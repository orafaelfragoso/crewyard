import { rmSync } from 'node:fs';
import { registerProject } from '@crewyard/projects';
import { createTempGitRepo, createTestContext, type TestContext } from '../../helpers/index.ts';

export interface IndexFixture {
  ctx: TestContext;
  repoPath: string;
  repositoryId: string;
  projectId: string;
  cleanup(): void;
}

export async function createIndexFixture(files: Record<string, string>): Promise<IndexFixture> {
  const ctx = createTestContext();
  const repoPath = await createTempGitRepo(files);
  const { repository, project } = await registerProject(ctx, {
    repoPath,
    baseBranch: 'main',
    actor: { kind: 'operator', id: 'test' },
  });
  return {
    ctx,
    repoPath,
    repositoryId: repository.id,
    projectId: project.id,
    cleanup() {
      ctx.cleanup();
      rmSync(repoPath, { recursive: true, force: true });
    },
  };
}

export const POLYGLOT_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'poly', scripts: { test: 'bun test', build: 'tsc -b' } }),
  'src/math.ts':
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport interface Shape {\n  area(): number;\n}\n',
  'src/app.ts':
    "import { add, type Shape } from './math.js';\n\nexport class Calculator {\n  total(xs: number[]): number {\n    return xs.reduce((acc, x) => add(acc, x), 0);\n  }\n}\n\nexport const square: Shape = { area: () => add(2, 2) };\n",
  'src/app.test.ts': "import { Calculator } from './app.ts';\n\ntest('total', () => new Calculator().total([1, 2]));\n",
  'py/pkg/__init__.py': '',
  'py/pkg/models.py':
    'class User:\n    def greet(self, name: str) -> str:\n        return f"hi {name}"\n\n\ndef _private():\n    pass\n',
  'py/pkg/service.py': 'from .models import User\nimport os\n\n\ndef make_user() -> User:\n    return User()\n',
  'crate/Cargo.toml': '[package]\nname = "crate-demo"\nversion = "0.1.0"\n',
  'crate/src/lib.rs':
    'pub mod parser;\nuse crate::parser::Token;\n\npub fn first(input: &str) -> Option<Token> {\n    parser::tokenize(input).into_iter().next()\n}\n',
  'crate/src/parser.rs':
    'pub struct Token(pub String);\n\npub fn tokenize(input: &str) -> Vec<Token> {\n    input.split_whitespace().map(|s| Token(s.to_string())).collect()\n}\n',
  'README.md': '# Poly\n\nSee [math](src/math.ts) for arithmetic.\n',
  '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs: {}\n',
};
