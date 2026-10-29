import { describe, expect, it } from 'vitest';

import { extractSourceDocument } from '../src/onboarding/ai/extract';
import type { AdminTemplateDetail } from '../src/onboarding/templates';
import {
  createLessonPdfArtifact,
  LessonPdfError,
  lessonPdfDocumentDefinition,
  lessonPdfFileName,
} from '../src/ui/onboarding/ai/lesson-pdf';

const review: AdminTemplateDetail = {
  id: 'template-1',
  version: 1,
  source: 'ai_generated',
  status: 'draft',
  employeeType: 'normal',
  title: 'Hội nhập nhân sự mới',
  description: 'Lộ trình giúp nhân sự bắt đầu công việc an toàn.',
  locked: false,
  maxAttempts: 3,
  updatedAt: '2026-10-26T08:00:00.000Z',
  modules: [{
    id: 'module-1',
    key: 'orders',
    title: 'Quy trình xử lý đơn hàng',
    description: 'Thực hiện đơn hàng đúng và đủ.',
    order: 1,
    resources: [],
    questions: [{
      id: 'question-1',
      type: 'single_choice',
      prompt: 'Câu hỏi bí mật không được ghi vào PDF?',
      options: [{ id: 'a', label: 'Đáp án bí mật' }],
      correctOptionIds: ['a'],
      explanation: 'Giải thích bí mật',
    }],
  }],
  content: {
    assessmentMode: 'per_module',
    learningMode: 'sequential',
    maxAttemptsPerModule: 3,
    modules: [{
      moduleId: 'module-1',
      frameKey: 't1-core',
      objectives: ['Hiểu luồng xử lý', 'Thực hiện đúng từng bước'],
      estimatedMinutes: 12,
      blocks: [{
        id: 'block-1',
        kind: 'concept',
        title: 'Khái niệm chính',
        body: 'Mở **Đơn hàng** và kiểm tra thông tin.\n\n- Xác nhận khách hàng\n- Kiểm tra tồn kho',
        sourceRefs: [{
          kind: 'document',
          sourceId: 'source-1',
          sectionId: 'source-1#s1',
          page: 2,
          quote: 'Nhân viên phải kiểm tra thông tin trước khi xác nhận.',
        }],
        pendingVerification: false,
      }, {
        id: 'block-2',
        kind: 'steps',
        title: 'Các bước thực hiện',
        body: 'Làm theo thứ tự dưới đây.',
        steps: [
          { order: 2, text: 'Xác nhận đơn hàng' },
          { order: 1, text: 'Kiểm tra thông tin' },
        ],
        sourceRefs: [{
          kind: 'document',
          sourceId: 'source-1',
          sectionId: 'source-1#s2',
          quote: 'Kiểm tra rồi mới xác nhận đơn hàng.',
        }],
        pendingVerification: false,
      }],
    }],
    questionMeta: [],
  },
};

