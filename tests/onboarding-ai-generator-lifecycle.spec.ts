import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { AiJobRecord } from '../src/onboarding/contracts';
import type { AdminTemplateDetail } from '../src/onboarding/templates';
import { createTemplateService } from '../src/onboarding/templates';
import { createAiReviewService, type AiReviewService, type UpdateAiReviewInput } from '../src/onboarding/ai/review';
import { materializeModuleTemplate } from '../src/onboarding/ai/materialize';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { approvedModuleJob } from './helpers/approved-module-fixture';
import { aiSource } from './helpers/ai-template-fixture';
import { AiPublishBatchError, publishAiTemplateBatch, type AiPublishTarget } from '../src/ui/onboarding/ai/ai-publish-batch';

const host = vi.hoisted(() => ({
  appRevision: 0,
  apps: [{ revision: 0, rest: vi.fn(), uploadFile: vi.fn() }, { revision: 1, rest: vi.fn(), uploadFile: vi.fn() }],
  context: {
    userId: 'admin-1',
    username: 'admin',
    theme: 'dark',
    roomId: 'room-1',
    roomName: 'AI room',
    userRoles: ['admin'],
    effectiveScopes: ['sandbox:generate', 'sandbox:ai-chat', 'sandbox:ai-chat:write'],
    roomSlug: 'ai-room',
    appId: 'onboarding',
    appUrl: 'about:srcdoc',
    themeTokens: {},
  },
}));

vi.mock('@privos_ai/app-react', () => ({
  usePrivosApp: () => host.apps[host.appRevision],
  usePrivosContext: () => host.context,
}));

vi.mock('../src/ui/onboarding/ai/lesson-pdf', () => ({
  createLessonPdfArtifact: async (review: AdminTemplateDetail, _id: string, index: number) => ({
    fileName: `${review.employeeType}-${index}.pdf`, mimeType: 'application/pdf', blob: new Blob(['pdf'], { type: 'application/pdf' }),
  }),
}));
vi.mock('../src/ui/onboarding/roomfiles', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ui/onboarding/roomfiles')>(),
  ensureTemplateRoomfilesFolder: async () => ({ rootId: 'root', documentsId: 'documents', templatesId: 'templates', templateFolderId: 'folder' }),
}));

import { AiGeneratorPage, createAiPublishDependencies } from '../src/ui/onboarding/ai/ai-generator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const inventoryJob: AiJobRecord = {
  id: 'inventory-row',
  roomId: 'room-1',
  jobId: 'inventory-1',
  kind: 'inventory',
  status: 'completed',
  sourceIds: ['source-1'],
  promptVersion: 'test',
  calls: [],
  stageOutputs: {},
  result: { features: [], glossary: [], conflicts: [] },
  operationId: 'inventory-operation',
  createdBy: 'admin-1',
  createdAt: '2026-10-27T08:00:00.000Z',
  updatedAt: '2026-10-27T08:01:00.000Z',
};

const failedTemplateJob: AiJobRecord = {
  id: 'template-row',
  roomId: 'room-1',
  jobId: 'template-1',
  kind: 'template',
  status: 'failed',
  templateKind: 'advanced',
  roleProfile: {
    department: 'other',
    departmentLabel: 'Vận hành khách hàng',
    jobTitle: 'Chuyên viên vận hành',
    responsibilities: [
      'Xử lý sự cố khách hàng theo đúng quy trình',
      'Bảo đảm an toàn khi làm việc từ xa',
    ],
  },
  sourceIds: ['source-1'],
  inventoryJobId: inventoryJob.jobId,
  promptVersion: 'test',
  calls: [],
  stageOutputs: {},
  errorCode: 'AI_FAILED',
  errorMessage: 'Sandbox worker failed.',
  operationId: 'template-operation',
  createdBy: 'admin-1',
  createdAt: '2026-10-27T08:02:00.000Z',
  updatedAt: '2026-10-27T08:03:00.000Z',
};

