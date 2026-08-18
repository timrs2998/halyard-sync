/**
 * The compiled libgit2 `.wasm`, embedded in `main.js` as base64.
 *
 * It has to be embedded rather than shipped as a sibling file, because no
 * Obsidian install path delivers a fourth file. Obsidian's community-plugin
 * installer and BRAT both fetch exactly `manifest.json`, `main.js` and
 * `styles.css` from a release and ignore every other asset — so a separate
 * `tether-libgit2.wasm` reaches only users who copy files by hand, and
 * everyone else gets ENOENT at first sync.
 *
 * Fetching it at runtime instead is not an option: Obsidian's developer
 * policies forbid a plugin carrying its own update mechanism and require every
 * network destination to be disclosed, and it would make a working install
 * depend on being online.
 *
 * The cost is roughly 2.3 MB of base64 in `main.js`. `esbuild.config.mjs`'s
 * `.wasm` base64 loader does the encoding at build time; the decode below runs
 * once per engine construction.
 */

import wasmBase64 from "./build/dist/tether-libgit2.wasm";

/** Decodes the embedded module. `atob` exists on both Electron and the
 * Capacitor webview, which `Buffer` and `fs` do not. */
export function libgit2WasmBytes(): ArrayBuffer {
	const binary = atob(wasmBase64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}
