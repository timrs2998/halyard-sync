/**
 * Token storage. Prefers Obsidian's `app.secretStorage` (OS keychain on
 * desktop, added in Obsidian 1.11) and falls back to plugin saved data when
 * it is unavailable. The fallback is plaintext on disk, so `insecure` is
 * exposed for the settings UI to warn on.
 *
 * The obsidian typings may not declare `secretStorage` yet, so detection is
 * a narrow structural probe of the App object — no `any` and no hard
 * dependency on a particular typings version.
 */

export interface SecretStorageLike {
	getSecret(key: string): Promise<string | null>;
	setSecret(key: string, value: string): Promise<void>;
	deleteSecret(key: string): Promise<void>;
}

type LooseFn = (...args: unknown[]) => unknown;

function pickMethod(obj: Record<string, unknown>, names: string[]): LooseFn | null {
	for (const name of names) {
		const fn = obj[name];
		if (typeof fn === "function") return (fn as LooseFn).bind(obj);
	}
	return null;
}

/**
 * Feature-detect `app.secretStorage` at runtime. Accepts both the
 * `getSecret/setSecret` and plain `get/set` method spellings so a typings or
 * API rename does not silently break token storage.
 */
export function detectSecretStorage(app: unknown): SecretStorageLike | null {
	const storage = (app as { secretStorage?: unknown } | null | undefined)
		?.secretStorage;
	if (typeof storage !== "object" || storage === null) return null;
	const obj = storage as Record<string, unknown>;
	const get = pickMethod(obj, ["getSecret", "get"]);
	const set = pickMethod(obj, ["setSecret", "set"]);
	if (get === null || set === null) return null;
	const del = pickMethod(obj, ["deleteSecret", "removeSecret", "delete", "remove"]);
	return {
		getSecret: async (key) => {
			const value = await get(key);
			return typeof value === "string" && value.length > 0 ? value : null;
		},
		setSecret: async (key, value) => {
			await set(key, value);
		},
		deleteSecret: async (key) => {
			// No delete surface -> best effort: overwrite with empty string,
			// which getSecret above reports as null.
			if (del !== null) await del(key);
			else await set(key, "");
		},
	};
}

/** Persistence for the insecure fallback (plugin data.json, injected for tests). */
export interface FallbackSecretPersistence {
	load(): Promise<Record<string, string>>;
	save(secrets: Record<string, string>): Promise<void>;
}

const KEY_PREFIX = "tether-sync-";
/** Pre-fix key shape (colons, dots — invalid once a real host hits
 * `app.secretStorage`, whose `setSecret` only accepts a "lowercase
 * alphanumeric ID with optional dashes" and throws otherwise). Still checked
 * on read for the insecure data.json fallback, which had no such
 * restriction and may hold tokens saved under the old shape. */
const LEGACY_KEY_PREFIX = "tether-sync:";

/** `app.secretStorage.setSecret` requires a lowercase-alphanumeric-plus-
 * dashes ID — a real host ("github.com", "gitlab.example.com:8443") fails
 * that on the dots and colon alone, so every character outside [a-z0-9]
 * collapses to a dash. */
