import { Project, SyntaxKind, Node, SourceFile } from 'ts-morph';
import path from 'path';
import fs, { existsSync } from 'fs';
import { execSync } from 'child_process';
import crypto from 'crypto';
import {
  AffectedTestsResult,
  FileDependencies,
  ImpactExplanation,
  CoverageGaps,
  TestSummary,
  RenameAwareDiffResult,
  UnreachableModulesResult,
  ArchitecturalCyclesResult,
  DifferentiateTypeImpactResult,
  ApiMutation,
  ApiSurfaceMutationResult,
} from './types.js';

interface CacheEntry {
  mtime: number;
  hash: string;
  imports: string[];
}

interface CacheData {
  version: string;
  files: Record<string, CacheEntry>;
}

function getCachePath(projectRoot: string): string {
  return path.join(projectRoot, '.ast-mapper-cache', 'cache.json');
}

function loadCache(projectRoot: string): CacheData {
  const cachePath = getCachePath(projectRoot);
  if (existsSync(cachePath)) {
    try {
      const content = fs.readFileSync(cachePath, 'utf8');
      return JSON.parse(content);
    } catch {
      // Ignore reading errors
    }
  }
  return { version: '1', files: {} };
}

function saveCache(projectRoot: string, cache: CacheData): void {
  const cachePath = getCachePath(projectRoot);
  const cacheDir = path.dirname(cachePath);
  if (!existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}

function computeMd5(filePath: string): string {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
  } catch {
    return '';
  }
}

function globFiles(dir: string, projectRoot: string): string[] {
  const results: string[] = [];
  let list: string[];
  try {
    list = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const file of list) {
    const filePath = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat && stat.isDirectory()) {
      if (
        file === 'node_modules' ||
        file === '.git' ||
        file === 'dist' ||
        file === '.ast-mapper-cache' ||
        file === 'build' ||
        file === 'out'
      ) {
        continue;
      }
      results.push(...globFiles(filePath, projectRoot));
    } else {
      if (/\.(ts|tsx|js|jsx)$/.test(file) && !file.endsWith('.d.ts')) {
        results.push(filePath);
      }
    }
  }
  return results;
}

export function getOrAddSourceFile(project: Project, filePath: string): SourceFile | undefined {
  let sf = project.getSourceFile(filePath);
  if (!sf) {
    try {
      sf = project.addSourceFileAtPath(filePath);
      project.resolveSourceFileDependencies();
    } catch {
      // Ignore
    }
  }
  return sf;
}

const projectCache = new Map<string, Project>();
const graphCache = new Map<
  string,
  { forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> }
>();

function getProject(projectRoot: string, lazy = true): Project {
  const cached = projectCache.get(projectRoot);
  if (cached) return cached;

  const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
  // allowJs lets ts-morph resolve .js/.jsx imports even in TS projects
  const project = existsSync(tsConfigPath)
    ? new Project({
        tsConfigFilePath: tsConfigPath,
        skipAddingFilesFromTsConfig: lazy,
        compilerOptions: { allowJs: true },
      })
    : new Project({ compilerOptions: { allowJs: true } });

  if (!existsSync(tsConfigPath) && !lazy) {
    project.addSourceFilesAtPaths(`${projectRoot}/**/*.{ts,tsx,js,jsx}`);
  }

  projectCache.set(projectRoot, project);
  return project;
}

