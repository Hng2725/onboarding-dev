import type { EmployeeType, TemplateResource } from '../../../onboarding/contracts';
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
  readonly batchId?: string;
  readonly targetKey?: string;
  readonly uploadedResources?: Readonly<Record<string, TemplateResource>>;
  readonly kind: EmployeeType;
  readonly review: AdminTemplateDetail;
  readonly preparedReview?: AdminTemplateDetail;
  readonly publishedTemplate?: AdminTemplateDetail;
  readonly jsonExported: boolean;
  readonly phase: AiPublishPhase;
  readonly error?: string;
}

export interface AiPublishBatchDependencies {
  beginBatch?(targets: readonly AiPublishTarget[]): Promise<readonly AiPublishTarget[]>;
  prepareResources(target: AiPublishTarget, checkpoint?: (resources: Readonly<Record<string, TemplateResource>>) => void): Promise<AdminTemplateDetail>;
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
    .map((target): AiPublishTarget => {
      const targetKey = aiPublishTargetKey(target.review);
      const stale = (target.targetKey && target.targetKey !== targetKey)
        || (target.preparedReview && aiPublishTargetKey(target.preparedReview) !== targetKey)
        || (target.publishedTemplate && aiPublishTargetKey(target.publishedTemplate) !== targetKey);
      return stale ? { batchId: target.batchId, kind: target.kind, review: target.review, targetKey, jsonExported: false, phase: 'idle' }
        : { ...target, targetKey };
    })
    .sort((left, right) => left.kind === right.kind ? 0 : left.kind === 'normal' ? -1 : 1);
}

export function restoreAiPublishTarget(review: AdminTemplateDetail, batchId?: string): AiPublishTarget {
  const published = review.status === 'published';
  const jsonExported = published && Boolean(review.content?.publication?.jsonFileId);
  return { batchId, kind: review.employeeType, review, targetKey: aiPublishTargetKey(review),
    uploadedResources: review.content?.publication?.pdfs,
    ...(published ? { preparedReview: review, publishedTemplate: review } : {}),
    jsonExported, phase: jsonExported ? 'completed' : 'idle' };
}

export function aiPublishTargetKey(review: AdminTemplateDetail): string {
  // Include legacy edits and settings, while allowing attachment/checkpoint writes to resume.
  const { publication: _publication, ...content } = review.content ?? {};
  return JSON.stringify({ kind: review.employeeType, id: review.id, version: review.version,
    title: review.title, description: review.description, passingScore: review.passingScore,
    content, modules: review.modules.map(({ resources: _resources, ...module }) => module) });
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

  if (dependencies.beginBatch) {
    try {
      current = orderedTargets(await dependencies.beginBatch(current));
      onUpdate?.(current);
    } catch (error) { fail(0, error); }
    const refreshedBlocked = current.findIndex((target) => !aiReviewReadiness(target.preparedReview ?? target.review).allowed);
    if (refreshedBlocked >= 0) fail(refreshedBlocked, new Error('Còn cờ bắt buộc cần xử lý trước khi xuất bản.'));
  }

  for (let index = 0; index < current.length; index += 1) {
    if (!current[index].preparedReview) {
      update(index, { phase: 'preparing_files', error: undefined });
      try {
        const preparedReview = await dependencies.prepareResources(current[index], (uploadedResources) => update(index, { uploadedResources }));
        update(index, { review: preparedReview, targetKey: aiPublishTargetKey(preparedReview), preparedReview, phase: 'prepared', error: undefined });
      } catch (error) {
        fail(index, error);
      }
    }
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
