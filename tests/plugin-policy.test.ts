import { describe, expect, it } from "vitest";
import {
	derivePluginPolicyPatterns,
	deterministicPluginPolicyPatterns,
	inferPluginPolicySettings,
	normalizePluginSyncPolicies,
	policyMigrationCandidatePaths,
	upsertManagedPluginPolicyBlock,
	readManagedPluginPolicyPatterns,
	PLUGIN_POLICY_BEGIN,
	PLUGIN_POLICY_END,
} from "../src/sync/plugin-policy";

describe("managed plugin policy block", () => {
	it("accepts only deterministic local-plugin patterns", () => {
		expect(deterministicPluginPolicyPatterns(".obsidian", [
			".obsidian/plugins/halyard-fetch/",
			".obsidian/plugins/halyard-fetch/data.json",
			".obsidian/community-plugins.json",
			"notes/",
			".git/objects/",
			".obsidian/plugins/a/b/",
		])).toEqual([
			".obsidian/community-plugins.json",
			".obsidian/plugins/halyard-fetch/",
			".obsidian/plugins/halyard-fetch/data.json",
		]);
	});

	it("preserves user lines and round-trips deterministic patterns", () => {
		const before = "# user header\nnotes/\n\n";
		const withPolicy = upsertManagedPluginPolicyBlock(before, [
			".obsidian/plugins/zeta/",
			".obsidian/plugins/alpha/data.json",
		]);
		expect(withPolicy).toBe(
			"# user header\nnotes/\n\n" +
				`${PLUGIN_POLICY_BEGIN}\n` +
				"# This block is managed by Halyard Sync. Edit the policy in its settings.\n" +
				".obsidian/plugins/alpha/data.json\n" +
				".obsidian/plugins/zeta/\n" +
				`${PLUGIN_POLICY_END}\n`
		);
		expect(readManagedPluginPolicyPatterns(withPolicy)).toEqual([
			".obsidian/plugins/alpha/data.json",
			".obsidian/plugins/zeta/",
		]);
		expect(upsertManagedPluginPolicyBlock(withPolicy, [".obsidian/plugins/zeta/"])).toContain("# user header\nnotes/\n\n");
		expect(upsertManagedPluginPolicyBlock(withPolicy, [])).toBe("# user header\nnotes/\n\n");
	});

	it("leaves malformed marker pairs untouched instead of appending a second block", () => {
		const unterminated = `${PLUGIN_POLICY_BEGIN}\n.obsidian/plugins/a/\n`;
		const orphanEnd = `notes/\n${PLUGIN_POLICY_END}\n`;
		expect(upsertManagedPluginPolicyBlock(unterminated, ["other/"])).toBe(unterminated);
		expect(upsertManagedPluginPolicyBlock(orphanEnd, ["other/"])).toBe(orphanEnd);
	});

	it("preserves CRLF user content", () => {
		const before = "notes/\r\n";
		const result = upsertManagedPluginPolicyBlock(before, [".config/plugins/a/"]);
		expect(result).toContain("notes/\r\n");
		expect(result).toContain("\r\n" + PLUGIN_POLICY_BEGIN);
	});
});

describe("plugin policy derivation", () => {
	const policies = {
		zeta: "device-local" as const,
		alpha: "code-only" as const,
		shared: "shared" as const,
	};

	it("uses the custom config directory and stable ordering", () => {
		expect(derivePluginPolicyPatterns(".config", policies, "device-local", "halyard-sync")).toEqual([
			".config/community-plugins.json",
			".config/plugins/alpha/data.json",
			".config/plugins/zeta/",
		]);
	});

	it("keeps backward-compatible defaults and excludes Halyard Sync itself", () => {
		expect(normalizePluginSyncPolicies(undefined)).toEqual({});
		expect(normalizePluginSyncPolicies({ "*": "device-local", "safe-plugin": "code-only" })).toEqual({
			"safe-plugin": "code-only",
		});
		expect(derivePluginPolicyPatterns(".obsidian", {}, "shared", "halyard-sync")).toEqual([]);
		expect(derivePluginPolicyPatterns(".obsidian", { "halyard-sync": "device-local" }, "shared", "halyard-sync")).toEqual([]);
		expect(inferPluginPolicySettings(".obsidian", [], [{ id: "shared", name: "Shared" }], "halyard-sync")).toEqual({
			pluginSyncPolicies: { shared: "shared" },
			communityPluginsSync: "shared",
		});
	});

	it("preserves a policy entry for a plugin that is not installed on this device", () => {
		const inferred = inferPluginPolicySettings(
			".obsidian",
			[".obsidian/plugins/halyard-fetch/", ".obsidian/community-plugins.json"],
			[{ id: "mobile-only", name: "Mobile Only" }],
			"halyard-sync"
		);
		expect(inferred.pluginSyncPolicies["halyard-fetch"]).toBe("device-local");
		expect(derivePluginPolicyPatterns(
			".obsidian",
			inferred.pluginSyncPolicies,
			inferred.communityPluginsSync,
			"halyard-sync"
		)).toEqual([".obsidian/community-plugins.json", ".obsidian/plugins/halyard-fetch/"]);
	});

	it("only selects paths belonging to requested exclusions", () => {
		expect(policyMigrationCandidatePaths(
			".obsidian",
			[
				{ id: "shared", name: "Shared" },
				{ id: "code", name: "Code" },
				{ id: "local", name: "Local" },
			],
			[
				".obsidian/plugins/shared/extra.bin",
				".obsidian/plugins/code/data.json",
				".obsidian/plugins/local/extra.bin",
			],
			{ shared: "shared", code: "code-only", local: "device-local" },
			"shared"
		)).toEqual([
			".obsidian/plugins/code/data.json",
			".obsidian/plugins/local/data.json",
			".obsidian/plugins/local/extra.bin",
			".obsidian/plugins/local/main.js",
			".obsidian/plugins/local/manifest.json",
			".obsidian/plugins/local/styles.css",
		]);
	});
});
