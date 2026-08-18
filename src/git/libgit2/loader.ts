/**
 * Loads the compiled libgit2-WASM module for real, inside the actual running
 * plugin (or a Node test harness standing in for it) — the missing piece
 * this directory's README flagged as "not cut over into the plugin yet."
 *
 * ---------------------------------------------------------------------------
 * The WASM-packaging decision (read this before changing how this loads)
 * ---------------------------------------------------------------------------
 *
 * esbuild bundles this plugin into a single `main.js`. The compiled
 * Emscripten glue (`build/dist/tether-libgit2.js`) is plain JS with no
 * special loading needs, so it is imported statically below and esbuild
 * inlines it directly into `main.js` like any other module. The `.wasm`
 * binary needs a real decision, and the options were:
 *
 *   1. **Emscripten's default `locateFile`-based fetch/readFileSync.**
 *      Rejected: it branches on `ENVIRONMENT_IS_NODE`/`ENVIRONMENT_IS_WEB`
 *      (confirmed by reading the real compiled glue — see this repo's
 *      notes for the exact `ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node
 *      && globalThis.process?.type!="renderer"` check), and neither branch
 *      is right here: Obsidian desktop is Electron's renderer process (so
 *      `ENVIRONMENT_IS_NODE` is actually FALSE there — `process.type` is
 *      `"renderer"`), and mobile has no `fetch` path that would resolve a
 *      same-origin relative URL the way a real web page's `<script src>`
 *      would (there's no HTTP server here at all). Neither codepath was
 *      built for "read the bytes via `app.vault.adapter`."
 *   2. **Base64-embed the `.wasm` inside `main.js`.** Rejected on a
 *      cost/benefit basis, not by default: this plugin's own `DESIGN.md`
 *      already accepts real mobile-memory constraints (shallow clones,
 *      whole-buffered HTTP responses) when the alternative is real
 *      complexity for a real benefit, so "it costs bundle size" alone isn't
 *      a sufficient reason to reject an option — but here it buys nothing:
 *      the compiled `.wasm` (1.67 MB) would cost ~2.2 MB as base64 text
 *      PLUS the decode step, entirely to avoid shipping one extra file next
 *      to `main.js`/`manifest.json`/`styles.css` — a file `manifest.dir`-relative
 *      `app.vault.adapter.readBinary` can already reach for free (see next
 *      point). No mobile-memory or CORS constraint favors base64 here; it is
 *      pure downside for this specific case.
 *   3. **`Module.instantiateWasm` override reading bytes via
 *      `app.vault.adapter.readBinary`, keyed off `manifest.dir`.** Chosen.
 *      `DESIGN.md`'s claim that the DataAdapter "operates below the vault
 *      index and can read dotfiles" is really a claim about `.git/`
 *      specifically; this loader depends on a DIFFERENT (but standard, and
 *      independently confirmed by the phase's own Node-based test below)
 *      fact: `manifest.dir` (a vault-relative path, typically
 *      `.obsidian/plugins/<id>`) is just as reachable through the same
 *      adapter as any other vault path, dotfile or not — this is the
 *      well-precedented pattern other Obsidian plugins shipping a compiled
 *      WASM/binary asset alongside `main.js` already use. The compiled
 *      glue's own `createWasm()` checks `Module["instantiateWasm"]` FIRST,
 *      unconditionally, before any environment branching (confirmed by
 *      reading the real compiled output — see phase notes), so this
 *      override point is honored regardless of `ENVIRONMENT_IS_NODE`/`_WEB`.
 *
 * ---------------------------------------------------------------------------
 * What's proven here vs. what still needs a real Obsidian smoke test
 * ---------------------------------------------------------------------------
 *
 * PROVEN (real, in `tests/libgit2/loader.test.ts`): `instantiateLibgit2Module`
 * below, given a `readWasmBytes` callback returning the ACTUAL compiled
 * `.wasm` bytes read off disk (standing in for
 * `app.vault.adapter.readBinary(manifest.dir + "/tether-libgit2.wasm")`),
 * successfully instantiates the real compiled module end-to-end (calls a
 * real libgit2 entry point afterwards to prove the returned `Module` is
 * fully functional, not just "didn't throw"). This proves the loading
 * MECHANISM (the `instantiateWasm` override contract, the manual
 * failure-propagation wrapper below) works against the real artifact.
 *
 * NOT PROVEN (no real Obsidian environment available to this phase): that
 * `this.manifest.dir` resolves to a real, readable path via
 * `app.vault.adapter.readBinary` inside an actual running Obsidian instance
 * on desktop or mobile, that the esbuild-bundled copy of the compiled glue
 * behaves identically once wrapped in Obsidian's own plugin-loading CJS
 * wrapper, or that the `tether-libgit2.wasm` file actually ships correctly
 * from a real install (manual vault-folder copy, BRAT, or a future
 * community-plugin release all need to include that extra file next to
 * `main.js`/`manifest.json`/`styles.css` — `esbuild.config.mjs` copies it
 * into the project root as part of `npm run build`/`npm run dev`, but no
 * automated test here proves an actual Obsidian install picks it up).
 */

