import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AdminTemplateDetail, TemplateDraftInput, TemplateQuestionInput } from '../src/onboarding/templates';
import * as templatesModule from '../src/ui/onboarding/templates';

const completeDraft = (question: TemplateQuestionInput): TemplateDraftInput => ({
  title: 'Hội nhập nhân sự',
  description: 'Chương trình thử nghiệm',
  employeeType: 'normal',
  passingScore: 80,
  maxAttempts: 1,
  modules: [{
    key: 'welcome',
    title: 'Chào mừng',
    description: 'Thông tin cần biết',
    resources: [{ title: 'Sổ tay', kind: 'link', required: true, sourceUrl: 'https://example.com' }],
    questions: [question],
  }],
});

const catalogItem = (id: string, title: string, updatedAt = '2026-10-22T00:00:00.000Z') => ({
  id,
  version: 1,
  source: 'custom' as const,
  status: 'published' as const,
  employeeType: 'normal' as const,
  title,
  description: `${title} description`,
  locked: false,
  updatedAt,
});

const templateDetail = (id: string, title: string): AdminTemplateDetail => ({
  ...catalogItem(id, title),
  passingScore: 80,
  maxAttempts: 1,
  modules: [],
});

describe('template detail and editor UI', () => {
  it('filters templates by Vietnamese title without requiring matching accents or letter case', () => {
    const filterTemplatesByName = (templatesModule as unknown as {
      filterTemplatesByName?: typeof templatesModule.filterTemplatesByName;
    }).filterTemplatesByName;
    const items = [catalogItem('privos', 'Nền tảng PrivOS'), catalogItem('sales', 'Hội nhập Kinh doanh')];

    expect(filterTemplatesByName).toBeTypeOf('function');
    expect(filterTemplatesByName!(items, 'NEN TANG').map((item) => item.id)).toEqual(['privos']);
    expect(filterTemplatesByName!(items, '  kinh doanh  ').map((item) => item.id)).toEqual(['sales']);
    expect(filterTemplatesByName!(items, '')).toEqual(items);
  });

  it('inserts a new question immediately below the selected question', () => {
    const insertQuestionAfter = (templatesModule as unknown as {
      insertQuestionAfter?: typeof templatesModule.insertQuestionAfter;
    }).insertQuestionAfter;
    const first = { type: 'essay' as const, prompt: 'Câu một', required: true };
    const second = { type: 'essay' as const, prompt: 'Câu hai', required: true };
    const inserted = { type: 'essay' as const, prompt: 'Câu mới', required: true };

    expect(insertQuestionAfter).toBeTypeOf('function');
    expect(insertQuestionAfter!([first, second], 0, inserted).map((question) => question.prompt)).toEqual([
      'Câu một', 'Câu mới', 'Câu hai',
    ]);
  });

  it('preloads missing template details once and preserves cached versions', async () => {
    const preloadTemplateDetails = (templatesModule as unknown as {
      preloadTemplateDetails?: typeof templatesModule.preloadTemplateDetails;
    }).preloadTemplateDetails;
    const templateDetailCacheKey = (templatesModule as unknown as {
      templateDetailCacheKey?: typeof templatesModule.templateDetailCacheKey;
    }).templateDetailCacheKey;
    const first = catalogItem('first', 'Template đã tải');
    const second = catalogItem('second', 'Template cần tải');
    const firstDetail = templateDetail(first.id, first.title);
    const secondDetail = templateDetail(second.id, second.title);
    const loadedIds: string[] = [];

    expect(preloadTemplateDetails).toBeTypeOf('function');
    expect(templateDetailCacheKey).toBeTypeOf('function');
    const existing = new Map([[templateDetailCacheKey!(first), { detail: firstDetail, error: null }]]);
    const result = await preloadTemplateDetails!([first, second], existing, async (item) => {
      loadedIds.push(item.id);
      return secondDetail;
    });

    expect(loadedIds).toEqual(['second']);
    expect(result.get(templateDetailCacheKey!(first))?.detail).toBe(firstDetail);
    expect(result.get(templateDetailCacheKey!(second))?.detail).toBe(secondDetail);
  });

  it('keeps other preloaded details available when one template fails', async () => {
    const preloadTemplateDetails = (templatesModule as unknown as {
      preloadTemplateDetails?: typeof templatesModule.preloadTemplateDetails;
    }).preloadTemplateDetails;
    const templateDetailCacheKey = (templatesModule as unknown as {
      templateDetailCacheKey?: typeof templatesModule.templateDetailCacheKey;
    }).templateDetailCacheKey;
    const healthy = catalogItem('healthy', 'Template hợp lệ');
    const broken = catalogItem('broken', 'Template lỗi');

    const result = await preloadTemplateDetails!([healthy, broken], new Map(), async (item) => {
      if (item.id === 'broken') throw new Error('Không tải được chi tiết');
      return templateDetail(item.id, item.title);
    });

    expect(result.get(templateDetailCacheKey!(healthy))?.detail?.id).toBe('healthy');
    expect(result.get(templateDetailCacheKey!(broken))).toEqual({ detail: null, error: 'Không tải được chi tiết' });
  });

  it('rejects a single-choice question with fewer than two answers', () => {
    const issues = templatesModule.validateTemplateDraft(completeDraft({
      type: 'single_choice',
      prompt: 'Bạn chọn đáp án nào?',
      required: true,
      options: [{ id: 'answer-1', label: 'Chỉ một đáp án' }],
      correctOptionIds: ['answer-1'],
    }));

    expect(issues.map((issue) => issue.field)).toContain('modules.0.questions.0.options');
  });

  it('rejects a single-choice question with more than one correct answer', () => {
    const issues = templatesModule.validateTemplateDraft(completeDraft({
      type: 'single_choice',
      prompt: 'Bạn chọn đáp án nào?',
      required: true,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      correctOptionIds: ['a', 'b'],
    }));

    expect(issues.map((issue) => issue.field)).toContain('modules.0.questions.0.correctOptionIds');
  });

  it('sets exactly one correct answer for single choice and toggles multiple-choice answers', () => {
    const updateCorrectOptionIds = (templatesModule as unknown as {
      updateCorrectOptionIds?: (type: 'single_choice' | 'multiple_choice', current: readonly string[], optionId: string) => readonly string[];
    }).updateCorrectOptionIds;

    expect(updateCorrectOptionIds).toBeTypeOf('function');
    expect(updateCorrectOptionIds!('single_choice', ['a'], 'b')).toEqual(['b']);
    expect(updateCorrectOptionIds!('multiple_choice', ['a'], 'b')).toEqual(['a', 'b']);
    expect(updateCorrectOptionIds!('multiple_choice', ['a', 'b'], 'a')).toEqual(['b']);
  });

  it('renders editable answer rows only for multiple-choice question types', () => {
    const QuestionEditor = (templatesModule as unknown as {
      QuestionEditor?: (props: {
        question: TemplateQuestionInput;
        questionNumber?: number;
        onChange: (next: TemplateQuestionInput) => void;
        onRemove: () => void;
      }) => ReactNode;
    }).QuestionEditor;

    expect(QuestionEditor).toBeTypeOf('function');
    const markup = renderToStaticMarkup(createElement(QuestionEditor!, {
      question: {
        type: 'single_choice', prompt: 'PrivOS tổ chức công việc theo đâu?', required: true,
        options: [{ id: 'room', label: 'Theo room' }, { id: 'browser', label: 'Theo trình duyệt' }],
        correctOptionIds: ['room'],
      },
      questionNumber: 2,
      onChange: () => undefined,
      onRemove: () => undefined,
    }));

    expect(markup).toContain('Câu 2');
    expect(markup).toContain('value="Theo room"');
    expect(markup).toContain('type="radio"');
    expect(markup).toContain('Thêm đáp án');
  });

  it('shows only a detail affordance on catalog cards', () => {
    const TemplateCard = (templatesModule as unknown as {
      TemplateCard?: (props: {
        item: {
          id: string; version: number; source: 'system' | 'custom'; status: 'published';
          employeeType: 'normal'; title: string; description: string; locked: boolean; updatedAt: string;
        };
        onOpen: () => void;
      }) => ReactNode;
    }).TemplateCard;

    expect(TemplateCard).toBeTypeOf('function');
    const markup = renderToStaticMarkup(createElement(TemplateCard!, {
      item: {
        id: 'privos-foundations', version: 1, source: 'system', status: 'published',
        employeeType: 'normal', title: 'Nền tảng PrivOS', description: 'Mô tả', locked: true, updatedAt: 'system:1',
      },
      onOpen: () => undefined,
    }));

    expect(markup).toContain('Xem chi tiết');
    expect(markup).not.toContain('Chỉnh sửa');
    expect(markup).not.toContain('Clone');
  });

  it('never offers edit for a system template but offers it for a custom template detail', () => {
    const detailActions = (templatesModule as unknown as {
      templateDetailActions?: (template: { source: 'system' | 'custom'; status: 'draft' | 'published' | 'archived' }) => readonly string[];
    }).templateDetailActions;

    expect(detailActions).toBeTypeOf('function');
    expect(detailActions!({ source: 'system', status: 'published' })).toEqual(['use', 'clone']);
    expect(detailActions!({ source: 'custom', status: 'published' })).toEqual(['use', 'edit', 'archive']);
  });

  it('portals template modals outside animated route stacking contexts', () => {
    const target = { nodeType: 1 } as Element;
    const layer = (templatesModule as unknown as {
      TemplateModalLayer?: (props: { children: ReactNode; target: Element }) => unknown;
    }).TemplateModalLayer;

    expect(layer).toBeTypeOf('function');
    const portal = layer!({ children: createElement('div'), target }) as { containerInfo?: unknown };
    expect(portal.containerInfo).toBe(target);
  });

  it('keeps a dirty editor open for confirmation and closes it after a successful save', () => {
    const transition = (templatesModule as unknown as {
      templateEditorTransition?: (
        state: { open: boolean; dirty: boolean; confirmDiscard: boolean },
        event: 'request_close' | 'cancel_discard' | 'confirm_discard' | 'save_succeeded',
      ) => { open: boolean; dirty: boolean; confirmDiscard: boolean };
    }).templateEditorTransition;

    expect(transition).toBeTypeOf('function');
    expect(transition!({ open: true, dirty: true, confirmDiscard: false }, 'request_close')).toEqual({
      open: true, dirty: true, confirmDiscard: true,
    });
    expect(transition!({ open: true, dirty: true, confirmDiscard: true }, 'cancel_discard')).toEqual({
      open: true, dirty: true, confirmDiscard: false,
    });
    expect(transition!({ open: true, dirty: true, confirmDiscard: false }, 'save_succeeded')).toEqual({
      open: false, dirty: false, confirmDiscard: false,
    });
  });
});
