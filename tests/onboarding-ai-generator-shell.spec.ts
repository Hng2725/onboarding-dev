import { createElement } from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AiJobRecord } from '../src/onboarding/contracts';

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

import { AI_GENERATOR_STEPS, AiGeneratorPage } from '../src/ui/onboarding/ai/ai-generator';

const source = {
  id: 'source-row', roomId: 'room-1', sourceId: 'source-1', kind: 'document' as const,
  fileName: 'guide.pdf', mimeType: 'application/pdf', checksum: 'checksum', systemName: 'Guide',
  status: 'ready' as const, textLength: 2680, createdBy: 'admin-1',
  createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
};

const completedInventory: AiJobRecord = {
  id: 'inventory-row', roomId: 'room-1', jobId: 'inventory-1', kind: 'inventory', status: 'completed',
  sourceIds: ['source-1'], promptVersion: 'test', calls: [], stageOutputs: {},
  result: { features: [], glossary: [], conflicts: [] }, operationId: 'inventory-operation', planPending: false,
  createdBy: 'admin-1', createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T08:01:00.000Z',
};

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

function buttonByText(view: TestRenderer.ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return view.root.findAllByType('button').find((button) => text(button).trim() === label);
}

function activeStep(view: TestRenderer.ReactTestRenderer): string {
  const stepper = view.root.findByProps({ 'aria-label': 'Các bước' });
  return text(stepper.findAll((node) => node.type === 'li' && node.props['aria-current'] === 'step')[0])
    .replace(/^\d+/, '');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function render(api: unknown, onClose = vi.fn()) {
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(createElement(AiGeneratorPage, {
      api: api as never, canGenerateWithAi: true, onClose, onComplete: () => undefined,
    }));
  });
  return { view, onClose };
}

function chooseKind(view: TestRenderer.ReactTestRenderer, label: 'Thông thường' | 'Nâng cao') {
  const radio = view.root.findAll((node) => node.type === 'button' && node.props.role === 'radio')
    .find((node) => text(node).includes(label))!;
  act(() => radio.props.onClick());
}

const views: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const view of views.splice(0)) act(() => view.unmount());
  vi.unstubAllGlobals();
});

