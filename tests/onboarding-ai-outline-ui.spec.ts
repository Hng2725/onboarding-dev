import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import { AiOutlineReview } from '../src/ui/onboarding/ai/ai-outline-review';

it('shows outline details and prevents approval of invalid frame order', () => {
  const outline = { revision: 3, modules: [{ moduleLocalId: 'm', frameKey: 'unknown', order: 0, title: 'Module A', description: '', estimatedMinutes: 10, objectives: ['Objective'], featureIds: [], sourceSectionIds: ['source-1'], responsibilityIndexes: [] }], taskCoverage: [], flags: [] };
  const html = renderToStaticMarkup(createElement(AiOutlineReview, { outline, templateKind: 'normal', responsibilities: [], busy: false, onEdit: () => {}, onApprove: () => {} }));
  expect(html).toContain('Objective');
  expect(html).toContain('source-1');
  expect(html).toMatch(/disabled=""[^>]*>Duyệt khung và bắt đầu viết/);
});

it('edits the selected outline card and sends a reorder for that card', () => {
  const onEdit = vi.fn();
  const modules = ['t1-overview', 't1-core', 't1-workflow', 't1-security'].map((frameKey, order) => ({ moduleLocalId: `m${order}`, frameKey, order, title: `Module ${order}`, description: '', estimatedMinutes: 10, objectives: ['Goal'], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] }));
  const view = TestRenderer.create(createElement(AiOutlineReview, { outline: { revision: 2, modules, taskCoverage: [], flags: [] }, templateKind: 'normal', responsibilities: [], busy: false, onEdit, onApprove: () => {} }));
  const cards = view.root.findAllByType('article');
  const input = cards[0].findAllByType('input')[0];
  act(() => input.props.onChange({ target: { value: 'New title' } }));
  act(() => cards[0].findAllByType('button').find((b) => b.children.join('') === 'Lưu thay đổi')!.props.onClick());
  expect(onEdit).toHaveBeenCalledWith([expect.objectContaining({ type: 'update', moduleLocalId: 'm0', patch: expect.objectContaining({ title: 'New title', sourceSectionIds: ['s'] }) })]);
  act(() => cards[1].findAllByType('button').find((b) => b.children.join('') === '↑')!.props.onClick());
  expect(onEdit).toHaveBeenCalledWith([{ type: 'reorder', moduleLocalId: 'm1', order: 0 }]);
});
