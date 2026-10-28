import { describe, expect, it } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import { materializeAiTemplate, materializeModuleTemplate } from '../src/onboarding/ai/materialize';
import { approvedModuleJob } from './helpers/approved-module-fixture';
import { buildFallbackLesson } from '../src/onboarding/ai/fallback-lessons';
import { createTemplateService } from '../src/onboarding/templates';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { aiSource, generatedTemplate, seedAiSource } from './helpers/ai-template-fixture';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };

describe('AI template materialization', () => {
  it('creates stable per-module IDs, balances answer positions, and is idempotent by job', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const templates = createTemplateService(store, {
      now: () => '2026-10-23T09:00:00.000Z',
    });
    const input = {
      jobId: 'job-template-1',
      promptVersion: '2026-10-23.1',
      templateKind: 'normal' as const,
      generated: generatedTemplate,
      sources: [aiSource],
      learningMode: 'sequential' as const,
      maxAttemptsPerModule: 3,
    };

    const first = await materializeAiTemplate(store, templates, admin, input);
    const replay = await materializeAiTemplate(store, templates, admin, input);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      source: 'ai_generated',
      status: 'draft',
      assessmentMode: 'per_module',
      content: { assessmentMode: 'per_module', learningMode: 'sequential', maxAttemptsPerModule: 3 },
    });
    expect(first.modules.every((module) => module.id.startsWith('ai-mod-'))).toBe(true);
    expect(first.content?.modules.flatMap((module) => module.blocks)
      .every((block) => block.id.startsWith('ai-block-'))).toBe(true);
    expect(first.flags?.[0]).toMatchObject({ status: 'open', severity: 'warning' });
    expect(first.content?.modules[0].blocks[0].pendingVerification).toBe(true);

    const correctPositions = first.modules.flatMap((module) => module.questions).map((question) =>
      question.options?.findIndex((option) => question.correctOptionIds?.includes(option.id)));
    expect(correctPositions.slice(0, 8)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(await store.count('room-a', 'onboarding_template_content')).toBe(1);
    expect(await store.count('room-a', 'onboarding_templates')).toBe(1);
  });

  it('keeps answer metadata out of learner snapshots while retaining lesson content', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const templates = createTemplateService(store, {
      now: () => '2026-10-23T09:00:00.000Z',
    });
    const draft = await materializeAiTemplate(store, templates, admin, {
      jobId: 'job-template-safe', promptVersion: '2026-10-23.1', templateKind: 'normal',
      generated: generatedTemplate, sources: [aiSource],
    });
    await templates.publish(admin, draft.id, draft.version, draft.updatedAt);

    const learner = await templates.getLearnerSnapshot(
      { userId: 'member-1', roomId: 'room-a', access: 'learner' },
      draft.id,
      draft.version,
    );

    expect(learner.content?.modules).toHaveLength(4);
    expect(learner.content).not.toHaveProperty('questionMeta');
    expect(JSON.stringify(learner)).not.toContain('correctOptionIds');
  });
});