export function getGraphs(projectRoot: string): {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
} {
  const cached = graphCache.get(projectRoot);
  if (cached) return cached;

  // 1. Load cache
  const cacheData = loadCache(projectRoot);
  const updatedFilesCache: Record<string, CacheEntry> = {};

  // 2. Scan project files
  const files = globFiles(projectRoot, projectRoot);

  // 3. Find files to parse (hash changed or not in cache)
  const filesToParse: string[] = [];
  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const cachedEntry = cacheData.files[file];

    if (cachedEntry && cachedEntry.mtime === stat.mtimeMs) {
      updatedFilesCache[file] = cachedEntry;
    } else {
      const currentHash = computeMd5(file);
      if (cachedEntry && cachedEntry.hash === currentHash) {
        updatedFilesCache[file] = {
          mtime: stat.mtimeMs,
          hash: currentHash,
          imports: cachedEntry.imports,
        };
      } else {
        filesToParse.push(file);
      }
    }
  }

  // 4. Parse changed files on-demand
  if (filesToParse.length > 0) {
    const project = getProject(projectRoot, true); // lazy project

    for (const file of filesToParse) {
      try {
        project.addSourceFileAtPath(file);
      } catch {
        // Ignore files that can't be added
      }
    }

    try {
      project.resolveSourceFileDependencies();
    } catch {
      // Ignore resolution errors
    }

    for (const file of filesToParse) {
      try {
        const sourceFile = project.getSourceFile(file);
        const imports: string[] = [];
        if (sourceFile) {
          for (const decl of sourceFile.getImportDeclarations()) {
            const resolved = decl.getModuleSpecifierSourceFile();
            if (resolved) {
              imports.push(resolved.getFilePath());
            }
          }
        }

        const stat = fs.statSync(file);
        const hash = computeMd5(file);
        updatedFilesCache[file] = {
          mtime: stat.mtimeMs,
          hash,
          imports,
        };
      } catch {
        try {
          const stat = fs.statSync(file);
          const hash = computeMd5(file);
          updatedFilesCache[file] = {
            mtime: stat.mtimeMs,
            hash,
            imports: [],
          };
        } catch {
          // File was deleted during parse
        }
      }
    }
  }

  // 5. Save updated cache
  cacheData.files = updatedFilesCache;
  saveCache(projectRoot, cacheData);

  // 6. Build forward and reverse graphs
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  for (const [file, entry] of Object.entries(updatedFilesCache)) {
    if (!forward.has(file)) forward.set(file, new Set());

    for (const imp of entry.imports) {
      forward.get(file)!.add(imp);

      if (!reverse.has(imp)) reverse.set(imp, new Set());
      reverse.get(imp)!.add(file);
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

const ENTRY_POINT_PATTERNS = [
  /\/index\.(ts|tsx|js|jsx)$/,
  /\/main\.(ts|tsx|js|jsx)$/,
  /\/app\.(ts|tsx|js|jsx)$/,
  /\/pages\//,
  /\/app\//,
  /\/routes\//,
  /\/api\//,
  /\/bin\//,
];

export function identifyUnreachableModules(
  projectRoot: string,
  { entryPoints, limit = 50 }: { entryPoints?: string[]; limit?: number } = {}
): UnreachableModulesResult {
  const { forward, reverse } = getGraphs(projectRoot);

  const normalizedEntryPoints = new Set((entryPoints ?? []).map((f) => normalize(f, projectRoot)));

  const isSource = (f: string): boolean => {
    if (isTestFile(f)) return false;
    if (f.includes('/node_modules/')) return false;
    if (f.endsWith('.d.ts')) return false;
    return f.startsWith(projectRoot);
  };

  const isEntryPoint = (f: string): boolean =>
    normalizedEntryPoints.has(f) || ENTRY_POINT_PATTERNS.some((p) => p.test(f));

  const allFiles = [...forward.keys()];
  const sourceFiles = allFiles.filter(isSource);

  const detectedEntryPoints: string[] = [];
  const unreachableFiles: string[] = [];

  for (const file of sourceFiles) {
    const incomingEdges = reverse.get(file);
    if (incomingEdges && incomingEdges.size > 0) continue;

    if (isEntryPoint(file)) {
      detectedEntryPoints.push(file);
    } else {
      unreachableFiles.push(file);
    }
  }

  return {
    unreachable_files: unreachableFiles.slice(0, limit),
    entry_points_detected: detectedEntryPoints,
    total_source_files: sourceFiles.length,
    total_unreachable: unreachableFiles.length,
  };
}

function normalizeCycle(chain: string[]): string[] {
  const minIdx = chain.reduce((minI, _, i, arr) => (arr[i] < arr[minI] ? i : minI), 0);
  return [...chain.slice(minIdx), ...chain.slice(0, minIdx)];
}

export function detectArchitecturalCycles(projectRoot: string): ArchitecturalCyclesResult {
  const { forward } = getGraphs(projectRoot);

  const cycles: ArchitecturalCyclesResult['cycles'] = [];
  const seenCycles = new Set<string>();
  // 0 = white (unvisited), 1 = gray (in current path), 2 = black (done)
  const color = new Map<string, 0 | 1 | 2>();

  function dfs(node: string, pathStack: string[]): void {
    color.set(node, 1);
    pathStack.push(node);

    for (const neighbor of forward.get(node) ?? []) {
      if (neighbor.includes('/node_modules/')) continue;
      if (!neighbor.startsWith(projectRoot)) continue;

      const c = color.get(neighbor) ?? 0;
      if (c === 1) {
        const chain = normalizeCycle(pathStack.slice(pathStack.indexOf(neighbor)));
        const key = chain.join('|');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push({ chain, severity: 'warning' });
        }
      } else if (c === 0) {
        dfs(neighbor, pathStack);
      }
    }

    pathStack.pop();
    color.set(node, 2);
  }

  for (const node of forward.keys()) {
    if (node.includes('/node_modules/')) continue;
    if (!node.startsWith(projectRoot)) continue;
    if ((color.get(node) ?? 0) === 0) dfs(node, []);
  }

  const filesInCycles = [...new Set(cycles.flatMap((c) => c.chain))].sort();
  return { cycles, total_cycles: cycles.length, files_in_cycles: filesInCycles };
}

const TYPE_ONLY_KINDS = new Set([
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.ImportDeclaration,
]);

function isTypeOnlyFile(projectRoot: string, filePath: string): boolean {
  const sf = getOrAddSourceFile(getProject(projectRoot, true), filePath);
  if (!sf) return false;
  for (const stmt of sf.getStatements()) {
    const kind = stmt.getKind();
    if (TYPE_ONLY_KINDS.has(kind)) continue;
    if (kind === SyntaxKind.ExportDeclaration) {
      const ed = stmt.asKind(SyntaxKind.ExportDeclaration);
      if (ed?.isTypeOnly()) continue;
    }
    return false;
  }
  return true;
}

function importsViaTypeOnly(
  projectRoot: string,
  importerPath: string,
  importedPath: string
): boolean {
  const sf = getOrAddSourceFile(getProject(projectRoot, true), importerPath);
  if (!sf) return false;
  return sf.getImportDeclarations().some((decl) => {
    const resolved = decl.getModuleSpecifierSourceFile();
    return resolved?.getFilePath() === importedPath && decl.isTypeOnly();
  });
}

export function differentiateTypeImpact(
  projectRoot: string,
  changedFiles: string[]
): DifferentiateTypeImpactResult {
  const { reverse } = getGraphs(projectRoot);
  const normalized = changedFiles.map((f) => normalize(f, projectRoot));

  const mustRunSet = new Set<string>();
  const skippableSet = new Set<string>();
  const fileResults: DifferentiateTypeImpactResult['files'] = [];

  for (const file of normalized) {
    const typeOnly = isTypeOnlyFile(projectRoot, file);

    // BFS: all transitively affected tests
    const visited = new Set<string>([file]);
    const queue = [file];
    let i = 0;
    while (i < queue.length) {
      const cur = queue[i++];
      for (const dep of reverse.get(cur) ?? []) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }
    const affectedTests = [...visited].filter((f) => isTestFile(f) && f !== file);

    const mustRun: string[] = [];
    const skippable: string[] = [];

    for (const test of affectedTests) {
      if (typeOnly || importsViaTypeOnly(projectRoot, test, file)) {
        skippable.push(test);
        skippableSet.add(test);
      } else {
        mustRun.push(test);
        mustRunSet.add(test);
      }
    }

    fileResults.push({
      file,
      runtime_impact: !typeOnly,
      reason: typeOnly ? 'type_only_change' : 'runtime_logic_changed',
      affected_tests_must_run: mustRun,
      affected_tests_skippable: skippable,
    });
  }

  // A test in must_run for any file overrides its skippable status
  for (const t of mustRunSet) skippableSet.delete(t);

  return {
    files: fileResults,
    total_tests_must_run: mustRunSet.size,
    total_tests_skippable: skippableSet.size,
  };
}

function extractSignatures(sf: ReturnType<Project['getSourceFileOrThrow']>): Map<string, string> {
  const sigs = new Map<string, string>();

  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName();
    if (!name) continue;
    const params = fn
      .getParameters()
      .map((p) => {
        const opt = p.hasQuestionToken() ? '?' : '';
        const rest = p.isRestParameter() ? '...' : '';
        const type = p.getTypeNode()?.getText() ?? 'any';
        return `${rest}${p.getName()}${opt}:${type}`;
      })
      .join(',');
    const ret = fn.getReturnTypeNode()?.getText() ?? '';
    sigs.set(name, `fn(${params})${ret ? `:${ret}` : ''}`);
  }

  for (const iface of sf.getInterfaces()) {
    if (!iface.isExported()) continue;
    const members = iface
      .getMembers()
      .map((m) => m.getText().replace(/\s+/g, ' ').trim())
      .sort()
      .join(';');
    sigs.set(iface.getName(), `iface{${members}}`);
  }

  for (const ta of sf.getTypeAliases()) {
    if (!ta.isExported()) continue;
    sigs.set(ta.getName(), `type=${ta.getTypeNode()?.getText() ?? ''}`);
  }

  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue;
    for (const decl of vs.getDeclarations()) {
      const type = decl.getTypeNode()?.getText() ?? '';
      sigs.set(decl.getName(), `var:${type}`);
    }
  }

  for (const cls of sf.getClasses()) {
    if (!cls.isExported()) continue;
    const name = cls.getName();
    if (!name) continue;
    const pub = [
      ...cls
        .getMethods()
        .filter(
          (m) =>
            !m.hasModifier(SyntaxKind.PrivateKeyword) && !m.hasModifier(SyntaxKind.ProtectedKeyword)
        ),
      ...cls
        .getProperties()
        .filter(
          (p) =>
            !p.hasModifier(SyntaxKind.PrivateKeyword) && !p.hasModifier(SyntaxKind.ProtectedKeyword)
        ),
    ]
      .map((m) => m.getName())
      .sort();
    sigs.set(name, `class{${pub.join(',')}}`);
  }

  return sigs;
}

