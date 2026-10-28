import type { AiModuleDraftRun, TemplateOutline } from '../contracts';
import type { GeneratedModule, GeneratedQuestion } from './validate';

export class ModuleLifecycleError extends Error {
  readonly code = 'OPERATION_CONFLICT';
}
function conflict(condition: boolean, message: string): void {
  if (condition) throw new ModuleLifecycleError(message);
}
export function createModuleRuns(outline: TemplateOutline): readonly AiModuleDraftRun[] {
  return outline.modules.map((module) => ({ outline: module, outlineRevision: outline.revision, lessonState: 'queued', lessonVersion: 0, questionState: 'blocked', questionVersion: 0, schemaRepairs: 0, transientRetries: 0 }));
}
export function invalidateModule(run: AiModuleDraftRun): AiModuleDraftRun {
  const { approvedLessonVersion: _lesson, approvedQuestionVersion: _questions, nextRetryAt: _retry, providerWaitStartedAt: _wait, ...rest } = run;
  return { ...rest, lessonState: 'stale', lessonVersion: run.lessonVersion + 1, questionState: run.questionVersion ? 'stale' : 'blocked', questionVersion: run.questionVersion + 1, schemaRepairs: 0, transientRetries: 0 };
}
export function reconcileModuleRuns(runs: readonly AiModuleDraftRun[], outline: TemplateOutline): readonly AiModuleDraftRun[] {
  return createModuleRuns(outline).map((fresh) => {
    const old = runs.find((r) => r.outline.moduleLocalId === fresh.outline.moduleLocalId);
    if (!old) return fresh;
    const { order: _oldOrder, ...before } = old.outline;
    const { order: _newOrder, ...after } = fresh.outline;
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    return { ...(changed ? invalidateModule(old) : old), ...(changed ? { sourceFingerprint: undefined } : {}), outline: fresh.outline, outlineRevision: outline.revision };
  });
}
export function updateLesson(run: AiModuleDraftRun, expectedVersion: number, module: GeneratedModule, provenance: 'ai' | 'fallback' | 'manual'): AiModuleDraftRun {
  conflict(run.outline.tombstoned === true || run.lessonVersion !== expectedVersion, 'Lesson version conflict.');
  conflict(module.localId !== run.outline.moduleLocalId || module.frameKey !== run.outline.frameKey || JSON.stringify(module.featureIds) !== JSON.stringify(run.outline.featureIds), 'Module identity cannot change.');
  const { approvedLessonVersion: _lesson, approvedQuestionVersion: _questions, nextRetryAt: _retry, providerWaitStartedAt: _wait, ...rest } = run;
  // Replacing a lesson invalidates even an unsaved first-question request.
  const questionVersion = run.lessonVersion > 0 ? run.questionVersion + 1 : run.questionVersion;
  return { ...rest, lessonDraft: { ...module, questions: [] }, lessonFlags: [], lessonProvenance: provenance, lessonVersion: run.lessonVersion + 1, lessonState: provenance === 'fallback' ? 'fallback_review' : 'review_ready', questionState: run.questionVersion ? 'stale' : 'blocked', questionVersion };
}
export function approveLesson(run: AiModuleDraftRun, expectedVersion: number): AiModuleDraftRun {
  conflict(run.outline.tombstoned === true || run.lessonVersion !== expectedVersion || !run.lessonDraft || !['review_ready', 'fallback_review'].includes(run.lessonState), 'Lesson is not ready for approval.');
  return { ...run, lessonState: 'approved', approvedLessonVersion: run.lessonVersion, questionState: 'queued' };
}
export function lessonApproved(run: AiModuleDraftRun): boolean {
  return !run.outline.tombstoned && run.lessonState === 'approved' && run.approvedLessonVersion === run.lessonVersion && !!run.lessonDraft;
}
export function updateQuestions(run: AiModuleDraftRun, expectedVersion: number, questions: readonly GeneratedQuestion[]): AiModuleDraftRun {
  conflict(!lessonApproved(run) || run.questionVersion !== expectedVersion, 'Questions require the current approved lesson and version.');
  conflict(questions.length < 3 || questions.length > 5, 'Three to five questions are required.');
  const { approvedQuestionVersion: _approved, ...rest } = run;
  return { ...rest, questionState: 'review_ready', questionVersion: run.questionVersion + 1, questionLessonVersion: run.lessonVersion, questionDraft: questions, questionFlags: [] };
}
export function approveQuestions(run: AiModuleDraftRun, expectedVersion: number): AiModuleDraftRun {
  conflict(!lessonApproved(run) || run.questionVersion !== expectedVersion || run.questionState !== 'review_ready' || run.questionLessonVersion !== run.lessonVersion || !run.questionDraft || run.questionDraft.length < 3 || run.questionDraft.length > 5, 'Questions are not ready for approval.');
  return { ...run, questionState: 'approved', approvedQuestionVersion: run.questionVersion };
}
export function retryModuleRun(run: AiModuleDraftRun, target: 'lesson' | 'questions'): AiModuleDraftRun {
  conflict(run.outline.tombstoned === true || run.lessonState === 'drafting' || run.questionState === 'drafting', 'Module has an active call.');
  if (target === 'lesson') return { ...invalidateModule(run), lessonState: 'queued' };
  conflict(!lessonApproved(run), 'Questions require an approved lesson.');
  const { approvedQuestionVersion: _approved, nextRetryAt: _retry, providerWaitStartedAt: _wait, ...rest } = run;
  return { ...rest, questionState: 'queued', questionVersion: run.questionVersion + 1, schemaRepairs: 0, transientRetries: 0 };
}
export function modulesComplete(runs: readonly AiModuleDraftRun[]): boolean {
  const active = runs.filter((run) => !run.outline.tombstoned);
  return active.length > 0 && active.every((run) => lessonApproved(run) && run.questionState === 'approved' && run.approvedQuestionVersion === run.questionVersion && run.questionLessonVersion === run.lessonVersion && !!run.questionDraft && run.questionDraft.length >= 3 && run.questionDraft.length <= 5);
}
