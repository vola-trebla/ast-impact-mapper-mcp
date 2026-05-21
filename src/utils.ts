import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export function isTestFile(filePath: string): boolean {
  return /\.(spec|test)\.(ts|tsx|js|jsx)$/.test(filePath) || /\/__tests__\//.test(filePath);
}

export function normalize(filePath: string, projectRoot: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
}

export function computeMd5(filePath: string): string {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
  } catch {
    return '';
  }
}

export function globFiles(dir: string, projectRoot: string): string[] {
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
