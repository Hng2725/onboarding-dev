import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AiCallRecord, AiJobRecord, VerificationFlag } from '../src/onboarding/contracts';
import type { AdminTemplateDetail } from '../src/onboarding/templates';
import {
  AI_GENERATOR_STEPS,
  AiTemplateSelection,
  aiGeneratorStepFor,
  aiCallDisplayLabel,
  aiCallRuntimeText,
  aiJobCurrentCall,
  aiJobErrorText,
  aiJobProgress,
  aiJobPrefersNative,
  canPublishAiReview,
  cancelRunningAiJob,
  createAiPublishDependencies,
  finishSuccessfulAiPublish,
  attemptsNeedingCleanup,
  reconcileAttemptCleanups,
  selectBlockingNativeCleanup,
  aiJobStatusText,
  clearAiResumeKeys,
  generationErrorMessage,
  lessonPdfResourceId,
  readAiResumeKey,
  selectResumableAiJobs,
  templateJobActionText,
  writeAiResumeKey,
} from '../src/ui/onboarding/ai/ai-generator';
import { FlagPanel } from '../src/ui/onboarding/ai/flag-panel';
import { AiReview } from '../src/ui/onboarding/ai/ai-review';
import {
  AiMilestoneProgress,
  inventoryMilestones,
  templateMilestones,
} from '../src/ui/onboarding/ai/ai-job-milestones';
import {
  acceptedSourceTypes,
  resolveUploadSystemName,
  validateSourceFile,
} from '../src/ui/onboarding/ai/source-panel';
import { TemplateCard, templateDetailActions } from '../src/ui/onboarding/template-editor-ui';
import { createAiReviewService } from '../src/onboarding/ai/review';
import { createTemplateService } from '../src/onboarding/templates';
import { materializeModuleTemplate } from '../src/onboarding/ai/materialize';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { approvedModuleJob } from './helpers/approved-module-fixture';
import { seedAiSource } from './helpers/ai-template-fixture';
import { AiPublishBatchError, publishAiTemplateBatch, type AiPublishTarget } from '../src/ui/onboarding/ai/ai-publish-batch';
import type { UpdateAiReviewInput } from '../src/onboarding/ai/review';

const blockingFlag: VerificationFlag = {
  id: 'flag-1',
  type: 'conflict',
  severity: 'blocking',
  message: 'Tài liệu dùng hai tên nút khác nhau.',
  questionForAdmin: 'Tên nào đang được sử dụng?',
  location: { moduleId: 'module-1' },
  evidence: [{
    kind: 'document',
    sourceId: 'source-1',
    sectionId: 'section-1',
    quote: 'Gửi duyệt',
  }],
  status: 'open',
};

