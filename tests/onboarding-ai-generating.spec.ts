import { createElement } from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AiCallRecord, AiJobRecord, AiModuleDraftRun, TemplateOutlineModule } from '../src/onboarding/contracts';
import type { AdminTemplateDetail } from '../src/onboarding/templates';

const host = vi.hoisted(() => ({
  app: { rest: vi.fn(), uploadFile: vi.fn() },
  context: {
    userId: 'admin-1',
    username: 'admin',
    theme: 'dark',
    roomId: 'room-1',
    roomName: 'AI room',
    userRoles: ['admin'],
    effectiveScopes: ['sandbox:generate'],
    roomSlug: 'ai-room',
    appId: 'onboarding',
    appUrl: 'about:srcdoc',
    themeTokens: {},
  },
}));

vi.mock('@privos_ai/app-react', () => ({
  usePrivosApp: () => host.app,
  usePrivosContext: () => host.context,
}));

import { AiGeneratorPage, aiCallDisplayLabel } from '../src/ui/onboarding/ai/ai-generator';
import {
  AiStepGenerating,
  GENERATING_SUBLINE,
  generationPercent,
  moduleAttention,
  moduleProgress,
} from '../src/ui/onboarding/ai/ai-step-generating';

const FRAMES = ['t1-overview', 't1-access', 't1-navigation', 't1-core'];
const TITLES = ['Tổng quan chương trình hội nhập', 'Ngày làm việc đầu tiên', 'Kênh giao tiếp nội bộ', 'Phân loại dữ liệu'];

function moduleAt(index: number): TemplateOutlineModule {
  return {
    moduleLocalId: 'm' + String(index), frameKey: FRAMES[index], order: index, title: TITLES[index], description: '',
    estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['handbook#s' + String(index + 1)],
    responsibilityIndexes: [], coverage: 'sufficient',
  };
}

const questions = (count: number) => Array.from({ length: count }, (_, index) => ({
  localId: 'q' + String(index), level: 'recall' as const, prompt: 'Câu ' + String(index), correctOptionId: 'a', explanation: '',
  options: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id })), blockIds: [], sourceRefs: [],
}));

function run(index: number, patch: Partial<AiModuleDraftRun> = {}): AiModuleDraftRun {
  return { outline: moduleAt(index), outlineRevision: 3, lessonState: 'queued', lessonVersion: 0, questionState: 'blocked', questionVersion: 0, ...patch };
}

function doneRun(index: number, count = 4): AiModuleDraftRun {
  return run(index, {
    lessonState: 'approved', lessonVersion: 1, approvedLessonVersion: 1, lessonProvenance: 'ai',
    questionState: 'approved', questionVersion: 1, approvedQuestionVersion: 1, questionLessonVersion: 1,
    questionProvenance: 'ai', questionDraft: questions(count),
  });
}

function templateJob(runs: readonly AiModuleDraftRun[], patch: Partial<AiJobRecord> = {}): AiJobRecord {
  return {
    id: 'template-row', roomId: 'room-1', jobId: 'template-1', kind: 'template', status: 'running', templateKind: 'normal',
    inventoryJobId: 'inventory-1', sourceIds: ['handbook'], promptVersion: 'test', stageOutputs: {}, operationId: 'template-op',
    pipelineVersion: 'module_v2', planPending: false, autoApprove: true,
    outline: { revision: 3, modules: runs.map((item) => item.outline), flags: [], taskCoverage: [] }, outlineApprovedRevision: 3,
    moduleRuns: runs, calls: [{ callId: 'plan-1', stage: 'P', operationId: 'template-1:plan-1', status: 'completed', planTarget: 'plan' }],
    createdBy: 'admin-1', createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T08:01:00.000Z',
    ...patch,
  } as AiJobRecord;
}

function moduleCall(callId: string, moduleLocalId: string, target: 'lesson' | 'questions', status: AiCallRecord['status'], moduleVersion = 1): AiCallRecord {
  return { callId, stage: 'B', operationId: 'template-1:' + callId, status, moduleLocalId, moduleTarget: target, moduleVersion };
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

function allText(view: TestRenderer.ReactTestRenderer): string {
  return text(view.root);
}

function buttonsByText(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === 'button' && text(node).trim() === label);
}