function sigKind(sig: string): string {
  if (sig.startsWith('fn')) return 'function';
  if (sig.startsWith('iface')) return 'interface';
  if (sig.startsWith('type=')) return 'type';
  if (sig.startsWith('var:')) return 'variable';
  if (sig.startsWith('class')) return 'class';
  return 'unknown';
}

export function analyzeApiSurfaceMutation(
  projectRoot: string,
  filePath: string
): ApiSurfaceMutationResult {
  const normalized = normalize(filePath, projectRoot);
  const relative = path.relative(projectRoot, normalized);

  let oldContent: string | null = null;
  try {
    oldContent = execSync(`git show HEAD:${relative}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // new file — no HEAD version
  }

  const project = getProject(projectRoot, true);
  const newSf = getOrAddSourceFile(project, normalized);
  if (!newSf) throw new Error(`File not found in project: ${normalized}`);

  const newSigs = extractSignatures(newSf);

  if (!oldContent) {
    const mutations: ApiMutation[] = [...newSigs.entries()].map(([name, sig]) => ({
      export_name: name,
      kind: sigKind(sig),
      mutation_type: 'added' as const,
      new_signature: sig,
    }));
    return {
      file: normalized,
      change_type: 'internal_refactor',
      changed_signatures: mutations,
      affected_exports: [],
    };
  }

  const inMemory = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const oldSf = inMemory.createSourceFile('old.ts', oldContent);
  const oldSigs = extractSignatures(oldSf);

  const mutations: ApiMutation[] = [];
  let isBreaking = false;

  for (const [name, oldSig] of oldSigs) {
    if (!newSigs.has(name)) {
      mutations.push({
        export_name: name,
        kind: sigKind(oldSig),
        mutation_type: 'removed',
        old_signature: oldSig,
      });
      isBreaking = true;
    } else {
      const newSig = newSigs.get(name)!;
      if (oldSig !== newSig) {
        mutations.push({
          export_name: name,
          kind: sigKind(newSig),
          mutation_type: 'signature_changed',
          old_signature: oldSig,
          new_signature: newSig,
        });
        isBreaking = true;
      }
    }
  }
  for (const [name, newSig] of newSigs) {
    if (!oldSigs.has(name)) {
      mutations.push({
        export_name: name,
        kind: sigKind(newSig),
        mutation_type: 'added',
        new_signature: newSig,
      });
    }
  }

  if (mutations.length === 0) {
    mutations.push({
      export_name: '<implementation>',
      kind: 'implementation',
      mutation_type: 'body_only',
    });
  }

  const affectedExports = mutations
    .filter((m) => m.mutation_type === 'removed' || m.mutation_type === 'signature_changed')
    .map((m) => m.export_name);

  return {
    file: normalized,
    change_type: isBreaking ? 'breaking_api_change' : 'internal_refactor',
    changed_signatures: mutations,
    affected_exports: affectedExports,
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

export function getSymbolDependencyGraph(
  projectRoot: string,
  filePath: string,
  symbolName?: string,
  direction: 'forward' | 'reverse' | 'bidirectional' = 'bidirectional'
): { nodes: SymbolNode[]; edges: SymbolEdge[] } {
  const normalizedPath = normalize(filePath, projectRoot);
  const project = getProject(projectRoot, true);
  const sf = getOrAddSourceFile(project, normalizedPath);
  if (!sf) {
    throw new Error(`File not found: ${normalizedPath}`);
  }

  const nodes: SymbolNode[] = [];
  const edges: SymbolEdge[] = [];
  const visitedSymbols = new Set<string>();

  function addNode(name: string, file: string, kind: string): string {
    const id = `${file}#${name}`;
    if (!visitedSymbols.has(id)) {
      visitedSymbols.add(id);
      nodes.push({ id, name, file: path.relative(projectRoot, file), kind });
    }
    return id;
  }

  const exportedDeclarations = sf.getExportedDeclarations();
  const targetSymbols = symbolName ? [symbolName] : [...exportedDeclarations.keys()];
  const { reverse: fileReverse } = getGraphs(projectRoot);

  for (const sym of targetSymbols) {
    const decls = exportedDeclarations.get(sym);
    if (!decls) continue;

    for (const decl of decls) {
      let kind = 'unknown';
      if (Node.isFunctionDeclaration(decl)) kind = 'function';
      else if (Node.isClassDeclaration(decl)) kind = 'class';
      else if (Node.isInterfaceDeclaration(decl)) kind = 'interface';
      else if (Node.isTypeAliasDeclaration(decl)) kind = 'type';
      else if (Node.isVariableDeclaration(decl)) kind = 'variable';

      const sourceId = addNode(sym, normalizedPath, kind);

      if (direction === 'reverse' || direction === 'bidirectional') {
        const visitedFiles = new Set<string>([normalizedPath]);
        const queue = [normalizedPath];
        let qi = 0;
        while (qi < queue.length) {
          const cur = queue[qi++];
          for (const dep of fileReverse.get(cur) ?? []) {
            if (!visitedFiles.has(dep)) {
              visitedFiles.add(dep);
              queue.push(dep);
            }
          }
        }

        for (const file of visitedFiles) {
          getOrAddSourceFile(project, file);
        }

        try {
          if (Node.isReferenceFindable(decl)) {
            const referencedSymbols = decl.findReferences();
            for (const refSym of referencedSymbols) {
              for (const ref of refSym.getReferences()) {
                const refNode = ref.getNode();
                const refFile = refNode.getSourceFile().getFilePath();
                if (refFile === normalizedPath) continue;

                let parentNode: Node | undefined = refNode.getParent();
                let parentSymName = '';
                let parentKind = 'unknown';

                while (parentNode) {
                  if (Node.isFunctionDeclaration(parentNode) && parentNode.getName()) {
                    parentSymName = parentNode.getName()!;
                    parentKind = 'function';
                    break;
                  } else if (Node.isMethodDeclaration(parentNode) && parentNode.getName()) {
                    parentSymName = parentNode.getName()!;
                    parentKind = 'method';
                    break;
                  } else if (Node.isClassDeclaration(parentNode) && parentNode.getName()) {
                    parentSymName = parentNode.getName()!;
                    parentKind = 'class';
                    break;
                  } else if (Node.isVariableDeclaration(parentNode)) {
                    parentSymName = parentNode.getName();
                    parentKind = 'variable';
                    break;
                  }
                  parentNode = parentNode.getParent();
                }

                if (parentSymName) {
                  const targetId = addNode(parentSymName, refFile, parentKind);
                  edges.push({ from: targetId, to: sourceId });
                }
              }
            }
          }
        } catch {
          // Ignore
        }
      }

      if (direction === 'forward' || direction === 'bidirectional') {
        decl.forEachDescendant((child) => {
          if (Node.isIdentifier(child)) {
            try {
              const definitions = child.getDefinitions();
              for (const def of definitions) {
                const defFile = def.getSourceFile()?.getFilePath();
                if (!defFile || defFile === normalizedPath || defFile.includes('/node_modules/')) {
                  continue;
                }

                const defName = def.getName();
                const defKindName = def.getKind().toString();
                const targetId = addNode(defName, defFile, defKindName);
                edges.push({ from: sourceId, to: targetId });
              }
            } catch {
              // Ignore
            }
          }
        });
      }
    }
  }

  const seenEdges = new Set<string>();
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.from}->${e.to}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  return { nodes, edges: uniqueEdges };
}

