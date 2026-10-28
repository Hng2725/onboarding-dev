import { callAppPlatformTool } from '../app-platform-tool-call';

export interface OnboardingFieldDefinition {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'datetime' | 'json' | 'string[]';
  readonly required?: boolean;
  readonly maxLength?: number;
}

export interface OnboardingIndexDefinition {
  readonly name: string;
  readonly fields: Readonly<Record<string, 1 | -1>>;
  readonly unique?: boolean;
}

export interface OnboardingCollectionDefinition {
  readonly collection: string;
  readonly scope: 'room';
  readonly fields: readonly OnboardingFieldDefinition[];
  readonly indexes: readonly OnboardingIndexDefinition[];
}

const field = (
  name: string,
  type: OnboardingFieldDefinition['type'] = 'string',
  required = false,
): OnboardingFieldDefinition => ({ name, type, required });

const index = (
  name: string,
  fields: readonly string[],
  unique = false,
): OnboardingIndexDefinition => ({
  name,
  // PrivOS forwards this Mongo-compatible direction map as the index key specification.
  fields: Object.fromEntries(fields.map((fieldName) => [fieldName, 1])) as Record<string, 1>,
  unique,
});

const collection = (
  name: string,
  fields: readonly OnboardingFieldDefinition[],
  indexes: readonly OnboardingIndexDefinition[],
): OnboardingCollectionDefinition => ({ collection: name, scope: 'room', fields, indexes });

