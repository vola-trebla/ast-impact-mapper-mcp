import { Project, SourceFile } from 'ts-morph';
import path from 'path';
import fs, { existsSync } from 'fs';
import { computeMd5, globFiles, normalize } from './utils.js';

export interface CacheEntry {
  mtime: number;
  hash: string;
  imports: string[];
}

export interface CacheData {
  version: string;
  files: Record<string, CacheEntry>;
}

export function getCachePath(projectRoot: string): string {
  return path.join(projectRoot, '.ast-mapper-cache', 'cache.json');
}

export function loadCache(projectRoot: string): CacheData {
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

export function saveCache(projectRoot: string, cache: CacheData): void {
  const cachePath = getCachePath(projectRoot);
  const cacheDir = path.dirname(cachePath);
  if (!existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
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

export function getProject(projectRoot: string, lazy = true): Project {
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
