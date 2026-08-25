import { describe, expect, it } from "vitest";
import { migrateWorkspaceIgnoreLine } from "../src/git/engine";

describe("migrateWorkspaceIgnoreLine", () => {
	const gitignore = (...lines: string[]) => lines.join("\n") + "\n";

	it("rewrites the hardcoded default prefix to the vault's real config folder", () => {
		const before = gitignore(".obsidian/workspace*", ".trash/", ".obsidian/plugins/halyard-sync/data.json");
		const after = migrateWorkspaceIgnoreLine(before, ".config");
		expect(after).not.toBeNull();
		expect(after?.split("\n")).toContain(".config/workspace*");
		expect(after?.split("\n")).not.toContain(".obsidian/workspace*");
	});

	it("leaves every other line untouched, including the plugin's own data.json entry", () => {
		const before = gitignore(".obsidian/workspace*", ".trash/", "attachments/large/", "*.psd");
		const after = migrateWorkspaceIgnoreLine(before, "my-config");
		expect(after?.split("\n")).toEqual(["my-config/workspace*", ".trash/", "attachments/large/", "*.psd", ""]);
	});

	it("does nothing when the config folder is the default one", () => {
		const before = gitignore(".obsidian/workspace*", ".trash/");
		expect(migrateWorkspaceIgnoreLine(before, ".obsidian")).toBeNull();
	});

	it("does nothing when the stale line was never there", () => {
		const before = gitignore(".trash/", "*.psd");
		expect(migrateWorkspaceIgnoreLine(before, ".config")).toBeNull();
	});

	it("is idempotent — a second run finds nothing left to migrate", () => {
		const before = gitignore(".obsidian/workspace*", ".trash/");
		const once = migrateWorkspaceIgnoreLine(before, ".config");
		expect(once).not.toBeNull();
		expect(migrateWorkspaceIgnoreLine(once as string, ".config")).toBeNull();
	});

	it("keeps a deliberate default-path entry when the correct line is already present", () => {
		// A vault also opened on a machine that uses the default folder name
		// may legitimately want both lines — never silently drop one.
		const before = gitignore(".obsidian/workspace*", ".config/workspace*", ".trash/");
		expect(migrateWorkspaceIgnoreLine(before, ".config")).toBeNull();
	});

	it("matches on the line's shape, so any stale config-folder name is repointed", () => {
		// The plugin does not carry Obsidian's default folder name around, so
		// the stale line is recognized by shape rather than by exact value —
		// which also repairs a vault seeded under some other folder name.
		const before = gitignore("old-config/workspace*", ".trash/");
		expect(migrateWorkspaceIgnoreLine(before, ".config")?.split("\n")[0]).toBe(".config/workspace*");
	});

	it("leaves deeper paths alone — only the single-segment ignore line is ours", () => {
		const before = gitignore("notes/archive/workspace*", ".trash/");
		expect(migrateWorkspaceIgnoreLine(before, ".config")).toBeNull();
	});

	it("tolerates surrounding whitespace on the stale line", () => {
		const before = gitignore("  .obsidian/workspace*  ", ".trash/");
		expect(migrateWorkspaceIgnoreLine(before, ".config")?.split("\n")[0]).toBe(".config/workspace*");
	});
});