export const ONBOARDING_COLLECTIONS: readonly OnboardingCollectionDefinition[] = [
  collection('onboarding_templates', [
    field('templateId', 'string', true), field('title', 'string', true), field('description'),
    field('employeeType', 'string', true), field('status', 'string', true), field('version', 'number', true),
    field('passingScore', 'number'), field('maxAttempts', 'number'), field('createdBy', 'string', true),
    field('publishedAt', 'datetime'), field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true),
    field('deletedAt', 'datetime'),
  ], [
    index('templates_id_version_unique', ['templateId', 'version'], true),
    index('templates_status_type', ['status', 'employeeType']),
  ]),
  collection('onboarding_modules', [
    field('templateId', 'string', true), field('templateVersion', 'number', true),
    field('moduleId', 'string', true), field('key', 'string', true), field('title', 'string', true),
    field('description'), field('order', 'number', true), field('createdAt', 'datetime', true),
    field('updatedAt', 'datetime', true), field('deletedAt', 'datetime'),
  ], [
    index('modules_template_order_unique', ['templateId', 'templateVersion', 'order'], true),
    index('modules_template_key_unique', ['templateId', 'templateVersion', 'key'], true),
  ]),
  collection('onboarding_resources', [
    field('moduleId', 'string', true), field('resourceId', 'string', true), field('kind', 'string', true),
    field('title', 'string', true), field('description'), field('fileId'), field('url'),
    field('required', 'boolean', true), field('order', 'number', true),
    field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true), field('deletedAt', 'datetime'),
  ], [
    index('resources_module_order_unique', ['moduleId', 'order'], true),
    index('resources_module_id_unique', ['moduleId', 'resourceId'], true),
  ]),
  collection('onboarding_questions', [
    field('moduleId', 'string', true), field('questionId', 'string', true), field('type', 'string', true),
    field('prompt', 'string', true), field('options', 'json'), field('correctOptionIds', 'string[]'),
    field('explanation'), field('required', 'boolean', true), field('order', 'number', true),
    field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true), field('deletedAt', 'datetime'),
  ], [
    index('questions_module_order_unique', ['moduleId', 'order'], true),
    index('questions_module_id_unique', ['moduleId', 'questionId'], true),
  ]),
  collection('onboarding_employees', [
    field('memberId', 'string', true), field('employeeType', 'string', true),
    field('addedBy', 'string', true), field('addedAt', 'datetime', true),
    field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true),
  ], [
    index('employees_member_unique', ['memberId'], true),
  ]),
  collection('onboarding_assignments', [
    field('memberId', 'string', true), field('employeeType', 'string', true),
    field('templateSource', 'string', true), field('templateId', 'string', true),
    field('templateVersion', 'number', true), field('templateSnapshot', 'json', true),
    field('dueAt', 'datetime'), field('status', 'string', true), field('attemptLimit', 'number'),
    field('allowedAttempts', 'number', true), field('activeAttemptId'), field('assignedBy', 'string', true),
    field('assignedAt', 'datetime', true), field('createdAt', 'datetime', true),
    field('updatedAt', 'datetime', true), field('deletedAt', 'datetime'),
  ], [
    index('assignments_member_status', ['memberId', 'status']),
    index('assignments_template_version', ['templateId', 'templateVersion']),
    index('assignments_due_status', ['dueAt', 'status']),
  ]),
  collection('onboarding_material_progress', [
    field('assignmentId', 'string', true), field('moduleId', 'string', true),
    field('resourceId', 'string', true), field('memberId', 'string', true),
    field('openedAt', 'datetime'), field('completedAt', 'datetime'),
    field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true),
  ], [
    index('progress_assignment_resource_unique', ['assignmentId', 'resourceId'], true),
    index('progress_member_assignment', ['memberId', 'assignmentId']),
  ]),
  collection('onboarding_attempts', [
    field('assignmentId', 'string', true), field('memberId', 'string', true),
    field('ordinal', 'number', true), field('status', 'string', true), field('operationId'),
    field('submissionHash'), field('mcScore', 'json'), field('submittedAt', 'datetime'),
    field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true), field('deletedAt', 'datetime'),
  ], [
    index('attempts_assignment_ordinal_unique', ['assignmentId', 'ordinal'], true),
    index('attempts_operation', ['operationId']),
    index('attempts_member_status', ['memberId', 'status']),
  ]),
  collection('onboarding_answers', [
    field('attemptId', 'string', true), field('questionId', 'string', true),
    field('selectedOptionIds', 'string[]'), field('essayText'), field('submittedAt', 'datetime'),
    field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true), field('deletedAt', 'datetime'),
  ], [
    index('answers_attempt_question_unique', ['attemptId', 'questionId'], true),
  ]),
  collection('onboarding_essay_feedback', [
    field('attemptId', 'string', true), field('answerId', 'string', true), field('comment', 'string', true),
    field('reviewedBy', 'string', true), field('reviewedAt', 'datetime', true),
    field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true),
  ], [
    index('feedback_attempt_answer_unique', ['attemptId', 'answerId'], true),
    index('feedback_reviewer_time', ['reviewedBy', 'reviewedAt']),
  ]),
  collection('onboarding_evaluations', [
    field('assignmentId', 'string', true), field('attemptId', 'string', true),
    field('completionLevel', 'string', true), field('strengths', 'string', true),
    field('improvements', 'string', true), field('comment', 'string', true),
    field('conclusion', 'string', true), field('evaluatedBy', 'string', true),
    field('evaluatedAt', 'datetime', true), field('operationId', 'string', true),
    field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true),
  ], [
    index('evaluations_attempt_unique', ['attemptId'], true),
    index('evaluations_operation_unique', ['operationId'], true),
    index('evaluations_assignment', ['assignmentId']),
  ]),
  collection('onboarding_audit_events', [
    field('actorId', 'string', true), field('action', 'string', true),
    field('targetType', 'string', true), field('targetId', 'string', true),
    field('metadata', 'json'), field('operationId'), field('occurredAt', 'datetime', true),
  ], [
    index('audit_target_time', ['targetType', 'targetId', 'occurredAt']),
    index('audit_actor_time', ['actorId', 'occurredAt']),
    index('audit_operation', ['operationId']),
  ]),
  collection('onboarding_sources', [
    field('sourceId', 'string', true), field('kind', 'string', true),
    field('fileId'), field('fileName', 'string', true), field('mimeType'),
    field('checksum', 'string', true), field('systemName', 'string', true),
    field('softwareVersion'), field('effectiveDate'), field('status', 'string', true),
    field('errorCode'), field('sections', 'json'), field('textLength', 'number'),
    field('createdBy', 'string', true), field('createdAt', 'datetime', true),
    field('updatedAt', 'datetime', true), field('deletedAt', 'datetime'),
  ], [
    index('sources_source_id_unique', ['sourceId'], true),
    index('sources_checksum', ['checksum']),
  ]),
  collection('onboarding_ai_jobs', [
    field('jobId', 'string', true), field('kind', 'string', true),
    field('status', 'string', true), field('templateKind'), field('roleProfile', 'json'),
    field('title'), field('sourceIds', 'string[]'), field('inventoryJobId'),
    field('promptVersion', 'string', true), field('calls', 'json'),
    field('stageOutputs', 'json'), field('result', 'json'),
    field('pumpLeaseUntil', 'datetime'), field('pumpedBy'), field('errorCode'),
    field('errorMessage'), field('operationId', 'string', true),
    field('createdBy', 'string', true), field('createdAt', 'datetime', true),
    field('updatedAt', 'datetime', true),
  ], [
    index('ai_jobs_job_id_unique', ['jobId'], true),
    index('ai_jobs_status_time', ['status', 'createdAt']),
    index('ai_jobs_operation', ['operationId']),
  ]),
  collection('onboarding_template_content', [
    field('templateId', 'string', true), field('templateVersion', 'number', true),
    field('content', 'json', true), field('flags', 'json', true),
    field('roleProfile', 'json'), field('sourceIds', 'string[]'),
    field('jobId', 'string', true), field('promptVersion'),
    field('generationNotes', 'json'), field('createdAt', 'datetime', true),
    field('updatedAt', 'datetime', true),
  ], [
    index('template_content_unique', ['templateId', 'templateVersion'], true),
  ]),
  collection('onboarding_module_progress', [
    field('assignmentId', 'string', true), field('memberId', 'string', true),
    field('moduleId', 'string', true), field('openedAt', 'datetime'),
    field('lessonCompletedAt', 'datetime'), field('passedAt', 'datetime'),
    field('attemptCount', 'number', true), field('bestScore', 'number'),
    field('extraAttempts', 'number', true), field('createdAt', 'datetime', true),
    field('updatedAt', 'datetime', true),
  ], [
    index('module_progress_unique', ['assignmentId', 'moduleId'], true),
    index('module_progress_member', ['memberId', 'assignmentId']),
  ]),
  collection('onboarding_module_attempts', [
    field('assignmentId', 'string', true), field('memberId', 'string', true),
    field('moduleId', 'string', true), field('ordinal', 'number', true),
    field('status', 'string', true), field('questionOrder', 'string[]'),
    field('optionOrder', 'json'), field('answers', 'json'),
    field('correctCount', 'number'), field('totalCount', 'number'),
    field('score', 'number'), field('passed', 'boolean'), field('operationId'),
    field('startedAt', 'datetime'), field('submittedAt', 'datetime'),
    field('createdAt', 'datetime', true), field('updatedAt', 'datetime', true),
  ], [
    index('module_attempts_ordinal_unique', ['assignmentId', 'moduleId', 'ordinal'], true),
    index('module_attempts_operation', ['operationId']),
    index('module_attempts_member', ['memberId', 'assignmentId']),
  ]),
] as const;

export type OnboardingCollectionName = typeof ONBOARDING_COLLECTIONS[number]['collection'];

export async function ensureOnboardingSchema(roomId: string): Promise<void> {
  for (const definition of ONBOARDING_COLLECTIONS) {
    try {
      await callAppPlatformTool(
        'mcpapp.db.registerCollection',
        definition as unknown as Record<string, unknown>,
        'db:schema:write',
        roomId,
        { replaySafe: true },
      );
    } catch (error) {
      const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
      const message = [record?.message, record?.error, String(error)]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      if (!message.includes('already registered')) throw error;
    }
    await callAppPlatformTool(
      'mcpapp.db.getSchema',
      { collection: definition.collection },
      'db:schema:read',
      roomId,
      { replaySafe: true },
    );
  }
}
