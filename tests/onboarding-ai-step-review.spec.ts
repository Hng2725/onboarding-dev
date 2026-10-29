import { createElement } from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AiJobRecord, AiModuleDraftRun, TemplateOutlineModule, VerificationFlag } from '../src/onboarding/contracts';
import type { GeneratedModule, GeneratedQuestion } from '../src/onboarding/ai/validate';
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
vi.mock('../src/ui/onboarding/roomfiles', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ui/onboarding/roomfiles')>(),
  ensureTemplateRoomfilesFolder: async () => ({ rootId: 'root', documentsId: 'documents', templatesId: 'templates', templateFolderId: 'folder' }),
}));

import { AiGeneratorPage } from '../src/ui/onboarding/ai/ai-generator';
import { AiStepReview, type AiStepReviewProps } from '../src/ui/onboarding/ai/ai-step-review';

const TITLES = ['Tổng quan chương trình hội nhập', 'Ngày làm việc đầu tiên'];
const FRAMES = ['t1-overview', 't1-access'];

function moduleAt(index: number): TemplateOutlineModule {
  return {
    moduleLocalId: 'm' + String(index), frameKey: FRAMES[index], order: index, title: TITLES[index], description: '',
    estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['handbook#s' + String(index + 1)],
    responsibilityIndexes: [], coverage: 'sufficient',
  };
}

function lessonFor(index: number): GeneratedModule {
  return {
    localId: 'm' + String(index), frameKey: FRAMES[index], title: TITLES[index], description: 'Mô tả module.',
    estimatedMinutes: 10, objectives: ['Hiểu chương trình', 'Biết kênh hỗ trợ', 'Nắm mục tiêu'], featureIds: [], questions: [],
    blocks: [
      { localId: 'b1', kind: 'concept', title: 'Mục đích', body: 'Trong 30 ngày đầu, nhân viên mới cần hiểu cách phối hợp.', sourceRefs: [{ sectionId: 'handbook#s1', quote: 'Trong 30 ngày đầu' }] },
      { localId: 'b2', kind: 'steps', body: 'Làm theo thứ tự.', steps: [{ order: 1, text: 'Nhận máy' }], sourceRefs: [] },
    ],
  };
}

function questionsFor(count: number): GeneratedQuestion[] {
  return Array.from({ length: count }, (_, index) => ({
    localId: 'q' + String(index), level: 'recall' as const, prompt: 'Câu hỏi số ' + String(index + 1), correctOptionId: 'a', explanation: 'Vì sổ tay nói vậy.',
    options: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: 'Đáp án ' + id })), blockIds: ['b1'], sourceRefs: [{ sectionId: 'handbook#s1', quote: 'Trong 30 ngày đầu' }],
  }));
}

function doneRun(index: number, count: number, patch: Partial<AiModuleDraftRun> = {}): AiModuleDraftRun {
  return {
    outline: moduleAt(index), outlineRevision: 3,
    lessonState: 'approved', lessonVersion: 2, approvedLessonVersion: 2, lessonProvenance: 'ai', lessonDraft: lessonFor(index),
    questionState: 'approved', questionVersion: 4, approvedQuestionVersion: 4, questionLessonVersion: 2, questionProvenance: 'ai',
    questionDraft: questionsFor(count),
    ...patch,
  };
}

function moduleJob(runs: readonly AiModuleDraftRun[], patch: Partial<AiJobRecord> = {}): AiJobRecord {
  return {
    id: 'template-row', roomId: 'room-1', jobId: 'template-1', kind: 'template', status: 'completed', templateKind: 'normal',
    inventoryJobId: 'inventory-1', sourceIds: ['handbook'], promptVersion: 'test', stageOutputs: {}, operationId: 'template-op',
    pipelineVersion: 'module_v2', planPending: false, autoApprove: true, title: 'Hội nhập nhân viên mới',
    outline: { revision: 3, modules: runs.map((item) => item.outline), flags: [], taskCoverage: [] }, outlineApprovedRevision: 3,
    moduleRuns: runs, calls: [], result: { templateId: 'draft-1', version: 1 },
    createdBy: 'admin-1', createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T08:01:00.000Z',
    ...patch,
  } as AiJobRecord;
}

