import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import type { AiModuleDraftRun } from '../src/onboarding/contracts';
import { AiModuleWorkspace } from '../src/ui/onboarding/ai/ai-module-workspace';
import { approvedModuleJob } from './helpers/approved-module-fixture';

function approvedRuns() {
  return approvedModuleJob().moduleRuns!;
}

function renderWorkspace(
  runs: readonly AiModuleDraftRun[],
  overrides: Record<string, unknown> = {},
) {
  return TestRenderer.create(createElement(AiModuleWorkspace, {
    runs,
    calls: [],
    selectedId: runs[0]?.outline.moduleLocalId ?? '',
    busy: false,
    onSelect: () => {},
    onAction: () => {},
    onSources: () => {},
    ...overrides,
  }));
}

function button(view: TestRenderer.ReactTestRenderer, label: string) {
  return view.root.findAllByType('button').find((item) => item.children.join('') === label)!;
}

it('opens an approved draft in reading mode without form fields', () => {
  const run = { ...approvedRuns()[0], lessonState: 'review_ready' as const, questionState: 'blocked' as const };
  const html = renderToStaticMarkup(createElement(AiModuleWorkspace, {
    runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false,
    onSelect: () => {}, onAction: () => {}, onSources: () => {},
  }));

  expect(html).toContain('Use **Orders** to start the documented workflow.');
  expect(html).toContain('Review the order workflow.');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain('<select');
});

it('uses human-readable module titles instead of internal frame IDs', () => {
  const original = approvedRuns()[0];
  const run = {
    ...original,
    outline: { ...original.outline, frameKey: 't1-overview', title: 't1-overview' },
  };
  const html = renderToStaticMarkup(createElement(AiModuleWorkspace, {
    runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false,
    onSelect: () => {}, onAction: () => {}, onSources: () => {},
  }));

  expect(html).toContain('1. Tổng quan');
  expect(html).toContain('<h3>Tổng quan</h3>');
  expect(html).not.toContain('t1-overview');
});

it('reveals lesson fields only after Chỉnh sửa is selected', () => {
  const run = { ...approvedRuns()[0], lessonState: 'review_ready' as const, questionState: 'blocked' as const };
  const view = renderWorkspace([run]);
  expect(view.root.findAllByProps({ 'aria-label': 'Tiêu đề bài học' })).toHaveLength(0);

  act(() => button(view, 'Chỉnh sửa').props.onClick());

  expect(view.root.findByProps({ 'aria-label': 'Tiêu đề bài học' }).props.value).toBe(run.lessonDraft!.title);
  expect(button(view, 'Lưu bài học')).toBeDefined();
});

it('keeps question review hidden until every lesson is approved', () => {
  const [first, second] = approvedRuns();
  const pending = { ...second, lessonState: 'review_ready' as const, questionState: 'blocked' as const };
  const props = {
    runs: [first, pending], calls: [], selectedId: first.outline.moduleLocalId, busy: false,
    onSelect: () => {}, onAction: () => {}, onSources: () => {},
  };
  const view = TestRenderer.create(createElement(AiModuleWorkspace, props));

  expect(view.root.findAllByProps({ 'data-phase': 'lessons' }).some((node) => node.children.join('').includes('Bài học'))).toBe(true);
  expect(JSON.stringify(view.toJSON())).not.toContain('What should you do in case 1?');

  act(() => view.update(createElement(AiModuleWorkspace, { ...props, runs: [first, second] })));
  expect(view.root.findAllByProps({ 'data-phase': 'questions' }).some((node) => node.children.join('').includes('Câu hỏi'))).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain('What should you do in case 1?');
});

it('labels question progress explicitly as questions', () => {
  const run = approvedRuns()[0];
  const html = renderToStaticMarkup(createElement(AiModuleWorkspace, {
    runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false,
    onSelect: () => {}, onAction: () => {}, onSources: () => {},
  }));

  expect(html).toContain('3/3 câu hỏi đã duyệt');
  expect(html).not.toContain('nhiệm vụ');
});

it('labels grounded fallback questions as requiring Admin review', () => {
  const original = approvedRuns()[0];
  const run = {
    ...original,
    questionState: 'review_ready' as const,
    approvedQuestionVersion: undefined,
    questionProvenance: 'fallback' as const,
  };
  const html = renderToStaticMarkup(createElement(AiModuleWorkspace, {
    runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false,
    onSelect: () => {}, onAction: () => {}, onSources: () => {},
  }));

  expect(html).toContain('Bản câu hỏi dự phòng — cần rà soát');
});

it('enables question approval only for a non-dirty review-ready draft', () => {
  const original = approvedRuns()[0];
  for (const state of ['queued', 'drafting', 'failed', 'stale'] as const) {
    const view = renderWorkspace([{
      ...original,
      questionState: state,
      approvedQuestionVersion: undefined,
    }]);
    expect(button(view, 'Duyệt câu hỏi và tiếp tục').props.disabled).toBe(true);
  }

  const ready = {
    ...original,
    questionState: 'review_ready' as const,
    approvedQuestionVersion: undefined,
  };
  const readyView = renderWorkspace([ready]);
  expect(button(readyView, 'Duyệt câu hỏi và tiếp tục').props.disabled).toBe(false);

  const emptyView = renderWorkspace([{ ...ready, questionDraft: [] }]);
  expect(button(emptyView, 'Duyệt câu hỏi và tiếp tục').props.disabled).toBe(true);

  act(() => button(readyView, 'Chỉnh sửa').props.onClick());
  const prompt = readyView.root.findAllByType('textarea')[0];
  act(() => prompt.props.onChange({ target: { value: 'Bản chỉnh sửa chưa lưu' } }));
  act(() => button(readyView, 'Đóng chỉnh sửa').props.onClick());
  expect(button(readyView, 'Duyệt câu hỏi và tiếp tục').props.disabled).toBe(true);
});

