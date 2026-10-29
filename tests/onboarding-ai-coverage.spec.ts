import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AiJobRecord, OutlineEdit, TemplateOutlineModule } from '../src/onboarding/contracts';

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
  ensureOnboardingRoomfiles: vi.fn(async () => ({ rootId: 'root', documentsId: 'documents', templatesId: 'templates' })),
}));

import { aiCallDisplayLabel, AiGeneratorPage } from '../src/ui/onboarding/ai/ai-generator';
import { AiStepCoverage, type ModuleSourceCatalog } from '../src/ui/onboarding/ai/ai-step-coverage';
import { vietnameseErrorMessage } from '../src/ui/onboarding/ai/ai-labels';

const css = readFileSync(fileURLToPath(new URL('../src/ui/onboarding/ai/ai-generator.css', import.meta.url)), 'utf8');

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

function allText(view: TestRenderer.ReactTestRenderer): string {
  return text(view.root);
}

function buttonsByText(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAllByType('button').filter((button) => text(button).trim() === label);
}

function buttonByText(root: ReactTestInstance, label: string): ReactTestInstance {
  const [button] = buttonsByText(root, label);
  if (!button) throw new Error('No button ' + label);
  return button;
}

function rows(view: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return view.root.findByProps({ 'aria-label': 'Lộ trình module' }).findAllByType('li');
}

function activeStep(view: TestRenderer.ReactTestRenderer): string {
  const stepper = view.root.findByProps({ 'aria-label': 'Các bước' });
  return text(stepper.findAll((node) => node.type === 'li' && node.props['aria-current'] === 'step')[0]).replace(/^\d+/, '');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const FRAMES = ['t1-overview', 't1-access', 't1-navigation', 't1-core', 't1-support'];
const TITLES = ['Tổng quan chương trình hội nhập', 'Ngày làm việc đầu tiên', 'Kênh giao tiếp nội bộ', 'Phân loại dữ liệu', 'Đánh giá kết thúc thử việc'];

function moduleAt(index: number, patch: Partial<TemplateOutlineModule> = {}): TemplateOutlineModule {
  return {
    moduleLocalId: 'm' + String(index), frameKey: FRAMES[index], order: index, title: TITLES[index], description: '',
    estimatedMinutes: index === 3 ? 15 : 10, objectives: [], featureIds: [],
    sourceSectionIds: ['handbook#s' + String(index + 1)], responsibilityIndexes: [], coverage: 'sufficient', ...patch,
  };
}

const insufficient = moduleAt(4, { sourceSectionIds: [], coverage: 'insufficient', gapNote: 'AI cần thêm tài liệu về tiêu chí đánh giá thử việc.' });

function templateJob(modules: readonly TemplateOutlineModule[], patch: Partial<AiJobRecord> = {}): AiJobRecord {
  return {
    id: 'template-row', roomId: 'room-1', jobId: 'template-1', kind: 'template', status: 'running', templateKind: 'normal',
    inventoryJobId: 'inventory-1', sourceIds: ['handbook'], promptVersion: 'test', stageOutputs: {}, operationId: 'template-op',
    pipelineVersion: 'module_v2', planPending: false, autoApprove: true,
    outline: { revision: 3, modules, flags: [], taskCoverage: [] }, outlineApprovedRevision: 0,
    moduleRuns: modules.map((outline) => ({ outline, outlineRevision: 3, lessonState: 'queued', lessonVersion: 0, questionState: 'blocked', questionVersion: 0 })),
    calls: [{ callId: 'plan-1', stage: 'P', operationId: 'template-1:plan-1', status: 'completed', planTarget: 'plan' }],
    createdBy: 'admin-1', createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T08:01:00.000Z',
    ...patch,
  } as AiJobRecord;
}

const catalog: ModuleSourceCatalog = [{
  sourceId: 'handbook',
  fileName: 'Sổ tay hội nhập.pdf',
  sections: [1, 2, 3, 4].map((n) => ({ id: 'handbook#s' + String(n), headingPath: ['Sổ tay', 'Mục ' + String(n)], usable: true }))
    .concat([{ id: 'handbook#s9', headingPath: ['Phụ lục'], usable: false }]),
}];
const usableFrom = (sources: ModuleSourceCatalog) => new Set(sources.flatMap((source) => source.sections.filter((section) => section.usable).map((section) => section.id)));

function renderCoverage(job: AiJobRecord, overrides: Partial<Parameters<typeof AiStepCoverage>[0]> = {}) {
  const props = {
    job,
    usableSectionIds: usableFrom(catalog),
    sourceCatalog: catalog,
    sourceNames: new Map([['handbook', 'Sổ tay hội nhập.pdf']]),
    busy: false,
    onEdit: vi.fn<(edits: readonly OutlineEdit[]) => void>(),
    onUploadFor: vi.fn<(moduleLocalId: string, file: File) => void>(),
    onPickSections: vi.fn<(moduleLocalId: string, sourceIds: string[], sectionIds: string[]) => void>(),
    onOverride: vi.fn<(moduleLocalId: string) => void>(),
    onAddModule: vi.fn<(title: string, description: string) => void>(),
    ...overrides,
  };
  let view!: TestRenderer.ReactTestRenderer;
  act(() => { view = TestRenderer.create(createElement(AiStepCoverage, props)); });
  views.push(view);
  return { view, props };
}

const views: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const view of views.splice(0)) act(() => view.unmount());
  vi.unstubAllGlobals();
  host.app.uploadFile.mockReset();
});

