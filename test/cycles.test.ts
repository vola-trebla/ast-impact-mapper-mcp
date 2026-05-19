import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectArchitecturalCycles } from '../src/analyzer.js';

let testDir: string;

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-cycles-test-'));

  fs.writeFileSync(
    path.join(testDir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src'] })
  );
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });

  // 3-node cycle: a → b → c → a
  fs.writeFileSync(
    path.join(testDir, 'src/a.ts'),
    `import { b } from './b';\nexport const a = b;\n`
  );
  fs.writeFileSync(
    path.join(testDir, 'src/b.ts'),
    `import { c } from './c';\nexport const b = c;\n`
  );
  fs.writeFileSync(
    path.join(testDir, 'src/c.ts'),
    `import { a } from './a';\nexport const c = a;\n`
  );

  // standalone — no cycle
  fs.writeFileSync(path.join(testDir, 'src/standalone.ts'), `export const x = 99;\n`);
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('detectArchitecturalCycles', () => {
  it('detects the 3-node cycle', () => {
    const result = detectArchitecturalCycles(testDir);
    expect(result.total_cycles).toBe(1);
    expect(result.cycles[0].severity).toBe('warning');
    expect(result.cycles[0].chain.length).toBe(3);
  });

  it('includes all cycle files in files_in_cycles', () => {
    const result = detectArchitecturalCycles(testDir);
    const names = result.files_in_cycles.map((f) => path.basename(f));
    expect(names).toContain('a.ts');
    expect(names).toContain('b.ts');
    expect(names).toContain('c.ts');
  });

  it('does not include standalone files in files_in_cycles', () => {
    const result = detectArchitecturalCycles(testDir);
    const names = result.files_in_cycles.map((f) => path.basename(f));
    expect(names).not.toContain('standalone.ts');
  });

  it('produces a deterministic (normalized) chain starting at the smallest path', () => {
    const result = detectArchitecturalCycles(testDir);
    const chain = result.cycles[0].chain;
    const sorted = [...chain].sort();
    expect(chain[0]).toBe(sorted[0]);
  });

  it('does not report the same cycle twice', () => {
    const result = detectArchitecturalCycles(testDir);
    const keys = result.cycles.map((c) => c.chain.join('|'));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
