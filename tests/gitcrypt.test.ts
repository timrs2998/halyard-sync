/**
 * Pure-format tests for src/git/gitcrypt.ts (no external binary needed), plus
 * cross-compatibility tests against a real `git`/`git-crypt` CLI, gated by
 * hasGitCrypt() so the suite still passes cleanly in environments (like most
 * CI) where git-crypt isn't installed. See DESIGN.md / engine.ts's
 * UnsupportedGitAttributesError for why this format matters: a pure-JS engine
 * cannot run git-crypt's filter at all, so a from-scratch, spec-accurate
 * implementation is the only way to interoperate with real git-crypt repos.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GitCryptFormatError,
	GitCryptKeyFileError,
	decryptBlob,
	encryptBlob,
	parseKeyFile,
} from "../src/git/gitcrypt";

// ---------------------------------------------------------------------------
// Fixed, deterministic (not random) test key material — reproducible test
// runs, no security purpose.
// ---------------------------------------------------------------------------

function fill(len: number, seed: number): Uint8Array {
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i++) out[i] = (i * 7 + seed) % 256;
	return out;
}

const TEST_AES_KEY = fill(32, 1); // AES_KEY_LEN
const TEST_HMAC_KEY = fill(64, 2); // HMAC_KEY_LEN

// ---------------------------------------------------------------------------
// encryptBlob / decryptBlob — pure round-trip + format conformance
// ---------------------------------------------------------------------------

describe("encryptBlob / decryptBlob round-trip", () => {
	const cases: Array<[string, Uint8Array]> = [
		["empty", new Uint8Array(0)],
		["short ascii", new TextEncoder().encode("hello, git-crypt\n")],
		["all byte values", Uint8Array.from({ length: 256 }, (_, i) => i)],
		["multi-KB binary-looking", fill(50_000, 42)],
	];

	for (const [label, plaintext] of cases) {
		it(`recovers original bytes: ${label}`, async () => {
			const ciphertext = await encryptBlob(TEST_AES_KEY, TEST_HMAC_KEY, plaintext);
			const decrypted = await decryptBlob(TEST_AES_KEY, ciphertext);
			expect(decrypted).toEqual(plaintext);
		});
	}

	it("produces the expected on-disk header: magic + 12-byte nonce", async () => {
		const plaintext = new TextEncoder().encode("some file contents");
		const ciphertext = await encryptBlob(TEST_AES_KEY, TEST_HMAC_KEY, plaintext);

		const magic = ciphertext.slice(0, 10);
		expect([...magic]).toEqual([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);

		// Nonce must equal the first 12 bytes of HMAC-SHA1(hmacKey, plaintext) —
		// computed independently here (not via the module's internals) so this
		// asserts conformance to the actual git-crypt format, not just
		// self-consistency with our own encrypt/decrypt pairing.
		const hmacKey = await crypto.subtle.importKey(
			"raw",
			TEST_HMAC_KEY.slice().buffer,
			{ name: "HMAC", hash: "SHA-1" },
			false,
			["sign"]
		);
		const digest = new Uint8Array(
			await crypto.subtle.sign("HMAC", hmacKey, plaintext.slice().buffer)
		);
		const expectedNonce = digest.slice(0, 12);
		const actualNonce = ciphertext.slice(10, 22);
		expect([...actualNonce]).toEqual([...expectedNonce]);

		// Ciphertext body length must equal plaintext length (CTR is a stream cipher).
		expect(ciphertext.length).toBe(10 + 12 + plaintext.length);
	});

	it("produces different ciphertext for different plaintexts (distinct nonces)", async () => {
		const a = await encryptBlob(TEST_AES_KEY, TEST_HMAC_KEY, new TextEncoder().encode("file A"));
		const b = await encryptBlob(TEST_AES_KEY, TEST_HMAC_KEY, new TextEncoder().encode("file B"));
		expect([...a]).not.toEqual([...b]);
	});
});

describe("encryptBlob determinism", () => {
	it("encrypting the same plaintext with the same keys twice is byte-identical", async () => {
		const plaintext = new TextEncoder().encode(
			"unchanged content must re-encrypt to the exact same bytes, or every " +
				"sync would show every unchanged encrypted file as modified"
		);
		const first = await encryptBlob(TEST_AES_KEY, TEST_HMAC_KEY, plaintext);
		const second = await encryptBlob(TEST_AES_KEY, TEST_HMAC_KEY, plaintext);
		expect([...first]).toEqual([...second]);
	});

	it("stays deterministic across a range of plaintext sizes", async () => {
		for (const len of [0, 1, 15, 16, 17, 1000]) {
			const plaintext = fill(len, 99);
			const first = await encryptBlob(TEST_AES_KEY, TEST_HMAC_KEY, plaintext);
			const second = await encryptBlob(TEST_AES_KEY, TEST_HMAC_KEY, plaintext);
			expect([...first]).toEqual([...second]);
		}
	});
});

describe("decryptBlob error handling", () => {
	it("rejects ciphertext shorter than the header", async () => {
		await expect(decryptBlob(TEST_AES_KEY, new Uint8Array(5))).rejects.toBeInstanceOf(
			GitCryptFormatError
		);
	});

	it("rejects data missing the git-crypt magic header", async () => {
		const notEncrypted = new TextEncoder().encode("plain text file, not git-crypt at all!!");
		await expect(decryptBlob(TEST_AES_KEY, notEncrypted)).rejects.toBeInstanceOf(
			GitCryptFormatError
		);
	});

	it("rejects a wrong-length AES key", async () => {
		await expect(
			encryptBlob(fill(16, 1), TEST_HMAC_KEY, new Uint8Array(0))
		).rejects.toBeInstanceOf(GitCryptFormatError);
	});
});

// ---------------------------------------------------------------------------
// parseKeyFile — synthetic key files built by hand to mirror key.cpp's TLV
// container, independent of whether the real git-crypt CLI is installed.
// ---------------------------------------------------------------------------

function u32be(n: number): number[] {
	return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Field ids per key.hpp: HEADER_FIELD_KEY_NAME=1, KEY_FIELD_VERSION=1,
 * KEY_FIELD_AES_KEY=3, KEY_FIELD_HMAC_KEY=5, *_END=0 for both. */
