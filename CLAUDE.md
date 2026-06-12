# CLAUDE.md

SQL desktop app: Electron main process + Lit renderer, bundled with Vite. Test via `npm run dev`, not packaged builds (EDR kills them on this machine).

## Architecture

- `electron/main.ts` — entry; all `ipcMain.handle()` handlers (`workspace:*`, `file:*`, `db:*`); broadcasts `db:status` / `workspace:files-changed`.
- `electron/preload.ts` — exposes `window.sqlkit`; renderer types in `src/electron.d.ts`. Keep main/preload/types in sync when adding an IPC channel.
- `electron/db/` — `driver.ts` engine-agnostic interface; `postgres.ts`, `sqlite.ts` implementations; `manager.ts` owns live connections by profile ID (status, SSH tunnel via `sshTunnel.ts`, `single` vs `all`-databases mode with per-child pools).
- `src/app-root.ts` — renderer entry; welcome screen ↔ `workbench-screen.ts`.
- `src/controllers/` — Lit reactive controllers: `connections.ts` (statuses + table/column metadata), `files.ts` (file tree).
- `src/components/workbench-screen.ts` — orchestrator; keeps per-(profile + child DB) buckets of tabs/selection/results, swaps on database switch.
- `src/components/sql-editor.ts` — CodeMirror 6; completion merges dialect keywords (`src/codemirror/dialects.ts`), tables, and alias-resolved `table.column` from `listColumns()` metadata; EditorStates cached per tab (LRU 20) so undo/selection survive remounts.
- Query flow: editor `run-query` event → `window.sqlkit.runQuery()` → manager → driver → `results-panel.ts`.
- Theming: CSS variables in `src/index.css`.