import { describe, expect, it, vi } from 'vitest';
import type { VerifiedActor } from '@privos_ai/app-server';
import { createAiReviewService } from '../src/onboarding/ai/review';
import { createTemplateService } from '../src/onboarding/templates';
import { materializeAiTemplate } from '../src/onboarding/ai/materialize';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { aiSource, generatedTemplate, seedAiSource } from './helpers/ai-template-fixture';

import {
  DATA_TOOL_NAMES,
  createOnboardingToolHandler,
  sourceFileMetadataFrom,
  type OnboardingServiceBundle,
} from '../src/onboarding/tools';

function verified(
  claims: Readonly<Record<string, unknown>> = { room_roles: ['member'] },
  userId = 'member-1',
): VerifiedActor {
  return {
    userId,
    username: userId === 'admin-1' ? 'admin.lan' : 'learner.minh',
    roomId: 'room-a',
    claims: Object.freeze(claims),
    provenance: 'user-token',
  };
}

function services(): OnboardingServiceBundle {
  return {
    prepare: vi.fn().mockResolvedValue(undefined),
    listRoomMembers: vi.fn().mockResolvedValue([{ userId: 'member-1', username: 'learner.minh' }]),
    employees: {
      list: vi.fn().mockResolvedValue([{ id: 'employee-1', memberId: 'member-1', employeeType: 'normal' }]),
      getByMemberId: vi.fn(),
      add: vi.fn().mockResolvedValue({ id: 'employee-2', memberId: 'member-2', employeeType: 'advanced' }),
    },
    templates: {
      list: vi.fn().mockResolvedValue([{ id: 'privos-foundations', version: 1 }]),
      getAdminDetail: vi.fn(), getLearnerSnapshot: vi.fn(), createDraft: vi.fn(), updateDraft: vi.fn(),
      createAiDraft: vi.fn(), updateAiDraft: vi.fn(),
      cloneSystemTemplate: vi.fn(), publish: vi.fn(), archive: vi.fn(), deleteDraft: vi.fn(),
    },
    assignments: {
      listAdmin: vi.fn().mockResolvedValue([{ id: 'assignment-1', status: 'awaiting_evaluation' }]),
      getAdminDetail: vi.fn(),
      listMine: vi.fn().mockResolvedValue([{ id: 'assignment-1', status: 'in_progress' }]),
      getMine: vi.fn(), assign: vi.fn(), markResourceOpened: vi.fn(), markResourceCompleted: vi.fn(),
      grantRetry: vi.fn(), sendDueReminders: vi.fn(),
    },
    attempts: {
      getOrCreateDraft: vi.fn(), saveDraft: vi.fn(), submit: vi.fn(), getLearnerResult: vi.fn(),
    },
    reviews: {
      listEssayQueue: vi.fn().mockResolvedValue([{ answerId: 'answer-1', reviewed: false }]),
      saveEssayFeedback: vi.fn(),
      listEvaluationQueue: vi.fn().mockResolvedValue([{ attemptId: 'attempt-1' }]),
      publishEvaluation: vi.fn(), getPublishedFeedback: vi.fn(),
    },
    sources: {
      listSources: vi.fn().mockResolvedValue([{ sourceId: 'source-1', fileName: 'guide.md' }]),
      ingestSource: vi.fn().mockResolvedValue({ sourceId: 'source-2', fileName: 'guide.pdf' }),
      addAdminNote: vi.fn().mockResolvedValue({ sourceId: 'source-3', fileName: 'Ghi chú' }),
      deleteSource: vi.fn().mockResolvedValue(undefined),
      getSourceSection: vi.fn().mockResolvedValue({
        fileName: 'guide.md',
        section: { id: 'section-1', text: 'Nội dung' },
      }),
    },
    aiJobs: {
      updateOutline: vi.fn().mockResolvedValue({ jobId: 'job-1', outline: { revision: 2 } }),
      approveOutline: vi.fn().mockResolvedValue({ jobId: 'job-1', outlineApprovedRevision: 1 }),
      listModuleSources: vi.fn().mockResolvedValue([]),
      supplementModuleSources: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      useSourceFallback: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      useQuestionFallback: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      updateModuleLesson: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      approveModuleLesson: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      updateModuleQuestions: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      approveModuleQuestions: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      retryModule: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      startJob: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'running' }),
      listJobs: vi.fn().mockResolvedValue([{ jobId: 'job-1', status: 'running' }]),
      getJob: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'running' }),
      nextStep: vi.fn().mockResolvedValue({ kind: 'wait' }),
      recordDispatch: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'running' }),
      submitAiOutput: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'running' }),
      reportAiFailure: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'failed' }),
      retryJob: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'running' }),
      cancelJob: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'cancelled' }),
      recordAttemptCleanup: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'cancelled' }),
    },
    aiReview: {
      beginPublication: vi.fn().mockResolvedValue({ batchId: 'batch-1', targets: [] }),
      listIncompletePublications: vi.fn().mockResolvedValue([{ batchId: 'batch-1', targets: [] }]),
      getReview: vi.fn().mockResolvedValue({ id: 'template-1', version: 1 }),
      updateReview: vi.fn().mockResolvedValue({ id: 'template-1', version: 1 }),
      resolveFlag: vi.fn().mockResolvedValue({ id: 'template-1', version: 1 }),
    },
    moduleLearning: {
      dashboardSummary: vi.fn().mockResolvedValue({ needsSupportModules: 2, openFlags: 3 }),
      getModules: vi.fn().mockResolvedValue([{ moduleId: 'module-1', status: 'available' }]),
      openModule: vi.fn().mockResolvedValue({ moduleId: 'module-1', status: 'learning' }),
      completeLesson: vi.fn().mockResolvedValue({ moduleId: 'module-1', status: 'quiz_ready' }),
      startModuleQuiz: vi.fn().mockResolvedValue({ attemptId: 'module-attempt-1', questions: [] }),
      submitModuleQuiz: vi.fn().mockResolvedValue({ attemptId: 'module-attempt-1', score: 100 }),
      getModuleAttempt: vi.fn().mockResolvedValue({ attemptId: 'module-attempt-1', score: 100 }),
      grantModuleRetry: vi.fn().mockResolvedValue({ moduleId: 'module-1', status: 'quiz_failed' }),
      questionStats: vi.fn().mockResolvedValue([{ questionId: 'question-1', correctRate: 50 }]),
    },
  };
}