function buildKeyFileBytes(opts: {
	keyName?: string;
	entries: Array<{ version: number; aesKey: Uint8Array; hmacKey: Uint8Array }>;
	formatVersion?: number;
}): Uint8Array {
	const bytes: number[] = [];
	// "\0GITCRYPTKEY"
	bytes.push(0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x4b, 0x45, 0x59);
	bytes.push(...u32be(opts.formatVersion ?? 2));

	if (opts.keyName !== undefined) {
		const nameBytes = [...new TextEncoder().encode(opts.keyName)];
		bytes.push(...u32be(1), ...u32be(nameBytes.length), ...nameBytes); // HEADER_FIELD_KEY_NAME
	}
	bytes.push(...u32be(0)); // HEADER_FIELD_END

	for (const entry of opts.entries) {
		bytes.push(...u32be(1), ...u32be(4), ...u32be(entry.version)); // KEY_FIELD_VERSION
		bytes.push(...u32be(3), ...u32be(entry.aesKey.length), ...entry.aesKey); // KEY_FIELD_AES_KEY
		bytes.push(...u32be(5), ...u32be(entry.hmacKey.length), ...entry.hmacKey); // KEY_FIELD_HMAC_KEY
		bytes.push(...u32be(0)); // KEY_FIELD_END
	}

	return Uint8Array.from(bytes);
}

