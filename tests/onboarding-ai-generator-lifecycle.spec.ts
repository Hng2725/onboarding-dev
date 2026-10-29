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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function activeStepLabel(view: TestRenderer.ReactTestRenderer): string {
  return view.root.findAllByType('li').find((item) => item.props.className === 'active')!.findByType('small').children.join('');
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

function materializedModuleReview(): AdminTemplateDetail {
  return { id: 'draft-1', version: 1, employeeType: 'normal', title: 'Approved first', description: '', source: 'ai_generated', status: 'draft', locked: false, maxAttempts: 2, modules: [{ id: 'm1', key: 'core', title: 'Core', description: '', order: 0, resources: [], questions: [] }], flags: [], updatedAt: 'now', content: { assessmentMode: 'per_module', learningMode: 'sequential', maxAttemptsPerModule: 2, questionMeta: [], modules: [{ moduleId: 'm1', frameKey: 'core', objectives: ['Learn'], estimatedMinutes: 1, blocks: [{ id: 'b1', kind: 'summary', body: 'Approved lesson', sourceRefs: [], pendingVerification: false }] }], moduleApproval: { pipelineVersion: 'module_v2', outlineRevision: 1, fingerprint: 'approved', materializedFingerprint: 'snapshot', taskCoverage: [] } } };
}

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
  it('recreates the modal and services with blank session storage and resumes an upload failure', async () => {
    host.appRevision = 0;
    const actor = { roomId: 'room-1', userId: 'admin-1', access: 'admin' as const };
    const store = new MemoryOnboardingStore();
    await store.create(actor.roomId, 'onboarding_sources', { ...aiSource });
    let templates = createTemplateService(store);
    let reviews = createAiReviewService(store, templates);
    const targets: AiPublishTarget[] = [];
    for (const kind of ['advanced'] as const) {
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
        if (action === 'list_sources') return { sources: (await store.query(actor.roomId, 'onboarding_sources')).records };
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
    expect(uploads).toHaveLength(1);
    targets.length = 0;
    templates = createTemplateService(store);
    reviews = createAiReviewService(store, templates);
    const storage = new Map<string, string>([
      ['onboarding:ai:responsibilities:room-1', 'Old task'],
      ['onboarding:ai:module:room-1', 'old-module'],
    ]);
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
    expect(uploads).toHaveLength(1);
    failUpload = false;
    const publish = view.root.findAllByType('button').find((button) => button.children.join('').includes('Xuất bản template'))!;
    expect(publish.props.disabled).toBe(false);
    await act(async () => { publish.props.onClick(); });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(6);
    expect(new Set(uploads).size).toBe(6);
    expect(await store.count(actor.roomId, 'onboarding_templates')).toBe(1);
    expect(await store.count(actor.roomId, 'onboarding_resources')).toBe(5);
    expect(await reviews.listIncompletePublications(actor)).toEqual([]);
    view.unmount();
    expect(storage.size).toBe(0);

    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, {
      api: api as never, canGenerateWithAi: true, onClose: closed, onComplete: completed,
    })); });
    expect(activeStepLabel(view)).toBe('Tài liệu nguồn');
    const sourceList = view.root.findByProps({ 'aria-label': 'Danh sách tài liệu nguồn' });
    expect(sourceList.findByType('input').props.checked).toBe(true);
    expect(sourceList.findAllByType('strong').some((item) => item.children.join('') === 'orders.md')).toBe(true);
    expect(api.adminAi.mock.calls.some(([action]) => action === 'delete_source')).toBe(false);
    expect(api.adminTemplates.mock.calls.some(([action]) => action === 'delete')).toBe(false);
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
      if (action === 'list_jobs') return { jobs, publicationBatches: [{ batchId: 'persisted-batch', createdBy: 'admin-1', createdAt: '2026-10-28T09:00:00.000Z',
        targets: jobs.map((job) => ({ kind: job.templateKind, jobId: job.jobId, templateId: job.result.templateId, version: 1 })) }] };
      if (action === 'get_review') return { review: reviews.find((review) => review.id === args?.templateId) };
      throw new Error('Unexpected action: ' + action);
    }) };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: closed, onComplete: () => undefined })); });
    expect(view.root.findAllByType('button').some((button) => button.children.join('').includes('Xuất bản template'))).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).toContain('Đã hoàn tất');
    view.unmount(); vi.unstubAllGlobals();
  });
  it('keeps final materialized review in Rà soát and goes to the publish summary on explicit next', async () => {
    const storage = new Map([['onboarding:ai:template:room-1:normal', 'template-1'], ['onboarding:ai:selection:room-1', 'both']]);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const review = materializedModuleReview();
    const job = { ...approvedModuleJob(), jobId: 'template-1', roomId: 'room-1', status: 'completed' as const, result: { templateId: review.id, version: 1 } };
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [] };
      if (action === 'list_jobs') return { jobs: [inventoryJob, job] };
      if (action === 'get_review') return { review };
      throw new Error('Unexpected action: ' + action);
    }) };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
    expect(activeStepLabel(view)).toBe('Rà soát');
    const next = view.root.findAllByType('button').find((button) => button.children.join('') === 'Kiểm tra xuất bản');
    expect(next).toBeDefined();
    expect(view.root.findAllByType('button').some((button) => button.children.join('').includes('Template 2'))).toBe(false);
    expect(view.root.findByProps({ 'aria-label': 'Sửa khối nội dung' }).props.disabled).toBe(true);
    expect(view.root.findAllByType('button').some((button) => button.children.join('') === 'Chỉnh sửa module')).toBe(true);
    expect(api.adminAi.mock.calls.some(([action]) => action === 'start_job')).toBe(false);
    // The legacy per-kind and selection keys migrate to the single template key.
    expect(storage.get('onboarding:ai:template:room-1')).toBe('template-1');
    expect(storage.has('onboarding:ai:template:room-1:normal')).toBe(false);
    expect(storage.has('onboarding:ai:selection:room-1')).toBe(false);
    view.unmount(); vi.unstubAllGlobals();
  });
  it('clears old resume keys and writes no single key when the saved job is missing', async () => {
    const storage = new Map([['onboarding:ai:template:room-1:normal', 'gone'], ['onboarding:ai:template:room-1:advanced', 'gone-2'], ['onboarding:ai:selection:room-1', 'both']]);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [] };
      if (action === 'list_jobs') return { jobs: [inventoryJob] };
      throw new Error('Unexpected action: ' + action);
    }) };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
    expect(storage.has('onboarding:ai:template:room-1:normal')).toBe(false);
    expect(storage.has('onboarding:ai:template:room-1:advanced')).toBe(false);
    expect(storage.has('onboarding:ai:selection:room-1')).toBe(false);
    expect(storage.has('onboarding:ai:template:room-1')).toBe(false);
    view.unmount(); vi.unstubAllGlobals();
  });
  it('edits materialized module content without returning to the outline by default', async () => {
    const review = materializedModuleReview();
    const job = { ...approvedModuleJob(), jobId: 'template-1', roomId: 'room-1', status: 'completed' as const, result: { templateId: review.id, version: review.version } };
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [] };
      if (action === 'get_review') return { review };
      if (action === 'get_job') return { job };
      throw new Error('Unexpected action: ' + action);
    }) };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, initialTemplate: { id: review.id, version: review.version }, onClose: () => undefined, onComplete: () => undefined })); });

    await act(async () => { view.root.findAllByType('button').find((button) => button.children.join('') === 'Chỉnh sửa module')!.props.onClick(); });
    expect(activeStepLabel(view)).toBe('Rà soát');
    expect(view.root.findByProps({ 'aria-label': 'Danh sách module' })).toBeDefined();
    expect(JSON.stringify(view.toJSON())).not.toContain('Kiểm tra lộ trình đề xuất');
    view.unmount();
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

  it('does not queue Native fallback after unmount while the failed job reloads', async () => {
    const pending: AiJobRecord = {
      ...inventoryJob,
      status: 'running',
      result: undefined,
      calls: [{
        callId: 'A1', stage: 'A', operationId: 'inventory-1:A1', status: 'pending',
      }],
    };
    const failed: AiJobRecord = {
      ...pending,
      status: 'failed',
      errorCode: 'AI_FAILED',
      errorMessage: 'Worker exited with code 1',
      calls: [{
        callId: 'A1', stage: 'A', operationId: 'inventory-1:A1', status: 'failed',
        provider: 'sandbox', attemptRef: 'sandbox-attempt-1', providerErrorCode: 'worker_failed',
        errors: ['Worker exited with code 1'],
      }],
    };
    const reload = deferred<{ job: AiJobRecord }>();
    const reloadStarted = deferred<void>();
    const source = {
      id: 'source-row', roomId: 'room-1', sourceId: 'source-1', kind: 'document',
      fileName: 'guide.pdf', mimeType: 'application/pdf', checksum: 'checksum', systemName: 'Guide',
      status: 'ready', textLength: 100, createdBy: 'admin-1',
      createdAt: '2026-10-27T07:00:00.000Z', updatedAt: '2026-10-27T07:00:00.000Z',
    };
    const api = {
      adminAi: vi.fn(async (action: string) => {
        if (action === 'list_sources') return { sources: [source] };
        if (action === 'list_jobs') return { jobs: [pending] };
        if (action === 'next_step') return { kind: 'failed', job: failed };
        if (action === 'get_job') { reloadStarted.resolve(); return reload.promise; }
        if (action === 'retry_job') return { job: pending };
        throw new Error('Unexpected action: ' + action);
      }),
    };

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(AiGeneratorPage, {
        api: api as never,
        canGenerateWithAi: true,
        onClose: () => undefined,
        onComplete: () => undefined,
      }));
    });
    const analyze = renderer.root.findAllByProps({ className: 'button button-primary' })[0];
    act(() => analyze.props.onClick());
    await reloadStarted.promise;

    await act(async () => {
      renderer.unmount();
      reload.resolve({ job: failed });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.adminAi.mock.calls.some(([action]) => action === 'retry_job')).toBe(false);
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

it('restores an approved running module job directly in Rà soát', async () => {
  const storage = new Map<string, string>([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const modules = ['First', 'Second'].map((title, order) => ({ moduleLocalId: `m${order}`, frameKey: order ? 't1-core' : 't1-overview', order, title, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [] }));
  const job = { ...failedTemplateJob, templateKind: 'normal' as const, roleProfile: undefined, status: 'running' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 1, modules, flags: [], taskCoverage: [] }, outlineApprovedRevision: 1, moduleRuns: modules.map((outline) => ({ outline, outlineRevision: 1, lessonState: 'manual_required' as const, lessonVersion: 0, questionState: 'blocked' as const, questionVersion: 0 })) };
  const api = { adminAi: vi.fn(async (action: string) => { if (action === 'list_sources') return { sources: [] }; if (action === 'list_jobs') return { jobs: [inventoryJob, job] }; throw new Error('Unexpected action: ' + action); }) };
  const page = () => createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined });
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(page()); });
  expect(activeStepLabel(view)).toBe('Rà soát');
  const second = view.root.findByProps({ 'aria-label': 'Danh sách module' }).findAllByType('button')[1];
  act(() => second.props.onClick());
  expect(storage.get('onboarding:ai:module:room-1')).toBe('m1');
  view.unmount();
  await act(async () => { view = TestRenderer.create(page()); });
  expect(view.root.findByType('article').findByType('h3').children.join('')).toBe('Second');
  expect(api.adminAi.mock.calls.every(([action]) => action === 'list_sources' || action === 'list_jobs')).toBe(true);
  view.unmount(); vi.unstubAllGlobals();
});

