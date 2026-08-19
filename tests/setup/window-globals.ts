/**
 * Obsidian plugins run in a browser-like host — Electron's renderer on
 * desktop, a Capacitor webview on mobile — so plugin code schedules timers
 * through `window` rather than the bare globals (Obsidian's plugin guidelines
 * require this: a popout window has its own `window`, and a timer registered
 * on the wrong one never fires there).
 *
 * Vitest runs these unit tests in plain Node, which has no `window` at all.
 * Rather than pull in a full DOM implementation for what amounts to four timer
 * functions, point `window` at the Node global object — `setTimeout`,
 * `setInterval` and their clear-counterparts already live there with matching
 * semantics.
 */
if (typeof globalThis.window === "undefined") {
	(globalThis as { window?: unknown }).window = globalThis;
}
