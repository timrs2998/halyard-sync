/**
 * Proves the WASM-loading MECHANISM `src/git/libgit2/loader.ts` implements
 * for the real plugin cutover: `Module.instantiateWasm` fed bytes from a
 * `readWasmBytes` callback — standing in for
 * `app.vault.adapter.readBinary(manifest.dir + "/halyard-libgit2.wasm")` —
 * rather than Emscripten's own default `locateFile`-based fetch/readFileSync
 * path. See `loader.ts`'s header comment for the full packaging decision and
 * exactly what this proves vs. what still needs a real Obsidian smoke test
 * (this file proves the MECHANISM against the real compiled artifact; it
 * cannot prove `manifest.dir`/`app.vault.adapter.readBinary` behave the same
 * way inside an actual running Obsidian instance, desktop or mobile).
 *
 * `readWasmBytes` here is a plain `node:fs` `readFileSync` against the real
 * compiled `.wasm` — not a fake/stub buffer — so a real failure in the
 * override wiring (wrong callback shape, wrong Promise plumbing) would show
 * up as a real instantiation failure, not something a mock silently permits.
 *
 * Skipped (not failed) when the compiled module doesn't exist.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateLibgit2Module, loadLibgit2Module } from "../../src/git/libgit2/loader";
import type { RequestUrlLike } from "../../src/git/http-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "..", "src", "git", "libgit2", "build", "dist");
const WASM_PATH = join(DIST_DIR, "halyard-libgit2.wasm");
const JS_PATH = join(DIST_DIR, "halyard-libgit2.js");

const compiledModuleExists = existsSync(WASM_PATH) && existsSync(JS_PATH);

async function readRealWasmBytes(): Promise<ArrayBuffer> {
	const buf = readFileSync(WASM_PATH);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const unusedRequestUrl: RequestUrlLike = async () => {
	throw new Error("loader.test.ts performs no network operations");
};

describe.skipIf(!compiledModuleExists)("libgit2/loader.ts (real, against the compiled module)", () => {
	it("instantiateLibgit2Module: instantiateWasm override successfully instantiates the real module", async () => {
		const Module = await instantiateLibgit2Module(readRealWasmBytes);
		// Not just "didn't throw" — call a real libgit2 entry point (via the
		// same `{ async: true }` ccall path `engine.ts` uses for every call, see
		// its own header comment) to prove the returned Module is fully
		// functional, not merely a resolved-but-broken object.
		const rc: number = await Module.ccall("git_libgit2_init", "number", [], [], { async: true });
		expect(rc).toBeGreaterThanOrEqual(0);
	});

	it("propagates a real instantiation failure instead of hanging (corrupt wasm bytes)", async () => {
		const corrupt = async () => new Uint8Array([0, 1, 2, 3]).buffer;
		await expect(instantiateLibgit2Module(corrupt)).rejects.toThrow();
	});

	it("loadLibgit2Module: wraps the module into the full Libgit2Module contract via the same override", async () => {
		const git2 = await loadLibgit2Module({
			readWasmBytes: readRealWasmBytes,
			requestUrl: unusedRequestUrl,
		});
		// A real end-to-end call through the wrapped contract, not just module
		// instantiation: init a repo, prove it's a real, usable git_repository.
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const dir = mkdtempSync(join(tmpdir(), "halyard-loader-"));
		const repo = await git2.init({ dir, defaultBranch: "main" });
		await repo.setConfig("user.name", "Loader Test");
		expect(await repo.getConfig("user.name")).toBe("Loader Test");
		await repo.close();
	});
});
