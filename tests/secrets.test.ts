import { describe, expect, it } from "vitest";
import {
	detectSecretStorage,
	GitCryptKeyStore,
	gitCryptKeyStorageKey,
	SecretStore,
	secretKeyForHost,
	type FallbackSecretPersistence,
	type GitCryptKeyMaterial,
} from "../src/auth/secrets";

function memoryFallback(initial: Record<string, string> = {}) {
	let data = { ...initial };
	const saves: Array<Record<string, string>> = [];
	const persistence: FallbackSecretPersistence = {
		load: async () => ({ ...data }),
		save: async (secrets) => {
			data = { ...secrets };
			saves.push({ ...secrets });
		},
	};
	return { persistence, saves, get data() { return data; } };
}

describe("detectSecretStorage", () => {
	it("returns null when the app has no secretStorage", () => {
		expect(detectSecretStorage({})).toBeNull();
		expect(detectSecretStorage(null)).toBeNull();
		expect(detectSecretStorage({ secretStorage: 42 })).toBeNull();
		expect(detectSecretStorage({ secretStorage: {} })).toBeNull();
	});

	it("adapts a getSecret/setSecret-shaped storage", async () => {
		const backing = new Map<string, string>();
		const storage = detectSecretStorage({
			secretStorage: {
				getSecret: (key: string) => backing.get(key) ?? null,
				setSecret: (key: string, value: string) => void backing.set(key, value),
				deleteSecret: (key: string) => void backing.delete(key),
			},
		});
		expect(storage).not.toBeNull();
		await storage!.setSecret("k", "v");
		await expect(storage!.getSecret("k")).resolves.toBe("v");
		await storage!.deleteSecret("k");
		await expect(storage!.getSecret("k")).resolves.toBeNull();
	});

	it("adapts a plain get/set-shaped storage and empties instead of deleting", async () => {
		const backing = new Map<string, string>();
		const storage = detectSecretStorage({
			secretStorage: {
				get: (key: string) => backing.get(key) ?? null,
				set: (key: string, value: string) => void backing.set(key, value),
			},
		});
		expect(storage).not.toBeNull();
		await storage!.setSecret("k", "v");
		await storage!.deleteSecret("k"); // no delete method -> set("")
		await expect(storage!.getSecret("k")).resolves.toBeNull();
	});
});

describe("SecretStore", () => {
	it("uses secure storage when available and is not insecure", async () => {
		const backing = new Map<string, string>();
		const fallback = memoryFallback();
		const store = new SecretStore(
			{
				getSecret: async (k) => backing.get(k) ?? null,
				setSecret: async (k, v) => void backing.set(k, v),
				deleteSecret: async (k) => void backing.delete(k),
			},
			fallback.persistence
		);

		expect(store.insecure).toBe(false);
		await store.setToken("github.com", "tok");
		expect(backing.get(secretKeyForHost("github.com"))).toBe("tok");
		expect(fallback.saves).toHaveLength(0); // nothing leaked to data.json
		await expect(store.getToken("github.com")).resolves.toBe("tok");
		await store.deleteToken("github.com");
		await expect(store.getToken("github.com")).resolves.toBeNull();
	});

	it("falls back to plugin data and flags insecure", async () => {
		const fallback = memoryFallback();
		const store = new SecretStore(null, fallback.persistence);

		expect(store.insecure).toBe(true);
		await store.setToken("gitlab.com", "tok2");
		expect(fallback.data[secretKeyForHost("gitlab.com")]).toBe("tok2");
		await expect(store.getToken("gitlab.com")).resolves.toBe("tok2");
		await store.deleteToken("gitlab.com");
		await expect(store.getToken("gitlab.com")).resolves.toBeNull();
	});

	it("keys tokens per host", async () => {
		const fallback = memoryFallback();
		const store = new SecretStore(null, fallback.persistence);
		await store.setToken("github.com", "a");
		await store.setToken("git.corp.example", "b");
		await expect(store.getToken("github.com")).resolves.toBe("a");
		await expect(store.getToken("git.corp.example")).resolves.toBe("b");
		expect(secretKeyForHost("github.com")).toBe("halyard-sync-github-com");
	});

	it("produces a lowercase-alphanumeric-plus-dashes ID (app.secretStorage's only accepted shape)", () => {
		expect(secretKeyForHost("github.com")).toMatch(/^[a-z0-9-]+$/);
		expect(secretKeyForHost("GitLab.Example.com:8443")).toBe(
			"halyard-sync-gitlab-example-com-8443"
		);
	});

	it("migrates a legacy colon-keyed fallback token on next write", async () => {
		const fallback = memoryFallback({ "tether-sync:github.com": "old-tok" });
		const store = new SecretStore(null, fallback.persistence);

		await expect(store.getToken("github.com")).resolves.toBe("old-tok");

		await store.setToken("github.com", "new-tok");
		expect(fallback.data["tether-sync:github.com"]).toBeUndefined();
		expect(fallback.data[secretKeyForHost("github.com")]).toBe("new-tok");
	});
});

