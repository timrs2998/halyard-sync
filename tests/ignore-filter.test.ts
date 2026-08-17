import { describe, expect, it } from "vitest";
import { createIgnoreFilter, DEFAULT_IGNORES } from "../src/git/engine";

describe("createIgnoreFilter defaults", () => {
	const isIgnored = createIgnoreFilter();

	it("ignores .obsidian/workspace and its variants (prefix match)", () => {
		expect(isIgnored(".obsidian/workspace")).toBe(true);
		expect(isIgnored(".obsidian/workspace.json")).toBe(true);
		expect(isIgnored(".obsidian/workspace-mobile.json")).toBe(true);
	});

	it("does not ignore other .obsidian config", () => {
		expect(isIgnored(".obsidian/app.json")).toBe(false);
		expect(isIgnored(".obsidian/community-plugins.json")).toBe(false);
	});

	it("ignores the .trash directory and its contents", () => {
		expect(isIgnored(".trash")).toBe(true);
		expect(isIgnored(".trash/deleted note.md")).toBe(true);
		expect(isIgnored(".trash/sub/deep.md")).toBe(true);
	});

	it("does not ignore look-alike names outside the pattern", () => {
		expect(isIgnored(".trashcan/file.md")).toBe(false);
		expect(isIgnored("notes/daily/2026-07-19.md")).toBe(false);
	});
});

describe("createIgnoreFilter user globs", () => {
	it("supports suffix globs (*.ext)", () => {
		const isIgnored = createIgnoreFilter(["*.tmp"]);
		expect(isIgnored("scratch.tmp")).toBe(true);
		expect(isIgnored("sub/dir/scratch.tmp")).toBe(true);
		expect(isIgnored("scratch.tmpx")).toBe(false);
		expect(isIgnored("scratch.md")).toBe(false);
	});

	it("supports prefix globs (dir/*)", () => {
		const isIgnored = createIgnoreFilter(["private/*"]);
		expect(isIgnored("private/secret.md")).toBe(true);
		expect(isIgnored("public/note.md")).toBe(false);
	});

	it("supports directory patterns (dir/)", () => {
		const isIgnored = createIgnoreFilter(["archive/"]);
		expect(isIgnored("archive")).toBe(true);
		expect(isIgnored("archive/2020/old.md")).toBe(true);
		expect(isIgnored("archives/new.md")).toBe(false);
	});

	it("normalizes leading ./ and backslashes in patterns", () => {
		const isIgnored = createIgnoreFilter(["./cache/", "tmp\\stuff/"]);
		expect(isIgnored("cache/x.bin")).toBe(true);
		expect(isIgnored("tmp/stuff/y.bin")).toBe(true);
	});

	it("ignores empty patterns", () => {
		const isIgnored = createIgnoreFilter(["", "   "]);
		expect(isIgnored("anything.md")).toBe(false);
	});

	it("keeps the defaults active alongside user globs", () => {
		const isIgnored = createIgnoreFilter(["*.tmp"]);
		expect(isIgnored(".obsidian/workspace.json")).toBe(true);
		expect(DEFAULT_IGNORES.length).toBeGreaterThan(0);
	});
});

describe("createIgnoreFilter with an ownDataPath-style extra default", () => {
	// GitEngine merges `ownDataPath` into DEFAULT_IGNORES before calling
	// createIgnoreFilter (see engine.ts's `defaultIgnoresFor`) — this exercises
	// that same merge shape directly against the pure filter function.
	it("ignores the plugin's own data.json alongside the built-in defaults", () => {
		const ownDataPath = ".obsidian/plugins/tether-sync/data.json";
		const isIgnored = createIgnoreFilter([], [...DEFAULT_IGNORES, ownDataPath]);
		expect(isIgnored(ownDataPath)).toBe(true);
		expect(isIgnored(".obsidian/workspace.json")).toBe(true);
		expect(isIgnored(".obsidian/plugins/other-plugin/data.json")).toBe(false);
	});
});
