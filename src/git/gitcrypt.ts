/**
 * git-crypt on-disk file format — pure TypeScript / WebCrypto port.
 *
 * This is *not* a from-scratch design: the byte layout below (header magic,
 * nonce derivation, CTR construction, key-file TLV encoding) is ported
 * directly from AGWA/git-crypt's own source so this module round-trips with
 * the real `git-crypt` CLI and its `.gitattributes`-declared clean/smudge
 * filter. References (upstream at github.com/AGWA/git-crypt, master):
 *   - crypto.cpp / crypto.hpp: encrypted blob header + nonce + CTR framing.
 *   - key.cpp / key.hpp: the "internal" key-file container written by
 *     `git-crypt export-key` (and read by `git-crypt unlock`).
 *
 * This module is the cryptographic half of running git-crypt's clean/smudge
 * filter. It is deliberately inert on its own — no filesystem, no git
 * plumbing, no GitEngine wiring — so it unit-tests in isolation. The native
 * filter in `libgit2/` supplies the other half.
 */

// ---------------------------------------------------------------------------
// Format constants (crypto.hpp / key.hpp)
// ---------------------------------------------------------------------------

/** AES-256: git-crypt always uses a 32-byte (256-bit) AES key. */
const AES_KEY_LEN = 32;
/** HMAC-SHA1 key length used to derive the per-file nonce. */
const HMAC_KEY_LEN = 64;
/** First NONCE_LEN bytes of the HMAC-SHA1 digest become the CTR nonce. */
const NONCE_LEN = 12;
/** AES block size; the last (BLOCK_LEN - NONCE_LEN) bytes of the CTR counter
 * block are the big-endian block index, incremented once per block. */
const BLOCK_LEN = 16;
/** Number of low-order bits of the 16-byte counter block that increment per
 * AES block, i.e. (BLOCK_LEN - NONCE_LEN) * 8 — matches store_be32() writing
 * the block index into the last 4 bytes of ctr_value in crypto.cpp. */
const COUNTER_BITS = (BLOCK_LEN - NONCE_LEN) * 8;

/** "\0GITCRYPT\0" — encrypted blob header, see commands.cpp clean()/smudge(). */
const BLOB_MAGIC = new Uint8Array([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);
/** "\0GITCRYPTKEY" — key-file container magic, see key.cpp Key_file::load(). */
const KEY_FILE_MAGIC = new Uint8Array([
	0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x4b, 0x45, 0x59,
]);
/** Key_file::FORMAT_VERSION in key.hpp; a different value is a newer/older
 * git-crypt key-file format this parser has not been updated for. */
const KEY_FILE_FORMAT_VERSION = 2;

const HEADER_FIELD_KEY_NAME = 1;
const KEY_FIELD_VERSION = 1;
const KEY_FIELD_AES_KEY = 3;
const KEY_FIELD_HMAC_KEY = 5;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitCryptFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitCryptFormatError";
	}
}

/**
 * `reason` distinguishes "this isn't a valid key file" (malformed) from
 * "this is a valid key file from a newer/incompatible git-crypt version"
 * (incompatible) — mirrors the Malformed/Incompatible exception split in
 * key.cpp, since the two call for different user-facing advice.
 */
export class GitCryptKeyFileError extends Error {
	constructor(
		message: string,
		readonly reason: "malformed" | "incompatible"
	) {
		super(message);
		this.name = "GitCryptKeyFileError";
	}
}

// ---------------------------------------------------------------------------
// Blob encrypt / decrypt (crypto.cpp)
// ---------------------------------------------------------------------------

/**
 * Encrypt one file's contents into git-crypt's on-disk blob format:
 * `"\0GITCRYPT\0" + nonce(12) + AES-256-CTR(plaintext)`.
 *
 * The nonce is HMAC-SHA1(hmacKey, plaintext) truncated to 12 bytes — not
 * random. This is load-bearing determinism (see crypto.cpp's comment on
 * deterministic CPA security): identical plaintext must always produce
 * byte-identical ciphertext, or every sync would show every unchanged
 * encrypted file as modified.
 */
export async function encryptBlob(
	aesKey: Uint8Array,
	hmacKey: Uint8Array,
	plaintext: Uint8Array
): Promise<Uint8Array> {
	requireLength("aesKey", aesKey, AES_KEY_LEN);
	requireLength("hmacKey", hmacKey, HMAC_KEY_LEN);

	const nonce = await deriveNonce(hmacKey, plaintext);
	const ciphertext = await aesCtrTransform(aesKey, nonce, plaintext, "encrypt");

	const out = new Uint8Array(BLOB_MAGIC.length + NONCE_LEN + ciphertext.length);
	out.set(BLOB_MAGIC, 0);
	out.set(nonce, BLOB_MAGIC.length);
	out.set(ciphertext, BLOB_MAGIC.length + NONCE_LEN);
	return out;
}

