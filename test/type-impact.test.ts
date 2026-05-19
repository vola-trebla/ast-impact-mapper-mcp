import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { differentiateTypeImpact } from '../src/analyzer.js';

let testDir: string;

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-type-impact-test-'));

  fs.writeFileSync(
    path.join(testDir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src', 'test'] })
  );
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(testDir, 'test'), { recursive: true });

  // type-only file — only interfaces and type aliases, no runtime code
  fs.writeFileSync(
    path.join(testDir, 'src/types-only.ts'),
    `export interface User { id: number; name: string; }\nexport type UserId = number;\n`
  );

  // runtime file — has a real function
  fs.writeFileSync(
    path.join(testDir, 'src/runtime.ts'),
    `export function greet(name: string): string { return \`Hello \${name}\`; }\n`
  );

  // test that imports type-only file via regular import
  fs.writeFileSync(
    path.join(testDir, 'test/types-regular.test.ts'),
    `import { User } from '../src/types-only';\nconst u: User = { id: 1, name: 'x' };\n`
  );

  // test that imports type-only file via import type
  fs.writeFileSync(
    path.join(testDir, 'test/types-importtype.test.ts'),
    `import type { User } from '../src/types-only';\nconst u: User = { id: 1, name: 'x' };\n`
  );

  // test that imports runtime file (must always run)
  fs.writeFileSync(
    path.join(testDir, 'test/runtime.test.ts'),
    `import { greet } from '../src/runtime';\nconsole.log(greet('world'));\n`
  );
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('differentiateTypeImpact — type-only file', () => {
  it('classifies type-only file as no runtime impact', () => {
    const result = differentiateTypeImpact(testDir, ['src/types-only.ts']);
    expect(result.files[0].runtime_impact).toBe(false);
    expect(result.files[0].reason).toBe('type_only_change');
  });

  it('marks all consumers as skippable when file is type-only', () => {
    const result = differentiateTypeImpact(testDir, ['src/types-only.ts']);
    expect(result.files[0].affected_tests_must_run).toHaveLength(0);
    expect(result.files[0].affected_tests_skippable.length).toBeGreaterThan(0);
  });

  it('reports total_tests_skippable > 0 and total_tests_must_run = 0', () => {
    const result = differentiateTypeImpact(testDir, ['src/types-only.ts']);
    expect(result.total_tests_must_run).toBe(0);
    expect(result.total_tests_skippable).toBeGreaterThan(0);
  });
});

describe('differentiateTypeImpact — runtime file', () => {
  it('classifies runtime file as having runtime impact', () => {
    const result = differentiateTypeImpact(testDir, ['src/runtime.ts']);
    expect(result.files[0].runtime_impact).toBe(true);
    expect(result.files[0].reason).toBe('runtime_logic_changed');
  });

  it('marks runtime consumers as must-run', () => {
    const result = differentiateTypeImpact(testDir, ['src/runtime.ts']);
    const mustRun = result.files[0].affected_tests_must_run.map((f) => path.basename(f));
    expect(mustRun).toContain('runtime.test.ts');
  });

  it('reports total_tests_must_run > 0', () => {
    const result = differentiateTypeImpact(testDir, ['src/runtime.ts']);
    expect(result.total_tests_must_run).toBeGreaterThan(0);
  });
});

describe('differentiateTypeImpact — import type consumer', () => {
  it('marks import-type consumer as skippable even for runtime file', () => {
    const result = differentiateTypeImpact(testDir, ['src/types-only.ts']);
    const skippable = result.files[0].affected_tests_skippable.map((f) => path.basename(f));
    // Both regular and import-type consumers are skippable because the file is type-only
    expect(skippable).toContain('types-regular.test.ts');
    expect(skippable).toContain('types-importtype.test.ts');
  });
});