export function generateSkeletonView(
  projectRoot: string,
  filePath: string,
  includeJSDoc = true,
  includePrivateMembers = false
): string {
  const normalizedPath = normalize(filePath, projectRoot);
  const project = getProject(projectRoot, true);
  const sf = getOrAddSourceFile(project, normalizedPath);
  if (!sf) {
    throw new Error(`File not found: ${normalizedPath}`);
  }

  const lines: string[] = [];
  const totalLines = sf.getEndLineNumber();
  const relativePath = path.relative(projectRoot, normalizedPath);
  lines.push(`# File: ${relativePath} (Lines: 1-${totalLines})`);

  function getJSDocText(node: Node): string {
    if (includeJSDoc && Node.isJSDocable(node)) {
      const docs = node.getJsDocs();
      if (docs.length > 0) {
        return docs.map((doc) => doc.getText()).join('\n') + '\n';
      }
    }
    return '';
  }

  function formatLineRange(node: Node): string {
    const start = node.getStartLineNumber();
    const end = node.getEndLineNumber();
    return ` L${start}-${end}`;
  }

  for (const statement of sf.getStatements()) {
    if (Node.isImportDeclaration(statement)) {
      lines.push(statement.getText());
    } else if (Node.isInterfaceDeclaration(statement)) {
      const jsdoc = getJSDocText(statement);
      const start = statement.getStartLineNumber();
      const end = statement.getEndLineNumber();
      const name = statement.getName();
      const extendsText = statement
        .getExtends()
        .map((e) => e.getText())
        .join(', ');
      const extendsPart = extendsText ? ` extends ${extendsText}` : '';
      lines.push(`${jsdoc}export interface ${name}${extendsPart} L${start}-${end}`);
    } else if (Node.isTypeAliasDeclaration(statement)) {
      const jsdoc = getJSDocText(statement);
      lines.push(
        `${jsdoc}${statement.getText().replace(/\s+/g, ' ').trim()} L${statement.getStartLineNumber()}-${statement.getEndLineNumber()}`
      );
    } else if (Node.isFunctionDeclaration(statement)) {
      const jsdoc = getJSDocText(statement);
      const name = statement.getName() ?? '';
      const params = statement
        .getParameters()
        .map((p) => p.getText())
        .join(', ');
      const returnType = statement.getReturnTypeNode()?.getText() ?? 'any';
      const isExported = statement.isExported() ? 'export ' : '';
      lines.push(
        `${jsdoc}${isExported}function ${name}(${params}): ${returnType}${formatLineRange(statement)}`
      );
    } else if (Node.isClassDeclaration(statement)) {
      const jsdoc = getJSDocText(statement);
      const name = statement.getName() ?? '';
      const isExported = statement.isExported() ? 'export ' : '';
      lines.push(`${jsdoc}${isExported}class ${name}${formatLineRange(statement)} {`);

      for (const member of statement.getMembers()) {
        let isPrivate = false;
        let modifiers = '';
        if (Node.isModifierable(member)) {
          isPrivate =
            member.hasModifier(SyntaxKind.PrivateKeyword) ||
            member.hasModifier(SyntaxKind.ProtectedKeyword);
          modifiers = member
            .getModifiers()
            .map((m) => m.getText())
            .join(' ');
        }
        if (isPrivate && !includePrivateMembers) continue;

        const memberJSDoc = getJSDocText(member);
        const modPrefix = modifiers ? modifiers + ' ' : '';

        if (Node.isMethodDeclaration(member)) {
          const mName = member.getName();
          const params = member
            .getParameters()
            .map((p) => p.getText())
            .join(', ');
          const returnType = member.getReturnTypeNode()?.getText() ?? 'any';
          lines.push(
            `  ${memberJSDoc}${modPrefix}${mName}(${params}): ${returnType}${formatLineRange(member)}`
          );
        } else if (Node.isPropertyDeclaration(member)) {
          const pName = member.getName();
          const type = member.getTypeNode()?.getText() ?? 'any';
          lines.push(`  ${memberJSDoc}${modPrefix}${pName}: ${type}${formatLineRange(member)}`);
        } else if (Node.isConstructorDeclaration(member)) {
          const params = member
            .getParameters()
            .map((p) => p.getText())
            .join(', ');
          lines.push(`  ${memberJSDoc}constructor(${params})${formatLineRange(member)}`);
        }
      }
      lines.push(`}`);
    } else if (Node.isVariableStatement(statement)) {
      const jsdoc = getJSDocText(statement);
      const isExported = statement.isExported() ? 'export ' : '';
      const declarations = statement
        .getDeclarations()
        .map((d) => {
          const name = d.getName();
          const type = d.getTypeNode()?.getText() ?? 'any';
          return `${name}: ${type}`;
        })
        .join(', ');
      lines.push(`${jsdoc}${isExported}const/let ${declarations}${formatLineRange(statement)}`);
    }
  }

  return lines.join('\n');
}

export function generateTestCommand(
  projectRoot: string,
  changedFiles: string[],
  runner: 'jest' | 'vitest' | 'playwright' = 'vitest'
): { command: string } {
  const result = getAffectedTests(projectRoot, changedFiles);
  const testFiles = result.affected_tests;

  if (testFiles.length === 0) {
    return { command: '' };
  }

  const relativePaths = testFiles.map((f) => path.relative(projectRoot, f));

  let command = '';
  if (runner === 'vitest') {
    command = `npx vitest run ${relativePaths.join(' ')}`;
  } else if (runner === 'jest') {
    command = `npx jest ${relativePaths.join(' ')}`;
  } else if (runner === 'playwright') {
    command = `npx playwright test ${relativePaths.join(' ')}`;
  }

  return { command };
}

interface SymbolNode {
  id: string;
  name: string;
  file: string;
  kind: string;
}

interface SymbolEdge {
  from: string;
  to: string;
}
