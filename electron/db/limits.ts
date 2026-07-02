// Rows a query buffers in the main process; the renderer pages through these on
// demand (see result-sessions.ts) instead of receiving them all at once.
// rowCount still reports the true count; `truncated` flags a result larger than
// this cap, which the buffer can't reach. Kept in its own module so the SQLite
// worker can import it without pulling in the rest of the driver graph.
export const MAX_BUFFERED_ROWS = 50_000

// Shared rows-affected-gate message for runBatch implementations.
export const BATCH_ZERO_ROWS = 'A change affected no rows; the row may have been modified or removed.'
