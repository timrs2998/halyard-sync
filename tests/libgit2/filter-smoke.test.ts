/**
 * Real, end-to-end smoke test for the compiled libgit2-WASM module
 * (`src/git/libgit2/build/dist/tether-libgit2.js` /
 * `src/git/libgit2/build/dist/tether-libgit2.wasm`, produced by
 * `src/git/libgit2/build/build.sh` — see that directory's README.md and
 * BUILD.md for how it's built and what's still open).
 *
 * This is deliberately NOT a mock. It:
 *   1. Loads the actual compiled Emscripten module.
 *   2. Mounts a real host temp directory into the module's classic FS via
 *      NODEFS (linked in via `-lnodefs.js`, see build.sh's comment on why —
 *      this sidesteps needing the VaultMirror-backed custom FS glue, which
 *      is a separate, still-unbuilt piece, to prove the filter/Asyncify
 *      bridge works). Because NODEFS maps straight onto a real directory,
 *      the *same* on-disk repo can also be inspected with the real `git`
 *      CLI, which is exactly how assertion (1) below is done — independent
 *      verification, not trusting the WASM module's own read-back.
 *   3. Registers the real git-crypt filter shim (`native/filter_shim.c`'s
 *      `tether_register_gitcrypt_filter`), wired to the real, already-unit-
 *      tested `encryptBlob`/`decryptBlob` from `src/git/gitcrypt.ts` (not a
 *      fake/stub crypto implementation — the whole point of this test is an
 *      end-to-end proof, and stubbing the crypto would prove nothing about
 *      the actual git-crypt on-disk format).
 *   4. Drives a real add -> commit -> (delete working-tree file) -> checkout
 *      cycle through the compiled module's exported libgit2 C entry points
 *      via `ccall(..., { async: true })` (required because Asyncify is what
 *      bridges the synchronous C filter callback to the Promise-returning
 *      JS crypto hooks — see filter_shim.c's header comment for the full
 *      Asyncify rationale/risk writeup).
 *   5. Asserts, independently of each other:
 *      - The object database really contains git-crypt's ciphertext framing
 *        (`\0GITCRYPT\0` header) for the added file — read via a real `git
 *        cat-file -p` shellout against the same on-disk repo, proving the
 *        *clean* filter really ran and really encrypted.
 *      - The working-tree file, after being deleted and the commit's HEAD
 *        tree force-checked-out, is back to the original plaintext bytes —
 *        proving the *smudge* filter really ran and really decrypted.
 *
 * Skipped (not failed) when the compiled module doesn't exist, so the rest
 * of the suite still passes in an environment without the Docker/Emscripten
 * toolchain available (see build/BUILD.md for how to produce it).
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptBlob, encryptBlob } from "../../src/git/gitcrypt";
import { mountHostDir } from "./helpers/nodefs-mount";
import type { TestNativeModule } from "./helpers/test-module";
import type { CcallArg, CcallArgType } from "../../src/git/libgit2/native-module";
import { loadModuleFactory } from "./helpers/test-module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "..", "src", "git", "libgit2", "build", "dist");
const MODULE_JS = join(DIST_DIR, "tether-libgit2.node.js");

const factory = loadModuleFactory(MODULE_JS);

// Bytes per git-crypt's on-disk blob header ("\0GITCRYPT\0" — see gitcrypt.ts).
const GITCRYPT_MAGIC = [0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00];
const GIT_CHECKOUT_FORCE = 2;

/** Thin promisified wrapper: every call goes through the async ccall path
 * since Asyncify may need to suspend for any call that reaches the filter's
 * EM_ASYNC_JS hooks (git_index_add_bypath on clean, git_checkout_head on
 * smudge) — calls that never actually suspend just resolve immediately. */
function ccallAsync(
	Module: TestNativeModule,
	name: string,
	returnType: "number",
	argTypes: CcallArgType[],
	args: CcallArg[]
): Promise<number> {
	return Module.ccall(name, returnType, argTypes, args, { async: true });
}

/** Debug helper: libgit2's `git_error_last()` -> a readable string. */
function lastError(Module: TestNativeModule): string {
	const ptr = Module.ccall("git_error_last", "number", [], []);
	if (!ptr) return "(no error set)";
	const msgPtr = Module.getValue(ptr, "i32");
	const klass = Module.getValue(ptr + 4, "i32");
	return `klass=${klass} message=${Module.UTF8ToString(msgPtr)}`;
}

