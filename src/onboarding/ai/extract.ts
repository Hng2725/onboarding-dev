import { extname } from 'node:path';

import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

import type { SourceSection } from '../contracts';
import { AI_GENERATION_LIMITS } from './limits';

export type SourceExtractionErrorCode =
  | 'SOURCE_TOO_LARGE'
  | 'SOURCE_TYPE_UNSUPPORTED'
  | 'SOURCE_NO_TEXT'
  | 'SOURCE_PARSE_FAILED';

export class SourceExtractionError extends Error {
  readonly code: SourceExtractionErrorCode;

  constructor(code: SourceExtractionErrorCode, message: string) {
    super(message);
    this.name = 'SourceExtractionError';
    this.code = code;
  }
}

export interface ExtractSourceDocumentInput {
  readonly sourceId: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly bytes: Uint8Array;
}

export interface ExtractedSourceDocument {
  readonly sections: readonly SourceSection[];
  readonly textLength: number;
}

type SourceFileKind = 'pdf' | 'docx' | 'markdown' | 'text' | 'html';

interface TextUnit {
  readonly headingPath: readonly string[];
  readonly page?: number;
  readonly text: string;
}

function extractionError(
  code: SourceExtractionErrorCode,
  message: string,
  cause?: unknown,
): SourceExtractionError {
  const error = new SourceExtractionError(code, message);
  if (cause !== undefined) Object.assign(error, { cause });
  return error;
}

function kindFromMime(rawMimeType?: string): SourceFileKind | undefined {
  const mimeType = rawMimeType?.split(';')[0]?.trim().toLowerCase();
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'docx';
  }
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown') return 'markdown';
  if (mimeType === 'text/plain') return 'text';
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') return 'html';
  return undefined;
}

function kindFromFileName(fileName: string): SourceFileKind | undefined {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'docx';
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.txt') return 'text';
  if (extension === '.html' || extension === '.htm') return 'html';
  return undefined;
}

function resolveFileKind(fileName: string, mimeType?: string): SourceFileKind {
  const mimeKind = kindFromMime(mimeType);
  const nameKind = kindFromFileName(fileName);
  if (mimeKind && nameKind && mimeKind !== nameKind) {
    throw extractionError(
      'SOURCE_TYPE_UNSUPPORTED',
      'File name and MIME type identify different document formats.',
    );
  }
  const kind = mimeKind ?? nameKind;
  if (!kind) {
    throw extractionError(
      'SOURCE_TYPE_UNSUPPORTED',
      'Only PDF, DOCX, Markdown, TXT, and HTML sources are supported.',
    );
  }
  return kind;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw extractionError('SOURCE_PARSE_FAILED', 'The document is not valid UTF-8 text.', error);
  }
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[lower] ?? match;
  });
}

function plainHtmlFragment(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
}

function htmlToMarkdown(value: string): string {
  let html = value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_match, level: string, body: string) =>
    '\n' + '#'.repeat(Number(level)) + ' ' + plainHtmlFragment(body) + '\n');
  html = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|ul|ol|table|tr|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeHtmlEntities(html);
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function markdownUnits(value: string): readonly TextUnit[] {
  const units: TextUnit[] = [];
  let headingPath: string[] = [];
  let body: string[] = [];
  const flush = () => {
    const text = normalizeText(body.join('\n'));
    if (text) units.push({ headingPath: [...headingPath], text });
    body = [];
  };

  for (const line of value.split(/\r?\n/)) {
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) {
      body.push(line);
      continue;
    }
    flush();
    const level = heading[1].length;
    const title = normalizeText(heading[2]);
    headingPath = headingPath.slice(0, Math.max(0, level - 1));
    headingPath.push(title);
  }
  flush();
  return units;
}

