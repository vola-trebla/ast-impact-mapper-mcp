import { Project } from 'ts-morph';
import path from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import {
  AffectedTestsResult,
  FileDependencies,
  ImpactExplanation,
  CoverageGaps,
  TestSummary,
  RenameAwareDiffResult,
} from './types.js';

const projectCache = new Map<string, Project>();
const graphCache = new Map<
  string,
  { forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> }
>();

function getProject(projectRoot: string): Project {
  const cached = projectCache.get(projectRoot);
  if (cached) return cached;

  const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
  // allowJs lets ts-morph resolve .js/.jsx imports even in TS projects
  const project = existsSync(tsConfigPath)
    ? new Project({
        tsConfigFilePath: tsConfigPath,
        skipAddingFilesFromTsConfig: false,
        compilerOptions: { allowJs: true },
      })
    : new Project({ compilerOptions: { allowJs: true } });

  if (!existsSync(tsConfigPath)) {
    project.addSourceFilesAtPaths(`${projectRoot}/**/*.{ts,tsx,js,jsx}`);
  }

  projectCache.set(projectRoot, project);
  return project;
}

function getGraphs(projectRoot: string): {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
} {
  const cached = graphCache.get(projectRoot);
  if (cached) return cached;

  const project = getProject(projectRoot);
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (!forward.has(filePath)) forward.set(filePath, new Set());

    for (const decl of sourceFile.getImportDeclarations()) {
      const resolved = decl.getModuleSpecifierSourceFile();
      if (!resolved) continue;
      const resolvedPath = resolved.getFilePath();

      forward.get(filePath)!.add(resolvedPath);

      if (!reverse.has(resolvedPath)) reverse.set(resolvedPath, new Set());
      reverse.get(resolvedPath)!.add(filePath);
    }
  }

  const graphs = { forward, reverse };
  graphCache.set(projectRoot, graphs);
  return graphs;
}

function isTestFile(filePath: string): boolean {
  return /\.(spec|test)\.(ts|tsx|js|jsx)$/.test(filePath) || /\/__tests__\//.test(filePath);
}

function normalize(filePath: string, projectRoot: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
}

export function parseGitDiff(projectRoot: string, gitDiff: string): string[] {
  return gitDiff
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /\.(ts|tsx|js|jsx)$/.test(line))
    .map((line) => normalize(line, projectRoot))
    .filter((f) => existsSync(f));
}

export function refreshProject(projectRoot: string): void {
  projectCache.delete(projectRoot);
  graphCache.delete(projectRoot);
}

export function getAffectedTests(projectRoot: string, changedFiles: string[]): AffectedTestsResult {
  const { reverse } = getGraphs(projectRoot);

  const normalizedChanged = changedFiles.map((f) => normalize(f, projectRoot));

  // BFS through reverse graph to find all transitively affected files
  const visited = new Set<string>(normalizedChanged);
  const queue = [...normalizedChanged];

  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    for (const dependent of reverse.get(current) ?? []) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        queue.push(dependent);
      }
    }
  }

  const affectedTests = [...visited].filter((f) => isTestFile(f) && !normalizedChanged.includes(f));

  return {
    changed_files: normalizedChanged,
    affected_tests: affectedTests,
    total_affected: affectedTests.length,
  };
}