describe('AI generator shell', () => {
  it('renders the title, a four-step stepper and exactly one footer primary', async () => {
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [] };
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view } = await render(api);
    views.push(view);

    expect(text(view.root.findByType('h2'))).toBe('Tạo template bằng AI');
    const steps = view.root.findByProps({ 'aria-label': 'Các bước' }).findAllByType('li');
    expect(steps.map((step) => text(step).replace(/^\d+/, ''))).toEqual([...AI_GENERATOR_STEPS]);
    expect(activeStep(view)).toBe('Nguồn & loại');
    const footer = view.root.findByType('footer');
    const primaries = footer.findAll((node) => node.type === 'button' && String(node.props.className).includes('button-primary'));
    expect(primaries).toHaveLength(1);
    expect(text(primaries[0]).trim()).toBe('Phân tích tài liệu');
    expect(buttonByText(view, 'Xóa phiên')).toBeDefined();
    expect(JSON.stringify(view.toJSON())).not.toContain('AI ONBOARDING');
  });

  it('keeps Phân tích tài liệu disabled until a kind is chosen', async () => {
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [] };
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view } = await render(api);
    views.push(view);

    expect(buttonByText(view, 'Phân tích tài liệu')!.props.disabled).toBe(true);
    chooseKind(view, 'Thông thường');
    expect(buttonByText(view, 'Phân tích tài liệu')!.props.disabled).toBe(false);
    chooseKind(view, 'Nâng cao');
    // Advanced needs 2–8 responsibilities before analysis can start.
    expect(buttonByText(view, 'Phân tích tài liệu')!.props.disabled).toBe(true);
    const systemName = view.root.findByProps({ name: 'systemName' });
    chooseKind(view, 'Thông thường');
    act(() => systemName.props.onChange({ target: { value: '' } }));
    expect(buttonByText(view, 'Phân tích tài liệu')!.props.disabled).toBe(true);
  });

  it('closes immediately from × when nothing is running', async () => {
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [] };
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view, onClose } = await render(api);
    views.push(view);

    act(() => view.root.findByProps({ 'aria-label': 'Đóng' }).props.onClick());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(view.toJSON())).not.toContain('Đóng cửa sổ?');
  });

  it('asks before closing while busy and closes only on Đóng và tạm dừng', async () => {
    const start = deferred<{ job: AiJobRecord }>();
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [] };
      if (action === 'start_job') return start.promise;
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view, onClose } = await render(api);
    views.push(view);
    chooseKind(view, 'Thông thường');
    await act(async () => { buttonByText(view, 'Phân tích tài liệu')!.props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('start_job', expect.objectContaining({ kind: 'inventory', sourceIds: ['source-1'] }));

    act(() => view.root.findByProps({ 'aria-label': 'Đóng' }).props.onClick());
    expect(onClose).not.toHaveBeenCalled();
    const dialog = view.root.findByProps({ 'aria-labelledby': 'confirm-title' });
    expect(text(dialog)).toContain('Đóng cửa sổ?');
    expect(text(dialog)).toContain('AI đang tạo nội dung. Nếu đóng, AI sẽ tạm dừng và tiếp tục khi bạn mở lại.');

    act(() => dialog.findAllByType('button').find((button) => text(button) === 'Tiếp tục ở lại')!.props.onClick());
    expect(view.root.findAllByProps({ 'aria-labelledby': 'confirm-title' })).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    act(() => view.root.findByProps({ 'aria-label': 'Đóng' }).props.onClick());
    act(() => view.root.findByProps({ 'aria-labelledby': 'confirm-title' }).findAllByType('button')
      .find((button) => text(button) === 'Đóng và tạm dừng')!.props.onClick());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('routes Esc and a backdrop click through the close confirmation', async () => {
    type KeyEvent = { key: string; defaultPrevented?: boolean; target?: unknown };
    const listeners = new Map<string, (event: KeyEvent) => void>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: KeyEvent) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    const planning: AiJobRecord = {
      ...completedInventory, id: 'template-row', jobId: 'template-1', kind: 'template', status: 'running',
      templateKind: 'normal', inventoryJobId: 'inventory-1', result: undefined, pipelineVersion: 'module_v2', planPending: true,
      calls: [{ callId: 'plan-1', stage: 'P', operationId: 'template-1:plan-1', status: 'pending' }] as never,
    };
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [completedInventory, planning] };
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view, onClose } = await render(api);
    views.push(view);
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    expect(JSON.stringify(view.toJSON())).toContain('AI đang lập lộ trình…');

    // Esc already handled, typed in a field, or inside a panel with its own Esc never reaches the modal.
    const inside = (match: string) => ({ closest: (selector: string) => selector.includes(match) ? {} : null });
    const ignored: KeyEvent[] = [
      { key: 'Escape', defaultPrevented: true },
      ...['input', 'textarea', 'select', '[contenteditable]', '[data-esc-scope]'].map((match) => ({ key: 'Escape', target: inside(match) })),
    ];
    for (const event of ignored) {
      act(() => listeners.get('keydown')!(event));
      expect(view.root.findAllByProps({ 'aria-labelledby': 'confirm-title' }), JSON.stringify(event)).toHaveLength(0);
    }

    act(() => listeners.get('keydown')!({ key: 'Escape', target: { closest: () => null } }));
    expect(onClose).not.toHaveBeenCalled();
    expect(view.root.findAllByProps({ 'aria-labelledby': 'confirm-title' })).toHaveLength(1);
    act(() => listeners.get('keydown')!({ key: 'Escape' }));
    expect(view.root.findAllByProps({ 'aria-labelledby': 'confirm-title' })).toHaveLength(0);

    const backdrop = view.root.find((node) => node.type === 'div' && String(node.props.className).includes('ai-generator-backdrop'));
    act(() => backdrop.props.onMouseDown({ target: 'inside', currentTarget: backdrop }));
    expect(view.root.findAllByProps({ 'aria-labelledby': 'confirm-title' })).toHaveLength(0);
    act(() => backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop }));
    expect(view.root.findAllByProps({ 'aria-labelledby': 'confirm-title' })).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reuses a completed inventory, starts the chosen template kind and moves to coverage', async () => {
    const module = { moduleLocalId: 'm0', frameKey: 't1-overview', order: 0, title: 'Tổng quan', description: '', estimatedMinutes: 10,
      objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] };
    const planned: AiJobRecord = {
      ...completedInventory, id: 'template-row', jobId: 'template-1', kind: 'template', status: 'running',
      templateKind: 'normal', inventoryJobId: 'inventory-1', result: undefined, pipelineVersion: 'module_v2', planPending: false,
      outline: { revision: 1, modules: [module], flags: [], taskCoverage: [] } as never, outlineApprovedRevision: 0,
      moduleRuns: [{ outline: module, outlineRevision: 1, lessonState: 'queued', lessonVersion: 0, questionState: 'blocked', questionVersion: 0 }] as never,
    };
    const api = { adminAi: vi.fn(async (action: string, args?: Record<string, unknown>) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [completedInventory] };
      if (action === 'start_job' && args?.kind === 'template') return { job: { ...planned, planPending: true, outline: undefined } };
      if (action === 'next_step') return { kind: 'awaiting_admin', job: planned };
      if (action === 'list_module_sources') return { sources: [] };
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view } = await render(api);
    views.push(view);
    expect(activeStep(view)).toBe('Nguồn & loại');
    chooseKind(view, 'Thông thường');
    await act(async () => { buttonByText(view, 'Phân tích tài liệu')!.props.onClick(); });

    expect(api.adminAi.mock.calls.some(([action, args]) => action === 'start_job' && (args as { kind?: string })?.kind === 'inventory')).toBe(false);
    expect(api.adminAi).toHaveBeenCalledWith('start_job', expect.objectContaining({
      kind: 'template', templateKind: 'normal', inventoryJobId: 'inventory-1',
    }));
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    expect(JSON.stringify(view.toJSON())).toContain('Tổng quan');
  });

  it('drops a run planned from another selection so step 2 tracks the new inventory', async () => {
    const second = { ...source, id: 'source-row-2', sourceId: 'source-2', fileName: 'policy.pdf' };
    const module = { moduleLocalId: 'm0', frameKey: 't1-overview', order: 0, title: 'Module kế hoạch cũ', description: '', estimatedMinutes: 10,
      objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] };
    const planned: AiJobRecord = {
      ...completedInventory, id: 'template-row', jobId: 'template-1', kind: 'template', status: 'running',
      templateKind: 'normal', inventoryJobId: 'inventory-1', result: undefined, pipelineVersion: 'module_v2', planPending: false,
      outline: { revision: 1, modules: [module], flags: [], taskCoverage: [] } as never, outlineApprovedRevision: 0,
      moduleRuns: [{ outline: module, outlineRevision: 1, lessonState: 'queued', lessonVersion: 0, questionState: 'blocked', questionVersion: 0 }] as never,
    };
    const newInventory: AiJobRecord = { ...completedInventory, jobId: 'inventory-2', status: 'running', result: undefined,
      sourceIds: ['source-1', 'source-2'], calls: [{ callId: 'A1', stage: 'A', operationId: 'inventory-2:A1', status: 'pending' }] as never };
    const api = { adminAi: vi.fn(async (action: string, args?: Record<string, unknown>) => {
      if (action === 'list_sources') return { sources: [source, second] };
      if (action === 'list_jobs') return { jobs: [completedInventory, planned] };
      if (action === 'list_module_sources') return { sources: [] };
      if (action === 'cancel_job') return { job: { ...(args?.jobId === 'template-1' ? planned : newInventory), status: 'cancelled' } };
      if (action === 'start_job' && args?.kind === 'inventory') return { job: newInventory };
      if (action === 'next_step') return new Promise(() => undefined);
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view } = await render(api);
    views.push(view);
    expect(JSON.stringify(view.toJSON())).toContain('Module kế hoạch cũ');

    act(() => buttonByText(view, '← Quay lại')!.props.onClick());
    const policy = view.root.findByProps({ 'aria-label': 'Danh sách tài liệu nguồn' }).findAllByType('input')[1];
    expect(policy.props.checked).toBe(false);
    act(() => policy.props.onChange());
    await act(async () => { buttonByText(view, 'Phân tích tài liệu')!.props.onClick(); });

    expect(api.adminAi).toHaveBeenCalledWith('cancel_job', { jobId: 'template-1' });
    expect(api.adminAi).toHaveBeenCalledWith('start_job', expect.objectContaining({ kind: 'inventory', sourceIds: ['source-1', 'source-2'] }));
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    const json = JSON.stringify(view.toJSON());
    expect(json).toContain('AI đang đọc tài liệu…');
    expect(json).not.toContain('Module kế hoạch cũ');

    await act(async () => { buttonByText(view, 'Hủy job')!.props.onClick(); });
    expect(api.adminAi).toHaveBeenLastCalledWith('cancel_job', { jobId: 'inventory-2' });
  });

  it('cancels the planned job when the kind changes and plans the new kind on the next analyse', async () => {
    const module = { moduleLocalId: 'm0', frameKey: 't1-overview', order: 0, title: 'Module thông thường', description: '', estimatedMinutes: 10,
      objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] };
    const planned: AiJobRecord = {
      ...completedInventory, id: 'template-row', jobId: 'template-1', kind: 'template', status: 'running',
      templateKind: 'normal', inventoryJobId: 'inventory-1', result: undefined, pipelineVersion: 'module_v2', planPending: false,
      outline: { revision: 1, modules: [module], flags: [], taskCoverage: [] } as never, outlineApprovedRevision: 0,
      moduleRuns: [{ outline: module, outlineRevision: 1, lessonState: 'queued', lessonVersion: 0, questionState: 'blocked', questionVersion: 0 }] as never,
    };
    const advanced: AiJobRecord = { ...planned, jobId: 'template-2', templateKind: 'advanced', planPending: true, outline: undefined, moduleRuns: [] };
    const api = { adminAi: vi.fn(async (action: string, args?: Record<string, unknown>) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [completedInventory, planned] };
      if (action === 'list_module_sources') return { sources: [] };
      if (action === 'cancel_job') return { job: { ...planned, status: 'cancelled' } };
      if (action === 'start_job' && args?.kind === 'template') return { job: advanced };
      if (action === 'next_step') return new Promise(() => undefined);
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view } = await render(api);
    views.push(view);
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');

    act(() => buttonByText(view, '← Quay lại')!.props.onClick());
    chooseKind(view, 'Nâng cao');
    act(() => view.root.findByType('textarea').props.onChange({ target: { value: 'Duyệt đơn\nLập báo cáo' } }));
    await act(async () => { buttonByText(view, 'Phân tích tài liệu')!.props.onClick(); });

    expect(api.adminAi).toHaveBeenCalledWith('cancel_job', { jobId: 'template-1' });
    expect(api.adminAi).toHaveBeenCalledWith('start_job', expect.objectContaining({ kind: 'template', templateKind: 'advanced', inventoryJobId: 'inventory-1' }));
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    expect(JSON.stringify(view.toJSON())).not.toContain('Module thông thường');
  });

  it('labels a save without analysing and closes without asking', async () => {
    const deletion = deferred<unknown>();
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [] };
      if (action === 'delete_source') return deletion.promise;
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view, onClose } = await render(api);
    views.push(view);
    chooseKind(view, 'Thông thường');

    await act(async () => { view.root.findByProps({ 'aria-label': 'Xóa guide.pdf' }).props.onClick(); });
    const primary = view.root.findByType('footer').findByProps({ className: 'button button-primary' });
    expect(text(primary)).toBe('Phân tích tài liệu');
    expect(primary.props.disabled).toBe(true);
    act(() => view.root.findByProps({ 'aria-label': 'Đóng' }).props.onClick());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks before closing while a source uploads, without an analysing label', async () => {
    vi.stubGlobal('FileReader', class {
      result = 'data:application/pdf;base64,YQ==';
      onload: (() => void) | null = null;
      readAsDataURL() { this.onload?.(); }
    });
    host.app.rest.mockImplementation(() => new Promise(() => undefined));
    const api = { adminAi: vi.fn(async (action: string) => {
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [] };
      throw new Error('Unexpected action: ' + action);
    }) };
    const { view, onClose } = await render(api);
    views.push(view);
    const upload = view.root.find((node) => node.type === 'input' && node.props.type === 'file');
    await act(async () => { upload.props.onChange({ target: { files: [{ name: 'new.pdf', size: 10, type: 'application/pdf' }], value: '' } }); });

    expect(text(view.root.findByType('footer').findByProps({ className: 'button button-primary' }))).toBe('Phân tích tài liệu');
    act(() => view.root.findByProps({ 'aria-label': 'Đóng' }).props.onClick());
    expect(onClose).not.toHaveBeenCalled();
    expect(text(view.root.findByProps({ 'aria-labelledby': 'confirm-title' }))).toContain('Đóng cửa sổ?');
    host.app.rest.mockReset();
  });
});
