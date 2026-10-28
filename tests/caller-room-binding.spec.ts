import { describe, expect, it } from 'vitest';
import type { VerifiedActor } from '@privos_ai/app-server';

import { createOnboardingToolHandler, type OnboardingServiceBundle } from '../src/onboarding/tools';
import { relayMcpHandler } from '../src/relay-transport';

function actorIn(roomId: string | undefined): VerifiedActor {
  return {
    userId: 'member-1',
    roomId,
    claims: Object.freeze({ room_roles: ['member'] }),
    provenance: 'user-token',
  };
}

function unreachableServices(): OnboardingServiceBundle {
  const unreachable = () => Promise.reject(new Error('service should not be reached'));
  return {
    prepare: unreachable,
    listRoomMembers: unreachable,
    employees: { list: unreachable, getByMemberId: unreachable, add: unreachable },
    templates: {
      list: unreachable, getAdminDetail: unreachable, getLearnerSnapshot: unreachable,
      createDraft: unreachable, updateDraft: unreachable, createAiDraft: unreachable,
      updateAiDraft: unreachable, cloneSystemTemplate: unreachable,
      publish: unreachable, archive: unreachable, deleteDraft: unreachable,
    },
    assignments: {
      listAdmin: unreachable, getAdminDetail: unreachable, listMine: unreachable, getMine: unreachable,
      assign: unreachable, markResourceOpened: unreachable, markResourceCompleted: unreachable,
      grantRetry: unreachable, sendDueReminders: unreachable,
    },
    attempts: {
      getOrCreateDraft: unreachable, saveDraft: unreachable, submit: unreachable, getLearnerResult: unreachable,
    },
    reviews: {
      listEssayQueue: unreachable, saveEssayFeedback: unreachable, listEvaluationQueue: unreachable,
      publishEvaluation: unreachable, getPublishedFeedback: unreachable,
    },
    sources: {
      listSources: unreachable, ingestSource: unreachable, addAdminNote: unreachable,
      deleteSource: unreachable, getSourceSection: unreachable,
    },
    aiJobs: {
      startJob: unreachable, listJobs: unreachable, getJob: unreachable, nextStep: unreachable,
      recordDispatch: unreachable, submitAiOutput: unreachable, reportAiFailure: unreachable,
      retryJob: unreachable, cancelJob: unreachable, recordAttemptCleanup: unreachable,
    },
    aiReview: {
      getReview: unreachable, updateReview: unreachable, resolveFlag: unreachable,
    },
    moduleLearning: {
      getModules: unreachable, openModule: unreachable, completeLesson: unreachable,
      startModuleQuiz: unreachable, submitModuleQuiz: unreachable, getModuleAttempt: unreachable,
      grantModuleRetry: unreachable, questionStats: unreachable,
    },
  };
}

describe('onboarding tools are bound to the verified caller and room', () => {
  const handle = createOnboardingToolHandler(unreachableServices);

  it.each([
    ['onboarding_bootstrap', { action: 'load' }],
    ['onboarding_admin_templates', { action: 'list' }],
    ['onboarding_admin_ai', { action: 'list_sources' }],
    ['onboarding_admin_assignments', { action: 'list' }],
    ['onboarding_learning', { action: 'list' }],
    ['onboarding_reviews', { action: 'list_essays' }],
  ])('%s refuses a call with no verified actor', async (name, args) => {
    await expect(handle(name, args)).rejects.toMatchObject({ data: { code: 'IDENTITY_REQUIRED' } });
  });

  it('rejects an actor that is not bound to any room', async () => {
    await expect(handle('onboarding_learning', { action: 'list' }, actorIn(undefined)))
      .rejects.toMatchObject({ data: { code: 'ROOM_UNBOUND' } });
  });

  it('rejects an untrusted member selector before any room service call', async () => {
    await expect(handle(
      'onboarding_learning',
      { action: 'list', memberId: 'member-2', roomId: 'room-b' },
      actorIn('room-a'),
    )).rejects.toMatchObject({ data: { code: 'MEMBER_FORBIDDEN' } });
  });

  it('relay adapter drops an actor whose identity is not verified', async () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'onboarding_learning', arguments: { action: 'list' } },
    };
    const context = {
      transport: 'relay' as const,
      identityState: 'invalid' as const,
      sessionScope: 's',
      actor: actorIn('room-a'),
    };

    await expect(relayMcpHandler(request, context)).rejects.toMatchObject({ data: { code: 'IDENTITY_REQUIRED' } });
  });
});
