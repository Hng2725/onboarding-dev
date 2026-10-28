import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AiModuleWorkspace } from '../src/ui/onboarding/ai/ai-module-workspace';

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
