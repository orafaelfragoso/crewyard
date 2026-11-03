import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SessionTooling } from '@crewyard/agents';
import { sha256 } from '@crewyard/core';
import { bundledSkillsDir, materializeSkills } from '@crewyard/host-installers';
import type { CrewContext } from '@crewyard/storage';
import pkg from '../../../package.json' with { type: 'json' };
import { crewInvocation } from './service-control.ts';

const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json');

function fileDigest(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      const relative = join(prefix, entry.name);
      return entry.isDirectory() ? fileDigest(path, relative) : [`${relative}:${sha256(readFileSync(path))}`];
    });
}

function stageSkills(runtime: string): string {
  const staging = mkdtempSync(join(runtime, '.agent-skills-'));
  const skillsDir = join(staging, 'skills');
  const bundled = bundledSkillsDir();
  if (bundled) cpSync(bundled, skillsDir, { recursive: true });
  else materializeSkills(skillsDir);
  mkdirSync(join(staging, '.claude-plugin'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(staging, PLUGIN_MANIFEST),
    `${JSON.stringify({ name: 'crewyard', description: 'Crewyard Skills for managed sessions', version: pkg.version })}\n`,
  );
  return staging;
}

export function sessionTooling(ctx: CrewContext): SessionTooling {
  const runtime = join(ctx.dirs.data, 'runtime');
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const staging = stageSkills(runtime);
  const pluginDir = join(runtime, `agent-skills-${sha256(fileDigest(staging).join('\n')).slice(0, 16)}`);
  if (existsSync(join(pluginDir, PLUGIN_MANIFEST))) {
    rmSync(staging, { recursive: true, force: true });
  } else {
    try {
      renameSync(staging, pluginDir);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(join(pluginDir, PLUGIN_MANIFEST))) throw error;
    }
  }
  return { crewCommand: crewInvocation(), skillsDir: pluginDir };
}
