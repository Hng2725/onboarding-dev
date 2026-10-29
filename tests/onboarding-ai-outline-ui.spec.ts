import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { AiOutlineReview } from '../src/ui/onboarding/ai/ai-outline-review';

const normalModules = ['t1-overview', 't1-access', 't1-navigation', 't1-core'].map((frameKey, order) => ({
  moduleLocalId: `normal-${order}`,
  frameKey,
  order,
  title: frameKey,
  description: `Mô tả ${order + 1}`,
  estimatedMinutes: 10,
  objectives: ['Mục tiêu'],
  featureIds: [],
  sourceSectionIds: [`source-${order}`],
  responsibilityIndexes: [],
}));

function outline(modules = normalModules, revision = 1) {
  return { revision, modules, taskCoverage: [], flags: [] };
}

function normalProps(overrides: Record<string, unknown> = {}) {
  return {
    outline: outline(),
    templateKind: 'normal' as const,
    responsibilities: [],
    busy: false,
    onEdit: () => {},
    onApprove: () => {},
    ...overrides,
  };
}

function button(view: TestRenderer.ReactTestRenderer, label: string) {
  return view.root.findAllByType('button').find((item) => item.children.join('') === label)!;
}

it('renders every normal module as one ordered roadmap instead of four choices', () => {
  const view = TestRenderer.create(createElement(AiOutlineReview, normalProps()));
  const roadmap = view.root.find((node) => node.props['aria-label'] === 'Lộ trình module');
  const moduleButtons = roadmap.findAllByType('button').filter((item) => typeof item.props['aria-pressed'] === 'boolean');

  expect(moduleButtons).toHaveLength(4);
  expect(moduleButtons.map((item) => item.props['aria-pressed'])).toEqual([true, false, false, false]);
  expect(moduleButtons.map((item) => item.findByType('strong').children.join(''))).toEqual([
    '1. Tổng quan',
    '2. Tài khoản và quyền truy cập',
    '3. Làm quen giao diện',
    '4. Quy trình công việc chính',
  ]);
});

it('uses friendly frame labels when generated titles are raw frame keys', () => {
  const html = renderToStaticMarkup(createElement(AiOutlineReview, normalProps()));

  expect(html).toContain('Tổng quan');
  expect(html).toContain('Tài khoản và quyền truy cập');
  expect(html).not.toContain('>t1-overview<');
});

it('hides work responsibility counts for Template 1', () => {
  const html = renderToStaticMarkup(createElement(AiOutlineReview, normalProps()));

  expect(html).not.toContain('nhiệm vụ');
});

it('shows mapped work responsibilities with explicit wording for Template 2', () => {
  const modules = ['t2-role', 't2-permissions', 't2-task-1', 't2-task-2', 't2-task-3'].map((frameKey, order) => ({
    ...normalModules[0], moduleLocalId: `advanced-${order}`, frameKey, order, title: frameKey,
    responsibilityIndexes: order === 2 ? [0, 1] : [],
  }));
  const html = renderToStaticMarkup(createElement(AiOutlineReview, {
    ...normalProps(), outline: outline(modules), templateKind: 'advanced', responsibilities: ['Đối soát', 'Báo cáo'],
  }));

  expect(html).toContain('2 nhiệm vụ công việc');
  expect(html).not.toContain('2 câu hỏi');
});

it('keeps only add edit and approve as persistent roadmap actions', () => {
  const view = TestRenderer.create(createElement(AiOutlineReview, normalProps()));
  const actions = view.root.findByProps({ className: 'ai-roadmap-actions' });

  expect(actions.findAllByType('button').map((item) => item.children.join(''))).toEqual([
    'Thêm module bổ sung',
    'Chỉnh sửa module',
    'Duyệt lộ trình và tiếp tục',
  ]);
});

it('opens module fields only after edit is requested and locks approval while dirty', () => {
  const view = TestRenderer.create(createElement(AiOutlineReview, normalProps()));
  expect(view.root.findAllByType('input')).toHaveLength(0);

  act(() => button(view, 'Chỉnh sửa module').props.onClick());
  const title = view.root.findByProps({ 'aria-label': 'Tên module' });
  act(() => title.props.onChange({ target: { value: 'Tổng quan mới' } }));

  expect(title.props.value).toBe('Tổng quan mới');
  expect(button(view, 'Duyệt lộ trình và tiếp tục').props.disabled).toBe(true);
});

