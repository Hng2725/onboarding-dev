import type { McpApp } from '@privos_ai/app-react';

import type { AssignmentStatus, FinalConclusion } from '../../onboarding/contracts';
import type { OnboardingAccess } from './navigation';

interface ToolContent {
  readonly type?: string;
  readonly text?: string;
}

export interface ToolResult {
  readonly isError?: boolean;
  readonly content?: readonly ToolContent[];
}

export interface BootstrapCapabilities {
  readonly canManageTemplates: boolean;
  readonly canAssignMembers: boolean;
  readonly canReview: boolean;
  readonly canLearn: boolean;
  readonly canUploadFiles: boolean;
  readonly notifications: 'best_effort';
}

export interface AdminBootstrapSummary {
  readonly assignmentCount: number;
  readonly templateCount: number;
  readonly pendingEssayCount: number;
  readonly pendingEvaluationCount: number;
}

export interface LearnerBootstrapSummary {
  readonly assignmentCount: number;
  readonly activeCount: number;
  readonly completedCount: number;
}

export interface BootstrapResult {
  readonly role: OnboardingAccess;
  readonly roomId: string;
  readonly identity: { readonly userId: string; readonly username: string };
  readonly capabilities: BootstrapCapabilities;
  readonly summary: AdminBootstrapSummary | LearnerBootstrapSummary;
}

export interface RecoveryDraft {
  readonly revision: number;
  readonly assignmentId?: string;
  readonly attemptId?: string;
  readonly answers?: readonly unknown[];
  readonly savedAt?: string;
}

export type DraftDecision = 'server' | 'local' | 'confirm';

export function reconcileDraft(
  serverDraft: Pick<RecoveryDraft, 'revision'> | null,
  localDraft: Pick<RecoveryDraft, 'revision'> | null,
): DraftDecision {
  if (!serverDraft && localDraft) return 'local';
  if (!localDraft) return 'server';
  if (!serverDraft) return 'local';
  return localDraft.revision > serverDraft.revision ? 'confirm' : 'server';
}

function errorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return [record.error, record.message].find((candidate): candidate is string => typeof candidate === 'string');
}

export function parseToolResult<T>(result: ToolResult): T {
  const text = result?.content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  if (!text) throw new Error('Kết quả từ PrivOS không hợp lệ.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Kết quả JSON từ PrivOS không hợp lệ.');
  }
  if (result.isError) throw new Error(errorMessage(parsed) ?? 'Yêu cầu onboarding thất bại.');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Kết quả từ PrivOS không hợp lệ.');
  }
  return parsed as T;
}

const RECOVERY_PREFIX = 'onboarding:recovery:';

export class OnboardingApi {
  constructor(private readonly app: McpApp) {}

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return parseToolResult<T>(await this.app.callServerTool({ name, arguments: args }));
  }

  async bootstrap(): Promise<BootstrapResult> {
    // `bot:room:join` authorizes this idempotent join for the installation-owned service bot.
    await this.call<Record<string, unknown>>('mcpapp.bot.joinCurrentRoom', {});
    return this.call('onboarding_bootstrap', { action: 'load' });
  }

  adminTemplates<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.call('onboarding_admin_templates', { ...args, action });
  }

  adminAssignments<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.call('onboarding_admin_assignments', { ...args, action });
  }

  learning<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.call('onboarding_learning', { ...args, action });
  }

  reviews<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.call('onboarding_reviews', { ...args, action });
  }

  async readRecoveryDraft(assignmentId: string): Promise<RecoveryDraft | null> {
    const value = await this.app.storage.get(`${RECOVERY_PREFIX}${assignmentId}`);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as RecoveryDraft;
      return Number.isInteger(parsed.revision) ? parsed : null;
    } catch {
      return null;
    }
  }

  saveRecoveryDraft(assignmentId: string, draft: RecoveryDraft): Promise<void> {
    return this.app.storage.set(`${RECOVERY_PREFIX}${assignmentId}`, JSON.stringify(draft));
  }

  clearRecoveryDraft(assignmentId: string): Promise<void> {
    return this.app.storage.remove(`${RECOVERY_PREFIX}${assignmentId}`);
  }
}

export type { AssignmentStatus, FinalConclusion };
