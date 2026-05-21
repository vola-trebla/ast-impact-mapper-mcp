#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import {
  getAffectedTests,
  getAffectedTestsByBranch,
  getAffectedTestsByBranchRenameAware,
  identifyUnreachableModules,
  detectArchitecturalCycles,
  differentiateTypeImpact,
  analyzeApiSurfaceMutation,
  getDependencyGraph,
  explainImpact,
  getCoverageGaps,
  getTestSummary,
  parseGitDiff,
  refreshProject,
  getSymbolDependencyGraph,
  generateSkeletonView,
  generateTestCommand,
} from './analyzer.js';

const server = new McpServer({
  name: 'ast-impact-mapper',
  version: '0.3.0',
});

const projectSchema = z.object({
  project_root: z
    .string()
    .describe('Absolute path to the TypeScript project root (must contain tsconfig.json)'),
});

function errorResponse(err: unknown) {
  return {
    content: [
      { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
    ],
    isError: true,
  };
}

server.registerTool(
  'get_affected_tests',
  {
    description:
      'Given a list of changed source files, returns which test files are affected — ' +
      'directly or transitively through the import graph. ' +
      'Use to answer: which tests should I run after this code change?',
    inputSchema: projectSchema.extend({
      changed_files: z
        .array(z.string())
        .optional()
        .describe('List of changed file paths (absolute or relative to project_root)'),
      git_diff: z
        .string()
        .optional()
        .describe(
          'Raw output of `git diff --name-only` — newline-separated file paths. ' +
            'Use instead of changed_files when piping git output directly.'
        ),
    }),
  },
  async ({ project_root, changed_files, git_diff }) => {
    try {
      const files =
        git_diff !== undefined ? parseGitDiff(project_root, git_diff) : (changed_files ?? []);
      if (files.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { changed_files: [], affected_tests: [], total_affected: 0 },
                null,
                2
              ),
            },
          ],
        };
      }
      const result = getAffectedTests(project_root, files);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'explain_impact',
  {
    description:
      'Finds the exact import chain that connects a changed source file to a test file. ' +
      'Use to answer: why does changing file X cause test Y to be affected? ' +
      'Returns the step-by-step import path from the test to the changed file.',
    inputSchema: projectSchema.extend({
      changed_file: z
        .string()
        .describe('The source file that was changed (absolute or relative to project_root)'),
      test_file: z.string().describe('The test file to explain the connection for'),
    }),
  },
  async ({ project_root, changed_file, test_file }) => {
    try {
      const result = explainImpact(project_root, changed_file, test_file);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'get_affected_tests_by_branch',
  {
    description:
      'Runs `git diff --name-only <base_branch>...HEAD` internally and returns affected test files. ' +
      'Use instead of get_affected_tests when you want the server to handle the git diff automatically.',
    inputSchema: projectSchema.extend({
      base_branch: z.string().default('main').describe('Branch to diff against (default: main)'),
    }),
  },
  async ({ project_root, base_branch }) => {
    try {
      const result = getAffectedTestsByBranch(project_root, base_branch);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'get_dependency_graph',
  {
    description:
      'Returns the direct import graph for a specific file: ' +
      'what it imports, and what imports it. ' +
      'Use to answer: what depends on this file? What does this file depend on?',
    inputSchema: projectSchema.extend({
      file_path: z.string().describe('Path to the file (absolute or relative to project_root)'),
      format: z
        .enum(['json', 'mermaid'])
        .default('json')
        .describe('Output format — json (default) or mermaid flowchart diagram'),
    }),
  },
  async ({ project_root, file_path, format }) => {
    try {
      const result = getDependencyGraph(project_root, file_path, format);
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'get_coverage_gaps',
  {
    description:
      'Finds source files that are not reachable from any test file through the import graph — ' +
      'i.e. completely untested code. ' +
      'Use to answer: which parts of the codebase have zero test coverage?',
    inputSchema: projectSchema.extend({
      source_dirs: z
        .array(z.string())
        .optional()
        .describe(
          'Restrict results to these directories (absolute or relative to project_root). ' +
            'Defaults to the entire project.'
        ),
      limit: z.number().int().min(1).max(200).default(50).describe('Max uncovered files to return'),
    }),
  },
  async ({ project_root, source_dirs, limit }) => {
    try {
      const result = getCoverageGaps(project_root, { sourceDirs: source_dirs, limit });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'get_test_summary',
  {
    description:
      "Returns a bird's-eye view of the project's test structure: coverage rate, " +
      'most-imported source files (highest risk to change), and tests with the deepest import chains. ' +
      'Use to answer: what is the overall test health of this project?',
    inputSchema: projectSchema,
  },
  async ({ project_root }) => {
    try {
      const result = getTestSummary(project_root);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'identify_unreachable_modules',
  {
    description:
      'Finds source files that are never imported by any other file — dead code candidates safe to delete. ' +
      'Automatically excludes known entry points (index.ts, main.ts, pages/, routes/, app/, api/, bin/). ' +
      'Use to answer: which files in this codebase are orphaned and can be safely removed?',
    inputSchema: projectSchema.extend({
      entry_points: z
        .array(z.string())
        .optional()
        .describe(
          'Additional entry point files to exclude (absolute or relative to project_root). ' +
            'Common patterns like index.ts and pages/ are auto-excluded.'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe('Max unreachable files to return (default: 50)'),
    }),
  },
  async ({ project_root, entry_points, limit }) => {
    try {
      const result = identifyUnreachableModules(project_root, {
        entryPoints: entry_points,
        limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'detect_architectural_cycles',
  {
    description:
      'Detects circular import dependencies — A imports B which imports C which imports A. ' +
      'Cycles cause unpredictable module initialization order and indicate tight coupling. ' +
      'Use to answer: are there circular dependencies I need to break before refactoring?',
    inputSchema: projectSchema,
  },
  async ({ project_root }) => {
    try {
      const result = detectArchitecturalCycles(project_root);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'differentiate_type_impact',
  {
    description:
      'Classifies each changed file as type-only or runtime, then splits affected tests into ' +
      '"must run" vs "skippable". A test is skippable when the changed file contains only ' +
      'TypeScript type declarations (interfaces/type aliases) or the test imports it via `import type`. ' +
      'Use to answer: which tests can I skip after a type-only refactor?',
    inputSchema: projectSchema.extend({
      changed_files: z
        .array(z.string())
        .describe('Changed file paths (absolute or relative to project_root)'),
    }),
  },
  async ({ project_root, changed_files }) => {
    try {
      const result = differentiateTypeImpact(project_root, changed_files);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'analyze_api_surface_mutation',
  {
    description:
      'Compares a file against its HEAD version and classifies the change as ' +
      '`breaking_api_change` (exported function signature changed, parameter removed/added, ' +
      'interface field removed) or `internal_refactor` (only implementation body changed). ' +
      'Use to answer: is this PR a breaking change or a safe refactor?',
    inputSchema: projectSchema.extend({
      file_path: z
        .string()
        .describe('Path to the changed file (absolute or relative to project_root)'),
    }),
  },
  async ({ project_root, file_path }) => {
    try {
      const result = analyzeApiSurfaceMutation(project_root, file_path);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'get_rename_aware_diff',
  {
    description:
      'Like get_affected_tests_by_branch, but correctly handles renamed and moved files. ' +
      'Uses --find-renames to detect file moves and --ignore-all-space to skip whitespace-only changes. ' +
      'Use instead of get_affected_tests_by_branch when the branch contains refactors or file moves.',
    inputSchema: projectSchema.extend({
      base_branch: z.string().default('main').describe('Branch to diff against (default: main)'),
      similarity_threshold: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(90)
        .describe('Minimum similarity % to consider a file move a rename (default: 90)'),
    }),
  },
  async ({ project_root, base_branch, similarity_threshold }) => {
    try {
      const result = getAffectedTestsByBranchRenameAware(
        project_root,
        base_branch,
        similarity_threshold
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'refresh_project',
  {
    description:
      'Clears the cached AST for a project root, forcing a full re-parse on the next call. ' +
      'Use after switching branches, running git pull, or adding/removing files.',
    inputSchema: projectSchema,
  },
  async ({ project_root }) => {
    try {
      refreshProject(project_root);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { project_root, message: 'Cache cleared. Next call will re-parse the project.' },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'get_symbol_dependency_graph',
  {
    description:
      'Retrieves a bidirectional or directed dependency graph mapped to individual declarations, functions, and variables.',
    inputSchema: projectSchema.extend({
      filePath: z.string().describe('Absolute path to the TypeScript source file'),
      symbolName: z
        .string()
        .optional()
        .describe('Target export symbol. If omitted, maps all symbols in the file'),
      direction: z
        .enum(['forward', 'reverse', 'bidirectional'])
        .default('bidirectional')
        .describe('Graph traversal direction'),
    }),
  },
  async ({ project_root, filePath, symbolName, direction }) => {
    try {
      const result = getSymbolDependencyGraph(project_root, filePath, symbolName, direction);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'generate_skeleton_view',
  {
    description:
      'Generates a token-optimized representation of a source file by stripping function and method bodies, keeping only JSDocs and declarations with line numbers.',
    inputSchema: projectSchema.extend({
      filePath: z.string().describe('Absolute path to the target source file'),
      includeJSDoc: z.boolean().default(true).describe('Whether to preserve JSDoc annotations'),
      includePrivateMembers: z
        .boolean()
        .default(false)
        .describe('Whether to list private/internal symbols'),
    }),
  },
  async ({ project_root, filePath, includeJSDoc, includePrivateMembers }) => {
    try {
      const result = generateSkeletonView(
        project_root,
        filePath,
        includeJSDoc,
        includePrivateMembers
      );
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  'generate_test_command',
  {
    description:
      'Outputs the optimal test execution command for Jest, Vitest, or Playwright based on changed files.',
    inputSchema: projectSchema.extend({
      changedFiles: z.array(z.string()).describe('List of modified source file paths'),
      runner: z
        .enum(['jest', 'vitest', 'playwright'])
        .default('vitest')
        .describe('Test runner to target'),
    }),
  },
  async ({ project_root, changedFiles, runner }) => {
    try {
      const result = generateTestCommand(project_root, changedFiles, runner);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