function rows(view: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return view.root.findAll((node) => node.type === 'li' && String(node.props.className ?? '').includes('ai-generating-module'));
}

function activeStep(view: TestRenderer.ReactTestRenderer): string {
  const stepper = view.root.findByProps({ 'aria-label': 'Các bước' });
  return text(stepper.findAll((node) => node.type === 'li' && node.props['aria-current'] === 'step')[0]).replace(/^\d+/, '');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const views: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const view of views.splice(0)) act(() => view.unmount());
  vi.unstubAllGlobals();
});

describe('moduleProgress', () => {
  it('reports an approved fallback lesson with drafting questions as fallback + running', () => {
    const progress = moduleProgress(run(0, {
      lessonState: 'approved', lessonVersion: 1, approvedLessonVersion: 1, lessonProvenance: 'fallback',
      questionState: 'drafting', questionVersion: 1,
    }), []);
    expect(progress).toMatchObject({ lesson: 'fallback', questions: 'running' });
  });

  it('counts approved questions and marks fallback questions', () => {
    expect(moduleProgress(doneRun(0, 5), [])).toEqual({ lesson: 'done', questions: 'done', questionCount: 5 });
    const fallback = { ...doneRun(1, 3), questionProvenance: 'fallback' as const };
    expect(moduleProgress(fallback, [])).toEqual({ lesson: 'done', questions: 'fallback', questionCount: 3 });
  });

  it('is waiting until a call for the module is live, then running', () => {
    expect(moduleProgress(run(2), [])).toMatchObject({ lesson: 'waiting', questions: 'waiting' });
    expect(moduleProgress(run(2), [moduleCall('module-3', 'm2', 'lesson', 'dispatched', 0)])).toMatchObject({ lesson: 'running', questions: 'waiting' });
    expect(moduleProgress(run(2, { lessonState: 'drafting' }), [])).toMatchObject({ lesson: 'running' });
  });
});

describe('generationPercent', () => {
  it('is the rounded share of finished lesson and question halves', () => {
    expect(generationPercent([doneRun(0), doneRun(1), run(2), run(3)])).toBe(50);
    const lessonOnly = run(2, { lessonState: 'approved', lessonVersion: 1, approvedLessonVersion: 1, questionState: 'queued' });
    expect(generationPercent([doneRun(0), lessonOnly, run(3)])).toBe(50);
    expect(generationPercent([doneRun(0), run(1), run(2)])).toBe(33);
    expect(generationPercent([])).toBe(0);
  });

  it('ignores removed modules', () => {
    const removed = run(3, { outline: { ...moduleAt(3), tombstoned: true } });
    expect(generationPercent([doneRun(0), removed])).toBe(100);
  });
});

describe('moduleAttention', () => {
  it('asks to retry a lesson autopilot could not approve, or failed questions', () => {
    expect(moduleAttention(run(0, { lessonState: 'review_ready', lessonVersion: 2 }))).toMatchObject({ target: 'lesson', expectedVersion: 2, tone: 'warn' });
    expect(moduleAttention(run(0, { lessonState: 'failed', lessonVersion: 2 }))).toMatchObject({ target: 'lesson', expectedVersion: 2, tone: 'error' });
    const failedQuestions = run(0, { lessonState: 'approved', lessonVersion: 1, approvedLessonVersion: 1, questionState: 'failed', questionVersion: 4 });
    expect(moduleAttention(failedQuestions)).toMatchObject({ target: 'questions', expectedVersion: 4, tone: 'error' });
    expect(moduleAttention(doneRun(0))).toBeNull();
    expect(moduleAttention(run(0))).toBeNull();
  });
});

