import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { chooseContinueAssignment } from '../src/ui/onboarding/learner-dashboard';
import {
  buildSubmission,
  fileDownloadBlob,
  isExerciseUnlocked,
  nextSubmissionOperation,
  roomFileMetadata,
  resourceViewState,
  validateRequiredAnswers,
} from '../src/ui/onboarding/learning-workspace';
import { resultPresentation } from '../src/ui/onboarding/results';
import {
  loadRoomfilePreview,
  roomfilePreviewMode,
} from '../src/ui/onboarding/roomfile-preview';
import { InlineRoomfileContent } from '../src/ui/onboarding/inline-roomfile-viewer';

describe('Learner onboarding UI models', () => {
  it('loads a room-bound PDF through authenticated metadata and byte endpoints', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:lesson-pdf');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const rest = vi.fn(async (request: { readonly path: string }) => request.path.endsWith('/download')
      ? { statusCode: 200, body: new Blob(['%PDF-test'], { type: 'application/pdf' }) }
      : {
          statusCode: 200,
          body: { file: {
            _id: 'file-lesson', name: '01-bai-hoc.pdf', channel_id: 'room-a', mimeType: 'application/pdf',
          } },
        });

    const preview = await loadRoomfilePreview(
      { rest } as never,
      'room-a',
      { id: 'resource-1', title: 'Bài học', kind: 'file', required: true, fileId: 'file-lesson' },
    );

    expect(preview).toMatchObject({
      fileName: '01-bai-hoc.pdf', mimeType: 'application/pdf', blobUrl: 'blob:lesson-pdf',
    });
    expect(rest).toHaveBeenNthCalledWith(1, {
      method: 'GET', path: 'file-management.files/file-lesson',
    });
    expect(rest.mock.calls[1][0]).toMatchObject({
      method: 'GET', path: 'file-management.files/file-lesson/download', responseType: 'blob',
    });
    preview.revoke();
    preview.revoke();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it.each([
    ['wrong room', { statusCode: 200, body: { file: { _id: 'file-lesson', name: 'lesson.pdf', channel_id: 'room-b' } } }, 'không thuộc room'],
    ['wrong file', { statusCode: 200, body: { file: { _id: 'file-other', name: 'lesson.pdf', channel_id: 'room-a' } } }, 'không hợp lệ'],
    ['metadata HTTP error', { statusCode: 403, body: {} }, 'Không thể đọc file (403)'],
  ])('rejects %s metadata before downloading or rendering', async (_case, metadata, message) => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const rest = vi.fn(async () => metadata);

    await expect(loadRoomfilePreview(
      { rest } as never,
      'room-a',
      { id: 'resource-1', title: 'Bài học', kind: 'file', required: true, fileId: 'file-lesson' },
    )).rejects.toThrow(message);
    expect(rest).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    createObjectURL.mockRestore();
  });

  it('rejects missing bytes and download HTTP errors before creating a blob URL', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const metadata = {
      statusCode: 200,
      body: { file: { _id: 'file-lesson', name: 'lesson.pdf', channel_id: 'room-a', mimeType: 'application/pdf' } },
    };
    for (const download of [{ statusCode: 200, body: {} }, { statusCode: 500, body: {} }]) {
      const rest = vi.fn(async (request: { readonly path: string }) =>
        request.path.endsWith('/download') ? download : metadata);
      await expect(loadRoomfilePreview(
        { rest } as never,
        'room-a',
        { id: 'resource-1', title: 'Bài học', kind: 'file', required: true, fileId: 'file-lesson' },
      )).rejects.toThrow();
    }
    expect(createObjectURL).not.toHaveBeenCalled();
    createObjectURL.mockRestore();
  });

  it('revokes replaced preview URLs exactly once', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const rest = vi.fn(async (request: { readonly path: string }) => request.path.endsWith('/download')
      ? new Blob(['%PDF'], { type: 'application/pdf' })
      : { file: { _id: 'file-lesson', name: 'lesson.pdf', channel_id: 'room-a' } });
    const resource = {
      id: 'resource-1', title: 'Bài học', kind: 'file' as const, required: true, fileId: 'file-lesson',
    };

    const first = await loadRoomfilePreview({ rest } as never, 'room-a', resource);
    const second = await loadRoomfilePreview({ rest } as never, 'room-a', resource);
    first.revoke();
    first.revoke();
    second.revoke();

    expect(revokeObjectURL.mock.calls).toEqual([['blob:first'], ['blob:second']]);
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('embeds Roomfiles PDFs in-app and keeps non-PDF files in download mode', () => {
    const resource = {
      id: 'resource-1', title: 'Bài học', kind: 'file' as const, required: true, fileId: 'file-lesson',
    };
    expect(roomfilePreviewMode(resource, 'lesson.pdf', 'application/pdf')).toBe('embedded_pdf');
    expect(roomfilePreviewMode(resource, 'notes.txt', 'text/plain')).toBe('download');
    expect(roomfilePreviewMode({ ...resource, kind: 'link' }, 'lesson.pdf', 'application/pdf'))
      .toBe('download');

    const markup = renderToStaticMarkup(createElement(InlineRoomfileContent, {
      preview: {
        fileName: 'lesson.pdf', mimeType: 'application/pdf', blobUrl: 'blob:lesson', revoke: () => undefined,
      },
      resource,
    }));
    expect(markup).toContain('<iframe');
    expect(markup).toContain('Xem PDF Bài học');
    expect(markup).not.toContain('target="_blank"');
  });
  it('accepts Blob and legacy base64 responses from the authenticated file download bridge', async () => {
    const blob = new Blob(['<html>untrusted</html>'], { type: 'text/html' });
    expect(fileDownloadBlob({ statusCode: 200, body: blob })).toBe(blob);
    const legacyBlob = fileDownloadBlob({
      result: {
        dataBase64: 'aGVsbG8=',
        mimeType: 'text/plain',
        fileName: 'hello.txt',
        size: 5,
      },
    });
    expect(legacyBlob.type).toBe('text/plain');
    expect(await legacyBlob.text()).toBe('hello');
    expect(() => fileDownloadBlob({ statusCode: 404, body: blob })).toThrow('Không thể tải file (404)');
    expect(() => fileDownloadBlob({ statusCode: 200, body: '<html>untrusted</html>' })).toThrow('dữ liệu file không hợp lệ');
    expect(() => fileDownloadBlob({ result: { dataBase64: '%' } })).toThrow();
  });

  it.each([
    ['direct', { success: true, file: { _id: 'file-1', name: 'manual.pdf', channel_id: 'room-a' } }],
    ['wrapped', { statusCode: 200, body: { success: true, file: { _id: 'file-1', name: 'manual.pdf', channel_id: 'room-a' } } }],
    ['bridge result', { statusCode: 200, body: { result: { success: true, file: { _id: 'file-1', name: 'manual.pdf', channel_id: 'room-a' } } } }],
    ['bridge direct file', { statusCode: 200, body: { success: true, _id: 'file-1', name: 'manual.pdf', channel_id: 'room-a' } }],
  ])('validates %s room file metadata responses', (_shape, response) => {
    expect(roomFileMetadata(response, 'file-1', 'room-a')).toEqual({
      _id: 'file-1', name: 'manual.pdf', channel_id: 'room-a',
    });
  });

  it('rejects file metadata from another room or for another id', () => {
    expect(() => roomFileMetadata(
      { file: { _id: 'file-1', name: 'manual.pdf', channel_id: 'room-b' } },
      'file-1',
      'room-a',
    )).toThrow('không thuộc room');
    expect(() => roomFileMetadata(
      { file: { _id: 'file-2', name: 'manual.pdf', channel_id: 'room-a' } },
      'file-1',
      'room-a',
    )).toThrow('không hợp lệ');
  });

  it('continues the active assignment with the earliest due date', () => {
    expect(chooseContinueAssignment([
      { id: 'done', status: 'passed', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'later', status: 'in_progress', dueAt: '2026-10-28T00:00:00Z', assignedAt: '2026-10-02T00:00:00Z' },
      { id: 'earlier', status: 'assigned', dueAt: '2026-10-22T00:00:00Z', assignedAt: '2026-10-03T00:00:00Z' },
    ])?.id).toBe('earlier');
    expect(chooseContinueAssignment([
      { id: 'waiting', status: 'awaiting_evaluation', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'submitted', status: 'submitted', assignedAt: '2026-10-02T00:00:00Z' },
    ])).toBeUndefined();
  });

  it('keeps exercises locked until every required resource is opened and completed', () => {
    const resources = [{ id: 'r1', required: true }, { id: 'r2', required: false }];
    expect(isExerciseUnlocked(resources, [{ resourceId: 'r1', openedAt: 'now' }])).toBe(false);
    expect(isExerciseUnlocked(resources, [{ resourceId: 'r1', openedAt: 'now', completedAt: 'later' }])).toBe(true);
  });

  it('shows a recoverable broken-file state without clearing completion', () => {
    expect(resourceViewState({ resourceId: 'r1', openedAt: 'a', completedAt: 'b' }, new Error('missing'))).toEqual({
      completed: true, opened: true, recoverableError: 'missing', canRetry: true,
    });
  });

  it('identifies unanswered required questions', () => {
    const questions = [
      { id: 'q1', type: 'single_choice', prompt: 'P', required: true },
      { id: 'q2', type: 'essay', prompt: 'E', required: false },
    ] as const;
    expect(validateRequiredAnswers(questions, [])).toEqual(['q1']);
    expect(validateRequiredAnswers(questions, [{ questionId: 'q1', selectedOptionIds: ['a'] }])).toEqual([]);
  });

  it('keeps one operation ID for retries of the same answer payload', () => {
    const createId = () => 'op-new';
    const first = nextSubmissionOperation(null, [{ questionId: 'q1', selectedOptionIds: ['a'] }], createId);
    const retry = nextSubmissionOperation(first, [{ questionId: 'q1', selectedOptionIds: ['a'] }], () => 'should-not-change');
    const changed = nextSubmissionOperation(first, [{ questionId: 'q1', selectedOptionIds: ['b'] }], createId);
    expect(retry.operationId).toBe(first.operationId);
    expect(changed.operationId).toBe('op-new');
    expect(buildSubmission('assignment-1', first.operationId)).toEqual({ assignmentId: 'assignment-1', operationId: first.operationId });
  });

  it('shows a numeric score only when multiple-choice questions exist', () => {
    expect(resultPresentation({ mcScore: null })).toMatchObject({ showScore: false });
    expect(resultPresentation({ mcScore: { correctCount: 4, totalCount: 5, percentage: 80, results: [] } })).toMatchObject({
      showScore: true, scoreLabel: '80%',
    });
  });

  it('reveals published feedback and retry CTA only from a published evaluation', () => {
    expect(resultPresentation({ mcScore: null, essayFeedback: [{ id: 'f1' }] })).toMatchObject({ showFeedback: false, canRetry: false });
    expect(resultPresentation({ mcScore: null, evaluation: { conclusion: 'retry' }, essayFeedback: [{ id: 'f1' }] })).toMatchObject({
      showFeedback: true, conclusionLabel: 'Làm lại', canRetry: true,
    });
  });
});
