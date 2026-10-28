import type { AiJobRecord, EmployeeType } from '../../src/onboarding/contracts';
import { ADVANCED_FRAMES } from '../../src/onboarding/ai/validate';
import { generatedTemplate } from './ai-template-fixture';

export function approvedModuleJob(kind: EmployeeType = 'normal'): AiJobRecord {
  const lessons = kind === 'normal' ? generatedTemplate.modules : [...generatedTemplate.modules, { ...generatedTemplate.modules[0], localId: 'm5' }].map((module, index) => ({
    ...module, frameKey: ADVANCED_FRAMES[index],
    blocks: module.blocks.map((b) => b.kind === 'concept' ? { ...b, kind: 'scenario' as const } : b),
  }));
  const modules = lessons.map((module, order) => ({
    moduleLocalId: module.localId, frameKey: module.frameKey, order,
    title: module.title, description: module.description, objectives: module.objectives,
    estimatedMinutes: module.estimatedMinutes, featureIds: module.featureIds,
    sourceSectionIds: ['source-1#s1'], responsibilityIndexes: kind === 'advanced' && order < 2 ? [order] : [],
  }));
  return {
    id: 'module-job-row', jobId: kind === 'normal' ? 'approved-module-job' : 'advanced-module-job', roomId: 'room-a', kind: 'template',
    pipelineVersion: 'module_v2', templateKind: kind, status: 'completed',
    ...(kind === 'advanced' ? { roleProfile: { department: 'it' as const, jobTitle: 'Legacy title', responsibilities: ['Process orders', 'Review orders'] } } : {}),
    title: 'Approved onboarding', promptVersion: 'module-v2', sourceIds: ['source-1'],
    outline: { revision: 2, modules, flags: [], taskCoverage: kind === 'advanced' ? ['Process orders', 'Review orders'].map((task, i) => ({ task, moduleLocalId: modules[i].moduleLocalId })) : [] }, outlineApprovedRevision: 2,
    moduleRuns: modules.map((outline, index) => ({
      outline, outlineRevision: 2, lessonState: 'approved', lessonVersion: 2,
      approvedLessonVersion: 2, lessonProvenance: 'ai',
      lessonDraft: { ...lessons[index], questions: [] },
      questionState: 'approved', questionVersion: 3, approvedQuestionVersion: 3,
      questionLessonVersion: 2, questionDraft: lessons[index].questions,
    })),
    calls: [], stageOutputs: { __inventory: { features: [] } }, operationId: 'module-op',
    createdBy: 'admin-1', createdAt: '2026-10-28T01:00:00.000Z', updatedAt: '2026-10-28T02:00:00.000Z',
  };
}
