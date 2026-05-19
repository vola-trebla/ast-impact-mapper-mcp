import { describe, it, expect } from 'vitest';
import path from 'path';
import { parseNameStatus } from '../src/analyzer.js';

const projectRoot = '/fake/project';
const abs = (rel: string) => path.resolve(projectRoot, rel);

describe('parseNameStatus', () => {
  it('parses modified files', () => {
    const { renamedFiles, changedFilePaths } = parseNameStatus(
      'M\tsrc/utils.ts\nM\tsrc/other.tsx',
      projectRoot,
      90
    );
    expect(renamedFiles).toEqual([]);
    expect(changedFilePaths).toEqual([abs('src/utils.ts'), abs('src/other.tsx')]);
  });

  it('parses added and deleted files', () => {
    const { changedFilePaths } = parseNameStatus('A\tsrc/new.ts\nD\tsrc/old.ts', projectRoot, 90);
    expect(changedFilePaths).toEqual([abs('src/new.ts'), abs('src/old.ts')]);
  });

  it('parses renamed files and uses new path for impact analysis', () => {
    const { renamedFiles, changedFilePaths } = parseNameStatus(
      'R90\tsrc/old-name.ts\tsrc/new-name.ts',
      projectRoot,
      90
    );
    expect(renamedFiles).toEqual([
      { from: abs('src/old-name.ts'), to: abs('src/new-name.ts'), similarity: 90 },
    ]);
    expect(changedFilePaths).toEqual([abs('src/new-name.ts')]);
  });

  it('reads similarity score from rename status code', () => {
    const { renamedFiles } = parseNameStatus('R75\tsrc/a.ts\tsrc/b.ts', projectRoot, 90);
    expect(renamedFiles[0].similarity).toBe(75);
  });

  it('skips non-TypeScript/JavaScript files', () => {
    const { changedFilePaths } = parseNameStatus(
      'M\tREADME.md\nM\tsrc/styles.css\nA\tsrc/app.ts',
      projectRoot,
      90
    );
    expect(changedFilePaths).toEqual([abs('src/app.ts')]);
  });

  it('skips renamed non-TypeScript files', () => {
    const { renamedFiles, changedFilePaths } = parseNameStatus(
      'R90\told.json\tnew.json',
      projectRoot,
      90
    );
    expect(renamedFiles).toEqual([]);
    expect(changedFilePaths).toEqual([]);
  });

  it('handles empty output', () => {
    const { renamedFiles, changedFilePaths } = parseNameStatus('', projectRoot, 90);
    expect(renamedFiles).toEqual([]);
    expect(changedFilePaths).toEqual([]);
  });

  it('handles mixed renames and modifications', () => {
    const output =
      'M\tsrc/utils.ts\nR95\tsrc/helpers/old.ts\tsrc/helpers/new.ts\nA\tsrc/feature.ts';
    const { renamedFiles, changedFilePaths } = parseNameStatus(output, projectRoot, 90);
    expect(renamedFiles).toEqual([
      { from: abs('src/helpers/old.ts'), to: abs('src/helpers/new.ts'), similarity: 95 },
    ]);
    expect(changedFilePaths).toEqual([
      abs('src/utils.ts'),
      abs('src/helpers/new.ts'),
      abs('src/feature.ts'),
    ]);
  });
});