describe('AiStepGenerating', () => {
  function renderStep(job: AiJobRecord, overrides: Partial<Parameters<typeof AiStepGenerating>[0]> = {}) {
    const props = {
      job, stalled: false, error: null, busy: false,
      onRetryModule: vi.fn<(moduleLocalId: string, target: 'lesson' | 'questions', expectedVersion: number) => void>(),
      onRetry: vi.fn<() => void>(),
      ...overrides,
    };
    let view!: TestRenderer.ReactTestRenderer;
    act(() => { view = TestRenderer.create(createElement(AiStepGenerating, props)); });
    views.push(view);
    return { view, props };
  }

  const midway = templateJob([
    doneRun(0, 5),
    run(1, { lessonState: 'approved', lessonVersion: 1, approvedLessonVersion: 1, lessonProvenance: 'fallback', questionState: 'approved', questionVersion: 1, approvedQuestionVersion: 1, questionLessonVersion: 1, questionProvenance: 'fallback', questionDraft: questions(3) }),
    run(2, { lessonState: 'approved', lessonVersion: 1, approvedLessonVersion: 1, lessonProvenance: 'ai', questionState: 'drafting', questionVersion: 1 }),
    run(3, { lessonState: 'drafting', lessonVersion: 1 }),
  ], { calls: [moduleCall('module-7', 'm2', 'questions', 'dispatched'), moduleCall('module-8', 'm3', 'lesson', 'pending')] });

  it('shows the ring, title, sub-line and one row per module with lesson and question chips', () => {
    const { view } = renderStep(midway);
    expect(view.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(63);
    expect(allText(view)).toContain('63%');
    expect(allText(view)).toContain('AI đang viết bài học và câu hỏi');
    expect(GENERATING_SUBLINE).toBe('Giữ cửa sổ này mở trong lúc AI làm việc. Nếu đóng, AI tạm dừng và tiếp tục khi mở lại.');
    expect(allText(view)).toContain(GENERATING_SUBLINE);
    const chips = rows(view).map((row) => row.findAll((node) => String(node.props.className ?? '').startsWith('ai-chip')).map(text));
    expect(chips).toEqual([
      ['Bài học ✓', '5 câu hỏi ✓'],
      ['Bản từ nguồn', 'Câu hỏi dự phòng'],
      ['Bài học ✓', 'Đang tạo câu hỏi…'],
      ['Đang viết…', 'Câu hỏi'],
    ]);
    expect(rows(view).map((row) => text(row.findByProps({ className: 'ai-generating-title' })))).toEqual(TITLES);
  });

  it('colours chips by state only', () => {
    const { view } = renderStep(midway);
    const classes = rows(view).map((row) => row.findAll((node) => String(node.props.className ?? '').startsWith('ai-chip')).map((node) => node.props.className));
    expect(classes).toEqual([
      ['ai-chip ok', 'ai-chip ok'],
      ['ai-chip warn', 'ai-chip warn'],
      ['ai-chip ok', 'ai-chip run'],
      ['ai-chip run', 'ai-chip wait'],
    ]);
  });

  it('has no approve buttons and shows no frame key, call id or provider id', () => {
    const { view } = renderStep(midway);
    expect(view.root.findAllByType('button').filter((button) => text(button).includes('Duyệt'))).toHaveLength(0);
    const html = allText(view);
    for (const raw of [...FRAMES, 'module-7', 'module-8', 'native_chat', 'sandbox', 'm2']) expect(html).not.toContain(raw);
  });

  it('marks a stuck module only once generation has stalled, with an inline Thử lại', () => {
    const stuck = templateJob([doneRun(0), run(1, { lessonState: 'approved', lessonVersion: 1, approvedLessonVersion: 1, questionState: 'failed', questionVersion: 2 })]);
    const running = renderStep(stuck);
    expect(buttonsByText(running.view.root, 'Thử lại')).toHaveLength(0);
    const notAutopilot = renderStep({ ...stuck, autoApprove: undefined }, { stalled: true });
    expect(buttonsByText(notAutopilot.view.root, 'Thử lại')).toHaveLength(1);
    expect(rows(notAutopilot.view).every((row) => buttonsByText(row, 'Thử lại').length === 0)).toBe(true);
    const { view, props } = renderStep(stuck, { stalled: true });
    expect(rows(view)[1].props.className).toContain('error');
    expect(text(rows(view)[1])).toContain('AI chưa tạo được câu hỏi.');
    act(() => buttonsByText(rows(view)[1], 'Thử lại')[0].props.onClick());
    expect(props.onRetryModule).toHaveBeenCalledWith('m1', 'questions', 2);
  });

  it('labels the stuck half Cần thử lại: amber for a lesson autopilot could not approve', () => {
    const { view } = renderStep(templateJob([run(0, { lessonState: 'review_ready', lessonVersion: 2 })]), { stalled: true });
    const chips = rows(view)[0].findAll((node) => String(node.props.className ?? '').startsWith('ai-chip'));
    expect(chips.map(text)).toEqual(['Cần thử lại', 'Câu hỏi']);
    expect(chips[0].props.className).toBe('ai-chip warn');
  });

  it('never leaves a stall silent: without a stuck module it offers a step-level Thử lại', () => {
    const { view, props } = renderStep(templateJob([doneRun(0), run(1)]), { stalled: true });
    const banner = view.root.findByProps({ className: 'ai-generating-banner warn' });
    act(() => buttonsByText(banner, 'Thử lại')[0].props.onClick());
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows one red banner with the error and Thử lại', () => {
    const { view, props } = renderStep(templateJob([run(0)], { status: 'failed' }), { error: 'Nhà cung cấp AI tạm thời không hoàn tất yêu cầu.' });
    const banners = view.root.findAll((node) => String(node.props.className ?? '').startsWith('ai-generating-banner'));
    expect(banners).toHaveLength(1);
    expect(banners[0].props.className).toBe('ai-generating-banner error');
    expect(banners[0].props.role).toBe('alert');
    expect(text(banners[0])).toContain('Nhà cung cấp AI tạm thời không hoàn tất yêu cầu.');
    act(() => buttonsByText(banners[0], 'Thử lại')[0].props.onClick());
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('module call labels', () => {
  it('names module calls in Vietnamese, never by call id', () => {
    const calls = [moduleCall('module-3', 'm0', 'lesson', 'completed'), moduleCall('module-4', 'm0', 'questions', 'dispatched')];
    expect(aiCallDisplayLabel(calls[0], calls)).toBe('Tạo bài học');
    expect(aiCallDisplayLabel(calls[1], calls)).toBe('Tạo câu hỏi');
    expect(aiCallDisplayLabel({ callId: 'module-9' }, calls)).toBe('Tạo nội dung module');
  });
});

describe('AI tạo nội dung in the generator', () => {
  const source = {
    id: 'source-row', roomId: 'room-1', sourceId: 'handbook', kind: 'document' as const, fileName: 'Sổ tay hội nhập.pdf',
    mimeType: 'application/pdf', checksum: 'c', systemName: 'PrivOS', status: 'ready' as const, textLength: 2000,
    createdBy: 'admin-1', createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
  };
  const inventory = {
    id: 'inventory-row', roomId: 'room-1', jobId: 'inventory-1', kind: 'inventory', status: 'completed', sourceIds: ['handbook'],
    promptVersion: 'test', calls: [], stageOutputs: {}, result: { features: [], glossary: [], conflicts: [] }, operationId: 'inv',
    planPending: false, createdBy: 'admin-1', createdAt: '2026-10-29T07:00:00.000Z', updatedAt: '2026-10-29T07:01:00.000Z',
  } as unknown as AiJobRecord;
  const review = {
    id: 'draft-1', version: 1, employeeType: 'normal', title: 'Hội nhập', description: '', source: 'ai_generated', status: 'draft',
    locked: false, maxAttempts: 2, modules: [], flags: [], updatedAt: 'now', passingScore: 70,
  } as unknown as AdminTemplateDetail;
  const catalog = { sources: [{ sourceId: 'handbook', fileName: 'Sổ tay hội nhập.pdf', sections: [1, 2, 3, 4].map((n) => ({ id: 'handbook#s' + String(n), headingPath: ['Mục ' + String(n)], usable: true })) }] };

  function stubStorage() {
    const storage = new Map<string, string>([['onboarding:ai:template:room-1', 'template-1']]);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  }

  function apiFor(job: AiJobRecord, handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
    return { adminAi: vi.fn(async (action: string, args: Record<string, unknown> = {}) => {
      if (handlers[action]) return handlers[action](args);
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [inventory, job] };
      if (action === 'list_module_sources') return catalog;
      if (action === 'get_review') return { review };
      throw new Error('Unexpected action: ' + action);
    }) };
  }

  async function renderPage(api: unknown) {
    stubStorage();
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose: () => undefined, onComplete: () => undefined }));
    });
    views.push(view);
    return view;
  }

  function footerPrimary(view: TestRenderer.ReactTestRenderer): ReactTestInstance {
    const primaries = view.root.findByType('footer').findAll((node) => node.type === 'button' && String(node.props.className).includes('button-primary'));
    expect(primaries).toHaveLength(1);
    return primaries[0];
  }

  const actions = (api: { adminAi: { mock: { calls: unknown[][] } } }) => api.adminAi.mock.calls.map(([action]) => action as string);

  it('upgrades an old job to autopilot once on reopen and resumes it without a click', async () => {
    const legacy = templateJob([doneRun(0), run(1)], { autoApprove: undefined });
    const enabled = { ...legacy, autoApprove: true };
    const api = apiFor(legacy, {
      enable_autopilot: () => ({ job: enabled }),
      next_step: () => ({ kind: 'awaiting_admin', job: enabled }),
    });
    const view = await renderPage(api);
    expect(activeStep(view)).toBe('AI tạo nội dung');
    expect(actions(api).filter((action) => action === 'enable_autopilot')).toHaveLength(1);
    expect(api.adminAi).toHaveBeenCalledWith('enable_autopilot', { jobId: 'template-1' });
    expect(actions(api).indexOf('enable_autopilot')).toBeLessThan(actions(api).indexOf('next_step'));
    expect(rows(view)).toHaveLength(2);
    expect(view.root.findAllByType('button').filter((button) => text(button).includes('Duyệt'))).toHaveLength(0);
  });

  it('does not re-enable autopilot for a job that already has it', async () => {
    const job = templateJob([doneRun(0), run(1)]);
    const api = apiFor(job, { next_step: () => ({ kind: 'awaiting_admin', job }) });
    await renderPage(api);
    expect(actions(api)).not.toContain('enable_autopilot');
    expect(actions(api)).toContain('next_step');
  });

  it('opens Xem lại & xuất bản by itself when the job is done', async () => {
    const job = templateJob([doneRun(0), run(1)]);
    const done = templateJob([doneRun(0), doneRun(1)], { status: 'completed', result: { templateId: 'draft-1', version: 1 } });
    const api = apiFor(job, { next_step: () => ({ kind: 'done', job: done }) });
    const view = await renderPage(api);
    expect(api.adminAi).toHaveBeenCalledWith('get_review', { templateId: 'draft-1', version: 1 });
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
  });

  it('goes back to Kiểm tra độ phủ when the server needs the outline checked again', async () => {
    const job = templateJob([doneRun(0), run(1)]);
    const paused = { ...job, outlineApprovedRevision: 0 };
    const api = apiFor(job, { next_step: () => ({ kind: 'awaiting_admin', job: paused }) });
    const view = await renderPage(api);
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    expect(allText(view)).toContain('Lộ trình cần kiểm tra lại trước khi tạo tiếp.');
  });

  it('retries a stuck module from its row and pumps again', async () => {
    const stuckRun = run(1, { lessonState: 'approved', lessonVersion: 1, approvedLessonVersion: 1, questionState: 'failed', questionVersion: 2 });
    const stuck = templateJob([doneRun(0), stuckRun]);
    const requeued = templateJob([doneRun(0), { ...stuckRun, questionState: 'queued', questionVersion: 3 }]);
    let retried = false;
    const api = apiFor(stuck, {
      next_step: () => ({ kind: 'awaiting_admin', job: retried ? requeued : stuck }),
      retry_module: () => { retried = true; return { job: requeued }; },
    });
    const view = await renderPage(api);
    expect(activeStep(view)).toBe('AI tạo nội dung');
    expect(rows(view)[1].props.className).toContain('error');
    const chips = rows(view)[1].findAll((node) => String(node.props.className ?? '').startsWith('ai-chip'));
    expect(chips.map(text)).toEqual(['Bài học ✓', 'Cần thử lại']);
    expect(chips[1].props.className).toBe('ai-chip error');
    await act(async () => { buttonsByText(rows(view)[1], 'Thử lại')[0].props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('retry_module', { jobId: 'template-1', moduleLocalId: 'm1', target: 'questions', expectedVersion: 2 });
    expect(actions(api).lastIndexOf('next_step')).toBeGreaterThan(actions(api).indexOf('retry_module'));
  });

  it('keeps pumping after question recovery so autopilot approves the fallback', async () => {
    const lessonDraft = { localId: 'm1', frameKey: 't1-access', title: 'Ngày làm việc đầu tiên', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], questions: [], blocks: [{ localId: 'b', kind: 'concept' as const, body: 'Nội dung có nguồn.', sourceRefs: [{ sectionId: 'handbook#s2', quote: 'Nội dung có nguồn.' }] }] };
    const lessonDone = { lessonState: 'approved' as const, lessonVersion: 1, approvedLessonVersion: 1, lessonDraft, lessonProvenance: 'ai' as const };
    const failed = templateJob([doneRun(0), run(1, { ...lessonDone, questionState: 'failed', questionVersion: 2 })], {
      calls: [{ ...moduleCall('module-5', 'm1', 'questions', 'failed', 2), provider: 'sandbox', attemptRef: 'sandbox-attempt' }],
    });
    const fallbackReady = templateJob([doneRun(0), run(1, { ...lessonDone, questionState: 'review_ready', questionVersion: 3, questionLessonVersion: 1, questionProvenance: 'fallback', questionDraft: questions(3) })]);
    const done = templateJob([doneRun(0), doneRun(1)], { status: 'completed', result: { templateId: 'draft-1', version: 1 } });
    let pumps = 0;
    const api = apiFor(failed, {
      next_step: () => (pumps++ === 0 ? { kind: 'awaiting_admin', job: failed } : { kind: 'done', job: done }),
      use_question_fallback: () => ({ job: fallbackReady }),
    });
    const view = await renderPage(api);
    expect(actions(api).filter((action) => action === 'use_question_fallback')).toHaveLength(1);
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
  });

  it('shows a red banner for a failed job and retries it with retry_job then pumps', async () => {
    const job = templateJob([doneRun(0), run(1)]);
    const failed = { ...job, status: 'failed' as const, errorCode: 'AI_TIMEOUT', errorMessage: 'Timed out.' };
    let pumps = 0;
    const api = apiFor(job, {
      next_step: () => (pumps++ === 0 ? { kind: 'failed', job: failed } : { kind: 'awaiting_admin', job }),
      retry_job: () => ({ job }),
    });
    const view = await renderPage(api);
    const banner = view.root.findByProps({ className: 'ai-generating-banner error' });
    expect(text(banner)).toContain('AI xử lý quá thời gian. Hãy thử lại job.');
    expect(allText(view)).not.toContain('Timed out.');
    await act(async () => { buttonsByText(banner, 'Thử lại')[0].props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('retry_job', { jobId: 'template-1' });
    expect(actions(api).lastIndexOf('next_step')).toBeGreaterThan(actions(api).indexOf('retry_job'));
    expect(view.root.findAll((node) => String(node.props.className ?? '').startsWith('ai-generating-banner error'))).toHaveLength(0);
  });

  it('pauses autopilot from the footer and goes back to Kiểm tra độ phủ', async () => {
    const job = templateJob([doneRun(0), run(1)]);
    const step = deferred<unknown>();
    const paused = { ...job, outlineApprovedRevision: 0 };
    const api = apiFor(job, { next_step: () => step.promise, pause_autopilot: () => ({ job: paused }) });
    const view = await renderPage(api);
    expect(activeStep(view)).toBe('AI tạo nội dung');
    expect(text(footerPrimary(view))).toBe('Xem lại template');
    expect(footerPrimary(view).props.disabled).toBe(true);
    const pause = buttonsByText(view.root.findByType('footer'), 'Tạm dừng & sửa lộ trình');
    expect(pause).toHaveLength(1);
    expect(pause[0].props.disabled).toBe(false);
    await act(async () => { pause[0].props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('pause_autopilot', { jobId: 'template-1' });
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    await act(async () => { step.resolve({ kind: 'awaiting_admin', job }); await Promise.resolve(); });
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
  });

  it('never pumps a job whose autopilot upgrade failed; the banner retries the upgrade first', async () => {
    const legacy = templateJob([doneRun(0), run(1, { lessonState: 'review_ready', lessonVersion: 1 })], { autoApprove: undefined });
    const enabled = { ...legacy, autoApprove: true };
    let upgrades = 0;
    const api = apiFor(legacy, {
      enable_autopilot: () => {
        if (upgrades++ === 0) throw Object.assign(new Error('Project busy'), { code: 'PROJECT_BUSY' });
        return { job: enabled };
      },
      next_step: () => ({ kind: 'awaiting_admin', job: enabled }),
    });
    const view = await renderPage(api);
    expect(activeStep(view)).toBe('AI tạo nội dung');
    expect(actions(api)).not.toContain('next_step');
    expect(allText(view)).toContain('AI của room đang bận. Hãy thử lại sau ít phút.');
    const banner = view.root.findByProps({ className: 'ai-generating-banner error' });
    expect(text(banner)).toContain('Chưa bật được chế độ AI tự động cho job này.');
    // A draft-rewriting retry is never offered for a job autopilot does not approve.
    expect(rows(view).every((row) => buttonsByText(row, 'Thử lại').length === 0)).toBe(true);
    await act(async () => { buttonsByText(banner, 'Thử lại')[0].props.onClick(); });
    expect(actions(api).filter((action) => action === 'enable_autopilot')).toHaveLength(2);
    expect(actions(api).indexOf('next_step')).toBeGreaterThan(actions(api).lastIndexOf('enable_autopilot'));
    expect(actions(api)).not.toContain('retry_module');
  });

  it('keeps going through more than 12 recoveries while the job progresses', async () => {
    const lessonDraft = { localId: 'm1', frameKey: 't1-access', title: 'Ngày làm việc đầu tiên', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], questions: [], blocks: [{ localId: 'b', kind: 'concept' as const, body: 'Nội dung có nguồn.', sourceRefs: [{ sectionId: 'handbook#s2', quote: 'Nội dung có nguồn.' }] }] };
    const lessonDone = { lessonState: 'approved' as const, lessonVersion: 1, approvedLessonVersion: 1, lessonDraft, lessonProvenance: 'ai' as const };
    const failedAt = (k: number) => templateJob([doneRun(0), run(1, { ...lessonDone, questionState: 'failed', questionVersion: 2 * k })], {
      calls: [{ ...moduleCall('module-' + String(k), 'm1', 'questions', 'failed', 2 * k), provider: 'sandbox', attemptRef: 'sandbox-' + String(k) }],
    });
    const readyAt = (k: number) => templateJob([doneRun(0), run(1, { ...lessonDone, questionState: 'review_ready', questionVersion: 2 * k + 1, questionLessonVersion: 1, questionProvenance: 'fallback', questionDraft: questions(3) })]);
    const done = templateJob([doneRun(0), doneRun(1)], { status: 'completed', result: { templateId: 'draft-1', version: 1 } });
    const RECOVERIES = 15;
    let pumps = 0;
    const api = apiFor(templateJob([doneRun(0), run(1, lessonDone)]), {
      next_step: () => {
        pumps += 1;
        return pumps <= RECOVERIES ? { kind: 'awaiting_admin', job: failedAt(pumps) } : { kind: 'done', job: done };
      },
      use_question_fallback: (args) => ({ job: readyAt(Number(args.expectedVersion) / 2) }),
    });
    const view = await renderPage(api);
    expect(actions(api).filter((action) => action === 'use_question_fallback')).toHaveLength(RECOVERIES);
    expect(actions(api).filter((action) => action === 'next_step')).toHaveLength(RECOVERIES + 1);
    expect(view.root.findAll((node) => String(node.props.className ?? '').startsWith('ai-generating-banner'))).toHaveLength(0);
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
  });

  it('shows the error of a failed retry_job call itself, not the stored job error', async () => {
    const job = templateJob([doneRun(0), run(1)], { status: 'failed', errorCode: 'AI_TIMEOUT', errorMessage: 'Timed out.' });
    const api = apiFor(job, {
      retry_job: () => { throw Object.assign(new Error('No failed AI call is available to retry.'), { code: 'JOB_CALL_MISMATCH' }); },
    });
    const view = await renderPage(api);
    const before = view.root.findByProps({ className: 'ai-generating-banner error' });
    expect(text(before)).toContain('AI xử lý quá thời gian. Hãy thử lại job.');
    expect(actions(api)).not.toContain('next_step');
    await act(async () => { buttonsByText(before, 'Thử lại')[0].props.onClick(); });
    const after = view.root.findByProps({ className: 'ai-generating-banner error' });
    expect(text(after)).toContain('Lượt gọi AI không còn khớp. Hãy thử lại.');
    expect(text(after)).not.toContain('AI xử lý quá thời gian');
  });

  it('starts exactly one pump chain when Tạo template approves the outline', async () => {
    const draft = templateJob([0, 1, 2, 3].map((index) => run(index)), { outlineApprovedRevision: 0 });
    const approved = { ...draft, outlineApprovedRevision: 3 };
    const first = deferred<unknown>();
    let steps = 0;
    const api = apiFor(draft, {
      approve_outline: () => ({ job: approved }),
      next_step: () => (steps++ === 0 ? first.promise : { kind: 'awaiting_admin', job: approved }),
    });
    const view = await renderPage(api);
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    await act(async () => { footerPrimary(view).props.onClick(); });
    expect(activeStep(view)).toBe('AI tạo nội dung');
    // While the first next_step is in flight nothing else starts a pump for the job.
    expect(actions(api).filter((action) => action === 'next_step')).toHaveLength(1);
    await act(async () => { first.resolve({ kind: 'awaiting_admin', job: approved }); await Promise.resolve(); });
    // One chain: the first pass plus the idle pass that ends it; a second chain would add more.
    expect(actions(api).filter((action) => action === 'next_step')).toHaveLength(2);
    const workers = new Set(api.adminAi.mock.calls.filter(([action]) => action === 'next_step').map(([, args]) => (args as { workerId: string }).workerId));
    expect(workers.size).toBe(2);
  });

  it('opens the review instead of a red banner when the final next_step times out but the job completed', async () => {
    const job = templateJob([doneRun(0), run(1)]);
    const done = templateJob([doneRun(0), doneRun(1)], { status: 'completed', result: { templateId: 'draft-1', version: 1 } });
    let timedOut = false;
    const api = apiFor(job, {
      next_step: () => { timedOut = true; throw new Error('tools/call timeout'); },
      get_job: () => ({ job: timedOut ? done : job }),
    });
    const view = await renderPage(api);
    expect(actions(api).filter((action) => action === 'next_step')).toHaveLength(1);
    expect(api.adminAi).toHaveBeenCalledWith('get_job', { jobId: 'template-1' });
    expect(view.root.findAll((node) => String(node.props.className ?? '').startsWith('ai-generating-banner'))).toHaveLength(0);
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
  });

  it('polls a timed-out job that completed without its result yet, without pumping it again', async () => {
    const job = templateJob([doneRun(0), run(1)]);
    const finishing = templateJob([doneRun(0), doneRun(1)], { status: 'completed' });
    const done = { ...finishing, result: { templateId: 'draft-1', version: 1 } };
    const step = deferred<unknown>();
    let reads = 0;
    const api = apiFor(job, {
      next_step: () => step.promise,
      get_job: () => ({ job: reads++ === 0 ? finishing : done }),
    });
    const view = await renderPage(api);
    vi.useFakeTimers();
    try {
      await act(async () => { step.resolve(Promise.reject(new Error('tools/call timeout'))); await vi.advanceTimersByTimeAsync(0); });
      expect(reads).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    } finally {
      vi.useRealTimers();
    }
    await act(async () => { await Promise.resolve(); });
    expect(reads).toBe(2);
    expect(actions(api).filter((action) => action === 'next_step')).toHaveLength(1);
    expect(view.root.findAll((node) => String(node.props.className ?? '').startsWith('ai-generating-banner'))).toHaveLength(0);
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
  });

  it('shows the Vietnamese timeout banner only when reconciling the job fails too', async () => {
    const job = templateJob([doneRun(0), run(1)]);
    const api = apiFor(job, {
      next_step: () => { throw new Error('tools/call timeout'); },
      get_job: () => { throw new Error('tools/call timeout'); },
    });
    const view = await renderPage(api);
    const banner = view.root.findByProps({ className: 'ai-generating-banner error' });
    expect(text(banner)).toContain('Máy chủ phản hồi chậm. Hãy bấm Thử lại.');
  });

  it('opens a restored completed job on its review without pumping', async () => {
    const done = templateJob([doneRun(0), doneRun(1)], { status: 'completed', result: { templateId: 'draft-1', version: 1 } });
    const api = apiFor(done);
    const view = await renderPage(api);
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
    expect(actions(api)).not.toContain('next_step');
    expect(actions(api)).not.toContain('enable_autopilot');
  });
});