describe('approved module materialization', () => {
  async function setup(job = approvedModuleJob()) {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    await store.create(admin.roomId, 'onboarding_ai_jobs', { ...job });
    const templates = createTemplateService(store);
    return { store, templates, job };
  }

  it('uses the live approved pair in outline order with internal provenance and stable IDs', async () => {
    const job = approvedModuleJob();
    const reordered = { ...job, outline: { ...job.outline!, modules: [...job.outline!.modules].reverse().map((m, order) => ({ ...m, order })) } };
    const current = { ...reordered, moduleRuns: job.moduleRuns!.map((run) => ({ ...run, outline: reordered.outline.modules.find((m) => m.moduleLocalId === run.outline.moduleLocalId)! })) };
    const { store, templates } = await setup(current);
    const first = await materializeModuleTemplate(store, templates, admin, job.jobId);
    expect(first.modules.map((m) => m.title)).toEqual(['Module 4', 'Module 3', 'Module 2', 'Module 1']);
    expect(first.content?.modules[0]).toMatchObject({ moduleLocalId: 'm4', lessonProvenance: 'ai', approvedLessonVersion: 2, approvedQuestionVersion: 3, questionLessonVersion: 2 });
    expect(first.content?.moduleApproval).toMatchObject({ pipelineVersion: 'module_v2', outlineRevision: 2, taskCoverage: [] });
    expect(await materializeModuleTemplate(store, templates, admin, job.jobId)).toEqual(first);
    await templates.publish(admin, first.id, first.version);
    const learner = await templates.getLearnerSnapshot({ ...admin, access: 'learner' }, first.id, first.version);
    expect(JSON.stringify(learner)).not.toMatch(/lessonProvenance|approvedLessonVersion|moduleApproval|approvedQuestionVersion|jobId|operationId|promptVersion/);
  });

  it('replaces a stale draft with the latest approved text while retaining its template identity', async () => {
    const { store, templates, job } = await setup();
    const draft = await materializeModuleTemplate(store, templates, admin, job.jobId);
    const row = (await store.query(admin.roomId, 'onboarding_ai_jobs', { filter: { jobId: job.jobId } })).records[0];
    await store.update(admin.roomId, 'onboarding_ai_jobs', String(row.id), { moduleRuns: job.moduleRuns!.map((r) => ({ ...r, lessonVersion: 3, approvedLessonVersion: 3, questionVersion: 4, approvedQuestionVersion: 4, questionLessonVersion: 3, lessonDraft: { ...r.lessonDraft!, title: 'Reapproved lesson' } })) });
    const updated = await materializeModuleTemplate(store, templates, admin, job.jobId);
    expect(updated.id).toBe(draft.id);
    expect(updated.modules[0].title).toBe('Reapproved lesson');
    expect(await store.count(admin.roomId, 'onboarding_templates')).toBe(1);
  });

  it('preserves published content when later approvals create a new draft revision', async () => {
    const { store, templates, job } = await setup();
    const draft = await materializeModuleTemplate(store, templates, admin, job.jobId);
    await templates.publish(admin, draft.id, 1);
    const row = (await store.query(admin.roomId, 'onboarding_ai_jobs', { filter: { jobId: job.jobId } })).records[0];
    await store.update(admin.roomId, 'onboarding_ai_jobs', String(row.id), { moduleRuns: job.moduleRuns!.map((r) => ({ ...r, lessonVersion: 3, approvedLessonVersion: 3, questionVersion: 4, approvedQuestionVersion: 4, questionLessonVersion: 3, lessonDraft: { ...r.lessonDraft!, title: 'Reapproved lesson' } })) });
    const revision = await materializeModuleTemplate(store, templates, admin, job.jobId);
    expect(revision).toMatchObject({ id: draft.id, version: 2, status: 'draft' });
    expect((await templates.getAdminDetail(admin, draft.id, 1)).modules[0].title).toBe('Module 1');
    expect(revision.modules[0].id).not.toBe(draft.modules[0].id);
    expect(await materializeModuleTemplate(store, templates, admin, job.jobId)).toEqual(revision);
  });

  it('keeps Department and Job Title on legacy advanced templates', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const job = approvedModuleJob('advanced');
    const templates = createTemplateService(store);
    const draft = await materializeAiTemplate(store, templates, admin, { jobId: 'legacy-advanced', templateKind: 'advanced', sources: [aiSource], roleProfile: job.roleProfile, generated: { title: 'Legacy advanced', description: '', generationNotes: [], flags: [], modules: job.moduleRuns!.map((r) => ({ ...r.lessonDraft!, questions: r.questionDraft!.map((q) => ({ ...q, localId: r.outline.moduleLocalId + q.localId })) })) } });
    const published = await templates.publish(admin, draft.id, 1);
    expect(published.roleProfile).toEqual(job.roleProfile);
    expect(published.roleProfile).toMatchObject({ department: 'it', jobTitle: 'Legacy title' });
  });

  it.each(['lesson', 'questions', 'mismatch', 'audit_only', 'missing', 'too_few', 'too_many', 'outline'] as const)('rejects %s before creating any draft', async (invalid) => {
    const job = approvedModuleJob();
    const first = job.moduleRuns![0];
    const bad = invalid === 'lesson' ? { ...first, lessonVersion: 4 }
      : invalid === 'questions' ? { ...first, questionVersion: 4 }
      : invalid === 'mismatch' ? { ...first, questionLessonVersion: 1 }
      : invalid === 'audit_only' ? { ...first, lessonDraft: undefined }
      : invalid === 'too_few' ? { ...first, questionDraft: first.questionDraft!.slice(0, 2) }
      : invalid === 'too_many' ? { ...first, questionDraft: [...first.questionDraft!, ...first.questionDraft!] }
      : invalid === 'outline' ? { ...first, outlineRevision: 1 } : first;
    const changed = { ...job, moduleRuns: invalid === 'missing' ? job.moduleRuns!.slice(1) : [bad, ...job.moduleRuns!.slice(1)], stageOutputs: { __moduleAudit: job.moduleRuns } };
    const { store, templates } = await setup(changed);
    await expect(materializeModuleTemplate(store, templates, admin, job.jobId)).rejects.toMatchObject({ code: 'AI_CONTENT_INVALID' });
    expect(await store.count(admin.roomId, 'onboarding_templates')).toBe(0);
  });

  it('cannot bypass the live module gate through the legacy materialization entry point', async () => {
    const job = approvedModuleJob();
    const { store, templates } = await setup({ ...job, moduleRuns: [] });
    await expect(materializeAiTemplate(store, templates, admin, { jobId: job.jobId, templateKind: 'normal', generated: generatedTemplate, sources: [aiSource] })).rejects.toMatchObject({ code: 'AI_CONTENT_INVALID' });
    expect(await store.count(admin.roomId, 'onboarding_templates')).toBe(0);
  });

  it('accepts explicitly approved manual content without references and rejects fallback impersonation', async () => {
    const job = approvedModuleJob();
    const modules = job.outline!.modules.map((m) => ({ ...m, sourceSectionIds: [] }));
    const manual = { ...job, outline: { ...job.outline!, modules, flags: modules.map((m) => ({ type: 'missing' as const, severity: 'blocking' as const, message: 'Source missing', questionForAdmin: 'Author content?', location: { moduleLocalId: m.moduleLocalId }, evidence: [] })) }, moduleRuns: job.moduleRuns!.map((r, i) => ({ ...r, outline: modules[i], lessonProvenance: 'manual' as const, lessonDraft: { ...r.lessonDraft!, blocks: r.lessonDraft!.blocks.map((b) => ({ ...b, sourceRefs: [] })) }, questionDraft: r.questionDraft!.map((q) => ({ ...q, sourceRefs: [] })) })) };
    const { store, templates } = await setup(manual);
    const draft = await materializeModuleTemplate(store, templates, admin, job.jobId);
    expect(draft.content?.modules.every((m) => m.lessonProvenance === 'manual')).toBe(true);
    // Source flags still require explicit resolution; manual approval never silently clears them.
    expect(draft.flags?.some((f) => f.severity === 'blocking')).toBe(true);
    const forged = { ...manual, moduleRuns: manual.moduleRuns.map((r) => ({ ...r, lessonProvenance: 'fallback' as const })) };
    const other = await setup(forged);
    await expect(materializeModuleTemplate(other.store, other.templates, admin, job.jobId)).rejects.toMatchObject({ code: 'AI_CONTENT_INVALID' });
  });

  it('accepts exact source-only fallback and rejects changed fallback text', async () => {
    const job = approvedModuleJob();
    const moduleRuns = job.moduleRuns!.map((run) => {
      const fallback = buildFallbackLesson({ outline: run.outline, sections: aiSource.sections! });
      if (fallback.kind !== 'draft') throw new Error('Fixture requires fallback');
      return { ...run, lessonProvenance: 'fallback' as const, lessonDraft: fallback.module, questionDraft: run.questionDraft!.map((q) => ({ ...q, blockIds: [fallback.module.blocks[0].localId] })) };
    });
    const { store, templates } = await setup({ ...job, moduleRuns });
    const draft = await materializeModuleTemplate(store, templates, admin, job.jobId);
    expect(draft.content?.modules[0].lessonProvenance).toBe('fallback');
    const altered = moduleRuns.map((r) => ({ ...r, lessonDraft: { ...r.lessonDraft, blocks: r.lessonDraft.blocks.map((b) => ({ ...b, body: b.body + ' Invented claim.' })) } }));
    const other = await setup({ ...job, moduleRuns: altered });
    await expect(materializeModuleTemplate(other.store, other.templates, admin, job.jobId)).rejects.toMatchObject({ code: 'AI_CONTENT_INVALID' });
  });
});
