import type { SourceRecord, SourceRef, SourceSection } from '../contracts';
import { AI_GENERATION_LIMITS } from './limits';

export interface RawSourceRef {
  readonly sectionId: string;
  readonly quote: string;
}

export type GroundingIssueCode =
  | 'SOURCE_REF_SECTION_UNKNOWN'
  | 'SOURCE_REF_QUOTE_LENGTH'
  | 'SOURCE_REF_QUOTE_MISMATCH'
  | 'EMPHASIZED_TERM_UNSUPPORTED';

export interface GroundingIssue {
  readonly code: GroundingIssueCode;
  readonly message: string;
  readonly sectionId?: string;
  readonly value?: string;
}

export type GroundSourceRefResult =
  | { readonly ok: true; readonly ref: SourceRef }
  | { readonly ok: false; readonly issue: GroundingIssue };

export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFC')
    .toLocaleLowerCase('vi')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function activeSection(
  sectionId: string,
  sources: readonly SourceRecord[],
): { readonly source: SourceRecord; readonly section: SourceSection } | undefined {
  for (const source of sources) {
    if (source.deletedAt || source.status !== 'ready') continue;
    const section = source.sections?.find((candidate) => candidate.id === sectionId);
    if (section) return { source, section };
  }
  return undefined;
}

export function groundSourceRef(
  raw: RawSourceRef,
  sources: readonly SourceRecord[],
): GroundSourceRefResult {
  const located = activeSection(raw.sectionId, sources);
  if (!located) {
    return {
      ok: false,
      issue: {
        code: 'SOURCE_REF_SECTION_UNKNOWN',
        message: 'The referenced source section does not exist in the active job sources.',
        sectionId: raw.sectionId,
      },
    };
  }
  const quote = raw.quote.trim();
  if (
    quote.length < AI_GENERATION_LIMITS.minQuoteChars
    || quote.length > AI_GENERATION_LIMITS.maxQuoteChars
  ) {
    return {
      ok: false,
      issue: {
        code: 'SOURCE_REF_QUOTE_LENGTH',
        message: 'The source quote must contain 8 to 300 characters.',
        sectionId: raw.sectionId,
        value: quote,
      },
    };
  }
  if (!normalizeForMatch(located.section.text).includes(normalizeForMatch(quote))) {
    return {
      ok: false,
      issue: {
        code: 'SOURCE_REF_QUOTE_MISMATCH',
        message: 'The quoted text does not occur in the referenced source section.',
        sectionId: raw.sectionId,
        value: quote,
      },
    };
  }
  return {
    ok: true,
    ref: {
      kind: located.source.kind,
      sourceId: located.source.sourceId,
      sectionId: located.section.id,
      ...(located.section.page === undefined ? {} : { page: located.section.page }),
      quote,
    },
  };
}

function emphasizedTerms(text: string): readonly string[] {
  const terms: string[] = [];
  const expression = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  for (const match of text.matchAll(expression)) {
    const term = (match[1] ?? match[2] ?? '').trim();
    if (term) terms.push(term);
  }
  return terms;
}

export function unsupportedEmphasizedTerms(
  text: string,
  sources: readonly SourceRecord[],
): readonly string[] {
  const corpus = normalizeForMatch(
    sources
      .filter((source) => !source.deletedAt && source.status === 'ready')
      .flatMap((source) => source.sections?.map((section) => section.text) ?? [])
      .join('\n'),
  );
  const unsupported = emphasizedTerms(text)
    .filter((term) => !corpus.includes(normalizeForMatch(term)));
  return [...new Set(unsupported)];
}
