import { describe, expect, it } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import type { TemplateResource } from '../src/onboarding/contracts';
import { materializeAiTemplate, materializeModuleTemplate } from '../src/onboarding/ai/materialize';
import { approvedModuleJob } from './helpers/approved-module-fixture';
import { createAiPublishGuard, createAiReviewService } from '../src/onboarding/ai/review';
import { createTemplateService } from '../src/onboarding/templates';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { aiSource, generatedTemplate, seedAiSource } from './helpers/ai-template-fixture';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };

describe('module publication gate', () => {
  it('starts a fresh batch when an admin restores retired content without reviving another owner or old batch', async () => {
    const { review, draft, store } = await setup();
    const target = { kind: 'normal' as const, templateId: draft.id, version: 1 };
    const request = { targets: [target] };
    const original = await review.beginPublication(admin, request);
    const otherAdmin = { ...admin, userId: 'admin-2' };
    const otherBatch = await review.beginPublication(otherAdmin, request);
    const originalBody = draft.content!.modules[0].blocks[0].body;
    const edit = async (body: string) => {
      const current = await review.getReview(admin, draft.id, 1);
      await review.updateReview(admin, { templateId: draft.id, version: 1, expectedUpdatedAt: current.updatedAt,
        ops: [{ kind: 'update_block', moduleId: current.modules[0].id, blockId: current.content!.modules[0].blocks[0].id, body }] });
    };
    await edit('Changed content');
    const changed = await review.beginPublication(admin, request);
    await edit(originalBody);
    const restored = await review.beginPublication(admin, request);
    expect(new Set([original.batchId, changed.batchId, restored.batchId]).size).toBe(3);
    expect((await review.beginPublication(admin, request)).batchId).toBe(restored.batchId);
    expect(await review.listIncompletePublications(admin)).toEqual([restored]);
    expect(await review.listIncompletePublications(otherAdmin)).toEqual([otherBatch]);
    const otherRow = (await store.query(admin.roomId, 'onboarding_ai_publications', { filter: { batchId: otherBatch.batchId } })).records[0];
    expect(otherRow.retiredAt).toBeUndefined();
  });

  it.each(['lesson', 'question', 'settings'] as const)('replaces an obsolete partial batch after a same-version %s edit and keeps unchanged retries idempotent', async (edit) => {
    const { templates, review, draft, store } = await setup();
    const target = { kind: 'normal' as const, templateId: draft.id, version: draft.version,
      settings: { passingScore: draft.passingScore!, maxAttemptsPerModule: draft.content!.maxAttemptsPerModule, learningMode: draft.content!.learningMode } };
    const original = await review.beginPublication(admin, { targets: [target] });
    expect((await review.beginPublication(admin, { targets: [target] })).batchId).toBe(original.batchId);
    let current = await review.getReview(admin, draft.id, draft.version);
    current = await review.updateReview(admin, { templateId: draft.id, version: draft.version, expectedUpdatedAt: current.updatedAt,
      ops: [{ kind: 'checkpoint_publication', moduleId: current.modules[0].id,
        resource: { id: 'ai-lesson-pdf-' + current.modules[0].id, title: 'Old lesson', kind: 'file', required: true, fileId: 'old-pdf' } }] });
    const updated = await review.updateReview(admin, { templateId: draft.id, version: draft.version, expectedUpdatedAt: current.updatedAt,
      ops: edit === 'lesson' ? [{ kind: 'update_block', moduleId: current.modules[0].id, blockId: current.content!.modules[0].blocks[0].id, body: 'Revised lesson' }]
        : edit === 'question' ? [{ kind: 'update_question', questionId: current.modules[0].questions[0].id, prompt: 'Revised question?' }]
          : [{ kind: 'set_settings', passingScore: 85 }] });
    const request = { targets: [{ ...target, settings: { ...target.settings, passingScore: updated.passingScore! } }] };
    const replacement = await review.beginPublication(admin, request);
    expect(replacement.batchId).not.toBe(original.batchId);
    const recreated = createAiReviewService(store, createTemplateService(store));
    expect((await recreated.beginPublication(admin, request)).batchId).toBe(replacement.batchId);
    expect(await recreated.listIncompletePublications(admin)).toEqual([replacement]);
    await expect(recreated.beginPublication(admin, { batchId: original.batchId, targets: [target] })).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });
    expect((await recreated.getReview(admin, draft.id, draft.version)).passingScore).toBe(updated.passingScore);
    const published = await templates.publish(admin, draft.id, draft.version);
    await recreated.updateReview(admin, { templateId: draft.id, version: draft.version, expectedUpdatedAt: published.updatedAt,
      ops: [{ kind: 'checkpoint_publication', jsonFileId: 'replacement-json' }] });
    expect(await recreated.listIncompletePublications(admin)).toEqual([]);
  });

  it('discovers persisted incomplete publication selections after service recreation and removes fully completed batches', async () => {
    const { templates, review, draft, store } = await setup();
    expect(typeof review.beginPublication).toBe('function');
    const request = { targets: [{ kind: 'normal' as const, templateId: draft.id, version: draft.version,
      settings: { passingScore: 80, maxAttemptsPerModule: 4, learningMode: 'free' as const } }] };
    const batch = await review.beginPublication(admin, request);
    const recreated = createAiReviewService(store, createTemplateService(store));
    expect(await recreated.listIncompletePublications(admin)).toEqual([batch]);
    expect((await recreated.beginPublication(admin, request)).batchId).toBe(batch.batchId);
    expect(await recreated.listIncompletePublications({ ...admin, userId: 'other-admin' })).toEqual([]);
    expect(await recreated.listIncompletePublications({ ...admin, roomId: 'other-room' })).toEqual([]);
    const published = await templates.publish(admin, draft.id, batch.targets[0].version);
    await recreated.updateReview(admin, { templateId: draft.id, version: published.version, expectedUpdatedAt: published.updatedAt,
      ops: [{ kind: 'checkpoint_publication', jsonFileId: 'complete-json' }] });
    expect(await recreated.listIncompletePublications(admin)).toEqual([]);
  });
  it('reuses settings revisions with refreshed approval fingerprints and leaves published v1 immutable', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const job = approvedModuleJob();
    await store.create(admin.roomId, 'onboarding_ai_jobs', { ...job });
    const templates = createTemplateService(store);
    const reviews = createAiReviewService(store, templates);
    const draft = await materializeModuleTemplate(store, templates, admin, job.jobId);
    const published = await templates.publish(admin, draft.id, 1);
    const request = { templateId: draft.id, version: 1, expectedUpdatedAt: published.updatedAt,
      ops: [{ kind: 'set_settings' as const, passingScore: 85, maxAttemptsPerModule: 4, learningMode: 'free' as const }] };
    const revision = await reviews.updateReview(admin, request);
    expect(revision.version).toBe(2);
    await expect(templates.publish(admin, revision.id, revision.version)).resolves.toMatchObject({ status: 'published', passingScore: 85 });
    expect((await reviews.updateReview(admin, request)).version).toBe(2);
    expect((await materializeModuleTemplate(store, templates, admin, job.jobId)).version).toBe(2);
    expect(await templates.getAdminDetail(admin, draft.id, 1)).toEqual(published);
    expect(await store.count(admin.roomId, 'onboarding_templates')).toBe(2);
  });

  it('does not create a revision when published settings are unchanged', async () => {
    const { templates, review, draft, store } = await setup();
    const published = await templates.publish(admin, draft.id, 1);
    const result = await review.updateReview(admin, { templateId: draft.id, version: 1, expectedUpdatedAt: published.updatedAt,
      ops: [{ kind: 'set_settings', passingScore: published.passingScore, learningMode: published.content!.learningMode, maxAttemptsPerModule: published.content!.maxAttemptsPerModule }] });
    expect(result).toEqual(published);
    expect(await store.count(admin.roomId, 'onboarding_templates')).toBe(1);
  });

  it.each(['draft', 'published'] as const)('invalidates changed legacy lesson artifacts on a %s while retaining unaffected PDFs', async (status) => {
    const { templates, review, draft } = await setup();
    let current = draft;
    for (const module of draft.modules) {
      const resource: TemplateResource = { id: 'ai-lesson-pdf-' + module.id, title: module.title, kind: 'file', required: true, fileId: 'pdf-' + module.id };
      current = await review.updateReview(admin, { templateId: current.id, version: current.version, expectedUpdatedAt: current.updatedAt,
        ops: [{ kind: 'checkpoint_publication', moduleId: module.id, resource }] });
      current = await review.updateReview(admin, { templateId: current.id, version: current.version, expectedUpdatedAt: current.updatedAt,
        ops: [{ kind: 'upsert_generated_resource', moduleId: module.id, resource }] });
    }
    if (status === 'published') {
      current = await templates.publish(admin, current.id, 1);
      current = await review.updateReview(admin, { templateId: current.id, version: 1, expectedUpdatedAt: current.updatedAt,
        ops: [{ kind: 'checkpoint_publication', jsonFileId: 'v1-json' }] });
    }
    const before = current;
    const changed = await review.updateReview(admin, { templateId: current.id, version: current.version, expectedUpdatedAt: current.updatedAt,
      ops: [{ kind: 'update_block', moduleId: current.modules[0].id, blockId: current.content!.modules[0].blocks[0].id, body: 'Updated lesson text' }] });
    expect(changed.content?.publication?.jsonFileId).toBeUndefined();
    expect(changed.content?.publication?.pdfs[changed.modules[0].id]).toBeUndefined();
    expect(changed.modules[0].resources.filter((resource) => resource.id.startsWith('ai-lesson-pdf-'))).toEqual([]);
    expect(changed.content?.publication?.pdfs[changed.modules[1].id]?.fileId).toBe('pdf-' + before.modules[1].id);
    if (status === 'published') expect(await templates.getAdminDetail(admin, before.id, 1)).toEqual(before);
  });
  it('does not let callers bypass blocking flags by omitting the optional legacy publish guard', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const job = approvedModuleJob();
    await store.create(admin.roomId, 'onboarding_ai_jobs', { ...job, outline: { ...job.outline!, flags: [{ type: 'missing', severity: 'blocking', message: 'Missing policy', questionForAdmin: 'Confirm policy?', location: { moduleLocalId: 'm1' }, evidence: [] }] } });
    const templates = createTemplateService(store);
    const draft = await materializeModuleTemplate(store, templates, admin, job.jobId);
    await expect(templates.publish(admin, draft.id, 1)).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
  });
  it('persists PDF and JSON checkpoints across service instances without revising a published template', async () => {
    const { store, templates, draft } = await setup();
    let review = await createAiReviewService(store, templates).updateReview(admin, {
      templateId: draft.id, version: 1, expectedUpdatedAt: draft.updatedAt,
      ops: [{ kind: 'checkpoint_publication', moduleId: draft.modules[0].id, resource: { id: 'ai-lesson-pdf-' + draft.modules[0].id, title: 'Lesson', kind: 'file', required: true, fileId: 'uploaded-pdf' } }],
    });
    expect((await createAiReviewService(store, templates).getReview(admin, draft.id, 1)).content?.publication?.pdfs[draft.modules[0].id].fileId).toBe('uploaded-pdf');
    review = await templates.publish(admin, draft.id, 1);
    await createAiReviewService(store, templates).updateReview(admin, { templateId: draft.id, version: 1, expectedUpdatedAt: review.updatedAt, ops: [{ kind: 'checkpoint_publication', jsonFileId: 'uploaded-json' }] });
    expect((await createAiReviewService(store, templates).getReview(admin, draft.id, 1))).toMatchObject({ status: 'published', version: 1, content: { publication: { jsonFileId: 'uploaded-json' } } });
    expect(await store.count(admin.roomId, 'onboarding_templates')).toBe(1);
  });
  it('rejects publication if a newer lesson invalidated a materialized approval even without an optional guard', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const job = approvedModuleJob();
    const row = await store.create(admin.roomId, 'onboarding_ai_jobs', { ...job });
    const templates = createTemplateService(store);
    const draft = await materializeModuleTemplate(store, templates, admin, job.jobId);
    await store.update(admin.roomId, 'onboarding_ai_jobs', String(row.id), {
      moduleRuns: job.moduleRuns!.map((r, i) => i === 0 ? { ...r, lessonVersion: 3 } : r),
    });
    await expect(templates.publish(admin, draft.id, draft.version)).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    expect((await templates.getAdminDetail(admin, draft.id, draft.version)).status).toBe('draft');
  });

  it('requires module edits to be approved again and permits artifact/settings updates', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const job = approvedModuleJob();
    await store.create(admin.roomId, 'onboarding_ai_jobs', { ...job });
    const templates = createTemplateService(store, { publishGuard: createAiPublishGuard(store) });
    const draft = await materializeModuleTemplate(store, templates, admin, job.jobId);
    const review = createAiReviewService(store, templates);
    await expect(review.updateReview(admin, { templateId: draft.id, version: 1, expectedUpdatedAt: draft.updatedAt, ops: [{ kind: 'update_block', moduleId: draft.modules[0].id, blockId: draft.content!.modules[0].blocks[0].id, body: 'Unapproved replacement' }] })).rejects.toMatchObject({ code: 'REVIEW_INVALID' });
    const updated = await review.updateReview(admin, { templateId: draft.id, version: 1, expectedUpdatedAt: draft.updatedAt, ops: [{ kind: 'set_settings', passingScore: 80 }] });
    await expect(templates.publish(admin, updated.id, 1)).resolves.toMatchObject({ status: 'published', passingScore: 80 });
  });
});

