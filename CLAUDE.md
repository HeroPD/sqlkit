# SqlKit

Electron desktop app — SQL database explorer with VS Code-inspired UI.
Currently PostgreSQL only (MySQL/SQL Server planned).

## Stack

- Electron (dark theme enforced), vanilla JS, no bundler
- `pg` library for PostgreSQL
- No TypeScript, no tests, no linter

## File Map

```
main.js          — Electron main process: window, IPC handlers (db:*, file:*, workspace:*)
preload.js       — contextBridge exposing `window.sqlkit` API (26 lines, just IPC wrappers)
src/index.html   — Single HTML page: welcome screen + workbench (sidebar, editor, panel)
src/renderer.js  — All UI logic: state, DOM, tabs, query execution, command palette (~1177 lines)
src/styles.css   — Full CSS with VS Code Dark+ theme variables (~1244 lines)
package.json     — electron + pg deps only
```

## Architecture

```
[renderer.js] --ipc--> [preload.js] --invoke--> [main.js] --pg/fs--> [PostgreSQL / disk]
```

- **Security**: contextIsolation=true, nodeIntegration=false, CSP header set
- **State**: single `state` object in renderer.js (connection, tabs, files, tables, UI)
- **IPC channels**: `db:connect/disconnect/get-tables/get-columns/run-query`, `file:list/read/save/save-new/delete`, `workspace:open/open-path/get-recent/get-last/get-current/save-config/get-config`
- **Workspace**: folder-based, stores config in `.sqlkit/config.json` inside workspace dir
- **Global config**: `app.getPath('userData')/config.json` — recent workspaces, last opened

## Key Patterns

- `esc()` for HTML escaping in template strings (renderer.js:1168)
- `$()` shorthand for getElementById (renderer.js:34)
- Engine defaults in `ENGINE_DEFAULTS` object per db engine
- Parameterized queries for schema introspection, raw execution for user queries
- Command palette supports two modes: `commands` and `tables`
- Keyboard shortcuts: Cmd+Enter=run, Cmd+S=save, Cmd+N=new, Cmd+W=close, Cmd+B=sidebar, Cmd+Shift+P=commands, Cmd+P=tables

## Known Issues (from review 2026-04-15)

- **Security**: file:read/save/delete accept arbitrary paths (no workspace validation)
- **Bug**: electron pinned to "latest" (non-reproducible builds)
- **Bug**: closeTab doesn't warn about unsaved changes
- **Perf**: renderResults creates DOM for up to 10k rows (no virtual scroll)
- **Missing**: no query timeout, no query cancellation, no file watcher, single pg.Client blocks on long queries

## How to Update This File

Run: `/init` or ask Claude to "update CLAUDE.md" after making significant changes.
Things to update: file map if files added/removed, architecture if IPC channels change,
known issues as they're fixed or new ones found.
