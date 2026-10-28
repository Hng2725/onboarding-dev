import { describe, expect, it } from 'vitest';

import { sanitizeAiDiagnosticText } from '../src/onboarding/ai/diagnostics';

describe('AI diagnostic sanitization', () => {
  it('redacts JSON, assignment, bearer, and provider-key credential shapes', () => {
    expect(sanitizeAiDiagnosticText(
      '{"token":"opaque-secret","apiKey":"sk-provider-secret","Authorization":"Bearer bearer-secret"} api_key=plain-secret access_token=access-secret',
    )).toBe(
      '{"token":"[REDACTED]","apiKey":"[REDACTED]","Authorization":"[REDACTED]"} api_key=[REDACTED] access_token=[REDACTED]',
    );
  });

  it('keeps ordinary failure context and bounds persisted diagnostics', () => {
    expect(sanitizeAiDiagnosticText('Worker exited with code 1')).toBe('Worker exited with code 1');
    expect(sanitizeAiDiagnosticText('x'.repeat(1_500))).toHaveLength(1_000);
    expect(sanitizeAiDiagnosticText('   ')).toBeUndefined();
  });
});
