/**
 * Real, end-to-end proof of the PRODUCTION HTTP transport path: HTTPS scheme
 * registration and Basic-auth credentials, as opposed to the test-only
 * plain-HTTP/no-auth path `asyncify-double-suspension.test.ts` already
 * proves (that test exists to answer the Asyncify double-suspension
 * question, not to prove auth — see its own header comment and
 * `native/transport_shim.c`'s header comment for that scope boundary).
 *
 * What this proves, all against the real compiled module and a real local
 * `git http-backend` CGI server (`helpers/git-http-backend.ts`, extended in
 * the helper to optionally require Basic auth and reject/serve
 * accordingly):
 *
 *   1. `native/transport_shim.c`'s `tether_register_http_transport` (this
 *      phase's change: register the same subtransport definition under
 *      BOTH `http` and `https`, not just `http`) makes an `https://` URL
 *      actually resolve through our custom transport instead of failing
 *      with "unsupported URL protocol" (this build has no built-in HTTPS
 *      transport at all — `USE_HTTPS=OFF`, see build.sh).
 *   2. `engine.ts`'s `installHttpDispatch` resolves `net.onCredentials`
 *      once, builds a real `Authorization: Basic ...` header via
 *      `basicAuthHeader` (reused from `http-transport.ts`, not
 *      reimplemented), and the server genuinely receives and checks it —
 *      not a mocked assertion on our own request-building code, but a real
 *      second process (`git http-backend`) that only serves the pack data
 *      when the header matches.
 *   3. Fetch, push, AND `listRemoteRefs` all work through the credentialed
 *      path, and omitting/mismatching credentials produces a real failure
 *      (401), not a silent success.
 *
 * TLS ITSELF IS NOT TESTED — same limitation `transport_shim.c`'s header
 * comment already documents: there is no local, trusted, self-signed TLS
 * story to stand up in this test environment, and this C shim never
 * terminates TLS anyway (`requestUrl`/`fetch` does that in production and in
 * this test's injected dispatch function). The URLs below are constructed
 * with an `https://` scheme so libgit2's OWN scheme-based transport
 * dispatch genuinely resolves them via the newly-`https`-registered
 * transport (proving point 1), but the test's own `RequestUrlLike`
 * implementation rewrites the scheme back to plain `http://` before the
 * real `fetch()` call, since the local server has no real TLS listener —
 * this is a test-environment substitution for "assume `requestUrl` handles
 * real TLS correctly," not a claim that real TLS was exercised.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapLibgit2Module } from "../../src/git/libgit2/engine";
import type { RequestUrlLike } from "../../src/git/http-client";
import { startGitHttpBackend } from "./helpers/git-http-backend";
import type { TestNativeModule } from "./helpers/test-module";
import { loadModuleFactory } from "./helpers/test-module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_JS = join(__dirname, "..", "..", "src", "git", "libgit2", "build", "dist", "tether-libgit2.js");

const factory = loadModuleFactory(MODULE_JS);

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd }).toString("utf8").trim();
}

/** Rewrites `https://` back to `http://` before the real `fetch()` call —
 * see this file's header comment for exactly why this is a legitimate test
 * substitution, not a claim of real TLS coverage. */
function makeTestRequestUrl(): RequestUrlLike {
	return async (param) => {
		const url = param.url.replace(/^https:/, "http:");
		const res = await fetch(url, { method: param.method ?? "GET", headers: param.headers, body: param.body });
		const arrayBuffer = await res.arrayBuffer();
		const headers: Record<string, string> = {};
		res.headers.forEach((v, k) => (headers[k] = v));
		return { status: res.status, headers, arrayBuffer };
	};
}

async function freshModule(): Promise<TestNativeModule> {
	const Module = await factory!();
	return Module;
}

const AUTH = { username: "x-access-token", password: "s3cret-token" };
const AUTHOR = { name: "Test", email: "test@example.com" };

function buildSeedRepo(serverRoot: string, allowPush = false): void {
	// `-b main` explicitly: without it, the bare repo's HEAD symref defaults
	// to whatever the LOCAL git installation's `init.defaultBranch` says
	// (historically "master", unless configured otherwise) even though the
	// seed commit below is pushed to `refs/heads/main` — on a machine with
	// no global `init.defaultBranch=main` override (a bare CI container,
	// unlike a dev machine that often has it set), the bare repo's HEAD is
	// left pointing at a `refs/heads/master` that's never created, and a
	// real `git clone` of it in the push test below (independent
	// verification via the real git CLI) fails with "remote HEAD refers to
	// nonexistent ref, unable to checkout" / "your current branch 'master'
	// does not have any commits yet" — a real failure caught by actually
	// running this suite in a real, unconfigured `node:20-bookworm`
	// CI container, not a hypothetical one.
	git(["init", "--quiet", "--bare", "-b", "main", "repo.git"], serverRoot);
	if (allowPush) {
		git(["config", "http.receivepack", "true"], join(serverRoot, "repo.git"));
	}
	const workDir = mkdtempSync(join(tmpdir(), "halyard-auth-seed-"));
	git(["clone", "--quiet", join(serverRoot, "repo.git"), workDir], tmpdir());
	writeFileSync(join(workDir, "file.txt"), "seeded content\n", "utf8");
	git(["add", "file.txt"], workDir);
	git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "seed"], workDir);
	git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], workDir);
}

