import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import { AiOutlineReview } from '../src/ui/onboarding/ai/ai-outline-review';

it('keeps eight outline cards collapsed with named keyboard-scrollable review and visible approval', () => {
  const modules = ['t2-role', 't2-permissions', 't2-task-1', 't2-task-2', 't2-task-3', 't2-task-4', 't2-task-5', 't2-task-6'].map((frameKey, order) => ({ moduleLocalId: `m${order}`, frameKey, order, title: `Module ${order}`, description: '', estimatedMinutes: 10, objectives: ['Goal'], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] }));
  const view = TestRenderer.create(createElement(AiOutlineReview, { outline: { revision: 1, modules, taskCoverage: [], flags: [] }, templateKind: 'advanced', responsibilities: ['A', 'B'], busy: false, onEdit: () => {}, onApprove: () => {} }));
  const cards = view.root.findAllByType('details');
  expect(cards).toHaveLength(8);
  expect(cards.every((card) => !card.props.open)).toBe(true);
  expect(view.root.findAllByType('summary').map((node) => node.findByType('strong').children.join(''))).toContain('8. Module 7');
  const region = view.root.find((node) => node.props.role === 'region' && node.props['aria-label'] === 'Các module trong khung');
  expect(region.props.tabIndex).toBe(0);
  expect(region.findAllByType('button').some((button) => button.children.join('') === 'Duyệt khung và bắt đầu viết')).toBe(false);
});

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

it('permits valid admin reorder and disables approval while a title edit is unsaved', () => {
  const modules = ['t1-core', 't1-overview', 't1-access', 't1-navigation'].map((frameKey, order) => ({ moduleLocalId: `m${order}`, frameKey, order, title: frameKey, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] }));
  const view = TestRenderer.create(createElement(AiOutlineReview, { outline: { revision: 2, modules, taskCoverage: [], flags: [] }, templateKind: 'normal', responsibilities: [], busy: false, onEdit: () => {}, onApprove: () => {} }));
  const approve = () => view.root.findAllByType('button').find((b) => b.children.join('') === 'Duyệt khung và bắt đầu viết')!;
  expect(approve().props.disabled).toBe(false);
  act(() => view.root.findAllByType('article')[0].findAllByType('input')[0].props.onChange({ target: { value: '' } }));
  expect(approve().props.disabled).toBe(true);
  act(() => view.root.findAllByType('article')[0].findAllByType('input')[0].props.onChange({ target: { value: 'Updated' } }));
  expect(approve().props.disabled).toBe(true);
  act(() => view.update(createElement(AiOutlineReview, { outline: { revision: 3, modules: modules.map((item, i) => i === 0 ? { ...item, title: 'Updated' } : item), taskCoverage: [], flags: [] }, templateKind: 'normal', responsibilities: [], busy: false, onEdit: () => {}, onApprove: () => {} })));
  expect(approve().props.disabled).toBe(false);
});

it('offers constrained add and remove actions with server-owned IDs', () => {
  const modules = ['t1-overview', 't1-access', 't1-navigation', 't1-core', 't1-workflow'].map((frameKey, order) => ({ moduleLocalId: 'm' + order, frameKey, order, title: frameKey, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['s'], responsibilityIndexes: [] }));
  const onEdit = vi.fn();
  const view = TestRenderer.create(createElement(AiOutlineReview, { outline: { revision: 1, modules, taskCoverage: [], flags: [] }, templateKind: 'normal', responsibilities: [], busy: false, onEdit, onApprove: () => {} }));
  const removable = view.root.findAllByType('article')[4].findAllByType('button').find((button) => button.props['aria-label'] === 'Remove t1-workflow')!;
  expect(removable.props.disabled).toBe(false);
  act(() => removable.props.onClick());
  expect(onEdit).toHaveBeenCalledWith([{ type: 'delete', moduleLocalId: 'm4' }]);
  const select = view.root.findAllByType('select').find((item) => item.props['aria-label'] === 'Add frame')!;
  const frame = select.findAllByType('option').find((option) => option.props.value)!.props.value;
  act(() => select.props.onChange({ target: { value: frame } }));
  const add = view.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Add frame')!;
  act(() => add.props.onClick());
  expect(onEdit).toHaveBeenCalledWith([expect.objectContaining({ type: 'add', module: expect.objectContaining({ frameKey: frame }) })]);
});

it('selects a room source section for an existing module', () => {
  const modules = ['t1-overview', 't1-access', 't1-navigation', 't1-core'].map((frameKey, order) => ({ moduleLocalId: 'm' + order, frameKey, order, title: frameKey, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [] }));
  const onSupplement = vi.fn();
  const view = TestRenderer.create(createElement(AiOutlineReview, { outline: { revision: 1, modules, taskCoverage: [], flags: [] }, templateKind: 'normal', responsibilities: [], busy: false, onEdit: () => {}, onApprove: () => {}, sourceCatalog: [{ sourceId: 'new-source', fileName: 'Policy.pdf', sections: [{ id: 'new-source#1', headingPath: ['Policy'] }] }], onSupplement }));
  const card = view.root.findAllByType('article')[0];
  const checkbox = card.findAllByType('input').find((input) => input.props.type === 'checkbox')!;
  act(() => checkbox.props.onChange({ target: { checked: true } }));
  act(() => card.findAllByType('button').find((button) => button.props['aria-label'] === 'Add selected sources')!.props.onClick());
  expect(onSupplement).toHaveBeenCalledWith('m0', ['new-source'], ['new-source#1']);
});