describe('AI generator lifecycle', () => {
  it('recreates the modal and services with blank session storage and resumes a Template 2 upload failure', async () => {
    host.appRevision = 0;
    const actor = { roomId: 'room-1', userId: 'admin-1', access: 'admin' as const };
    const store = new MemoryOnboardingStore();
    await store.create(actor.roomId, 'onboarding_sources', { ...aiSource });
    let templates = createTemplateService(store);
    let reviews = createAiReviewService(store, templates);
    const targets: AiPublishTarget[] = [];
    for (const kind of ['normal', 'advanced'] as const) {
      const job = approvedModuleJob(kind);
      const row = await store.create(actor.roomId, 'onboarding_ai_jobs', { ...job });
      const review = await materializeModuleTemplate(store, templates, actor, job.jobId);
      await store.update(actor.roomId, 'onboarding_ai_jobs', String(row.id), { result: { templateId: review.id, version: review.version } });
      targets.push({ kind, review, phase: 'idle', jsonExported: false });
    }
    const uploads: string[] = [];
    let failUpload = true;
    host.apps[0].uploadFile.mockImplementation(async (file: { fileName: string }) => {
      if (file.fileName === 'advanced-1.pdf' && failUpload) throw new Error('Upload interrupted');
      uploads.push(file.fileName);
      return { fileId: file.fileName };
    });
    const api = {
      adminAi: vi.fn(async (action: string, args: Record<string, unknown> = {}) => {
        if (action === 'list_sources') return { sources: [] };
        if (action === 'list_jobs') return { jobs: (await store.query(actor.roomId, 'onboarding_ai_jobs')).records,
          publicationBatches: await reviews.listIncompletePublications(actor) };
        if (action === 'begin_publication') return { batch: await reviews.beginPublication(actor, args as unknown as Parameters<AiReviewService['beginPublication']>[1]) };
        if (action === 'get_review') return { review: await reviews.getReview(actor, String(args.templateId), Number(args.version)) };
        if (action === 'update_review') return { review: await reviews.updateReview(actor, args as unknown as UpdateAiReviewInput) };
        throw new Error('Unexpected action: ' + action);
      }),
      adminTemplates: vi.fn(async (_action: string, args: Record<string, unknown>) => ({
        template: await templates.publish(actor, String(args.templateId), Number(args.version), String(args.expectedUpdatedAt)),
      })),
    };
    const dependencies = createAiPublishDependencies({ roomId: actor.roomId, app: host.apps[0] as never, api: api as never,
      encodeBlob: async () => ({ dataUrl: 'data:application/pdf;base64,YQ==', base64: 'YQ==' }) });
    await expect(publishAiTemplateBatch(targets, dependencies)).rejects.toBeInstanceOf(AiPublishBatchError);
    expect(uploads).toHaveLength(6); // Template 1: 4 PDFs + JSON; Template 2: 1 PDF.
    targets.length = 0;
    templates = createTemplateService(store);
    reviews = createAiReviewService(store, templates);
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    vi.stubGlobal('FileReader', class {
      result = 'data:application/pdf;base64,YQ==';
      onload: (() => void) | null = null;
      readAsDataURL() { this.onload?.(); }
    });
    const closed = vi.fn();
    const completed = vi.fn();
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, {
      api: api as never, canGenerateWithAi: true, onClose: closed, onComplete: completed,
    })); });
    expect(closed).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).toContain('Đã hoàn tất');
    expect(uploads).toHaveLength(6);
    failUpload = false;
    const publish = view.root.findAllByType('button').find((button) => button.children.join('').includes('Xuất bản cả hai'))!;
    expect(publish.props.disabled).toBe(false);
    await act(async () => { publish.props.onClick(); });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(11);
    expect(new Set(uploads).size).toBe(11);
    expect(await store.count(actor.roomId, 'onboarding_templates')).toBe(2);
    expect(await store.count(actor.roomId, 'onboarding_resources')).toBe(9);
    expect(await reviews.listIncompletePublications(actor)).toEqual([]);
    view.unmount();
    vi.unstubAllGlobals();
    host.apps[0].uploadFile.mockReset();
  });
  it('preserves unlimited attempts when opening published settings without edits', async () => {
    const review: AdminTemplateDetail = { id: 'published', version: 1, source: 'ai_generated', status: 'published', employeeType: 'normal',
      title: 'Published', description: '', modules: [], locked: false, maxAttempts: 2, updatedAt: 'now', flags: [],
      content: { assessmentMode: 'per_module', learningMode: 'free', maxAttemptsPerModule: null, modules: [], questionMeta: [] } };
    const api = { adminAi: vi.fn(async (action: string) => action === 'list_sources' ? { sources: [] } : { review }) };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, initialTemplate: { id: review.id, version: 1 }, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
    expect(view.root.findAllByType('input').find((input) => input.props.max === 10)?.props.value).toBe('');
    view.unmount();
  });
  it('reopens a partial publication at the batch summary using durable server checkpoints', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const reviews = (['normal', 'advanced'] as const).map((kind): AdminTemplateDetail => ({ id: kind + '-draft', version: 1, employeeType: kind, title: kind, description: '', source: 'ai_generated', status: kind === 'normal' ? 'published' : 'draft', locked: false, maxAttempts: 2, modules: [], flags: [], updatedAt: 'now', content: { assessmentMode: 'per_module', learningMode: 'sequential', maxAttemptsPerModule: 2, modules: [], questionMeta: [], publication: { pdfs: {}, ...(kind === 'normal' ? { jsonFileId: 'normal-json' } : {}) } } }));
    const jobs = reviews.map((review) => ({ ...failedTemplateJob, jobId: review.employeeType + '-job', templateKind: review.employeeType, pipelineVersion: 'module_v2', status: 'completed', result: { templateId: review.id, version: 1 } }));
    const closed = vi.fn();
    const api = { adminAi: vi.fn(async (action: string, args?: Record<string, unknown>) => {
      if (action === 'list_sources') return { sources: [] };
      if (action === 'list_jobs') return { jobs, publicationBatches: [{ batchId: 'persisted-both', createdBy: 'admin-1', createdAt: '2026-10-28T09:00:00.000Z',
        targets: jobs.map((job) => ({ kind: job.templateKind, jobId: job.jobId, templateId: job.result.templateId, version: 1 })) }] };
      if (action === 'get_review') return { review: reviews.find((review) => review.id === args?.templateId) };
      throw new Error('Unexpected action: ' + action);
    }) };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: closed, onComplete: () => undefined })); });
    expect(view.root.findAllByType('button').some((button) => button.children.join('').includes('Xuất bản cả hai'))).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).toContain('Đã hoàn tất');
    view.unmount(); vi.unstubAllGlobals();
  });
  it('opens a materialized module review and requires explicit next before Template 2', async () => {
    const storage = new Map([['onboarding:ai:template:room-1:normal', 'template-1'], ['onboarding:ai:selection:room-1', 'both']]);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const review: AdminTemplateDetail = { id: 'draft-1', version: 1, employeeType: 'normal', title: 'Approved first', description: '', source: 'ai_generated', status: 'draft', locked: false, maxAttempts: 2, modules: [{ id: 'm1', key: 'core', title: 'Core', description: '', order: 0, resources: [], questions: [] }], flags: [], updatedAt: 'now', content: { assessmentMode: 'per_module', learningMode: 'sequential', maxAttemptsPerModule: 2, questionMeta: [], modules: [{ moduleId: 'm1', frameKey: 'core', objectives: ['Learn'], estimatedMinutes: 1, blocks: [{ id: 'b1', kind: 'summary', body: 'Approved lesson', sourceRefs: [], pendingVerification: false }] }], moduleApproval: { pipelineVersion: 'module_v2', outlineRevision: 1, fingerprint: 'approved', materializedFingerprint: 'snapshot', taskCoverage: [] } } };
    const job = { ...failedTemplateJob, templateKind: 'normal', pipelineVersion: 'module_v2', status: 'completed', result: { templateId: review.id, version: 1 } };
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [] };
      if (action === 'list_jobs') return { jobs: [inventoryJob, job] };
      if (action === 'get_review') return { review };
      throw new Error('Unexpected action: ' + action);
    }) };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
    const next = view.root.findAllByType('button').find((button) => button.children.join('') === 'Tiếp: Template 2');
    expect(next).toBeDefined();
    expect(view.root.findByProps({ 'aria-label': 'Sửa khối nội dung' }).props.disabled).toBe(true);
    expect(view.root.findAllByType('button').some((button) => button.children.join('') === 'Chỉnh sửa module')).toBe(true);
    expect(api.adminAi.mock.calls.some(([action]) => action === 'start_job')).toBe(false);
    await act(async () => { next!.props.onClick(); });
    expect(view.root.findAllByType('button').some((button) => button.children.join('').includes('Tạo lộ trình'))).toBe(true);
    view.unmount(); vi.unstubAllGlobals();
  });
  it('restores and closes a timed-out job by observing the provider without cancelling it', async () => {
    host.appRevision = 0;
    let cancelled = false;
    const rest = host.apps[0].rest.mockImplementation(async (request: { path: string }) => {
      if (request.path === 'agents.sandbox.attempt-cancel') { cancelled = true; return { status: 'cancelled' }; }
      return { status: cancelled ? 'cancelled' : 'running' };
    });
    const job = { ...inventoryJob, status: 'failed', calls: [{ callId: 'A1', stage: 'A', operationId: 'op', status: 'failed', attemptRef: 'attempt-live', provider: 'sandbox', cleanupState: 'pending' }] };
    const api = {
      adminAi: vi.fn(async (action: string) => {
        if (action === 'list_sources') return { sources: [] };
        if (action === 'list_jobs') return { jobs: [job] };
        if (action === 'record_attempt_cleanup') return { job };
        throw new Error('Unexpected action: ' + action);
      }),
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined }));
    });
    await act(async () => { renderer.unmount(); });
    expect(rest.mock.calls.some(([request]) => request.path === 'agents.sandbox.attempt-status')).toBe(true);
    expect(rest.mock.calls.some(([request]) => request.path === 'agents.sandbox.attempt-cancel')).toBe(false);
    expect(api.adminAi).toHaveBeenCalledWith('record_attempt_cleanup', expect.objectContaining({ state: 'unknown' }));
    rest.mockReset();
  });

  it('restores a failed job even when the host returns a new app facade during an unrelated render', async () => {
    host.appRevision = 0;
    const jobRequests: Array<ReturnType<typeof deferred<{ jobs: readonly AiJobRecord[] }>>> = [];
    const api = {
      adminAi: vi.fn(async (action: string) => {
        if (action === 'list_sources') {
          return {
            sources: [{
              id: 'source-row',
              roomId: 'room-1',
              sourceId: 'source-1',
              kind: 'document',
              fileName: 'guide.pdf',
              mimeType: 'application/pdf',
              checksum: 'checksum',
              systemName: 'Guide',
              status: 'ready',
              textLength: 100,
              createdBy: 'admin-1',
              createdAt: '2026-10-27T07:00:00.000Z',
              updatedAt: '2026-10-27T07:00:00.000Z',
            }],
          };
        }
        if (action === 'list_jobs') {
          const request = deferred<{ jobs: readonly AiJobRecord[] }>();
          jobRequests.push(request);
          return request.promise;
        }
        throw new Error('Unexpected action: ' + action);
      }),
    };
    const Harness = ({ tick }: { tick: number }) => createElement('div', { 'data-tick': tick },
      createElement(AiGeneratorPage, {
        api: api as never,
        canGenerateWithAi: true,
        onClose: () => undefined,
        onComplete: () => undefined,
      }));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, { tick: 0 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      host.appRevision = 1;
      renderer.update(createElement(Harness, { tick: 1 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      jobRequests[0].resolve({ jobs: [failedTemplateJob, inventoryJob] });
      await Promise.resolve();
      await Promise.resolve();
    });

    const textarea = renderer.root.findByType('textarea');
    expect(textarea.props.value).toBe(failedTemplateJob.roleProfile?.responsibilities.join('\n'));
    expect(renderer.root.findAllByType('select')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Chức danh');
    const [retryButton] = renderer.root.findAllByProps({ className: 'button button-primary' });
    expect(retryButton).toBeDefined();
    expect(retryButton.props.disabled).toBe(false);
    renderer.unmount();
  });
});

it('reopens a completed module job without routing to legacy review', async () => {
  const storage = new Map<string, string>([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const module = { moduleLocalId: 'm', frameKey: 't1-core', order: 0, title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [] };
  const job = { ...failedTemplateJob, templateKind: 'normal' as const, roleProfile: undefined, status: 'completed' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 1, modules: [module], flags: [], taskCoverage: [] }, outlineApprovedRevision: 1, moduleRuns: [{ outline: module, outlineRevision: 1, lessonState: 'approved' as const, lessonVersion: 1, questionState: 'approved' as const, questionVersion: 1 }], result: null };
  const api = { adminAi: vi.fn(async (action: string) => { if (action === 'list_sources') return { sources: [] }; if (action === 'list_jobs') return { jobs: [inventoryJob, job] }; throw new Error('Unexpected action: ' + action); }) };
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
  expect(view.root.findAllByType('button').some((button) => button.children.join('') === 'Rà soát bản nháp')).toBe(true);
  expect(api.adminAi).not.toHaveBeenCalledWith('get_review', expect.anything());
  view.unmount(); vi.unstubAllGlobals();
});

it('restores the selected module on reopen without starting or cancelling work', async () => {
  const storage = new Map<string, string>([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const modules = ['First', 'Second'].map((title, order) => ({ moduleLocalId: `m${order}`, frameKey: order ? 't1-core' : 't1-overview', order, title, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [] }));
  const job = { ...failedTemplateJob, templateKind: 'normal' as const, roleProfile: undefined, status: 'running' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 1, modules, flags: [], taskCoverage: [] }, outlineApprovedRevision: 1, moduleRuns: modules.map((outline) => ({ outline, outlineRevision: 1, lessonState: 'manual_required' as const, lessonVersion: 0, questionState: 'blocked' as const, questionVersion: 0 })) };
  const api = { adminAi: vi.fn(async (action: string) => { if (action === 'list_sources') return { sources: [] }; if (action === 'list_jobs') return { jobs: [inventoryJob, job] }; throw new Error('Unexpected action: ' + action); }) };
  const page = () => createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined });
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(page()); });
  const second = view.root.findByProps({ 'aria-label': 'Danh sách module' }).findAllByType('button')[1];
  act(() => second.props.onClick());
  expect(storage.get('onboarding:ai:module:room-1')).toBe('m1');
  view.unmount();
  await act(async () => { view = TestRenderer.create(page()); });
  expect(view.root.findByType('article').findByType('h3').children.join('')).toBe('Second');
  expect(api.adminAi.mock.calls.every(([action]) => action === 'list_sources' || action === 'list_jobs')).toBe(true);
  view.unmount(); vi.unstubAllGlobals();
});

