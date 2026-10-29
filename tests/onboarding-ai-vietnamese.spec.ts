import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AiJobRecord, AiModuleDraftRun, TemplateOutlineModule } from '../src/onboarding/contracts';
import type { GeneratedModule, GeneratedQuestion } from '../src/onboarding/ai/validate';
import type { AdminTemplateDetail } from '../src/onboarding/templates';

vi.mock('@privos_ai/app-react', () => ({
  usePrivosApp: () => ({ rest: vi.fn(), uploadFile: vi.fn() }),
  usePrivosContext: () => ({ userId: 'admin-1', roomId: 'room-1', userRoles: ['admin'], themeTokens: {} }),
}));

import { AiMilestoneProgress } from '../src/ui/onboarding/ai/ai-job-milestones';
import { AiStepCoverage } from '../src/ui/onboarding/ai/ai-step-coverage';
import { AiStepGenerating } from '../src/ui/onboarding/ai/ai-step-generating';
import { AiStepReview } from '../src/ui/onboarding/ai/ai-step-review';
import { AiStepSources } from '../src/ui/onboarding/ai/ai-step-sources';

const FRAMES = ['t1-overview', 't1-access', 't2-core'];
const TITLES = ['Tổng quan chương trình hội nhập', 'Ngày làm việc đầu tiên', 'Phân loại dữ liệu'];

const FORBIDDEN: readonly RegExp[] = [
  /\bt[12]-[a-z]/,
  /\b(concept|steps|scenario|summary|recall|procedure|Missing|Outline|Lesson|Question|Template \d)\b/,
  /Cả hai/,
];

function visibleText(element: ReactElement): string {
  return renderToStaticMarkup(element).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
}

function expectVietnamese(label: string, content: string, rawIds: readonly string[] = []) {
  for (const pattern of FORBIDDEN) expect(content, label + ' ' + String(pattern)).not.toMatch(pattern);
  for (const id of rawIds) expect(content, label + ' raw id ' + id).not.toContain(id);
}

function moduleAt(index: number, patch: Partial<TemplateOutlineModule> = {}): TemplateOutlineModule {
  return {
    moduleLocalId: 'm' + String(index), frameKey: FRAMES[index], order: index, title: TITLES[index], description: '',
    estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['handbook#s' + String(index + 1)],
    responsibilityIndexes: [], coverage: 'sufficient', ...patch,
  };
}

const lesson = (index: number): GeneratedModule => ({
  localId: 'm' + String(index), frameKey: FRAMES[index], title: TITLES[index], description: 'Mô tả module.', estimatedMinutes: 10,
  objectives: ['Hiểu chương trình'], featureIds: [], questions: [],
  blocks: [
    { localId: 'b1', kind: 'concept', title: 'Mục đích', body: 'Nội dung khái niệm.', sourceRefs: [{ sectionId: 'handbook#s1', quote: 'Nội dung' }] },
    { localId: 'b2', kind: 'steps', body: 'Làm theo thứ tự.', steps: [{ order: 1, text: 'Nhận máy' }], sourceRefs: [] },
    { localId: 'b3', kind: 'scenario', body: 'Tình huống.', sourceRefs: [] },
    { localId: 'b4', kind: 'summary', body: 'Tóm tắt.', sourceRefs: [] },
  ],
}) as GeneratedModule;

const questions = (): GeneratedQuestion[] => [0, 1, 2].map((index) => ({
  localId: 'q' + String(index), level: (['recall', 'procedure', 'scenario'] as const)[index], prompt: 'Câu hỏi số ' + String(index + 1),
  correctOptionId: 'a', explanation: 'Vì sổ tay nói vậy.', options: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: 'Đáp án ' + id })),
  blockIds: ['b1'], sourceRefs: [{ sectionId: 'handbook#s1', quote: 'Nội dung' }],
}));

function doneRun(index: number): AiModuleDraftRun {
  return {
    outline: moduleAt(index), outlineRevision: 3,
    lessonState: 'approved', lessonVersion: 2, approvedLessonVersion: 2, lessonProvenance: 'ai', lessonDraft: lesson(index),
    questionState: 'approved', questionVersion: 4, approvedQuestionVersion: 4, questionLessonVersion: 2, questionProvenance: 'ai',
    questionDraft: questions(),
  };
}

function queuedRun(outline: TemplateOutlineModule): AiModuleDraftRun {
  return { outline, outlineRevision: 3, lessonState: 'queued', lessonVersion: 0, questionState: 'blocked', questionVersion: 0 } as AiModuleDraftRun;
}

