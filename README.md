# 🗺️ ast-impact-mapper-mcp

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