describe('AI lesson PDF artifacts', () => {
  it('uses distinct stable names for identically titled modules from separate templates', () => {
    expect(lessonPdfFileName('Same title', 0, 'ai-mod-first')).not.toBe(lessonPdfFileName('Same title', 0, 'ai-mod-second'));
    expect(lessonPdfFileName('Same title', 0, 'ai-mod-first')).toBe('01-same-title-ai-mod-first.pdf');
  });
  it('does not render internal approval and checkpoint fields into lesson text', () => {
    const internal = { ...review, content: { ...review.content!, publication: { pdfs: {}, jsonFileId: 'private-json' }, moduleApproval: { pipelineVersion: 'module_v2' as const, outlineRevision: 2, fingerprint: 'private-fingerprint', materializedFingerprint: 'private-materialized', taskCoverage: [] }, modules: review.content!.modules.map((m) => ({ ...m, lessonProvenance: 'manual' as const, approvedLessonVersion: 2 })) } };
    expect(JSON.stringify(lessonPdfDocumentDefinition(internal, 'module-1'))).not.toMatch(/private-|lessonProvenance|moduleApproval|approvedLessonVersion/);
  });
  it('builds a Vietnamese lesson-only document definition in source order', () => {
    const definition = lessonPdfDocumentDefinition(review, 'module-1');
    const serialized = JSON.stringify(definition);

    expect(definition.pageSize).toBe('A4');
    expect(definition.pageMargins).toEqual([48, 56, 48, 56]);
    expect(definition.defaultStyle).toMatchObject({ font: 'Roboto' });
    expect(typeof definition.footer).toBe('function');
    expect(serialized).toContain('Hội nhập nhân sự mới');
    expect(serialized).toContain('Quy trình xử lý đơn hàng');
    expect(serialized).toContain('Thực hiện đơn hàng đúng và đủ.');
    expect(serialized).toContain('Hiểu luồng xử lý');
    expect(serialized).toContain('Thực hiện đúng từng bước');
    expect(serialized).toContain('12 phút');

    const firstBlock = serialized.indexOf('Khái niệm chính');
    const secondBlock = serialized.indexOf('Các bước thực hiện');
    const firstStep = serialized.indexOf('Kiểm tra thông tin', secondBlock);
    const secondStep = serialized.indexOf('Xác nhận đơn hàng', secondBlock);
    const citations = serialized.indexOf('Nguồn tham khảo');
    expect(firstBlock).toBeGreaterThan(-1);
    expect(secondBlock).toBeGreaterThan(firstBlock);
    expect(firstStep).toBeGreaterThan(secondBlock);
    expect(secondStep).toBeGreaterThan(firstStep);
    expect(citations).toBeGreaterThan(secondBlock);
    expect(serialized).toContain('source-1#s1');
    expect(serialized).toContain('trang 2');

    expect(serialized).not.toContain('Câu hỏi bí mật');
    expect(serialized).not.toContain('Đáp án bí mật');
    expect(serialized).not.toContain('Giải thích bí mật');
  });

  it('prints each block kind as its Vietnamese label, never the raw kind', () => {
    const serialized = JSON.stringify(lessonPdfDocumentDefinition(review, 'module-1'));
    expect(serialized).toContain('"text":"Khái niệm"');
    expect(serialized).toContain('"text":"Các bước"');
    expect(serialized).not.toMatch(/"text":"(?:concept|steps)"/);
    expect(serialized.indexOf('"text":"Các bước"')).toBeLessThan(serialized.indexOf('Các bước thực hiện'));
  });

  it('creates a stable ASCII filename and reports missing module content', () => {
    expect(lessonPdfFileName(review.modules[0].title, 0))
      .toBe('01-quy-trinh-xu-ly-don-hang.pdf');

    expect(() => lessonPdfDocumentDefinition(review, 'missing-module'))
      .toThrowError(LessonPdfError);
    expect(() => lessonPdfDocumentDefinition(review, 'missing-module'))
      .toThrow('Không tìm thấy nội dung bài học');
  });

  it('renders a valid PDF blob whose Vietnamese lesson text is extractable', async () => {
    const artifact = await createLessonPdfArtifact(review, 'module-1', 0);
    const bytes = new Uint8Array(await artifact.blob.arrayBuffer());

    expect(artifact.fileName).toBe('01-quy-trinh-xu-ly-don-hang-module-1.pdf');
    expect(artifact.mimeType).toBe('application/pdf');
    expect(artifact.blob.type).toBe('application/pdf');
    expect(artifact.blob.size).toBeGreaterThan(0);
    expect(new TextDecoder('ascii').decode(bytes.slice(0, 5))).toBe('%PDF-');

    const extracted = await extractSourceDocument({
      sourceId: 'generated-lesson',
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      bytes,
    });
    const text = extracted.sections.map((section) => section.text).join('\\n');
    expect(text).toContain('Quy trình xử lý đơn hàng');
    expect(text).toContain('Hiểu luồng xử lý');
    expect(text).not.toContain('Câu hỏi bí mật');
  });
});
