import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  getGraphs,
  getSymbolDependencyGraph,
  generateSkeletonView,
  generateTestCommand,
  refreshProject,
} from '../src/analyzer.js';

const tempDir = path.resolve('./temp-v3-test');

describe('v0.3.0 Features', () => {
  beforeEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    refreshProject(tempDir);
  });

  it('implements metadata hashing cache & only parses changed files', () => {
    const fileA = path.join(tempDir, 'fileA.ts');
    const fileB = path.join(tempDir, 'fileB.ts');

    fs.writeFileSync(fileA, `import { b } from './fileB';\nexport const a = 1;`, 'utf8');
    fs.writeFileSync(fileB, `export const b = 2;`, 'utf8');

    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowJs: true,
        },
      }),
      'utf8'
    );

    const graphs1 = getGraphs(tempDir);
    expect(graphs1.forward.get(fileA)?.has(fileB)).toBe(true);

    const cachePath = path.join(tempDir, '.ast-mapper-cache', 'cache.json');
    expect(fs.existsSync(cachePath)).toBe(true);
    const cacheContent1 = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    expect(cacheContent1.files[fileA]).toBeDefined();

    refreshProject(tempDir);
    const graphs2 = getGraphs(tempDir);
    expect(graphs2.forward.get(fileA)?.has(fileB)).toBe(true);

    fs.writeFileSync(fileA, `export const a = 1;`, 'utf8');
    refreshProject(tempDir);
    const graphs3 = getGraphs(tempDir);
    expect(graphs3.forward.get(fileA)?.has(fileB)).toBe(false);
  });

  it('generates a skeleton view', () => {
    const file = path.join(tempDir, 'component.ts');
    fs.writeFileSync(
      file,
      `
/**
 * User interface.
 */
export interface User {
  id: string;
  name: string;
}

/**
 * Gets the user details.
 */
export function getUser(id: string): User {
  const result = { id, name: 'Alice' };
  return result;
}

export class Helper {
  private secret = 'shh';
  public getSecret(): string {
    return this.secret;
  }
}
`,
      'utf8'
    );

    const skeleton = generateSkeletonView(tempDir, file, true, false);
    expect(skeleton).toContain('export interface User');
    expect(skeleton).toContain('export function getUser(id: string): User L13-16');
    expect(skeleton).toContain('export class Helper L18-23 {');
    expect(skeleton).toContain('public getSecret(): string L20-22');
    expect(skeleton).not.toContain("const result = { id, name: 'Alice' }");
    expect(skeleton).not.toContain('private secret');
  });

  it('generates test command', () => {
    const fileA = path.join(tempDir, 'fileA.ts');
    const testFile = path.join(tempDir, 'fileA.test.ts');

    fs.writeFileSync(fileA, `export const a = 1;`, 'utf8');
    fs.writeFileSync(testFile, `import { a } from './fileA';`, 'utf8');

    const cmd = generateTestCommand(tempDir, [fileA], 'vitest');
    expect(cmd.command).toContain('npx vitest run fileA.test.ts');
  });

  it('builds symbol dependency graph', () => {
    const fileA = path.join(tempDir, 'fileA.ts');
    const fileB = path.join(tempDir, 'fileB.ts');

    fs.writeFileSync(
      fileA,
      `import { b } from './fileB';\nexport function a() { return b(); }`,
      'utf8'
    );
    fs.writeFileSync(fileB, `export function b() { return 1; }`, 'utf8');

    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowJs: true,
        },
      }),
      'utf8'
    );

    getGraphs(tempDir);

    const graph = getSymbolDependencyGraph(tempDir, fileB, 'b', 'reverse');

    const nodeA = graph.nodes.find((n) => n.name === 'a');
    const nodeB = graph.nodes.find((n) => n.name === 'b');
    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();

    const edge = graph.edges.find((e) => e.from === nodeA!.id && e.to === nodeB!.id);
    expect(edge).toBeDefined();
  });
});
