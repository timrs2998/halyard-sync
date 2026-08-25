/**
 * End-to-end smoke test: the PLUGIN's `GitEngine` (src/git/engine.ts) driven
 * against the REAL compiled libgit2-WASM module (same artifact
 * `tests/libgit2/*.test.ts` already prove works), backed by a `MockAdapter`
 * (the same in-memory `DataAdapterLike` mock every other adapter-facing test
 * in this repo uses) via `VaultMirror` — no Obsidian, network disabled
 * unless a test explicitly starts a real local HTTP git server. This is what
 * proves the engine cutover for real: `GitEngine` no longer wraps
 * the libgit2 binding, it wraps `Libgit2Module`/`Libgit2Repository`.
 *
 * Skipped (not failed) when the compiled module doesn't exist — same
 * convention every `tests/libgit2/*.test.ts` file uses.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitEngine, GitEngine } from "../src/git/engine";
import { wrapLibgit2Module } from "../src/git/libgit2/engine";
import type { RequestUrlLike } from "../src/git/http-client";
import type { GitCryptKeyMaterial } from "../src/auth/secrets";
import { startGitHttpBackend } from "./libgit2/helpers/git-http-backend";
import { MockAdapter } from "./helpers/mock-adapter";
import { loadModuleFactory } from "./libgit2/helpers/test-module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_JS = join(__dirname, "..", "src", "git", "libgit2", "build", "dist", "tether-libgit2.js");

const factory = loadModuleFactory(MODULE_JS);

const noRequestUrl: RequestUrlLike = async () => {
	throw new Error("network disabled in this test");
};

async function makeEngine(
	adapter: MockAdapter,
	requestUrl: RequestUrlLike = noRequestUrl,
	getGitCryptKeys?: () => Promise<Map<string, GitCryptKeyMaterial>>,
	autoMergeOverlappingEdits?: boolean
): Promise<GitEngine> {
	return createGitEngine({
		instantiateModule: () => factory!(),
		wrapModule: (rawModule, requestUrlFn) => wrapLibgit2Module(rawModule, { requestUrl: requestUrlFn }),
		requestUrl,
		adapter,
		author: { name: "Test", email: "test@localhost" },
		configDir: ".obsidian",
		getGitCryptKeys,
		autoMergeOverlappingEdits,
	});
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd }).toString("utf8").trim();
}

describe.skipIf(factory === null)("GitEngine against the real compiled libgit2 module", () => {
	it("init, status, commit, modify, delete round-trip", async () => {
		const adapter = new MockAdapter();
		const engine = await makeEngine(adapter);

		await engine.initFromExistingVault({
			url: "https://example.com/vault.git",
			defaultBranch: "main",
		});
		expect(await engine.getRemoteUrl()).toBe("https://example.com/vault.git");
		// Unborn HEAD (no commit yet): libgit2's `git_repository_head` reports
		// GIT_EUNBORNBRANCH, which `Libgit2Repository.currentBranch()` maps to
		// null (documented, matching resolveRef's null-on-absent contract) —
		// a real, deliberate behavior of `currentBranch`,
		// which reads the symbolic HEAD target directly without needing a
		// real commit to exist.
		expect(await engine.currentBranch()).toBeNull();

		// New files, including ignored ones that must not show up.
		await adapter.write("note.md", "# hello\n");
		await adapter.mkdir("sub");
		await adapter.write("sub/nested.md", "nested\n");
		await adapter.mkdir(".obsidian");
		await adapter.write(".obsidian/workspace.json", "{}");
		await adapter.mkdir(".trash");
		await adapter.write(".trash/old.md", "gone");

		const changes = await engine.getChangedFiles();
		expect([...changes].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: "note.md", status: "added" },
			{ path: "sub/nested.md", status: "added" },
		]);

		const oid = await engine.stageAndCommit("vault sync: test");
		expect(oid).toMatch(/^[0-9a-f]{40}$/);
		expect(await engine.localRef("main")).toBe(oid);

		// Clean tree -> no commit.
		expect(await engine.getChangedFiles()).toEqual([]);
		expect(await engine.stageAndCommit("noop")).toBeNull();

		// Modify + delete, made directly against the adapter (standing in for a
		// direct Obsidian edit made between sync cycles) — proves
		// getChangedFiles() actually re-hydrates from the adapter each call
		// rather than relying on a stale in-memory snapshot.
		await adapter.write("note.md", "# hello world\n");
		await adapter.remove("sub/nested.md");
		expect([...(await engine.getChangedFiles())].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: "note.md", status: "modified" },
			{ path: "sub/nested.md", status: "deleted" },
		]);

		const second = await engine.stageAndCommit("vault sync: edit");
		expect(second).toMatch(/^[0-9a-f]{40}$/);
		expect(second).not.toBe(oid);
		expect(await engine.getChangedFiles()).toEqual([]);

		await engine.close();
	});

	it("ensureRemote force-overwrites an already-configured remote URL", async () => {
		const adapter = new MockAdapter();
		const engine = await makeEngine(adapter);
		await engine.initFromExistingVault({ url: "git@github.com:owner/vault.git" });
		expect(await engine.getRemoteUrl()).toBe("git@github.com:owner/vault.git");

		// Simulates opening a vault whose .git predates this plugin (e.g.
		// cloned by hand over SSH) — main.ts calls this on every startup
		// before scheduling syncs, so the repo's actual remote always matches
		// the validated settings.remoteUrl instead of whatever was on disk.
		await engine.ensureRemote("https://github.com/owner/vault.git");
		expect(await engine.getRemoteUrl()).toBe("https://github.com/owner/vault.git");

		await engine.close();
	});

	it("manages its own 'halyard-sync' remote by default, never touching a pre-existing 'origin'", async () => {
		const adapter = new MockAdapter();

		// Simulates a vault the user already had cloned/managed by hand, with
		// their own "origin" pointed wherever their own tooling expects —
		// created via an engine explicitly configured with remote: "origin"
		// to stand in for that pre-existing, user-owned remote.
		const userOwnedEngine = await createGitEngine({
			instantiateModule: () => factory!(),
			wrapModule: (rawModule, requestUrlFn) => wrapLibgit2Module(rawModule, { requestUrl: requestUrlFn }),
			requestUrl: noRequestUrl,
			adapter,
			author: { name: "Test", email: "test@localhost" },
			configDir: ".obsidian",
			remote: "origin",
		});
		await userOwnedEngine.initFromExistingVault({ url: "git@github.com:owner/vault.git" });
		await userOwnedEngine.close();

		// Halyard Sync opens the SAME on-disk repo with its normal (default)
		// engine config — no explicit `remote` override, same as production.
		const engine = await makeEngine(adapter);
		await engine.ensureRemote("https://github.com/owner/vault.git");

		expect(await engine.getRemoteUrl()).toBe("https://github.com/owner/vault.git");

		// The user's own "origin" must be completely untouched.
		const stillUserOwned = await createGitEngine({
			instantiateModule: () => factory!(),
			wrapModule: (rawModule, requestUrlFn) => wrapLibgit2Module(rawModule, { requestUrl: requestUrlFn }),
			requestUrl: noRequestUrl,
			adapter,
			author: { name: "Test", email: "test@localhost" },
			configDir: ".obsidian",
			remote: "origin",
		});
		expect(await stillUserOwned.getRemoteUrl()).toBe("git@github.com:owner/vault.git");

		await engine.close();
		await stillUserOwned.close();
	});

	it("currentBranch reports whatever branch is actually checked out, not a hardcoded default", async () => {
		// The exact mechanism main.ts's adoptExistingRepo() relies on to sync
		// settings.branch to an already-existing repo's REAL branch (which may
		// not be "main") before handing off to the orchestrator.
		const adapter = new MockAdapter();
		const engine = await makeEngine(adapter);
		await engine.initFromExistingVault({
			url: "https://example.com/v.git",
			defaultBranch: "master",
		});
		await adapter.write("a.md", "a");
		await engine.stageAndCommit("first");
		expect(await engine.currentBranch()).toBe("master");
		await engine.close();
	});

	it("reports refs and ahead/behind for a fresh repo", async () => {
		const adapter = new MockAdapter();
		const engine = await makeEngine(adapter);
		await engine.initFromExistingVault({ url: "https://example.com/v.git" });
		await adapter.write("a.md", "a");
		await engine.stageAndCommit("first");

		expect(await engine.remoteTrackingRef("main")).toBeNull();
		const ab = await engine.aheadBehind("main");
		expect(ab.state).toBe("ahead");
		expect(ab.approximate).toBe(true);

		// mergeUpstream with nothing fetched is a no-op.
		expect(await engine.mergeUpstream("main")).toEqual({ kind: "uptodate" });

		await engine.close();
	});
});

// ---------------------------------------------------------------------------
// Divergent history over a real local HTTP git server: real conflicts,
// hard resets, and conflict stats.
// ---------------------------------------------------------------------------

/** Rewrites `https://`/`http://` to the real server's own scheme — the
 * plugin's `GitEngine` is only ever pointed at HTTPS URLs in production, but
 * the local `git http-backend` test server has no real TLS listener, same
 * substitution `tests/libgit2/http-transport-auth.test.ts` documents and
 * uses for the same reason. */
