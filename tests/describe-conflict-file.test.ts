import { describe, expect, it } from "vitest";
import { describeConflictFile, type ConflictFileStat } from "../src/git/engine";

function stat(partial: Partial<ConflictFileStat>): ConflictFileStat {
	return { path: "note.md", localLines: 5, remoteLines: 5, binary: false, ...partial };
}

describe("describeConflictFile", () => {
	it("falls back to the bare path when no stat was computed", () => {
		expect(describeConflictFile("note.md", undefined)).toBe("note.md");
	});

	it("flags binary files without a line count", () => {
		expect(describeConflictFile("image.png", stat({ binary: true }))).toBe(
			"image.png (binary)"
		);
	});

	it("reports a file missing locally as added remotely", () => {
		expect(describeConflictFile("new.md", stat({ localLines: null }))).toBe(
			"new.md (added remotely)"
		);
	});

	it("reports a file missing on the remote as added locally", () => {
		expect(describeConflictFile("new.md", stat({ remoteLines: null }))).toBe(
			"new.md (added locally)"
		);
	});

	it("reports equal line counts as changed on both sides", () => {
		expect(describeConflictFile("note.md", stat({ localLines: 10, remoteLines: 10 }))).toBe(
			"note.md (10 lines, both changed)"
		);
	});

	it("shows a local -> remote line-count delta otherwise", () => {
		expect(describeConflictFile("note.md", stat({ localLines: 12, remoteLines: 18 }))).toBe(
			"note.md (12 → 18 lines)"
		);
	});
});
