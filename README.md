# 🗺️ ast-impact-mapper-mcp

[![npm version](https://img.shields.io/npm/v/ast-impact-mapper-mcp.svg)](https://www.npmjs.com/package/ast-impact-mapper-mcp)
[![npm downloads](https://img.shields.io/npm/dm/ast-impact-mapper-mcp.svg)](https://www.npmjs.com/package/ast-impact-mapper-mcp)
[![CI](https://github.com/vola-trebla/ast-impact-mapper-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vola-trebla/ast-impact-mapper-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that uses the TypeScript AST to determine exactly which tests are affected by a code change — so your AI agent stops running the entire suite and starts running only what matters.

## 🤔 The Problem

When you change `src/utils/auth.ts`, which tests should run? Most tools either run everything (slow) or guess by filename (wrong). Import graphs don't lie — if a test transitively imports the changed file, it needs to run.

This server builds a precise dependency graph from your TypeScript project and answers that question in milliseconds.

## 🛠️ Tools

| Tool                   | Arguments                                       | What it returns                                                       |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `get_affected_tests`   | `project_root`, `changed_files[]` or `git_diff` | Test files that transitively import any of the changed files          |
| `get_dependency_graph` | `project_root`, `file_path`                     | Direct imports and importers for a specific file                      |
| `explain_impact`       | `project_root`, `changed_file`, `test_file`     | Step-by-step import chain from a test file to the changed source file |
| `get_coverage_gaps`    | `project_root`, `source_dirs[]?`, `limit?`      | Source files not reachable from any test — completely untested code   |
| `get_test_summary`     | `project_root`                                  | Coverage rate, most-imported files, deepest import chains             |
| `refresh_project`      | `project_root`                                  | Clears the cached AST — use after git pull or branch switch           |

## 🚀 Setup

### 1. Install

```bash
npm install -g ast-impact-mapper-mcp
```

Or build from source:

```bash
git clone https://github.com/vola-trebla/ast-impact-mapper-mcp.git
cd ast-impact-mapper-mcp
npm install && npm run build
```

### 2. Add the MCP server to your editor

#### Cursor / VS Code (`.cursor/mcp.json` or `.vscode/mcp.json`)

```json
{
  "mcpServers": {
    "ast-impact-mapper": {
      "command": "ast-impact-mapper-mcp"
    }
  }
}
```

#### Claude Code

```bash
claude mcp add ast-impact-mapper ast-impact-mapper-mcp
```

## 💬 Example usage

```
My project root is /my-project. I just changed these files from git diff:
  src/utils/auth.ts
  src/api/userService.ts

1. get_affected_tests — which tests do I need to run?
2. get_dependency_graph for src/utils/auth.ts — what else depends on it?
3. explain_impact — why does tests/login.spec.ts care about auth.ts?
4. get_coverage_gaps — which source files have zero test coverage?
5. get_test_summary — what's the overall health of our test suite?
```

## 📊 Example output

Given a project with this structure:

```
src/
  fixtures/base-fixture.ts   ← imports home-page + results-page
  pages/google-home-page.ts
  pages/google-results-page.ts
tests/
  google-pom.spec.ts         ← imports base-fixture
```

**`get_affected_tests`** — change `google-home-page.ts`, find affected tests:

```json
{
  "changed_files": ["/my-project/src/pages/google-home-page.ts"],
  "affected_tests": ["/my-project/tests/google-pom.spec.ts"],
  "total_affected": 1
}
```

**`explain_impact`** — why does the spec depend on `google-home-page.ts`?

```json
{
  "changed_file": "/my-project/src/pages/google-home-page.ts",
  "test_file": "/my-project/tests/google-pom.spec.ts",
  "found": true,
  "import_chain": [
    "/my-project/tests/google-pom.spec.ts",
    "/my-project/src/fixtures/base-fixture.ts",
    "/my-project/src/pages/google-home-page.ts"
  ]
}
```

**`get_test_summary`** — project-wide health:

```json
{
  "total_source_files": 4,
  "total_test_files": 1,
  "covered_source_files": 3,
  "coverage_rate": 0.75,
  "most_imported_files": [{ "file": "src/fixtures/base-fixture.ts", "imported_by_count": 1 }],
  "deepest_import_chains": [{ "test": "tests/google-pom.spec.ts", "depth": 2 }]
}
```

## 🧠 How it works

The server uses [`ts-morph`](https://ts-morph.com/) to load your TypeScript project (with full tsconfig support, including path aliases) and builds two graphs:

- **Forward graph**: file → files it imports
- **Reverse graph**: file → files that import it

`get_affected_tests` does a BFS through the reverse graph starting from the changed files, collecting every file that transitively depends on them, then filters to `*.spec.ts` / `*.test.ts`.

`explain_impact` does a BFS through the forward graph from the test file until it reaches the changed file, then reconstructs the shortest import path.

The project is cached in memory per `project_root` — the first call parses the AST, subsequent calls reuse it.

## 🔗 Works great with flakiness-knowledge-graph-mcp

- **ast-impact-mapper-mcp** answers "which tests are affected by this change?"
- **[flakiness-knowledge-graph-mcp](https://github.com/vola-trebla/flakiness-knowledge-graph-mcp)** answers "of those tests, which ones are historically unreliable?"

Together, an AI agent can give you a prioritized, minimal test run: the right tests, ranked by flakiness risk.

## 📋 Scripts

```bash
npm run build        # compile TypeScript → dist/
npm run lint         # ESLint
npm run format       # Prettier --write
npm run format:check # Prettier check (used in CI)
```

## 📄 License

MIT
