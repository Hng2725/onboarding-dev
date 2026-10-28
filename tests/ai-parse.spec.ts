import { describe, expect, it } from 'vitest';

import { AiOutputParseError, parseAiJsonObject } from '../src/onboarding/ai/parse';
import { AI_GENERATION_LIMITS } from '../src/onboarding/ai/limits';

describe('AI JSON parser', () => {
  it('accepts exactly one raw or fenced JSON object', () => {
    expect(parseAiJsonObject('  {"ok":true}  ')).toEqual({ ok: true });
    expect(parseAiJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it.each([
    ['leading prose', 'Here is the result: {"ok":true}'],
    ['trailing prose', '{"ok":true} done'],
    ['multiple objects', '{"a":1} {"b":2}'],
    ['array root', '[{"a":1}]'],
    ['truncated JSON', '{"a":'],
    ['two fenced blocks', '```json\n{"a":1}\n```\n```json\n{"b":2}\n```'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseAiJsonObject(text)).toThrow(AiOutputParseError);
  });

  it('accepts agent narration before the final object only when the transport allows it', () => {
    const transcript = 'File bị cắt ngắn. Đã đọc trọn vẹn dữ liệu {theo yêu cầu}.{"ok":true,"nested":{"a":[1]}}';

    expect(() => parseAiJsonObject(transcript)).toThrow(AiOutputParseError);
    expect(parseAiJsonObject(transcript, { allowLeadingNarration: true }))
      .toEqual({ ok: true, nested: { a: [1] } });
    expect(parseAiJsonObject('Kết quả:\n```json\n{"ok":true}\n```', { allowLeadingNarration: true }))
      .toEqual({ ok: true });
    expect(() => parseAiJsonObject('Xong {"ok":true} rồi nhé', { allowLeadingNarration: true }))
      .toThrow(AiOutputParseError);
    expect(() => parseAiJsonObject('Chưa có kết quả.', { allowLeadingNarration: true }))
      .toThrow(AiOutputParseError);
  });

  it('rejects a response before parsing when its UTF-8 payload exceeds the limit', () => {
    const oversized = '{"value":"' + 'x'.repeat(AI_GENERATION_LIMITS.maxAiResponseBytes) + '"}';
    expect(() => parseAiJsonObject(oversized)).toThrow(expect.objectContaining({
      code: 'AI_OUTPUT_TOO_LARGE',
    }));
  });
});
