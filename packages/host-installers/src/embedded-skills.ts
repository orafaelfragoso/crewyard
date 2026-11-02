import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import f0 from '../../../skills/crew-context/SKILL.md' with { type: 'text' };
import f1 from '../../../skills/crew-execution/SKILL.md' with { type: 'text' };
import f2 from '../../../skills/crew-integration/SKILL.md' with { type: 'text' };
import f3 from '../../../skills/crew-planning/references/plan-format.md' with { type: 'text' };
import f4 from '../../../skills/crew-planning/SKILL.md' with { type: 'text' };
import f5 from '../../../skills/crew-recovery/SKILL.md' with { type: 'text' };
import f6 from '../../../skills/crew-review/references/finding-format.md' with { type: 'text' };
import f7 from '../../../skills/crew-review/SKILL.md' with { type: 'text' };

export const EMBEDDED_SKILL_FILES: Readonly<Record<string, string>> = {
  'crew-context/SKILL.md': f0,
  'crew-execution/SKILL.md': f1,
  'crew-integration/SKILL.md': f2,
  'crew-planning/references/plan-format.md': f3,
  'crew-planning/SKILL.md': f4,
  'crew-recovery/SKILL.md': f5,
  'crew-review/references/finding-format.md': f6,
  'crew-review/SKILL.md': f7,
};

export function materializeSkills(targetDir: string): string {
  for (const [relative, content] of Object.entries(EMBEDDED_SKILL_FILES)) {
    const path = join(targetDir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return targetDir;
}