it('approves the persisted outline revision then resumes only that job', async () => {
  const storage = new Map<string, string>([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const modules = ['t1-overview', 't1-access', 't1-navigation', 't1-core'].map((frameKey, order) => ({ moduleLocalId: `m${order}`, frameKey, order, title: frameKey, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] }));
  const job = { ...failedTemplateJob, templateKind: 'normal' as const, roleProfile: undefined, status: 'running' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 4, modules, flags: [], taskCoverage: [] }, outlineApprovedRevision: 0, moduleRuns: modules.map((outline) => ({ outline, outlineRevision: 4, lessonState: 'queued' as const, lessonVersion: 0, questionState: 'blocked' as const, questionVersion: 0 })) };
  const approved = { ...job, outlineApprovedRevision: 4 };
  const api = { adminAi: vi.fn(async (action: string) => { if (action === 'list_sources') return { sources: [] }; if (action === 'list_jobs') return { jobs: [inventoryJob, job] }; if (action === 'approve_outline') return { job: approved }; if (action === 'next_step') return { kind: 'awaiting_admin', job: approved }; throw new Error('Unexpected action: ' + action); }) };
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
  expect(api.adminAi.mock.calls.some(([action]) => action === 'next_step')).toBe(false);
  const button = view.root.findAllByType('button').find((item) => item.children.join('') === 'Duyệt khung và bắt đầu viết')!;
  await act(async () => { button.props.onClick(); });
  expect(api.adminAi).toHaveBeenCalledWith('approve_outline', { jobId: 'template-1', expectedRevision: 4 });
  expect(api.adminAi).toHaveBeenCalledWith('next_step', expect.objectContaining({ jobId: 'template-1' }));
  view.unmount(); vi.unstubAllGlobals();
});

