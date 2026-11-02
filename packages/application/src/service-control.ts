import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureDir, isProcessAlive, RailError, run, terminateTree } from '@agent-rail/core';
import { listWorkers, type RailContext, type WorkerHeartbeat } from '@agent-rail/storage';

const SERVICE_LABEL = 'dev.agent-rail.service';

export function railInvocation(): string[] {
  const compiled = Bun.main.includes('$bunfs') || Bun.main.includes('~BUN');
  return compiled ? [process.execPath] : [process.execPath, Bun.main];
}

function pidFile(ctx: RailContext): string {
  return join(ensureDir(ctx.dirs.run), 'service.pid');
}

export interface ServiceStatus {
  running: boolean;
  pid: number | null;
  logFile: string;
  workers: WorkerHeartbeat[];
  note: string;
}

export function serviceStatus(ctx: RailContext): ServiceStatus {
  const file = pidFile(ctx);
  const pid = existsSync(file) ? Number.parseInt(readFileSync(file, 'utf8'), 10) : null;
  const running = pid !== null && isProcessAlive(pid);
  const workers = listWorkers(ctx.store, 'service').filter((w) => w.status === 'running');
  return {
    running: running || workers.some((w) => isProcessAlive(w.pid)),
    pid: running ? pid : null,
    logFile: join(ctx.dirs.logs, 'service.log'),
    workers,
    note:
      running || workers.length > 0
        ? 'Autonomous dispatch, sync and integration are active.'
        : 'No service is running: MCP/CLI calls work, but autonomous work does not continue in the background.',
  };
}

export function startService(ctx: RailContext, options: { dryRun?: boolean } = {}): ServiceStatus & { command: string[] } {
  const current = serviceStatus(ctx);
  const command = [...railInvocation(), 'service', 'run'];
  if (current.running || options.dryRun) return { ...current, command };
  ensureDir(ctx.dirs.logs);
  const log = openSync(current.logFile, 'a', 0o600);
  const child = Bun.spawn(command, {
    stdin: 'ignore',
    stdout: log,
    stderr: log,
    detached: true,
    env: { ...process.env, RAIL_SERVICE_DETACHED: '1' },
  });
  child.unref();
  writeFileSync(pidFile(ctx), String(child.pid), { mode: 0o600 });
  return { ...serviceStatus(ctx), pid: child.pid, running: true, command };
}

export async function stopService(ctx: RailContext, graceMs = 15_000): Promise<{ stopped: boolean; pid: number | null }> {
  const status = serviceStatus(ctx);
  const pids = new Set<number>([...(status.pid ? [status.pid] : []), ...status.workers.map((w) => w.pid)]);
  let stopped = false;
  for (const pid of pids) {
    if (!isProcessAlive(pid)) continue;
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isProcessAlive(pid)) await Bun.sleep(100);
    if (isProcessAlive(pid)) await terminateTree(pid, 1000);
    stopped = true;
  }
  rmSync(pidFile(ctx), { force: true });
  return { stopped, pid: status.pid };
}

export interface ServiceUnitPlan {
  platform: NodeJS.Platform;
  file: string;
  content: string;
  activate: string[][];
  deactivate: string[][];
}

export function planServiceUnit(ctx: RailContext, home = homedir()): ServiceUnitPlan {
  const command = [...railInvocation(), 'service', 'run'];
  const env = { RAIL_DATA_DIR: ctx.dirs.data, RAIL_CONFIG_DIR: ctx.dirs.config };
  if (process.platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    const args = command.map((c) => `    <string>${escapeXml(c)}</string>`).join('\n');
    const envXml = Object.entries(env)
      .map(([k, v]) => `    <key>${k}</key><string>${escapeXml(v)}</string>`)
      .join('\n');
    return {
      platform: 'darwin',
      file,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${escapeXml(join(ctx.dirs.logs, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(ctx.dirs.logs, 'service.log'))}</string>
</dict>
</plist>
`,
      activate: [['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, file]],
      deactivate: [['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}`, file]],
    };
  }
  if (process.platform === 'win32') {
    const file = join(ctx.dirs.config, 'agent-rail-service.xml');
    const [exe, ...args] = command;
    return {
      platform: 'win32',
      file,
      content: `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${escapeXml(exe!)}</Command><Arguments>${escapeXml(args.map((a) => `"${a}"`).join(' '))}</Arguments></Exec>
  </Actions>
</Task>
`,
      activate: [['schtasks', '/Create', '/TN', 'AgentRail', '/XML', file, '/F']],
      deactivate: [['schtasks', '/Delete', '/TN', 'AgentRail', '/F']],
    };
  }
  const file = join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'systemd', 'user', 'agent-rail.service');
  return {
    platform: process.platform,
    file,
    content: `[Unit]
Description=Agent Rail coordination service
After=network-online.target

[Service]
Type=simple
ExecStart=${command.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(' ')}
${Object.entries(env)
  .map(([k, v]) => `Environment=${k}=${v}`)
  .join('\n')}
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
`,
    activate: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'agent-rail.service'],
    ],
    deactivate: [
      ['systemctl', '--user', 'disable', '--now', 'agent-rail.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ],
  };
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export async function installServiceUnit(ctx: RailContext, options: { dryRun?: boolean } = {}) {
  const plan = planServiceUnit(ctx);
  if (options.dryRun) return { ...plan, applied: false };
  if (existsSync(plan.file)) {
    const existing = readFileSync(plan.file, 'utf8');
    if (!existing.includes('agent-rail') && !existing.includes('Agent Rail') && !existing.includes(SERVICE_LABEL)) {
      throw new RailError('CONFLICT', `${plan.file} exists and is not owned by Agent Rail`, { suggestion: 'Move it aside and retry.' });
    }
  }
  mkdirSync(dirname(plan.file), { recursive: true });
  writeFileSync(plan.file, plan.content, { mode: 0o644 });
  const results = [];
  for (const cmd of plan.activate) results.push(await run(cmd, { allowFailure: true, timeoutMs: 30_000 }));
  const failed = results.find((r) => r.exitCode !== 0);
  if (failed) {
    throw new RailError('EXTERNAL_FAILURE', `Service unit written to ${plan.file} but activation failed: ${failed.stderr.trim()}`, {
      suggestion: `Activate manually: ${plan.activate.map((c) => c.join(' ')).join(' && ')}`,
    });
  }
  return { ...plan, applied: true };
}

export async function uninstallServiceUnit(ctx: RailContext, options: { dryRun?: boolean } = {}) {
  const plan = planServiceUnit(ctx);
  if (options.dryRun) return { ...plan, removed: false };
  for (const cmd of plan.deactivate) await run(cmd, { allowFailure: true, timeoutMs: 30_000 });
  const owned = existsSync(plan.file) && /agent-rail|Agent Rail/.test(readFileSync(plan.file, 'utf8'));
  if (owned) rmSync(plan.file);
  return { ...plan, removed: owned };
}