function blockingFlag(moduleId: string): VerificationFlag {
  return {
    id: 'flag-1', type: 'missing', severity: 'blocking', status: 'open', message: 'Thiếu số điện thoại hỗ trợ.',
    questionForAdmin: 'Số điện thoại hỗ trợ là gì?', location: { moduleId }, evidence: [],
  } as VerificationFlag;
}

function reviewFor(flags: readonly VerificationFlag[] = []): AdminTemplateDetail {
  return {
    id: 'draft-1', version: 1, employeeType: 'normal', title: 'Hội nhập nhân viên mới – Công ty ABC', description: '', source: 'ai_generated',
    status: 'draft', locked: false, maxAttempts: 2, passingScore: 70, updatedAt: 'now', flags,
    modules: [0, 1].map((index) => ({ id: 'ai-mod-' + String(index), key: FRAMES[index], title: TITLES[index], description: '', order: index, resources: [], questions: [] })),
    content: { assessmentMode: 'per_module', learningMode: 'sequential', maxAttemptsPerModule: 2, questionMeta: [], modules: [] },
  } as unknown as AdminTemplateDetail;
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

function buttonsByText(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === 'button' && text(node).trim() === label);
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = buttonsByText(root, label);
  expect(found, 'button ' + label).toHaveLength(1);
  return found[0];
}

const views: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const view of views.splice(0)) act(() => view.unmount());
  vi.unstubAllGlobals();
});