// ---------------------------------------------------------------------------
// GitCryptKeyStore — per-host, per-KEY-NAME storage (default "" plus zero or
// more named keys, e.g. `filter=git-crypt-finance` -> "finance"). Both the
// SecretStorage-available and data.json-fallback backends are covered, same
// as SecretStore above.
// ---------------------------------------------------------------------------

function material(seed: number): GitCryptKeyMaterial {
	return { aesKey: new Uint8Array(32).fill(seed), hmacKey: new Uint8Array(64).fill(seed + 1) };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function expectMaterialEqual(actual: GitCryptKeyMaterial | null, expected: GitCryptKeyMaterial): void {
	expect(actual).not.toBeNull();
	expect(bytesEqual(actual!.aesKey, expected.aesKey)).toBe(true);
	expect(bytesEqual(actual!.hmacKey, expected.hmacKey)).toBe(true);
}

describe("GitCryptKeyStore", () => {
	describe.each([
		["SecretStorage-backed", () => {
			const backing = new Map<string, string>();
			return {
				getSecret: async (k: string) => backing.get(k) ?? null,
				setSecret: async (k: string, v: string) => void backing.set(k, v),
				deleteSecret: async (k: string) => void backing.delete(k),
			};
		}],
	] as const)("%s", (_label, makeStorage) => {
		it("round-trips the default key and a named key independently, and lists configured names", async () => {
			const fallback = memoryFallback();
			const store = new GitCryptKeyStore(makeStorage(), fallback.persistence);

			expect(await store.getKey("github.com")).toBeNull();
			expect(await store.hasKey("github.com")).toBe(false);
			expect(await store.listConfiguredNames("github.com")).toEqual([]);

			const defaultKey = material(1);
			const financeKey = material(10);
			await store.setKey("github.com", "", defaultKey);
			await store.setKey("github.com", "finance", financeKey);

			expect(await store.hasKey("github.com")).toBe(true);
			expect(await store.hasKey("github.com", "finance")).toBe(true);
			expect(await store.hasKey("github.com", "personal")).toBe(false);
			expectMaterialEqual(await store.getKey("github.com"), defaultKey);
			expectMaterialEqual(await store.getKey("github.com", "finance"), financeKey);
			expect(await store.getKey("github.com", "personal")).toBeNull();
			expect((await store.listConfiguredNames("github.com")).sort()).toEqual(["", "finance"]);

			const all = await store.getAllKeys("github.com");
			expect(all.size).toBe(2);
			expectMaterialEqual(all.get("") ?? null, defaultKey);
			expectMaterialEqual(all.get("finance") ?? null, financeKey);

			// Deleting one name leaves the other untouched.
			await store.deleteKey("github.com", "finance");
			expect(await store.hasKey("github.com", "finance")).toBe(false);
			expectMaterialEqual(await store.getKey("github.com"), defaultKey);
			expect(await store.listConfiguredNames("github.com")).toEqual([""]);

			await store.deleteKey("github.com");
			expect(await store.listConfiguredNames("github.com")).toEqual([]);
			expect(await store.getAllKeys("github.com")).toEqual(new Map());
		});

		it("keeps keys independent per host", async () => {
			const fallback = memoryFallback();
			const store = new GitCryptKeyStore(makeStorage(), fallback.persistence);
			await store.setKey("github.com", "", material(1));
			await store.setKey("gitlab.com", "", material(2));

			expectMaterialEqual(await store.getKey("github.com"), material(1));
			expectMaterialEqual(await store.getKey("gitlab.com"), material(2));
			expect(gitCryptKeyStorageKey("github.com")).toBe("halyard-sync-gitcrypt-github-com");
		});
	});

	it("falls back to plugin data (data.json) when SecretStorage is unavailable", async () => {
		const fallback = memoryFallback();
		const store = new GitCryptKeyStore(null, fallback.persistence);

		await store.setKey("github.com", "", material(3));
		await store.setKey("github.com", "work", material(4));

		expectMaterialEqual(await store.getKey("github.com"), material(3));
		expectMaterialEqual(await store.getKey("github.com", "work"), material(4));
		expect((await store.listConfiguredNames("github.com")).sort()).toEqual(["", "work"]);
		// Actually persisted into the injected fallback (not just in-memory).
		expect(Object.keys(fallback.data)).toContain(gitCryptKeyStorageKey("github.com"));

		await store.deleteKey("github.com", "work");
		expect(await store.hasKey("github.com", "work")).toBe(false);
		expectMaterialEqual(await store.getKey("github.com"), material(3));
	});

	it("tolerates the old single-key flat encoding as 'no keys configured' rather than crashing", async () => {
		// Pre-named-key data.json shape was a flat {aesKey,hmacKey} object per
		// host, not a name -> material map. Reading it back must not throw and
		// must not misinterpret "aesKey"/"hmacKey" as configured key NAMES.
		const fallback = memoryFallback({
			[gitCryptKeyStorageKey("github.com")]: JSON.stringify({ aesKey: "AAAA", hmacKey: "BBBB" }),
		});
		const store = new GitCryptKeyStore(null, fallback.persistence);

		expect(await store.getKey("github.com")).toBeNull();
		expect(await store.listConfiguredNames("github.com")).toEqual([]);
	});
});