describe('AiStepCoverage', () => {
  const fiveModules = [0, 1, 2, 3].map((index) => moduleAt(index)).concat(insufficient);

  it('spreads the four summary numbers over an equal four-column grid', () => {
    const { view } = renderCoverage(templateJob(fiveModules));
    const summary = view.root.find((node) => node.type === 'div' && String(node.props.className).split(' ').includes('ai-coverage-summary'));
    const cells = summary.children as ReactTestInstance[];
    expect(cells).toHaveLength(4);
    expect(cells.map((cell) => text(cell))).toEqual(['5module đề xuất', '4đủ tài liệu', '1cần bổ sung', '~55phút học']);
    expect(String(cells[1].props.className)).toContain('ok');
    expect(String(cells[2].props.className)).toContain('warn');
    expect(css.replace(/\s+/g, ' ')).toContain('.ai-coverage-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr))');
  });

  it('lists modules with order, title, a readable source line and a coverage chip', () => {
    const overridden = moduleAt(3, { coverage: 'insufficient', coverageOverride: true });
    const { view } = renderCoverage(templateJob([moduleAt(0), moduleAt(1), moduleAt(2), overridden, insufficient]));
    const list = rows(view);
    expect(list).toHaveLength(5);
    expect(text(list[0])).toContain('1');
    expect(text(list[0])).toContain('Tổng quan chương trình hội nhập');
    expect(text(list[0])).toContain('Sổ tay hội nhập · Mục 1');
    expect(text(list[0])).not.toContain('.pdf');
    expect(text(list[0])).toContain('Đủ tài liệu');
    expect(text(list[3])).toContain('Đủ tài liệu (Admin xác nhận)');
    expect(text(list[4])).toContain('Cần bổ sung');
    expect(text(list[4])).toContain('AI cần thêm tài liệu về tiêu chí đánh giá thử việc.');
    for (const row of list) {
      expect(buttonsByText(row, 'Sửa')).toHaveLength(1);
      expect(buttonsByText(row, 'Bỏ module')).toHaveLength(1);
    }
    expect(buttonByText(view.root, '+ Thêm module')).toBeDefined();
  });

  it('offers all three actions to an insufficient module with usable sections', () => {
    const partial = moduleAt(4, { sourceSectionIds: ['handbook#s4'], coverage: 'insufficient', gapNote: 'Chưa đủ chi tiết.' });
    const { view, props } = renderCoverage(templateJob([0, 1, 2, 3].map((index) => moduleAt(index)).concat(partial)));
    const row = rows(view)[4];
    expect(text(row)).toContain('Tải tài liệu bổ sung');
    expect(row.findAll((node) => node.type === 'input' && node.props.type === 'file')).toHaveLength(1);
    expect(buttonsByText(row, 'Chọn đoạn từ tài liệu đã có')).toHaveLength(1);
    act(() => buttonByText(row, 'Vẫn dùng tài liệu hiện có').props.onClick());
    expect(props.onOverride).toHaveBeenCalledWith('m4');

    const file = { name: 'Thử việc.pdf' } as File;
    act(() => row.find((node) => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [file], value: 'x' } }));
    expect(props.onUploadFor).toHaveBeenCalledWith('m4', file);
  });

  it('hides Vẫn dùng tài liệu hiện có when the module has no usable section', () => {
    const { view } = renderCoverage(templateJob([0, 1, 2, 3].map((index) => moduleAt(index)).concat(insufficient)));
    const row = rows(view)[4];
    expect(buttonsByText(row, 'Chọn đoạn từ tài liệu đã có')).toHaveLength(1);
    expect(text(row)).toContain('Tải tài liệu bổ sung');
    expect(buttonsByText(row, 'Vẫn dùng tài liệu hiện có')).toHaveLength(0);
  });

  it('picks only usable sections from existing documents', () => {
    const { view, props } = renderCoverage(templateJob([0, 1, 2, 3].map((index) => moduleAt(index)).concat(insufficient)));
    act(() => buttonByText(rows(view)[4], 'Chọn đoạn từ tài liệu đã có').props.onClick());
    const picker = view.root.findByProps({ 'aria-label': 'Chọn tài liệu bổ sung' });
    expect(text(picker)).not.toContain('Phụ lục');
    const boxes = picker.findAll((node) => node.type === 'input' && node.props.type === 'checkbox');
    expect(boxes).toHaveLength(4);
    act(() => boxes[1].props.onChange({ target: { checked: true } }));
    act(() => buttonByText(picker, 'Thêm đoạn đã chọn').props.onClick());
    expect(props.onPickSections).toHaveBeenCalledWith('m4', ['handbook'], ['handbook#s2']);
  });

  it('disables Bỏ module at the minimum count with a tooltip, and deletes above it', () => {
    const four = [0, 1, 2, 3].map((index) => moduleAt(index));
    const { view } = renderCoverage(templateJob(four));
    const remove = buttonByText(rows(view)[1], 'Bỏ module');
    expect(remove.props.disabled).toBe(true);
    expect(remove.parent!.props.title).toBe('Lộ trình cần tối thiểu 4 module');

    const { view: five, props } = renderCoverage(templateJob([...four, insufficient]));
    act(() => buttonByText(rows(five)[4], 'Bỏ module').props.onClick());
    expect(props.onEdit).toHaveBeenCalledWith([{ type: 'delete', moduleLocalId: 'm4' }]);
  });

  it('edits a module inline without touching coverage', () => {
    const { view, props } = renderCoverage(templateJob([0, 1, 2, 3].map((index) => moduleAt(index)).concat(insufficient)));
    act(() => buttonByText(rows(view)[1], 'Sửa').props.onClick());
    const panel = view.root.findByProps({ 'aria-label': 'Sửa module Ngày làm việc đầu tiên' });
    act(() => panel.findByProps({ 'aria-label': 'Tên module' }).props.onChange({ target: { value: 'Ngày đầu tiên' } }));
    act(() => panel.findByProps({ 'aria-label': 'Thời lượng (phút)' }).props.onChange({ target: { value: '20' } }));
    act(() => panel.findByProps({ 'aria-label': 'Mục tiêu học tập' }).props.onChange({ target: { value: 'Nhận thiết bị\n\nĐăng nhập' } }));
    act(() => buttonByText(panel, 'Lưu').props.onClick());
    expect(props.onEdit).toHaveBeenCalledWith([{ type: 'update', moduleLocalId: 'm1', patch: {
      title: 'Ngày đầu tiên', description: '', estimatedMinutes: 20, objectives: ['Nhận thiết bị', 'Đăng nhập'],
    } }]);
    const patch = (props.onEdit.mock.calls[0][0][0] as { patch: Record<string, unknown> }).patch;
    expect(Object.keys(patch)).not.toContain('coverage');
    expect(Object.keys(patch)).not.toContain('coverageOverride');
  });

  it('moves a responsibility between modules for an advanced template', () => {
    const frames = ['t2-role', 't2-permissions', 't2-task-1', 't2-task-2', 't2-control'];
    const modules = frames.map((frameKey, index) => moduleAt(index % 4, {
      moduleLocalId: 'a' + String(index), frameKey, order: index, title: 'Module ' + String(index + 1), responsibilityIndexes: index === 2 ? [0] : index === 3 ? [1] : [],
    }));
    const job = templateJob(modules, { templateKind: 'advanced', roleProfile: { responsibilities: ['Duyệt đơn', 'Lập báo cáo'] } as never });
    const { view, props } = renderCoverage(job);
    act(() => buttonByText(rows(view)[4], 'Sửa').props.onClick());
    const panel = view.root.findByProps({ 'aria-label': 'Sửa module Module 5' });
    const reports = panel.findAll((node) => node.type === 'input' && node.props.type === 'checkbox')[1];
    act(() => reports.props.onChange({ target: { checked: true } }));
    act(() => buttonByText(panel, 'Lưu').props.onClick());
    expect(props.onEdit).toHaveBeenCalledWith([
      { type: 'update', moduleLocalId: 'a4', patch: expect.objectContaining({ responsibilityIndexes: [1] }) },
      { type: 'update', moduleLocalId: 'a3', patch: { responsibilityIndexes: [] } },
    ]);
  });

  it('adds a module from a title and description', () => {
    const { view, props } = renderCoverage(templateJob([0, 1, 2, 3].map((index) => moduleAt(index))));
    act(() => buttonByText(view.root, '+ Thêm module').props.onClick());
    const form = view.root.findByProps({ 'aria-label': 'Thêm module' });
    act(() => form.findByProps({ 'aria-label': 'Tên module mới' }).props.onChange({ target: { value: 'Mẹo sử dụng' } }));
    act(() => form.findByProps({ 'aria-label': 'Mô tả module mới' }).props.onChange({ target: { value: 'Các mẹo nhanh.' } }));
    act(() => buttonByText(form, 'Thêm vào lộ trình').props.onClick());
    expect(props.onAddModule).toHaveBeenCalledWith('Mẹo sử dụng', 'Các mẹo nhanh.');
  });

  it('shows a skeleton while AI plans the outline', () => {
    const job = templateJob([], { planPending: true, outline: undefined,
      calls: [{ callId: 'plan-1', stage: 'P', operationId: 'x', status: 'dispatched', planTarget: 'plan' }] as never });
    const { view } = renderCoverage(job);
    expect(allText(view)).toContain('AI đang lập lộ trình…');
    expect(view.root.findAll((node) => String(node.props.className ?? '').includes('ai-coverage-skeleton')).length).toBeGreaterThan(0);
    expect(view.root.findAllByProps({ 'aria-label': 'Lộ trình module' })).toHaveLength(0);
  });

  it('marks the module AI is reading a supplement for and locks edits', () => {
    const job = templateJob([0, 1, 2, 3].map((index) => moduleAt(index)).concat(insufficient), { planPending: true,
      calls: [{ callId: 'supplement-1-b1', stage: 'S', operationId: 'x', status: 'pending', planTarget: 'supplement', supplementModuleLocalId: 'm4' }] as never });
    const { view } = renderCoverage(job);
    const row = rows(view)[4];
    expect(text(row)).toContain('AI đang đọc tài liệu bổ sung…');
    expect(text(rows(view)[0])).not.toContain('AI đang đọc tài liệu bổ sung…');
    expect(buttonByText(rows(view)[0], 'Sửa').props.disabled).toBe(true);
    expect(allText(view)).not.toContain('AI đang lập lộ trình…');
  });

  it('never shows frame keys or English pipeline words', () => {
    const raw = [0, 1, 2, 3].map((index) => moduleAt(index, { title: FRAMES[index] })).concat(insufficient);
    const { view } = renderCoverage(templateJob(raw));
    act(() => buttonByText(rows(view)[4], 'Chọn đoạn từ tài liệu đã có').props.onClick());
    const rendered = allText(view);
    expect(rendered).not.toMatch(/\bt[12]-[a-z]/);
    expect(rendered).not.toMatch(/\b(concept|steps|summary|Missing|Outline)\b/);
    expect(rendered).toContain('Tổng quan');
  });
});

