/**
 * Proves the libgit2 WASM engine loads inside a real Obsidian install.
 *
 * The install shape is the whole point. `wdio-obsidian-service`'s
 * `plugins: ["."]` reproduces exactly what Obsidian's community installer and
 * BRAT deliver — `main.js`, `manifest.json`, `styles.css` and nothing else.
 * A sibling `tether-libgit2.wasm` never arrives by that route, which is why
 * the binary is embedded in `main.js` as base64 (see
 * `src/git/libgit2/wasm-binary.ts`).
 *
 * So the first test below asserts the sibling file is ABSENT and the engine
 * builds regardless. That combination is the regression guard: it fails if
 * anyone reverts to shipping the binary beside `main.js`. Its other half —
 * that `main.js` really does carry the embedded binary — is a check against
 * files on disk rather than against a running Obsidian, and lives in
 * `tests/packaging.test.ts`.
 *
 * Deliberately offline — it stops at "the engine is built and functional",
 * which is where the WASM risk lives. Network behaviour is covered by
 * `tests/engine-smoke.test.ts`.
 */

import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const WASM = "tether-libgit2.wasm";

describe("Halyard Sync's libgit2 WASM engine in a real Obsidian instance", function () {
	it("builds a working engine with no sibling .wasm in the plugin directory", async function () {
		// WASM instantiation plus the initial VaultMirror hydration is real work.
		this.timeout(120 * 1000);

		const result = await browser.executeObsidian(async ({ app }, wasmName: string) => {
			const plugin = (app as unknown as {
				plugins: {
					plugins: Record<string, { manifest?: { dir?: string }; getEngine?: () => Promise<unknown> }>;
				};
			}).plugins.plugins["halyard-sync"];

			const dir = plugin?.manifest?.dir;
			if (dir === undefined) return { siblingWasmExists: null, ok: false, methods: [] as string[], error: "manifest.dir is undefined" };

			// A real install delivers three files. Confirm the binary genuinely
			// is not on disk, so the engine below can only come from the embed.
			const siblingWasmExists = await app.vault.adapter.exists(`${dir}/${wasmName}`);

			if (plugin.getEngine === undefined) return { siblingWasmExists, ok: false, methods: [] as string[], error: "getEngine missing" };
			try {
				const engine = (await plugin.getEngine()) as Record<string, unknown>;
				const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(engine) as object).filter(
					(n) => typeof engine[n] === "function"
				);
				return { siblingWasmExists, ok: true, methods, error: null };
			} catch (err) {
				return { siblingWasmExists, ok: false, methods: [] as string[], error: String(err) };
			}
		}, WASM);

		expect(result.error).toBe(null);
		// The bug this guards: BRAT and the community installer drop the fourth
		// file, and the engine used to die with ENOENT at first sync.
		expect(result.siblingWasmExists).toBe(false);
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
			}).plugins.plugins["halyard-sync"];
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
		console.debug(`    [info] app.secretStorage available: ${available}`);
		expect(typeof available).toBe("boolean");
	});
});
