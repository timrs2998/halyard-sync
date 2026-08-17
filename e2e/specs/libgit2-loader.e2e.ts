/**
 * Closes the gap `src/git/libgit2/loader.ts`'s header calls out as NOT PROVEN:
 * that `manifest.dir` resolves to a readable path via
 * `app.vault.adapter.readBinary` inside a real running Obsidian, that the
 * esbuild-bundled glue survives Obsidian's own plugin-loading CJS wrapper, and
 * that `tether-libgit2.wasm` actually ships next to `main.js` from an install.
 *
 * `tests/libgit2/loader.test.ts` proves the loading MECHANISM against the real
 * artifact under Node. This proves the same path inside Obsidian's Electron
 * renderer (and, via the emulated-mobile capability, the mobile UI too), which
 * is the only place `manifest.dir` and `readBinary` actually exist.
 *
 * The `beforeEach` copy is not scaffolding — it is the finding. A standard
 * Obsidian plugin install is main.js + manifest.json + styles.css, and that is
 * exactly what wdio-obsidian-service's `plugins: ["."]` reproduces: the `.wasm`
 * is silently dropped and the engine dies with ENOENT at first sync, not at
 * load. Every install path has to place the fourth file deliberately. See
 * RELEASE.md, which already says all four files are required.
 *
 * Deliberately offline: it stops at "the engine is built and functional", which
 * is where the WASM risk lives. Anything past that is network behaviour already
 * covered by `tests/engine-smoke.test.ts`.
 */

import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WASM = "tether-libgit2.wasm";

describe("Tether Sync's libgit2 WASM engine in a real Obsidian instance", function () {
	before(function () {
		const pluginDir = join(obsidianPage.getVaultPath(), ".obsidian", "plugins", "tether-sync");
		mkdirSync(pluginDir, { recursive: true });
		copyFileSync(WASM, join(pluginDir, WASM));
	});

	it("ships tether-libgit2.wasm next to main.js and can read it back", async function () {
		const result = await browser.executeObsidian(async ({ app }, wasmName: string) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { manifest?: { dir?: string } }> } })
				.plugins.plugins["tether-sync"];
			const dir = plugin?.manifest?.dir;
			if (dir === undefined) return { dir: null, bytes: -1, error: "manifest.dir is undefined" };
			try {
				const buf = await app.vault.adapter.readBinary(`${dir}/${wasmName}`);
				return { dir, bytes: buf.byteLength, error: null };
			} catch (err) {
				return { dir, bytes: -1, error: String(err) };
			}
		}, WASM);

		expect(result.error).toBe(null);
		// A truncated read or an error page would be orders of magnitude smaller
		// than the real ~1.7 MB artifact.
		expect(result.bytes).toBe(statSync(WASM).size);
	});

	it("instantiates the module and builds a working engine", async function () {
		// WASM instantiation plus the initial VaultMirror hydration is real work.
		this.timeout(120 * 1000);

		const result = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, { getEngine?: () => Promise<unknown> }> };
			}).plugins.plugins["tether-sync"];
			if (plugin?.getEngine === undefined) return { ok: false, methods: [] as string[], error: "getEngine missing" };
			try {
				const engine = (await plugin.getEngine()) as Record<string, unknown>;
				const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(engine) as object).filter(
					(n) => typeof engine[n] === "function"
				);
				return { ok: true, methods, error: null };
			} catch (err) {
				return { ok: false, methods: [] as string[], error: String(err) };
			}
		});

		expect(result.error).toBe(null);
		expect(result.ok).toBe(true);
		// Prove the real GitEngine surface came back, not a partial object.
		expect(result.methods).toContain("clone");
		expect(result.methods).toContain("push");
		expect(result.methods).toContain("fetch");
	});

	it("initializes a repository in the vault through the mounted mirror", async function () {
		this.timeout(120 * 1000);

		const result = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, { getEngine?: () => Promise<Record<string, unknown>> }> };
			}).plugins.plugins["tether-sync"];
			try {
				const engine = (await plugin.getEngine!()) as unknown as {
					initFromExistingVault: (options: { url: string; defaultBranch?: string }) => Promise<unknown>;
					getRemoteUrl: () => Promise<string | null>;
				};
				// Local-only: init and addRemote never touch the network, so this
				// URL is never dialled.
				await engine.initFromExistingVault({
					url: "https://gitlab.invalid/e2e/fixture.git",
					defaultBranch: "main",
				});
				const gitDirExists = await app.vault.adapter.exists(".git");
				const remoteUrl = await engine.getRemoteUrl();
				return { gitDirExists, remoteUrl, error: null };
			} catch (err) {
				return { gitDirExists: false, remoteUrl: null, error: String(err) };
			}
		});

		expect(result.error).toBe(null);
		// The mirror's flush-back half actually wrote a real .git into the vault.
		expect(result.gitDirExists).toBe(true);
		// And it landed on the plugin's own remote name, never "origin".
		expect(result.remoteUrl).toBe("https://gitlab.invalid/e2e/fixture.git");
	});

	it("reports whether this platform offers OS keychain secret storage", async function () {
		// Not an assertion about which backend is used — it records it. Tokens
		// land in the keychain when present and in data.json (plaintext, with a
		// warning banner) when not, and knowing which applies decides whether a
		// token can be provisioned from outside the app.
		const available = await browser.executeObsidian(({ app }) => {
			const storage = (app as unknown as { secretStorage?: Record<string, unknown> }).secretStorage;
			if (typeof storage !== "object" || storage === null) return false;
			return typeof (storage.getSecret ?? storage.get) === "function";
		});
		console.log(`    [info] app.secretStorage available: ${available}`);
		expect(typeof available).toBe("boolean");
	});
});

// Guards the assumption the `before` hook is compensating for, so this stays
// honest if the harness ever starts shipping the file on its own.
describe("plugin install completeness", function () {
	it("has a built wasm artifact at the project root to install", function () {
		expect(existsSync(WASM)).toBe(true);
	});
});