function makeRealRequestUrl(): RequestUrlLike {
	return async (param) => {
		const res = await fetch(param.url, {
			method: param.method ?? "GET",
			headers: param.headers,
			body: param.body,
		});
		const arrayBuffer = await res.arrayBuffer();
		const headers: Record<string, string> = {};
		res.headers.forEach((v, k) => (headers[k] = v));
		return { status: res.status, headers, arrayBuffer };
	};
}

/**
 * Builds a real bare repo (served over a real local smart-HTTP server) with
 * one shared base commit on `main` — the scaffolding a test then diverges
 * from two directions: the `GitEngine` under test (which clones it and
 * commits locally) and a real `git` CLI working copy standing in for
 * "another device already pushed a conflicting change" (pushed straight to
 * the same bare repo, bypassing `GitEngine` entirely — this is test
 * scaffolding, not something under test).
 */
async function setupSharedRemote(filepath: string) {
	const tmpRoot = mkdtempSync(join(tmpdir(), "halyard-engine-smoke-"));
	const bareDir = join(tmpRoot, "remote.git");
	git(["init", "--bare", "-b", "main", "remote.git"], tmpRoot);

	const seedDir = join(tmpRoot, "seed");
	git(["init", "-b", "main", "seed"], tmpRoot);
	writeFileSync(join(seedDir, filepath), "base\n");
	git(["add", "."], seedDir);
	git(["-c", "user.email=seed@test", "-c", "user.name=Seed", "commit", "-m", "base"], seedDir);
	git(["push", bareDir, "main"], seedDir);
	const baseOid = git(["rev-parse", "main"], seedDir);

	const server = await startGitHttpBackend(tmpRoot, "remote.git");
	return { server, seedDir, bareDir, baseOid };
}