describe('AiStepReview', () => {
  function renderReview(overrides: Partial<AiStepReviewProps> = {}) {
    const props: AiStepReviewProps = {
      job: moduleJob([doneRun(0, 5), doneRun(1, 4)]),
      review: reviewFor(),
      updating: false,
      busy: false,
      settings: { passingScore: 70, maxAttemptsPerModule: 2, learningMode: 'sequential' },
      onSettings: vi.fn(),
      onSaveLesson: vi.fn(),
      onSaveQuestions: vi.fn(),
      onRewrite: vi.fn(),
      onResolveFlag: vi.fn(),
      sourceNames: new Map([['handbook', 'Sổ tay.pdf']]),
      ...overrides,
    };
    let view!: TestRenderer.ReactTestRenderer;
    act(() => { view = TestRenderer.create(createElement(AiStepReview, props)); });
    views.push(view);
    return { view, props };
  }

  function moduleButtons(view: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
    return view.root.findByProps({ 'aria-label': 'Danh sách module' }).findAllByType('button');
  }

  it('lists every module of a 2-module job with its question count', () => {
    const { view } = renderReview();
    expect(text(view.root)).toContain('Hội nhập nhân viên mới – Công ty ABC');
    const items = moduleButtons(view);
    expect(items).toHaveLength(2);
    expect(items.map(text)).toEqual(['1. Tổng quan chương trình hội nhập5 câu', '2. Ngày làm việc đầu tiên4 câu']);
  });

  it('shows the lesson with Vietnamese block kinds, citation chips and lesson meta, never raw kinds', () => {
    const { view } = renderReview();
    const all = text(view.root);
    expect(all).toContain('Khái niệm');
    expect(all).toContain('Các bước');
    expect(all).not.toMatch(/\bconcept\b|\bsteps\b/);
    expect(all).toContain('10 phút · 3 mục tiêu học tập');
    const chip = view.root.find((node) => String(node.props.className ?? '') === 'ai-cite');
    expect(text(chip)).toBe('Sổ tay · mục 1');
    expect(buttonsByText(view.root, 'Chỉnh sửa')).toHaveLength(1);
    expect(buttonsByText(view.root, 'AI viết lại')).toHaveLength(1);
  });

  it('switches modules and shows questions with Vietnamese levels in the Câu hỏi tab', () => {
    const { view } = renderReview();
    act(() => moduleButtons(view)[1].props.onClick());
    const tab = button(view.root, 'Câu hỏi (4)');
    act(() => tab.props.onClick());
    const all = text(view.root);
    expect(all).toContain('Câu 1 · Ghi nhớ');
    expect(all).not.toContain('recall');
    expect(all).toContain('Câu hỏi số 4');
  });

  it('saves an edited lesson only after the inline confirmation is accepted', () => {
    const { view, props } = renderReview();
    act(() => button(view.root, 'Chỉnh sửa').props.onClick());
    const title = view.root.findByProps({ 'aria-label': 'Tiêu đề bài học' });
    act(() => title.props.onChange({ target: { value: 'Tổng quan mới' } }));
    act(() => button(view.root, 'Lưu bài học').props.onClick());
    expect(props.onSaveLesson).not.toHaveBeenCalled();
    expect(text(view.root)).toContain('Câu hỏi của module này sẽ được AI tạo lại cho khớp bài học mới.');
    act(() => button(view.root, 'Hủy').props.onClick());
    expect(props.onSaveLesson).not.toHaveBeenCalled();
    act(() => button(view.root, 'Lưu bài học').props.onClick());
    act(() => button(view.root, 'Lưu và tạo lại câu hỏi').props.onClick());
    expect(props.onSaveLesson).toHaveBeenCalledTimes(1);
    expect(props.onSaveLesson).toHaveBeenCalledWith('m0', expect.objectContaining({ title: 'Tổng quan mới', localId: 'm0' }), 2);
  });

  it('saves edited questions with their version, and needs 3 to 5 questions', () => {
    const { view, props } = renderReview();
    act(() => button(view.root, 'Câu hỏi (5)').props.onClick());
    act(() => button(view.root, 'Chỉnh sửa').props.onClick());
    act(() => button(view.root, 'Thêm câu hỏi').props.onClick());
    expect(button(view.root, 'Lưu câu hỏi').props.disabled).toBe(true);
    expect(text(view.root)).toContain('Cần từ 3 đến 5 câu hỏi.');
    act(() => buttonsByText(view.root, 'Xóa câu hỏi').at(-1)!.props.onClick());
    act(() => button(view.root, 'Lưu câu hỏi').props.onClick());
    expect(props.onSaveQuestions).toHaveBeenCalledWith('m0', expect.arrayContaining([expect.objectContaining({ localId: 'q0' })]), 4);
  });

  it('asks AI to rewrite the lesson with the lesson version', () => {
    const { view, props } = renderReview();
    act(() => button(view.root, 'AI viết lại').props.onClick());
    expect(props.onRewrite).toHaveBeenCalledWith('m0', 2);
  });

  it('keeps the module content on screen with Đang cập nhật… while updating', () => {
    const { view } = renderReview({ updating: true });
    const all = text(view.root);
    expect(all).toContain('Đang cập nhật…');
    expect(all).toContain('Trong 30 ngày đầu, nhân viên mới cần hiểu cách phối hợp.');
    expect(button(view.root, 'Chỉnh sửa').props.disabled).toBe(true);
    expect(button(view.root, 'AI viết lại').props.disabled).toBe(true);
  });

  it('shows the settings pills and edits them in a small popover', () => {
    const { view, props } = renderReview();
    const pills = view.root.findAll((node) => node.type === 'button' && String(node.props.className ?? '').includes('ai-pill'));
    expect(pills.map(text)).toEqual(['Đạt 70%', '2 lượt/module', 'Tuần tự']);
    expect(view.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    act(() => pills[1].props.onClick());
    const popover = view.root.findByProps({ role: 'dialog' });
    expect(popover.findAllByType('input')).toHaveLength(2);
    expect(popover.findAllByType('select')).toHaveLength(1);
    act(() => popover.findAllByType('input')[0].props.onChange({ target: { value: '80' } }));
    expect(props.onSettings).toHaveBeenCalledWith({ passingScore: 80 });
    act(() => popover.findByType('select').props.onChange({ target: { value: 'free' } }));
    expect(props.onSettings).toHaveBeenCalledWith({ learningMode: 'free' });
    act(() => button(popover, 'Xong').props.onClick());
    expect(view.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);

    const unlimited = renderReview({ settings: { passingScore: 85, maxAttemptsPerModule: null, learningMode: 'free' } });
    const unlimitedPills = unlimited.view.root.findAll((node) => node.type === 'button' && String(node.props.className ?? '').includes('ai-pill'));
    expect(unlimitedPills.map(text)).toEqual(['Đạt 85%', 'Không giới hạn', 'Tự do']);
  });

  it('shows the open flags of the selected module inline and resolves them', () => {
    const { view, props } = renderReview({ review: reviewFor([blockingFlag('ai-mod-1')]) });
    expect(view.root.findAll((node) => String(node.props.className ?? '') === 'ai-flag-panel')).toHaveLength(0);
    expect(text(moduleButtons(view)[1])).toContain('1');
    act(() => moduleButtons(view)[1].props.onClick());
    const panel = view.root.find((node) => String(node.props.className ?? '') === 'ai-flag-panel');
    expect(text(panel)).toContain('Thiếu số điện thoại hỗ trợ.');
    act(() => buttonsByText(panel, 'Loại bỏ nội dung')[0].props.onClick());
    expect(props.onResolveFlag).toHaveBeenCalledWith(expect.objectContaining({ id: 'flag-1' }), 'remove');
  });

  it('shows a stuck module with its error and Thử lại once updating stalled', () => {
    const stuck = doneRun(0, 5, { questionState: 'failed', questionVersion: 6, approvedQuestionVersion: undefined });
    const onRetryModule = vi.fn();
    const { view } = renderReview({ job: moduleJob([stuck, doneRun(1, 4)], { status: 'running', result: null }), review: null, stalled: true, onRetryModule });
    expect(text(view.root)).toContain('AI chưa tạo được câu hỏi.');
    act(() => button(view.root, 'Thử lại').props.onClick());
    expect(onRetryModule).toHaveBeenCalledWith('m0', 'questions', 6);
  });
});

describe('Xem lại & xuất bản in the generator', () => {
  const source = {
    id: 'source-row', roomId: 'room-1', sourceId: 'handbook', kind: 'document' as const, fileName: 'Sổ tay.pdf',
    mimeType: 'application/pdf', checksum: 'c', systemName: 'PrivOS', status: 'ready' as const, textLength: 2000,
    createdBy: 'admin-1', createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
  };
  const inventory = {
    id: 'inventory-row', roomId: 'room-1', jobId: 'inventory-1', kind: 'inventory', status: 'completed', sourceIds: ['handbook'],
    promptVersion: 'test', calls: [], stageOutputs: {}, result: { features: [], glossary: [], conflicts: [] }, operationId: 'inv',
    planPending: false, createdBy: 'admin-1', createdAt: '2026-10-29T07:00:00.000Z', updatedAt: '2026-10-29T07:01:00.000Z',
  } as unknown as AiJobRecord;
  const catalog = { sources: [{ sourceId: 'handbook', fileName: 'Sổ tay.pdf', sections: [1, 2].map((n) => ({ id: 'handbook#s' + String(n), headingPath: ['Mục ' + String(n)], usable: true })) }] };

  function stubStorage() {
    const storage = new Map<string, string>([['onboarding:ai:template:room-1', 'template-1']]);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  }

  function apiFor(job: AiJobRecord, review: AdminTemplateDetail, handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
    return {
      adminAi: vi.fn(async (action: string, args: Record<string, unknown> = {}) => {
        if (handlers[action]) return handlers[action](args);
        if (action === 'list_sources') return { sources: [source] };
        if (action === 'list_jobs') return { jobs: [inventory, job] };
        if (action === 'list_module_sources') return catalog;
        if (action === 'get_review') return { review };
        throw new Error('Unexpected action: ' + action);
      }),
      adminTemplates: vi.fn(async (action: string) => { throw new Error('Unexpected template action: ' + action); }),
    };
  }

  async function renderPage(api: unknown, onClose = vi.fn(), onComplete = vi.fn()) {
    stubStorage();
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(createElement(AiGeneratorPage, { api: api as never, canGenerateWithAi: true, onClose, onComplete }));
    });
    views.push(view);
    return view;
  }

  function activeStep(view: TestRenderer.ReactTestRenderer): string {
    const stepper = view.root.findByProps({ 'aria-label': 'Các bước' });
    return text(stepper.findAll((node) => node.type === 'li' && node.props['aria-current'] === 'step')[0]).replace(/^\d+/, '');
  }

  function footer(view: TestRenderer.ReactTestRenderer): ReactTestInstance {
    return view.root.findByType('footer');
  }

  function footerPrimary(view: TestRenderer.ReactTestRenderer): ReactTestInstance {
    const primaries = footer(view).findAll((node) => node.type === 'button' && String(node.props.className).includes('button-primary'));
    expect(primaries).toHaveLength(1);
    return primaries[0];
  }

  const actions = (api: { adminAi: { mock: { calls: unknown[][] } } }) => api.adminAi.mock.calls.map(([action]) => action as string);

  it('opens the new review with ← Về độ phủ and one primary, and no Xóa phiên', async () => {
    const view = await renderPage(apiFor(moduleJob([doneRun(0, 5), doneRun(1, 4)]), reviewFor()));
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
    expect(view.root.findAllByProps({ 'aria-label': 'Xem lại & xuất bản' })).toHaveLength(1);
    expect(text(footerPrimary(view))).toBe('Xuất bản template');
    expect(footerPrimary(view).props.disabled).toBe(false);
    expect(buttonsByText(footer(view), '← Về độ phủ')).toHaveLength(1);
    expect(buttonsByText(view.root, 'Xóa phiên')).toHaveLength(0);
    expect(buttonsByText(view.root, 'Chỉnh sửa module')).toHaveLength(0);
    expect(text(view.root)).not.toMatch(/Template 1\/|Kiểm tra xuất bản|Tiếp: Template 2/);
  });

  it('blocks publishing while a blocking flag is open, with Còn N cờ bắt buộc', async () => {
    const view = await renderPage(apiFor(moduleJob([doneRun(0, 5), doneRun(1, 4)]), reviewFor([blockingFlag('ai-mod-1')])));
    expect(footerPrimary(view).props.disabled).toBe(true);
    expect(text(footer(view))).toContain('Còn 1 cờ bắt buộc');
  });

  it('returns a completed job to Kiểm tra độ phủ without pausing it', async () => {
    const api = apiFor(moduleJob([doneRun(0, 5), doneRun(1, 4)]), reviewFor());
    const view = await renderPage(api);
    await act(async () => { button(footer(view), '← Về độ phủ').props.onClick(); });
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    expect(actions(api)).not.toContain('pause_autopilot');
  });

  it('saves a lesson through the job, stays on the step while updating, then reloads the new review', async () => {
    const job = moduleJob([doneRun(0, 5), doneRun(1, 4)]);
    const edited = { ...lessonFor(0), title: 'Tổng quan mới' };
    const updated = moduleJob([doneRun(0, 5, { lessonState: 'review_ready', lessonVersion: 3, lessonDraft: edited, questionState: 'stale', questionVersion: 5 }), doneRun(1, 4)], { status: 'running', result: null });
    const done = moduleJob([doneRun(0, 4, { lessonVersion: 3, approvedLessonVersion: 3, lessonDraft: edited, questionVersion: 5, approvedQuestionVersion: 5, questionLessonVersion: 3 }), doneRun(1, 4)], { result: { templateId: 'draft-1', version: 2 } });
    const step = { resolve: (_value: unknown) => undefined as void, promise: Promise.resolve() as Promise<unknown> };
    step.promise = new Promise((resolve) => { step.resolve = resolve; });
    const newReview = { ...reviewFor(), version: 2 };
    const api = apiFor(job, reviewFor(), {
      update_module_lesson: () => ({ job: updated }),
      next_step: () => step.promise,
      get_review: (args) => ({ review: args.version === 2 ? newReview : reviewFor() }),
    });
    const view = await renderPage(api);
    act(() => button(view.root, 'Chỉnh sửa').props.onClick());
    act(() => view.root.findByProps({ 'aria-label': 'Tiêu đề bài học' }).props.onChange({ target: { value: 'Tổng quan mới' } }));
    act(() => button(view.root, 'Lưu bài học').props.onClick());
    await act(async () => { button(view.root, 'Lưu và tạo lại câu hỏi').props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('update_module_lesson', expect.objectContaining({
      jobId: 'template-1', moduleLocalId: 'm0', expectedVersion: 2, module: expect.objectContaining({ title: 'Tổng quan mới' }),
    }));
    expect(actions(api)).toContain('next_step');
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
    expect(text(view.root)).toContain('Đang cập nhật…');
    expect(text(view.root)).toContain('Tổng quan mới');
    expect(footerPrimary(view).props.disabled).toBe(true);
    await act(async () => { step.resolve({ kind: 'done', job: done }); await Promise.resolve(); });
    expect(api.adminAi).toHaveBeenCalledWith('get_review', { templateId: 'draft-1', version: 2 });
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
    expect(text(view.root)).not.toContain('Đang cập nhật…');
    expect(footerPrimary(view).props.disabled).toBe(false);
  });

  it('rewrites a lesson with retry_module, and shows a stalled module with Thử lại', async () => {
    const job = moduleJob([doneRun(0, 5), doneRun(1, 4)]);
    const queued = moduleJob([doneRun(0, 5, { lessonState: 'queued', lessonVersion: 3, questionState: 'blocked', questionVersion: 5 }), doneRun(1, 4)], { status: 'running', result: null });
    const stuck = moduleJob([doneRun(0, 5, { lessonState: 'failed', lessonVersion: 3, questionState: 'blocked', questionVersion: 5 }), doneRun(1, 4)], { status: 'running', result: null });
    const api = apiFor(job, reviewFor(), {
      retry_module: () => ({ job: queued }),
      next_step: () => ({ kind: 'awaiting_admin', job: stuck }),
    });
    const view = await renderPage(api);
    await act(async () => { button(view.root, 'AI viết lại').props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('retry_module', { jobId: 'template-1', moduleLocalId: 'm0', target: 'lesson', expectedVersion: 2 });
    expect(activeStep(view)).toBe('Xem lại & xuất bản');
    expect(text(view.root)).toContain('AI chưa viết được bài học.');
    await act(async () => { button(view.root, 'Thử lại').props.onClick(); });
    expect(api.adminAi).toHaveBeenLastCalledWith('next_step', expect.anything());
    expect(api.adminAi).toHaveBeenCalledWith('retry_module', { jobId: 'template-1', moduleLocalId: 'm0', target: 'lesson', expectedVersion: 3 });
  });

  it('pauses a running job before returning to Kiểm tra độ phủ', async () => {
    const job = moduleJob([doneRun(0, 5), doneRun(1, 4)]);
    const queued = moduleJob([doneRun(0, 5, { lessonState: 'failed', lessonVersion: 3 }), doneRun(1, 4)], { status: 'running', result: null });
    const api = apiFor(job, reviewFor(), {
      retry_module: () => ({ job: queued }),
      next_step: () => ({ kind: 'awaiting_admin', job: queued }),
      pause_autopilot: () => ({ job: { ...queued, outlineApprovedRevision: 0 } }),
    });
    const view = await renderPage(api);
    await act(async () => { button(view.root, 'AI viết lại').props.onClick(); });
    await act(async () => { button(footer(view), '← Về độ phủ').props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('pause_autopilot', { jobId: 'template-1' });
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
  });

  it('publishes exactly one target', async () => {
    const job = moduleJob([doneRun(0, 5), doneRun(1, 4)]);
    const draft = { ...reviewFor(), modules: [], content: { ...reviewFor().content!, modules: [] } } as AdminTemplateDetail;
    vi.stubGlobal('FileReader', class {
      result = 'data:application/json;base64,e30=';
      onload: (() => void) | null = null;
      readAsDataURL() { this.onload?.(); }
    });
    host.app.uploadFile.mockResolvedValue({ fileId: 'json-file' });
    const api = apiFor(job, draft, {
      begin_publication: (args) => ({ batch: { batchId: 'batch-1', createdBy: 'admin-1', createdAt: 'now',
        targets: (args.targets as { kind: string; templateId: string; version: number }[]).map((target) => ({ ...target, jobId: 'template-1' })) } }),
      update_review: () => ({ review: draft }),
    });
    api.adminTemplates.mockImplementation(async () => ({ template: { ...draft, status: 'published' } }) as never);
    const onClose = vi.fn();
    const onComplete = vi.fn();
    const view = await renderPage(api, onClose, onComplete);
    await act(async () => { footerPrimary(view).props.onClick(); });
    const begins = api.adminAi.mock.calls.filter(([action]) => action === 'begin_publication');
    expect(begins).toHaveLength(1);
    const targets = (begins[0][1] as { targets: unknown[] }).targets;
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ kind: 'normal', templateId: 'draft-1', version: 1, settings: { passingScore: 70, maxAttemptsPerModule: 2, learningMode: 'sequential' } });
    expect(api.adminTemplates).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    host.app.uploadFile.mockReset();
  });
});