function templateJob(patch: Partial<AiJobRecord> = {}, runs: readonly AiModuleDraftRun[] = [doneRun(0), doneRun(1), doneRun(2)]): AiJobRecord {
  return {
    id: 'template-row', roomId: 'room-1', jobId: 'template-1', kind: 'template', status: 'completed', templateKind: 'normal',
    inventoryJobId: 'inventory-1', sourceIds: ['handbook'], promptVersion: 'test', stageOutputs: {}, operationId: 'template-op',
    pipelineVersion: 'module_v2', planPending: false, autoApprove: true, title: 'Hội nhập nhân viên mới',
    outline: { revision: 3, modules: runs.map((run) => run.outline), flags: [], taskCoverage: [] }, outlineApprovedRevision: 3,
    moduleRuns: runs, calls: [], result: { templateId: 'draft-1', version: 1 },
    createdBy: 'admin-1', createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T08:01:00.000Z',
    ...patch,
  } as AiJobRecord;
}

const noop = () => undefined;

describe('AI generator copy is Vietnamese', () => {
  it('step 1 Nguồn & loại', () => {
    const content = visibleText(createElement(AiStepSources, {
      kind: null, onKind: noop, templateTitle: '', onTemplateTitle: noop, systemName: '', onSystemName: noop, softwareVersion: '',
      effectiveDate: '', onMeta: noop, responsibilities: '', onResponsibilities: noop, errors: {}, sourcePanel: createElement('div'),
    }));
    expectVietnamese('sources', content);
  });

  it('step 2 Kiểm tra độ phủ', () => {
    const modules = [moduleAt(0), moduleAt(1), moduleAt(2, { sourceSectionIds: [], coverage: 'insufficient' })];
    const content = visibleText(createElement(AiStepCoverage, {
      job: templateJob({ status: 'running', outlineApprovedRevision: 0 }, modules.map(queuedRun)),
      usableSectionIds: new Set(['handbook#s1', 'handbook#s2']),
      sourceCatalog: [{ sourceId: 'handbook', fileName: 'Sổ tay.pdf', sections: [{ id: 'handbook#s1', headingPath: ['Mục 1'], usable: true }] }],
      sourceNames: new Map([['handbook', 'Sổ tay.pdf']]), busy: false,
      onEdit: noop, onUploadFor: noop, onPickSections: noop, onOverride: noop, onAddModule: noop,
    }));
    expectVietnamese('coverage', content);
  });

  it('the technical failure log shows no raw call, job or attempt ids', () => {
    const job = {
      ...templateJob(), kind: 'inventory', jobId: 'job-abc123', status: 'failed', errorMessage: 'Không đọc được tài liệu.',
      calls: [{ callId: 'A1', stage: 'A', operationId: 'job-abc123:A1', status: 'failed', attemptRef: 'attempt-xyz789', provider: 'sandbox' }],
    } as unknown as AiJobRecord;
    const content = visibleText(createElement(AiMilestoneProgress, { label: 'Phân tích tài liệu', job, milestones: [] }));
    expectVietnamese('failure log', content, ['job-abc123', 'attempt-xyz789', 'A1']);
    expect(content).toContain('Phân tích tài liệu');
  });

  it('step 3 AI tạo nội dung', () => {
    const content = visibleText(createElement(AiStepGenerating, {
      job: templateJob({ status: 'running' }, [doneRun(0), { ...doneRun(1), questionState: 'running' } as AiModuleDraftRun, queuedRun(moduleAt(2))]),
      stalled: false, error: null, busy: false, onRetryModule: noop, onRetry: noop,
    }));
    expectVietnamese('generating', content);
  });

  it('step 4 Xem lại & xuất bản', () => {
    const review = {
      id: 'draft-1', version: 1, employeeType: 'normal', title: 'Hội nhập nhân viên mới', description: '', source: 'ai_generated',
      status: 'draft', locked: false, maxAttempts: 2, passingScore: 70, updatedAt: 'now',
      flags: [{
        id: 'flag-1', type: 'missing', severity: 'blocking', status: 'open', message: 'Thiếu số điện thoại hỗ trợ.',
        questionForAdmin: 'Số điện thoại hỗ trợ là gì?', location: { moduleId: 'ai-mod-0' }, evidence: [],
      }],
      modules: [0, 1, 2].map((index) => ({ id: 'ai-mod-' + String(index), key: FRAMES[index], title: TITLES[index], description: '', order: index, resources: [], questions: [] })),
      content: { assessmentMode: 'per_module', learningMode: 'sequential', maxAttemptsPerModule: 2, questionMeta: [], modules: [] },
    } as unknown as AdminTemplateDetail;
    const content = visibleText(createElement(AiStepReview, {
      job: templateJob(), review, updating: false, busy: false,
      settings: { passingScore: 70, maxAttemptsPerModule: 2, learningMode: 'sequential' },
      onSettings: noop, onSaveLesson: noop, onSaveQuestions: noop, onRewrite: noop, onResolveFlag: noop,
      sourceNames: new Map([['handbook', 'Sổ tay.pdf']]),
    }));
    expectVietnamese('review', content);
  });
});
