import { describe, expect, it } from "vitest";
import { classifyStatusEntries, classifyStatusEntry } from "../src/git/engine";
import { GIT_STATUS, type StatusEntry } from "../src/git/libgit2/binding";

const entry = (path: string, statusFlags: number): StatusEntry => ({ path, statusFlags });

describe("classifyStatusEntry", () => {
	it("returns null for an unmodified file (no bits set)", () => {
		expect(classifyStatusEntry(entry("a.md", GIT_STATUS.CURRENT))).toBeNull();
	});

	it("returns null when only INDEX_* bits are set (already staged, nothing more to do)", () => {
		expect(classifyStatusEntry(entry("staged.md", GIT_STATUS.INDEX_MODIFIED))).toBeNull();
		expect(classifyStatusEntry(entry("staged-new.md", GIT_STATUS.INDEX_NEW))).toBeNull();
	});

	it("classifies a new untracked file as added", () => {
		expect(classifyStatusEntry(entry("new.md", GIT_STATUS.WT_NEW))).toBe("added");
	});

	it("classifies an edited working-tree file as modified", () => {
		expect(classifyStatusEntry(entry("edit.md", GIT_STATUS.WT_MODIFIED))).toBe("modified");
	});

	it("treats WT_TYPECHANGE and WT_RENAMED as modified too", () => {
		expect(classifyStatusEntry(entry("t.md", GIT_STATUS.WT_TYPECHANGE))).toBe("modified");
		expect(classifyStatusEntry(entry("r.md", GIT_STATUS.WT_RENAMED))).toBe("modified");
	});

	it("classifies a working-tree deletion as deleted", () => {
		expect(classifyStatusEntry(entry("gone.md", GIT_STATUS.WT_DELETED))).toBe("deleted");
	});

	it("prioritizes WT_NEW/WT_DELETED over a combined INDEX_* bit", () => {
		expect(
			classifyStatusEntry(entry("new-staged.md", GIT_STATUS.WT_NEW | GIT_STATUS.INDEX_NEW))
		).toBe("added");
		expect(
			classifyStatusEntry(entry("gone-staged.md", GIT_STATUS.WT_DELETED | GIT_STATUS.INDEX_DELETED))
		).toBe("deleted");
	});

	it("ignores IGNORED and CONFLICTED bits on their own", () => {
		expect(classifyStatusEntry(entry("ignored.log", GIT_STATUS.IGNORED))).toBeNull();
	});
});

describe("classifyStatusEntries", () => {
	it("returns an empty list for a clean tree", () => {
		expect(
			classifyStatusEntries([entry("a.md", GIT_STATUS.CURRENT), entry("b.md", GIT_STATUS.CURRENT)])
		).toEqual([]);
	});

	it("classifies a mixed set preserving order", () => {
		const entries: StatusEntry[] = [
			entry("unchanged.md", GIT_STATUS.CURRENT),
			entry("new.md", GIT_STATUS.WT_NEW),
			entry("edited.md", GIT_STATUS.WT_MODIFIED),
			entry("deleted.md", GIT_STATUS.WT_DELETED),
		];
		expect(classifyStatusEntries(entries)).toEqual([
			{ path: "new.md", status: "added" },
			{ path: "edited.md", status: "modified" },
			{ path: "deleted.md", status: "deleted" },
		]);
	});
});
