import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrivosAppProvider } from '@privos_ai/app-react';
import { describe, expect, it } from 'vitest';

import { AdminWorkspace, LearnerWorkspace } from '../src/ui/App';
import { AssignmentDialog, type AssignmentDraft } from '../src/ui/onboarding/employees';
import type { AdminBootstrapSummary, OnboardingApi } from '../src/ui/onboarding/api';

const api = {} as OnboardingApi;
const adminSummary: AdminBootstrapSummary = {
  assignmentCount: 0,
  templateCount: 0,
  pendingEssayCount: 0,
  pendingEvaluationCount: 0,
};

function routeTag(markup: string, route: string): string {
  return markup.match(new RegExp(`<section[^>]*data-onboarding-route="${route}"[^>]*>`))?.[0] ?? '';
}

function renderWithPrivos(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(PrivosAppProvider, null, element));
}

describe('eager onboarding route mounting', () => {
  it('mounts every Admin tab immediately and only reveals the active route', () => {
    const markup = renderWithPrivos(createElement(AdminWorkspace, {
      api,
      summary: adminSummary,
      route: 'employees',
      onNavigate: () => undefined,
    }));

    for (const route of ['admin-overview', 'employees', 'templates', 'essay-feedback', 'evaluations']) {
      expect(routeTag(markup, route), route).not.toBe('');
    }
    expect(routeTag(markup, 'employees')).not.toContain('hidden=');
    expect(routeTag(markup, 'templates')).toContain('hidden=""');
  });

  it('mounts every learner tab immediately and only reveals the active route', () => {
    const markup = renderWithPrivos(createElement(LearnerWorkspace, {
      api,
      route: 'my-overview',
      onNavigate: () => undefined,
    }));

    for (const route of ['my-overview', 'my-learning', 'results']) {
      expect(routeTag(markup, route), route).not.toBe('');
    }
    expect(routeTag(markup, 'my-overview')).not.toContain('hidden=');
    expect(routeTag(markup, 'results')).toContain('hidden=""');
  });
});

describe('assignment dialog layout contract', () => {
  it('renders a centered dialog shell with an independently scrollable body', () => {
    const draft: AssignmentDraft = {
      memberId: '',
      employeeType: 'normal',
      templateId: '',
      templateVersion: 0,
    };
    const markup = renderToStaticMarkup(createElement(AssignmentDialog, {
      members: [],
      availableTemplates: [],
      draft,
      issues: [],
      saving: false,
      onPatch: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(markup).toContain('class="assignment-dialog"');
    expect(markup).toContain('class="assignment-dialog-body"');
    expect(markup).toContain('role="dialog"');
    expect(markup).not.toContain('class="side-panel"');
  });
});