it('moves to Rà soát immediately after outline approval and starts the module pump', async () => {
  const storage = new Map<string, string>([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const modules = ['t1-overview', 't1-access', 't1-navigation', 't1-core'].map((frameKey, order) => ({ moduleLocalId: `m${order}`, frameKey, order, title: frameKey, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] }));
  const job = { ...failedTemplateJob, templateKind: 'normal' as const, roleProfile: undefined, status: 'running' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 4, modules, flags: [], taskCoverage: [] }, outlineApprovedRevision: 0, moduleRuns: modules.map((outline) => ({ outline, outlineRevision: 4, lessonState: 'queued' as const, lessonVersion: 0, questionState: 'blocked' as const, questionVersion: 0 })) };
  const approved = { ...job, outlineApprovedRevision: 4 };
  const api = { adminAi: vi.fn(async (action: string) => { if (action === 'list_sources') return { sources: [] }; if (action === 'list_jobs') return { jobs: [inventoryJob, job] }; if (action === 'approve_outline') return { job: approved }; if (action === 'next_step') return { kind: 'awaiting_admin', job: approved }; throw new Error('Unexpected action: ' + action); }) };
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
  expect(activeStepLabel(view)).toBe('Tạo lộ trình');
  expect(api.adminAi.mock.calls.some(([action]) => action === 'next_step')).toBe(false);
  const button = view.root.findAllByType('button').find((item) => item.children.join('') === 'Duyệt lộ trình và tiếp tục')!;
  await act(async () => { button.props.onClick(); });
  expect(api.adminAi).toHaveBeenCalledWith('approve_outline', { jobId: 'template-1', expectedRevision: 4 });
  expect(api.adminAi).toHaveBeenCalledWith('next_step', expect.objectContaining({ jobId: 'template-1' }));
  expect(activeStepLabel(view)).toBe('Rà soát');
  view.unmount(); vi.unstubAllGlobals();
});