export function getAffectedTestsByBranch(
  projectRoot: string,
  baseBranch = 'main'
): AffectedTestsResult & { base_branch: string } {
  let diffOutput: string;
  try {
    diffOutput = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    diffOutput = execSync(`git diff --name-only ${baseBranch}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const files = parseGitDiff(projectRoot, diffOutput);
  const result = getAffectedTests(projectRoot, files);
  return { base_branch: baseBranch, ...result };
}

export function getDependencyGraph(
  projectRoot: string,
  filePath: string,
  format: 'json' | 'mermaid' = 'json'
): FileDependencies | string {
  const normalized = normalize(filePath, projectRoot);
  const { forward, reverse } = getGraphs(projectRoot);

  const filterExternal = (f: string) => !f.includes('/node_modules/');
  const imports = [...(forward.get(normalized) ?? [])].filter(filterExternal);
  const importedBy = [...(reverse.get(normalized) ?? [])].filter(filterExternal);

  if (format === 'mermaid') {
    const shortName = (f: string) => path.relative(projectRoot, f);
    const lines = ['graph TD'];
    for (const imp of imports) {
      lines.push(`  "${shortName(normalized)}" --> "${shortName(imp)}"`);
    }
    for (const dep of importedBy) {
      lines.push(`  "${shortName(dep)}" --> "${shortName(normalized)}"`);
    }
    if (lines.length === 1) lines.push(`  "${shortName(normalized)}"`);
    return lines.join('\n');
  }

  return { file: normalized, imports, imported_by: importedBy };
}

export function explainImpact(
  projectRoot: string,
  changedFile: string,
  testFile: string
): ImpactExplanation {
  const { forward } = getGraphs(projectRoot);

  const normalizedChanged = normalize(changedFile, projectRoot);
  const normalizedTest = normalize(testFile, projectRoot);

  // BFS from test file through its imports to find a path to changedFile
  const parent = new Map<string, string | null>([[normalizedTest, null]]);
  const queue = [normalizedTest];

  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    if (current === normalizedChanged) {
      const chain: string[] = [];
      let node: string | null = current;
      while (node !== null) {
        chain.unshift(node);
        node = parent.get(node) ?? null;
      }
      return {
        changed_file: normalizedChanged,
        test_file: normalizedTest,
        found: true,
        import_chain: chain,
      };
    }
    for (const imp of forward.get(current) ?? []) {
      if (!parent.has(imp)) {
        parent.set(imp, current);
        queue.push(imp);
      }
    }
  }

  return {
    changed_file: normalizedChanged,
    test_file: normalizedTest,
    found: false,
    import_chain: [],
  };
}

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

export function parseNameStatus(
  statusOutput: string,
  projectRoot: string,
  similarityThreshold: number
): {
  renamedFiles: Array<{ from: string; to: string; similarity: number }>;
  changedFilePaths: string[];
} {
  const renamedFiles: Array<{ from: string; to: string; similarity: number }> = [];
  const changedFilePaths: string[] = [];

  for (const line of statusOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const status = parts[0];

    if (status.startsWith('R') || status.startsWith('C')) {
      const similarity = parseInt(status.slice(1), 10) || similarityThreshold;
      const fromRel = parts[1];
      const toRel = parts[2];
      if (fromRel && toRel && /\.(ts|tsx|js|jsx)$/.test(toRel)) {
        renamedFiles.push({
          from: normalize(fromRel, projectRoot),
          to: normalize(toRel, projectRoot),
          similarity,
        });
        changedFilePaths.push(normalize(toRel, projectRoot));
      }
    } else if (/^[MAD]$/.test(status)) {
      const file = parts[1];
      if (file && /\.(ts|tsx|js|jsx)$/.test(file)) {
        changedFilePaths.push(normalize(file, projectRoot));
      }
    }
  }

  return { renamedFiles, changedFilePaths };
}

export function getAffectedTestsByBranchRenameAware(
  projectRoot: string,
  baseBranch = 'main',
  similarityThreshold = 90
): RenameAwareDiffResult {
  const flags = `--name-status -M${similarityThreshold}% --ignore-all-space`;
  let statusOutput: string;
  try {
    statusOutput = execSync(`git diff ${flags} ${baseBranch}...HEAD`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    statusOutput = execSync(`git diff ${flags} ${baseBranch}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const { renamedFiles, changedFilePaths } = parseNameStatus(
    statusOutput,
    projectRoot,
    similarityThreshold
  );
  const result = getAffectedTests(projectRoot, changedFilePaths);
  return { base_branch: baseBranch, renamed_files: renamedFiles, ...result };
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