function sanitizeSecretId(raw: string): string {
	return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function secretKeyForHost(host: string): string {
	return `${KEY_PREFIX}${sanitizeSecretId(host)}`;
}

function legacySecretKeyForHost(host: string): string {
	return `${LEGACY_KEY_PREFIX}${host}`;
}

export class SecretStore {
	constructor(
		private readonly storage: SecretStorageLike | null,
		private readonly fallback: FallbackSecretPersistence
	) {}

	/** True when tokens live in plugin data instead of the OS keychain. */
	get insecure(): boolean {
		return this.storage === null;
	}

	async getToken(host: string): Promise<string | null> {
		const key = secretKeyForHost(host);
		if (this.storage !== null) return this.storage.getSecret(key);
		const secrets = await this.fallback.load();
		const value = secrets[key] ?? secrets[legacySecretKeyForHost(host)];
		return typeof value === "string" && value.length > 0 ? value : null;
	}

	async setToken(host: string, token: string): Promise<void> {
		const key = secretKeyForHost(host);
		if (this.storage !== null) {
			await this.storage.setSecret(key, token);
			return;
		}
		const secrets = { ...(await this.fallback.load()) };
		delete secrets[legacySecretKeyForHost(host)];
		secrets[key] = token;
		await this.fallback.save(secrets);
	}

	async deleteToken(host: string): Promise<void> {
		const key = secretKeyForHost(host);
		if (this.storage !== null) {
			await this.storage.deleteSecret(key);
			return;
		}
		const secrets = { ...(await this.fallback.load()) };
		delete secrets[key];
		delete secrets[legacySecretKeyForHost(host)];
		await this.fallback.save(secrets);
	}
}

// ---------------------------------------------------------------------------
// git-crypt key storage
// ---------------------------------------------------------------------------

/** Parsed git-crypt key material (see `git/gitcrypt.ts`'s `GitCryptKeyFile`) —
 * only the two symmetric keys actually needed to encrypt/decrypt blobs; not
 * the whole parsed key-file structure (key name / multiple versioned
 * entries), which is a setup-time-only concern already resolved by the time
 * a key is stored here. */
export interface GitCryptKeyMaterial {
	aesKey: Uint8Array;
	hmacKey: Uint8Array;
}

const GITCRYPT_KEY_PREFIX = "tether-sync-gitcrypt-";
/** See `LEGACY_KEY_PREFIX` above — same pre-fix shape, same fallback-only read. */
const LEGACY_GITCRYPT_KEY_PREFIX = "tether-sync:gitcrypt:";

export function gitCryptKeyStorageKey(host: string): string {
	return `${GITCRYPT_KEY_PREFIX}${sanitizeSecretId(host)}`;
}

function legacyGitCryptKeyStorageKey(host: string): string {
	return `${LEGACY_GITCRYPT_KEY_PREFIX}${host}`;
}

/** Wire encoding of one key entry (base64 of the raw bytes). */
interface EncodedGitCryptKeyMaterial {
	aesKey: string;
	hmacKey: string;
}

function encodeGitCryptKeyMaterial(material: GitCryptKeyMaterial): EncodedGitCryptKeyMaterial {
	return {
		aesKey: Buffer.from(material.aesKey).toString("base64"),
		hmacKey: Buffer.from(material.hmacKey).toString("base64"),
	};
}

function decodeGitCryptKeyMaterialEntry(value: unknown): GitCryptKeyMaterial | null {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as Record<string, unknown>).aesKey !== "string" ||
		typeof (value as Record<string, unknown>).hmacKey !== "string"
	) {
		return null;
	}
	const { aesKey, hmacKey } = value as EncodedGitCryptKeyMaterial;
	try {
		return {
			aesKey: new Uint8Array(Buffer.from(aesKey, "base64")),
			hmacKey: new Uint8Array(Buffer.from(hmacKey, "base64")),
		};
	} catch {
		return null;
	}
}

/**
 * One host's git-crypt key material stored as a MAP of key name -> material
 * (`""` = the default/unnamed key, anything else = a named key, e.g.
 * `filter=git-crypt-finance` -> `"finance"`) — a real repo can use the
 * default key for most paths and one or more named keys for specific
 * subtrees at the same time (see `src/git/engine.ts`'s `FilterCheckResult`
 * doc comment), so a single flat value per host is no longer enough.
 */
function encodeGitCryptKeyMap(map: ReadonlyMap<string, GitCryptKeyMaterial>): string {
	const obj: Record<string, EncodedGitCryptKeyMaterial> = {};
	for (const [keyName, material] of map) {
		obj[keyName] = encodeGitCryptKeyMaterial(material);
	}
	return JSON.stringify(obj);
}

/** Returns an empty map (rather than throwing) for anything that doesn't
 * parse as the shape this store itself writes — defensive against a future
 * format change, a hand-edited data.json, or the OLD single-key encoding
 * from before named-key support (a flat `{aesKey,hmacKey}` object, which
 * this rejects as "no entries" rather than misreading it as a map whose
 * keys happen to be literally "aesKey"/"hmacKey") — same tolerance
 * `SecretStore` gives a missing/empty token. */