const publishReview: AdminTemplateDetail = {
  id: 'template-normal',
  version: 1,
  source: 'ai_generated',
  status: 'draft',
  employeeType: 'normal',
  title: 'Template 1 nhân sự thường',
  description: 'Tài liệu onboarding',
  modules: [
    { id: 'module-a', key: 'a', title: 'Module A', description: 'A', order: 1, resources: [], questions: [] },
    { id: 'module-b', key: 'b', title: 'Module B', description: 'B', order: 2, resources: [], questions: [] },
  ],
  locked: false,
  maxAttempts: 2,
  flags: [],
  updatedAt: 'draft-at',
};
describe('Admin AI template UI model', () => {
  it('resumes Both from server checkpoints after a second-template PDF failure without duplicate artifacts', async () => {
    const actor = { roomId: 'room-a', userId: 'admin-1', access: 'admin' as const };
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const templates = createTemplateService(store);
    const reviews = createAiReviewService(store, templates);
    const targets: AiPublishTarget[] = [];
    for (const kind of ['normal', 'advanced'] as const) {
      const job = approvedModuleJob(kind);
      await store.create(actor.roomId, 'onboarding_ai_jobs', { ...job });
      const review = await materializeModuleTemplate(store, templates, actor, job.jobId);
      targets.push({ kind, review, jsonExported: false, phase: 'idle' });
    }
    const uploaded: string[] = [];
    let fail = true;
    const makeDependencies = (withSettings = true) => createAiPublishDependencies({
      roomId: actor.roomId,
      ...(withSettings ? { settingsByKind: { advanced: { passingScore: 85, maxAttemptsPerModule: 4, learningMode: 'free' as const } } } : {}),
      app: { uploadFile: async (file: { fileName: string }) => {
        if (file.fileName === 'advanced-1.pdf' && fail) throw new Error('Upload disconnected');
        uploaded.push(file.fileName); return { fileId: file.fileName };
      } } as never,
      api: {
        adminAi: async (action: string, args: Record<string, unknown>) => ({ review: action === 'get_review'
          ? await reviews.getReview(actor, String(args.templateId), Number(args.version))
          : await reviews.updateReview(actor, args as unknown as UpdateAiReviewInput) }),
        adminTemplates: async (_action: string, args: Record<string, unknown>) => ({ template: await templates.publish(actor, String(args.templateId), Number(args.version), String(args.expectedUpdatedAt)) }),
      } as never,
      ensureTemplateFolder: async () => ({ rootId: 'root', documentsId: 'documents', templatesId: 'templates', templateFolderId: 'folder' }),
      createLessonPdf: async (review, _id, index) => ({ fileName: `${review.employeeType}-${index}.pdf`, mimeType: 'application/pdf', blob: new Blob(['pdf']) }),
      encodeBlob: async () => ({ dataUrl: 'data:application/pdf;base64,YQ==', base64: 'YQ==' }),
    });
    await expect(publishAiTemplateBatch(targets, makeDependencies())).rejects.toBeInstanceOf(AiPublishBatchError);
    expect((await templates.getAdminDetail(actor, targets[0].review.id, 1)).status).toBe('published');
    expect((await templates.getAdminDetail(actor, targets[1].review.id, 1)).passingScore).toBe(85);
    // Simulate a fresh modal with no in-memory or browser checkpoint state.
    fail = false;
    const completed = await publishAiTemplateBatch(targets, makeDependencies(false));
    expect(completed.every((target) => target.phase === 'completed')).toBe(true);
    expect(uploaded).toHaveLength(11); // 4 + 5 PDFs and two JSON files.
    expect(new Set(uploaded).size).toBe(11);
    expect(await store.count(actor.roomId, 'onboarding_templates')).toBe(2);
    expect(await store.count(actor.roomId, 'onboarding_resources')).toBe(9);
    expect((await templates.getAdminDetail(actor, targets[1].review.id, 1)).roleProfile).toEqual({ responsibilities: ['Process orders', 'Review orders'] });
  });
  it('derives an upload system name from the selected file when the field is blank', () => {
    expect(resolveUploadSystemName('', 'employee-handbook.docx')).toBe('employee handbook');
    expect(resolveUploadSystemName('  Payroll Portal  ', 'guide.pdf')).toBe('Payroll Portal');
  });

  it('models the five source-to-publish steps in the requested order', () => {
    expect(AI_GENERATOR_STEPS).toEqual([
      'Tài liệu nguồn', 'Phân tích', 'Tạo lộ trình', 'Rà soát', 'Xuất bản',
    ]);
    expect(aiGeneratorStepFor({ sourceCount: 0 })).toBe(0);
    expect(aiGeneratorStepFor({ sourceCount: 2, inventoryStatus: 'running' })).toBe(1);
    expect(aiGeneratorStepFor({ sourceCount: 2, inventoryStatus: 'completed' })).toBe(2);
    expect(aiGeneratorStepFor({
      sourceCount: 2, inventoryStatus: 'completed', templateStatus: 'running',
    })).toBe(2);
    expect(aiGeneratorStepFor({
      sourceCount: 2, inventoryStatus: 'completed', templateStatus: 'completed',
    })).toBe(3);
    expect(aiGeneratorStepFor({
      sourceCount: 2, inventoryStatus: 'completed', templateStatus: 'completed',
      reviewReady: true,
    })).toBe(4);
  });

  it('recovers the newest running AI job when iframe session storage is lost', () => {
    const inventory = {
      jobId: 'inventory-running',
      kind: 'inventory',
      status: 'running',
      createdAt: '2026-10-23T09:00:00.000Z',
    };
    const olderInventory = {
      jobId: 'inventory-old',
      kind: 'inventory',
      status: 'completed',
      createdAt: '2026-10-22T09:00:00.000Z',
    };

    expect(selectResumableAiJobs({
      jobs: [inventory, olderInventory] as never,
      inventoryJobId: null,
      templateJobId: null,
    })).toEqual({ inventory, template: undefined });
  });

  it('recovers the newest failed AI job so Admin can retry after a refresh', () => {
    const failed = {
      jobId: 'inventory-failed',
      kind: 'inventory',
      status: 'failed',
      createdAt: '2026-10-23T10:00:00.000Z',
    };

    expect(selectResumableAiJobs({
      jobs: [failed] as never,
      inventoryJobId: null,
      templateJobId: null,
    })).toEqual({ inventory: failed, template: undefined });
  });

  it('labels resumable template jobs clearly', () => {
    expect(templateJobActionText('running')).toBe('Tiếp tục tạo');
    expect(templateJobActionText('failed')).toBe('Thử lại');
    expect(templateJobActionText(undefined)).toBe('Tạo lộ trình');
  });

  it('aborts local polling, cancels the server job, confirms each attempt, and reports it', async () => {
    const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
    const order: string[] = [];
    const cancelled = {
      jobId: 'job-1',
      status: 'cancelled',
      calls: [
        { callId: 'A1', status: 'completed', attemptRef: 'native-chat:s:old' },
        {
          callId: 'A1-retry1', status: 'dispatched', attemptRef: 'native-chat:s:m',
          provider: 'native_chat', cleanupState: 'pending',
        },
      ],
    };
    const reconciled = { ...cancelled, updatedAt: 'later' };

    const result = await cancelRunningAiJob({
      adminAi: async (action: string, args: Record<string, unknown>) => {
        calls.push({ action, args });
        order.push(action);
        return { job: action === 'cancel_job' ? cancelled : reconciled };
      },
    } as never, 'job-1', () => { order.push('abort'); }, async (call) => {
      order.push('confirm:' + call.attemptRef);
      return { state: 'confirmed', terminalState: 'cancelled' };
    });

    expect(order).toEqual(['abort', 'cancel_job', 'confirm:native-chat:s:m', 'record_attempt_cleanup']);
    expect(calls[1]).toEqual({
      action: 'record_attempt_cleanup',
      args: { jobId: 'job-1', callId: 'A1-retry1', attemptRef: 'native-chat:s:m', state: 'confirmed' },
    });
    expect(result).toEqual({ job: reconciled, unconfirmed: 0 });
  });

  it('returns the cancelled server job and counts attempts PrivOS did not confirm', async () => {
    const cancelled = {
      jobId: 'job-1',
      status: 'cancelled',
      calls: [{ callId: 'A1', status: 'dispatched', attemptRef: 'attempt-1', cleanupState: 'pending' }],
    };
    const reported: unknown[] = [];

    const result = await cancelRunningAiJob({
      adminAi: async (action: string, args: Record<string, unknown>) => {
        if (action === 'record_attempt_cleanup') reported.push(args);
        return { job: cancelled };
      },
    } as never, 'job-1', () => undefined, async () => ({ state: 'unknown', message: 'Chưa xác nhận' }));

    expect(result).toEqual({ job: cancelled, unconfirmed: 1 });
    expect(reported).toEqual([{
      jobId: 'job-1', callId: 'A1', attemptRef: 'attempt-1', state: 'unknown', message: 'Chưa xác nhận',
    }]);
  });

  it('explicitly cancels timed-out provider attempts as well as dispatched calls', async () => {
    const call = { callId: 'A1', status: 'failed', attemptRef: 'attempt-timeout', cleanupState: 'pending' };
    const cancelled = { jobId: 'job-1', status: 'cancelled', calls: [call] };
    const confirm = vi.fn(async () => ({ state: 'confirmed', terminalState: 'cancelled' }));
    const api = { adminAi: vi.fn(async () => ({ job: cancelled })) };
    await cancelRunningAiJob(api as never, 'job-1', () => undefined, confirm as never);
    expect(confirm).toHaveBeenCalledWith(call);
    expect(api.adminAi).toHaveBeenCalledWith('record_attempt_cleanup', expect.objectContaining({ attemptRef: 'attempt-timeout', state: 'confirmed' }));
  });

  it('reports an unconfirmed cancellation when a dispatch claim has no provider reference yet', async () => {
    const job = { jobId: 'job-1', status: 'cancelled', calls: [{ callId: 'A1', status: 'pending', dispatchClaimedAt: '2026-10-28T00:00:00.000Z', cleanupState: 'pending' }] };
    const api = { adminAi: vi.fn(async () => ({ job })) };
    const confirm = vi.fn();
    const result = await cancelRunningAiJob(api as never, 'job-1', () => undefined, confirm);
    expect(result.unconfirmed).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.adminAi).toHaveBeenCalledTimes(1);
  });

  it('selects only the current user\'s unconfirmed Native attempts as blocking', () => {
    const jobs = [
      {
        jobId: 'job-own', status: 'cancelled', createdBy: 'admin-1',
        calls: [
          { callId: 'A1', status: 'dispatched', attemptRef: 'native-chat:s:1', provider: 'native_chat', cleanupState: 'unknown' },
          { callId: 'A2', status: 'dispatched', attemptRef: 'attempt-2', provider: 'sandbox', cleanupState: 'unknown' },
        ],
      },
      {
        jobId: 'job-other', status: 'cancelled', createdBy: 'admin-2',
        calls: [{ callId: 'A1', status: 'dispatched', attemptRef: 'native-chat:s:9', cleanupState: 'unknown' }],
      },
      {
        jobId: 'job-confirmed', status: 'cancelled', createdBy: 'admin-1',
        calls: [{ callId: 'A1', status: 'dispatched', attemptRef: 'native-chat:s:3', cleanupState: 'confirmed' }],
      },
    ];

    expect(selectBlockingNativeCleanup(jobs as never, 'admin-1')).toMatchObject({
      jobId: 'job-own', call: { callId: 'A1', attemptRef: 'native-chat:s:1' },
    });
    expect(selectBlockingNativeCleanup(jobs.slice(1) as never, 'admin-1')).toBeUndefined();
  });

  it('lists the current user\'s attempts that still need reconciliation, including legacy cancelled ones', () => {
    const jobs = [
      {
        jobId: 'job-legacy', status: 'cancelled', createdBy: 'admin-1',
        calls: [{ callId: 'B-lessons', status: 'dispatched', attemptRef: 'native-chat:s:1' }],
      },
      {
        jobId: 'job-pending', status: 'cancelled', createdBy: 'admin-1',
        calls: [{ callId: 'A1', status: 'dispatched', attemptRef: 'attempt-2', provider: 'sandbox', cleanupState: 'pending' }],
      },
      {
        jobId: 'job-running', status: 'running', createdBy: 'admin-1',
        calls: [{ callId: 'A1', status: 'dispatched', attemptRef: 'native-chat:s:3' }],
      },
      {
        jobId: 'job-other', status: 'cancelled', createdBy: 'admin-2',
        calls: [{ callId: 'A1', status: 'dispatched', attemptRef: 'native-chat:s:4', cleanupState: 'pending' }],
      },
    ];

    expect(attemptsNeedingCleanup(jobs as never, 'admin-1').map((entry) => entry.jobId + '/' + entry.call.callId))
      .toEqual(['job-legacy/B-lessons', 'job-pending/A1']);
  });

  it('resumes only the current user\'s jobs so another admin\'s attempt is never adopted', () => {
    const own = { jobId: 'job-own', kind: 'inventory', status: 'failed', createdBy: 'admin-1', createdAt: '2026-10-23T08:00:00.000Z' };
    const other = { jobId: 'job-other', kind: 'inventory', status: 'running', createdBy: 'admin-2', createdAt: '2026-10-23T09:00:00.000Z' };

    expect(selectResumableAiJobs({
      jobs: [other, own] as never, inventoryJobId: 'job-other', templateJobId: null, userId: 'admin-1',
    })).toEqual({ inventory: own, template: undefined });
  });

  it('keeps timed-out attempts that may still run in the cleanup list', () => {
    const jobs = [{
      jobId: 'job-timeout', status: 'failed', createdBy: 'admin-1',
      calls: [
        { callId: 'A1', status: 'failed', attemptRef: 'native-chat:s:1', provider: 'native_chat', cleanupState: 'pending' },
        { callId: 'A1-retry1', status: 'failed', attemptRef: 'native-chat:s:2' },
      ],
    }];

    expect(attemptsNeedingCleanup(jobs as never, 'admin-1').map((entry) => entry.call.callId)).toEqual(['A1']);
    expect(selectBlockingNativeCleanup(jobs as never, 'admin-1')?.call.callId).toBe('A1');
  });

  it('reconciles pending attempts without letting one failure stop the rest', async () => {
    const reported: string[] = [];
    const jobs = [{
      jobId: 'job-1', status: 'cancelled', createdBy: 'admin-1',
      calls: [
        { callId: 'A1', status: 'dispatched', attemptRef: 'native-chat:s:1', cleanupState: 'pending' },
        { callId: 'A2', status: 'dispatched', attemptRef: 'native-chat:s:2', cleanupState: 'unknown' },
      ],
    }];

    const updated = await reconcileAttemptCleanups({
      adminAi: async (_action: string, args: Record<string, unknown>) => {
        reported.push(String(args.callId) + ':' + String(args.state));
        return { job: { ...jobs[0], updatedAt: String(args.callId) } };
      },
    } as never, jobs as never, 'admin-1', async (call) => {
      if (call.callId === 'A1') throw new Error('bridge offline');
      return { state: 'confirmed', terminalState: 'cancelled' };
    });

    expect(reported).toEqual(['A2:confirmed']);
    expect(updated.map((job) => job.updatedAt)).toEqual(['A2']);
  });

  it('routes provider failures and resumed native attempts through the fallback gateway', () => {
    expect(aiJobPrefersNative({
      status: 'failed',
      errorCode: 'AI_FAILED',
      calls: [],
    })).toBe(true);
    expect(aiJobPrefersNative({
      status: 'running',
      calls: [{ attemptRef: 'native-chat:session-1:message-1' }],
    })).toBe(true);
    expect(aiJobPrefersNative({
      status: 'cancelled',
      calls: [{ attemptRef: 'native-chat:session-1:message-1' }],
    })).toBe(false);
    expect(aiJobPrefersNative({
      status: 'failed',
      errorCode: 'AI_OUTPUT_INVALID',
      calls: [],
    })).toBe(false);
  });

  it('keeps AI jobs usable when sandboxed iframes deny session storage', () => {
    expect(readAiResumeKey('inventory')).toBeNull();
    expect(() => writeAiResumeKey('inventory', 'job-1')).not.toThrow();
    expect(() => clearAiResumeKeys(['inventory', 'template'])).not.toThrow();
  });

  it('accepts only bounded PDF, DOCX, Markdown, text, and HTML sources', () => {
    expect(acceptedSourceTypes).toContain('.pdf');
    expect(validateSourceFile({ name: 'guide.pdf', size: 2 * 1024 * 1024 })).toBeNull();
    expect(validateSourceFile({ name: 'guide.exe', size: 100 })).toContain('PDF');
    expect(validateSourceFile({ name: 'guide.md', size: 2 * 1024 * 1024 + 1 })).toContain('2 MB');
  });

  it('prepares one lesson PDF per module and exports JSON into the same template folder', async () => {
    const uploadFile = vi.fn(async (input: { readonly fileName: string }) => ({
      file: { _id: `canonical-${input.fileName}`, name: input.fileName },
    }));
    const ensureTemplateFolder = vi.fn(async () => ({
      rootId: 'root', documentsId: 'documents', templatesId: 'templates', templateFolderId: 'template-folder',
    }));
    const createLessonPdf = vi.fn(async (
      _review: AdminTemplateDetail,
      _moduleId: string,
      moduleIndex: number,
    ) => ({
      fileName: `0${moduleIndex + 1}-lesson.pdf`,
      mimeType: 'application/pdf' as const,
      blob: new Blob([`lesson-${moduleIndex}`], { type: 'application/pdf' }),
    }));
    const adminAi = vi.fn(async (_action: string, args: Record<string, unknown>) => ({
      review: { ...publishReview, updatedAt: 'prepared-at', capturedOps: args.ops },
    }));
    const adminTemplates = vi.fn(async () => ({
      template: { ...publishReview, status: 'published', updatedAt: 'published-at' },
    }));
    const progress: string[] = [];
    const dependencies = createAiPublishDependencies({
      app: { uploadFile } as never,
      api: { adminAi, adminTemplates } as never,
      roomId: 'room-1',
      settingsByKind: {
        normal: { passingScore: 80, maxAttemptsPerModule: 3, learningMode: 'sequential' },
      },
      ensureTemplateFolder,
      createLessonPdf,
      encodeBlob: async (blob) => ({ dataUrl: `data:${blob.type};base64,dGVzdA==`, base64: 'dGVzdA==' }),
      onProgress: (event) => progress.push(`${event.kind}:${event.stage}:${event.moduleTitle ?? ''}`),
    });
    const target = {
      kind: 'normal' as const,
      review: publishReview,
      jsonExported: false,
      phase: 'idle' as const,
    };

    const prepared = await dependencies.prepareResources(target);

    expect(ensureTemplateFolder).toHaveBeenCalledWith(
      expect.anything(), 'room-1', 'Template 1 nhân sự thường',
    );
    expect(createLessonPdf.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['module-a', 0], ['module-b', 1],
    ]);
    const pdfUploads = uploadFile.mock.calls.map((call) => call[0]).filter((input) =>
      input.fileName.endsWith('.pdf'));
    expect(pdfUploads).toHaveLength(2);
    expect(pdfUploads.every((input) => input.folderId === 'template-folder'
      && input.duplicateAction === 'replace')).toBe(true);
    const updateArgs = adminAi.mock.calls.at(-1)![1] as { readonly ops: readonly Record<string, unknown>[] };
    const resourceOps = updateArgs.ops.filter((operation) => operation.kind === 'upsert_generated_resource');
    expect(resourceOps).toHaveLength(2);
    expect(resourceOps.map((operation) => operation.resource)).toEqual([
      expect.objectContaining({ id: lessonPdfResourceId('module-a'), fileId: 'canonical-01-lesson.pdf' }),
      expect.objectContaining({ id: lessonPdfResourceId('module-b'), fileId: 'canonical-02-lesson.pdf' }),
    ]);
    expect(prepared.updatedAt).toBe('prepared-at');

    await dependencies.exportJson({ ...publishReview, status: 'published', updatedAt: 'published-at' });
    expect(uploadFile.mock.calls.at(-1)?.[0]).toMatchObject({
      folderId: 'template-folder', mimeType: 'application/json', duplicateAction: 'replace',
    });
    expect(progress).toContain('normal:creating_pdf:Module A');
    expect(progress).toContain('normal:uploading_pdf:Module B');
    expect(progress).toContain('normal:exporting_json:');
  });

  it('reports the template and module when lesson-file preparation fails', async () => {
    const errorProgress: string[] = [];
    const dependencies = createAiPublishDependencies({
      app: { uploadFile: vi.fn(async (upload: { readonly fileName: string }) => ({
        file: { _id: `file-${upload.fileName}`, name: upload.fileName },
      })) } as never,
      api: { adminAi: vi.fn(async () => ({ review: publishReview })), adminTemplates: vi.fn() } as never,
      roomId: 'room-1',
      ensureTemplateFolder: async () => ({
        rootId: 'root', documentsId: 'documents', templatesId: 'templates', templateFolderId: 'folder',
      }),
      createLessonPdf: async (_review, moduleId) => {
        if (moduleId === 'module-b') throw new Error('Roboto failed');
        return {
          fileName: '01-a.pdf', mimeType: 'application/pdf',
          blob: new Blob(['a'], { type: 'application/pdf' }),
        };
      },
      encodeBlob: async () => ({ dataUrl: 'data:application/pdf;base64,YQ==', base64: 'YQ==' }),
      onProgress: (event) => {
        if (event.error) errorProgress.push(`${event.stage}:${event.moduleTitle}:${event.error}`);
      },
    });

    await expect(dependencies.prepareResources({
      kind: 'normal', review: publishReview, jsonExported: false, phase: 'idle',
    })).rejects.toThrow('Template 1 nhân sự thường · Module B: Roboto failed');
    expect(errorProgress).toEqual([
      'creating_pdf:Module B:Template 1 nhân sự thường · Module B: Roboto failed',
    ]);
  });
  it('refreshes and closes the modal only after every publish target completes', () => {
    const calls: string[] = [];
    const complete = [
      { kind: 'normal' as const, review: publishReview, preparedReview: publishReview, publishedTemplate: { ...publishReview, status: 'published' as const }, jsonExported: true, phase: 'completed' as const },
      { kind: 'advanced' as const, review: { ...publishReview, employeeType: 'advanced' as const }, preparedReview: publishReview, publishedTemplate: { ...publishReview, status: 'published' as const }, jsonExported: true, phase: 'completed' as const },
    ];
    const callbacks = {
      clearResume: () => calls.push('clear'),
      onComplete: () => calls.push('refresh'),
      onClose: () => calls.push('close'),
    };

    expect(finishSuccessfulAiPublish(
      complete.map((target, index) => index === 1 ? { ...target, phase: 'failed' as const } : target),
      callbacks,
    )).toBe(false);
    expect(calls).toEqual([]);
    expect(finishSuccessfulAiPublish(complete.map((target) => ({ ...target, jsonExported: false })), callbacks)).toBe(false);
    expect(finishSuccessfulAiPublish(complete.map((target) => ({ ...target, publishedTemplate: undefined })), callbacks)).toBe(false);

    expect(finishSuccessfulAiPublish(complete, callbacks)).toBe(true);
    expect(calls).toEqual(['clear', 'refresh', 'close']);
  });
  it('reports completed AI calls and blocks publishing while blocking flags are open', () => {
    expect(aiJobProgress({
      calls: [
        { callId: 'A1', status: 'completed', stage: 'A' },
        { callId: 'A2', status: 'pending', stage: 'A' },
      ],
    })).toEqual({ completed: 1, total: 2, percent: 50 });
    expect(canPublishAiReview([blockingFlag])).toEqual({
      allowed: false,
      blockingCount: 1,
    });
    expect(canPublishAiReview([{ ...blockingFlag, status: 'resolved' }])).toEqual({
      allowed: true,
      blockingCount: 0,
    });
  });

  it('counts each planned step once instead of every failed, retried, or repaired attempt', () => {
    expect(aiJobProgress({
      calls: [
        { callId: 'A1', status: 'failed', stage: 'A' },
        { callId: 'A1-retry1', status: 'failed', stage: 'A' },
        { callId: 'A1-retry2', status: 'dispatched', stage: 'A' },
      ],
    })).toEqual({ completed: 0, total: 1, percent: 0 });
    expect(aiJobProgress({
      calls: [
        { callId: 'B-lessons', status: 'invalid', stage: 'B' },
        { callId: 'B-lessons-r1', status: 'completed', stage: 'B' },
        { callId: 'B-questions', status: 'completed', stage: 'B' },
        { callId: 'D1', status: 'completed', stage: 'D' },
        { callId: 'D2', status: 'pending', stage: 'D' },
      ],
    })).toEqual({ completed: 3, total: 4, percent: 75 });
  });

  it('names AI steps in words with batch, repair, and retry context', () => {
    const calls = [
      { callId: 'A1' }, { callId: 'A2' },
      { callId: 'D1' }, { callId: 'D2' }, { callId: 'D3' },
    ];

    expect(aiCallDisplayLabel({ callId: 'A2' }, calls)).toBe('Phân tích tài liệu (lô 2/2)');
    expect(aiCallDisplayLabel({ callId: 'B-lessons-r1' }, calls)).toBe('Tạo bài học (tự sửa lần 1/2)');
    expect(aiCallDisplayLabel({ callId: 'C-questions-retry2' }, calls)).toBe('Tạo câu hỏi (thử lại lần 2)');
    expect(aiCallDisplayLabel({ callId: 'D2' }, calls)).toBe('Kiểm chứng nội dung (lô 2/3)');
    expect(aiJobStatusText({
      status: 'running',
      calls: [{ callId: 'B-lessons', status: 'invalid' }, { callId: 'B-lessons-r1', status: 'dispatched' }],
    })).toBe('Đang xử lý: Tạo bài học (tự sửa lần 1/2)');
  });

  it('shows the provider and elapsed time of the running call', () => {
    expect(aiCallRuntimeText({
      status: 'dispatched', provider: 'native_chat', startedAt: '2026-10-24T05:00:00.000Z',
    }, Date.parse('2026-10-24T05:03:20.000Z'))).toBe('Native AI Chat · 3 phút 20 giây');
    expect(aiCallRuntimeText({
      status: 'dispatched', attemptRef: 'sandbox-attempt-1', startedAt: '2026-10-24T05:00:00.000Z',
    }, Date.parse('2026-10-24T05:00:42.000Z'))).toBe('Sandbox · 42 giây');
    expect(aiCallRuntimeText({ status: 'pending' }, 0)).toBeNull();
  });

  it('labels cancelled jobs as cancelled instead of completed', () => {
    expect(aiJobStatusText({
      status: 'cancelled',
      calls: [{ callId: 'D7', status: 'pending' }],
    })).toBe('Đã hủy');
  });

  it('shows the active verification batch instead of the last queued batch', () => {
    const calls = [
      { callId: 'D2', status: 'pending' },
      { callId: 'D3', status: 'pending' },
      { callId: 'D4', status: 'pending' },
    ];

    expect(aiJobCurrentCall({ status: 'running', calls })?.callId).toBe('D2');
    expect(aiJobCurrentCall({
      status: 'failed',
      calls: [
        { callId: 'D2', status: 'failed' },
        { callId: 'D3', status: 'pending' },
        { callId: 'D4', status: 'pending' },
      ],
    })?.callId).toBe('D2');
  });

  it('exposes the latest validation details for a failed AI job', () => {
    expect(aiJobErrorText({
      status: 'failed',
      errorCode: 'AI_OUTPUT_INVALID',
      calls: [
        { status: 'invalid', errors: ['modules.0.questions: expected 3-5 questions'] },
      ],
    })).toContain('modules.0.questions: expected 3-5 questions');
  });

  it('explains PrivOS agent configuration failures in Vietnamese', () => {
    const credentials = aiJobErrorText({
      status: 'failed',
      errorCode: 'AI_FAILED',
      errorMessage: "The AI provider rejected this agent's credentials. Ask your workspace admin to check the model provider key in the agent's settings.",
      calls: [],
    });
    const stopped = aiJobErrorText({
      status: 'failed',
      errorCode: 'AI_FAILED',
      errorMessage: 'The agent stopped unexpectedly before finishing. Please try again; if this keeps happening, ask your workspace admin to check the agent.',
      calls: [],
    });

    expect(credentials).toContain('khóa nhà cung cấp model');
    expect(credentials).toContain('Admin workspace');
    expect(stopped).toContain('Agent AI của PrivOS dừng đột ngột');
  });

  it('turns provider credential failures into an actionable Vietnamese notice', () => {
    expect(generationErrorMessage(new Error(
      'The model provider rejected the configured credentials.',
    ))).toContain('Admin workspace');
  });

  it('identifies a crashed PrivOS Sandbox worker and gives the repair or fallback action', () => {
    const message = generationErrorMessage(new Error('Worker exited with code 1'));

    expect(message).toContain('Worker Sandbox của PrivOS');
    expect(message).toContain('worker_failed');
    expect(message).toContain('repair/restart Sandbox');
    expect(message).toContain('Native AI Chat');
    const differentExit = generationErrorMessage(new Error('Worker exited with code 137'));
    expect(differentExit).toContain('exit code 137');
    expect(differentExit).not.toContain('(worker_failed, exit code 1).');
  });

  it('maps machine error codes to actionable Vietnamese messages', () => {
    expect(generationErrorMessage({ code: 'SOURCE_TOO_LARGE' })).toContain('2 MB');
    expect(generationErrorMessage({ code: 'ROLE_PROFILE_INVALID' }).toLowerCase()).toContain('hồ sơ vai trò');
    expect(generationErrorMessage({ code: 'AI_DISPATCH_UNKNOWN' })).toContain('Thử lại');
  });

  it('renders blocking flags first with explicit resolution actions', () => {
    const markup = renderToStaticMarkup(createElement(FlagPanel as unknown as (
      props: {
        flags: readonly VerificationFlag[];
        busy: boolean;
        onResolve: () => void;
      },
    ) => ReactNode, {
      flags: [
        { ...blockingFlag, id: 'warning-1', severity: 'warning', type: 'ambiguous' },
        blockingFlag,
      ],
      busy: false,
      onResolve: () => undefined,
    }));

    expect(markup.indexOf('Cần xử lý')).toBeLessThan(markup.indexOf('Cảnh báo'));
    expect(markup).toContain('Chọn phương án');
    expect(markup).toContain('Thêm ghi chú');
    expect(markup).toContain('Loại bỏ nội dung');
  });

  it('labels AI-generated templates and never offers manual system cloning', () => {
    const item = {
      id: 'ai-template',
      version: 1,
      source: 'ai_generated' as const,
      status: 'draft' as const,
      employeeType: 'normal' as const,
      title: 'PrivOS cơ bản',
      description: 'Sinh từ tài liệu',
      locked: false,
      updatedAt: '2026-10-23T00:00:00.000Z',
    };
    const markup = renderToStaticMarkup(createElement(TemplateCard, {
      item,
      onOpen: () => undefined,
    }));

    expect(markup).toContain('AI tạo');
    expect(templateDetailActions(item)).toEqual(['edit', 'delete']);
    expect(templateDetailActions({ ...item, source: 'system', status: 'published' })).toEqual(['use']);
  });
});

