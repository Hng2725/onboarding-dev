import { describe, expect, it } from 'vitest';

import type {
  AiCallRecord,
  AiJobRecord,
  ModuleAttemptRecord,
  ModuleProgressRecord,
  SourceRecord,
  TemplateContentRecord,
  TemplateSnapshot,
  VerificationFlag,
} from '../src/onboarding/contracts';

describe('AI onboarding domain contracts', () => {
  it('supports an immutable per-module template extension without changing legacy snapshots', () => {
    const legacy: TemplateSnapshot = {
      id: 'legacy', version: 1, source: 'custom', status: 'published',
      employeeType: 'normal', title: 'Legacy', description: '', modules: [],
    };
    const generated: TemplateSnapshot = {
      ...legacy,
      id: 'generated',
      content: {
        assessmentMode: 'per_module',
        learningMode: 'sequential',
        maxAttemptsPerModule: 3,
        modules: [{
          moduleId: 'module-1',
          frameKey: 't1-overview',
          objectives: ['Hiểu phạm vi hệ thống', 'Mở đúng room'],
          estimatedMinutes: 8,
          blocks: [{
            id: 'block-1',
            kind: 'concept',
            body: 'PrivOS tổ chức công việc theo room.',
            sourceRefs: [{
              kind: 'document', sourceId: 'source-1', sectionId: 'source-1#s1',
              quote: 'PrivOS tổ chức công việc theo room.',
            }],
            pendingVerification: false,
          }],
        }],
        questionMeta: [{
          questionId: 'question-1',
          level: 'recall',
          sourceRefs: [],
          blockIds: ['block-1'],
        }],
      },
    };

    expect(legacy.content).toBeUndefined();
    expect(generated.content?.assessmentMode).toBe('per_module');
  });

  it('represents sources, jobs, flags, content, progress, and attempts with stable IDs', () => {
    const source: SourceRecord = {
      id: 'row-source', roomId: 'room-a', sourceId: 'source-1', kind: 'document',
      fileId: 'file-1', fileName: 'guide.pdf', mimeType: 'application/pdf',
      checksum: 'sha256', systemName: 'PrivOS', status: 'ready',
      sections: [{ id: 'source-1#s1', headingPath: ['Tổng quan'], page: 1, text: 'Nội dung' }],
      textLength: 8, createdBy: 'admin-1', createdAt: '2026-10-23T00:00:00Z',
      updatedAt: '2026-10-23T00:00:00Z',
    };
    const call: AiCallRecord = {
      callId: 'B-lessons', stage: 'B', operationId: 'job-1:B-lessons', status: 'pending',
    };
    const job: AiJobRecord = {
      id: 'row-job', roomId: 'room-a', jobId: 'job-1', kind: 'template', status: 'running',
      templateKind: 'normal', sourceIds: ['source-1'], promptVersion: 'v1',
      calls: [call], stageOutputs: {}, operationId: 'operation-1', createdBy: 'admin-1',
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    };
    const flag: VerificationFlag = {
      id: 'flag-1', type: 'missing', severity: 'blocking', message: 'Thiếu nguồn',
      questionForAdmin: 'Bổ sung nguồn?', location: { moduleId: 'module-1' },
      evidence: [], status: 'open',
    };
    const content: TemplateContentRecord = {
      id: 'row-content', roomId: 'room-a', templateId: 'template-1', templateVersion: 1,
      content: {
        assessmentMode: 'per_module', learningMode: 'sequential', maxAttemptsPerModule: 3,
        modules: [], questionMeta: [],
      },
      flags: [flag], sourceIds: ['source-1'], jobId: 'job-1', promptVersion: 'v1',
      generationNotes: [], createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    };
    const progress: ModuleProgressRecord = {
      id: 'row-progress', roomId: 'room-a', assignmentId: 'assignment-1',
      memberId: 'member-1', moduleId: 'module-1', attemptCount: 0, extraAttempts: 0,
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    };
    const attempt: ModuleAttemptRecord = {
      id: 'row-attempt', roomId: 'room-a', assignmentId: 'assignment-1',
      memberId: 'member-1', moduleId: 'module-1', ordinal: 1, status: 'started',
      questionOrder: ['question-1'], optionOrder: { 'question-1': ['a', 'b', 'c', 'd'] },
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    };

    expect({ source, job, content, progress, attempt }).toMatchObject({
      source: { sourceId: 'source-1' },
      job: { calls: [{ callId: 'B-lessons' }] },
      content: { flags: [{ severity: 'blocking' }] },
      progress: { attemptCount: 0 },
      attempt: { ordinal: 1 },
    });
  });
});
