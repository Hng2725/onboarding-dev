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

/** XML escaping and wrapping grow the text a little; sizes are checked in UTF-8 bytes. */
const ESCAPE_MARGIN = 1.15;

export interface PlanBatchesOptions {
  /** Bytes of the system context kept free for what the call adds besides the sections. */
  readonly reserveBytes?: number;
}

/**
 * Splits the sources' sections, in order, into batches of section IDs that each fit one AI
 * call's system context, measured in UTF-8 bytes like bounded(). Throws when the total text
 * exceeds the job limit or there are no sections at all.
 */
export function planBatches(
  sources: readonly SourceRecord[],
  options: PlanBatchesOptions = {},
): readonly (readonly string[])[] {
  const budget = AI_GENERATION_LIMITS.maxSystemContextChars - 1_000 - (options.reserveBytes ?? 0);
  const sections = sources.flatMap((source) => source.sections ?? []);
  const totalBytes = Buffer.byteLength(sections.map((section) => section.text).join('\n'), 'utf8');
  if (totalBytes > AI_GENERATION_LIMITS.maxJobTextBytes) {
    throw new SourceBatchError('SOURCE_TOO_LARGE', 'Selected source text exceeds the job limit.');
  }
  const batches: string[][] = [];
  let current: string[] = [];
  let currentSize = 0;
  for (const section of sections) {
    const rawBytes = Buffer.byteLength(section.text, 'utf8') + Buffer.byteLength(section.id, 'utf8')
      + Buffer.byteLength(section.headingPath.join(' > '), 'utf8');
    const estimatedSize = Math.ceil(rawBytes * ESCAPE_MARGIN) + 500;
    if (current.length > 0 && currentSize + estimatedSize > budget) {
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