function milestoneJob(input: {
  kind: AiJobRecord['kind'];
  status: AiJobRecord['status'];
  calls?: readonly AiCallRecord[];
}): AiJobRecord {
  return {
    id: 'row-1',
    roomId: 'room-1',
    jobId: 'job-1',
    kind: input.kind,
    status: input.status,
    promptVersion: 'v1',
    calls: input.calls ?? [],
    stageOutputs: {},
    operationId: 'operation-1',
    createdBy: 'admin-1',
    createdAt: '2026-10-26T09:00:00.000Z',
    updatedAt: '2026-10-26T09:00:00.000Z',
  };
}

function milestoneCall(
  callId: string,
  status: AiCallRecord['status'],
  overrides: Partial<AiCallRecord> = {},
): AiCallRecord {
  return {
    callId,
    stage: callId.startsWith('A') ? 'A'
      : callId.startsWith('D') ? 'D'
        : callId.startsWith('C') ? 'C' : 'B',
    operationId: `job-1:${callId}`,
    status,
    ...overrides,
  };
}

function milestoneStatuses(milestones: ReturnType<typeof templateMilestones>): readonly string[] {
  return milestones.map((milestone) => milestone.status);
}

describe('AI job milestones', () => {
  it('maps inventory preparation, batches, repair, failure, and completion to stable milestones', () => {
    expect(inventoryMilestones(null, 2).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'prepare', status: 'completed' },
      { id: 'analysis', status: 'active' },
      { id: 'merge', status: 'pending' },
      { id: 'ready', status: 'pending' },
    ]);

    const firstBatch = milestoneJob({
      kind: 'inventory',
      status: 'running',
      calls: [milestoneCall('A1', 'dispatched'), milestoneCall('A2', 'pending')],
    });
    expect(milestoneStatuses(inventoryMilestones(firstBatch, 2))).toEqual([
      'completed', 'active', 'pending', 'pending',
    ]);

    const oneOfTwo = milestoneJob({
      kind: 'inventory',
      status: 'running',
      calls: [milestoneCall('A1', 'completed'), milestoneCall('A2', 'dispatched')],
    });
    expect(milestoneStatuses(inventoryMilestones(oneOfTwo, 2))).toEqual([
      'completed', 'active', 'pending', 'pending',
    ]);

    const repairing = milestoneJob({
      kind: 'inventory',
      status: 'running',
      calls: [milestoneCall('A1', 'invalid'), milestoneCall('A1-r1', 'dispatched')],
    });
    expect(inventoryMilestones(repairing, 2)[1]).toMatchObject({
      status: 'active',
      detail: 'Phân tích tài liệu (lô 1/1) (tự sửa lần 1/2)',
    });
    expect(inventoryMilestones(repairing, 2).filter((item) => item.detail)).toHaveLength(1);

    const failed = milestoneJob({
      kind: 'inventory',
      status: 'failed',
      calls: [milestoneCall('A1', 'failed')],
    });
    expect(inventoryMilestones(failed, 2)[1]).toMatchObject({
      status: 'failed',
      detail: 'Phân tích tài liệu (lô 1/1)',
    });

    expect(milestoneStatuses(inventoryMilestones(milestoneJob({
      kind: 'inventory', status: 'completed', calls: [milestoneCall('A1', 'completed')],
    }), 2))).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  it.each(['B', 'C'] as const)('maps %s lesson and question calls to the same fixed template stages', (prefix) => {
    expect(milestoneStatuses(templateMilestones(null))).toEqual([
      'active', 'pending', 'pending', 'pending', 'pending',
    ]);

    const lessons = milestoneJob({
      kind: 'template', status: 'running', calls: [milestoneCall(`${prefix}-lessons`, 'dispatched')],
    });
    expect(milestoneStatuses(templateMilestones(lessons))).toEqual([
      'completed', 'active', 'pending', 'pending', 'pending',
    ]);

    const questions = milestoneJob({
      kind: 'template',
      status: 'running',
      calls: [
        milestoneCall(`${prefix}-lessons`, 'completed'),
        milestoneCall(`${prefix}-questions`, 'dispatched'),
      ],
    });
    expect(milestoneStatuses(templateMilestones(questions))).toEqual([
      'completed', 'completed', 'active', 'pending', 'pending',
    ]);
  });

  it('keeps five template milestone IDs while verification and repair calls are added', () => {
    const baseCalls = [
      milestoneCall('B-lessons', 'completed'),
      milestoneCall('B-questions', 'completed'),
    ];
    const beforeVerification = templateMilestones(milestoneJob({
      kind: 'template', status: 'running', calls: baseCalls,
    }));
    const duringVerification = templateMilestones(milestoneJob({
      kind: 'template', status: 'running', calls: [...baseCalls, milestoneCall('D1', 'dispatched')],
    }));
    const duringRepair = templateMilestones(milestoneJob({
      kind: 'template',
      status: 'running',
      calls: [
        ...baseCalls,
        milestoneCall('D1', 'invalid'),
        milestoneCall('D1-r1', 'dispatched'),
      ],
    }));

    const ids = ['prepare', 'lessons', 'questions', 'verification', 'draft'];
    expect(beforeVerification.map((item) => item.id)).toEqual(ids);
    expect(duringVerification.map((item) => item.id)).toEqual(ids);
    expect(duringRepair.map((item) => item.id)).toEqual(ids);
    expect(duringVerification.filter((item) => item.status === 'completed').length)
      .toBeGreaterThanOrEqual(beforeVerification.filter((item) => item.status === 'completed').length);
    expect(duringRepair.filter((item) => item.status === 'completed').length)
      .toBeGreaterThanOrEqual(duringVerification.filter((item) => item.status === 'completed').length);
    expect(duringRepair[3]).toMatchObject({
      status: 'active',
      detail: 'Kiểm chứng nội dung (lô 1/1) (tự sửa lần 1/2)',
    });
    expect(duringRepair.filter((item) => item.detail)).toHaveLength(1);
  });

  it('maps retry failure and completed jobs without regressing earlier stages', () => {
    const failed = templateMilestones(milestoneJob({
      kind: 'template',
      status: 'failed',
      calls: [
        milestoneCall('C-lessons', 'completed'),
        milestoneCall('C-questions', 'failed'),
        milestoneCall('C-questions-retry1', 'failed'),
      ],
    }));
    expect(milestoneStatuses(failed)).toEqual([
      'completed', 'completed', 'failed', 'pending', 'pending',
    ]);
    expect(failed[2].detail).toBe('Tạo câu hỏi (thử lại lần 1)');
    expect(failed.filter((item) => item.detail)).toHaveLength(1);

    expect(milestoneStatuses(templateMilestones(milestoneJob({
      kind: 'template', status: 'completed', calls: [],
    })))).toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
  });

  it('renders a semantic ordered milestone list with current provider runtime', () => {
    const job = milestoneJob({
      kind: 'template',
      status: 'running',
      calls: [milestoneCall('B-lessons', 'dispatched', {
        provider: 'native_chat',
        startedAt: '2026-10-26T09:00:00.000Z',
      })],
    });
    const milestones = templateMilestones(job);
    const html = renderToStaticMarkup(createElement(AiMilestoneProgress, {
      label: 'Tạo lộ trình onboarding',
      job,
      milestones,
    }));

    expect(html).toContain('<ol');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('data-status="active"');
    expect(html).toContain('Native AI Chat');
  });

  it('renders an open technical failure log with provider and attempt diagnostics', () => {
    const job = milestoneJob({
      kind: 'template',
      status: 'failed',
      calls: [milestoneCall('B-lessons', 'failed', {
        provider: 'sandbox',
        attemptRef: 'agent-attempt-123',
        providerErrorCode: 'MODEL_PROVIDER_CREDENTIALS_REJECTED',
        providerPhase: 'model-call',
        errors: ['The model provider rejected the configured credentials.'],
        finishedAt: '2026-10-27T09:15:00.000Z',
      })],
    });
    const html = renderToStaticMarkup(createElement(AiMilestoneProgress, {
      label: 'Tạo lộ trình onboarding',
      job,
      milestones: templateMilestones(job),
    }));

    expect(html).toContain('<details class="ai-failure-log" open="">');
    expect(html).toContain('Chi tiết lỗi kỹ thuật');
    expect(html).toContain('job-1');
    expect(html).toContain('Tạo bài học');
    expect(html).toContain('<code>B-lessons</code>');
    expect(html).toContain('Sandbox');
    expect(html).toContain('agent-attempt-123');
    expect(html).toContain('MODEL_PROVIDER_CREDENTIALS_REJECTED');
    expect(html).toContain('model-call');
    expect(html).toContain('The model provider rejected the configured credentials.');
  });
});
describe('AI template request workspace', () => {
  const commonProps = {
    templateTitle: '',
    responsibilities: '',
    responsibilityCount: 0,
    onSelect: () => undefined,
    onTemplateTitleChange: () => undefined,
    onResponsibilitiesChange: () => undefined,
  };

  it('renders all three mandatory choices and explains a missing selection', () => {
    const html = renderToStaticMarkup(createElement(AiTemplateSelection, {
      ...commonProps,
      selection: null,
      errors: { selection: 'Chọn ít nhất một loại lộ trình.' },
    }));

    expect(html).toContain('Template 1');
    expect(html).toContain('Template 2');
    expect(html).toContain('Cả hai');
    expect(html).toContain('Chọn ít nhất một loại lộ trình.');
    expect(html).toContain('role="radiogroup"');
  });

  it('connects advanced role errors to invalid fields and displays the responsibility count', () => {
    const html = renderToStaticMarkup(createElement(AiTemplateSelection, {
      ...commonProps,
      selection: 'advanced',
      errors: {
        responsibilities: 'Nhập từ 2 đến 8 nhiệm vụ chính, mỗi nhiệm vụ một dòng.',
      },
    }));

    expect(html).toContain('aria-invalid="true"');
    expect(html).not.toContain('Phòng ban');
    expect(html).not.toContain('Tên phòng ban');
    expect(html).not.toContain('Chức danh');
    expect(html).toContain('<textarea');
    expect(html).toContain('aria-describedby="ai-responsibilities-error"');
    expect(html).toContain('0/8 nhiệm vụ hợp lệ');
  });
});
describe('AI compact review panes', () => {
  it('defaults to lesson content, exposes a question tab, and keeps blocking count visible', () => {
    const review = {
      id: 'template-1',
      version: 1,
      title: 'Hội nhập vận hành',
      employeeType: 'normal',
      modules: [{
        id: 'module-1',
        key: 'module-1',
        title: 'Quy trình đơn hàng',
        description: 'Nội dung quy trình',
        resources: [],
        questions: [{
          id: 'question-1',
          type: 'single_choice',
          prompt: 'Câu hỏi chỉ xuất hiện trong tab câu hỏi?',
          options: [{ id: 'a', label: 'Đáp án A' }, { id: 'b', label: 'Đáp án B' }],
          correctOptionIds: ['a'],
        }],
      }],
      content: {
        assessmentMode: 'per_module',
        learningMode: 'sequential',
        maxAttemptsPerModule: 2,
        modules: [{
          moduleId: 'module-1',
          frameKey: 'overview',
          objectives: ['Hiểu quy trình'],
          estimatedMinutes: 10,
          blocks: [{
            id: 'block-1',
            kind: 'concept',
            title: 'Tài liệu học mặc định',
            body: 'Nội dung bài học.',
            sourceRefs: [],
            pendingVerification: false,
          }],
        }],
        questionMeta: [],
      },
      flags: [blockingFlag],
      updatedAt: '2026-10-26T09:00:00.000Z',
    } as never;
    const html = renderToStaticMarkup(createElement(AiReview, {
      api: {} as never,
      review,
      busy: false,
      sequence: { index: 0, total: 2, kind: 'normal' },
      onUpdated: () => undefined,
      onResolve: () => undefined,
    }));

    expect(html).toContain('Template 1/2');
    expect(html).toContain('Tài liệu học');
    expect(html).toContain('Câu hỏi (1)');
    expect(html).toContain('Tài liệu học mặc định');
    expect(html).not.toContain('Câu hỏi chỉ xuất hiện trong tab câu hỏi?');
    expect(html).toContain('1 cờ bắt buộc');
    expect(html).toContain('aria-expanded="true"');
  });
});