it('opens source selection only after bổ sung tài liệu is requested', () => {
  const onSupplement = vi.fn();
  const view = TestRenderer.create(createElement(AiOutlineReview, normalProps({
    onSupplement,
    sourceCatalog: [{ sourceId: 'policy', fileName: 'Policy.pdf', sections: [{ id: 'policy#1', headingPath: ['Quy định'] }] }],
  })));
  act(() => button(view, 'Chỉnh sửa module').props.onClick());
  expect(view.root.findAll((node) => node.type === 'input' && node.props.type === 'checkbox')).toHaveLength(0);

  act(() => button(view, 'Bổ sung tài liệu').props.onClick());
  const checkbox = view.root.find((node) => node.type === 'input' && node.props.type === 'checkbox');
  act(() => checkbox.props.onChange({ target: { checked: true } }));
  act(() => button(view, 'Thêm tài liệu đã chọn').props.onClick());

  expect(onSupplement).toHaveBeenCalledWith('normal-0', ['policy'], ['policy#1']);
  expect(JSON.stringify(view.toJSON())).not.toContain('Nguồn và phần tài liệu');
});

it('keeps add reorder remove save and approve callbacks compatible', () => {
  const modules = [...normalModules, {
    ...normalModules[0], moduleLocalId: 'extra', frameKey: 't1-data', order: 4, title: 'Dữ liệu',
  }];
  const onEdit = vi.fn();
  const onApprove = vi.fn();
  const view = TestRenderer.create(createElement(AiOutlineReview, normalProps({
    outline: outline(modules), onEdit, onApprove,
  })));

  const roadmap = view.root.find((node) => node.props['aria-label'] === 'Lộ trình module');
  act(() => roadmap.findAllByType('button')[4].props.onClick());
  act(() => button(view, 'Chỉnh sửa module').props.onClick());
  act(() => view.root.findByProps({ 'aria-label': 'Tên module' }).props.onChange({ target: { value: 'Dữ liệu hệ thống' } }));
  act(() => button(view, 'Lưu thay đổi').props.onClick());
  expect(onEdit).toHaveBeenCalledWith([expect.objectContaining({
    type: 'update', moduleLocalId: 'extra', patch: expect.objectContaining({ title: 'Dữ liệu hệ thống' }),
  })]);

  act(() => button(view, 'Chỉnh sửa module').props.onClick());
  act(() => view.root.findByProps({ 'aria-label': 'Đưa Dữ liệu lên' }).props.onClick());
  expect(onEdit).toHaveBeenCalledWith([{ type: 'reorder', moduleLocalId: 'extra', order: 3 }]);
  act(() => button(view, 'Xóa module').props.onClick());
  expect(onEdit).toHaveBeenCalledWith([{ type: 'delete', moduleLocalId: 'extra' }]);

  act(() => button(view, 'Đóng chỉnh sửa').props.onClick());
  act(() => button(view, 'Thêm module bổ sung').props.onClick());
  const select = view.root.findByProps({ 'aria-label': 'Chọn module bổ sung' });
  act(() => select.props.onChange({ target: { value: 't1-core-2' } }));
  act(() => button(view, 'Thêm vào lộ trình').props.onClick());
  expect(onEdit).toHaveBeenCalledWith([expect.objectContaining({
    type: 'add', module: expect.objectContaining({ frameKey: 't1-core-2', title: 'Quy trình bổ sung' }),
  })]);

  act(() => button(view, 'Duyệt lộ trình và tiếp tục').props.onClick());
  expect(onApprove).toHaveBeenCalledOnce();
});

it('disables approval for invalid outlines with a user-visible explanation', () => {
  const invalid = [{ ...normalModules[0], frameKey: 'unknown', title: 'Không hợp lệ' }];
  const view = TestRenderer.create(createElement(AiOutlineReview, normalProps({ outline: outline(invalid) })));

  expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('Khung chưa hợp lệ');
  expect(button(view, 'Duyệt lộ trình và tiếp tục').props.disabled).toBe(true);
});
