import { execSync } from 'child_process';
import path from 'path';
import { AffectedTestsResult, ImpactExplanation, RenameAwareDiffResult } from './types.js';
import { isTestFile, normalize } from './utils.js';
import { getGraphs, parseGitDiff } from './project.js';

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
