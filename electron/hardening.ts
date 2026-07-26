// A release build must not be inspectable. The main process holds database
// credentials in the clear — safeStorage decrypts saved passwords into memory to
// dial a connection — so anything that attaches a debugger reads every password
// the user has saved, and can drive their live connections through the preload
// bridge. Unpackaged runs (npm run dev, the smoke test) keep DevTools.

// Chromium and Node act on these before any application code runs, so they
// cannot be disarmed from here — the only defence left is refusing to start.
// The `electronFuses` block in electron-builder.yml is what actually removes
// the Node ones from a packaged binary; this covers the Chromium side and any
// build whose fuses were not applied.
const INSPECTION_SWITCHES = [
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--remote-allow-origins',
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--inspect-publish-uid',
  // Arbitrary V8 flags reach the same place by a longer road (--js-flags=--prof
  // and friends dump memory to disk).
  '--js-flags',
]

const matches = (argument: string) =>
  INSPECTION_SWITCHES.find((flag) => argument === flag || argument.startsWith(`${flag}=`))

/**
 * The first inspection switch found in a launch, or null when it is clean.
 * `argv` is passed whole (the leading executable path is skipped) and
 * `nodeOptions` is NODE_OPTIONS, which smuggles the same --inspect flags in
 * through the environment.
 */
export function inspectionSwitch(argv: readonly string[], nodeOptions?: string): string | null {
  for (const argument of argv.slice(1)) {
    const found = matches(argument)
    if (found) return found
  }
  for (const token of (nodeOptions ?? '').split(/\s+/)) {
    if (!token) continue
    const found = matches(token)
    if (found) return found
  }
  return null
}