/** Advances the real `git` CLI seed working copy and pushes straight to the
 * bare repo — the "another device changed this too" half of the scenario. */
function pushRemoteChange(seedDir: string, bareDir: string, filepath: string, content: string, message: string): string {
	writeFileSync(join(seedDir, filepath), content);
	git(["add", "."], seedDir);
	git(["-c", "user.email=seed@test", "-c", "user.name=Seed", "commit", "-m", message], seedDir);
	git(["push", bareDir, "main"], seedDir);
	return git(["rev-parse", "main"], seedDir);
}

describe.skipIf(factory === null)("GitEngine merge conflicts (real divergent history over real HTTP)", () => {
	it("mergeUpstream reports a real conflict and never writes markers into tracked files", async () => {
		const { server, seedDir, bareDir } = await setupSharedRemote("shared.md");
		try {
			const adapter = new MockAdapter();
			const engine = await makeEngine(adapter, makeRealRequestUrl());
			await engine.clone({ url: server.url });

			await adapter.write("shared.md", "local change\n");
			const localOid = await engine.stageAndCommit("local change");
			expect(localOid).not.toBeNull();

			pushRemoteChange(seedDir, bareDir, "shared.md", "remote change\n", "remote change");

			await engine.fetch("main");
			const outcome = await engine.mergeUpstream("main");
			expect(outcome.kind).toBe("conflict");
			if (outcome.kind === "conflict") {
				expect(outcome.files).toEqual(["shared.md"]);
			}

			// The core invariant (see git/engine.ts, mergeUpstream docs): a failed
			// merge must never leave conflict markers in a tracked file. Content
			// and ref must be exactly what they were before the merge attempt.
			expect(await adapter.read("shared.md")).toBe("local change\n");
			expect(await adapter.read("shared.md")).not.toMatch(/<{7}|={7}|>{7}/);
			expect(await engine.localRef("main")).toBe(localOid);

			await engine.close();
		} finally {
			await server.close();
		}
	});

	it("mergeUpstream with autoMergeOverlappingEdits never conflicts, keeping both sides' text", async () => {
		const { server, seedDir, bareDir } = await setupSharedRemote("shared.md");
		try {
			const adapter = new MockAdapter();
			const engine = await makeEngine(adapter, makeRealRequestUrl(), undefined, true);
			await engine.clone({ url: server.url });

			await adapter.write("shared.md", "local change\n");
			await engine.stageAndCommit("local change");

			pushRemoteChange(seedDir, bareDir, "shared.md", "remote change\n", "remote change");

			await engine.fetch("main");
			// Same overlapping-edit setup as the plain-conflict test above, but
			// with the setting on: this must merge cleanly, never report
			// "conflict", and the file must contain BOTH sides' text.
			const outcome = await engine.mergeUpstream("main");
			expect(outcome.kind).toBe("merged");

			const content = await adapter.read("shared.md");
			expect(content).toContain("local change");
			expect(content).toContain("remote change");
			expect(content).not.toMatch(/<{7}|={7}|>{7}/);

			await engine.close();
		} finally {
			await server.close();
		}
	});

	it("hardResetToRemote rewrites the working tree to match the remote branch", async () => {
		const { server, seedDir, bareDir } = await setupSharedRemote("shared.md");
		try {
			const adapter = new MockAdapter();
			const engine = await makeEngine(adapter, makeRealRequestUrl());
			await engine.clone({ url: server.url });

			await adapter.write("shared.md", "local change\n");
			await engine.stageAndCommit("local change");

			const remoteOid = pushRemoteChange(seedDir, bareDir, "shared.md", "remote change\n", "remote change");

			await engine.fetch("main");
			const oid = await engine.hardResetToRemote("main");

			expect(oid).toBe(remoteOid);
			expect(await engine.localRef("main")).toBe(remoteOid);
			expect(await adapter.read("shared.md")).toBe("remote change\n");

			await engine.close();
		} finally {
			await server.close();
		}
	});

	it("conflictFileStats reports a line-count stat for a file changed on both sides", async () => {
		const { server, seedDir, bareDir } = await setupSharedRemote("shared.md");
		try {
			const adapter = new MockAdapter();
			const engine = await makeEngine(adapter, makeRealRequestUrl());
			await engine.clone({ url: server.url });

			await adapter.write("shared.md", "local change\n");
			await engine.stageAndCommit("local change");
			pushRemoteChange(seedDir, bareDir, "shared.md", "remote change\n", "remote change");
			await engine.fetch("main");

			const stats = await engine.conflictFileStats("main", ["shared.md"]);
			expect(stats).toEqual([{ path: "shared.md", localLines: 1, remoteLines: 1, binary: false }]);

			await engine.close();
		} finally {
			await server.close();
		}
	});

	it("conflictFileStats reports null on the side where the file doesn't exist (added on the other side)", async () => {
		const { server, seedDir, bareDir } = await setupSharedRemote("base.md");
		try {
			const adapter = new MockAdapter();
			const engine = await makeEngine(adapter, makeRealRequestUrl());
			await engine.clone({ url: server.url });

			// Local adds a new file the remote never saw.
			await adapter.write("local-only.md", "line one\nline two\n");
			await engine.stageAndCommit("local only");

			// Remote advances base.md instead, so the two histories diverge
			// without ever touching local-only.md.
			pushRemoteChange(seedDir, bareDir, "base.md", "base changed\n", "advance base");
			await engine.fetch("main");

			const stats = await engine.conflictFileStats("main", ["local-only.md"]);
			expect(stats).toEqual([
				{ path: "local-only.md", localLines: 2, remoteLines: null, binary: false },
			]);

			await engine.close();
		} finally {
			await server.close();
		}
	});

	it("conflictFileStats flags a binary (non-UTF-8) blob instead of a line count", async () => {
		const adapter = new MockAdapter();
		const engine = await makeEngine(adapter);
		await engine.initFromExistingVault({ url: "https://example.com/v.git", defaultBranch: "main" });
		await adapter.writeBinary(
			"image.png",
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).buffer
		);
		await engine.stageAndCommit("add binary");

		const stats = await engine.conflictFileStats("main", ["image.png"]);
		expect(stats).toEqual([
			{ path: "image.png", localLines: null, remoteLines: null, binary: true },
		]);

		await engine.close();
	});

	it("conflictFileStats decrypts a real git-crypt-encrypted path via the registered filter before counting lines", async () => {
		// An all-zero key is a technically valid (if insecure) AES-256/HMAC key
		// pair — real WebCrypto encrypt/decrypt round-trips correctly with it,
		// which is all this test needs (a self-consistent real key, not a
		// realistic one).
		const key: GitCryptKeyMaterial = { aesKey: new Uint8Array(32), hmacKey: new Uint8Array(64) };

		const encryptedAdapter = new MockAdapter();
		const encryptedEngine = await makeEngine(encryptedAdapter, noRequestUrl, async () => new Map([["", key]]));
		await encryptedEngine.initFromExistingVault({
			url: "https://example.com/v.git",
			defaultBranch: "main",
		});
		await encryptedAdapter.write("secret.md", "line one\nline two\nline three\n");
		// stagePath (git_index_add_bypath) resolves .gitattributes and runs the
		// registered clean filter on matching paths — the whole point of
		// registering it via syncGitCryptFilter() when the repo is opened/created
		// and a key is configured (see GitEngine's ensureRepo()/clone()/
		// initFromExistingVault()). Real git-crypt-compatible encryption, not a
		// mock: this is `gitcrypt.ts`'s actual encryptBlob under the hood.
		await encryptedAdapter.write(
			".gitattributes",
			"secret.md filter=git-crypt diff=git-crypt\n"
		);
		await encryptedEngine.stageAndCommit("add secret");

		const statsWithKey = await encryptedEngine.conflictFileStats("main", ["secret.md"]);
		expect(statsWithKey).toEqual([
			{ path: "secret.md", localLines: 3, remoteLines: null, binary: false },
		]);
		await encryptedEngine.close();

		// Independent proof the blob is REALLY ciphertext in the ODB (not a
		// no-op filter): open a second engine over the SAME flushed adapter
		// state with NO key configured. Without a key, conflictFileStats reads
		// the raw stored bytes (git-crypt's "\0GITCRYPT\0" magic header contains
		// a NUL byte), which the binary-detection path correctly flags —
		// proving the with-key result above genuinely came from decrypting real
		// ciphertext, not from some code path that happened to skip encryption
		// entirely.
		const noKeyEngine = await makeEngine(encryptedAdapter, noRequestUrl, async () => new Map());
		const statsWithoutKey = await noKeyEngine.conflictFileStats("main", ["secret.md"]);
		expect(statsWithoutKey).toEqual([
			{ path: "secret.md", localLines: null, remoteLines: null, binary: true },
		]);
		await noKeyEngine.close();
	});

	it("conflictFileStats dispatches each path to ITS OWN git-crypt key — a named key alongside the default in the same repo", async () => {
		const defaultKey: GitCryptKeyMaterial = { aesKey: new Uint8Array(32), hmacKey: new Uint8Array(64) };
		const financeKey: GitCryptKeyMaterial = {
			aesKey: new Uint8Array(32).fill(7),
			hmacKey: new Uint8Array(64).fill(9),
		};
		const keys = new Map([
			["", defaultKey],
			["finance", financeKey],
		]);

		const adapter = new MockAdapter();
		const engine = await makeEngine(adapter, noRequestUrl, async () => keys);
		await engine.initFromExistingVault({ url: "https://example.com/v.git", defaultBranch: "main" });
		await adapter.write(
			".gitattributes",
			"default.md filter=git-crypt diff=git-crypt\nfinance.md filter=git-crypt-finance diff=git-crypt-finance\n"
		);
		await adapter.write("default.md", "one\ntwo\n");
		await adapter.write("finance.md", "alpha\nbeta\ngamma\n");
		await engine.stageAndCommit("add default + finance secrets");

		// Both round-trip correctly when read back through their OWN key —
		// proving the path -> keyName -> key material dispatch is real, not
		// just "some" key applied to everything.
		const stats = await engine.conflictFileStats("main", ["default.md", "finance.md"]);
		expect(stats).toEqual([
			{ path: "default.md", localLines: 2, remoteLines: null, binary: false },
			{ path: "finance.md", localLines: 3, remoteLines: null, binary: false },
		]);

		// Key isolation at the GitEngine level: an engine configured with ONLY
		// the default key (no "finance") must NOT be able to read finance.md's
		// content — it falls back to "(binary)" rather than silently trying
		// the wrong key, matching the no-key case above.
		const partialEngine = await makeEngine(adapter, noRequestUrl, async () => new Map([["", defaultKey]]));
		const partialStats = await partialEngine.conflictFileStats("main", ["default.md", "finance.md"]);
		expect(partialStats).toEqual([
			{ path: "default.md", localLines: 2, remoteLines: null, binary: false },
			{ path: "finance.md", localLines: null, remoteLines: null, binary: true },
		]);

		await engine.close();
		await partialEngine.close();
	});
});