describe.skipIf(factory === null)("compiled libgit2-WASM git-crypt filter (real, not mocked)", () => {
	it("clean filter encrypts into the ODB and smudge filter decrypts back into the working tree", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-libgit2-smoke-"));

		const plaintext = "line one: real end-to-end proof\nline two: through the compiled filter\n";
		writeFileSync(join(dir, ".gitattributes"), "secret.txt filter=git-crypt\n");
		writeFileSync(join(dir, "secret.txt"), plaintext, "utf8");

		// Real AES-256/HMAC-SHA1 key material, generated with WebCrypto per the
		// directly (no key-file import flow needed for this smoke test).
		const aesKey = new Uint8Array(32);
		const hmacKey = new Uint8Array(64);
		crypto.getRandomValues(aesKey);
		crypto.getRandomValues(hmacKey);

		const Module = await factory!();

		mountHostDir(Module, dir, "/repo");

		// The seam documented in binding.ts's GitCryptFilterHooks / filter_shim.c's
		// header comment: real crypto, not a stub.
		Module.__gitcryptEncrypt = async (_keyName: string, pt: Uint8Array) =>
			encryptBlob(aesKey, hmacKey, pt);
		Module.__gitcryptDecrypt = async (_keyName: string, ct: Uint8Array) => decryptBlob(aesKey, ct);

		expect(await ccallAsync(Module, "git_libgit2_init", "number", [], [])).toBeGreaterThanOrEqual(0);

		const regRc = await ccallAsync(Module, "tether_register_gitcrypt_filter", "number", [], []);
		expect(regRc).toBe(0);

		const repoPtrPtr = Module._malloc(4);
		let rc = await ccallAsync(Module, "git_repository_init", "number", ["number", "string", "number"], [
			repoPtrPtr,
			"/repo",
			0,
		]);
		expect(rc).toBe(0);
		const repo = Module.getValue(repoPtrPtr, "i32");
		Module._free(repoPtrPtr);

		const indexPtrPtr = Module._malloc(4);
		rc = await ccallAsync(Module, "git_repository_index", "number", ["number", "number"], [
			indexPtrPtr,
			repo,
		]);
		expect(rc).toBe(0);
		const index = Module.getValue(indexPtrPtr, "i32");
		Module._free(indexPtrPtr);

		// *** The clean filter (encrypt) runs inside this call. ***
		rc = await ccallAsync(Module, "git_index_add_bypath", "number", ["number", "string"], [
			index,
			"secret.txt",
		]);
		expect(rc).toBe(0);

		const treeOidPtr = Module._malloc(20);
		rc = await ccallAsync(Module, "git_index_write_tree", "number", ["number", "number"], [
			treeOidPtr,
			index,
		]);
		expect(rc).toBe(0);

		const treePtrPtr = Module._malloc(4);
		rc = await ccallAsync(Module, "git_tree_lookup", "number", ["number", "number", "number"], [
			treePtrPtr,
			repo,
			treeOidPtr,
		]);
		expect(rc).toBe(0);
		const tree = Module.getValue(treePtrPtr, "i32");
		Module._free(treePtrPtr);
		Module._free(treeOidPtr);

		const sigPtrPtr = Module._malloc(4);
		rc = await ccallAsync(Module, "git_signature_now", "number", ["number", "string", "string"], [
			sigPtrPtr,
			"Test",
			"test@example.com",
		]);
		expect(rc).toBe(0);
		const sig = Module.getValue(sigPtrPtr, "i32");
		Module._free(sigPtrPtr);

		const commitOidPtr = Module._malloc(20);
		rc = await ccallAsync(
			Module,
			"git_commit_create",
			"number",
			["number", "number", "string", "number", "number", "number", "string", "number", "number", "number"],
			[commitOidPtr, repo, "HEAD", sig, sig, 0, "add secret", tree, 0, 0]
		);
		expect(rc).toBe(0);
		Module._free(commitOidPtr);

		// -----------------------------------------------------------------
		// Assertion 1: the ODB really contains git-crypt ciphertext framing.
		// Verified with a REAL `git cat-file`, independent of the WASM
		// module's own read path, against the same on-disk repo (possible
		// only because NODEFS mounts a real directory).
		// -----------------------------------------------------------------
		const blobBytes = execFileSync("git", ["cat-file", "-p", "HEAD:secret.txt"], { cwd: dir });
		expect([...blobBytes.subarray(0, 10)]).toEqual(GITCRYPT_MAGIC);
		expect(blobBytes.equals(Buffer.from(plaintext, "utf8"))).toBe(false);

		// -----------------------------------------------------------------
		// Assertion 2: the working tree round-trips back to plaintext via the
		// REAL smudge filter (not gitcrypt.ts's own already-tested unit
		// tests) after deleting the file and forcing a checkout of HEAD.
		//
		// Deliberately deleted via `Module.FS.unlink` (the WASM module's own
		// classic-FS layer), NOT a raw `node:fs` unlink -- a real bug found
		// while writing this test: Emscripten's classic FS caches looked-up
		// nodes in-memory (separately from NODEFS's passthrough to the real
		// file), so deleting the real host file out-of-band leaves a stale
		// "this file exists" node cached from the earlier `git_index_add_bypath`
		// lookup. `git_checkout_head` then tries to open that stale node for
		// writing (instead of creating a fresh one) and fails with a real OS
		// ENOENT ("could not open '/repo/secret.txt' for writing: No such file
		// or directory") since the underlying file is actually gone. Going
		// through `Module.FS.unlink` keeps the WASM module's own node cache
		// and the real disk in sync, which is also the only correct way any
		// future binding.ts consumer should ever mutate a mounted repo path.
		// -----------------------------------------------------------------
		Module.FS.unlink("/repo/secret.txt");

		const optsPtr = Module._malloc(128);
		rc = await ccallAsync(Module, "git_checkout_options_init", "number", ["number", "number"], [
			optsPtr,
			1,
		]);
		expect(rc).toBe(0);
		Module.setValue(optsPtr + 4, GIT_CHECKOUT_FORCE, "i32");

		// *** The smudge filter (decrypt) runs inside this call. ***
		rc = await ccallAsync(Module, "git_checkout_head", "number", ["number", "number"], [repo, optsPtr]);
		if (rc !== 0) console.error("git_checkout_head failed:", lastError(Module));
		expect(rc).toBe(0);
		Module._free(optsPtr);

		const smudged = readFileSync(join(dir, "secret.txt"), "utf8");
		expect(smudged).toBe(plaintext);
	}, 30_000);
});
