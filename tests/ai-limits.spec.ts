import { describe, expect, it } from 'vitest';

import { AI_GENERATION_LIMITS } from '../src/onboarding/ai/limits';

describe('AI generation limits', () => {
  it('centralizes the evidenced bridge limit and bounded generation defaults', () => {
    expect(AI_GENERATION_LIMITS).toMatchObject({
      maxSourcesPerRoom: 10,
      maxSourceFileBytes: 2 * 1024 * 1024,
      maxNormalizedTextBytes: 512 * 1024,
      maxJobTextBytes: 1024 * 1024,
      maxSectionChars: 4_000,
      maxSystemContextChars: 150_000,
      maxPromptChars: 40_000,
      maxInventoryJsonChars: 150_000,
      maxAiResponseBytes: 1024 * 1024,
      maxTemplateContentBytes: 2 * 1024 * 1024,
      minQuoteChars: 8,
      maxQuoteChars: 300,
      maxRepairAttempts: 2,
      pollIntervalMs: 3_000,
      maxPollMs: 15 * 60_000,
      pumpLeaseMs: 90_000,
      maxClaimsPerVerificationCall: 20,
      normalModuleRange: { min: 4, max: 8 },
      advancedModuleRange: { min: 5, max: 8 },
      questionRange: { min: 3, max: 5 },
      optionCount: 4,
      defaultPassingScore: 70,
      passingScoreRange: { min: 50, max: 100 },
      defaultMaxAttemptsPerModule: 3,
      defaultLearningMode: 'sequential',
      language: 'vi',
    });
    expect(AI_GENERATION_LIMITS.maxClaimsPerVerificationCall).toBeLessThanOrEqual(80);
  });
});