/**
 * Reverse `encryptBlob`. Only the AES key is needed: the nonce travels in
 * the ciphertext's header, and (unlike the real `git-crypt smudge`) this
 * does not recompute the HMAC to verify the file wasn't tampered with —
 * callers that want that check have the plaintext afterward and the HMAC
 * key is not part of this function's contract.
 */
export async function decryptBlob(aesKey: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
	requireLength("aesKey", aesKey, AES_KEY_LEN);

	if (ciphertext.length < BLOB_MAGIC.length + NONCE_LEN) {
		throw new GitCryptFormatError("Ciphertext is too short to be a git-crypt blob");
	}
	const magic = ciphertext.subarray(0, BLOB_MAGIC.length);
	if (!bytesEqual(magic, BLOB_MAGIC)) {
		throw new GitCryptFormatError("Not a git-crypt blob (missing \\0GITCRYPT\\0 header)");
	}
	const nonce = ciphertext.subarray(BLOB_MAGIC.length, BLOB_MAGIC.length + NONCE_LEN);
	const body = ciphertext.subarray(BLOB_MAGIC.length + NONCE_LEN);
	return aesCtrTransform(aesKey, nonce, body, "decrypt");
}

async function deriveNonce(hmacKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(hmacKey),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"]
	);
	const digest = await crypto.subtle.sign("HMAC", key, toArrayBuffer(plaintext));
	return new Uint8Array(digest).slice(0, NONCE_LEN);
}

/**
 * Copy a (possibly-offset/shared-buffer) Uint8Array view into a plain,
 * standalone ArrayBuffer. Needed only to satisfy WebCrypto's BufferSource
 * typing across the TS lib/@types/node versions this repo builds against —
 * not a security or correctness concern, just a type-level normalization.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

/**
 * AES-256-CTR with the exact counter-block layout git-crypt's hand-rolled
 * ECB-based CTR loop produces: bytes [0,12) are the nonce (fixed for the
 * whole file), bytes [12,16) are the big-endian block index starting at 0
 * and incrementing once per 16-byte block (crypto.cpp's store_be32 call).
 * WebCrypto's AES-CTR `counter`/`length` options implement precisely this,
 * so no manual per-block ECB loop is needed here.
 */
