/**
 * Real, end-to-end tests for `src/git/libgit2/engine.ts` — the actual
 * `Libgit2Module`/`Libgit2Repository` implementation, run against the real
 * compiled `build/dist/tether-libgit2.{js,wasm}` module (same artifact
 * `tests/libgit2/filter-smoke.test.ts` and
 * `tests/libgit2/asyncify-double-suspension.test.ts` already prove works).
 *
 * Unlike those two smoke tests (which call the compiled module's raw C
 * entry points directly via `ccall`/`cwrap`), everything here goes through
 * `engine.ts`'s actual `Libgit2Module`/`Libgit2Repository` TypeScript
 * classes — this is what proves the *binding*, not just the underlying
 * compiled module, actually works: real error mapping, real malloc/free
 * discipline, the real async surface.
 *
 * Filesystem note: these tests mount NODEFS onto a real temp directory
 * (via `wrapLibgit2Module`, which accepts an already-instantiated `Module`
 * so the test can mount before any git call runs) — same as the two
 * existing smoke tests, and for the same reason: proving `engine.ts`'s
 * libgit2 call sequences are correct is an orthogonal concern from proving
 * `VaultMirror`'s classic-FS glue works, which
 * `tests/libgit2/fs-backend-mount.test.ts` covers separately. Skipped (not
 * failed) when the compiled module doesn't exist.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapLibgit2Module } from "../../src/git/libgit2/engine";
import { Libgit2Error, type Libgit2Repository } from "../../src/git/libgit2/binding";
import type { RequestUrlLike } from "../../src/git/http-client";
import { startGitHttpBackend } from "./helpers/git-http-backend";
import { mountHostDir } from "./helpers/nodefs-mount";
import type { TestNativeModule } from "./helpers/test-module";
import { loadModuleFactory } from "./helpers/test-module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_JS = join(__dirname, "..", "..", "src", "git", "libgit2", "build", "dist", "tether-libgit2.node.js");

const factory = loadModuleFactory(MODULE_JS);

/** A `RequestUrlLike` backed by real `fetch` — used for the fetch/listRemoteRefs
 * tests against the real local `git http-backend` server, same pattern as
 * asyncify-double-suspension.test.ts's inline `Module.__httpDispatch`, just
 * expressed as the actual `RequestUrlLike` shape `engine.ts` expects. */
const realFetchRequestUrl: RequestUrlLike = async (param) => {
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

async function freshModule(mountDir: string): Promise<TestNativeModule> {
	const Module = await factory!();
	mountHostDir(Module, mountDir, "/repo");
	return Module;
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd }).toString("utf8").trim();
}

const AUTHOR = { name: "Test", email: "test@example.com" };

