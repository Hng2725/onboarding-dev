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
