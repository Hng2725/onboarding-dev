import { describe, expect, it } from 'vitest';

import {
  OnboardingApiError,
  canUseAiGeneration,
  parseToolResult,
  reconcileDraft,
  resolveHostCapability,
} from '../src/ui/onboarding/api';
import {
  LEARNER_EMPTY_STATE,
  assignmentStatusLabel,
  conclusionLabel,
} from '../src/ui/onboarding/components';
import { routesForAccess } from '../src/ui/onboarding/navigation';

describe('onboarding UI models', () => {
  it('provides the complete Admin navigation', () => {
    expect(routesForAccess('admin').map((item) => item.label)).toEqual([
      'Tổng quan', 'Nhân sự', 'Template', 'Nhận xét tự luận', 'Đánh giá chung',
    ]);
  });

  it('provides the focused Learner navigation', () => {
    expect(routesForAccess('learner').map((item) => item.label)).toEqual([
      'Tổng quan của tôi', 'Nội dung học', 'Kết quả',
    ]);
  });

  it('uses a dedicated Vietnamese state when a Learner has no assignment', () => {
    expect(LEARNER_EMPTY_STATE).toMatchObject({
      title: 'Bạn chưa được gán onboarding',
    });
    expect(LEARNER_EMPTY_STATE.description).toContain('Admin');
  });

  it('maps every assignment state and final conclusion to exact Vietnamese labels', () => {
    expect([
      'assigned', 'in_progress', 'submitted', 'awaiting_essay_feedback', 'awaiting_evaluation',
      'passed', 'failed', 'retry',
    ].map((status) => assignmentStatusLabel(status as Parameters<typeof assignmentStatusLabel>[0]))).toEqual([
      'Đã giao', 'Đang học', 'Đã nộp', 'Chờ nhận xét tự luận', 'Chờ đánh giá chung',
      'Đạt', 'Không đạt', 'Làm lại',
    ]);
    expect(['passed', 'failed', 'retry'].map((value) => conclusionLabel(value as Parameters<typeof conclusionLabel>[0])))
      .toEqual(['Đạt', 'Không đạt', 'Làm lại']);
  });

  it('reconciles local recovery drafts without overwriting a newer server revision', () => {
    expect(reconcileDraft({ revision: 4 }, { revision: 3 })).toBe('server');
    expect(reconcileDraft({ revision: 4 }, { revision: 5 })).toBe('confirm');
    expect(reconcileDraft({ revision: 4 }, { revision: 4 })).toBe('server');
    expect(reconcileDraft(null, { revision: 1 })).toBe('local');
  });

  it('enables AI generation only after the optional host scope is resolved and granted', () => {
    expect(canUseAiGeneration(true, { resolved: false, granted: false })).toBe(false);
    expect(canUseAiGeneration(true, { resolved: true, granted: false })).toBe(false);
    expect(canUseAiGeneration(true, { resolved: true, granted: true })).toBe(true);
    expect(canUseAiGeneration(
      true,
      { resolved: true, granted: false },
      { resolved: true, granted: true },
    )).toBe(true);
    expect(canUseAiGeneration(false, { resolved: true, granted: true })).toBe(false);
  });

  it('derives every AI capability from the same resolved host scope list', () => {
    const effectiveScopes = ['files:read', 'sandbox:generate'];

    expect(resolveHostCapability(effectiveScopes, 'sandbox:generate')).toEqual({
      resolved: true,
      granted: true,
      scope: 'sandbox:generate',
    });
    expect(resolveHostCapability(effectiveScopes, 'sandbox:ai-chat')).toEqual({
      resolved: true,
      granted: false,
      scope: 'sandbox:ai-chat',
    });
    expect(resolveHostCapability(undefined, 'sandbox:generate')).toEqual({
      resolved: false,
      granted: false,
      scope: 'sandbox:generate',
    });
  });

  it('parses JSON text results and rejects malformed or error results', () => {
    expect(parseToolResult<{ ok: boolean }>({ content: [{ type: 'text', text: '{"ok":true}' }] })).toEqual({ ok: true });
    expect(() => parseToolResult({ content: [{ type: 'resource' }] })).toThrow('không hợp lệ');
    expect(() => parseToolResult({ isError: true, content: [{ type: 'text', text: '{"error":"blocked"}' }] }))
      .toThrow('blocked');
    try {
      parseToolResult({
        isError: true,
        content: [{ type: 'text', text: '{"message":"too large","data":{"code":"SOURCE_TOO_LARGE"}}' }],
      });
      throw new Error('Expected typed API error.');
    } catch (error) {
      expect(error).toBeInstanceOf(OnboardingApiError);
      expect(error).toMatchObject({ code: 'SOURCE_TOO_LARGE', message: 'too large' });
    }
    expect(() => parseToolResult({ content: [{ type: 'text', text: 'not-json' }] })).toThrow('JSON');
  });
});
