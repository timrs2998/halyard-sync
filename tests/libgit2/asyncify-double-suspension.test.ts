/**
 * The Asyncify double-suspension probe — the single biggest open question
 * flagged in `native/filter_shim.c`'s header comment and `build/BUILD.md`:
 * can ONE top-level libgit2 call that internally triggers BOTH the
 * transport's Asyncify suspension (a real network fetch, bridged via
 * `native/transport_shim.c`'s `EM_ASYNC_JS` dispatch) AND the git-crypt
 * filter's Asyncify suspension (a real decrypt, bridged via
 * `native/filter_shim.c`'s `EM_ASYNC_JS` hooks) — actually work, or does it
 * hit Asyncify's documented "cannot start an async operation while another
 * is already running" hazard?
 *
 * `native/transport_shim.c`'s `tether_test_clone_and_checkout()` is written
 * specifically to exercise this: ONE C function, one top-level `ccall` from
 * this test, that internally does `git_remote_fetch` (transport Asyncify)
 * immediately followed by `git_checkout_tree` (filter Asyncify) with no
 * return to JS in between — the exact shape needed to test nested/adjacent
 * suspension within a single call stack, not two independent top-level
 * calls (which would trivially work and prove nothing about the risk).
 *
 * The "remote" is a real `git http-backend` CGI process on 127.0.0.1 (see
 * `helpers/git-http-backend.ts`), serving a real bare repo whose one
 * committed file is real git-crypt ciphertext (produced by this test's own
 * call to the real, already-tested `encryptBlob` from `src/git/gitcrypt.ts`
 * — not hand-crafted fake bytes). The client's git-crypt filter is wired to
 * the real `decryptBlob` with the matching key, so a passing test proves the
 * fetched ciphertext is decrypted back to the original plaintext by the
 * REAL smudge filter, in the same call as the REAL network fetch.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptBlob } from "../../src/git/gitcrypt";
import { startGitHttpBackend } from "./helpers/git-http-backend";
import { mountHostDir } from "./helpers/nodefs-mount";
import type { TestNativeModule } from "./helpers/test-module";
import type { CcallArg, CcallArgType } from "../../src/git/libgit2/native-module";
import { loadModuleFactory } from "./helpers/test-module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_JS = join(__dirname, "..", "..", "src", "git", "libgit2", "build", "dist", "tether-libgit2.node.js");

const factory = loadModuleFactory(MODULE_JS);

function ccallAsync(
	Module: TestNativeModule,
	name: string,
	returnType: "number",
	argTypes: CcallArgType[],
	args: CcallArg[]
) {
	return Module.ccall(name, returnType, argTypes, args, { async: true });
}

function lastError(Module: TestNativeModule): string {
	const ptr = Module.ccall("git_error_last", "number", [], []);
	if (!ptr) return "(no error set)";
	const msgPtr = Module.getValue(ptr, "i32");
	const klass = Module.getValue(ptr + 4, "i32");
	return `klass=${klass} message=${Module.UTF8ToString(msgPtr)}`;
}

function git(args: string[], opts: { cwd: string; input?: Buffer; env?: Record<string, string> }): Buffer {
	return execFileSync("git", args, {
		cwd: opts.cwd,
		input: opts.input,
		env: { ...process.env, ...opts.env },
	});
}

/** Build a real bare repo at `serverRoot/repoDirName` whose single commit
 * contains a real git-crypt-ciphertext blob for `secret.txt`, using plumbing
 * commands (hash-object/mktree/commit-tree/update-ref) rather than the real
 * `git-crypt` CLI, since the ciphertext bytes themselves come from this
 * repo's own already-tested `encryptBlob` -- exactly what git-crypt's own
 * clean filter would have produced. */
