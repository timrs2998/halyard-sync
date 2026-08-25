/**
 * Covers the three-way gitattributes-filter split: `"ok"` (no filters, or
 * every git-crypt-family key in use — default and/or named — has a
 * configured key), `"locked"` (at least one git-crypt-family key in use has
 * NO configured key — recoverable, names exactly the missing one(s)), and
 * `"blocked"` (LFS or any other non-git-crypt custom filter — unconditionally
 * unsupported, unchanged). Named git-crypt keys are NOT unsupported anymore
 * (the native filter shim's bare-`"filter"`-attribute matching runs for
 * either form — see `native/filter_shim.c`'s header comment) — a named key
 * with no material configured is `"locked"`, exactly like the default key
 * with no material, never `"blocked"`. The pure parsing/message functions
 * are unit-tested directly; the `GitEngine` methods that actually decide
 * "ok" vs "locked" vs "blocked" are tested against the real compiled
 * libgit2 module (skipped, not failed, when it doesn't exist).
 */

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createGitEngine,
	describeGitCryptLocked,
	describeUnsupportedFilters,
	deriveGitCryptKeyChecklist,
	parseFilterAttributes,
	UnsupportedGitAttributesError,
} from "../src/git/engine";
import { wrapLibgit2Module } from "../src/git/libgit2/engine";
import type { RequestUrlLike } from "../src/git/http-client";
import type { GitCryptKeyMaterial } from "../src/auth/secrets";
import { MockAdapter } from "./helpers/mock-adapter";
import { loadModuleFactory } from "./libgit2/helpers/test-module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_JS = join(__dirname, "..", "src", "git", "libgit2", "build", "dist", "halyard-libgit2.js");

const factory = loadModuleFactory(MODULE_JS);

const noRequestUrl: RequestUrlLike = async () => {
	throw new Error("network disabled in this test");
};

/** A key material stand-in (technically valid, if insecure, all-zero
 * AES-256/HMAC-SHA1 key — real WebCrypto encrypt/decrypt round-trips
 * correctly with it) used wherever a test actually needs the native filter
 * to really run (staging a path under a CONFIGURED key); its presence vs.
 * absence in the map passed to `getGitCryptKeys` is what these tests exercise. */
const SOME_KEY: GitCryptKeyMaterial = {
	aesKey: new Uint8Array(32),
	hmacKey: new Uint8Array(64),
};

/**
 * `existingAdapter`, when given, reuses that adapter's already-flushed state
 * instead of creating a fresh one — needed to build a fixture where a
 * git-crypt-family path is committed WITHOUT the filter ever running (e.g.
 * no keys configured on the setup engine at all), then re-opened by a
 * SECOND engine with different keys configured, to test detection
 * (`listPathsWithAttribute`-based, never requiring decryption) independently
 * of whether staging that content would itself have succeeded under the
 * second engine's key configuration. Mirrors the same "second engine over
 * the same flushed adapter" pattern `tests/engine-smoke.test.ts` already
 * uses for its git-crypt determinism proof.
 */
async function makeEngine(
	getGitCryptKeys?: () => Promise<Map<string, GitCryptKeyMaterial>>,
	existingAdapter?: MockAdapter
) {
	const adapter = existingAdapter ?? new MockAdapter();
	const engine = await createGitEngine({
		instantiateModule: () => factory!(),
		wrapModule: (rawModule, requestUrlFn) => wrapLibgit2Module(rawModule, { requestUrl: requestUrlFn }),
		requestUrl: noRequestUrl,
		adapter,
		author: { name: "Test", email: "test@localhost" },
		configDir: ".obsidian",
		getGitCryptKeys,
	});
	return { adapter, engine };
}