it('returns to Tạo lộ trình when outline approval fails', async () => {
  const storage = new Map<string, string>([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const modules = ['t1-overview', 't1-access', 't1-navigation', 't1-core'].map((frameKey, order) => ({ moduleLocalId: `m${order}`, frameKey, order, title: frameKey, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] }));
  const job = { ...failedTemplateJob, templateKind: 'normal' as const, roleProfile: undefined, status: 'running' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 4, modules, flags: [], taskCoverage: [] }, outlineApprovedRevision: 0, moduleRuns: modules.map((outline) => ({ outline, outlineRevision: 4, lessonState: 'queued' as const, lessonVersion: 0, questionState: 'blocked' as const, questionVersion: 0 })) };
  const approval = deferred<{ job: AiJobRecord }>();
  const api = { adminAi: vi.fn(async (action: string) => {
    if (action === 'list_sources') return { sources: [] };
    if (action === 'list_jobs') return { jobs: [inventoryJob, job] };
    if (action === 'approve_outline') return approval.promise;
    throw new Error('Unexpected action: ' + action);
  }) };
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });

  act(() => { view.root.findAllByType('button').find((item) => item.children.join('') === 'Duyệt lộ trình và tiếp tục')!.props.onClick(); });
  expect(activeStepLabel(view)).toBe('Rà soát');
  await act(async () => { approval.reject(new Error('Approval failed')); await Promise.resolve(); await Promise.resolve(); });
  expect(activeStepLabel(view)).toBe('Tạo lộ trình');
  view.unmount(); vi.unstubAllGlobals();
});

