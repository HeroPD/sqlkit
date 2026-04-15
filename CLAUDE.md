# SqlKit

Electron desktop app — SQL database explorer with VS Code-inspired UI.
Currently PostgreSQL only (MySQL/SQL Server planned).

## Stack

- Electron (dark theme enforced), vanilla JS ES modules, no bundler
- `pg` library for PostgreSQL
- No TypeScript, no tests, no linter

## File Map

```
main.js            — Electron main process: window, IPC handlers (db:*, file:*, workspace:*)
preload.js         — contextBridge exposing `window.sqlkit` API
src/index.html     — Single HTML page: welcome screen + workbench (sidebar, editor, panel)
src/styles.css     — CSS entry point (@imports all css/ modules)
src/js/
  app.js           — Entry point: imports all modules, runs init()
  utils.js         — Shared state, ENGINE_DEFAULTS, $(), el refs, helpers (esc, fmtTime, status)
  layout.js        — App shell: welcome, sidebar, activity bar, sections, resize, toggle
  editor.js        — Editor area: tabs, textarea, line numbers, save dialog
  explorer.js      — Data sidebar: connection, file tree, table tree, browse
  panel.js         — Bottom panel: query execution, results, messages
  palette.js       — Overlay: command palette, COMMANDS, global keyboard shortcuts
src/css/
  theme.css        — :root CSS custom properties (VS Code Dark+ theme)
  base.css         — Reset, body, generic buttons, scrollbar, utility
  layout.css       — App shell: titlebar, screens, workbench, activity bar, sidebar, sections, resize, statusbar, welcome
  components.css   — Interactive parts: connection, file tree, table tree, tabs, editor, panel, results, messages
  overlays.css     — Floating UI: command palette, save dialog
package.json       — electron + pg deps only
```

## Architecture

```
[src/js/*] --ipc--> [preload.js] --invoke--> [main.js] --pg/fs--> [PostgreSQL / disk]
```

- **Modules**: ES modules (`<script type="module">`), circular imports OK (all cross-refs inside functions)
- **Security**: contextIsolation=true, nodeIntegration=false, CSP header set
- **State**: single `state` object in `js/utils.js` (connection, tabs, files, tables, UI)
- **IPC channels**: `db:connect/disconnect/get-tables/get-columns/run-query`, `file:list/read/save/save-new/delete`, `workspace:open/open-path/get-recent/get-last/get-current/save-config/get-config`
- **Workspace**: folder-based, stores config in `.sqlkit/config.json` inside workspace dir
- **Global config**: `app.getPath('userData')/config.json` — recent workspaces, last opened

## Key Patterns

- `esc()` for HTML escaping in template strings (utils.js)
- `$()` shorthand for getElementById (utils.js)
- `el` object caches all DOM refs at startup (utils.js)
- Engine defaults in `ENGINE_DEFAULTS` object per db engine (utils.js)
- Parameterized queries for schema introspection, raw execution for user queries
- Command palette supports two modes: `commands` and `tables` (palette.js)
- Keyboard shortcuts: Cmd+Enter=run, Cmd+S=save, Cmd+N=new, Cmd+W=close, Cmd+B=sidebar, Cmd+Shift+P=commands, Cmd+P=tables (palette.js)

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