// ---------------------------------------------------------------------------
// git-crypt determinism across sync cycles — the ORIGINAL motivating concern
// for this whole libgit2-over-WASM effort ("avoid different git
// tooling showing all files have changed"), proven one level up from where
// it's proven everywhere else in this repo:
//   - gitcrypt.test.ts's "encryptBlob determinism" proves the crypto itself
//     (AES-256-CTR with a content-derived nonce) re-encrypts identically.
//   - tests/libgit2/filter-smoke.test.ts proves one clean+smudge round trip
//     through the compiled native filter, independently verified via a real
//     `git cat-file`.
// Neither proves the thing an actual sync cycle depends on: that
// GitEngine.getChangedFiles()/stageAndCommit() — the exact calls
// SyncOrchestrator makes every cycle — see a clean tree the SECOND time
// around, with no edits in between. If status ever compared raw working-tree
// plaintext against the ciphertext ODB blob without re-running the clean
// filter (or if the filter weren't deterministic), an encrypted file would
// show as perpetually modified and get needlessly re-staged/re-committed on
// every single sync — this is the regression this project would be most
// embarrassing to ship with.
// ---------------------------------------------------------------------------

describe.skipIf(factory === null)(
	"GitEngine git-crypt determinism across sync cycles (the original cross-tool motivating concern)",
	() => {
		it("an encrypted file, once committed, does not show as changed again on the next unmodified sync cycle", async () => {
			// Same real-crypto convention as the conflictFileStats git-crypt test
			// above: an all-zero AES-256/HMAC-SHA1 pair is technically valid,
			// self-consistent key material — real encryptBlob/decryptBlob run
			// underneath via the registered native filter, not a mock.
			const key: GitCryptKeyMaterial = { aesKey: new Uint8Array(32), hmacKey: new Uint8Array(64) };
			const adapter = new MockAdapter();
			const engine = await makeEngine(adapter, noRequestUrl, async () => new Map([["", key]]));

			await engine.initFromExistingVault({
				url: "https://example.com/v.git",
				defaultBranch: "main",
			});
			await adapter.write(".gitattributes", "secret.md filter=git-crypt diff=git-crypt\n");
			await adapter.write("secret.md", "line one\nline two\nline three\n");

			// First sync cycle: both new paths are detected, and committing them
			// really runs the clean filter (secret.md's blob is encrypted going
			// into the index/ODB — already independently verified byte-for-byte
			// elsewhere; this test cares about what happens next).
			const firstChanges = await engine.getChangedFiles();
			expect([...firstChanges].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
				{ path: ".gitattributes", status: "added" },
				{ path: "secret.md", status: "added" },
			]);
			const firstOid = await engine.stageAndCommit("add encrypted secret");
			expect(firstOid).toMatch(/^[0-9a-f]{40}$/);

			// Second sync cycle — no edits made in between. getChangedFiles()
			// re-hydrates the VaultMirror from the adapter and re-runs libgit2
			// status from scratch (same as a real second sync would), so this is
			// a genuine re-check, not a cached answer from the first call.
			const secondChanges = await engine.getChangedFiles();
			expect(secondChanges).toEqual([]);
			expect(await engine.stageAndCommit("no-op sync")).toBeNull();
			expect(await engine.localRef("main")).toBe(firstOid);

			await engine.close();
		});
	}
);