describe.skipIf(factory === null)("engine.ts Libgit2Module/Libgit2Repository (real, against the compiled module)", () => {
	it("init, addRemote, setConfig/getConfig", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-init-"));
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });

		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });
		await repo.addRemote("origin", "https://example.invalid/owner/repo.git");
		await repo.setConfig("user.name", "Test User");
		await repo.setConfig("user.email", "test-user@example.com");

		expect(await repo.getConfig("user.name")).toBe("Test User");
		expect(await repo.getConfig("user.email")).toBe("test-user@example.com");
		expect(await repo.getConfig("remote.origin.url")).toBe("https://example.invalid/owner/repo.git");
		expect(await repo.getConfig("does.not.exist")).toBeNull();

		// Independent verification: real `git config` against the same on-disk repo.
		expect(git(["config", "--get", "remote.origin.url"], dir)).toBe(
			"https://example.invalid/owner/repo.git"
		);

		await repo.close();
	});

	it("addRemote with force re-points an existing remote's URL", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-remote-force-"));
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });
		const repo = await git2.init({ dir: "/repo" });

		await repo.addRemote("origin", "https://example.invalid/a.git");
		await expect(repo.addRemote("origin", "https://example.invalid/b.git")).rejects.toThrow(Libgit2Error);
		await repo.addRemote("origin", "https://example.invalid/b.git", { force: true });
		expect(await repo.getConfig("remote.origin.url")).toBe("https://example.invalid/b.git");

		await repo.close();
	});

	it("stagePath + commit, then commit() again with no changes returns null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-commit-"));
		writeFileSync(join(dir, "a.txt"), "hello world\n", "utf8");
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		await repo.stagePath("a.txt");
		const oid = await repo.commit("first commit", AUTHOR);
		expect(oid).toMatch(/^[0-9a-f]{40}$/);

		// Independent verification via the real git CLI.
		expect(git(["log", "-1", "--format=%s"], dir)).toBe("first commit");
		expect(git(["show", `${oid}:a.txt`], dir)).toBe("hello world");

		const again = await repo.commit("no-op commit", AUTHOR);
		expect(again).toBeNull();

		await repo.close();
	});

	it("resolveRef, currentBranch, writeRef, log, findMergeBase", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-refs-"));
		writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		// Unborn HEAD (no commits yet): per binding.ts's doc comment on
		// `currentBranch`, this maps to null, same as a detached HEAD would —
		// `git_repository_head` itself fails with GIT_EUNBORNBRANCH here, it
		// does not report "main" the way a symbolic-ref-only read would.
		expect(await repo.currentBranch()).toBeNull();
		expect(await repo.resolveRef("refs/heads/main")).toBeNull();

		await repo.stagePath("a.txt");
		const firstOid = await repo.commit("c1", AUTHOR);
		expect(firstOid).not.toBeNull();
		expect(await repo.resolveRef("refs/heads/main")).toBe(firstOid);
		expect(await repo.currentBranch()).toBe("main");

		writeFileSync(join(dir, "a.txt"), "two\n", "utf8");
		await repo.stagePath("a.txt");
		const secondOid = await repo.commit("c2", AUTHOR);
		expect(secondOid).not.toBeNull();
		expect(secondOid).not.toBe(firstOid);

		const history = await repo.log("refs/heads/main");
		expect(history).toEqual([secondOid, firstOid]);

		const bounded = await repo.log("refs/heads/main", { until: firstOid! });
		expect(bounded).toEqual([secondOid, firstOid]);

		expect(await repo.findMergeBase(firstOid!, secondOid!)).toBe(firstOid);

		// writeRef: move a branch pointer directly.
		await repo.writeRef("refs/heads/other", firstOid!, { force: true });
		expect(await repo.resolveRef("refs/heads/other")).toBe(firstOid);

		await repo.close();
	});

	it("readBlob resolves (commit, path) to the blob's raw content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-readblob-"));
		writeFileSync(join(dir, "notes.md"), "# Title\ncontent\n", "utf8");
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		await repo.stagePath("notes.md");
		const oid = await repo.commit("add notes", AUTHOR);

		const content = await repo.readBlob(oid!, "notes.md");
		expect(new TextDecoder().decode(content)).toBe("# Title\ncontent\n");

		await expect(repo.readBlob(oid!, "does-not-exist.md")).rejects.toThrow(Libgit2Error);

		await repo.close();
	});

	it("writeBlobAndStageOid stages an oid directly without a working-tree read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-writeblob-"));
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		const content = new TextEncoder().encode("direct oid content\n");
		const oid = await repo.writeBlobAndStageOid("direct.txt", content);
		expect(oid).toMatch(/^[0-9a-f]{40}$/);

		const commitOid = await repo.commit("direct blob", AUTHOR);
		expect(commitOid).not.toBeNull();

		// Independent verification: the ODB really has this exact blob oid at
		// this path in the committed tree.
		const treeOid = git(["rev-parse", `${commitOid}^{tree}`], dir);
		const lsTree = git(["ls-tree", treeOid, "direct.txt"], dir);
		expect(lsTree).toContain(oid);
		expect(git(["cat-file", "-p", oid], dir)).toBe("direct oid content");

		await repo.close();
	});

	it("status reports untracked, staged, and modified files with the right raw flags", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-status-"));
		writeFileSync(join(dir, "committed.txt"), "v1\n", "utf8");
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		await repo.stagePath("committed.txt");
		await repo.commit("base", AUTHOR);

		writeFileSync(join(dir, "committed.txt"), "v2\n", "utf8");
		writeFileSync(join(dir, "untracked.txt"), "new\n", "utf8");

		const statusBeforeStage = await repo.status();
		const byPath = Object.fromEntries(statusBeforeStage.map((e) => [e.path, e.statusFlags]));

		const WT_MODIFIED = 1 << 8;
		const WT_NEW = 1 << 7;
		const INDEX_NEW = 1 << 0;

		expect(byPath["committed.txt"] & WT_MODIFIED).toBe(WT_MODIFIED);
		expect(byPath["untracked.txt"] & WT_NEW).toBe(WT_NEW);

		await repo.stagePath("untracked.txt");
		const statusAfterStage = await repo.status();
		const staged = statusAfterStage.find((e) => e.path === "untracked.txt")!;
		expect(staged.statusFlags & INDEX_NEW).toBe(INDEX_NEW);

		await repo.close();
	});

	it("checkout force-resets a modified working-tree file back to HEAD", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-checkout-"));
		writeFileSync(join(dir, "a.txt"), "original\n", "utf8");
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		await repo.stagePath("a.txt");
		await repo.commit("base", AUTHOR);

		// Mutate the real host file out-of-band, then go back through the
		// module's own FS layer to keep its node cache in sync (same real bug/
		// fix documented in filter-smoke.test.ts).
		Module.FS.writeFile("/repo/a.txt", "modified\n");
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("modified\n");

		await repo.checkout("main", { force: true });
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("original\n");

		await repo.close();
	});

	it("close() is idempotent and further calls throw", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-close-"));
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });
		const repo: Libgit2Repository = await git2.init({ dir: "/repo" });

		await repo.close();
		await expect(repo.close()).resolves.toBeUndefined();
		await expect(repo.resolveRef("refs/heads/main")).rejects.toThrow(/after close/);
	});

	it("fetch() over a real local smart-HTTP server updates remote-tracking refs", async () => {
		const serverRoot = mkdtempSync(join(tmpdir(), "tether-engine-fetch-server-"));
		git(["init", "--quiet", "--bare", "repo.git"], serverRoot);
		const workDir = mkdtempSync(join(tmpdir(), "tether-engine-fetch-seed-"));
		git(["clone", "--quiet", join(serverRoot, "repo.git"), workDir], tmpdir());
		writeFileSync(join(workDir, "file.txt"), "seeded\n", "utf8");
		git(["add", "file.txt"], workDir);
		git(
			["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "seed"],
			workDir
		);
		git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], workDir);

		const server = await startGitHttpBackend(serverRoot, "repo.git");
		try {
			const dir = mkdtempSync(join(tmpdir(), "tether-engine-fetch-client-"));
			const Module = await freshModule(dir);
			const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });
			const repo = await git2.init({ dir: "/repo" });
			await repo.addRemote("origin", server.url);

			const summary = await repo.fetch("origin", "main");
			const refs = Object.keys(summary.updatedRefs);
			expect(refs).toContain("refs/remotes/origin/main");
			expect(summary.updatedRefs["refs/remotes/origin/main"]).toMatch(/^[0-9a-f]{40}$/);

			// listRemoteRefs is a separate, repo-less module-level call.
			const remoteRefs = await git2.listRemoteRefs(server.url, "refs/heads/");
			expect(remoteRefs.some((r) => r.ref === "refs/heads/main")).toBe(true);

			await repo.close();
		} finally {
			await server.close();
		}
	}, 30_000);

	it("fetch() surfaces a rejected requestUrl as a real error instead of hanging forever", async () => {
		// The actual bug this proves fixed: native/transport_shim.c's
		// tether_http_dispatch_js (an EM_ASYNC_JS block) awaits
		// Module.__httpDispatch with no try/catch of its own. Asyncify's
		// resume machinery only drives the suspended WASM stack forward on
		// FULFILLMENT of that await, so before installHttpDispatch (in
		// engine.ts) caught the rejection itself, a requestUrl that threw
		// (e.g. a real "net::ERR_CONNECTION_CLOSED" from a proxy/firewall
		// silently killing the connection) left this call permanently
		// pending — never resolving, never rejecting. This test hanging
		// past its timeout is exactly what a regression back to that bug
		// would look like.
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-fetch-reject-client-"));
		const Module = await freshModule(dir);
		const rejectingRequestUrl: RequestUrlLike = async () => {
			throw new Error("net::ERR_CONNECTION_CLOSED");
		};
		const git2 = await wrapLibgit2Module(Module, { requestUrl: rejectingRequestUrl });
		const repo = await git2.init({ dir: "/repo" });
		await repo.addRemote("origin", "https://example.invalid/repo.git");

		await expect(repo.fetch("origin", "main")).rejects.toThrow(/ERR_CONNECTION_CLOSED/);

		await repo.close();
	}, 10_000);

	it("listRemoteRefs() surfaces a rejected requestUrl as a real error instead of hanging forever", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-lsremote-reject-client-"));
		const Module = await freshModule(dir);
		const rejectingRequestUrl: RequestUrlLike = async () => {
			throw new Error("net::ERR_CONNECTION_CLOSED");
		};
		const git2 = await wrapLibgit2Module(Module, { requestUrl: rejectingRequestUrl });

		await expect(
			git2.listRemoteRefs("https://example.invalid/repo.git", "refs/heads/")
		).rejects.toThrow(/ERR_CONNECTION_CLOSED/);
	}, 10_000);

	it("listRemoteRefs() surfaces a 2xx response with the wrong content-type (e.g. an HTML SSO/login page instead of the git advertisement) as an actionable error, not libgit2's raw pkt-line parse failure", async () => {
		// The actual bug this proves fixed: a server (or a proxy/SSO gate in
		// front of it) that answers the discovery request with `200 OK` and an
		// HTML page instead of the real `application/x-git-upload-pack-
		// advertisement` body used to sail straight through to libgit2's own
		// pkt-line parser, which failed deep inside with an opaque "error
		// parsing REF pkt-line" — see `installHttpDispatch`'s wiring of
		// `validateSmartHttpResponse` in engine.ts.
		const dir = mkdtempSync(join(tmpdir(), "tether-engine-lsremote-badcontenttype-client-"));
		const Module = await freshModule(dir);
		const htmlPageRequestUrl: RequestUrlLike = async () => ({
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
			arrayBuffer: new TextEncoder().encode("<html><body>Sign in to continue</body></html>").buffer,
		});
		const git2 = await wrapLibgit2Module(Module, { requestUrl: htmlPageRequestUrl });

		await expect(
			git2.listRemoteRefs("https://example.invalid/repo.git", "refs/heads/")
		).rejects.toThrow(/content-type/i);
	}, 10_000);

	it("clone() fetches and checks out the default branch", async () => {
		const serverRoot = mkdtempSync(join(tmpdir(), "tether-engine-clone-server-"));
		git(["init", "--quiet", "--bare", "repo.git"], serverRoot);
		const workDir = mkdtempSync(join(tmpdir(), "tether-engine-clone-seed-"));
		git(["clone", "--quiet", join(serverRoot, "repo.git"), workDir], tmpdir());
		writeFileSync(join(workDir, "readme.md"), "hello from origin\n", "utf8");
		git(["add", "readme.md"], workDir);
		git(
			["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "seed"],
			workDir
		);
		git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], workDir);

		const server = await startGitHttpBackend(serverRoot, "repo.git");
		try {
			const dir = mkdtempSync(join(tmpdir(), "tether-engine-clone-client-"));
			const Module = await freshModule(dir);
			const git2 = await wrapLibgit2Module(Module, { requestUrl: realFetchRequestUrl });

			const repo = await git2.clone({ url: server.url, dir: "/repo" });
			expect(await repo.currentBranch()).toBe("main");
			expect(readFileSync(join(dir, "readme.md"), "utf8")).toBe("hello from origin\n");

			await repo.close();
		} finally {
			await server.close();
		}
	}, 30_000);
});