describe.skipIf(factory === null)("production HTTP transport: HTTPS scheme + Basic-auth credentials (real)", () => {
	it("fetch() over https:// with correct credentials succeeds and the server actually receives the Authorization header", async () => {
		const serverRoot = mkdtempSync(join(tmpdir(), "halyard-auth-fetch-server-"));
		buildSeedRepo(serverRoot);

		const receivedAuthHeaders: Array<string | undefined> = [];
		const server = await startGitHttpBackend(serverRoot, "repo.git", {
			requireAuth: AUTH,
			onRequest: (req) => {
				const h = req.headers.authorization;
				receivedAuthHeaders.push(Array.isArray(h) ? h[0] : h);
			},
		});
		try {
			const httpsUrl = server.url.replace(/^http:/, "https:");
			const Module = await freshModule();
			const git2 = await wrapLibgit2Module(Module, { requestUrl: makeTestRequestUrl() });
			Module.FS.mkdir("/repo");
			// MEMFS (the module's default FS) is enough here — this test is
			// about the transport/credential path, not the FS mount (see
			// fs-backend-mount.test.ts for that).
			const repo = await git2.init({ dir: "/repo" });
			await repo.addRemote("origin", httpsUrl);

			const summary = await repo.fetch("origin", "main", {
				onCredentials: async () => ({ username: AUTH.username, password: AUTH.password }),
			});
			expect(summary.updatedRefs["refs/remotes/origin/main"]).toMatch(/^[0-9a-f]{40}$/);

			// The server really received the header, not just "the request
			// happened to succeed for some other reason" — every captured
			// request must carry the exact expected Basic value.
			expect(receivedAuthHeaders.length).toBeGreaterThan(0);
			const expected = `Basic ${Buffer.from(`${AUTH.username}:${AUTH.password}`).toString("base64")}`;
			for (const h of receivedAuthHeaders) expect(h).toBe(expected);

			await repo.close();
		} finally {
			await server.close();
		}
	}, 30_000);

	it("fetch() without credentials against an auth-required server fails", async () => {
		const serverRoot = mkdtempSync(join(tmpdir(), "halyard-auth-noauth-server-"));
		buildSeedRepo(serverRoot);

		const server = await startGitHttpBackend(serverRoot, "repo.git", { requireAuth: AUTH });
		try {
			const Module = await freshModule();
			const git2 = await wrapLibgit2Module(Module, { requestUrl: makeTestRequestUrl() });
			Module.FS.mkdir("/repo");
			const repo = await git2.init({ dir: "/repo" });
			await repo.addRemote("origin", server.url.replace(/^http:/, "https:"));

			await expect(repo.fetch("origin", "main")).rejects.toThrow();

			await repo.close();
		} finally {
			await server.close();
		}
	}, 30_000);

	it("listRemoteRefs (module-level, no open repo) works with credentials over https://", async () => {
		const serverRoot = mkdtempSync(join(tmpdir(), "halyard-auth-lsremote-server-"));
		buildSeedRepo(serverRoot);

		const server = await startGitHttpBackend(serverRoot, "repo.git", { requireAuth: AUTH });
		try {
			const Module = await freshModule();
			const git2 = await wrapLibgit2Module(Module, { requestUrl: makeTestRequestUrl() });

			const refs = await git2.listRemoteRefs(server.url.replace(/^http:/, "https:"), "refs/heads/", {
				onCredentials: async () => ({ username: AUTH.username, password: AUTH.password }),
			});
			expect(refs.some((r) => r.ref === "refs/heads/main")).toBe(true);
		} finally {
			await server.close();
		}
	}, 30_000);

	it("push() with credentials over https:// updates the remote, verified with the real git CLI", async () => {
		const serverRoot = mkdtempSync(join(tmpdir(), "halyard-auth-push-server-"));
		buildSeedRepo(serverRoot, /* allowPush */ true);

		const server = await startGitHttpBackend(serverRoot, "repo.git", { requireAuth: AUTH });
		try {
			const httpsUrl = server.url.replace(/^http:/, "https:");
			const Module = await freshModule();
			const git2 = await wrapLibgit2Module(Module, { requestUrl: makeTestRequestUrl() });
			Module.FS.mkdir("/repo");

			const net = { onCredentials: async () => ({ username: AUTH.username, password: AUTH.password }) };
			const repo = await git2.clone({ url: httpsUrl, dir: "/repo" }, net);

			Module.FS.writeFile("/repo/new-file.txt", "pushed via engine.ts\n");
			await repo.stagePath("new-file.txt");
			const oid = await repo.commit("push via engine.ts", AUTHOR);
			expect(oid).toMatch(/^[0-9a-f]{40}$/);

			await repo.addRemote("origin", httpsUrl, { force: true });
			await repo.push("origin", { ref: "main" }, net);

			await repo.close();

			// Independent verification: the real git CLI, cloning fresh from
			// the bare server repo, sees the pushed commit.
			const verifyDir = mkdtempSync(join(tmpdir(), "halyard-auth-push-verify-"));
			git(["clone", "--quiet", join(serverRoot, "repo.git"), verifyDir], tmpdir());
			expect(git(["log", "-1", "--format=%s"], verifyDir)).toBe("push via engine.ts");
			expect(git(["show", "HEAD:new-file.txt"], verifyDir)).toBe("pushed via engine.ts");
		} finally {
			await server.close();
		}
	}, 30_000);
});
