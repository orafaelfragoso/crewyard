import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import f0 from '../../../skills/rail-context/SKILL.md' with { type: 'text' };
import f1 from '../../../skills/rail-execution/SKILL.md' with { type: 'text' };
import f2 from '../../../skills/rail-integration/SKILL.md' with { type: 'text' };
import f3 from '../../../skills/rail-planning/references/plan-format.md' with { type: 'text' };
import f4 from '../../../skills/rail-planning/SKILL.md' with { type: 'text' };
import f5 from '../../../skills/rail-recovery/SKILL.md' with { type: 'text' };
import f6 from '../../../skills/rail-review/references/finding-format.md' with { type: 'text' };
import f7 from '../../../skills/rail-review/SKILL.md' with { type: 'text' };

export const EMBEDDED_SKILL_FILES: Readonly<Record<string, string>> = {
  'rail-context/SKILL.md': f0,
  'rail-execution/SKILL.md': f1,
  'rail-integration/SKILL.md': f2,
  'rail-planning/references/plan-format.md': f3,
  'rail-planning/SKILL.md': f4,
  'rail-recovery/SKILL.md': f5,
  'rail-review/references/finding-format.md': f6,
  'rail-review/SKILL.md': f7,
};

export function materializeSkills(targetDir: string): string {
  for (const [relative, content] of Object.entries(EMBEDDED_SKILL_FILES)) {
    const path = join(targetDir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return targetDir;
}
