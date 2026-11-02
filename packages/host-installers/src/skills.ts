import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RailError, toPosix } from '@agent-rail/core';

export interface SkillFile {
  relativePath: string;
  content: string;
}

export interface SkillSource {
  name: string;
  description: string;
  dir: string;
  files: SkillFile[];
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ALLOWED_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

export function parseSkillFrontmatter(text: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  try {
    const parsed = Bun.YAML.parse(match[1] ?? '');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function validateSkill(directoryName: string, skillMd: string): string[] {
  const front = parseSkillFrontmatter(skillMd);
  if (!front) return ['SKILL.md must start with YAML frontmatter delimited by ---'];
  const issues: string[] = [];
  const { name, description, compatibility, metadata } = front;
  if (typeof name !== 'string' || name.length === 0 || name.length > 64 || !NAME_PATTERN.test(name)) {
    issues.push('name must be 1-64 lowercase letters, digits and single hyphens');
  } else if (name !== directoryName) {
    issues.push(`name "${name}" must match directory "${directoryName}"`);
  }
  if (typeof description !== 'string' || description.trim().length === 0 || description.length > 1024) {
    issues.push('description must be 1-1024 characters');
  }
  if (compatibility !== undefined && (typeof compatibility !== 'string' || compatibility.length > 500)) {
    issues.push('compatibility must be a string of at most 500 characters');
  }
  if (
    metadata !== undefined &&
    (metadata === null ||
      typeof metadata !== 'object' ||
      Object.values(metadata as Record<string, unknown>).some((v) => typeof v !== 'string'))
  ) {
    issues.push('metadata must map string keys to string values');
  }
  for (const key of Object.keys(front)) {
    if (!ALLOWED_FIELDS.has(key)) issues.push(`unknown frontmatter field "${key}"`);
  }
  return issues;
}

function walk(dir: string, root: string, out: SkillFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, out);
    else if (entry.isFile()) {
      const bytes = readFileSync(full);
      if (bytes.includes(0)) {
        throw new RailError('INVALID_INPUT', `Skill file is not text: ${full}`, {
          suggestion: 'Skills installed by Rail must contain text files only.',
        });
      }
      out.push({ relativePath: toPosix(relative(root, full)), content: bytes.toString('utf8') });
    }
  }
}

export function loadSkills(sourceDir: string): SkillSource[] {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new RailError('NOT_FOUND', `Skills directory not found: ${sourceDir}`);
  }
  const skills: SkillSource[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(sourceDir, entry.name);
    const skillMdPath = join(dir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;
    const skillMd = readFileSync(skillMdPath, 'utf8');
    const issues = validateSkill(entry.name, skillMd);
    if (issues.length > 0) {
      throw new RailError('CONFIG_INVALID', `Invalid skill ${entry.name}: ${issues.join('; ')}`, {
        details: { skill: entry.name, issues },
      });
    }
    const files: SkillFile[] = [];
    walk(dir, dir, files);
    const front = parseSkillFrontmatter(skillMd)!;
    skills.push({ name: entry.name, description: String(front.description), dir, files });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function bundledSkillsDir(): string | null {
  const candidate = join(import.meta.dir, '..', '..', '..', 'skills');
  return existsSync(join(candidate, 'rail-execution', 'SKILL.md')) ? candidate : null;
}
