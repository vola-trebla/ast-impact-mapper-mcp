#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { getAffectedTests, getDependencyGraph, explainImpact } from "./analyzer.js";

const server = new McpServer({
  name: "ast-impact-mapper",
  version: "0.1.0",
});

const projectSchema = z.object({
  project_root: z
    .string()
    .describe("Absolute path to the TypeScript project root (must contain tsconfig.json)"),
});

function errorResponse(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
    ],
    isError: true,
  };
}

server.registerTool(
  "get_affected_tests",
  {
    description:
      "Given a list of changed source files, returns which test files are affected — " +
      "directly or transitively through the import graph. " +
      "Use to answer: which tests should I run after this code change?",
    inputSchema: projectSchema.extend({
      changed_files: z
        .array(z.string())
        .min(1)
        .describe(
          "List of changed file paths (absolute or relative to project_root). " +
            "Tip: pipe `git diff --name-only` output here."
        ),
    }),
  },
  async ({ project_root, changed_files }) => {
    try {
      const result = getAffectedTests(project_root, changed_files);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_dependency_graph",
  {
    description:
      "Returns the direct import graph for a specific file: " +
      "what it imports, and what imports it. " +
      "Use to answer: what depends on this file? What does this file depend on?",
    inputSchema: projectSchema.extend({
      file_path: z.string().describe("Path to the file (absolute or relative to project_root)"),
    }),
  },
  async ({ project_root, file_path }) => {
    try {
      const result = getDependencyGraph(project_root, file_path);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "explain_impact",
  {
    description:
      "Finds the exact import chain that connects a changed source file to a test file. " +
      "Use to answer: why does changing file X cause test Y to be affected? " +
      "Returns the step-by-step import path from the test to the changed file.",
    inputSchema: projectSchema.extend({
      changed_file: z
        .string()
        .describe("The source file that was changed (absolute or relative to project_root)"),
      test_file: z.string().describe("The test file to explain the connection for"),
    }),
  },
  async ({ project_root, changed_file, test_file }) => {
    try {
      const result = explainImpact(project_root, changed_file, test_file);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