async function setup() {
  const store = new MemoryOnboardingStore();
  await seedAiSource(store);
  let tick = 0;
  const now = () => `2026-10-23T10:00:${String(++tick).padStart(2, '0')}.000Z`;
  const templates = createTemplateService(store, { now, publishGuard: createAiPublishGuard(store) });
  const review = createAiReviewService(store, templates, { now });
  const draft = await materializeAiTemplate(store, templates, admin, {
    jobId: 'job-review', promptVersion: '2026-10-23.1', templateKind: 'normal',
    generated: generatedTemplate, sources: [aiSource],
  });
  return { draft, review, store, templates };
}

describe('AI template review', () => {
  it('edits AI content with optimistic concurrency and records a manual-edit audit', async () => {
    const { draft, review, store } = await setup();
    const module = draft.content!.modules[0];
    const block = module.blocks[0];

    const updated = await review.updateReview(admin, {
      templateId: draft.id,
      version: draft.version,
      expectedUpdatedAt: draft.updatedAt,
      ops: [{ kind: 'update_block', moduleId: module.moduleId, blockId: block.id, body: 'Admin corrected body.' }],
    });

    expect(updated.content?.modules[0].blocks[0].body).toBe('Admin corrected body.');
    await expect(review.updateReview(admin, {
      templateId: draft.id,
      version: draft.version,
      expectedUpdatedAt: draft.updatedAt,
      ops: [{ kind: 'update_block', moduleId: module.moduleId, blockId: block.id, body: 'Stale edit.' }],
    })).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });
    const audits = await store.query('room-a', 'onboarding_audit_events', {
      filter: { action: 'ai_template.manual_edit' },
    });
    expect(audits.records).toHaveLength(1);
  });

  it('stores resolution notes, recomputes pending verification, and audits flag resolution', async () => {
    const { draft, review, store } = await setup();
    const flag = draft.flags![0];

    const resolved = await review.resolveFlag(admin, {
      templateId: draft.id,
      version: draft.version,
      flagId: flag.id,
      action: 'accept',
      note: 'Reviewed with the process owner.',
    });

    expect(resolved.flags?.[0]).toMatchObject({
      status: 'dismissed',
      resolution: { action: 'accept', note: 'Reviewed with the process owner.', by: 'admin-1' },
    });
    expect(resolved.content?.modules[0].blocks[0].pendingVerification).toBe(false);
    const audits = await store.query('room-a', 'onboarding_audit_events', {
      filter: { action: 'ai_flag.resolved' },
    });
    expect(audits.records).toHaveLength(1);
  });

  it('automatically reopens a flag when the Admin-note evidence used to resolve it is deleted', async () => {
    const { draft, review, store } = await setup();
    const resolved = await review.resolveFlag(admin, {
      templateId: draft.id,
      version: draft.version,
      flagId: draft.flags![0].id,
      action: 'add_note',
      note: 'The process owner confirms that every employee uses this workflow.',
    });
    const noteRef = resolved.flags![0].evidence.find((ref) => ref.kind === 'admin_note')!;
    const noteRows = await store.query('room-a', 'onboarding_sources', {
      filter: { sourceId: noteRef.sourceId },
    });
    await store.softDelete('room-a', 'onboarding_sources', String(noteRows.records[0].id));

    const reopened = await review.getReview(admin, draft.id, draft.version);

    expect(reopened.flags?.[0]).toMatchObject({ status: 'open' });
    expect(reopened.flags?.[0]).not.toHaveProperty('resolution');
    expect(reopened.content?.modules[0].blocks[0].pendingVerification).toBe(true);
  });

  it('reopens a resolved evidence flag after an edit invalidates its review and blocks publish', async () => {
    const { draft, review, store, templates } = await setup();
    const warning = draft.flags![0];
    const accepted = await review.resolveFlag(admin, {
      templateId: draft.id, version: 1, flagId: warning.id, action: 'accept', note: 'Accepted once.',
    });
    const block = accepted.content!.modules[0].blocks[0];
    const reopened = await review.updateReview(admin, {
      templateId: draft.id,
      version: 1,
      expectedUpdatedAt: accepted.updatedAt,
      ops: [{ kind: 'update_block', moduleId: accepted.content!.modules[0].moduleId, blockId: block.id, body: 'Changed claim.' }],
    });
    expect(reopened.flags?.[0].status).toBe('open');

    await storeBlockingFlag(store, reopened);
    const blocked = await review.getReview(admin, draft.id, 1);
    await expect(templates.publish(admin, blocked.id, 1, blocked.updatedAt)).rejects.toMatchObject({
      code: 'TEMPLATE_FLAGS_BLOCKING',
    });
  });

  it('publishes a clean draft and edits the published snapshot as a new immutable revision', async () => {
    const { draft, review, templates } = await setup();
    const clean = await review.resolveFlag(admin, {
      templateId: draft.id, version: 1, flagId: draft.flags![0].id, action: 'accept',
    });
    const published = await templates.publish(admin, draft.id, 1, clean.updatedAt);
    const firstBody = published.content!.modules[0].blocks[0].body;
    const second = await review.updateReview(admin, {
      templateId: published.id,
      version: 1,
      expectedUpdatedAt: published.updatedAt,
      ops: [{
        kind: 'update_block',
        moduleId: published.content!.modules[0].moduleId,
        blockId: published.content!.modules[0].blocks[0].id,
        body: 'Revision two body.',
      }],
    });

    expect(second).toMatchObject({ version: 2, status: 'draft', source: 'ai_generated' });
    expect(second.content?.modules[0].blocks[0].body).toBe('Revision two body.');
    expect((await templates.getAdminDetail(admin, published.id, 1)).content?.modules[0].blocks[0].body)
      .toBe(firstBody);
  });

  it('rejects invalid generated resources without mutating the review', async () => {
    const { draft, review } = await setup();
    const moduleId = draft.modules[0].id;
    const valid: TemplateResource = {
      id: `ai-lesson-pdf-${moduleId}`,
      title: 'Tài liệu bài học',
      description: 'PDF do AI tạo.',
      kind: 'file',
      required: true,
      fileId: 'file-lesson-1',
    };
    const cases: readonly { readonly moduleId: string; readonly resource: TemplateResource }[] = [
      { moduleId: 'missing-module', resource: valid },
      { moduleId, resource: { ...valid, kind: 'link' } },
      { moduleId, resource: { ...valid, fileId: '   ' } },
      { moduleId, resource: { ...valid, required: false } },
      { moduleId, resource: { ...valid, id: '   ' } },
      { moduleId, resource: { ...valid, title: '   ' } },
    ];

    for (const invalid of cases) {
      await expect(review.updateReview(admin, {
        templateId: draft.id,
        version: draft.version,
        expectedUpdatedAt: draft.updatedAt,
        ops: [{ kind: 'upsert_generated_resource', ...invalid }],
      })).rejects.toMatchObject({ code: 'REVIEW_INVALID' });
    }

    const unchanged = await review.getReview(admin, draft.id, draft.version);
    expect(unchanged.updatedAt).toBe(draft.updatedAt);
    expect(unchanged.modules).toEqual(draft.modules);
    expect(unchanged.content).toEqual(draft.content);
    expect(unchanged.flags).toEqual(draft.flags);
  });

  it('upserts a generated file by stable ID and persists only its module resources', async () => {
    const { draft, review } = await setup();
    const module = draft.modules[0];
    const untouchedModule = draft.modules[1];
    const contentBefore = structuredClone(draft.content);
    const questionsBefore = structuredClone(draft.modules.map((entry) => entry.questions));
    const flagsBefore = structuredClone(draft.flags);
    const resourceId = `ai-lesson-pdf-${module.id}`;

    const first = await review.updateReview(admin, {
      templateId: draft.id,
      version: draft.version,
      expectedUpdatedAt: draft.updatedAt,
      ops: [{
        kind: 'upsert_generated_resource',
        moduleId: module.id,
        resource: {
          id: resourceId,
          title: 'Tài liệu bài học',
          description: 'Bản PDF đầu tiên.',
          kind: 'file',
          required: true,
          fileId: 'file-lesson-v1',
        },
      }],
    });
    const firstResource = first.modules[0].resources.filter((entry) => entry.id === resourceId);
    expect(firstResource).toEqual([expect.objectContaining({ fileId: 'file-lesson-v1' })]);
    expect(first.updatedAt).not.toBe(draft.updatedAt);

    const second = await review.updateReview(admin, {
      templateId: first.id,
      version: first.version,
      expectedUpdatedAt: first.updatedAt,
      ops: [{
        kind: 'upsert_generated_resource',
        moduleId: module.id,
        resource: {
          id: resourceId,
          title: 'Tài liệu bài học đã cập nhật',
          description: 'Bản PDF thay thế.',
          kind: 'file',
          required: true,
          fileId: 'file-lesson-v2',
        },
      }],
    });

    expect(second.modules[0].resources.filter((entry) => entry.id === resourceId)).toEqual([{
      id: resourceId,
      title: 'Tài liệu bài học đã cập nhật',
      description: 'Bản PDF thay thế.',
      kind: 'file',
      required: true,
      sourceUrl: undefined,
      fileId: 'file-lesson-v2',
    }]);
    expect(second.modules.find((entry) => entry.id === untouchedModule.id)?.resources)
      .toEqual(untouchedModule.resources);
    expect(second.content).toEqual(contentBefore);
    expect(second.modules.map((entry) => entry.questions)).toEqual(questionsBefore);
    expect(second.flags).toEqual(flagsBefore);

    const persisted = await review.getReview(admin, second.id, second.version);
    expect(persisted.modules[0].resources).toEqual(second.modules[0].resources);
    expect(persisted.updatedAt).toBe(second.updatedAt);
  });
});

async function storeBlockingFlag(
  store: MemoryOnboardingStore,
  detail: { readonly id: string; readonly version: number; readonly flags?: readonly Record<string, unknown>[] },
): Promise<void> {
  const rows = await store.query('room-a', 'onboarding_template_content', {
    filter: { templateId: detail.id, templateVersion: detail.version },
  });
  const row = rows.records[0];
  await store.update('room-a', 'onboarding_template_content', String(row.id), {
    flags: [{
      ...detail.flags![0],
      id: 'blocking-fixture',
      severity: 'blocking',
      status: 'open',
      resolution: undefined,
    }],
  });
}
