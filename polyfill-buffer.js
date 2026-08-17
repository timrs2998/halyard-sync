// Injected by esbuild (see esbuild.config.mjs) to provide a global `Buffer`
// for isomorphic-git's transitive deps (safe-buffer, sha.js).
//
// On desktop, Obsidian runs in Electron with Node integration, so the real
// Buffer already exists on the global object — use it. On mobile (Capacitor
// webview) there is no Buffer, so fall back to the bundled `buffer` npm
// polyfill. `buffer` is deliberately NOT in esbuild's external list so this
// import resolves to the npm package rather than the Node builtin.
import { Buffer as PolyfillBuffer } from "buffer";

const globalObject =
	typeof globalThis !== "undefined"
		? globalThis
		: typeof window !== "undefined"
			? window
			: undefined;

export const Buffer =
	globalObject && globalObject.Buffer ? globalObject.Buffer : PolyfillBuffer;
