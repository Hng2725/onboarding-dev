import type { EmployeeType } from '../../../onboarding/contracts';
import type { AdminTemplateDetail } from '../../../onboarding/templates';
import { aiReviewReadiness } from './ai-template-batch';

export type AiPublishPhase =
  | 'idle'
  | 'preparing_files'
  | 'prepared'
  | 'publishing'
  | 'exporting'
  | 'completed'
  | 'failed';

export interface AiPublishTarget {
  readonly kind: EmployeeType;
  readonly review: AdminTemplateDetail;
  readonly preparedReview?: AdminTemplateDetail;
  readonly publishedTemplate?: AdminTemplateDetail;
  readonly jsonExported: boolean;
  readonly phase: AiPublishPhase;
  readonly error?: string;
}

export interface AiPublishBatchDependencies {
  prepareResources(target: AiPublishTarget): Promise<AdminTemplateDetail>;
  publish(review: AdminTemplateDetail): Promise<AdminTemplateDetail>;
  exportJson(published: AdminTemplateDetail): Promise<void>;
}

export class AiPublishBatchError extends Error {
  readonly cause: unknown;

  constructor(readonly targets: readonly AiPublishTarget[], cause: unknown) {
    super(cause instanceof Error && cause.message
      ? cause.message
      : 'Không thể hoàn tất xuất bản template AI.');
    this.name = 'AiPublishBatchError';
    this.cause = cause;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Không thể hoàn tất bước xuất bản.';
}

function orderedTargets(targets: readonly AiPublishTarget[]): readonly AiPublishTarget[] {
  return targets
    .map((target) => ({ ...target }))
    .sort((left, right) => left.kind === right.kind ? 0 : left.kind === 'normal' ? -1 : 1);
}

export async function publishAiTemplateBatch(
  targets: readonly AiPublishTarget[],
  dependencies: AiPublishBatchDependencies,
  onUpdate?: (targets: readonly AiPublishTarget[]) => void,
): Promise<readonly AiPublishTarget[]> {
  let current = orderedTargets(targets);

  const update = (index: number, patch: Partial<AiPublishTarget>) => {
    current = current.map((target, targetIndex) => targetIndex === index
      ? { ...target, ...patch }
      : target);
    onUpdate?.(current);
  };
  const fail = (index: number, cause: unknown): never => {
    update(index, { phase: 'failed', error: errorText(cause) });
    throw new AiPublishBatchError(current, cause);
  };

  const blockedIndex = current.findIndex((target) =>
    !aiReviewReadiness(target.preparedReview ?? target.review).allowed);
  if (blockedIndex >= 0) {
    fail(blockedIndex, new Error('Còn cờ bắt buộc cần xử lý trước khi xuất bản.'));
  }

  for (let index = 0; index < current.length; index += 1) {
    if (current[index].preparedReview) continue;
    update(index, { phase: 'preparing_files', error: undefined });
    try {
      const preparedReview = await dependencies.prepareResources(current[index]);
      update(index, { preparedReview, phase: 'prepared', error: undefined });
    } catch (error) {
      fail(index, error);
    }
  }

  for (let index = 0; index < current.length; index += 1) {
    let published = current[index].publishedTemplate;
    if (!published) {
      const prepared = current[index].preparedReview
        ?? fail(index, new Error('Template chưa được chuẩn bị tài liệu.'));
      update(index, { phase: 'publishing', error: undefined });
      try {
        published = await dependencies.publish(prepared);
        update(index, { publishedTemplate: published, phase: 'exporting', error: undefined });
      } catch (error) {
        fail(index, error);
      }
    }

    if (!current[index].jsonExported) {
      const publishedTemplate = published
        ?? fail(index, new Error('Template chưa được xuất bản.'));
      update(index, { phase: 'exporting', error: undefined });
      try {
        await dependencies.exportJson(publishedTemplate);
        update(index, { jsonExported: true, phase: 'completed', error: undefined });
      } catch (error) {
        fail(index, error);
      }
    } else if (current[index].phase !== 'completed') {
      update(index, { phase: 'completed', error: undefined });
    }
  }

  return current;
}
