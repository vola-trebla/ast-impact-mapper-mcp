import { Project, SyntaxKind, SourceFile } from 'ts-morph';
import { execSync } from 'child_process';
import path from 'path';
import { DifferentiateTypeImpactResult, ApiSurfaceMutationResult, ApiMutation } from './types.js';
import { isTestFile, normalize } from './utils.js';
import { getGraphs, getProject, getOrAddSourceFile } from './project.js';

export const TYPE_ONLY_KINDS = new Set([
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.ImportDeclaration,
]);

export function isTypeOnlyFile(projectRoot: string, filePath: string): boolean {
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

export function importsViaTypeOnly(
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

export function extractSignatures(sf: SourceFile): Map<string, string> {
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

export function sigKind(sig: string): string {
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
