import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { analyzeApiSurfaceMutation, refreshProject } from '../src/analyzer.js';

let testDir: string;

function git(cmd: string) {
  execSync(cmd, { cwd: testDir, stdio: 'pipe' });
}

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-api-surface-test-'));
  fs.mkdirSync(path.join(testDir, 'src'));

  fs.writeFileSync(
    path.join(testDir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['src'] })
  );

  // Initial commit: function with one param
  fs.writeFileSync(
    path.join(testDir, 'src/api.ts'),
    `export function greet(name: string): string { return 'Hello ' + name; }\n` +
      `export interface Config { timeout: number; }\n`
  );

  git('git init -b main');
  git('git config user.email "test@test.com"');
  git('git config user.name "Test"');
  git('git add -A');
  git('git commit -m "initial"');
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('analyzeApiSurfaceMutation — breaking change', () => {
  beforeAll(() => {
    fs.writeFileSync(
      path.join(testDir, 'src/api.ts'),
      `export function greet(name: string, greeting: string): string { return greeting + ' ' + name; }\n` +
        `export interface Config { timeout: number; }\n`
    );
    refreshProject(testDir);
  });

  it('detects breaking_api_change when required param added', () => {
    const result = analyzeApiSurfaceMutation(testDir, 'src/api.ts');
    expect(result.change_type).toBe('breaking_api_change');
  });

  it('reports signature_changed mutation for the function', () => {
    const result = analyzeApiSurfaceMutation(testDir, 'src/api.ts');
    const sig = result.changed_signatures.find((m) => m.export_name === 'greet');
    expect(sig?.mutation_type).toBe('signature_changed');
    expect(sig?.old_signature).toContain('name');
    expect(sig?.new_signature).toContain('greeting');
  });

  it('includes the changed export in affected_exports', () => {
    const result = analyzeApiSurfaceMutation(testDir, 'src/api.ts');
    expect(result.affected_exports).toContain('greet');
  });

  it('does not flag unchanged interface as mutated', () => {
    const result = analyzeApiSurfaceMutation(testDir, 'src/api.ts');
    const sig = result.changed_signatures.find((m) => m.export_name === 'Config');
    expect(sig).toBeUndefined();
  });
});

describe('analyzeApiSurfaceMutation — internal refactor', () => {
  beforeAll(() => {
    fs.writeFileSync(
      path.join(testDir, 'src/api.ts'),
      `export function greet(name: string): string { return \`Hello, \${name}!\`; }\n` +
        `export interface Config { timeout: number; }\n`
    );
    refreshProject(testDir);
  });

  it('detects internal_refactor when only body changes', () => {
    const result = analyzeApiSurfaceMutation(testDir, 'src/api.ts');
    expect(result.change_type).toBe('internal_refactor');
  });

  it('reports body_only mutation', () => {
    const result = analyzeApiSurfaceMutation(testDir, 'src/api.ts');
    const bodyMut = result.changed_signatures.find((m) => m.mutation_type === 'body_only');
    expect(bodyMut).toBeDefined();
  });

  it('reports empty affected_exports for body-only change', () => {
    const result = analyzeApiSurfaceMutation(testDir, 'src/api.ts');
    expect(result.affected_exports).toHaveLength(0);
  });
});