function decodeGitCryptKeyMap(raw: string): Map<string, GitCryptKeyMaterial> {
	const map = new Map<string, GitCryptKeyMaterial>();
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return map;
		}
		for (const [keyName, value] of Object.entries(parsed as Record<string, unknown>)) {
			const material = decodeGitCryptKeyMaterialEntry(value);
			if (material !== null) map.set(keyName, material);
		}
	} catch {
		// Falls through to the empty map — same "absent" contract as a missing key.
	}
	return map;
}

/** The default/unnamed git-crypt key's slot name, matching
 * `src/git/engine.ts`'s `""` convention for `filter=git-crypt` (no name). */
export const DEFAULT_GITCRYPT_KEY_NAME = "";

/**
 * Stores parsed git-crypt key material per remote host, per KEY NAME (the
 * default/unnamed key plus zero or more named keys — see the module comment
 * above) — the same per-host-keying convention `SecretStore` already uses
 * for PATs/OAuth tokens, and the same SecretStorage-with-data.json-fallback
 * backend (a sibling store rather than folding into `SecretStore` itself:
 * the value shape is structured key material, not an opaque bearer-token
 * string, so it needs its own encode/decode step either way).
 */
export class GitCryptKeyStore {
	constructor(
		private readonly storage: SecretStorageLike | null,
		private readonly fallback: FallbackSecretPersistence
	) {}

	private async loadMap(host: string): Promise<Map<string, GitCryptKeyMaterial>> {
		const key = gitCryptKeyStorageKey(host);
		let raw: string | null;
		if (this.storage !== null) {
			raw = await this.storage.getSecret(key);
		} else {
			const secrets = await this.fallback.load();
			raw = secrets[key] ?? secrets[legacyGitCryptKeyStorageKey(host)] ?? null;
		}
		return raw !== null && raw.length > 0 ? decodeGitCryptKeyMap(raw) : new Map();
	}

	private async saveMap(host: string, map: ReadonlyMap<string, GitCryptKeyMaterial>): Promise<void> {
		const key = gitCryptKeyStorageKey(host);
		if (map.size === 0) {
			if (this.storage !== null) {
				await this.storage.deleteSecret(key);
				return;
			}
			const secrets = { ...(await this.fallback.load()) };
			delete secrets[key];
			delete secrets[legacyGitCryptKeyStorageKey(host)];
			await this.fallback.save(secrets);
			return;
		}
		const encoded = encodeGitCryptKeyMap(map);
		if (this.storage !== null) {
			await this.storage.setSecret(key, encoded);
			return;
		}
		const secrets = { ...(await this.fallback.load()) };
		delete secrets[legacyGitCryptKeyStorageKey(host)];
		secrets[key] = encoded;
		await this.fallback.save(secrets);
	}

	/** All key names currently configured for `host`, `""` first if present
	 * (matches `deriveGitCryptKeyChecklist`'s default-first sort intent) —
	 * used by the settings checklist to know what's already configured. */
	async listConfiguredNames(host: string): Promise<string[]> {
		return [...(await this.loadMap(host)).keys()];
	}

	/** Every configured key for `host`, as a name -> material map — what
	 * `GitEngineOptions.getGitCryptKeys` needs directly. */
	async getAllKeys(host: string): Promise<Map<string, GitCryptKeyMaterial>> {
		return this.loadMap(host);
	}

	async getKey(host: string, keyName: string = DEFAULT_GITCRYPT_KEY_NAME): Promise<GitCryptKeyMaterial | null> {
		return (await this.loadMap(host)).get(keyName) ?? null;
	}

	async hasKey(host: string, keyName: string = DEFAULT_GITCRYPT_KEY_NAME): Promise<boolean> {
		return (await this.getKey(host, keyName)) !== null;
	}

	/** `keyName` has no default here (unlike `getKey`/`hasKey`/`deleteKey`):
	 * a write should always be explicit about which slot it's filling —
	 * callers importing a key file already have its embedded name (or `""`
	 * for a default-key export) to pass, see `main.ts`'s `importGitCryptKey`. */
	async setKey(host: string, keyName: string, material: GitCryptKeyMaterial): Promise<void> {
		const map = await this.loadMap(host);
		map.set(keyName, material);
		await this.saveMap(host, map);
	}

	async deleteKey(host: string, keyName: string = DEFAULT_GITCRYPT_KEY_NAME): Promise<void> {
		const map = await this.loadMap(host);
		map.delete(keyName);
		await this.saveMap(host, map);
	}
}
