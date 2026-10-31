import { createElement, type ReactNode } from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminTemplateDetail } from '../src/onboarding/templates';

vi.mock('@privos_ai/app-react', () => ({
  usePrivosApp: () => ({ rest: vi.fn(), uploadFile: vi.fn() }),
  usePrivosContext: () => ({ userId: 'admin-1', roomId: 'room-1', effectiveScopes: [], userRoles: ['admin'], themeTokens: {} }),
}));
// The renderer has no DOM to portal into: render the library's modals in place.
vi.mock('../src/ui/onboarding/template-editor-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/onboarding/template-editor-ui')>()),
  TemplateModalLayer: ({ children }: { children: ReactNode }) => children,
}));

import { TemplatesPage } from '../src/ui/onboarding/templates';

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

function stat(view: TestRenderer.ReactTestRenderer, label: string): string {
  const row = view.root.findAll((node) => node.type === 'div' && node.parent?.props.className === 'template-detail-stats'
    && text(node).startsWith(label));
  return text(row[0].findByType('dd'));
}

const module = (index: number) => ({
  id: 'module-' + String(index), title: 'Module ' + String(index), description: '', resources: [], questions: [],
});

function detail(id: string, status: 'draft' | 'published', modules: number, maxAttempts: number): AdminTemplateDetail {
  return {
    id, version: 1, source: 'ai_generated', status, employeeType: 'normal', title: 'Template ' + id, description: '',
    locked: false, passingScore: 70, maxAttempts, modules: Array.from({ length: modules }, (_, index) => module(index + 1)),
    updatedAt: '2026-10-30T04:00:00.000Z',
  } as unknown as AdminTemplateDetail;
}

const views: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const view of views.splice(0)) act(() => view.unmount());
});

describe('template library detail', () => {
  it('reads an AI draft again on open, so a draft re-materialized in place never shows its old modules', async () => {
    // Same id, version and list updatedAt before and after AI rewrote the draft in place (live 2026-10-30).
    const item = { id: 'ai-draft', version: 1, source: 'ai_generated', status: 'draft', employeeType: 'normal', title: 'Template ai-draft', description: '', locked: false, updatedAt: '2026-10-30T04:00:00.000Z' };
    const published = { ...item, id: 'ai-published', status: 'published', title: 'Template ai-published' };
    let draftReads = 0;
    const adminTemplates = vi.fn(async (action: string, args: { templateId?: string } = {}) => {
      if (action === 'list') return { templates: [item, published] };
      if (action === 'get' && args.templateId === 'ai-draft') {
        draftReads += 1;
        return { template: draftReads === 1 ? detail('ai-draft', 'draft', 2, 1) : detail('ai-draft', 'draft', 6, 3) };
      }
      if (action === 'get') return { template: detail('ai-published', 'published', 4, 2) };
      throw new Error('Unexpected action: ' + action);
    });
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(createElement(TemplatesPage, { api: { adminTemplates } as never, onUseTemplate: () => undefined }));
    });
    views.push(view);
    // The list preloaded the draft's detail once, in its old state.
    expect(draftReads).toBe(1);
    const open = (title: string) => view.root.findByProps({ 'aria-label': 'Xem chi tiết ' + title });
    await act(async () => { open('Template ai-draft').props.onClick(); });
    expect(stat(view, 'Module')).toBe('6');
    expect(stat(view, 'Lượt làm tối đa')).toBe('3');
    expect(draftReads).toBe(2);

    // A published version is immutable: its preloaded detail is used as is.
    const publishedReads = () => adminTemplates.mock.calls.filter(([action, args]) => action === 'get' && args?.templateId === 'ai-published').length;
    const before = publishedReads();
    await act(async () => { view.root.findByProps({ 'aria-label': 'Đóng' }).props.onClick(); });
    await act(async () => { open('Template ai-published').props.onClick(); });
    expect(stat(view, 'Module')).toBe('4');
    expect(publishedReads()).toBe(before);
  });

  it('shows the per-module attempt limit of an AI template, not the legacy template-level field', async () => {
    const item = { id: 'ai-draft', version: 1, source: 'ai_generated', status: 'draft', employeeType: 'normal', title: 'Template ai-draft', description: '', locked: false, updatedAt: '2026-10-30T04:00:00.000Z' };
    const unlimited = { ...item, id: 'ai-unlimited', title: 'Template ai-unlimited' };
    const withLimit = (id: string, maxAttemptsPerModule: number | null) =>
      ({ ...detail(id, 'draft', 6, 1), content: { maxAttemptsPerModule } }) as unknown as AdminTemplateDetail;
    const adminTemplates = vi.fn(async (action: string, args: { templateId?: string } = {}) => {
      if (action === 'list') return { templates: [item, unlimited] };
      if (action === 'get') return { template: args.templateId === 'ai-draft' ? withLimit('ai-draft', 3) : withLimit('ai-unlimited', null) };
      throw new Error('Unexpected action: ' + action);
    });
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(createElement(TemplatesPage, { api: { adminTemplates } as never, onUseTemplate: () => undefined }));
    });
    views.push(view);
    const open = (title: string) => view.root.findByProps({ 'aria-label': 'Xem chi tiết ' + title });
    await act(async () => { open('Template ai-draft').props.onClick(); });
    expect(stat(view, 'Lượt làm mỗi module')).toBe('3');
    await act(async () => { view.root.findByProps({ 'aria-label': 'Đóng' }).props.onClick(); });
    await act(async () => { open('Template ai-unlimited').props.onClick(); });
    expect(stat(view, 'Lượt làm mỗi module')).toBe('Không giới hạn');
  });
});
