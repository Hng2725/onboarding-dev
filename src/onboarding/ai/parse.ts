import { AI_GENERATION_LIMITS } from './limits';

export type AiOutputParseErrorCode = 'AI_OUTPUT_INVALID' | 'AI_OUTPUT_TOO_LARGE';

export class AiOutputParseError extends Error {
  readonly code: AiOutputParseErrorCode;

  constructor(code: AiOutputParseErrorCode, message: string) {
    super(message);
    this.name = 'AiOutputParseError';
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new AiOutputParseError('AI_OUTPUT_INVALID', message);
}

export interface ParseAiJsonOptions {
  /**
   * Native AI Chat transcripts concatenate the agent's progress narration with its answer.
   * When allowed, prose may precede the object, but the object must still end the output.
   */
  readonly allowLeadingNarration?: boolean;
}

const MAX_NARRATION_CANDIDATES = 200;

function trailingObject(text: string): string | undefined {
  const fenced = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (fenced) return fenced[1].trim();
  if (!text.endsWith('}')) return undefined;
  let start = text.indexOf('{');
  for (let attempts = 0; start >= 0 && attempts < MAX_NARRATION_CANDIDATES; attempts += 1) {
    const candidate = text.slice(start);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return candidate;
    } catch {
      // Not the start of the final object; try the next brace.
    }
    start = text.indexOf('{', start + 1);
  }
  return undefined;
}

export function parseAiJsonObject(
  text: string,
  options: ParseAiJsonOptions = {},
): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > AI_GENERATION_LIMITS.maxAiResponseBytes) {
    throw new AiOutputParseError('AI_OUTPUT_TOO_LARGE', 'AI output exceeds the allowed size.');
  }

  const raw = text.trim();
  if (!raw) invalid('AI output is empty.');
  const trimmed = options.allowLeadingNarration && !raw.startsWith('{') && !raw.startsWith('```')
    ? trailingObject(raw) ?? raw
    : raw;
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  const candidate = fenced?.[1].trim() ?? trimmed;
  if (!fenced && (candidate[0] !== '{' || candidate[candidate.length - 1] !== '}')) {
    invalid('AI output must contain exactly one JSON object and no prose.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return invalid('AI output is malformed or truncated JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalid('AI output root must be one JSON object.');
  }
  return parsed as Record<string, unknown>;
}
