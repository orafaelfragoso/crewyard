import type { Clock, RailDirs } from '@agent-rail/core';

export const HOST_IDS = ['codex', 'claude', 'opencode'] as const;
export type HostId = (typeof HOST_IDS)[number];

export type InstallScope = 'user' | 'project';
export type ChangePurpose = 'mcp' | 'skill' | 'instructions';

export const RAIL_SERVER_NAME = 'agent-rail';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  argv: readonly string[],
  options: { env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<ExecResult>;

export interface InstallerEnvironment {
  env?: NodeJS.ProcessEnv;
  which?: (binary: string) => string | null;
  exec?: CommandRunner;
  dirs?: RailDirs;
}

export type HostSupport = 'supported' | 'unknown' | 'unsupported';

export interface HostConfigPaths {
  mcpConfig: string;
  skillsDir: string;
}

export interface HostDetection {
  host: HostId;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  testedVersion: string;
  support: HostSupport;
  configPaths: { user: HostConfigPaths; project: HostConfigPaths | null };
  registered: { user: boolean; project: boolean | null };
  notes: string[];
}

export type Ownership =
  | { type: 'marker-block' }
  | { type: 'json-member'; containerKey: string; key: string; value: unknown; createdContainer: boolean }
  | { type: 'file' }
  | { type: 'cli-registration'; name: string; value: unknown };

export interface FileChange {
  kind: 'file';
  path: string;
  hosts: HostId[];
  purpose: ChangePurpose;
  action: 'create' | 'modify' | 'delete';
  before: string | null;
  after: string | null;
  preview: string;
  ownership: Ownership;
  pruneEmptyDirsUpTo?: string;
}

export interface CommandChange {
  kind: 'command';
  hosts: HostId[];
  purpose: 'mcp';
  commands: string[][];
  stateFile: string;
  preview: string;
  ownership: Ownership;
}

export type PlannedChange = FileChange | CommandChange;

export interface ManualInstruction {
  host: HostId;
  purpose: ChangePurpose;
  reason: string;
  path?: string;
  snippet?: string;
  command?: string;
}

export interface InstallPlan {
  kind: 'install' | 'uninstall';
  scope: InstallScope;
  targets: HostId[];
  projectRoot: string | null;
  railCommand: string[];
  changes: PlannedChange[];
  manualInstructions: ManualInstruction[];
  notes: string[];
  hosts: HostDetection[];
}

export interface PlanOptions extends InstallerEnvironment {
  targets: readonly HostId[];
  scope: InstallScope;
  projectRoot?: string;
  railCommand?: readonly string[];
  skillsSourceDir?: string;
  includeInstructions?: boolean;
}

export interface ApplyOptions extends InstallerEnvironment {
  clock?: Clock;
  dryRun?: boolean;
}

export interface ApplyResult {
  dryRun: boolean;
  backupDir: string | null;
  manifestPath: string | null;
  applied: PlannedChange[];
  manualInstructions: ManualInstruction[];
}