import TetherLibgit2Factory from "./build/dist/tether-libgit2.js";
import { wrapLibgit2Module } from "./engine";
import type { Libgit2Module } from "./binding";
import type { RequestUrlLike } from "../http-client";

/** The filename this loader expects to find next to `main.js` (see
 * `esbuild.config.mjs`'s post-build copy step). */
export const LIBGIT2_WASM_FILENAME = "tether-libgit2.wasm";

export interface LoadLibgit2ModuleOptions {
	/** Reads the compiled `.wasm` binary's bytes. In the real plugin this is
	 * `() => app.vault.adapter.readBinary(normalizePath(`${manifest.dir}/${LIBGIT2_WASM_FILENAME}`))`
	 * — injected here (rather than importing 'obsidian') so this module stays
	 * unit-testable with a plain Node `fs.readFileSync`. */
	readWasmBytes: () => Promise<ArrayBuffer>;
	/** Routed into every network operation — see `engine.ts`'s
	 * `installHttpDispatch` doc comment for the credential model this
	 * implies. */
	requestUrl: RequestUrlLike;
}

/**
 * Instantiates the RAW compiled module (not yet wrapped in the
 * `Libgit2Module` contract) via `Module.instantiateWasm`, without calling
 * `git_libgit2_init`/registering the HTTP transport — the seam a caller
 * needs when it must mount a filesystem backend (e.g. `VaultMirror`'s
 * classic-FS glue, see `fs-backend.ts`) onto the raw module BEFORE any
 * libgit2 call touches a path under that mount. Callers that don't need to
 * mount anything can go straight to `loadLibgit2Module` below.
 *
 * Failure handling: the compiled glue's own `createWasm()` wraps
 * `instantiateWasm(info, callback)` in `new Promise(resolve => ...)` with NO
 * corresponding `reject` wired to anything this override does (confirmed by
 * reading the real compiled output) — if `WebAssembly.instantiate` rejects
 * and this function did nothing but call `callback` on success, the
 * factory's returned promise would simply hang forever instead of
 * rejecting. The `Promise.race` below against a manually-rejected
 * `instantiateFailure` promise is what actually surfaces that failure to
 * the caller instead of hanging.
 */
export async function instantiateLibgit2Module(
	readWasmBytes: () => Promise<ArrayBuffer>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
	const wasmBytes = await readWasmBytes();

	let rejectInstantiate: (err: unknown) => void = () => {};
	const instantiateFailure = new Promise<never>((_, reject) => {
		rejectInstantiate = reject;
	});

	const modulePromise = TetherLibgit2Factory({
		instantiateWasm(
			imports: WebAssembly.Imports,
			callback: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void
		) {
			WebAssembly.instantiate(wasmBytes, imports)
				.then((result) => callback(result.instance, result.module))
				.catch((err) => {
					rejectInstantiate(err instanceof Error ? err : new Error(String(err)));
				});
			// Return value is ignored by the compiled glue's createWasm() (it
			// only ever awaits the `callback` being invoked) — returning an
			// empty object here just matches Emscripten's documented
			// instantiateWasm contract shape for readers, not because
			// anything reads it.
			return {};
		},
	});

	return Promise.race([modulePromise, instantiateFailure]);
}

/**
 * Instantiates the module AND wraps it into the `Libgit2Module` contract
 * (`git_libgit2_init` + HTTPS transport registration) — the convenience path
 * for a caller that isn't mounting a custom filesystem backend itself. The
 * real plugin always mounts `VaultMirror` (see `engine.ts`'s
 * `createGitEngine`), so it calls `instantiateLibgit2Module` directly
 * instead; this export exists for completeness and for tests that don't need
 * a custom mount (e.g. proving the loader mechanism itself works, see
 * `tests/libgit2/loader.test.ts`).
 */
export async function loadLibgit2Module(options: LoadLibgit2ModuleOptions): Promise<Libgit2Module> {
	const Module = await instantiateLibgit2Module(options.readWasmBytes);
	return wrapLibgit2Module(Module, { requestUrl: options.requestUrl });
}