function splitBounded(value: string): readonly string[] {
  const chunks: string[] = [];
  let remaining = value.trim();
  while (remaining.length > AI_GENERATION_LIMITS.maxSectionChars) {
    const boundary = AI_GENERATION_LIMITS.maxSectionChars;
    const prefix = remaining.slice(0, boundary + 1);
    const paragraphBreak = prefix.lastIndexOf('\n\n');
    const lineBreak = prefix.lastIndexOf('\n');
    const wordBreak = prefix.lastIndexOf(' ');
    const candidate = paragraphBreak >= Math.floor(boundary / 2)
      ? paragraphBreak
      : lineBreak >= Math.floor(boundary / 2)
        ? lineBreak
        : wordBreak >= Math.floor(boundary / 2)
          ? wordBreak
          : boundary;
    const chunk = remaining.slice(0, candidate).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(candidate).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function toSections(sourceId: string, units: readonly TextUnit[]): ExtractedSourceDocument {
  const normalizedUnits = units
    .map((unit) => ({ ...unit, text: normalizeText(unit.text) }))
    .filter((unit) => Boolean(unit.text));
  const normalizedText = normalizedUnits.map((unit) => unit.text).join('\n\n');
  const normalizedBytes = Buffer.byteLength(normalizedText, 'utf8');
  if (normalizedBytes === 0) {
    throw extractionError(
      'SOURCE_NO_TEXT',
      'The document has no extractable text. OCR is not available in this version.',
    );
  }
  if (normalizedBytes > AI_GENERATION_LIMITS.maxNormalizedTextBytes) {
    throw extractionError('SOURCE_TOO_LARGE', 'The extracted document text is too large.');
  }

  const sections: SourceSection[] = [];
  for (const unit of normalizedUnits) {
    for (const chunk of splitBounded(unit.text)) {
      sections.push({
        id: sourceId + '#s' + String(sections.length + 1),
        headingPath: [...unit.headingPath],
        ...(unit.page === undefined ? {} : { page: unit.page }),
        text: chunk,
      });
    }
  }
  return { sections, textLength: normalizedText.length };
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(extractionError(
      'SOURCE_PARSE_FAILED',
      'Document extraction exceeded the safe processing time.',
    )), AI_GENERATION_LIMITS.extractionTimeoutMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function pdfUnits(bytes: Uint8Array): Promise<readonly TextUnit[]> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    const safePdfOptions = {
      isEvalSupported: false,
      maxImageSize: 16_777_216,
    } as unknown as NonNullable<Parameters<typeof getDocumentProxy>[1]>;
    pdf = await withTimeout(getDocumentProxy(Uint8Array.from(bytes), safePdfOptions));
    if (pdf.numPages > AI_GENERATION_LIMITS.maxPdfPages) {
      throw extractionError('SOURCE_TOO_LARGE', 'The PDF has too many pages.');
    }
    const result = await withTimeout(extractText(pdf, { mergePages: false }));
    return result.text.map((text, index) => ({
      headingPath: [],
      page: index + 1,
      text,
    }));
  } catch (error) {
    if (error instanceof SourceExtractionError) throw error;
    throw extractionError(
      'SOURCE_PARSE_FAILED',
      'The PDF is malformed, encrypted, or could not be extracted.',
      error,
    );
  } finally {
    const destroy = (pdf as unknown as { destroy?: () => Promise<void> } | undefined)?.destroy;
    if (typeof destroy === 'function') await destroy.call(pdf).catch(() => undefined);
  }
}

async function docxUnits(bytes: Uint8Array): Promise<readonly TextUnit[]> {
  try {
    const result = await withTimeout(mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      },
    ));
    return markdownUnits(htmlToMarkdown(result.value));
  } catch (error) {
    if (error instanceof SourceExtractionError) throw error;
    throw extractionError('SOURCE_PARSE_FAILED', 'The DOCX document could not be extracted.', error);
  }
}

export async function extractSourceDocument(
  input: ExtractSourceDocumentInput,
): Promise<ExtractedSourceDocument> {
  if (!input.sourceId.trim()) {
    throw extractionError('SOURCE_PARSE_FAILED', 'A stable source ID is required.');
  }
  if (input.bytes.byteLength > AI_GENERATION_LIMITS.maxSourceFileBytes) {
    throw extractionError('SOURCE_TOO_LARGE', 'The source file exceeds the 2 MiB limit.');
  }
  const kind = resolveFileKind(input.fileName, input.mimeType);

  let units: readonly TextUnit[];
  if (kind === 'pdf') {
    units = await pdfUnits(input.bytes);
  } else if (kind === 'docx') {
    units = await docxUnits(input.bytes);
  } else {
    const text = decodeUtf8(input.bytes);
    if (kind === 'markdown') units = markdownUnits(text);
    else if (kind === 'html') units = markdownUnits(htmlToMarkdown(text));
    else units = [{ headingPath: [], text }];
  }
  return toSections(input.sourceId, units);
}