async function aesCtrTransform(
	aesKey: Uint8Array,
	nonce: Uint8Array,
	data: Uint8Array,
	direction: "encrypt" | "decrypt"
): Promise<Uint8Array> {
	if (nonce.length !== NONCE_LEN) {
		throw new GitCryptFormatError(`Nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
	}
	const counter = new Uint8Array(BLOCK_LEN);
	counter.set(nonce, 0); // remaining 4 bytes stay zero: the initial block index

	const key = await crypto.subtle.importKey("raw", toArrayBuffer(aesKey), { name: "AES-CTR" }, false, [
		direction,
	]);
	const algorithm = { name: "AES-CTR", counter: toArrayBuffer(counter), length: COUNTER_BITS };
	const dataBuffer = toArrayBuffer(data);
	const result =
		direction === "encrypt"
			? await crypto.subtle.encrypt(algorithm, key, dataBuffer)
			: await crypto.subtle.decrypt(algorithm, key, dataBuffer);
	return new Uint8Array(result);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function requireLength(name: string, bytes: Uint8Array, expected: number): void {
	if (bytes.length !== expected) {
		throw new GitCryptFormatError(`${name} must be ${expected} bytes, got ${bytes.length}`);
	}
}

// ---------------------------------------------------------------------------
// Key-file parsing (key.cpp Key_file::load / Entry::load)
// ---------------------------------------------------------------------------

/** One version-numbered key pair inside a key file (key.hpp's Key_file::Entry). */
export interface GitCryptKeyEntry {
	version: number;
	aesKey: Uint8Array;
	hmacKey: Uint8Array;
}

export interface GitCryptKeyFile {
	/** Header's optional key-name field ("default" export omits it -> null). */
	keyName: string | null;
	/** All versioned entries found, in the order they appeared in the file. */
	entries: GitCryptKeyEntry[];
	/** Highest-`version` entry's AES key — what `git-crypt clean`/`smudge`
	 * use by default (Key_file::get_latest in key.cpp). */
	aesKey: Uint8Array;
	/** Highest-`version` entry's HMAC key. */
	hmacKey: Uint8Array;
}

/**
 * Parse the binary "internal" key-file format written by
 * `git-crypt export-key <path>` (and read by `git-crypt unlock <path>`).
 *
 * Layout: 12-byte magic + 4-byte big-endian format version, then a header
 * field list (TLV, field id 0 = end), then zero or more Entry TLV field
 * lists (also id-0-terminated) each carrying a version + AES key + HMAC key.
 * Field ids are big-endian uint32; odd ids are "critical" — an unrecognized
 * odd field id means a newer key-file feature this parser doesn't know
 * about, and per upstream semantics that's a hard failure, not a value to
 * silently ignore. Even unrecognized field ids are safe to skip.
 */
export function parseKeyFile(bytes: Uint8Array): GitCryptKeyFile {
	const reader = new ByteReader(bytes);

	const magic = reader.readBytes(KEY_FILE_MAGIC.length);
	if (!bytesEqual(magic, KEY_FILE_MAGIC)) {
		throw new GitCryptKeyFileError("Not a git-crypt key file (bad magic)", "malformed");
	}
	const formatVersion = reader.readU32();
	if (formatVersion !== KEY_FILE_FORMAT_VERSION) {
		throw new GitCryptKeyFileError(
			`Unsupported git-crypt key file format version ${formatVersion}`,
			"incompatible"
		);
	}

	const keyName = readHeaderFields(reader);

	const entries: GitCryptKeyEntry[] = [];
	while (reader.hasRemaining()) {
		entries.push(readEntry(reader));
	}
	if (entries.length === 0) {
		throw new GitCryptKeyFileError("Key file contains no keys", "malformed");
	}

	const latest = entries.reduce((a, b) => (b.version > a.version ? b : a));
	return { keyName, entries, aesKey: latest.aesKey, hmacKey: latest.hmacKey };
}

function readHeaderFields(reader: ByteReader): string | null {
	let keyName: string | null = null;
	while (true) {
		const fieldId = reader.readU32();
		if (fieldId === 0) return keyName; // HEADER_FIELD_END
		const fieldLen = reader.readU32();
		if (fieldId === HEADER_FIELD_KEY_NAME) {
			keyName = new TextDecoder().decode(reader.readBytes(fieldLen));
		} else if (fieldId % 2 === 1) {
			throw new GitCryptKeyFileError(
				`Unrecognized critical header field ${fieldId}`,
				"incompatible"
			);
		} else {
			reader.skip(fieldLen);
		}
	}
}

function readEntry(reader: ByteReader): GitCryptKeyEntry {
	let version: number | null = null;
	let aesKey: Uint8Array | null = null;
	let hmacKey: Uint8Array | null = null;
	while (true) {
		const fieldId = reader.readU32();
		if (fieldId === 0) break; // KEY_FIELD_END
		const fieldLen = reader.readU32();
		if (fieldId === KEY_FIELD_VERSION) {
			if (fieldLen !== 4) {
				throw new GitCryptKeyFileError("Malformed key version field", "malformed");
			}
			version = reader.readU32();
		} else if (fieldId === KEY_FIELD_AES_KEY) {
			if (fieldLen !== AES_KEY_LEN) {
				throw new GitCryptKeyFileError("Malformed AES key field", "malformed");
			}
			aesKey = reader.readBytes(AES_KEY_LEN).slice();
		} else if (fieldId === KEY_FIELD_HMAC_KEY) {
			if (fieldLen !== HMAC_KEY_LEN) {
				throw new GitCryptKeyFileError("Malformed HMAC key field", "malformed");
			}
			hmacKey = reader.readBytes(HMAC_KEY_LEN).slice();
		} else if (fieldId % 2 === 1) {
			throw new GitCryptKeyFileError(`Unrecognized critical key field ${fieldId}`, "incompatible");
		} else {
			reader.skip(fieldLen);
		}
	}
	if (aesKey === null || hmacKey === null) {
		throw new GitCryptKeyFileError("Key entry missing AES or HMAC key", "malformed");
	}
	return { version: version ?? 0, aesKey, hmacKey };
}

/** Minimal bounds-checked cursor over a byte buffer, big-endian uint32 only
 * (all integers in this format are — see read_be32/write_be32 in util.cpp). */
class ByteReader {
	private pos = 0;
	constructor(private readonly bytes: Uint8Array) {}

	hasRemaining(): boolean {
		return this.pos < this.bytes.length;
	}

	readBytes(len: number): Uint8Array {
		if (this.bytes.length - this.pos < len) {
			throw new GitCryptKeyFileError("Unexpected end of key file", "malformed");
		}
		const out = this.bytes.subarray(this.pos, this.pos + len);
		this.pos += len;
		return out;
	}

	readU32(): number {
		const b = this.readBytes(4);
		return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
	}

	skip(len: number): void {
		this.readBytes(len);
	}
}
