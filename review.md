# Review Notes — ast-impact-mapper-mcp v0.2.0

Overall: ship-ready. All 12 tools work via stdio, versions synced, package clean.

## 1. README was missing v2 tools (fixed)

Tool table only listed 6 original tools. Five new v2 tools were absent.
Fixed: table split into "Impact analysis" and "Code health" sections, all 12 tools documented.

## 2. Edge case: nonexistent project_root returns empty result, not error

`identify_unreachable_modules` on `/nonexistent/path` returns `{ total_source_files: 0, unreachable_files: [] }` with no explanation. Not `isError: true`.
Low priority — ts-morph silently returns empty project. Acceptable for now.

## 3. Cache freshness (section 10)

`projectCache` caches per `project_root`. After file changes on disk, users must call `refresh_project`. This is documented in the tool description and README.
`refresh_project → identify_unreachable_modules` sequence tested: works correctly.

## Verification run

- `npm run build` — clean
- `npm test` — 33/33 passing
- `npm run lint` — clean
- `npm run format:check` — clean
- `npm pack --dry-run` — dist/, README.md, LICENSE, server.json all present
- `npm pack + npm install + npx` — binary runs
- `git remote -v` — SSH remote confirmed
- version sync: package.json=0.2.0, serverInfo=0.2.0, server.json=0.2.0/0.2.0
- `tools/list` — all 12 tools registered
- `tools/call` via stdio for all 5 new tools against `sample-playwright-project` — no errors
- edge case: nonexistent path → empty result (no crash)
- npm: `latest=0.2.0` ✓
- MCP Registry: `0.2.0 isLatest=True` ✓