it('opens the selected outline source panel from a source-less review module', async () => {
  const storage = new Map<string, string>([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const module = { moduleLocalId: 'm', frameKey: 't1-core', order: 0, title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [] };
  const job = { ...failedTemplateJob, templateKind: 'normal' as const, roleProfile: undefined, status: 'running' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 1, modules: [module], flags: [], taskCoverage: [] }, outlineApprovedRevision: 1, moduleRuns: [{ outline: module, outlineRevision: 1, lessonState: 'manual_required' as const, lessonVersion: 0, questionState: 'blocked' as const, questionVersion: 0 }] };
  const api = { adminAi: vi.fn(async (action: string) => {
    if (action === 'list_sources') return { sources: [] };
    if (action === 'list_jobs') return { jobs: [inventoryJob, job] };
    if (action === 'list_module_sources') return { sources: [{ sourceId: 'policy', fileName: 'Policy.pdf', sections: [{ id: 'policy#1', headingPath: ['Quy định'] }] }] };
    throw new Error('Unexpected action: ' + action);
  }) };
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });

  await act(async () => { view.root.findAllByType('button').find((item) => item.children.join('') === 'Bổ sung tài liệu')!.props.onClick(); await Promise.resolve(); });
  expect(activeStepLabel(view)).toBe('Tạo lộ trình');
  expect(view.root.findByProps({ 'aria-label': 'Chọn tài liệu bổ sung' })).toBeDefined();
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

it('resumes a later module with Sandbox after an earlier module used Native', async () => {
  host.appRevision = 0;
  host.apps[0].rest.mockReset();
  host.apps[0].uploadFile.mockReset();
  host.apps[0].rest.mockImplementation(async (request: { path: string }) => {
    if (request.path === 'agents.sandbox.generate-async') {
      return { statusCode: 200, body: { attemptId: 'sandbox-module-2' } };
    }
    throw new Error('Unexpected REST path: ' + request.path);
  });
  host.apps[0].uploadFile.mockRejectedValue(new Error('Native must not be selected'));
  const storage = new Map([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const modules = ['First', 'Second'].map((title, order) => ({ moduleLocalId: `m${order + 1}`, frameKey: order ? 't1-core' : 't1-overview', order, title, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] }));
  const job = {
    ...failedTemplateJob,
    templateKind: 'normal' as const,
    roleProfile: undefined,
    status: 'running' as const,
    pipelineVersion: 'module_v2' as const,
    outline: { revision: 1, modules, flags: [], taskCoverage: [] },
    outlineApprovedRevision: 1,
    moduleRuns: [
      { outline: modules[0], outlineRevision: 1, lessonState: 'approved' as const, lessonVersion: 1, questionState: 'approved' as const, questionVersion: 1 },
      { outline: modules[1], outlineRevision: 1, lessonState: 'approved' as const, lessonVersion: 1, questionState: 'drafting' as const, questionVersion: 1 },
    ],
    calls: [{
      callId: 'm1-native', stage: 'B' as const, operationId: 'm1-native', status: 'failed' as const,
      provider: 'native_chat' as const, attemptRef: 'native-chat:old:message',
      moduleLocalId: 'm1', moduleTarget: 'questions' as const, moduleVersion: 1,
    }],
  };
  const api = { adminAi: vi.fn(async (action: string) => {
    if (action === 'list_sources') return { sources: [] };
    if (action === 'list_jobs') return { jobs: [inventoryJob, job] };
    if (action === 'next_step') return { kind: 'ai_call', callId: 'm2-questions', operationId: 'm2-questions', prompt: 'Create questions' };
    if (action === 'record_dispatch') throw new Error('Stop after provider selection');
    if (action === 'report_ai_failure') throw new Error('Stop after provider selection');
    throw new Error('Unexpected action: ' + action);
  }) };
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });

  const resume = view.root.findAllByType('button').find((item) => item.children.join('').includes('Tiếp tục xử lý'))!;
  await act(async () => { resume.props.onClick(); await Promise.resolve(); });

  expect(host.apps[0].rest).toHaveBeenCalledWith(expect.objectContaining({ path: 'agents.sandbox.generate-async' }));
  expect(host.apps[0].uploadFile).not.toHaveBeenCalled();
  view.unmount(); vi.unstubAllGlobals();
});