describe("parseKeyFile", () => {
	it("parses a minimal default-key file (no key name, one entry)", () => {
		const bytes = buildKeyFileBytes({
			entries: [{ version: 0, aesKey: TEST_AES_KEY, hmacKey: TEST_HMAC_KEY }],
		});
		const parsed = parseKeyFile(bytes);
		expect(parsed.keyName).toBeNull();
		expect(parsed.entries).toHaveLength(1);
		expect([...parsed.aesKey]).toEqual([...TEST_AES_KEY]);
		expect([...parsed.hmacKey]).toEqual([...TEST_HMAC_KEY]);
	});

	it("parses a named key file", () => {
		const bytes = buildKeyFileBytes({
			keyName: "work",
			entries: [{ version: 0, aesKey: TEST_AES_KEY, hmacKey: TEST_HMAC_KEY }],
		});
		expect(parseKeyFile(bytes).keyName).toBe("work");
	});

	it("picks the highest-version entry as the default aesKey/hmacKey", () => {
		const oldAes = fill(32, 10);
		const oldHmac = fill(64, 11);
		const bytes = buildKeyFileBytes({
			entries: [
				{ version: 0, aesKey: oldAes, hmacKey: oldHmac },
				{ version: 1, aesKey: TEST_AES_KEY, hmacKey: TEST_HMAC_KEY },
			],
		});
		const parsed = parseKeyFile(bytes);
		expect(parsed.entries).toHaveLength(2);
		expect([...parsed.aesKey]).toEqual([...TEST_AES_KEY]);
	});

	it("rejects a file with the wrong magic", () => {
		const bytes = buildKeyFileBytes({
			entries: [{ version: 0, aesKey: TEST_AES_KEY, hmacKey: TEST_HMAC_KEY }],
		});
		bytes[0] = 0xff; // corrupt magic
		expect(() => parseKeyFile(bytes)).toThrow(GitCryptKeyFileError);
	});

	it("rejects an unsupported format version", () => {
		const bytes = buildKeyFileBytes({
			formatVersion: 99,
			entries: [{ version: 0, aesKey: TEST_AES_KEY, hmacKey: TEST_HMAC_KEY }],
		});
		try {
			parseKeyFile(bytes);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(GitCryptKeyFileError);
			expect((err as GitCryptKeyFileError).reason).toBe("incompatible");
		}
	});

	it("rejects truncated data", () => {
		const bytes = buildKeyFileBytes({
			entries: [{ version: 0, aesKey: TEST_AES_KEY, hmacKey: TEST_HMAC_KEY }],
		});
		expect(() => parseKeyFile(bytes.slice(0, bytes.length - 10))).toThrow(GitCryptKeyFileError);
	});

	it("rejects an unrecognized critical (odd) field id", () => {
		const bytes = buildKeyFileBytes({
			entries: [{ version: 0, aesKey: TEST_AES_KEY, hmacKey: TEST_HMAC_KEY }],
		});
		// Splice an unknown critical header field (id=7, i.e. odd -> critical)
		// with a 1-byte payload right before HEADER_FIELD_END.
		const magicAndVersion = 16;
		const injected = Uint8Array.from([...u32be(7), ...u32be(1), 0x00]);
		const patched = new Uint8Array(bytes.length + injected.length);
		patched.set(bytes.slice(0, magicAndVersion), 0);
		patched.set(injected, magicAndVersion);
		patched.set(bytes.slice(magicAndVersion), magicAndVersion + injected.length);
		expect(() => parseKeyFile(patched)).toThrow(GitCryptKeyFileError);
	});
});

// ---------------------------------------------------------------------------
// Real git-crypt cross-compatibility (skipped when the binary isn't on PATH)
// ---------------------------------------------------------------------------

function hasGitCrypt(): boolean {
	try {
		execFileSync("git-crypt", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const GIT_CRYPT_AVAILABLE = hasGitCrypt();

describe.skipIf(!GIT_CRYPT_AVAILABLE)("real git-crypt cross-compatibility", () => {
	function makeRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "gitcrypt-test-"));
		execFileSync("git", ["init", "--quiet"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "test@localhost"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
		execFileSync("git-crypt", ["init"], { cwd: dir });
		return dir;
	}

	it("decryptBlob reproduces plaintext from a real git-crypt-encrypted blob", async () => {
		const dir = makeRepo();
		try {
			const plaintext = "these contents must survive git-crypt encryption\nline two\n";
			writeFileSync(join(dir, ".gitattributes"), "secret.txt filter=git-crypt diff=git-crypt\n");
			writeFileSync(join(dir, "secret.txt"), plaintext);
			execFileSync("git", ["add", ".gitattributes", "secret.txt"], { cwd: dir });
			execFileSync("git", ["commit", "--quiet", "-m", "add secret"], { cwd: dir });

			const keyFilePath = join(dir, "exported.key");
			execFileSync("git-crypt", ["export-key", keyFilePath], { cwd: dir });
			const keyBytes = new Uint8Array(readFileSync(keyFilePath));
			const { aesKey } = parseKeyFile(keyBytes);

			// The blob stored in the object database is exactly what git-crypt's
			// clean filter produced — no filter runs on a raw object read.
			const ciphertext = new Uint8Array(
				execFileSync("git", ["cat-file", "-p", "HEAD:secret.txt"], { cwd: dir })
			);

			const decrypted = await decryptBlob(aesKey, ciphertext);
			expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("real git-crypt smudge decrypts a blob produced by our encryptBlob", async () => {
		const dir = makeRepo();
		try {
			const keyFilePath = join(dir, "exported.key");
			execFileSync("git-crypt", ["export-key", keyFilePath], { cwd: dir });
			const keyBytes = new Uint8Array(readFileSync(keyFilePath));
			const { aesKey, hmacKey } = parseKeyFile(keyBytes);

			const plaintext = "round-trip the other direction: TS encrypts, git-crypt decrypts\n";
			const ciphertext = await encryptBlob(aesKey, hmacKey, new TextEncoder().encode(plaintext));

			const smudged = execFileSync("git-crypt", ["smudge", `--key-file=${keyFilePath}`], {
				cwd: dir,
				input: Buffer.from(ciphertext),
			});
			expect(smudged.toString("utf8")).toBe(plaintext);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
