import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { LessonBlock, SourceRef } from '../../../onboarding/contracts';
import type { AdminTemplateDetail } from '../../../onboarding/templates';

export interface LessonPdfArtifact {
  readonly fileName: string;
  readonly mimeType: 'application/pdf';
  readonly blob: Blob;
}

export type LessonPdfErrorCode = 'MODULE_CONTENT_NOT_FOUND';

export class LessonPdfError extends Error {
  readonly code: LessonPdfErrorCode;

  constructor(code: LessonPdfErrorCode, message: string) {
    super(message);
    this.name = 'LessonPdfError';
    this.code = code;
  }
}

function plainMarkdownText(value: string): string {
  const entities: Readonly<Record<string, string>> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value
    .replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) {
        const codePoint = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
      if (lower.startsWith('#')) {
        const codePoint = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
      return entities[lower] ?? match;
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/(^|\s)[#>*_~`]+/g, '$1')
    .replace(/[*_~`]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function markdownContent(value: string): Content[] {
  const content: Content[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    const text = plainMarkdownText(paragraph.join(' '));
    if (text) content.push({ text, margin: [0, 0, 0, 8] });
    paragraph = [];
  };
  const flushBullets = () => {
    const ul = bullets.map(plainMarkdownText).filter(Boolean);
    if (ul.length > 0) content.push({ ul, margin: [12, 0, 0, 8] });
    bullets = [];
  };

  for (const rawLine of value.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push(bullet[1]);
      continue;
    }
    if (!line) {
      flushParagraph();
      flushBullets();
      continue;
    }
    flushBullets();
    paragraph.push(line);
  }
  flushParagraph();
  flushBullets();
  return content;
}

function blockContent(block: LessonBlock): Content[] {
  const content: Content[] = [];
  if (block.title) {
    content.push({ text: plainMarkdownText(block.title), style: 'blockTitle' });
  }
  content.push(...markdownContent(block.body));
  const steps = [...(block.steps ?? [])].sort((left, right) => left.order - right.order);
  if (steps.length > 0) {
    content.push({
      ol: steps.map((step) => plainMarkdownText(step.text)).filter(Boolean),
      margin: [12, 0, 0, 12],
    });
  }
  return content;
}

function sourceKey(ref: SourceRef): string {
  return [ref.kind, ref.sourceId, ref.sectionId, ref.page ?? '', ref.quote].join('|');
}

function sourceLabel(ref: SourceRef, index: number): Content {
  const location = [ref.sourceId, ref.sectionId, ref.page === undefined ? '' : `trang ${ref.page}`]
    .filter(Boolean)
    .join(' · ');
  return {
    stack: [
      { text: `[${index + 1}] ${location}`, bold: true },
      { text: plainMarkdownText(ref.quote), italics: true, margin: [0, 2, 0, 8] },
    ],
  };
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, (letter) => letter === 'Đ' ? 'D' : 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'module';
}

export function lessonPdfFileName(moduleTitle: string, moduleIndex: number, moduleId?: string): string {
  const ordinal = String(Math.max(0, moduleIndex) + 1).padStart(2, '0');
  return `${ordinal}-${slugify(moduleTitle)}${moduleId ? '-' + slugify(moduleId) : ''}.pdf`;
}

export function lessonPdfDocumentDefinition(
  review: AdminTemplateDetail,
  moduleId: string,
): TDocumentDefinitions {
  const module = review.modules.find((entry) => entry.id === moduleId);
  const lesson = review.content?.modules.find((entry) => entry.moduleId === moduleId);
  if (!module || !lesson) {
    throw new LessonPdfError(
      'MODULE_CONTENT_NOT_FOUND',
      `Không tìm thấy nội dung bài học cho mô-đun ${moduleId}.`,
    );
  }

  const refs: SourceRef[] = [];
  const seenRefs = new Set<string>();
  for (const block of lesson.blocks) {
    for (const ref of block.sourceRefs) {
      const key = sourceKey(ref);
      if (!seenRefs.has(key)) {
        seenRefs.add(key);
        refs.push(ref);
      }
    }
  }

  const content: Content[] = [
    { text: review.title, style: 'templateTitle' },
    { text: module.title, style: 'moduleTitle' },
    { text: plainMarkdownText(module.description), style: 'description' },
    { text: `Thời lượng dự kiến: ${lesson.estimatedMinutes} phút`, style: 'metadata' },
    { text: 'Mục tiêu học tập', style: 'sectionTitle' },
    { ul: lesson.objectives.map(plainMarkdownText).filter(Boolean), margin: [12, 0, 0, 14] },
    { text: 'Nội dung bài học', style: 'sectionTitle' },
  ];

  for (const block of lesson.blocks) content.push(...blockContent(block));
  if (refs.length > 0) {
    content.push({ text: 'Nguồn tham khảo', style: 'sectionTitle', pageBreak: 'before' });
    refs.forEach((ref, index) => content.push(sourceLabel(ref, index)));
  }

  return {
    pageSize: 'A4',
    pageMargins: [48, 56, 48, 56],
    info: { title: `${review.title} – ${module.title}`, subject: 'Tài liệu onboarding' },
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.35, color: '#172033' },
    footer: (currentPage, pageCount) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'center',
      color: '#667085',
      fontSize: 8,
      margin: [0, 16, 0, 0],
    }),
    styles: {
      templateTitle: { fontSize: 11, bold: true, color: '#536078', margin: [0, 0, 0, 6] },
      moduleTitle: { fontSize: 22, bold: true, color: '#172033', margin: [0, 0, 0, 8] },
      description: { fontSize: 11, color: '#475467', margin: [0, 0, 0, 6] },
      metadata: { fontSize: 9, color: '#667085', margin: [0, 0, 0, 16] },
      sectionTitle: { fontSize: 14, bold: true, color: '#3448a5', margin: [0, 10, 0, 8] },
      blockTitle: { fontSize: 11.5, bold: true, color: '#253052', margin: [0, 6, 0, 5] },
    },
    content,
  };
}

export async function createLessonPdfArtifact(
  review: AdminTemplateDetail,
  moduleId: string,
  moduleIndex: number,
): Promise<LessonPdfArtifact> {
  const module = review.modules.find((entry) => entry.id === moduleId);
  if (!module) {
    throw new LessonPdfError(
      'MODULE_CONTENT_NOT_FOUND',
      `Không tìm thấy nội dung bài học cho mô-đun ${moduleId}.`,
    );
  }
  const [pdfMakeModule, vfsModule] = await Promise.all([
    import('pdfmake/build/pdfmake.js'),
    import('pdfmake/build/vfs_fonts.js'),
  ]);
  const pdfMake = pdfMakeModule.default;
  pdfMake.addVirtualFileSystem(vfsModule.default);
  const blob = await pdfMake.createPdf(lessonPdfDocumentDefinition(review, moduleId)).getBlob();
  return {
    fileName: lessonPdfFileName(module.title, moduleIndex, module.id),
    mimeType: 'application/pdf',
    blob: blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }),
  };
}