describe('Kiểm tra độ phủ in the generator', () => {
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
  const covered = [0, 1, 2, 3].map((index) => moduleAt(index));

  function apiFor(job: AiJobRecord, handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
    return { adminAi: vi.fn(async (action: string, args: Record<string, unknown> = {}) => {
      if (handlers[action]) return handlers[action](args);
      if (action === 'list_sources') return { sources: [source] };
      if (action === 'list_jobs') return { jobs: [inventory, job] };
      if (action === 'list_module_sources') return { sources: catalog };
      throw new Error('Unexpected action: ' + action);
    }) };
  }

  async function renderPage(api: unknown) {
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

  it('disables Tạo template with the readiness reason and shows only ← Quay lại on the left', async () => {
    const view = await renderPage(apiFor(templateJob([...covered, insufficient])));
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    const primary = footerPrimary(view);
    expect(text(primary)).toBe('Tạo template');
    expect(primary.props.disabled).toBe(true);
    expect(text(view.root.findByType('footer'))).toContain('Còn 1 module cần bổ sung hoặc bỏ');
    expect(buttonsByText(view.root, '← Quay lại')).toHaveLength(1);
    expect(buttonsByText(view.root, 'Xóa phiên')).toHaveLength(0);
    expect(buttonsByText(view.root, 'Duyệt lộ trình và tiếp tục')).toHaveLength(0);
  });

  it('moves to AI tạo nội dung only after the server confirms approval, then pumps', async () => {
    const job = templateJob(covered);
    const approval = deferred<{ job: AiJobRecord }>();
    const approved = { ...job, outlineApprovedRevision: 3 };
    const api = apiFor(job, {
      approve_outline: () => approval.promise,
      next_step: () => ({ kind: 'awaiting_admin', job: approved }),
    });
    const view = await renderPage(api);
    expect(footerPrimary(view).props.disabled).toBe(false);
    act(() => { footerPrimary(view).props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('approve_outline', { jobId: 'template-1', expectedRevision: 3 });
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    expect(text(footerPrimary(view))).toBe('Đang bắt đầu…');
    expect(footerPrimary(view).props.disabled).toBe(true);
    expect(rows(view)).toHaveLength(4);
    await act(async () => { approval.resolve({ job: approved }); await Promise.resolve(); await Promise.resolve(); });
    expect(activeStep(view)).toBe('AI tạo nội dung');
    expect(api.adminAi).toHaveBeenCalledWith('next_step', expect.objectContaining({ jobId: 'template-1' }));
  });

  it('stays on coverage with the server message when approval is rejected', async () => {
    const job = templateJob(covered);
    const api = apiFor(job, {
      approve_outline: () => { throw Object.assign(new Error('Còn module chưa đủ tài liệu cho tiêu chí thử việc.'), { code: 'COVERAGE_INCOMPLETE' }); },
    });
    const view = await renderPage(api);
    await act(async () => { footerPrimary(view).props.onClick(); });
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    expect(allText(view)).toContain('Còn module chưa đủ tài liệu cho tiêu chí thử việc.');
    expect(text(footerPrimary(view))).toBe('Tạo template');
    expect(api.adminAi.mock.calls.some(([action]) => action === 'next_step')).toBe(false);
  });

  it('uploads a supplement file, ingests it, queues the S call and pumps it', async () => {
    vi.stubGlobal('FileReader', class {
      result = 'data:application/pdf;base64,YQ==';
      onload: (() => void) | null = null;
      readAsDataURL() { this.onload?.(); }
    });
    host.app.uploadFile.mockResolvedValue({ fileId: 'file-9', fileName: 'Thử việc.pdf' });
    const job = templateJob([...covered, insufficient]);
    const queued = { ...job, planPending: true, sourceIds: ['handbook', 'source-9'],
      calls: [...job.calls, { callId: 'supplement-1-b1', stage: 'S', operationId: 'x', status: 'pending', planTarget: 'supplement', supplementModuleLocalId: 'm4' }] } as AiJobRecord;
    const read = { ...queued, planPending: false, calls: queued.calls.map((call) => ({ ...call, status: 'completed' })) } as AiJobRecord;
    const api = apiFor(job, {
      ingest_source: () => ({ source: { ...source, sourceId: 'source-9', fileName: 'Thử việc.pdf' } }),
      supplement_module_document: () => ({ job: queued }),
      next_step: () => ({ kind: 'awaiting_admin', job: read }),
    });
    const view = await renderPage(api);
    const input = rows(view)[4].find((node) => node.type === 'input' && node.props.type === 'file');
    await act(async () => {
      input.props.onChange({ target: { files: [{ name: 'Thử việc.pdf', size: 10, type: 'application/pdf' }], value: 'x' } });
    });
    expect(host.app.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'Thử việc.pdf', folderId: 'documents' }));
    expect(api.adminAi).toHaveBeenCalledWith('ingest_source', expect.objectContaining({ fileName: 'Thử việc.pdf', fileId: 'file-9' }));
    expect(api.adminAi).toHaveBeenCalledWith('supplement_module_document', { jobId: 'template-1', expectedRevision: 3, moduleLocalId: 'm4', sourceId: 'source-9' });
    expect(api.adminAi).toHaveBeenCalledWith('next_step', expect.objectContaining({ jobId: 'template-1' }));
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
  });

  it('confirms coverage only through set_coverage_override', async () => {
    const partial = moduleAt(4, { sourceSectionIds: ['handbook#s4'], coverage: 'insufficient', gapNote: 'Chưa đủ chi tiết.' });
    const job = templateJob([...covered, partial]);
    const api = apiFor(job, { set_coverage_override: () => ({ job }) });
    const view = await renderPage(api);
    await act(async () => { buttonByText(rows(view)[4], 'Vẫn dùng tài liệu hiện có').props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('set_coverage_override', { jobId: 'template-1', expectedRevision: 3, moduleLocalId: 'm4', override: true });
    expect(api.adminAi.mock.calls.some(([action]) => action === 'update_outline')).toBe(false);
  });

  it('adds a module and pumps the AI call that picks its sections', async () => {
    const job = templateJob(covered);
    const added = { ...job, planPending: true, calls: [...job.calls, { callId: 'supplement-1-b1', stage: 'S', operationId: 'x', status: 'pending', planTarget: 'supplement', supplementModuleLocalId: 'm4' }] } as AiJobRecord;
    const api = apiFor(job, {
      add_outline_module: () => ({ job: added }),
      next_step: () => ({ kind: 'awaiting_admin', job: { ...added, planPending: false } }),
    });
    const view = await renderPage(api);
    act(() => buttonByText(view.root, '+ Thêm module').props.onClick());
    const form = view.root.findByProps({ 'aria-label': 'Thêm module' });
    act(() => form.findByProps({ 'aria-label': 'Tên module mới' }).props.onChange({ target: { value: 'Mẹo sử dụng' } }));
    await act(async () => { buttonByText(form, 'Thêm vào lộ trình').props.onClick(); });
    expect(api.adminAi).toHaveBeenCalledWith('add_outline_module', { jobId: 'template-1', expectedRevision: 3, title: 'Mẹo sử dụng', description: '' });
    expect(api.adminAi).toHaveBeenCalledWith('next_step', expect.objectContaining({ jobId: 'template-1' }));
  });

  it('restores a paused autopilot job (approval reset to 0) on Kiểm tra độ phủ', async () => {
    const paused = templateJob(covered, { outlineApprovedRevision: 0,
      moduleRuns: covered.map((outline, index) => ({ outline, outlineRevision: 3, lessonState: index === 0 ? 'approved' : 'queued', lessonVersion: index === 0 ? 1 : 0, questionState: 'blocked', questionVersion: 0 })) as never });
    const view = await renderPage(apiFor(paused));
    expect(activeStep(view)).toBe('Kiểm tra độ phủ');
    expect(rows(view)).toHaveLength(4);
  });
});

describe('labels for coverage work', () => {
  it('names planner calls in Vietnamese', () => {
    const calls = [{ callId: 'plan-1' }, { callId: 'supplement-1-b1' }];
    expect(aiCallDisplayLabel({ callId: 'plan-1' }, calls)).toBe('Lập lộ trình');
    expect(aiCallDisplayLabel({ callId: 'plan-1-r1' }, calls)).toMatch(/^Lập lộ trình \(tự sửa lần 1\//);
    expect(aiCallDisplayLabel({ callId: 'supplement-1-b1' }, calls)).toBe('Đọc tài liệu bổ sung');
    expect(aiCallDisplayLabel({ callId: 'supplement-2-b3-retry1' }, calls)).toBe('Đọc tài liệu bổ sung (thử lại lần 1)');
  });

  it('prefers the specific Vietnamese server message for conflicts and incomplete coverage', () => {
    const duplicate = 'Tài liệu này đã có trong lộ trình. Hãy dùng "Chọn đoạn từ tài liệu đã có".';
    expect(vietnameseErrorMessage(Object.assign(new Error(duplicate), { code: 'OPERATION_CONFLICT' }))).toBe(duplicate);
    expect(vietnameseErrorMessage(Object.assign(new Error('Module chưa có đoạn tài liệu dùng được.'), { code: 'COVERAGE_INCOMPLETE' })))
      .toBe('Module chưa có đoạn tài liệu dùng được.');
    expect(vietnameseErrorMessage(Object.assign(new Error('Outline revision conflict.'), { code: 'OPERATION_CONFLICT' }))).toBe('Dữ liệu vừa thay đổi. Hãy thử lại.');
    expect(vietnameseErrorMessage(Object.assign(new Error('x'), { code: 'COVERAGE_INCOMPLETE' }))).toBe('Còn module chưa đủ tài liệu.');
  });
});