describe("parseFilterAttributes", () => {
	it("extracts a single filter= name", () => {
		expect(parseFilterAttributes("* filter=git-crypt diff=git-crypt\n")).toEqual([
			"git-crypt",
		]);
	});

	it("extracts distinct names across multiple lines and patterns", () => {
		const content = [
			"secrets/** filter=git-crypt diff=git-crypt",
			"*.bin filter=lfs -text",
			"*.md text", // no filter attribute at all
		].join("\n");
		expect(parseFilterAttributes(content).sort()).toEqual(["git-crypt", "lfs"]);
	});

	it("ignores comments and blank lines", () => {
		const content = "# git-crypt config\n\n  \n* filter=git-crypt\n";
		expect(parseFilterAttributes(content)).toEqual(["git-crypt"]);
	});

	it("returns nothing for attributes with no filter driver", () => {
		expect(parseFilterAttributes("*.md text eol=lf\n*.png binary\n")).toEqual([]);
	});
});

describe("describeUnsupportedFilters", () => {
	// NOTE: git-crypt (default or named) is no longer reachable here at all —
	// classifyFilters() routes every git-crypt-family name into "ok"/"locked"
	// instead (see below). This function is only reached for genuinely
	// unsupported filters (LFS, or anything else non-git-crypt).

	it("calls out LFS by name when detected", () => {
		expect(describeUnsupportedFilters(["lfs"])).toContain("Git LFS");
	});

	it("still explains unrecognized custom filters generically", () => {
		const message = describeUnsupportedFilters(["my-custom-filter"]);
		expect(message).toContain("my-custom-filter");
		expect(message).toContain("cannot run");
	});

	it("names a git-crypt filter too when it's blocked alongside a genuinely unsupported one", () => {
		// classifyFilters still passes the FULL name list through to "blocked"
		// even when git-crypt names are mixed in with a real blocker (LFS) —
		// see the "blocked for a mix" GitEngine test below — so this message
		// must still read sensibly in that mixed case.
		const message = describeUnsupportedFilters(["git-crypt", "lfs"]);
		expect(message).toContain("git-crypt");
		expect(message).toContain("Git LFS");
	});
});

describe("describeGitCryptLocked", () => {
	it("mentions git-crypt, importing a key, and that auto-sync is paused", () => {
		const message = describeGitCryptLocked([""]);
		expect(message).toContain("git-crypt");
		expect(message).toContain("Import");
		expect(message).toContain("paused");
	});

	it("names the specific missing named key(s), not a generic notice", () => {
		const message = describeGitCryptLocked(["finance", "personal"]);
		expect(message).toContain("finance");
		expect(message).toContain("personal");
	});

	it("labels the default (unnamed) key slot as 'default', not an empty string", () => {
		const message = describeGitCryptLocked([""]);
		expect(message).toContain("default");
	});
});

describe("deriveGitCryptKeyChecklist", () => {
	it("returns nothing for a repo that declares no git-crypt keys", () => {
		expect(deriveGitCryptKeyChecklist([], [])).toEqual([]);
	});

	it("flags the default key as configured or missing", () => {
		expect(deriveGitCryptKeyChecklist([""], [])).toEqual([{ keyName: "", configured: false }]);
		expect(deriveGitCryptKeyChecklist([""], [""])).toEqual([{ keyName: "", configured: true }]);
	});

	it("sorts the default key first, then named keys alphabetically", () => {
		expect(deriveGitCryptKeyChecklist(["personal", "", "finance"], [])).toEqual([
			{ keyName: "", configured: false },
			{ keyName: "finance", configured: false },
			{ keyName: "personal", configured: false },
		]);
	});

	it("marks only the actually-configured names as configured, independently of each other", () => {
		const result = deriveGitCryptKeyChecklist(["", "finance", "personal"], ["finance"]);
		expect(result).toEqual([
			{ keyName: "", configured: false },
			{ keyName: "finance", configured: true },
			{ keyName: "personal", configured: false },
		]);
	});

	it("de-duplicates repeated declared names", () => {
		expect(deriveGitCryptKeyChecklist(["work", "work", "work"], ["work"])).toEqual([
			{ keyName: "work", configured: true },
		]);
	});

	it("ignores a configured name the repo doesn't actually declare", () => {
		// e.g. a leftover key from a previously-connected different repository.
		expect(deriveGitCryptKeyChecklist(["work"], ["work", "stale-from-another-repo"])).toEqual([
			{ keyName: "work", configured: true },
		]);
	});
});

