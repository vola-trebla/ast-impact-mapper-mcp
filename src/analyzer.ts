import { Project } from "ts-morph";
import path from "path";
import { existsSync } from "fs";
import { AffectedTestsResult, FileDependencies, ImpactExplanation } from "./types.js";

const projectCache = new Map<string, Project>();

function getProject(projectRoot: string): Project {
  const cached = projectCache.get(projectRoot);
  if (cached) return cached;

  const tsConfigPath = path.join(projectRoot, "tsconfig.json");
  const project = existsSync(tsConfigPath)
    ? new Project({ tsConfigFilePath: tsConfigPath, skipAddingFilesFromTsConfig: false })
    : new Project();

  if (!existsSync(tsConfigPath)) {
    project.addSourceFilesAtPaths(`${projectRoot}/**/*.{ts,tsx}`);
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
  return /\.(spec|test)\.(ts|tsx)$/.test(filePath);
}

function normalize(filePath: string, projectRoot: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
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

  return {
    file: normalized,
    imports: [...(forwardGraph.get(normalized) ?? [])],
    imported_by: [...(reverseGraph.get(normalized) ?? [])],
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
