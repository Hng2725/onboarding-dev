import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AiModuleWorkspace } from '../src/ui/onboarding/ai/ai-module-workspace';
import { approvedModuleJob } from './helpers/approved-module-fixture';

it('keeps a new question open while its prompt is typed', () => {
  const original = approvedModuleJob().moduleRuns![0];
  const run = { ...original, questionDraft: [{ ...original.questionDraft![0], prompt: '' }] };
  let view!: TestRenderer.ReactTestRenderer;
  act(() => { view = TestRenderer.create(createElement(AiModuleWorkspace, { runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false, onSelect: () => {}, onAction: () => {}, onSources: () => {} })); });
  const card = () => view.root.findAllByType('details').filter((node) => node.props.className === 'ai-content-card').at(-1)!;
  expect(card().props.open).toBe(true);
  act(() => card().findAllByType('textarea').find((node) => node.props.value === '')!.props.onChange({ target: { value: 'Which source?' } }));
  expect(card().props.open).toBe(true);
});

it('collapses long lesson/question cards and citations while keeping versioned actions outside scroll regions', () => {
  const original = approvedModuleJob().moduleRuns![0];
  const lesson = original.lessonDraft!;
  const run = { ...original, lessonState: 'review_ready' as const, lessonDraft: { ...lesson, blocks: Array.from({ length: 20 }, (_, index) => ({ ...lesson.blocks[0], localId: `block-${index}`, title: `Section ${index + 1}` })) } };
  const onAction = vi.fn();
  const view = TestRenderer.create(createElement(AiModuleWorkspace, { runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false, onSelect: () => {}, onAction, onSources: () => {} }));
  const disclosures = view.root.findAllByType('details');
  expect(disclosures.filter((node) => node.props.className === 'ai-content-card')).toHaveLength(23);
  expect(disclosures.every((node) => !node.props.open)).toBe(true);
  expect(disclosures.filter((node) => node.props.className === 'ai-source-details')).toHaveLength(23);
  const summaries = view.root.findAllByType('summary');
  expect(summaries.flatMap((node) => node.findAllByType('strong')).map((node) => node.children.join(''))).toContain('20. Section 20');
  const regions = view.root.findAll((node) => node.props.role === 'region' && node.props.className === 'ai-review-scroll');
  expect(regions.map((node) => node.props['aria-label'])).toEqual(['Nội dung bài học', 'Nội dung câu hỏi']);
  expect(regions.every((node) => node.props.tabIndex === 0)).toBe(true);
  expect(regions.flatMap((node) => node.findAllByType('button')).some((button) => button.children.join('') === 'Duyệt bài học')).toBe(false);
  act(() => view.root.findAllByType('button').find((button) => button.children.join('') === 'Duyệt bài học')!.props.onClick());
  expect(onAction).toHaveBeenCalledWith('approve_module_lesson', { moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion });
});

it('shows manual source requirement and blocks approval without content', () => {
  const run = { outline: { moduleLocalId: 'm', frameKey: 't1-core', order: 0, title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [] }, outlineRevision: 1, lessonState: 'manual_required' as const, lessonVersion: 0, questionState: 'blocked' as const, questionVersion: 0 };
  const html = renderToStaticMarkup(createElement(AiModuleWorkspace, { runs: [run], calls: [], selectedId: 'm', busy: false, onSelect: () => {}, onAction: () => {}, onSources: () => {} }));
  expect(html).toContain('Cần bổ sung nguồn hoặc tự soạn');
  expect(html).toMatch(/disabled=""[^>]*>Duyệt bài học/);
});

it('presents structured lesson fields instead of requiring JSON', () => {
  const run = { outline: { moduleLocalId: 'm', frameKey: 't1-core', order: 0, title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [] }, outlineRevision: 1, lessonState: 'manual_required' as const, lessonVersion: 0, questionState: 'blocked' as const, questionVersion: 0 };
  const html = renderToStaticMarkup(createElement(AiModuleWorkspace, { runs: [run], calls: [], selectedId: 'm', busy: false, onSelect: () => {}, onAction: () => {}, onSources: () => {} }));
  expect(html).toContain('Tiêu đề bài học');
  expect(html).toContain('Thêm nội dung');
  expect(html).not.toContain('Bài học (JSON)');
});
import TestRenderer, { act } from 'react-test-renderer';
import { vi } from 'vitest';