it('automatically recovers a failed Sandbox question through Native and grounded fallback', async () => {
  const storage = new Map([['onboarding:ai:template:room-1:normal', 'template-1']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const outline = { moduleLocalId: 'm', frameKey: 't1-core', order: 0, title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] };
  const lessonDraft = { localId: 'm', frameKey: 't1-core', title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], questions: [], blocks: [{ localId: 'b', kind: 'concept' as const, body: 'Nội dung có nguồn.', sourceRefs: [{ sectionId: 's', quote: 'Nội dung có nguồn.' }] }] };
  const baseRun = { outline, outlineRevision: 1, lessonState: 'approved' as const, lessonVersion: 1, approvedLessonVersion: 1, lessonDraft, lessonProvenance: 'fallback' as const };
  const sandboxFailed = { ...failedTemplateJob, templateKind: 'normal' as const, roleProfile: undefined, status: 'running' as const, pipelineVersion: 'module_v2' as const, outline: { revision: 1, modules: [outline], flags: [], taskCoverage: [] }, outlineApprovedRevision: 1, moduleRuns: [{ ...baseRun, questionState: 'failed' as const, questionVersion: 1 }], calls: [{ callId: 'q-sandbox', stage: 'B' as const, operationId: 'q-sandbox', status: 'failed' as const, provider: 'sandbox' as const, attemptRef: 'sandbox-attempt', moduleLocalId: 'm', moduleTarget: 'questions' as const, moduleVersion: 1 }] };
  const nativeQueued = { ...sandboxFailed, moduleRuns: [{ ...baseRun, questionState: 'queued' as const, questionVersion: 2 }] };
  const nativeFailed = { ...nativeQueued, moduleRuns: [{ ...baseRun, questionState: 'failed' as const, questionVersion: 2 }], calls: [...sandboxFailed.calls, { callId: 'q-native', stage: 'B' as const, operationId: 'q-native', status: 'failed' as const, provider: 'native_chat' as const, attemptRef: 'native-chat:s:m', moduleLocalId: 'm', moduleTarget: 'questions' as const, moduleVersion: 2 }] };
  const fallbackReady = { ...nativeFailed, moduleRuns: [{ ...baseRun, questionState: 'review_ready' as const, questionVersion: 3, questionLessonVersion: 1, questionProvenance: 'fallback' as const, questionDraft: [] }] };
  let nextStep = 0;
  const api = { adminAi: vi.fn(async (action: string) => {
    if (action === 'list_sources') return { sources: [] };
    if (action === 'list_jobs') return { jobs: [inventoryJob, sandboxFailed] };
    if (action === 'next_step') return { kind: 'awaiting_admin', job: nextStep++ === 0 ? sandboxFailed : nativeFailed };
    if (action === 'retry_module') return { job: nativeQueued };
    if (action === 'use_question_fallback') return { job: fallbackReady };
    throw new Error('Unexpected action: ' + action);
  }) };
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });

  const resume = view.root.findAllByType('button').find((item) => item.children.join('').includes('Tiếp tục xử lý'))!;
  await act(async () => { resume.props.onClick(); await Promise.resolve(); });

  expect(api.adminAi.mock.calls.map(([action]) => action)).toEqual(expect.arrayContaining(['retry_module', 'use_question_fallback']));
  expect(api.adminAi.mock.calls.filter(([action]) => action === 'retry_module')).toHaveLength(1);
  expect(api.adminAi.mock.calls.filter(([action]) => action === 'use_question_fallback')).toHaveLength(1);
  expect(api.adminAi.mock.calls.some(([action]) => action === 'update_module_questions')).toBe(false);
  view.unmount(); vi.unstubAllGlobals();
});

