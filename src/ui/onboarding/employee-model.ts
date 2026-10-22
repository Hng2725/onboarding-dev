import type {
  AssignmentStatus,
  EmployeeRecord,
  EmployeeType,
  TemplateStatus,
} from '../../onboarding/contracts';

export interface MemberRow {
  readonly userId: string;
  readonly username?: string;
  readonly displayName?: string;
}

export interface AssignmentRow {
  readonly id: string;
  readonly memberId: string;
  readonly employeeType: EmployeeType;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateTitle?: string;
  readonly status: AssignmentStatus;
  readonly dueAt?: string;
  readonly assignedAt: string;
  readonly progressPercent?: number;
}

export interface TemplateRow {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly employeeType: EmployeeType;
  readonly status: TemplateStatus;
}

export type EmployeeAttentionStatus =
  | 'needs_essay_feedback'
  | 'needs_evaluation'
  | 'failed'
  | 'overdue'
  | 'active'
  | 'completed'
  | 'not_started';

export interface EmployeeListRow {
  readonly employee: EmployeeRecord;
  readonly member?: MemberRow;
  readonly assignments: readonly AssignmentRow[];
  readonly templateCount: number;
  readonly averageProgress: number;
  readonly attentionStatus: EmployeeAttentionStatus;
  readonly updatedAt: string;
}

export type EmployeeTypeFilter = 'all' | EmployeeType;

function isFinished(status: AssignmentStatus): boolean {
  return status === 'passed' || status === 'failed';
}

function attentionStatus(
  assignments: readonly AssignmentRow[],
  now: Date,
): EmployeeAttentionStatus {
  if (assignments.length === 0) return 'not_started';
  if (assignments.some((item) => item.status === 'awaiting_essay_feedback')) return 'needs_essay_feedback';
  if (assignments.some((item) => item.status === 'awaiting_evaluation')) return 'needs_evaluation';
  if (assignments.some((item) => item.status === 'failed')) return 'failed';
  if (assignments.some((item) => (
    !isFinished(item.status)
    && item.dueAt !== undefined
    && Number.isFinite(new Date(item.dueAt).valueOf())
    && new Date(item.dueAt).valueOf() < now.valueOf()
  ))) return 'overdue';
  if (assignments.some((item) => !isFinished(item.status))) return 'active';
  return 'completed';
}

export function buildEmployeeRows(
  employees: readonly EmployeeRecord[],
  assignments: readonly AssignmentRow[],
  members: readonly MemberRow[],
  now = new Date(),
): readonly EmployeeListRow[] {
  const memberById = new Map(members.map((member) => [member.userId, member]));
  const assignmentsByMember = new Map<string, AssignmentRow[]>();
  for (const assignment of assignments) {
    const current = assignmentsByMember.get(assignment.memberId) ?? [];
    current.push(assignment);
    assignmentsByMember.set(assignment.memberId, current);
  }

  return employees.map((employee): EmployeeListRow => {
    const employeeAssignments = [...(assignmentsByMember.get(employee.memberId) ?? [])]
      .sort((left, right) => right.assignedAt.localeCompare(left.assignedAt));
    const averageProgress = employeeAssignments.length === 0
      ? 0
      : Math.round(employeeAssignments.reduce((sum, item) => sum + (item.progressPercent ?? 0), 0)
        / employeeAssignments.length);
    return {
      employee,
      member: memberById.get(employee.memberId),
      assignments: employeeAssignments,
      templateCount: employeeAssignments.length,
      averageProgress,
      attentionStatus: attentionStatus(employeeAssignments, now),
      updatedAt: employeeAssignments[0]?.assignedAt ?? employee.addedAt,
    };
  }).sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt)
    || left.employee.memberId.localeCompare(right.employee.memberId)
  ));
}

export function filterEmployeeRows(
  rows: readonly EmployeeListRow[],
  query: string,
  employeeType: EmployeeTypeFilter,
): readonly EmployeeListRow[] {
  const needle = query.trim().toLocaleLowerCase('vi');
  return rows.filter((row) => {
    if (employeeType !== 'all' && row.employee.employeeType !== employeeType) return false;
    if (!needle) return true;
    return [row.member?.displayName, row.member?.username, row.employee.memberId]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLocaleLowerCase('vi')
      .includes(needle);
  });
}

export function availableRoomMembers(
  members: readonly MemberRow[],
  employees: readonly EmployeeRecord[],
): readonly MemberRow[] {
  const employeeIds = new Set(employees.map((employee) => employee.memberId));
  return members.filter((member) => !employeeIds.has(member.userId));
}

export function assignableTemplates(
  templates: readonly TemplateRow[],
  employee: EmployeeRecord,
  assignments: readonly AssignmentRow[],
): readonly TemplateRow[] {
  const assigned = new Set(assignments
    .filter((assignment) => assignment.memberId === employee.memberId)
    .map((assignment) => `${assignment.templateId}@${assignment.templateVersion}`));
  return templates.filter((template) => (
    template.status === 'published'
    && template.employeeType === employee.employeeType
    && !assigned.has(`${template.id}@${template.version}`)
  ));
}
