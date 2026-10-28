import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SourceExtractionError,
  extractSourceDocument,
} from '../src/onboarding/ai/extract';
import { AI_GENERATION_LIMITS } from '../src/onboarding/ai/limits';

const encoder = new TextEncoder();

function minimalPdf(text: string): Uint8Array {
  const stream = 'BT /F1 14 Tf 72 720 Td (' + text.replace(/[()\\]/g, '\\$&') + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream, 'ascii') + ' >>\nstream\n' + stream + '\nendstream',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += String(index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += 'xref\n0 ' + String(objects.length + 1) + '\n';
  body += '0000000000 65535 f \n';
  body += offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  body += 'trailer\n<< /Size ' + String(objects.length + 1) + ' /Root 1 0 R >>\n';
  body += 'startxref\n' + String(xrefOffset) + '\n%%EOF';
  return new Uint8Array(Buffer.from(body, 'ascii'));
}

describe('AI source extraction', () => {
  it('creates deterministic heading-aware sections and splits long sections', async () => {
    const longParagraph = 'a'.repeat(AI_GENERATION_LIMITS.maxSectionChars + 37);
    const bytes = encoder.encode('# Tổng quan\n\nNội dung chung.\n\n## Quy trình\n\n' + longParagraph);

    const first = await extractSourceDocument({
      sourceId: 'source-1', fileName: 'guide.md', mimeType: 'text/markdown', bytes,
    });
    const second = await extractSourceDocument({
      sourceId: 'source-1', fileName: 'guide.md', mimeType: 'text/markdown', bytes,
    });

    expect(first.sections).toEqual(second.sections);
    expect(first.sections.map((section) => section.id)).toEqual([
      'source-1#s1', 'source-1#s2', 'source-1#s3',
    ]);
    expect(first.sections[0]).toMatchObject({ headingPath: ['Tổng quan'], text: 'Nội dung chung.' });
    expect(first.sections[1].headingPath).toEqual(['Tổng quan', 'Quy trình']);
    expect(first.sections.every((section) => section.text.length <= AI_GENERATION_LIMITS.maxSectionChars)).toBe(true);
  });

  it('extracts TXT, inert HTML, DOCX, and page-numbered PDF text', async () => {
    const text = await extractSourceDocument({
      sourceId: 'txt', fileName: 'guide.txt', mimeType: 'text/plain',
      bytes: encoder.encode('  Dòng một\r\n\r\nDòng hai  '),
    });
    expect(text.sections).toEqual([
      { id: 'txt#s1', headingPath: [], text: 'Dòng một\n\nDòng hai' },
    ]);

    const html = await extractSourceDocument({
      sourceId: 'html', fileName: 'guide.html', mimeType: 'text/html',
      bytes: encoder.encode('<h1>An toàn</h1><p>Mở &lt;Room&gt;.</p><script><h2>Lệnh xấu</h2>alert(1)</script>'),
    });
    expect(html.sections).toEqual([
      { id: 'html#s1', headingPath: ['An toàn'], text: 'Mở <Room>.' },
    ]);

    const docxBytes = readFileSync(resolve('node_modules/mammoth/test/test-data/single-paragraph.docx'));
    const docx = await extractSourceDocument({
      sourceId: 'docx', fileName: 'guide.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: new Uint8Array(docxBytes),
    });
    expect(docx.sections[0]?.text).toContain('Walking on imported air');

    const pdf = await extractSourceDocument({
      sourceId: 'pdf', fileName: 'guide.pdf', mimeType: 'application/pdf',
      bytes: minimalPdf('Onboarding guide'),
    });
    expect(pdf.sections).toEqual([
      { id: 'pdf#s1', headingPath: [], page: 1, text: 'Onboarding guide' },
    ]);
  });

  it('fails closed for unsupported, malformed, encrypted/image-only, and oversized inputs', async () => {
    const cases: Array<{
      input: Parameters<typeof extractSourceDocument>[0];
      code: SourceExtractionError['code'];
    }> = [
      {
        input: { sourceId: 'zip', fileName: 'guide.zip', mimeType: 'application/zip', bytes: encoder.encode('zip') },
        code: 'SOURCE_TYPE_UNSUPPORTED',
      },
      {
        input: { sourceId: 'bad', fileName: 'guide.pdf', mimeType: 'application/pdf', bytes: encoder.encode('not-pdf') },
        code: 'SOURCE_PARSE_FAILED',
      },
      {
        input: { sourceId: 'empty', fileName: 'guide.pdf', mimeType: 'application/pdf', bytes: minimalPdf('') },
        code: 'SOURCE_NO_TEXT',
      },
      {
        input: {
          sourceId: 'large', fileName: 'guide.txt', mimeType: 'text/plain',
          bytes: new Uint8Array(AI_GENERATION_LIMITS.maxSourceFileBytes + 1),
        },
        code: 'SOURCE_TOO_LARGE',
      },
    ];

    for (const entry of cases) {
      await expect(extractSourceDocument(entry.input)).rejects.toMatchObject({ code: entry.code });
    }
  });

  it('rejects malformed UTF-8 and normalized text beyond its separate bound', async () => {
    await expect(extractSourceDocument({
      sourceId: 'utf8', fileName: 'guide.txt', mimeType: 'text/plain',
      bytes: new Uint8Array([0xc3, 0x28]),
    })).rejects.toMatchObject({ code: 'SOURCE_PARSE_FAILED' });

    await expect(extractSourceDocument({
      sourceId: 'text-large', fileName: 'guide.txt', mimeType: 'text/plain',
      bytes: encoder.encode('x'.repeat(AI_GENERATION_LIMITS.maxNormalizedTextBytes + 1)),
    })).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
  });
});
