/**
 * Real, end-to-end test for NAMED git-crypt keys through the compiled
 * libgit2-WASM module (`native/filter_shim.c`'s bare-`"filter"`-attribute
 * matching + `filter_check`'s value-prefix dispatch — see that file's
 * header comment for the libgit2 attribute-clause DSL research this is
 * built on).
 *
 * Companion to `filter-smoke.test.ts` (which only exercises the default,
 * unnamed key): this proves two things `filter-smoke.test.ts` cannot, since
 * it only ever registers one key:
 *
 *   1. A path declared `filter=git-crypt-finance` really round-trips
 *      through the compiled module using the "finance" key specifically —
 *      clean (encrypt) writes real git-crypt ciphertext framing to the ODB
 *      (verified via a real `git cat-file`, independent of the WASM
 *      module's own read path, same pattern as filter-smoke.test.ts), and
 *      smudge (decrypt) restores the exact original plaintext in the
 *      working tree after a delete + forced checkout.
 *   2. KEY ISOLATION: a file encrypted under the "finance" key is genuinely
 *      only decryptable with the "finance" key. Decrypting the SAME stored
 *      ciphertext bytes with the DEFAULT key's material produces garbage,
 *      not the original plaintext — proving the key name that reaches
 *      `Module.__gitcryptEncrypt`/`Module.__gitcryptDecrypt` is really the
 *      one from the path's `.gitattributes` value (`filter=git-crypt-finance`
 *      -> keyName "finance"), not just "some" key or always the default.
 *
 * A THIRD file, plain `filter=git-crypt` (no name), is included alongside
 * the named one in the SAME repo/commit, proving the default and a named
 * key coexist correctly in one repo (not an either/or) — matching the real
 * git-crypt named-key model (default key + per-subtree named keys, same
 * repo).
 *
 * Skipped (not failed) when the compiled module doesn't exist, matching
 * every other real compiled-module test in this directory.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { decryptBlob, encryptBlob } from "../../src/git/gitcrypt";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const DIST_DIR = join(__dirname, "..", "..", "src", "git", "libgit2", "build", "dist");
const MODULE_JS = join(DIST_DIR, "tether-libgit2.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadFactory(): (() => Promise<any>) | null {
	try {
		const mod = require(MODULE_JS);
		return typeof mod === "function" ? mod : mod.default;
	} catch {
		return null;
	}
}

const factory = loadFactory();

const GITCRYPT_MAGIC = [0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00];
const GIT_CHECKOUT_FORCE = 2;

function ccallAsync(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	Module: any,
	name: string,
	returnType: string,
	argTypes: string[],
	args: unknown[]
): Promise<number> {
	return Module.ccall(name, returnType, argTypes, args, { async: true });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastError(Module: any): string {
	const ptr = Module.ccall("git_error_last", "number", [], []);
	if (!ptr) return "(no error set)";
	const msgPtr = Module.getValue(ptr, "i32");
	const klass = Module.getValue(ptr + 4, "i32");
	return `klass=${klass} message=${Module.UTF8ToString(msgPtr)}`;
}

function randomKeyMaterial(): { aesKey: Uint8Array; hmacKey: Uint8Array } {
	const aesKey = new Uint8Array(32);
	const hmacKey = new Uint8Array(64);
	crypto.getRandomValues(aesKey);
	crypto.getRandomValues(hmacKey);
	return { aesKey, hmacKey };
}

describe.skipIf(factory === null)("compiled libgit2-WASM git-crypt filter — named keys (real, not mocked)", () => {
	it("a named key round-trips independently of the default key, and the two keys are NOT interchangeable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-libgit2-named-key-"));

		const defaultPlaintext = "default-key file: unnamed, plain filter=git-crypt\n";
		const financePlaintext = "finance-key file: filter=git-crypt-finance, a DIFFERENT key\n";

		writeFileSync(
			join(dir, ".gitattributes"),
			"default.txt filter=git-crypt\nfinance.txt filter=git-crypt-finance\n"
		);
		writeFileSync(join(dir, "default.txt"), defaultPlaintext, "utf8");
		writeFileSync(join(dir, "finance.txt"), financePlaintext, "utf8");

		const defaultKey = randomKeyMaterial();
		const financeKey = randomKeyMaterial();
		const keysByName = new Map([
			["", defaultKey],
			["finance", financeKey],
		]);

		const Module = await factory!();
		Module.FS.mkdir("/repo");
		Module.FS.mount(Module.NODEFS, { root: dir }, "/repo");

		// Real dispatch on keyName, exactly what src/git/engine.ts's
		// gitCryptFilterHooks() is required to do once a repo has more than
		// one configured key (see the phase brief) — proven here at the
		// native-boundary level, independent of that TS-side map.
		Module.__gitcryptEncrypt = async (keyName: string, pt: Uint8Array) => {
			const key = keysByName.get(keyName);
			if (key === undefined) throw new Error(`no key configured for "${keyName}"`);
			return encryptBlob(key.aesKey, key.hmacKey, pt);
		};
		Module.__gitcryptDecrypt = async (keyName: string, ct: Uint8Array) => {
			const key = keysByName.get(keyName);
			if (key === undefined) throw new Error(`no key configured for "${keyName}"`);
			return decryptBlob(key.aesKey, ct);
		};

		expect(await ccallAsync(Module, "git_libgit2_init", "number", [], [])).toBeGreaterThanOrEqual(0);
		expect(await ccallAsync(Module, "tether_register_gitcrypt_filter", "number", [], [])).toBe(0);

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

		// *** Clean filters run inside these calls — default key for
		// default.txt, "finance" key for finance.txt. ***
		for (const path of ["default.txt", "finance.txt"]) {
			rc = await ccallAsync(Module, "git_index_add_bypath", "number", ["number", "string"], [
				index,
				path,
			]);
			expect(rc).toBe(0);
		}

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
			[commitOidPtr, repo, "HEAD", sig, sig, 0, "add default + finance", tree, 0, 0]
		);
		expect(rc).toBe(0);
		Module._free(commitOidPtr);

		// -----------------------------------------------------------------
		// Assertion 1: both blobs are real git-crypt ciphertext (independent
		// `git cat-file`, same pattern as filter-smoke.test.ts), and they are
		// NOT byte-identical to each other or to their plaintexts.
		// -----------------------------------------------------------------
		const defaultCipher = execFileSync("git", ["cat-file", "-p", "HEAD:default.txt"], { cwd: dir });
		const financeCipher = execFileSync("git", ["cat-file", "-p", "HEAD:finance.txt"], { cwd: dir });
		expect([...defaultCipher.subarray(0, 10)]).toEqual(GITCRYPT_MAGIC);
		expect([...financeCipher.subarray(0, 10)]).toEqual(GITCRYPT_MAGIC);
		expect(defaultCipher.equals(Buffer.from(defaultPlaintext, "utf8"))).toBe(false);
		expect(financeCipher.equals(Buffer.from(financePlaintext, "utf8"))).toBe(false);

		// -----------------------------------------------------------------
		// Assertion 2 (KEY ISOLATION): decrypting the "finance" ciphertext
		// with the DEFAULT key's material must NOT reproduce the finance
		// plaintext — proving the two keys are genuinely independent, not
		// just "a key" being used for everything. (AES-CTR with the wrong
		// key produces garbage, not a thrown error — the meaningful
		// assertion is that the bytes are wrong, not that it throws.)
		const wrongKeyAttempt = await decryptBlob(defaultKey.aesKey, new Uint8Array(financeCipher));
		expect(Buffer.from(wrongKeyAttempt).equals(Buffer.from(financePlaintext, "utf8"))).toBe(false);
		// And the reverse: the finance key must not decrypt the default file either.
		const reverseWrongKeyAttempt = await decryptBlob(financeKey.aesKey, new Uint8Array(defaultCipher));
		expect(Buffer.from(reverseWrongKeyAttempt).equals(Buffer.from(defaultPlaintext, "utf8"))).toBe(false);
		// The RIGHT key for each does reproduce the right plaintext (sanity
		// check that the "wrong key" comparisons above aren't vacuously true
		// because of some other bug).
		const rightDefault = await decryptBlob(defaultKey.aesKey, new Uint8Array(defaultCipher));
		expect(Buffer.from(rightDefault).equals(Buffer.from(defaultPlaintext, "utf8"))).toBe(true);
		const rightFinance = await decryptBlob(financeKey.aesKey, new Uint8Array(financeCipher));
		expect(Buffer.from(rightFinance).equals(Buffer.from(financePlaintext, "utf8"))).toBe(true);

		// -----------------------------------------------------------------
		// Assertion 3: smudge (decrypt) round-trips both files back to their
		// correct plaintext through the compiled module itself (not just
		// gitcrypt.ts's own unit-tested crypto) after deleting the working
		// tree files and forcing a checkout of HEAD.
		// -----------------------------------------------------------------
		Module.FS.unlink("/repo/default.txt");
		Module.FS.unlink("/repo/finance.txt");

		const optsPtr = Module._malloc(128);
		rc = await ccallAsync(Module, "git_checkout_options_init", "number", ["number", "number"], [
			optsPtr,
			1,
		]);
		expect(rc).toBe(0);
		Module.setValue(optsPtr + 4, GIT_CHECKOUT_FORCE, "i32");

		// *** Smudge filters run inside this call — default key for
		// default.txt, "finance" key for finance.txt. ***
		rc = await ccallAsync(Module, "git_checkout_head", "number", ["number", "number"], [repo, optsPtr]);
		if (rc !== 0) console.error("git_checkout_head failed:", lastError(Module));
		expect(rc).toBe(0);
		Module._free(optsPtr);

		expect(readFileSync(join(dir, "default.txt"), "utf8")).toBe(defaultPlaintext);
		expect(readFileSync(join(dir, "finance.txt"), "utf8")).toBe(financePlaintext);
	}, 30_000);

	it("an unrelated filter (lfs) alongside git-crypt paths is left untouched (GIT_PASSTHROUGH)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-libgit2-named-key-lfs-"));

		writeFileSync(
			join(dir, ".gitattributes"),
			"secret.txt filter=git-crypt\nbig.bin filter=lfs\nplain.txt\n"
		);
		writeFileSync(join(dir, "secret.txt"), "plaintext for the default key\n", "utf8");
		writeFileSync(join(dir, "big.bin"), "not actually large, just filter=lfs-tagged\n", "utf8");
		writeFileSync(join(dir, "plain.txt"), "no filter attribute at all\n", "utf8");

		const { aesKey, hmacKey } = randomKeyMaterial();

		const Module = await factory!();
		Module.FS.mkdir("/repo");
		Module.FS.mount(Module.NODEFS, { root: dir }, "/repo");
		Module.__gitcryptEncrypt = async (_keyName: string, pt: Uint8Array) => encryptBlob(aesKey, hmacKey, pt);
		Module.__gitcryptDecrypt = async (_keyName: string, ct: Uint8Array) => decryptBlob(aesKey, ct);

		expect(await ccallAsync(Module, "git_libgit2_init", "number", [], [])).toBeGreaterThanOrEqual(0);
		expect(await ccallAsync(Module, "tether_register_gitcrypt_filter", "number", [], [])).toBe(0);

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

		for (const path of ["secret.txt", "big.bin", "plain.txt"]) {
			rc = await ccallAsync(Module, "git_index_add_bypath", "number", ["number", "string"], [
				index,
				path,
			]);
			expect(rc).toBe(0);
		}

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
			[commitOidPtr, repo, "HEAD", sig, sig, 0, "mixed filters", tree, 0, 0]
		);
		expect(rc).toBe(0);
		Module._free(commitOidPtr);

		// secret.txt: really encrypted (clean filter ran for it).
		const secretCipher = execFileSync("git", ["cat-file", "-p", "HEAD:secret.txt"], { cwd: dir });
		expect([...secretCipher.subarray(0, 10)]).toEqual(GITCRYPT_MAGIC);

		// big.bin (filter=lfs) and plain.txt (no filter attribute) must be
		// stored byte-for-byte as-is: this filter passed them through
		// untouched (GIT_PASSTHROUGH), never calling out to
		// __gitcryptEncrypt for them at all.
		const lfsStored = execFileSync("git", ["cat-file", "-p", "HEAD:big.bin"], { cwd: dir });
		const plainStored = execFileSync("git", ["cat-file", "-p", "HEAD:plain.txt"], { cwd: dir });
		expect(lfsStored.equals(Buffer.from("not actually large, just filter=lfs-tagged\n", "utf8"))).toBe(true);
		expect(plainStored.equals(Buffer.from("no filter attribute at all\n", "utf8"))).toBe(true);
	}, 30_000);
});
