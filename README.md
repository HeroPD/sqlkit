# sqlkit

SQL desktop client for PostgreSQL, MySQL, SQL Server, and SQLite, built with Electron, Lit, and Vite.

- Tabbed SQL editor (CodeMirror 6) with dialect-aware completion
- Results grid with inline editing, sorting, and CSV/TSV/JSON export
- Table, object, and server inspectors; schema browsing
- SSH tunnels, SSL, and all-databases mode for server engines
- Workspace-scoped .sql files and connection profiles

## Development

```sh
npm install
npm run dev     # Vite + Electron dev mode
npm test        # vitest
npm run lint    # eslint
```

## Packaging

`npm run dist` builds installers via electron-builder (reads signing config from `.env`).

Architecture notes live in [CLAUDE.md](CLAUDE.md).
