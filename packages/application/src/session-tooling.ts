import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionTooling } from '@crewyard/agents';
import { bundledSkillsDir, materializeSkills } from '@crewyard/host-installers';
import type { CrewContext } from '@crewyard/storage';
import pkg from '../../../package.json' with { type: 'json' };
import { crewInvocation } from './service-control.ts';

const PREPARED = new Map<string, SessionTooling>();

export function sessionTooling(ctx: CrewContext): SessionTooling {
  const cached = PREPARED.get(ctx.dirs.data);
  if (cached) return cached;
  const pluginDir = join(ctx.dirs.data, 'runtime', 'agent-skills');
  const skillsDir = join(pluginDir, 'skills');
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true, mode: 0o700 });
  const bundled = bundledSkillsDir();
  if (bundled) cpSync(bundled, skillsDir, { recursive: true });
  else materializeSkills(skillsDir);
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'crewyard', description: 'Crewyard Skills for managed sessions', version: pkg.version })}\n`,
  );
  const tooling = { crewCommand: crewInvocation(), skillsDir: pluginDir };
  PREPARED.set(ctx.dirs.data, tooling);
  return tooling;
}
