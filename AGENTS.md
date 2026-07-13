# AGENTS.md

SqlKit is an Electron + Lit desktop SQL workbench supporting PostgreSQL, MySQL/MariaDB, Microsoft SQL Server, and SQLite. Read this file and `CLAUDE.md` before reviewing or changing the repository.

## Product priorities

- PostgreSQL, MySQL/MariaDB, and SQL Server are the primary engines.
- SQLite is a secondary convenience feature. Do not let SQLite-only edge cases dominate reviews or release decisions.
- This is a trusted-user SQL workbench. Users intentionally execute arbitrary SQL, including stored procedures, functions, multi-statement scripts, and queries with side effects.
- Full-result export explicitly tells the user that it reruns the query. Do not report intentional reruns of user-provided SQL as a security defect.
- Extreme-load failure is not automatically a release blocker. Distinguish normal workload reliability from deliberately accepted behavior under exceptional load.
- Prefer concrete defects with realistic user impact over generic best-practice advice.

## Architecture

- `electron/main.ts` owns application startup, BrowserWindow security, menus, shared per-window state, and shutdown.
- `electron/ipc-workspace.ts` owns workspace and file IPC handlers.
- `electron/ipc-db.ts` owns database IPC handlers.
- `electron/preload.ts` exposes the renderer API; `src/electron.d.ts` defines its types.
- `electron/db/manager.ts` owns connection lifecycle, status, tunnels, result sessions, and driver dispatch.
- `electron/db/driver.ts` defines the shared driver contract.
- `electron/db/postgres.ts`, `mysql.ts`, `mssql.ts`, and `sqlite.ts` contain explicit engine-specific behavior.
- `src/engine-capabilities.ts` documents intentional cross-engine differences such as DDL atomicity, cancellation, row counting, and namespace models.
- `src/dialect.ts` owns placeholders, identifier quoting, browse syntax, and engine-specific editor capabilities.

## Engineering judgement

- Do not recommend splitting cohesive engine driver files merely because they are large. Files under roughly 1,000 lines are considered manageable when keeping engine behavior together improves readability.
- Do not recommend a universal database base class. Important differences between engines should remain explicit.
- Third-party database client libraries are expected. Private or weakly typed driver surfaces are acceptable when isolated, dependency-controlled, and covered by real-engine integration tests.
- Do not treat documented behavior such as exact row counts after draining, MySQL best-effort DDL, pooled stateless query runs, or bounded result truncation as defects.
- Credential fallback behavior is intentional: use OS-backed `safeStorage` when available, warn for weak/unavailable storage, redact secrets from renderer DTOs, and keep config files out of Git.
- Renderer IPC still requires validation and filesystem containment, but do not invent an exploit without a concrete path through the existing sandbox, CSP, navigation controls, and authorization model.
- Avoid speculative production-readiness findings. Signing, notarization, and distribution credentials may be supplied outside the repository.

## Review expectations

- Report only evidence-backed findings with a specific file/function, realistic impact, and proportionate severity.
- It is acceptable to report fewer findings than requested, including none. Never fill a quota with theoretical concerns.
- Separate bugs from accepted product tradeoffs, optional hardening, and operational maturity.
- Do not assign a low score merely because alternative practices exist. Judge fitness for SqlKit's goals.
- Current code quality is approximately 9/10. A materially lower assessment requires concrete, important defects.
- Low-priority durability ideas, such as atomic replacement of an existing export file, belong in the backlog and should not be presented as release blockers.

## Validation

- `npm run lint`
- `npx tsc -b`
- `npm run build`
- `npm test`
- CI provisions PostgreSQL, MySQL, SQL Server, and MariaDB services and runs the real-engine integration suites.
- If a sandbox blocks local TCP connections or listeners, do not report resulting integration failures as application defects.
- `electron/ipc-contract.test.ts` checks `main.ts`, `ipc-workspace.ts`, and `ipc-db.ts` against the preload channels.

## Change conventions

- Preserve existing user changes and avoid unrelated rewrites.
- Keep main, preload, renderer types, validation, and IPC contract tests synchronized when changing a channel.
- Keep comments concise and focused on non-obvious behavior.
- Use `apply_patch` for source edits.
- Run lint and TypeScript after changes; run focused tests plus the broader non-network suite when practical.