describe('AI generator reset UI', () => {
  const source = {
    id: 'source-row',
    roomId: 'room-1',
    sourceId: 'source-1',
    kind: 'document' as const,
    fileName: 'guide.pdf',
    mimeType: 'application/pdf',
    checksum: 'checksum',
    systemName: 'Guide',
    status: 'ready' as const,
    textLength: 100,
    createdBy: 'admin-1',
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
  };

  it('shows Xóa dữ liệu only for a new generator and cancelling confirmation changes nothing', async () => {
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [] };
      throw new Error('Unexpected action: ' + action);
    }) };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });

    const reset = view.root.findAllByType('button').find((button) => button.children.join('').includes('Xóa dữ liệu'))!;
    expect(reset).toBeDefined();
    act(() => reset.props.onClick());
    expect(view.root.findByProps({ 'aria-labelledby': 'confirm-title' })).toBeDefined();
    act(() => view.root.findAllByType('button').find((button) => button.children.join('') === 'Hủy')!.props.onClick());
    expect(activeStepLabel(view)).toBe('Tài liệu nguồn');
    expect(api.adminAi.mock.calls.map(([action]) => action)).toEqual(['list_sources', 'list_jobs']);
    view.unmount();

    const existing = materializedModuleReview();
    const reviewApi = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'get_review') return { review: existing };
      throw new Error('Unexpected action: ' + action);
    }) };
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: reviewApi as never, initialTemplate: { id: existing.id, version: existing.version }, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
    expect(view.root.findAllByType('button').some((button) => button.children.join('').includes('Xóa dữ liệu'))).toBe(false);
    view.unmount();
  });

  it('cancels the current job, deletes its draft, clears resume keys, and returns to selected sources', async () => {
    const storage = new Map<string, string>([
      ['onboarding:ai:inventory:room-1', 'inventory-1'],
      ['onboarding:ai:template:room-1', 'template-1'],
      ['onboarding:ai:template:room-1:normal', 'template-1'],
      ['onboarding:ai:template:room-1:advanced', 'template-2'],
      ['onboarding:ai:publish:room-1:admin-1', 'checkpoint'],
      ['onboarding:ai:selection:room-1', 'normal'],
      ['onboarding:ai:responsibilities:room-1', 'Task'],
      ['onboarding:ai:module:room-1', 'module-1'],
    ]);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const draft = materializedModuleReview();
    const failed = { ...failedTemplateJob, templateKind: 'normal' as const, result: { templateId: draft.id, version: draft.version } };
    const deletion = deferred<void>();
    let sourceLoads = 0;
    const api = {
      adminAi: vi.fn(async (action: string) => {
        if (action === 'list_sources') { sourceLoads += 1; return { sources: [source] }; }
        if (action === 'list_jobs') return {
          jobs: [inventoryJob, failed],
          publicationBatches: [{
            batchId: 'reset-batch',
            createdBy: 'admin-1',
            createdAt: '2026-10-29T00:00:00.000Z',
            targets: [{ kind: 'normal', jobId: failed.jobId, templateId: draft.id, version: draft.version }],
          }],
        };
        if (action === 'get_review') return { review: draft };
        if (action === 'cancel_job') return { job: { ...failed, status: 'cancelled' as const } };
        throw new Error('Unexpected action: ' + action);
      }),
      adminTemplates: vi.fn(async (action: string) => {
        if (action === 'delete') return deletion.promise;
        throw new Error('Unexpected template action: ' + action);
      }),
    };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
    expect(activeStepLabel(view)).toBe('Xuất bản');
    act(() => view.root.findAllByType('button').find((button) => button.children.join('').includes('Xóa dữ liệu'))!.props.onClick());
    act(() => view.root.findByProps({ 'aria-labelledby': 'confirm-title' }).findAllByType('button').find((button) => button.children.join('') === 'Xóa dữ liệu')!.props.onClick());
    const deleting = view.root.findAllByType('button').find((button) => button.children.join('').includes('Đang xóa…'))!;
    expect(deleting.props.disabled).toBe(true);

    await act(async () => { deletion.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(api.adminAi).toHaveBeenCalledWith('cancel_job', { jobId: failed.jobId });
    expect(api.adminTemplates).toHaveBeenCalledWith('delete', { templateId: draft.id, version: draft.version });
    expect(sourceLoads).toBe(2);
    expect(storage.size).toBe(0);
    expect(activeStepLabel(view)).toBe('Tài liệu nguồn');
    expect(view.root.findByProps({ 'aria-label': 'Danh sách tài liệu nguồn' }).findByType('input').props.checked).toBe(true);
    expect(api.adminAi.mock.calls.some(([action]) => action === 'delete_source')).toBe(false);
    view.unmount(); vi.unstubAllGlobals();
  });

  it('keeps the current step when reloading sources for reset fails', async () => {
    let sourceLoads = 0;
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') {
        sourceLoads += 1;
        if (sourceLoads === 2) throw new Error('Cannot reload sources');
        return { sources: [source] };
      }
      if (action === 'list_jobs') return { jobs: [] };
      throw new Error('Unexpected action: ' + action);
    }), adminTemplates: vi.fn() };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
    act(() => view.root.findAllByType('button').find((button) => button.children.join('') === 'Tiếp tục')!.props.onClick());
    expect(activeStepLabel(view)).toBe('Phân tích');
    act(() => view.root.findAllByType('button').find((button) => button.children.join('').includes('Xóa dữ liệu'))!.props.onClick());
    await act(async () => { view.root.findByProps({ 'aria-labelledby': 'confirm-title' }).findAllByType('button').find((button) => button.children.join('') === 'Xóa dữ liệu')!.props.onClick(); await Promise.resolve(); await Promise.resolve(); });

    expect(activeStepLabel(view)).toBe('Phân tích');
    expect(JSON.stringify(view.toJSON())).toContain('Không thể hoàn tất yêu cầu AI.');
    view.unmount();
  });

  it('remounts an unfinished Admin note form while keeping saved sources', async () => {
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [] };
      throw new Error('Unexpected action: ' + action);
    }), adminTemplates: vi.fn() };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
    act(() => view.root.findAllByType('button').find((button) => button.children.join('').includes('Thêm ghi chú Admin'))!.props.onClick());
    expect(view.root.findAllByType('textarea')).toHaveLength(1);
    act(() => view.root.findAllByType('button').find((button) => button.children.join('').includes('Xóa dữ liệu'))!.props.onClick());
    await act(async () => { view.root.findByProps({ 'aria-labelledby': 'confirm-title' }).findAllByType('button').find((button) => button.children.join('') === 'Xóa dữ liệu')!.props.onClick(); await Promise.resolve(); await Promise.resolve(); });

    expect(view.root.findAllByType('textarea')).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).toContain('guide.pdf');
    view.unmount();
  });

  it('reloads current review status before reset and does not delete a partially published template', async () => {
    const draft = materializedModuleReview();
    const published = { ...draft, status: 'published' as const };
    const completed = { ...failedTemplateJob, templateKind: 'normal' as const, status: 'completed' as const, result: { templateId: draft.id, version: draft.version } };
    let reviewLoads = 0;
    const api = {
      adminAi: vi.fn(async (action: string) => {
        if (action === 'list_sources') return { sources: [source] };
        if (action === 'list_jobs') return {
          jobs: [inventoryJob, completed],
          publicationBatches: [{
            batchId: 'partial-publish', createdBy: 'admin-1', createdAt: '2026-10-29T00:00:00.000Z',
            targets: [{ kind: 'normal', jobId: completed.jobId, templateId: draft.id, version: draft.version }],
          }],
        };
        if (action === 'get_review') return { review: reviewLoads++ === 0 ? draft : published };
        throw new Error('Unexpected action: ' + action);
      }),
      adminTemplates: vi.fn(async () => undefined),
    };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined })); });
    expect(activeStepLabel(view)).toBe('Xuất bản');

    act(() => view.root.findAllByType('button').find((button) => button.children.join('').includes('Xóa dữ liệu'))!.props.onClick());
    await act(async () => { view.root.findByProps({ 'aria-labelledby': 'confirm-title' }).findAllByType('button').find((button) => button.children.join('') === 'Xóa dữ liệu')!.props.onClick(); await Promise.resolve(); await Promise.resolve(); });

    expect(reviewLoads).toBe(2);
    expect(api.adminTemplates).not.toHaveBeenCalled();
    expect(activeStepLabel(view)).toBe('Tài liệu nguồn');
    view.unmount();
  });

  it('keeps reset disabled until the initial session restore has settled', async () => {
    const jobs = deferred<{ jobs: readonly AiJobRecord[] }>();
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return jobs.promise;
      throw new Error('Unexpected action: ' + action);
    }), adminTemplates: vi.fn() };
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined }));
      await Promise.resolve();
    });
    const resetButton = () => view.root.findAllByType('button').find((button) => button.children.join('').includes('Xóa dữ liệu'))!;
    expect(resetButton().props.disabled).toBe(true);

    await act(async () => { jobs.resolve({ jobs: [] }); await Promise.resolve(); await Promise.resolve(); });

    expect(resetButton().props.disabled).toBe(false);
    expect(activeStepLabel(view)).toBe('Tài liệu nguồn');
    view.unmount();
  });
});