it('sends the selected module version for lesson approval and exposes stale history', () => {
  const outline = { moduleLocalId: 'm', frameKey: 't1-core', order: 0, title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] };
  const lesson = { localId: 'm', frameKey: 't1-core', title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], blocks: [], questions: [] };
  const run = { outline, outlineRevision: 1, lessonState: 'review_ready' as const, lessonVersion: 4, lessonDraft: lesson, questionState: 'stale' as const, questionVersion: 2 };
  const onAction = vi.fn();
  const view = TestRenderer.create(createElement(AiModuleWorkspace, { runs: [run], calls: [], history: [{ moduleLocalId: 'm', target: 'questions', version: 1 }], selectedId: 'm', busy: false, onSelect: () => {}, onAction, onSources: () => {} }));
  expect(JSON.stringify(view.toJSON())).toContain('Câu hỏi đã cũ');
  expect(JSON.stringify(view.toJSON())).toContain('Lịch sử phê duyệt');
  const approve = view.root.findAllByType('button').find((button) => button.children.join('') === 'Duyệt bài học')!;
  act(() => approve.props.onClick());
  expect(onAction).toHaveBeenCalledWith('approve_module_lesson', { moduleLocalId: 'm', expectedVersion: 4 });
});

it('keeps unsaved text on a server status refresh and sends the current retry version', () => {
  const outline = { moduleLocalId: 'm', frameKey: 't1-core', order: 0, title: 'Core', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] };
  const run = { outline, outlineRevision: 1, lessonState: 'failed' as const, lessonVersion: 4, questionState: 'blocked' as const, questionVersion: 2 };
  const onAction = vi.fn();
  const props = { runs: [run], calls: [], selectedId: 'm', busy: false, onSelect: () => {}, onAction, onSources: () => {} };
  let view!: TestRenderer.ReactTestRenderer;
  act(() => { view = TestRenderer.create(createElement(AiModuleWorkspace, props)); });
  const title = () => view.root.findAllByType('input').find((item) => item.props.value === 'Core' || item.props.value === 'Unsaved')!;
  act(() => title().props.onChange({ target: { value: 'Unsaved' } }));
  act(() => view.update(createElement(AiModuleWorkspace, { ...props, runs: [{ ...run, nextRetryAt: '2026-10-28T00:00:00Z' }] })));
  expect(title().props.value).toBe('Unsaved');
  act(() => view.root.findAllByType('button').find((button) => button.children.join('') === 'Viết lại module')!.props.onClick());
  expect(onAction).toHaveBeenCalledWith('retry_module', { moduleLocalId: 'm', target: 'lesson', expectedVersion: 4 });
});

it('exposes versioned fallback and regeneration choices for approved content', () => {
  const run = approvedModuleJob().moduleRuns![0];
  const onAction = vi.fn();
  const view = TestRenderer.create(createElement(AiModuleWorkspace, { runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false, onSelect: () => {}, onAction, onSources: () => {} }));
  for (const [label, action, args] of [
    ['Dùng bản từ nguồn', 'use_source_fallback', { moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion }],
    ['Viết lại module', 'retry_module', { moduleLocalId: run.outline.moduleLocalId, target: 'lesson', expectedVersion: run.lessonVersion }],
    ['Tạo lại câu hỏi', 'retry_module', { moduleLocalId: run.outline.moduleLocalId, target: 'questions', expectedVersion: run.questionVersion }],
  ] as const) {
    const button = view.root.findAllByType('button').find((item) => item.children.join('') === label)!;
    expect(button.props.disabled).toBe(false);
    act(() => button.props.onClick());
    expect(onAction).toHaveBeenCalledWith(action, args);
  }
});

it.each(['queued', 'stale'] as const)('offers versioned source fallback for %s lessons', (state) => {
  const run = { ...approvedModuleJob().moduleRuns![0], lessonState: state, questionState: 'stale' as const };
  const onAction = vi.fn();
  const view = TestRenderer.create(createElement(AiModuleWorkspace, { runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false, onSelect: () => {}, onAction, onSources: () => {} }));
  const fallback = view.root.findAllByType('button').find((button) => button.children.join('') === 'Dùng bản từ nguồn')!;
  expect(fallback.props.disabled).toBe(false);
  act(() => fallback.props.onClick());
  expect(onAction).toHaveBeenCalledWith('use_source_fallback', { moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion });
});

it.each(['drafting', 'validating'] as const)('does not offer fallback during %s', (state) => {
  const run = { ...approvedModuleJob().moduleRuns![0], lessonState: state };
  const view = TestRenderer.create(createElement(AiModuleWorkspace, { runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false, onSelect: () => {}, onAction: () => {}, onSources: () => {} }));
  expect(view.root.findAllByType('button').some((button) => button.children.join('') === 'Dùng bản từ nguồn')).toBe(false);
});

it('disables fallback while busy or questions are drafting', () => {
  for (const busy of [false, true]) {
    const run = { ...approvedModuleJob().moduleRuns![0], lessonState: 'queued' as const, questionState: busy ? 'stale' as const : 'drafting' as const };
    const view = TestRenderer.create(createElement(AiModuleWorkspace, { runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy, onSelect: () => {}, onAction: () => {}, onSources: () => {} }));
    expect(view.root.findAllByType('button').find((button) => button.children.join('') === 'Dùng bản từ nguồn')!.props.disabled).toBe(true);
  }
});
