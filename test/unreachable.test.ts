import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { identifyUnreachableModules } from '../src/analyzer.js';

let testDir: string;

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-unreachable-test-'));

  fs.writeFileSync(
    path.join(testDir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src'] })
  );
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });

  // entry point — imports utils (auto-excluded by index.ts pattern)
  fs.writeFileSync(
    path.join(testDir, 'src/index.ts'),
    `import { helper } from './utils';\nconsole.log(helper());\n`
  );
  // imported by index.ts — reachable
  fs.writeFileSync(
    path.join(testDir, 'src/utils.ts'),
    `export function helper() { return 'ok'; }\n`
  );
  // never imported — dead code
  fs.writeFileSync(
    path.join(testDir, 'src/dead.ts'),
    `export function unused() { return 'nope'; }\n`
  );
  // another dead file
  fs.writeFileSync(path.join(testDir, 'src/orphan.ts'), `export const x = 42;\n`);
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('identifyUnreachableModules', () => {
  it('detects dead files', () => {
    const result = identifyUnreachableModules(testDir);
    expect(result.unreachable_files.some((f) => f.endsWith('dead.ts'))).toBe(true);
    expect(result.unreachable_files.some((f) => f.endsWith('orphan.ts'))).toBe(true);
  });

  it('auto-excludes index.ts as entry point', () => {
    const result = identifyUnreachableModules(testDir);
    expect(result.entry_points_detected.some((f) => f.endsWith('index.ts'))).toBe(true);
    expect(result.unreachable_files.some((f) => f.endsWith('index.ts'))).toBe(false);
  });

  it('does not flag reachable files', () => {
    const result = identifyUnreachableModules(testDir);
    expect(result.unreachable_files.some((f) => f.endsWith('utils.ts'))).toBe(false);
  });

  it('returns correct counts', () => {
    const result = identifyUnreachableModules(testDir);
    expect(result.total_source_files).toBe(4);
    expect(result.total_unreachable).toBe(2);
  });

  it('respects custom entry_points option', () => {
    const result = identifyUnreachableModules(testDir, {
      entryPoints: [path.join(testDir, 'src/dead.ts')],
    });
    expect(result.entry_points_detected.some((f) => f.endsWith('dead.ts'))).toBe(true);
    expect(result.unreachable_files.some((f) => f.endsWith('dead.ts'))).toBe(false);
  });

  it('respects limit option', () => {
    const result = identifyUnreachableModules(testDir, { limit: 1 });
    expect(result.unreachable_files.length).toBe(1);
    expect(result.total_unreachable).toBe(2);
  });
});
