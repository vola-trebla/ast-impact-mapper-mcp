import { Node, SyntaxKind } from 'ts-morph';
import path from 'path';
import { FileDependencies } from './types.js';
import { normalize } from './utils.js';
import { getGraphs, getProject, getOrAddSourceFile } from './project.js';

export interface SymbolNode {
  id: string;
  name: string;
  file: string;
  kind: string;
}

export interface SymbolEdge {
  from: string;
  to: string;
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