describe.skipIf(factory === null)("GitEngine.testConnection (real HTTP, no repository)", () => {
	it("lists branches from a remote without any local repo", async () => {
		const { server } = await setupSharedRemote("probe.md");
		try {
			const adapter = new MockAdapter();
			const engine = await makeEngine(adapter, makeRealRequestUrl());

			// Deliberately no clone()/initFromExistingVault() — the wizard calls
			// this before the vault is connected to anything, so it must work
			// against a bare adapter with no .git at all.
			const refs = await engine.testConnection(server.url);

			expect(refs.map((r) => r.ref)).toContain("refs/heads/main");
			expect(refs.every((r) => /^[0-9a-f]{40}$/.test(r.oid))).toBe(true);
			expect(await adapter.exists(".git")).toBe(false);

			await engine.close();
		} finally {
			await server.close();
		}
	});

	it("rejects an empty URL before touching the network", async () => {
		const adapter = new MockAdapter();
		// noRequestUrl throws if anything actually dials out.
		const engine = await makeEngine(adapter);
		await expect(engine.testConnection("")).rejects.toThrow(/No remote URL/);
		await engine.close();
	});

	it("surfaces an unreachable remote as an error rather than an empty list", async () => {
		const adapter = new MockAdapter();
		const engine = await makeEngine(adapter, makeRealRequestUrl());
		// Port 1 is reserved and never listening.
		await expect(engine.testConnection("http://127.0.0.1:1/nope.git")).rejects.toThrow();
		await engine.close();
	});
});