async function buildServerRepo(
	serverRoot: string,
	repoDirName: string,
	plaintext: string,
	aesKey: Uint8Array,
	hmacKey: Uint8Array
): Promise<void> {
	const repoDir = join(serverRoot, repoDirName);
	git(["init", "--quiet", "--bare", repoDir], { cwd: serverRoot });

	const ciphertext = await encryptBlob(aesKey, hmacKey, new TextEncoder().encode(plaintext));
	const blobOid = git(["hash-object", "-w", "--stdin", "-t", "blob"], {
		cwd: repoDir,
		input: Buffer.from(ciphertext),
	})
		.toString("utf8")
		.trim();
	const attrOid = git(["hash-object", "-w", "--stdin", "-t", "blob"], {
		cwd: repoDir,
		input: Buffer.from("secret.txt filter=git-crypt\n", "utf8"),
	})
		.toString("utf8")
		.trim();

	const treeInput = `100644 blob ${blobOid}\tsecret.txt\n100644 blob ${attrOid}\t.gitattributes\n`;
	const treeOid = git(["mktree"], { cwd: repoDir, input: Buffer.from(treeInput, "utf8") })
		.toString("utf8")
		.trim();

	const commitOid = git(["commit-tree", treeOid, "-m", "seed"], {
		cwd: repoDir,
		env: {
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	})
		.toString("utf8")
		.trim();

	git(["update-ref", "refs/heads/main", commitOid], { cwd: repoDir });
	git(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: repoDir });
}

describe.skipIf(factory === null)("Asyncify double-suspension probe (real fetch + real smudge, one call)", () => {
	it("tether_test_clone_and_checkout: fetch (transport Asyncify) then checkout-smudge (filter Asyncify) in ONE top-level call", async () => {
		const serverRoot = mkdtempSync(join(tmpdir(), "tether-http-server-"));
		const plaintext = "fetched-over-real-http-then-decrypted-by-the-real-filter\n";

		const aesKey = new Uint8Array(32);
		const hmacKey = new Uint8Array(64);
		crypto.getRandomValues(aesKey);
		crypto.getRandomValues(hmacKey);

		await buildServerRepo(serverRoot, "repo.git", plaintext, aesKey, hmacKey);

		const server = await startGitHttpBackend(serverRoot, "repo.git");
		try {
			const Module = await factory!();

			const destDir = mkdtempSync(join(tmpdir(), "tether-http-client-"));
			mountHostDir(Module, destDir, "/dest");

			Module.__gitcryptDecrypt = async (_keyName: string, ciphertext: Uint8Array) => {
				const { decryptBlob } = await import("../../src/git/gitcrypt");
				return decryptBlob(aesKey, ciphertext);
			};
			Module.__gitcryptEncrypt = async (_keyName: string, pt: Uint8Array) => encryptBlob(aesKey, hmacKey, pt);

			Module.__httpDispatch = async (
				url: string,
				method: string,
				contentType: string | null,
				body: Uint8Array
			) => {
				const res = await fetch(url, {
					method,
					headers: contentType ? { "Content-Type": contentType } : undefined,
					body: body.length > 0 ? (body.slice().buffer) : undefined,
				});
				const buf = new Uint8Array(await res.arrayBuffer());
				return { status: res.status, body: buf };
			};

			expect(await ccallAsync(Module, "git_libgit2_init", "number", [], [])).toBeGreaterThanOrEqual(0);
			expect(await ccallAsync(Module, "tether_register_gitcrypt_filter", "number", [], [])).toBe(0);
			expect(await ccallAsync(Module, "tether_register_http_transport", "number", [], [])).toBe(0);

			const oidHexPtr = Module._malloc(41);

			// *** THE PROBE: one top-level call, both Asyncify paths inside. ***
			const rc = await ccallAsync(
				Module,
				"tether_test_clone_and_checkout",
				"number",
				["string", "string", "number"],
				[server.url, "/dest", oidHexPtr]
			);

			if (rc !== 0) {
				console.error("tether_test_clone_and_checkout failed, rc =", rc, lastError(Module));
			}
			expect(rc).toBe(0);

			const smudged = readFileSync(join(destDir, "secret.txt"), "utf8");
			expect(smudged).toBe(plaintext);
		} finally {
			await server.close();
		}
	}, 30_000);
});
