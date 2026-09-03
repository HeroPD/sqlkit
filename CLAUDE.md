# CLAUDE.md

SqlKit Studio: Electron main + Lit renderer, Vite-bundled; engines Postgres, MySQL/MariaDB, SQL Server, SQLite. Test via `npm run dev`, not packaged builds (EDR kills them on this machine).

## Architecture

- `electron/main.ts` — startup, window security, menus; IPC handlers in `ipc-db.ts` / `ipc-workspace.ts` (+ `ipc-validation.ts`); broadcasts `db:status` / `workspace:files-changed`.
- `electron/preload.ts` — exposes `window.sqlkit`; renderer types in `src/electron.d.ts`. Keep main/preload/types and `ipc-contract.test.ts` in sync when adding a channel.
- `electron/db/` — `driver.ts` engine-agnostic contract; `postgres.ts` / `mysql.ts` / `mssql.ts` / `sqlite.ts`; `manager.ts` owns live connections by profile ID (status, SSH tunnels, result sessions, single vs all-databases pools).
- `src/components/workbench-screen.ts` — orchestrator; per-(profile + child DB) buckets of tabs/selection/results.
- `src/controllers/` — Lit reactive controllers. Key: `queries.ts` (result trails, staged edits/drafts/deletes, history, tasks), `connections.ts` (statuses + table/column metadata), `result-editing.ts` (write targeting), `session.ts` (hot exit).
- Hot exit (`electron/session.ts`, `src/controllers/session.ts`): open tabs persist to `.sqlkit/session.json`, unsaved buffers to `.sqlkit/backups/`. A workspace can be open in more than one window; each claims a session slot (`electron/workspace-windows.ts`) owning its own session file and backups directory. The config and history are shared, so a window writes a *patch* of what it changed (never a whole-file snapshot) and siblings are told to re-read. **The on-disk contract is documented at the top of `electron/session.ts` and has shipped — read it before changing the format.** Writes are continuous and debounced (that is what survives a kill), with a synchronous `session:flush` on `pagehide` and before quit. Each write reconciles buffers from `ContextsController.sessionBuffers()` before pruning unclaimed ones, since editor events only report the tab being typed in. `src/session-recovery.ts` holds the "only describe what can be restored" rule, applied by the renderer for debounced writes and by main for the flush, the only side that learns whether those writes landed. Main flushes a window before repointing its workspace; the workbench flushes on close, where app-root drops the workspace without awaiting. Restoring is silent. Results, staged row edits, and secrets are never persisted.
- `src/components/sql-editor.ts` — CodeMirror 6; completion merges dialect keywords, tables, alias-resolved columns; EditorStates cached per tab (LRU 20).
- Query flow: `run-query` event → `_runSql` (parameter prompt, then the destructive preflight of `src/sql-destructive.ts`) → `window.sqlkit.runQuery()` → manager → driver → `results-panel.ts`. Statement splitting is shared with the main process via `src/sql-statements.ts`.
- UI strings: `src/i18n.ts`; theme CSS vars: `src/index.css`; engine quirks: `src/dialect.ts`, `src/engine-capabilities.ts`.

## Conventions

- Comments: single line; two only when the explanation genuinely needs it.
- Lint: `npm run lint` (type-aware). After `lint:fix`, run `tsc -b` — its `no-unnecessary-type-assertion` fix can strip load-bearing assertions on generic DOM methods (`closest`).
- Tests: `npm test` (vitest). Integration suites read `TEST_DATABASE_URL`/`TEST_MYSQL_URL`/`TEST_MSSQL_URL` from `.env` (local docker), skipping when absent.
