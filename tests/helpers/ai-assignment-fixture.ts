import { vi } from 'vitest';

import type { OnboardingActor } from '../../src/onboarding/auth';
import { createAssignmentService } from '../../src/onboarding/assignments';
import { materializeAiTemplate } from '../../src/onboarding/ai/materialize';
import { createEmployeeService } from '../../src/onboarding/employees';
import type { NotificationPort } from '../../src/onboarding/notifications';
import { createTemplateService } from '../../src/onboarding/templates';
import { MemoryOnboardingStore } from './onboarding-memory-store';
import { aiSource, generatedTemplate, seedAiSource } from './ai-template-fixture';

export const moduleAdmin: OnboardingActor = {
  userId: 'admin-1', roomId: 'room-a', access: 'admin',
};
export const moduleLearner: OnboardingActor = {
  userId: 'member-1', roomId: 'room-a', access: 'learner',
};
export const moduleOtherLearner: OnboardingActor = {
  userId: 'member-2', roomId: 'room-a', access: 'learner',
};

export async function seedAiAssignment(maxAttemptsPerModule: number | null = 3) {
  const store = new MemoryOnboardingStore();
  await seedAiSource(store);
  let tick = 0;
  const now = () => `2026-10-23T12:00:${String(++tick).padStart(2, '0')}.000Z`;
  const templates = createTemplateService(store, { now });
  const draft = await materializeAiTemplate(store, templates, moduleAdmin, {
    jobId: 'module-learning-job-' + String(maxAttemptsPerModule),
    promptVersion: '2026-10-23.1',
    templateKind: 'normal',
    generated: generatedTemplate,
    sources: [aiSource],
    maxAttemptsPerModule,
  });
  const published = await templates.publish(moduleAdmin, draft.id, draft.version, draft.updatedAt);
  const callPlatform = vi.fn().mockResolvedValue({ members: [
    { userId: 'admin-1' }, { userId: 'member-1' }, { userId: 'member-2' },
  ] });
  const employees = createEmployeeService(store, { callPlatform, now });
  await employees.add(moduleAdmin, { memberId: moduleLearner.userId, employeeType: 'normal' });
  const deliveries: Array<{ memberId: string; title: string; body: string }> = [];
  const notifications: NotificationPort = {
    async notify(memberId, title, body) {
      deliveries.push({ memberId, title, body });
      return { delivered: true };
    },
  };
  const assignments = createAssignmentService(store, templates, {
    employees,
    callPlatform,
    notifications,
    now,
  });
  const assigned = await assignments.assign(moduleAdmin, {
    memberId: moduleLearner.userId,
    templateId: published.id,
    templateVersion: published.version,
  });
  return {
    store,
    templates,
    assignments,
    assignment: assigned.assignment,
    published,
    notifications,
    deliveries,
    now,
  };
}