describe("UnsupportedGitAttributesError", () => {
	it("carries the filter names and a matching message", () => {
		const err = new UnsupportedGitAttributesError(["git-crypt"]);
		expect(err.filters).toEqual(["git-crypt"]);
		expect(err.message).toBe(describeUnsupportedFilters(["git-crypt"]));
		expect(err.name).toBe("UnsupportedGitAttributesError");
	});
});

describe.skipIf(factory === null)("GitEngine.detectUnsupportedFiltersInWorkingTree", () => {
	it("reports 'locked' for a root-level git-crypt filter with no key configured", async () => {
		const { adapter, engine } = await makeEngine();
		await adapter.write(".gitattributes", "* filter=git-crypt diff=git-crypt\n");
		await adapter.write("note.md", "hello\n");

		expect(await engine.detectUnsupportedFiltersInWorkingTree()).toEqual({
			kind: "locked",
			missingKeyNames: [""],
			presentKeyNames: [],
		});
		await engine.close();
	});

	it("reports 'ok' for the same repo once the default key is configured", async () => {
		const { adapter, engine } = await makeEngine(async () => new Map([["", SOME_KEY]]));
		await adapter.write(".gitattributes", "* filter=git-crypt diff=git-crypt\n");

		expect(await engine.detectUnsupportedFiltersInWorkingTree()).toEqual({ kind: "ok" });
		await engine.close();
	});

	it("reports 'locked' for a nested .gitattributes git-crypt filter", async () => {
		const { adapter, engine } = await makeEngine();
		await adapter.mkdir("secrets");
		await adapter.write("secrets/.gitattributes", "* filter=git-crypt\n");

		expect(await engine.detectUnsupportedFiltersInWorkingTree()).toEqual({
			kind: "locked",
			missingKeyNames: [""],
			presentKeyNames: [],
		});
		await engine.close();
	});

	it("reports 'locked' naming exactly the missing NAMED key, for a filter=git-crypt-<name> clause", async () => {
		const { adapter, engine } = await makeEngine();
		await adapter.write(".gitattributes", "secrets/** filter=git-crypt-work diff=git-crypt-work\n");

		expect(await engine.detectUnsupportedFiltersInWorkingTree()).toEqual({
			kind: "locked",
			missingKeyNames: ["work"],
			presentKeyNames: [],
		});
		await engine.close();
	});

	it("reports 'ok' for a named key once that specific name is configured", async () => {
		const { adapter, engine } = await makeEngine(async () => new Map([["work", SOME_KEY]]));
		await adapter.write(".gitattributes", "secrets/** filter=git-crypt-work diff=git-crypt-work\n");

		expect(await engine.detectUnsupportedFiltersInWorkingTree()).toEqual({ kind: "ok" });
		await engine.close();
	});

	it("reports 'locked' naming only the STILL-missing name when some (not all) named keys are configured", async () => {
		const { adapter, engine } = await makeEngine(async () => new Map([["work", SOME_KEY]]));
		await adapter.write(
			".gitattributes",
			"work/** filter=git-crypt-work\npersonal/** filter=git-crypt-personal\n"
		);

		expect(await engine.detectUnsupportedFiltersInWorkingTree()).toEqual({
			kind: "locked",
			missingKeyNames: ["personal"],
			presentKeyNames: ["work"],
		});
		await engine.close();
	});

	it("reports 'blocked' for LFS regardless of any configured git-crypt key", async () => {
		const { adapter, engine } = await makeEngine(async () => new Map([["", SOME_KEY]]));
		await adapter.write(".gitattributes", "*.bin filter=lfs -text\n");

		expect(await engine.detectUnsupportedFiltersInWorkingTree()).toEqual({
			kind: "blocked",
			filters: ["lfs"],
		});
		await engine.close();
	});

	it("reports 'blocked' for a mix of git-crypt and another unsupported filter — still all-or-nothing, unchanged", async () => {
		const { adapter, engine } = await makeEngine(async () => new Map([["", SOME_KEY]]));
		await adapter.write(
			".gitattributes",
			"secrets/** filter=git-crypt\n*.bin filter=lfs -text\n"
		);

		const result = await engine.detectUnsupportedFiltersInWorkingTree();
		expect(result.kind).toBe("blocked");
		if (result.kind === "blocked") {
			expect(result.filters.sort()).toEqual(["git-crypt", "lfs"]);
		}
		await engine.close();
	});

	it("does not descend into .git", async () => {
		const { adapter, engine } = await makeEngine();
		await adapter.mkdir(".git");
		await adapter.write(".git/.gitattributes", "* filter=git-crypt\n");

		expect(await engine.detectUnsupportedFiltersInWorkingTree()).toEqual({ kind: "ok" });
		await engine.close();
	});

	it("reports 'ok' for a vault with no .gitattributes", async () => {
		const { adapter, engine } = await makeEngine();
		await adapter.write("note.md", "hello\n");

		expect(await engine.detectUnsupportedFiltersInWorkingTree()).toEqual({ kind: "ok" });
		await engine.close();
	});
});

