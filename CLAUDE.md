# CLAUDE.md

SqlKit Studio: Electron main + Lit renderer, Vite-bundled; engines Postgres, MySQL/MariaDB, SQL Server, SQLite. Test via `npm run dev`, not packaged builds (EDR kills them on this machine).

## Architecture

- `electron/main.ts` — startup, window security, menus; IPC handlers in `ipc-db.ts` / `ipc-workspace.ts` (+ `ipc-validation.ts`); broadcasts `db:status` / `workspace:files-changed`.
- `electron/preload.ts` — exposes `window.sqlkit`; renderer types in `src/electron.d.ts`. Keep main/preload/types and `ipc-contract.test.ts` in sync when adding a channel.
- `electron/db/` — `driver.ts` engine-agnostic contract; `postgres.ts` / `mysql.ts` / `mssql.ts` / `sqlite.ts`; `manager.ts` owns live connections by profile ID (status, SSH tunnels, result sessions, single vs all-databases pools).
- `src/components/workbench-screen.ts` — orchestrator; per-(profile + child DB) buckets of tabs/selection/results.
- `src/controllers/` — Lit reactive controllers. Key: `queries.ts` (result trails, staged edits/drafts/deletes, history, tasks), `connections.ts` (statuses + table/column metadata), `result-editing.ts` (write targeting).
- `src/components/sql-editor.ts` — CodeMirror 6; completion merges dialect keywords, tables, alias-resolved columns; EditorStates cached per tab (LRU 20).
- Query flow: `run-query` event → `window.sqlkit.runQuery()` → manager → driver → `results-panel.ts`.
- UI strings: `src/i18n.ts`; theme CSS vars: `src/index.css`; engine quirks: `src/dialect.ts`, `src/engine-capabilities.ts`.

## Conventions

- Comments: single line; two only when the explanation genuinely needs it.
- Lint: `npm run lint` (type-aware). After `lint:fix`, run `tsc -b` — its `no-unnecessary-type-assertion` fix can strip load-bearing assertions on generic DOM methods (`closest`).
- Tests: `npm test` (vitest). Integration suites read `TEST_DATABASE_URL`/`TEST_MYSQL_URL`/`TEST_MSSQL_URL` from `.env` (local docker), skipping when absent.
