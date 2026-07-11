// Ceiling for one db:fetch-rows request, shared by the main-process validator
// and the renderer's export drain (pages are additionally byte-capped there).
export const MAX_FETCH_ROWS = 5000