describe.skipIf(factory === null)("GitEngine.detectUnsupportedFilters (index-based)", () => {
	it("reports 'locked' once a git-crypt .gitattributes is committed with no key configured", async () => {
		const { adapter, engine } = await makeEngine();
		await engine.initFromExistingVault({ url: "https://example.com/v.git" });
		await adapter.write(".gitattributes", "* filter=git-crypt diff=git-crypt\n");
		await adapter.write("secret.md", "ciphertext\n");
		await engine.stageAndCommit("add git-crypt config");

		expect(await engine.detectUnsupportedFilters()).toEqual({
			kind: "locked",
			missingKeyNames: [""],
			presentKeyNames: [],
		});
		await engine.close();
	});

	it("reports 'ok' for the same commit once the default key is configured", async () => {
		const { adapter, engine } = await makeEngine(async () => new Map([["", SOME_KEY]]));
		await engine.initFromExistingVault({ url: "https://example.com/v.git" });
		await adapter.write(".gitattributes", "* filter=git-crypt diff=git-crypt\n");
		await adapter.write("secret.md", "ciphertext\n");
		await engine.stageAndCommit("add git-crypt config");

		expect(await engine.detectUnsupportedFilters()).toEqual({ kind: "ok" });
		await engine.close();
	});

	it("reports 'ok' for a repo with a plain .gitattributes", async () => {
		const { adapter, engine } = await makeEngine();
		await engine.initFromExistingVault({ url: "https://example.com/v.git" });
		await adapter.write(".gitattributes", "*.md text eol=lf\n");
		await engine.stageAndCommit("add gitattributes");

		expect(await engine.detectUnsupportedFilters()).toEqual({ kind: "ok" });
		await engine.close();
	});

	it("reports 'ok' before any commit exists", async () => {
		const { engine } = await makeEngine();
		await engine.initFromExistingVault({ url: "https://example.com/v.git" });

		expect(await engine.detectUnsupportedFilters()).toEqual({ kind: "ok" });
		await engine.close();
	});

	it("reports 'locked' (not 'blocked') for a NAMED git-crypt key with no key configured — named keys are supported now", async () => {
		// Setup engine has NO keys configured at all, so the native filter
		// never registers (see GitEngine.syncGitCryptFilter) and committing a
		// path under an as-yet-unconfigured named key succeeds as a plain
		// (unencrypted) blob — exactly what a device that has never imported
		// ANY key would see cloning a repo someone else already set up. This
		// mirrors reality: detecting a missing key must never require
		// successfully running that key's filter first.
		const { adapter, engine: setupEngine } = await makeEngine();
		await setupEngine.initFromExistingVault({ url: "https://example.com/v.git" });
		await adapter.write(".gitattributes", "secrets/work.md filter=git-crypt-work diff=git-crypt-work\n");
		await adapter.mkdir("secrets");
		await adapter.write("secrets/work.md", "content under a key this device doesn't have\n");
		await setupEngine.stageAndCommit("add named git-crypt config");
		await setupEngine.close();

		// Re-open with the DEFAULT key configured (but NOT "work") — proves
		// detection is purely attribute-based (listPathsWithAttribute), never
		// requiring the filter to actually run/decrypt anything.
		const { engine } = await makeEngine(async () => new Map([["", SOME_KEY]]), adapter);
		expect(await engine.detectUnsupportedFilters()).toEqual({
			kind: "locked",
			missingKeyNames: ["work"],
			presentKeyNames: [],
		});
		await engine.close();
	});

	it("reports 'ok' for a named git-crypt key once that specific name is configured", async () => {
		const { adapter, engine } = await makeEngine(async () => new Map([["work", SOME_KEY]]));
		await engine.initFromExistingVault({ url: "https://example.com/v.git" });
		await adapter.write(".gitattributes", "secrets/work.md filter=git-crypt-work diff=git-crypt-work\n");
		await adapter.mkdir("secrets");
		await adapter.write("secrets/work.md", "content under the configured work key\n");
		await engine.stageAndCommit("add named git-crypt config");

		expect(await engine.detectUnsupportedFilters()).toEqual({ kind: "ok" });
		await engine.close();
	});

	it("reports 'locked' naming both a missing default AND a missing named key when both are used together", async () => {
		// No keys configured at all -> filter never registers -> both paths
		// commit as plain blobs, same "never requires the filter to succeed
		// first" reasoning as above.
		const { adapter, engine } = await makeEngine();
		await engine.initFromExistingVault({ url: "https://example.com/v.git" });
		await adapter.write(
			".gitattributes",
			"default.md filter=git-crypt\nsecrets/work.md filter=git-crypt-work\n"
		);
		await adapter.write("default.md", "a\n");
		await adapter.mkdir("secrets");
		await adapter.write("secrets/work.md", "b\n");
		await engine.stageAndCommit("add mixed git-crypt config");

		const result = await engine.detectUnsupportedFilters();
		expect(result.kind).toBe("locked");
		if (result.kind === "locked") {
			expect(result.missingKeyNames.sort()).toEqual(["", "work"]);
		}
		await engine.close();
	});

	it("still reports 'blocked' for LFS present alongside a git-crypt filter (unchanged, all-or-nothing)", async () => {
		const { adapter, engine } = await makeEngine(async () => new Map([["", SOME_KEY]]));
		await engine.initFromExistingVault({ url: "https://example.com/v.git" });
		await adapter.write(
			".gitattributes",
			"secret.md filter=git-crypt\nbig.bin filter=lfs -text\n"
		);
		await adapter.write("secret.md", "a\n");
		// lfs is a real, unrelated filter driver this engine never registers at
		// all — GIT_PASSTHROUGH at the native layer, so staging it succeeds
		// as a plain blob regardless of any git-crypt key configuration.
		await adapter.write("big.bin", "not actually large, just filter=lfs-tagged\n");
		await engine.stageAndCommit("add mixed filters");

		const result = await engine.detectUnsupportedFilters();
		expect(result.kind).toBe("blocked");
		if (result.kind === "blocked") {
			expect(result.filters.sort()).toEqual(["git-crypt", "lfs"]);
		}
		await engine.close();
	});
});
