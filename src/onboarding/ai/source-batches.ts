import type { SourceRecord } from '../contracts';
import { AI_GENERATION_LIMITS } from './limits';

export class SourceBatchError extends Error {
  readonly code: 'SOURCE_TOO_LARGE' | 'SOURCE_NOT_FOUND';

  constructor(code: SourceBatchError['code'], message: string) {
    super(message);
    this.name = 'SourceBatchError';
    this.code = code;
  }
}

/**
 * Splits the sources' sections, in order, into batches of section IDs that each fit one AI
 * call's system context. Throws when the total text exceeds the job limit or there are no
 * sections at all.
 */
export function planBatches(sources: readonly SourceRecord[]): readonly (readonly string[])[] {
  const sections = sources.flatMap((source) => source.sections ?? []);
  const totalBytes = Buffer.byteLength(sections.map((section) => section.text).join('\n'), 'utf8');
  if (totalBytes > AI_GENERATION_LIMITS.maxJobTextBytes) {
    throw new SourceBatchError('SOURCE_TOO_LARGE', 'Selected source text exceeds the job limit.');
  }
  const batches: string[][] = [];
  let current: string[] = [];
  let currentSize = 0;
  for (const section of sections) {
    const estimatedSize = section.text.length + section.id.length + 500;
    if (
      current.length > 0
      && currentSize + estimatedSize > AI_GENERATION_LIMITS.maxSystemContextChars - 1_000
    ) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(section.id);
    currentSize += estimatedSize;
  }
  if (current.length > 0) batches.push(current);
  if (batches.length === 0) {
    throw new SourceBatchError('SOURCE_NOT_FOUND', 'Selected sources contain no extracted sections.');
  }
  return batches;
}

/** The sources narrowed to the given section IDs; sources left without sections are dropped. */
export function batchSources(
  sources: readonly SourceRecord[],
  sectionIds: readonly string[],
): readonly SourceRecord[] {
  const selected = new Set(sectionIds);
  return sources.map((source) => ({
    ...source,
    sections: source.sections?.filter((section) => selected.has(section.id)) ?? [],
  })).filter((source) => (source.sections?.length ?? 0) > 0);
}
