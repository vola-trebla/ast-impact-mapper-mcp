# 🗺️ ast-impact-mapper-mcp ✨

[![npm version](https://img.shields.io/npm/v/ast-impact-mapper-mcp.svg)](https://www.npmjs.com/package/ast-impact-mapper-mcp)
[![npm downloads](https://img.shields.io/npm/dm/ast-impact-mapper-mcp.svg)](https://www.npmjs.com/package/ast-impact-mapper-mcp)
[![CI](https://github.com/vola-trebla/ast-impact-mapper-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vola-trebla/ast-impact-mapper-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **"Stop boiling the ocean. Run only the tests that actually care about your changes."** 🐸

`ast-impact-mapper-mcp` is an advanced Model Context Protocol (MCP) server that analyzes your TypeScript/JavaScript codebase using AST parsing (`ts-morph`) and dependency graph tracing. It helps AI agents (like Claude or Cursor) target only the relevant tests, find dead code, identify circular import dependencies, and trace API mutations.

---

## 🧐 Why import graphs?

Guessing affected tests based on matching filenames (e.g. `auth.ts` -> `auth.test.ts`) is highly inaccurate. Running the entire test suite on every minor change is extremely slow.

**Import graphs do not lie.** If a test file transitively imports a modified source file, it must be run. `ast-impact-mapper-mcp` builds a bidirectional file dependency graph and answers "which tests should I run?" in milliseconds.

---

## 💡 Quick Showcase (Real-World e2e Flow)

Imagine your AI agent modifies a shared helper: `src/utils/auth.ts`. Instead of blindly running all tests or guessing by name, the agent uses this MCP server:

### 1. Identify Affected Tests

The agent calls `get_affected_tests` with the changed file:

```json
// Tool Call: get_affected_tests({ changed_files: ["src/utils/auth.ts"] })
{
  "changed_files": ["/project/src/utils/auth.ts"],
  "affected_tests": ["/project/tests/checkout.spec.ts"],
  "total_affected": 1
}
```

### 2. Explain the Connection

To understand why `checkout.spec.ts` depends on `auth.ts`, the agent calls `explain_impact`:

```json
// Tool Call: explain_impact({ changed_file: "src/utils/auth.ts", test_file: "tests/checkout.spec.ts" })
{
  "found": true,
  "import_chain": [
    "/project/tests/checkout.spec.ts",
    "/project/src/fixtures/user-fixture.ts",
    "/project/src/utils/auth.ts"
  ]
}
```

_Aha! The checkout spec imports the user-fixture, which imports auth!_

### 3. Check for Runtime Impact

If the change in `auth.ts` was only adding a TypeScript interface (type-only change), calling `differentiate_type_impact` tells the agent:

```json
{
  "files": [{ "file": "/project/src/utils/auth.ts", "runtime_impact": false }],
  "total_tests_must_run": 0,
  "total_tests_skippable": 1
}
```

_Success! Since it is a type-only change, the agent can skip running tests entirely, saving precious CPU cycles and time._

### 4. Run Minimal Tests

If it _does_ contain runtime changes, the agent requests the execution command:

```json
// Tool Call: generate_test_command({ changed_files: ["src/utils/auth.ts"], runner: "vitest" })
{
  "command": "npx vitest run tests/checkout.spec.ts"
}
```

---

## 🛠️ MCP Tools Reference

All tools are configured with consistent, type-safe schemas (arguments in `snake_case`).

### 1. Impact Mapping & Tracing

- #### `get_affected_tests`

  Finds all test files transitively importing changed source files.
  - **Arguments:**
    - `project_root` (string, required): Absolute path to the TypeScript project.
    - `changed_files` (string[], optional): Modified file paths.
    - `git_diff` (string, optional): Raw stdout of `git diff --name-only`.
  - **Returns:** Detailed map of changed files, affected tests, and totals.

- #### `get_affected_tests_by_branch`

  Automatically diffs the current state against a base branch using git to find affected tests.
  - **Arguments:**
    - `project_root` (string, required)
    - `base_branch` (string, default: `"main"`): Branch to compare against.

- #### `get_rename_aware_diff`

  Highly robust branch impact analysis that tracks file moves/renames (via `git diff -M`) and ignores formatting/whitespace changes.
  - **Arguments:**
    - `project_root` (string, required)
    - `base_branch` (string, default: `"main"`)
    - `similarity_threshold` (number, default: `90`): % similarity threshold to declare a move.

- #### `explain_impact`

  Traces and explains the exact chain of imports showing why a changed source file affects a specific test.
  - **Arguments:**
    - `project_root` (string, required)
    - `changed_file` (string, required)
    - `test_file` (string, required)

- #### `generate_test_command`
  Constructs CLI commands for test runners (`vitest`, `jest`, or `playwright`) matching the affected tests subset.
  - **Arguments:**
    - `project_root` (string, required)
    - `changed_files` (string[], required)
    - `runner` (enum: `jest`, `vitest`, `playwright`, default: `vitest`)

---

### 2. TypeScript-specific Deep Code Analysis

- #### `differentiate_type_impact`

  Inspects imports and types to isolate type-only changes (interfaces, types, or `import type` exports). Helps skip test execution entirely if the changes do not impact the runtime bundle!
  - **Arguments:**
    - `project_root` (string, required)
    - `changed_files` (string[], required)

- #### `analyze_api_surface_mutation`

  Compares a file against its `HEAD` version and determines if it modifies the public API (`breaking_api_change`) or only contains internal implementation edits (`internal_refactor`).
  - **Arguments:**
    - `project_root` (string, required)
    - `file_path` (string, required)

- #### `generate_skeleton_view`

  Generates a token-optimized skeleton of a file by stripping out function and method bodies, keeping only signatures, JSDocs, and line numbers.
  - **Arguments:**
    - `project_root` (string, required)
    - `file_path` (string, required)
    - `include_jsdoc` (boolean, default: `true`)
    - `include_private_members` (boolean, default: `false`)

- #### `get_symbol_dependency_graph`
  Traces declaration-level dependencies (functions, classes, variables) across files, finding internal declarations usage.
  - **Arguments:**
    - `project_root` (string, required)
    - `file_path` (string, required)
    - `symbol_name` (string, optional): Specific export symbol to map.
    - `direction` (enum: `forward`, `reverse`, `bidirectional`, default: `bidirectional`)

---

### 3. Codebase Health & Graph Insights

- #### `identify_unreachable_modules`

  Finds orphaned source files that have zero incoming imports (dead code safe to prune). Automatically respects standard entry points.
  - **Arguments:**
    - `project_root` (string, required)
    - `entry_points` (string[], optional): Explicit entry-points to exclude from warning.
    - `limit` (number, default: `50`)

- #### `detect_architectural_cycles`

  Locates circular dependency loops (e.g. `A → B → C → A`) which cause unpredictable module initialization orders.
  - **Arguments:**
    - `project_root` (string, required)

- #### `get_dependency_graph`

  Returns direct imports/importers of a file in JSON format or as a visual **Mermaid TD flowchart**.
  - **Arguments:**
    - `project_root` (string, required)
    - `file_path` (string, required)
    - `format` (enum: `json`, `mermaid`, default: `json`)

- #### `get_coverage_gaps`

  Identifies files with zero import coverage — those that are never imported by any test file.
  - **Arguments:**
    - `project_root` (string, required)
    - `source_dirs` (string[], optional)
    - `limit` (number, default: `50`)

- #### `get_test_summary`

  Provides a high-level view of test coverage rate, deepest import chains, and high-risk most-imported modules.
  - **Arguments:**
    - `project_root` (string, required)

- #### `refresh_project`
  Invalidates AST and dependency graphs cache. Run this after checking out branches or pulling remote git updates.
  - **Arguments:**
    - `project_root` (string, required)

---

## 🚀 Installation & Setup

### 1. Global Installation

```bash
npm install -g ast-impact-mapper-mcp
```

### 2. Configure Editor / Agent Client

#### VS Code / Cursor

Add the following to your `.cursor/mcp.json` or `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "ast-impact-mapper": {
      "command": "npx",
      "args": ["-y", "ast-impact-mapper-mcp"]
    }
  }
}
```

#### Claude Code CLI

```bash
claude mcp add ast-impact-mapper npx -- -y ast-impact-mapper-mcp
```

---

## 💬 Example Scenario

Imagine you modify a shared page component: `src/pages/login-page.ts`.

1. **AI Agent runs `get_rename_aware_diff`**:
   It detects that only `tests/auth.spec.ts` imports the page object transitively.
2. **AI Agent runs `differentiate_type_impact`**:
   It sees you only added a type definition interface, classifying it as `type_only_change` -> it skips running the test execution completely, saving developer cycles!
3. **AI Agent runs `explain_impact`**:
   If asked why `tests/auth.spec.ts` depends on it, it renders the path:
   `tests/auth.spec.ts` → `src/fixtures/app.ts` → `src/pages/login-page.ts`.

---

## 🔗 The Ecosystem

- **`ast-impact-mapper-mcp`** answers: _"Which tests are affected by my changes?"_ 🗺️
- **[`flakiness-graph-mcp`](https://github.com/vola-trebla/flakiness-graph-mcp)** answers: _"Of those affected tests, which ones are historically unstable?"_ 📊
- Together, they form a perfect feedback loop for running a prioritized, resilient, and minimal test suite.

---

## 🛠️ CLI Development

```bash
npm run build        # Compile TypeScript to dist/
npm run lint         # Run ESLint validation
npm run format       # Format files via Prettier
npm test             # Run unit tests via Vitest
```

---

## 📄 License

MIT © vola-trebla 🐸
