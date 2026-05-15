import { Project } from "ts-morph";
import path from "path";
import { existsSync } from "fs";
import {
  AffectedTestsResult,
  FileDependencies,
  ImpactExplanation,
  CoverageGaps,
  TestSummary,
} from "./types.js";

const projectCache = new Map<string, Project>();

function getProject(projectRoot: string): Project {
  const cached = projectCache.get(projectRoot);
  if (cached) return cached;

  const tsConfigPath = path.join(projectRoot, "tsconfig.json");
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

function buildForwardGraph(project: Project): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    const imports = new Set<string>();
    for (const decl of sourceFile.getImportDeclarations()) {
      const resolved = decl.getModuleSpecifierSourceFile();
      if (resolved) imports.add(resolved.getFilePath());
    }
    graph.set(filePath, imports);
  }
  return graph;
}

function buildReverseGraph(project: Project): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    for (const decl of sourceFile.getImportDeclarations()) {
      const resolved = decl.getModuleSpecifierSourceFile();
      if (!resolved) continue;
      const resolvedPath = resolved.getFilePath();
      if (!graph.has(resolvedPath)) graph.set(resolvedPath, new Set());
      graph.get(resolvedPath)!.add(filePath);
    }
  }
  return graph;
}

function isTestFile(filePath: string): boolean {
  return /\.(spec|test)\.(ts|tsx|js|jsx)$/.test(filePath);
}

function normalize(filePath: string, projectRoot: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
}

export function parseGitDiff(projectRoot: string, gitDiff: string): string[] {
  return gitDiff
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /\.(ts|tsx|js|jsx)$/.test(line))
    .map((line) => normalize(line, projectRoot))
    .filter((f) => existsSync(f));
}

export function refreshProject(projectRoot: string): void {
  projectCache.delete(projectRoot);
}

export function getAffectedTests(projectRoot: string, changedFiles: string[]): AffectedTestsResult {
  const project = getProject(projectRoot);
  const reverseGraph = buildReverseGraph(project);

  const normalizedChanged = changedFiles.map((f) => normalize(f, projectRoot));

  // BFS through reverse graph to find all transitively affected files
  const visited = new Set<string>(normalizedChanged);
  const queue = [...normalizedChanged];

  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    for (const dependent of reverseGraph.get(current) ?? []) {
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

export function getDependencyGraph(projectRoot: string, filePath: string): FileDependencies {
  const project = getProject(projectRoot);
  const normalized = normalize(filePath, projectRoot);

  const forwardGraph = buildForwardGraph(project);
  const reverseGraph = buildReverseGraph(project);

  const filterExternal = (f: string) => !f.includes("/node_modules/");
  return {
    file: normalized,
    imports: [...(forwardGraph.get(normalized) ?? [])].filter(filterExternal),
    imported_by: [...(reverseGraph.get(normalized) ?? [])].filter(filterExternal),
  };
}

export function explainImpact(
  projectRoot: string,
  changedFile: string,
  testFile: string
): ImpactExplanation {
  const project = getProject(projectRoot);
  const forwardGraph = buildForwardGraph(project);

  const normalizedChanged = normalize(changedFile, projectRoot);
  const normalizedTest = normalize(testFile, projectRoot);

  // BFS from test file through its imports to find a path to changedFile
  const parent = new Map<string, string | null>([[normalizedTest, null]]);
  const queue = [normalizedTest];

  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    if (current === normalizedChanged) {
      // Reconstruct the import chain
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
    for (const imp of forwardGraph.get(current) ?? []) {
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
  const project = getProject(projectRoot);
  const forwardGraph = buildForwardGraph(project);

  const allFiles = [...forwardGraph.keys()];
  const testFiles = allFiles.filter(isTestFile);

  // BFS from all test files through forward graph to find all reachable source files
  const reachable = new Set<string>(testFiles);
  const queue = [...testFiles];
  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    for (const imp of forwardGraph.get(current) ?? []) {
      if (!reachable.has(imp)) {
        reachable.add(imp);
        queue.push(imp);
      }
    }
  }

  const isSource = (f: string): boolean => {
    if (isTestFile(f)) return false;
    if (f.includes("/node_modules/")) return false;
    if (f.endsWith(".d.ts")) return false;
    if (sourceDirs && sourceDirs.length > 0) {
      return sourceDirs.some((dir) => f.startsWith(normalize(dir, projectRoot)));
    }
    return f.startsWith(projectRoot);
  };

  const sourceFiles = allFiles.filter(isSource);
  const uncovered = sourceFiles.filter((f) => !reachable.has(f)).slice(0, limit);

  return {
    uncovered_files: uncovered,
    total_source_files: sourceFiles.length,
    total_uncovered: sourceFiles.filter((f) => !reachable.has(f)).length,
    coverage_rate:
      sourceFiles.length > 0
        ? Math.round(
            ((sourceFiles.length - sourceFiles.filter((f) => !reachable.has(f)).length) /
              sourceFiles.length) *
              10000
          ) / 10000
        : 1,
  };
}

export function getTestSummary(projectRoot: string): TestSummary {
  const project = getProject(projectRoot);
  const forwardGraph = buildForwardGraph(project);
  const reverseGraph = buildReverseGraph(project);

  const allFiles = [...forwardGraph.keys()];
  const testFiles = allFiles.filter(isTestFile);
  const sourceFiles = allFiles.filter(
    (f) =>
      !isTestFile(f) &&
      !f.includes("/node_modules/") &&
      !f.endsWith(".d.ts") &&
      f.startsWith(projectRoot)
  );

  // Most imported source files (highest reverse-graph degree among non-test files)
  const mostImported = sourceFiles
    .map((f) => ({ file: f, imported_by_count: (reverseGraph.get(f) ?? new Set()).size }))
    .filter((x) => x.imported_by_count > 0)
    .sort((a, b) => b.imported_by_count - a.imported_by_count)
    .slice(0, 10);

  // Deepest import chain per test file (BFS depth)
  const deepestChains = testFiles
    .map((testFile) => {
      const visited = new Set<string>([testFile]);
      let frontier = [testFile];
      let depth = 0;
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const f of frontier) {
          for (const imp of forwardGraph.get(f) ?? []) {
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

  // Coverage: reachable source files from tests
  const reachable = new Set<string>(testFiles);
  const queue = [...testFiles];
  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    for (const imp of forwardGraph.get(current) ?? []) {
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
