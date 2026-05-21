import { UnreachableModulesResult, ArchitecturalCyclesResult } from './types.js';
import { isTestFile, normalize } from './utils.js';
import { getGraphs } from './project.js';

export const ENTRY_POINT_PATTERNS = [
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

export function normalizeCycle(chain: string[]): string[] {
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
