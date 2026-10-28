import type { SourceSection, TemplateOutlineModule } from '../contracts';
import { normalizeForMatch, type RawSourceRef } from './grounding';
import { AI_GENERATION_LIMITS } from './limits';
import type { GeneratedBlock, GeneratedModule } from './validate';

export type FallbackLessonResult =
  | { readonly kind: 'draft'; readonly module: GeneratedModule; readonly provenance: 'fallback' }
  | { readonly kind: 'manual_placeholder'; readonly moduleLocalId: string; readonly blockingReason: 'NO_USABLE_SOURCE' };

interface FallbackInput {
  readonly outline: TemplateOutlineModule;
  readonly sections: readonly SourceSection[];
}

type SegmentKind = 'concept' | 'steps';
interface Segment { readonly kind: SegmentKind; readonly lines: readonly string[] }

function segments(text: string): readonly Segment[] {
  const result: Segment[] = [];
  let kind: SegmentKind | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (lines.length && kind) result.push({ kind, lines });
    lines = [];
  };
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) { flush(); kind = undefined; continue; }
    const nextKind: SegmentKind = /^(?:[-*+]\s+|\d+[.)]\s+)/u.test(line) ? 'steps' : 'concept';
    if (kind && kind !== nextKind) flush();
    kind = nextKind;
    lines.push(line);
  }
  flush();
  return result;
}

function quoteFor(section: SourceSection, segment: Segment): string {
  const first = segment.lines[0];
  const position = section.text.indexOf(first);
  const start = position < 0 ? 0 : position;
  const quote = section.text.slice(start, start + AI_GENERATION_LIMITS.maxQuoteChars).trim();
  if (quote.length >= AI_GENERATION_LIMITS.minQuoteChars && /[\p{L}\p{N}]/u.test(normalizeForMatch(quote))) return quote;
  return section.text.slice(0, AI_GENERATION_LIMITS.maxQuoteChars).trim();
}

function usable(section: SourceSection): boolean {
  const normalized = normalizeForMatch(section.text);
  return section.text.trim().length >= AI_GENERATION_LIMITS.minQuoteChars
    && /[\p{L}\p{N}]/u.test(normalized);
}

export function buildFallbackLesson(input: FallbackInput): FallbackLessonResult {
  const byId = new Map(input.sections.map((section) => [section.id, section]));
  const selected = input.outline.sourceSectionIds
    .map((id) => byId.get(id))
    .filter((section): section is SourceSection => Boolean(section && usable(section)));
  const blocks: GeneratedBlock[] = [];
  const headings: string[] = [];
  const headingRefs: RawSourceRef[] = [];

  for (const section of selected) {
    const sectionSegments = segments(section.text);
    const sectionHeadings = section.headingPath.map((part) => part.trim()).filter(Boolean);
    const heading = sectionHeadings[sectionHeadings.length - 1]
      ?? sectionSegments[0]?.lines[0];
    if (!heading || !sectionSegments.length) continue;
    for (const segment of sectionSegments) {
      const quote = quoteFor(section, segment);
      if (quote.length < AI_GENERATION_LIMITS.minQuoteChars || !normalizeForMatch(section.text).includes(normalizeForMatch(quote))) continue;
      const ref: RawSourceRef = { sectionId: section.id, quote };
      const block: GeneratedBlock = {
        localId: input.outline.moduleLocalId + '-fallback-' + String(blocks.length + 1),
        kind: segment.kind,
        title: heading,
        body: segment.lines.join('\n'),
        ...(segment.kind === 'steps' ? { steps: segment.lines.map((line, index) => ({
          order: index + 1,
          text: line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, ''),
        })) } : {}),
        sourceRefs: [ref],
      };
      blocks.push(block);
      if (!headings.includes(heading)) {
        headings.push(heading);
        headingRefs.push(ref);
      }
    }
  }

  if (!blocks.length) return {
    kind: 'manual_placeholder', moduleLocalId: input.outline.moduleLocalId,
    blockingReason: 'NO_USABLE_SOURCE',
  };

  blocks.push({
    localId: input.outline.moduleLocalId + '-fallback-summary',
    kind: 'summary', body: headings.join('\n'), sourceRefs: headingRefs,
  });
  return {
    kind: 'draft', provenance: 'fallback',
    module: {
      localId: input.outline.moduleLocalId,
      frameKey: input.outline.frameKey,
      title: input.outline.title,
      description: input.outline.description,
      estimatedMinutes: input.outline.estimatedMinutes,
      objectives: input.outline.objectives,
      featureIds: input.outline.featureIds,
      blocks,
      questions: [],
    },
  };
}