it('approves the current lesson and selects the next module after success', async () => {
  const [first, second] = approvedRuns().slice(0, 2).map((run) => ({
    ...run, lessonState: 'review_ready' as const, questionState: 'blocked' as const,
  }));
  const onAction = vi.fn(async () => true);
  const onSelect = vi.fn();
  const view = renderWorkspace([first, second], { onAction, onSelect });

  await act(async () => { await button(view, 'Duyệt và sang module tiếp theo').props.onClick(); });

  expect(onAction).toHaveBeenCalledWith('approve_module_lesson', {
    moduleLocalId: first.outline.moduleLocalId,
    expectedVersion: first.lessonVersion,
  });
  expect(onSelect).toHaveBeenCalledWith(second.outline.moduleLocalId);
});

it('does not advance when approve-and-next reports failure', async () => {
  const [first, second] = approvedRuns().slice(0, 2).map((run) => ({
    ...run, lessonState: 'review_ready' as const, questionState: 'blocked' as const,
  }));
  const onSelect = vi.fn();
  const view = renderWorkspace([first, second], { onAction: async () => false, onSelect });

  await act(async () => { await button(view, 'Duyệt và sang module tiếp theo').props.onClick(); });

  expect(onSelect).not.toHaveBeenCalled();
});

it('puts retry and source fallback inside Thao tác khác with current versions', () => {
  const run = approvedRuns()[0];
  const onAction = vi.fn();
  const view = renderWorkspace([run], {
    history: [{ moduleLocalId: run.outline.moduleLocalId, target: 'questions', version: 1 }],
    onAction,
  });
  const overflow = view.root.findAllByType('details').find((node) => node.props.className === 'ai-module-more-actions')!;

  expect(overflow.findByType('summary').children.join('')).toBe('Thao tác khác');
  expect(overflow.findAllByType('button').map((item) => item.children.join(''))).toEqual([
    'Viết lại bài học', 'Dùng bản từ nguồn', 'Tạo lại câu hỏi',
  ]);
  expect(overflow.findAllByType('strong').some((item) => item.children.join('') === 'Lịch sử phê duyệt')).toBe(true);

  act(() => overflow.findAllByType('button')[0].props.onClick());
  expect(onAction).toHaveBeenCalledWith('retry_module', {
    moduleLocalId: run.outline.moduleLocalId, target: 'lesson', expectedVersion: run.lessonVersion,
  });
  act(() => overflow.findAllByType('button')[1].props.onClick());
  expect(onAction).toHaveBeenCalledWith('use_source_fallback', {
    moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion,
  });
  act(() => overflow.findAllByType('button')[2].props.onClick());
  expect(onAction).toHaveBeenCalledWith('retry_module', {
    moduleLocalId: run.outline.moduleLocalId, target: 'questions', expectedVersion: run.questionVersion,
  });
});

it('routes a source-less module through Bổ sung tài liệu', () => {
  const original = approvedRuns()[0];
  const run = {
    ...original,
    outline: { ...original.outline, sourceSectionIds: [] },
    lessonDraft: undefined,
    lessonState: 'manual_required' as const,
    questionDraft: undefined,
    questionState: 'blocked' as const,
  };
  const onSources = vi.fn();
  const view = renderWorkspace([run], { onSources });

  expect(JSON.stringify(view.toJSON())).toContain('Cần bổ sung tài liệu hoặc tự soạn');
  act(() => button(view, 'Bổ sung tài liệu').props.onClick());
  expect(onSources).toHaveBeenCalledOnce();
  expect(button(view, 'Duyệt và sang module tiếp theo').props.disabled).toBe(true);
});

it('keeps unsaved lesson text on status refresh and saves the current version', () => {
  const original = approvedRuns()[0];
  const run = { ...original, lessonState: 'review_ready' as const, questionState: 'blocked' as const };
  const onAction = vi.fn();
  const props = {
    runs: [run], calls: [], selectedId: run.outline.moduleLocalId, busy: false,
    onSelect: () => {}, onAction, onSources: () => {},
  };
  const view = TestRenderer.create(createElement(AiModuleWorkspace, props));
  act(() => button(view, 'Chỉnh sửa').props.onClick());
  const title = () => view.root.findByProps({ 'aria-label': 'Tiêu đề bài học' });
  act(() => title().props.onChange({ target: { value: 'Bản chưa lưu' } }));
  act(() => view.update(createElement(AiModuleWorkspace, {
    ...props, runs: [{ ...run, nextRetryAt: '2026-10-29T08:00:00Z' }],
  })));

  expect(title().props.value).toBe('Bản chưa lưu');
  act(() => button(view, 'Lưu bài học').props.onClick());
  expect(onAction).toHaveBeenCalledWith('update_module_lesson', expect.objectContaining({
    moduleLocalId: run.outline.moduleLocalId,
    expectedVersion: run.lessonVersion,
    module: expect.objectContaining({ title: 'Bản chưa lưu' }),
  }));
});

it('keeps source fallback disabled while questions are drafting or the workspace is busy', () => {
  for (const busy of [false, true]) {
    const run = {
      ...approvedRuns()[0],
      lessonState: 'queued' as const,
      questionState: busy ? 'stale' as const : 'drafting' as const,
    };
    const view = renderWorkspace([run], { busy });
    expect(button(view, 'Dùng bản từ nguồn').props.disabled).toBe(true);
  }
});
