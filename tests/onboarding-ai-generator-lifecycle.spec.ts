import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { AiJobRecord } from '../src/onboarding/contracts';

const host = vi.hoisted(() => ({
  appRevision: 0,
  apps: [{ revision: 0 }, { revision: 1 }],
  context: {
    userId: 'admin-1',
    username: 'admin',
    theme: 'dark',
    roomId: 'room-1',
    roomName: 'AI room',
    userRoles: ['admin'],
    effectiveScopes: ['sandbox:generate', 'sandbox:ai-chat', 'sandbox:ai-chat:write'],
    roomSlug: 'ai-room',
    appId: 'onboarding',
    appUrl: 'about:srcdoc',
    themeTokens: {},
  },
}));

vi.mock('@privos_ai/app-react', () => ({
  usePrivosApp: () => host.apps[host.appRevision],
  usePrivosContext: () => host.context,
}));

import { AiGeneratorPage } from '../src/ui/onboarding/ai/ai-generator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const inventoryJob: AiJobRecord = {
  id: 'inventory-row',
  roomId: 'room-1',
  jobId: 'inventory-1',
  kind: 'inventory',
  status: 'completed',
  sourceIds: ['source-1'],
  promptVersion: 'test',
  calls: [],
  stageOutputs: {},
  result: { features: [], glossary: [], conflicts: [] },
  operationId: 'inventory-operation',
  createdBy: 'admin-1',
  createdAt: '2026-10-27T08:00:00.000Z',
  updatedAt: '2026-10-27T08:01:00.000Z',
};

const failedTemplateJob: AiJobRecord = {
  id: 'template-row',
  roomId: 'room-1',
  jobId: 'template-1',
  kind: 'template',
  status: 'failed',
  templateKind: 'advanced',
  roleProfile: {
    department: 'other',
    departmentLabel: 'Vận hành khách hàng',
    jobTitle: 'Chuyên viên vận hành',
    responsibilities: [
      'Xử lý sự cố khách hàng theo đúng quy trình',
      'Bảo đảm an toàn khi làm việc từ xa',
    ],
  },
  sourceIds: ['source-1'],
  inventoryJobId: inventoryJob.jobId,
  promptVersion: 'test',
  calls: [],
  stageOutputs: {},
  errorCode: 'AI_FAILED',
  errorMessage: 'Sandbox worker failed.',
  operationId: 'template-operation',
  createdBy: 'admin-1',
  createdAt: '2026-10-27T08:02:00.000Z',
  updatedAt: '2026-10-27T08:03:00.000Z',
};

describe('AI generator lifecycle', () => {
  it('restores a failed job even when the host returns a new app facade during an unrelated render', async () => {
    host.appRevision = 0;
    const jobRequests: Array<ReturnType<typeof deferred<{ jobs: readonly AiJobRecord[] }>>> = [];
    const api = {
      adminAi: vi.fn(async (action: string) => {
        if (action === 'list_sources') {
          return {
            sources: [{
              id: 'source-row',
              roomId: 'room-1',
              sourceId: 'source-1',
              kind: 'document',
              fileName: 'guide.pdf',
              mimeType: 'application/pdf',
              checksum: 'checksum',
              systemName: 'Guide',
              status: 'ready',
              textLength: 100,
              createdBy: 'admin-1',
              createdAt: '2026-10-27T07:00:00.000Z',
              updatedAt: '2026-10-27T07:00:00.000Z',
            }],
          };
        }
        if (action === 'list_jobs') {
          const request = deferred<{ jobs: readonly AiJobRecord[] }>();
          jobRequests.push(request);
          return request.promise;
        }
        throw new Error('Unexpected action: ' + action);
      }),
    };
    const Harness = ({ tick }: { tick: number }) => createElement('div', { 'data-tick': tick },
      createElement(AiGeneratorPage, {
        api: api as never,
        canGenerateWithAi: true,
        onClose: () => undefined,
        onComplete: () => undefined,
      }));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, { tick: 0 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      host.appRevision = 1;
      renderer.update(createElement(Harness, { tick: 1 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      jobRequests[0].resolve({ jobs: [failedTemplateJob, inventoryJob] });
      await Promise.resolve();
      await Promise.resolve();
    });

    const textarea = renderer.root.findByType('textarea');
    expect(textarea.props.value).toBe(failedTemplateJob.roleProfile?.responsibilities.join('\n'));
    expect(renderer.root.findAllByType('select')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Chức danh');
    const [retryButton] = renderer.root.findAllByProps({ className: 'button button-primary' });
    expect(retryButton).toBeDefined();
    expect(retryButton.props.disabled).toBe(false);
    renderer.unmount();
  });
});
