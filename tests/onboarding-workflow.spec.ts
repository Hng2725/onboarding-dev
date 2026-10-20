import { describe, expect, it } from 'vitest';

import { SYSTEM_TEMPLATES, getSystemTemplate } from '../src/onboarding/system-templates';
import {
  canEvaluateAttempt,
  canUnlockExercise,
  nextAssignmentStatus,
  scoreMultipleChoice,
} from '../src/onboarding/workflow';

const questions = [
  {
    id: 'single',
    type: 'single_choice' as const,
    prompt: 'Chọn một',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    correctOptionIds: ['a'],
  },
  {
    id: 'multiple',
    type: 'multiple_choice' as const,
    prompt: 'Chọn nhiều',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    correctOptionIds: ['a', 'b'],
  },
  { id: 'essay', type: 'essay' as const, prompt: 'Trình bày cách làm' },
];

describe('onboarding workflow', () => {
  it('scores only single-choice and exact-set multiple-choice answers', () => {
    const score = scoreMultipleChoice(questions, [
      { id: 'answer-1', questionId: 'single', selectedOptionIds: ['a'] },
      { id: 'answer-2', questionId: 'multiple', selectedOptionIds: ['b', 'a'] },
      { id: 'answer-3', questionId: 'essay', essayText: 'Nội dung tự luận' },
    ]);

    expect(score).toEqual({
      correctCount: 2,
      totalCount: 2,
      percentage: 100,
      results: [
        { questionId: 'single', correct: true },
        { questionId: 'multiple', correct: true },
      ],
    });

    expect(scoreMultipleChoice(questions, [
      { id: 'answer-1', questionId: 'single', selectedOptionIds: ['a'] },
      { id: 'answer-2', questionId: 'multiple', selectedOptionIds: ['a', 'b', 'c'] },
    ])?.correctCount).toBe(1);
  });

  it('returns null when an exercise contains only essays', () => {
    expect(scoreMultipleChoice([questions[2]], [
      { id: 'answer-3', questionId: 'essay', essayText: 'Đã nộp' },
    ])).toBeNull();
  });

  it('never includes essays in the numeric denominator', () => {
    const score = scoreMultipleChoice([questions[0], questions[2]], [
      { id: 'answer-1', questionId: 'single', selectedOptionIds: ['a'] },
      { id: 'answer-3', questionId: 'essay', essayText: 'Đã nộp' },
    ]);

    expect(score).toMatchObject({ correctCount: 1, totalCount: 1, percentage: 100 });
  });

  it('keeps an exercise locked until every required resource is opened and completed', () => {
    const resources = [
      { id: 'required', title: 'Bắt buộc', kind: 'link' as const, required: true, sourceUrl: 'https://docs.privos.ai/' },
      { id: 'optional', title: 'Tham khảo', kind: 'link' as const, required: false, sourceUrl: 'https://docs.privos.ai/' },
    ];

    expect(canUnlockExercise(resources, [])).toBe(false);
    expect(canUnlockExercise(resources, [
      { resourceId: 'required', openedAt: '2026-10-20T00:00:00.000Z' },
    ])).toBe(false);
    expect(canUnlockExercise(resources, [
      { resourceId: 'required', completedAt: '2026-10-20T00:05:00.000Z' },
    ])).toBe(false);
    expect(canUnlockExercise(resources, [
      {
        resourceId: 'required',
        openedAt: '2026-10-20T00:00:00.000Z',
        completedAt: '2026-10-20T00:05:00.000Z',
      },
    ])).toBe(true);
  });

  it('requires feedback for every submitted essay before overall evaluation', () => {
    const answers = [
      { id: 'essay-answer', questionId: 'essay', essayText: 'Câu trả lời' },
    ];

    expect(canEvaluateAttempt(questions, answers, [])).toBe(false);
    expect(canEvaluateAttempt(questions, answers, [{
      id: 'feedback',
      answerId: 'essay-answer',
      comment: 'Nhận xét',
      reviewed: true,
      reviewerId: 'admin',
      reviewedAt: '2026-10-20T01:00:00.000Z',
    }])).toBe(true);
  });

  it('maps conclusions to passed failed and retry assignment states', () => {
    expect(nextAssignmentStatus({ currentStatus: 'awaiting_evaluation', conclusion: 'passed' })).toBe('passed');
    expect(nextAssignmentStatus({ currentStatus: 'awaiting_evaluation', conclusion: 'failed' })).toBe('failed');
    expect(nextAssignmentStatus({ currentStatus: 'awaiting_evaluation', conclusion: 'retry' })).toBe('retry');
  });

  it('ships immutable normal and advanced PrivOS templates at version 1', () => {
    expect(SYSTEM_TEMPLATES.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: 'privos-foundations', version: 1 },
      { id: 'privos-advanced', version: 1 },
    ]);

    expect(SYSTEM_TEMPLATES[0].modules.map((module) => module.key)).toEqual([
      'welcome', 'account', 'rooms', 'files', 'lists', 'notifications-and-apps',
    ]);
    expect(SYSTEM_TEMPLATES[1].modules.map((module) => module.key)).toEqual([
      'sandbox', 'bots', 'ai-workflows', 'app-permissions', 'room-isolation',
    ]);

    for (const template of SYSTEM_TEMPLATES) {
      expect(template.source).toBe('system');
      expect(template.status).toBe('published');
      expect(Object.isFrozen(template)).toBe(true);
      expect(Object.isFrozen(template.modules)).toBe(true);
      for (const module of template.modules) {
        expect(module.resources.length).toBeGreaterThan(0);
        expect(module.resources.every((resource) => resource.sourceUrl?.startsWith('https://docs.privos.ai/'))).toBe(true);
        expect(module.questions.length).toBeGreaterThan(0);
        expect(Object.isFrozen(module.resources)).toBe(true);
        expect(Object.isFrozen(module.questions)).toBe(true);
      }
    }

    const title = SYSTEM_TEMPLATES[0].modules[0].title;
    expect(() => {
      (SYSTEM_TEMPLATES[0].modules as unknown as Array<unknown>).push({});
    }).toThrow();
    expect(SYSTEM_TEMPLATES[0].modules[0].title).toBe(title);
    expect(getSystemTemplate('privos-foundations', 1)).toBe(SYSTEM_TEMPLATES[0]);
    expect(getSystemTemplate('missing', 1)).toBeUndefined();
  });
});
