import { CoverageGaps, TestSummary } from './types.js';
import { isTestFile, normalize } from './utils.js';
import { getGraphs } from './project.js';

export function getCoverageGaps(
  projectRoot: string,
  { sourceDirs, limit = 50 }: { sourceDirs?: string[]; limit?: number } = {}
): CoverageGaps {
  const { forward } = getGraphs(projectRoot);

  const allFiles = [...forward.keys()];
  const testFiles = allFiles.filter(isTestFile);

  // BFS from all test files to find all reachable source files
  const reachable = new Set<string>(testFiles);
  const queue = [...testFiles];
  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    for (const imp of forward.get(current) ?? []) {
      if (!reachable.has(imp)) {
        reachable.add(imp);
        queue.push(imp);
      }
    }
  }

  const isSource = (f: string): boolean => {
    if (isTestFile(f)) return false;
    if (f.includes('/node_modules/')) return false;
    if (f.endsWith('.d.ts')) return false;
    if (sourceDirs && sourceDirs.length > 0) {
      return sourceDirs.some((dir) => f.startsWith(normalize(dir, projectRoot)));
    }
    return f.startsWith(projectRoot);
  };

  const sourceFiles = allFiles.filter(isSource);
  const uncoveredAll = sourceFiles.filter((f) => !reachable.has(f));

  return {
    uncovered_files: uncoveredAll.slice(0, limit),
    total_source_files: sourceFiles.length,
    total_uncovered: uncoveredAll.length,
    coverage_rate:
      sourceFiles.length > 0
        ? Math.round(((sourceFiles.length - uncoveredAll.length) / sourceFiles.length) * 10000) /
          10000
        : 1,
  };
}

export function getTestSummary(projectRoot: string): TestSummary {
  const { forward, reverse } = getGraphs(projectRoot);

  const allFiles = [...forward.keys()];
  const testFiles = allFiles.filter(isTestFile);
  const sourceFiles = allFiles.filter(
    (f) =>
      !isTestFile(f) &&
      !f.includes('/node_modules/') &&
      !f.endsWith('.d.ts') &&
      f.startsWith(projectRoot)
  );

  const mostImported = sourceFiles
    .map((f) => ({ file: f, imported_by_count: (reverse.get(f) ?? new Set()).size }))
    .filter((x) => x.imported_by_count > 0)
    .sort((a, b) => b.imported_by_count - a.imported_by_count)
    .slice(0, 10);

  const deepestChains = testFiles
    .map((testFile) => {
      const visited = new Set<string>([testFile]);
      let frontier = [testFile];
      let depth = 0;
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const f of frontier) {
          for (const imp of forward.get(f) ?? []) {
            if (!visited.has(imp)) {
              visited.add(imp);
              next.push(imp);
            }
          }
        }
        if (next.length > 0) depth++;
        frontier = next;
      }
      return { test: testFile, depth };
    })
    .sort((a, b) => b.depth - a.depth)
    .slice(0, 10);

  const reachable = new Set<string>(testFiles);
  const queue = [...testFiles];
  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    for (const imp of forward.get(current) ?? []) {
      if (!reachable.has(imp)) {
        reachable.add(imp);
        queue.push(imp);
      }
    }
  }
  const coveredSource = sourceFiles.filter((f) => reachable.has(f)).length;

  return {
    total_source_files: sourceFiles.length,
    total_test_files: testFiles.length,
    covered_source_files: coveredSource,
    coverage_rate:
      sourceFiles.length > 0 ? Math.round((coveredSource / sourceFiles.length) * 10000) / 10000 : 1,
    most_imported_files: mostImported,
    deepest_import_chains: deepestChains,
  };
}
