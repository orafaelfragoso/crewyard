import type { approvalClasses } from '@agent-rail/config';
import type { HandoffKind, Risk, TaskOrigin, TaskState, WorkItemKind } from '@agent-rail/core';
import { parseJson } from '@agent-rail/storage';

export type ApprovalClass = (typeof approvalClasses)[number];

export interface TaskBudget {
  tokens?: number;
  costUsd?: number;
}

export interface TestEvidence {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  summary?: string;
  artifactPath?: string;
}

export interface TaskCheckpoint {
  summary: string;
  percent?: number;
  commits?: string[];
  at: string;
  generation: number;
}

export interface TaskApprovalState {
  requiredClasses: ApprovalClass[];
  approvedClasses: ApprovalClass[];
  matches: { class: ApprovalClass; path: string; pattern: string }[];
}

export interface TaskArtifacts {
  worktreePath?: string;
  branch?: string;
  commits?: string[];
  testEvidence?: TestEvidence[];
  contextPackIds?: string[];
  checkpoint?: TaskCheckpoint;
  approval?: TaskApprovalState;
  scopeReason?: string;
}

export interface Handoff {
  kind: HandoffKind;
  summary: string;
  worktreePath: string | null;
  commits: string[];
  testEvidence: TestEvidence[];
  contextPackIds: string[];
  remainingIssues: string[];
  generation: number;
  reportedBy: string;
  reportedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  goalId: string | null;
  parentId: string | null;
  kind: WorkItemKind;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  repositoryId: string | null;
  baseBranch: string | null;
  risk: Risk;
  priority: number;
  priorityOverride: number | null;
  effectivePriority: number;
  scopeHints: string[];
  exclusiveResources: string[];
  permittedTools: string[] | null;
  requestedRole: string | null;
  state: TaskState;
  revision: number;
  budget: TaskBudget | null;
  artifacts: TaskArtifacts;
  origin: TaskOrigin;
  originRef: string | null;
  paused: boolean;
  attempts: number;
  blockerReason: string | null;
  handoff: Handoff | null;
  assignedAgentId: string | null;
  selectedProfileId: string | null;
  selectedModel: string | null;
  routingExplanation: string | null;
  leaseGeneration: number;
  requiresApproval: boolean;
  deadline: string | null;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
}

export interface TaskView extends Task {
  dependencies: string[];
  blockedByDependencies: string[];
}

export interface TaskRow {
  id: string;
  project_id: string;
  goal_id: string | null;
  parent_id: string | null;
  kind: WorkItemKind;
  title: string;
  objective: string;
  acceptance_criteria: string;
  repository_id: string | null;
  base_branch: string | null;
  risk: Risk;
  priority: number;
  priority_override: number | null;
  scope_hints: string;
  exclusive_resources: string;
  permitted_tools: string | null;
  requested_role: string | null;
  state: TaskState;
  revision: number;
  budget: string | null;
  artifacts: string;
  origin: TaskOrigin;
  origin_ref: string | null;
  paused: number;
  attempts: number;
  blocker_reason: string | null;
  handoff: string | null;
  assigned_agent_id: string | null;
  selected_profile_id: string | null;
  selected_model: string | null;
  routing_explanation: string | null;
  lease_generation: number;
  requires_approval: number;
  deadline: string | null;
  created_at: string;
  updated_at: string;
  state_changed_at: string;
}

export function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    goalId: row.goal_id,
    parentId: row.parent_id,
    kind: row.kind,
    title: row.title,
    objective: row.objective,
    acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria, []),
    repositoryId: row.repository_id,
    baseBranch: row.base_branch,
    risk: row.risk,
    priority: row.priority,
    priorityOverride: row.priority_override,
    effectivePriority: row.priority_override ?? row.priority,
    scopeHints: parseJson<string[]>(row.scope_hints, []),
    exclusiveResources: parseJson<string[]>(row.exclusive_resources, []),
    permittedTools: row.permitted_tools === null ? null : parseJson<string[]>(row.permitted_tools, []),
    requestedRole: row.requested_role,
    state: row.state,
    revision: row.revision,
    budget: row.budget === null ? null : parseJson<TaskBudget | null>(row.budget, null),
    artifacts: parseJson<TaskArtifacts>(row.artifacts, {}),
    origin: row.origin,
    originRef: row.origin_ref,
    paused: row.paused === 1,
    attempts: row.attempts,
    blockerReason: row.blocker_reason,
    handoff: parseJson<Handoff | null>(row.handoff, null),
    assignedAgentId: row.assigned_agent_id,
    selectedProfileId: row.selected_profile_id,
    selectedModel: row.selected_model,
    routingExplanation: row.routing_explanation,
    leaseGeneration: row.lease_generation,
    requiresApproval: row.requires_approval === 1,
    deadline: row.deadline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateChangedAt: row.state_changed_at,
  };
}

export type LeaseHolderKind = 'agent' | 'session' | 'operator';

export interface LeaseHolder {
  kind: LeaseHolderKind;
  id: string;
}

export interface LeaseRow {
  id: string;
  task_id: string;
  generation: number;
  holder_kind: LeaseHolderKind;
  holder_id: string;
  token_hash: string;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
  released_at: string | null;
  release_reason: string | null;
}

export interface LeaseInfo {
  id: string;
  taskId: string;
  generation: number;
  holder: LeaseHolder;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
}

export function mapLease(row: LeaseRow): LeaseInfo {
  return {
    id: row.id,
    taskId: row.task_id,
    generation: row.generation,
    holder: { kind: row.holder_kind, id: row.holder_id },
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

export type ReservationMode = 'advisory' | 'exclusive';
export type ReservationSource = 'impact' | 'explicit' | 'config';

export interface ReservationRow {
  id: string;
  task_id: string;
  repository_id: string | null;
  project_id: string;
  lease_generation: number;
  scope: string;
  mode: ReservationMode;
  source: ReservationSource;
  created_at: string;
  released_at: string | null;
}

export interface Reservation {
  id: string;
  taskId: string;
  repositoryId: string | null;
  projectId: string;
  leaseGeneration: number;
  scope: string;
  mode: ReservationMode;
  source: ReservationSource;
  createdAt: string;
  releasedAt: string | null;
}

export function mapReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    taskId: row.task_id,
    repositoryId: row.repository_id,
    projectId: row.project_id,
    leaseGeneration: row.lease_generation,
    scope: row.scope,
    mode: row.mode,
    source: row.source,
    createdAt: row.created_at,
    releasedAt: row.released_at,
  };
}

export type ApprovalSubjectKind = 'goal_plan' | 'task' | 'pr_publish' | 'merge' | 'repo_hooks' | 'cleanup';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRow {
  id: string;
  project_id: string;
  subject_kind: ApprovalSubjectKind;
  subject_id: string;
  reason: string;
  status: ApprovalStatus;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  projectId: string;
  subjectKind: ApprovalSubjectKind;
  subjectId: string;
  reason: string;
  status: ApprovalStatus;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    projectId: row.project_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export const SATISFIED_DEPENDENCY_STATES: ReadonlySet<TaskState> = new Set(['MERGED', 'DONE']);

export function requiresPullRequest(task: Pick<Task, 'kind' | 'repositoryId'>): boolean {
  return task.kind !== 'epic' && task.repositoryId !== null;
}

export function taskSequenceNumber(id: string): number {
  const match = /^TASK-(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function compareTaskIds(a: string, b: string): number {
  return taskSequenceNumber(a) - taskSequenceNumber(b) || (a < b ? -1 : a > b ? 1 : 0);
}