describe('onboarding tool dispatcher', () => {
  it('lists jobs and unrelated recoverable batches after deletion without exposing another owner', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const templates = createTemplateService(store);
    const aiReview = createAiReviewService(store, templates);
    const admin = { roomId: 'room-a', userId: 'admin-1', access: 'admin' as const };
    const otherAdmin = { ...admin, userId: 'admin-2' };
    const drafts = [];
    const batches = [];
    for (const [index, actor] of [admin, admin, otherAdmin].entries()) {
      const draft = await materializeAiTemplate(store, templates, actor, { jobId: 'batch-job-' + index,
        templateKind: 'normal', generated: generatedTemplate, sources: [aiSource] });
      drafts.push(draft);
      batches.push(await aiReview.beginPublication(actor, { targets: [{ kind: 'normal', templateId: draft.id, version: draft.version }] }));
    }
    const handle = createOnboardingToolHandler(() => ({ ...services(), templates, aiReview }));
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');
    await handle('onboarding_admin_templates', { action: 'delete', templateId: drafts[0].id, version: 1 }, actor);
    await expect(handle('onboarding_admin_ai', { action: 'list_jobs' }, actor)).resolves.toMatchObject({
      jobs: [{ jobId: 'job-1' }], publicationBatches: [batches[1]],
    });
    await expect(handle('onboarding_admin_ai', { action: 'list_jobs' }, verified({ room_roles: ['owner'] }, 'admin-2')))
      .resolves.toMatchObject({ publicationBatches: [batches[2]] });
    await expect(aiReview.beginPublication(admin, { batchId: batches[2].batchId, targets: batches[2].targets }))
      .rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });
  });
  it('validates and routes module actions using the verified room admin', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');
    for (const action of ['update_outline', 'approve_outline', 'supplement_module_sources', 'use_source_fallback', 'use_question_fallback', 'update_module_lesson', 'approve_module_lesson', 'update_module_questions', 'approve_module_questions', 'retry_module']) {
      const args = { action, jobId: 'job-1', moduleLocalId: 'm1', expectedRevision: 1, expectedVersion: 1, edits: [], module: {}, questions: [], sourceIds: ['source'], sectionIds: ['source#s1'], target: 'lesson', roomId: 'forged' };
      await expect(handle('onboarding_admin_ai', args, actor)).resolves.toMatchObject({ job: { jobId: 'job-1' } });
      await expect(handle('onboarding_admin_ai', args, verified())).rejects.toThrow();
    }
    await expect(handle('onboarding_admin_ai', { action: 'approve_outline', jobId: 'job-1' }, actor)).rejects.toThrow();
    await expect(handle('onboarding_admin_ai', { action: 'retry_module', jobId: 'job-1', moduleLocalId: 'm1', target: 'other' }, actor)).rejects.toThrow();
    await expect(handle('onboarding_admin_ai', { action: 'retry_module', jobId: 'job-1', moduleLocalId: 'm1', target: 'lesson' }, actor)).rejects.toThrow();
    await expect(handle('onboarding_admin_ai', { action: 'list_module_sources', jobId: 'job-1' }, actor)).resolves.toMatchObject({ sources: [] });
    expect(bundle.aiJobs.supplementModuleSources).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-a', userId: 'admin-1' }), expect.objectContaining({ sourceIds: ['source'], sectionIds: ['source#s1'] }));
    expect(bundle.aiJobs.retryModule).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-a', userId: 'admin-1' }), { jobId: 'job-1', moduleLocalId: 'm1', target: 'lesson', expectedVersion: 1 });
    expect(bundle.aiJobs.useQuestionFallback).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-a', userId: 'admin-1' }), { jobId: 'job-1', moduleLocalId: 'm1', expectedVersion: 1 });
    expect(bundle.aiJobs.updateOutline).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-a', userId: 'admin-1' }), { jobId: 'job-1', expectedRevision: 1, edits: [] });
  });
  it('normalizes only matching room-file metadata for AI source verification', () => {
    expect(sourceFileMetadataFrom({
      file: {
        _id: 'file-1',
        name: 'guide.pdf',
        mimetype: 'application/pdf',
        size: 2048,
      },
    }, 'file-1')).toEqual({
      fileId: 'file-1',
      fileName: 'guide.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    });
    expect(sourceFileMetadataFrom({
      file: { _id: 'other-file', name: 'guide.pdf', size: 2048 },
    }, 'file-1')).toBeNull();
  });

  it('normalizes live Roomfiles snake_case metadata without treating an extension as MIME', () => {
    expect(sourceFileMetadataFrom({
      file: {
        _id: 'file-2',
        name: 'employee-guide.docx',
        file_size: 5115,
        file_type: 'docx',
      },
    }, 'file-2')).toEqual({
      fileId: 'file-2',
      fileName: 'employee-guide.docx',
      size: 5115,
    });
  });

  it('rejects missing and unknown actions for every data tool before touching services', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified();

    for (const name of DATA_TOOL_NAMES) {
      await expect(handle(name, {}, actor)).rejects.toMatchObject({ data: { code: 'ACTION_REQUIRED' } });
      await expect(handle(name, { action: 'not-real' }, actor)).rejects.toMatchObject({ data: { code: 'ACTION_INVALID' } });
    }

    expect(bundle.prepare).not.toHaveBeenCalled();
    expect(bundle.assignments.listMine).not.toHaveBeenCalled();
    expect(bundle.templates.list).not.toHaveBeenCalled();
  });

  it('returns verified identity, room, capabilities, and an Admin summary from bootstrap', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const result = await handle(
      'onboarding_bootstrap',
      { action: 'load' },
      verified({ room_roles: ['owner'] }, 'admin-1'),
    );

    expect(result).toMatchObject({
      role: 'admin',
      roomId: 'room-a',
      identity: { userId: 'admin-1', username: 'admin.lan' },
      capabilities: { canManageTemplates: true, canAssignMembers: true, canReview: true, canLearn: true },
      summary: { assignmentCount: 1, pendingEssayCount: 1, pendingEvaluationCount: 1 },
    });
    expect(bundle.prepare).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-a', access: 'admin' }));
  });

  it('uses authoritative room membership roles when the signed actor has no role claims', async () => {
    const bundle = services();
    vi.mocked(bundle.listRoomMembers).mockResolvedValue([
      { userId: 'admin-1', username: 'admin.lan', roles: ['owner'] },
      { userId: 'member-1', username: 'learner.minh', roles: ['leader'] },
    ]);
    const handle = createOnboardingToolHandler(() => bundle);
    const actorWithoutRoleClaims = verified({ sub: 'admin-1', rid: 'room-a' }, 'admin-1');

    await expect(handle('onboarding_bootstrap', { action: 'load' }, actorWithoutRoleClaims))
      .resolves.toMatchObject({ role: 'admin', capabilities: { canManageTemplates: true } });
    await expect(handle('onboarding_admin_templates', { action: 'list' }, actorWithoutRoleClaims))
      .resolves.toMatchObject({ templates: [{ id: 'privos-foundations', version: 1 }] });

    expect(bundle.listRoomMembers).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1', roomId: 'room-a', access: 'learner',
    }));
    expect(bundle.prepare).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1', roomId: 'room-a', access: 'admin',
    }));
  });

  it('returns only the verified Learner summary for members and leaders', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const result = await handle(
      'onboarding_bootstrap',
      { action: 'load' },
      verified({ room_roles: ['leader'] }),
    );

    expect(result).toMatchObject({
      role: 'learner',
      roomId: 'room-a',
      capabilities: { canManageTemplates: false, canAssignMembers: false, canReview: false, canLearn: true },
      summary: { assignmentCount: 1, activeCount: 1, completedCount: 0 },
    });
    expect(bundle.assignments.listMine).toHaveBeenCalledWith(expect.objectContaining({ userId: 'member-1' }));
    expect(bundle.assignments.listAdmin).not.toHaveBeenCalled();
  });

  it('rejects member and leader Admin calls before any service/store call', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);

    await expect(handle('onboarding_admin_templates', { action: 'list' }, verified()))
      .rejects.toMatchObject({ data: { code: 'ADMIN_REQUIRED' } });
    await expect(handle('onboarding_admin_assignments', { action: 'list' }, verified({ room_roles: ['leader'] })))
      .rejects.toMatchObject({ data: { code: 'ADMIN_REQUIRED' } });
    await expect(handle('onboarding_admin_ai', { action: 'list_sources' }, verified()))
      .rejects.toMatchObject({ data: { code: 'ADMIN_REQUIRED' } });
    await expect(handle('onboarding_admin_ai', { action: 'begin_publication', targets: [] }, verified()))
      .rejects.toMatchObject({ data: { code: 'ADMIN_REQUIRED' } });

    expect(bundle.prepare).not.toHaveBeenCalled();
    expect(bundle.templates.list).not.toHaveBeenCalled();
    expect(bundle.assignments.listAdmin).not.toHaveBeenCalled();
  });

  it('dispatches every Admin AI family with validated server-owned arguments', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');

    await expect(handle('onboarding_admin_ai', { action: 'list_sources' }, actor))
      .resolves.toMatchObject({ sources: [{ sourceId: 'source-1' }] });
    await expect(handle('onboarding_admin_ai', { action: 'list_jobs' }, actor))
      .resolves.toMatchObject({ publicationBatches: [{ batchId: 'batch-1' }] });
    await handle('onboarding_admin_ai', { action: 'begin_publication', targets: [{ kind: 'normal', templateId: 'template-1', version: 1 }] }, actor);
    expect(bundle.aiReview.beginPublication).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', roomId: 'room-a' }),
      { targets: [{ kind: 'normal', templateId: 'template-1', version: 1 }], batchId: undefined });
    await handle('onboarding_admin_ai', {
      action: 'add_admin_note', operationId: 'op-note', title: 'Ghi chú', text: 'Nội dung',
    }, actor);
    await handle('onboarding_admin_ai', {
      action: 'start_job', job: {
        kind: 'inventory', operationId: 'op-job', sourceIds: ['source-1'],
      },
    }, actor);
    await handle('onboarding_admin_ai', {
      action: 'next_step', jobId: 'job-1', workerId: 'tab-1',
    }, actor);
    await handle('onboarding_admin_ai', {
      action: 'update_review', templateId: 'template-1', version: 1,
      expectedUpdatedAt: '2026-10-23T00:00:00.000Z', ops: [],
    }, actor);

    expect(bundle.sources.addAdminNote).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'admin', roomId: 'room-a' }),
      { operationId: 'op-note', title: 'Ghi chú', text: 'Nội dung' },
    );
    expect(bundle.aiJobs.startJob).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      { kind: 'inventory', operationId: 'op-job', sourceIds: ['source-1'] },
    );
    expect(bundle.aiJobs.nextStep).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      { jobId: 'job-1', workerId: 'tab-1' },
    );
    expect(bundle.aiReview.updateReview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      {
        templateId: 'template-1', version: 1,
        expectedUpdatedAt: '2026-10-23T00:00:00.000Z', ops: [],
      },
    );
  });

  it('passes the AI provider through record_dispatch', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');

    await handle('onboarding_admin_ai', {
      action: 'record_dispatch', jobId: 'job-1', workerId: 'tab-1', callId: 'A1',
      attemptRef: 'native-chat:s:m', provider: 'native_chat',
    }, actor);

    expect(bundle.aiJobs.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      {
        jobId: 'job-1', workerId: 'tab-1', callId: 'A1',
        attemptRef: 'native-chat:s:m', provider: 'native_chat',
      },
    );
  });

  it('passes structured provider diagnostics through report_ai_failure', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');

    await handle('onboarding_admin_ai', {
      action: 'report_ai_failure', jobId: 'job-1', workerId: 'tab-1', callId: 'B-lessons',
      kind: 'failed', message: 'Provider credentials rejected',
      providerErrorCode: 'MODEL_PROVIDER_CREDENTIALS_REJECTED', providerPhase: 'model-call',
    }, actor);

    expect(bundle.aiJobs.reportAiFailure).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      {
        jobId: 'job-1', workerId: 'tab-1', callId: 'B-lessons', kind: 'failed',
        message: 'Provider credentials rejected',
        providerErrorCode: 'MODEL_PROVIDER_CREDENTIALS_REJECTED',
        providerPhase: 'model-call',
      },
    );
  });

  it('records provider attempt cleanup with a bounded state', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');

    await handle('onboarding_admin_ai', {
      action: 'record_attempt_cleanup', jobId: 'job-1', callId: 'A1',
      attemptRef: 'native-chat:s:m', state: 'unknown', message: 'Chưa xác nhận',
    }, actor);
    await expect(handle('onboarding_admin_ai', {
      action: 'record_attempt_cleanup', jobId: 'job-1', callId: 'A1',
      attemptRef: 'native-chat:s:m', state: 'pending',
    }, actor)).rejects.toThrow(/state/i);

    expect(bundle.aiJobs.recordAttemptCleanup).toHaveBeenCalledTimes(1);
    expect(bundle.aiJobs.recordAttemptCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      {
        jobId: 'job-1', callId: 'A1', attemptRef: 'native-chat:s:m',
        state: 'unknown', message: 'Chưa xác nhận',
      },
    );
  });

  it('rejects an unknown provider at the tool boundary', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');

    await expect(handle('onboarding_admin_ai', {
      action: 'record_dispatch', jobId: 'job-1', workerId: 'tab-1', callId: 'A1',
      attemptRef: 'attempt-1', provider: 'openai',
    }, actor)).rejects.toThrow(/provider/i);
    expect(bundle.aiJobs.recordDispatch).not.toHaveBeenCalled();
  });

  it('dispatches learner module actions only for the verified learner', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified();

    await expect(handle('onboarding_learning', {
      action: 'get_modules', assignmentId: 'assignment-1', memberId: 'member-1',
    }, actor)).resolves.toMatchObject({ modules: [{ moduleId: 'module-1' }] });
    await handle('onboarding_learning', {
      action: 'submit_module_quiz',
      assignmentId: 'assignment-1',
      moduleId: 'module-1',
      attemptId: 'module-attempt-1',
      operationId: 'op-submit',
      answers: [{ questionId: 'question-1', selectedOptionId: 'option-1' }],
    }, actor);

    expect(bundle.moduleLearning.submitModuleQuiz).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'member-1', access: 'learner' }),
      {
        assignmentId: 'assignment-1',
        moduleId: 'module-1',
        attemptId: 'module-attempt-1',
        operationId: 'op-submit',
        answers: [{ questionId: 'question-1', selectedOptionId: 'option-1' }],
      },
    );
  });

  it('dispatches Admin module retry and question statistics', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');

    await handle('onboarding_admin_assignments', {
      action: 'grant_module_retry', assignmentId: 'assignment-1', moduleId: 'module-1',
    }, actor);
    await handle('onboarding_admin_assignments', {
      action: 'question_stats', templateId: 'template-1', version: 1,
    }, actor);

    expect(bundle.moduleLearning.grantModuleRetry).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'admin' }), 'assignment-1', 'module-1',
    );
    expect(bundle.moduleLearning.questionStats).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'admin' }), 'template-1', 1,
    );
  });

  it('dispatches employee list and add actions with the verified Admin actor', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');

    await expect(handle('onboarding_admin_assignments', { action: 'list_employees' }, actor))
      .resolves.toMatchObject({ employees: [{ memberId: 'member-1' }] });
    await expect(handle('onboarding_admin_assignments', {
      action: 'add_employee', memberId: 'member-2', employeeType: 'advanced',
    }, actor)).resolves.toMatchObject({ employee: { memberId: 'member-2', employeeType: 'advanced' } });

    expect(bundle.employees.list).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', access: 'admin' }));
    expect(bundle.employees.add).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1', access: 'admin' }),
      { memberId: 'member-2', employeeType: 'advanced' },
    );
  });

  it('rejects Learners before employee Admin actions reach the service', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);

    await expect(handle('onboarding_admin_assignments', {
      action: 'add_employee', memberId: 'member-2', employeeType: 'advanced',
    }, verified())).rejects.toMatchObject({ data: { code: 'ADMIN_REQUIRED' } });
    expect(bundle.employees.add).not.toHaveBeenCalled();
  });

  it('binds Learner selectors to the verified member before service dispatch', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);

    await expect(handle('onboarding_learning', { action: 'list', memberId: 'member-2' }, verified()))
      .rejects.toMatchObject({ data: { code: 'MEMBER_FORBIDDEN' } });
    expect(bundle.prepare).not.toHaveBeenCalled();
    expect(bundle.assignments.listMine).not.toHaveBeenCalled();

    await handle('onboarding_learning', { action: 'list', memberId: 'member-1' }, verified());
    expect(bundle.assignments.listMine).toHaveBeenCalledWith(expect.objectContaining({ userId: 'member-1' }));
  });

  it('preserves service error codes as machine-readable MCP error data', async () => {
    const bundle = services();
    vi.mocked(bundle.attempts.submit).mockRejectedValue(Object.assign(new Error('operation reused'), {
      code: 'OPERATION_CONFLICT',
    }));
    const handle = createOnboardingToolHandler(() => bundle);

    await expect(handle('onboarding_learning', {
      action: 'submit', assignmentId: 'assignment-1', operationId: 'op-1',
    }, verified())).rejects.toMatchObject({
      message: 'operation reused',
      data: { code: 'OPERATION_CONFLICT' },
    });
  });
});
