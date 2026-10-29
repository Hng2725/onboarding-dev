import { normalizeForMatch } from './grounding';
import type { GeneratedBlock, GeneratedModule, GeneratedQuestion } from './validate';

export type FallbackQuestionResult =
  | { readonly kind: 'draft'; readonly questions: readonly GeneratedQuestion[]; readonly provenance: 'fallback' }
  | { readonly kind: 'manual_required'; readonly reason: 'NO_GROUNDED_LESSON_BLOCK' };

interface GroundedStatement {
  readonly block: GeneratedBlock;
  readonly text: string;
}

const PROMPT_FORMS = [
  (statement: string) => `Thông tin sau có được nêu trong bài học không? “${statement}”`,
  (statement: string) => `Theo bài học đã duyệt, nhận định sau có chính xác không? “${statement}”`,
  (statement: string) => `Bài học có xác nhận nội dung sau không? “${statement}”`,
] as const;

const OPTIONS = [
  { id: 'a', label: 'Có, nội dung này được nêu trực tiếp.' },
  { id: 'b', label: 'Không, tài liệu nêu điều ngược lại.' },
  { id: 'c', label: 'Không, nội dung này không xuất hiện.' },
  { id: 'd', label: 'Chưa đủ thông tin để xác định.' },
] as const;

function fragments(text: string): readonly string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((part) => part.replace(/^(?:[-*+]\s+|\d+[.)]\s*)/u, '').trim())
    .filter((part) => normalizeForMatch(part).length > 0)
    .map((part) => part.slice(0, 300));
}

function statements(block: GeneratedBlock): readonly GroundedStatement[] {
  const evidence = block.sourceRefs.flatMap((ref) => fragments(ref.quote));
  const content = [
    ...(block.steps ?? []).map((step) => step.text),
    ...fragments(block.body),
    ...evidence,
  ];
  const evidenceText = block.sourceRefs.map((ref) => normalizeForMatch(ref.quote));
  const seen = new Set<string>();
  const result: GroundedStatement[] = [];
  for (const text of content) {
    const normalized = normalizeForMatch(text);
    if (!normalized || seen.has(normalized)) continue;
    if (!evidenceText.some((quote) => quote.includes(normalized) || normalized.includes(quote))) continue;
    seen.add(normalized);
    result.push({ block, text });
  }
  return result;
}

export function buildFallbackQuestions(input: {
  readonly lesson: GeneratedModule;
}): FallbackQuestionResult {
  const blocks = input.lesson.blocks.filter((block) => block.kind !== 'summary' && block.sourceRefs.length > 0);
  if (!blocks.length) return { kind: 'manual_required', reason: 'NO_GROUNDED_LESSON_BLOCK' };

  const available = blocks.flatMap(statements);
  const seed = available.length ? available : [{ block: blocks[0], text: blocks[0].sourceRefs[0].quote.slice(0, 300) }];
  const questions: GeneratedQuestion[] = Array.from({ length: 3 }, (_, index) => {
    const statement = seed[index % seed.length];
    return {
      localId: `${input.lesson.localId}-fallback-question-${index + 1}`,
      level: statement.block.kind === 'steps' ? 'procedure' : 'recall',
      prompt: PROMPT_FORMS[index](statement.text),
      options: OPTIONS,
      correctOptionId: 'a',
      explanation: 'Đáp án A đúng vì phát biểu được trích trực tiếp từ nội dung bài học đã duyệt.',
      blockIds: [statement.block.localId],
      sourceRefs: statement.block.sourceRefs,
    };
  });
  return { kind: 'draft', questions, provenance: 'fallback' };
}