it('lets an admin explicitly start Template 2 after Template 1 completed without a legacy result', async () => {
  const storage = new Map<string, string>([['onboarding:ai:template:room-1:normal', 'template-1'], ['onboarding:ai:selection:room-1', 'both'], ['onboarding:ai:responsibilities:room-1', 'First task\nSecond task']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const module = { moduleLocalId: 'm', frameKey: 't1-core', order: 0, title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [] };
  const job = { ...failedTemplateJob, inventoryJobId: 'inventory-1', templateKind: 'normal' as const, roleProfile: undefined, status: 'completed' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 1, modules: [module], flags: [], taskCoverage: [] }, outlineApprovedRevision: 1, moduleRuns: [{ outline: module, outlineRevision: 1, lessonState: 'approved' as const, lessonVersion: 1, questionState: 'approved' as const, questionVersion: 1 }], result: null };
  const api = { adminAi: vi.fn(async (action: string) => { if (action === 'list_sources') return { sources: [] }; if (action === 'list_jobs') return { jobs: [inventoryJob, job] }; if (action === 'start_job') return { job: { ...job, jobId: 'template-2', templateKind: 'advanced', status: 'running', outlineApprovedRevision: 0 } }; if (action === 'next_step') return { kind: 'awaiting_admin', job: { ...job, jobId: 'template-2', templateKind: 'advanced', status: 'running', outlineApprovedRevision: 0 } }; throw new Error('Unexpected action: ' + action); }) };
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
  const next = view.root.findAllByType('button').find((button) => button.children.join('') === 'Tiếp tục Template 2');
  expect(next).toBeDefined();
  act(() => next!.props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain('Template 2');
  expect(api.adminAi.mock.calls.every(([action]) => action === 'list_sources' || action === 'list_jobs')).toBe(true);
  const generate = view.root.findAllByType('button').find((button) => button.children.join('').includes('Tạo lộ trình') && !button.props.disabled)!;
  await act(async () => { generate.props.onClick(); });
  expect(api.adminAi).toHaveBeenCalledWith('start_job', expect.objectContaining({ templateKind: 'advanced' }));
  expect(api.adminAi.mock.calls.filter(([action]) => action === 'start_job')).toHaveLength(1);
  view.unmount(); vi.unstubAllGlobals();
});

it('resumes an interrupted module job only on explicit action', async () => {
  const storage = new Map([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const module = { moduleLocalId: 'm', frameKey: 't1-core', order: 0, title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] };
  const job = { ...failedTemplateJob, templateKind: 'normal' as const, roleProfile: undefined, status: 'running' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 1, modules: [module], flags: [], taskCoverage: [] }, outlineApprovedRevision: 1, moduleRuns: [{ outline: module, outlineRevision: 1, lessonState: 'drafting' as const, lessonVersion: 1, questionState: 'blocked' as const, questionVersion: 0 }], calls: [] };
  const api = { adminAi: vi.fn(async (action: string) => { if (action === 'list_sources') return { sources: [] }; if (action === 'list_jobs') return { jobs: [inventoryJob, job] }; if (action === 'next_step') return { kind: 'awaiting_admin', job }; throw new Error('Unexpected action: ' + action); }) };
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
  expect(api.adminAi.mock.calls.some(([action]) => action === 'next_step')).toBe(false);
  const button = view.root.findAllByType('button').find((item) => item.children.join('').includes('Tiếp tục xử lý'));
  expect(button).toBeDefined();
  await act(async () => { button!.props.onClick(); });
  expect(api.adminAi).toHaveBeenCalledWith('next_step', expect.objectContaining({ jobId: 'template-1' }));
  expect(api.adminAi.mock.calls.some(([action]) => action === 'start_job' || action === 'cancel_job' || action === 'retry_module')).toBe(false);
  view.unmount(); vi.unstubAllGlobals();
});
