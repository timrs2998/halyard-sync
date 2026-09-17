import { describe, expect, it } from "vitest";
import {
	buildActiveNoteGitDetailsViewModel,
	shortCommitHash,
} from "../src/ui/active-note-git-details";

const oid = "0123456789abcdef0123456789abcdef01234567";

describe("active-note Git details view model", () => {
	it("labels non-Markdown notes as not applicable", () => {
		const model = buildActiveNoteGitDetailsViewModel({ kind: "not-applicable" });
		expect(model.kind).toBe("not-applicable");
		expect(model.message).toContain("Markdown");
	});

	it("preserves clear unavailable, untracked, no-history, and error states", () => {
		for (const state of [
			{ kind: "loading", path: "Note.md" } as const,
			{ kind: "unavailable", message: "Connect a repository" } as const,
			{ kind: "untracked", path: "Note.md", message: "Not tracked" } as const,
			{ kind: "no-history", path: "Note.md", message: "Shallow clone" } as const,
			{ kind: "error", path: "Note.md", message: "Read failed" } as const,
		]) {
			const model = buildActiveNoteGitDetailsViewModel(state);
			expect(model.kind).toBe(state.kind);
			expect(model.message).toBe("message" in state ? state.message : "Checking Git history…");
		}
	});

	it("shows commit metadata and makes the complete hash copyable", () => {
		const model = buildActiveNoteGitDetailsViewModel({
			kind: "available",
			path: "Notes/Today.md",
			commit: {
				oid,
				timestamp: 1_700_000_000,
				timezoneOffsetMinutes: -360,
				authorName: "Halyard Sync",
				authorEmail: "halyard-sync@localhost",
				message: "vault sync: now (platform=desktop; device=workstation)",
			},
		});
		expect(model.path).toBe("Notes/Today.md");
		expect(model.commitMessage).toContain("vault sync");
		expect(model.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "Author", value: "Halyard Sync <halyard-sync@localhost>" }),
				expect.objectContaining({ label: "Commit", value: "0123456", copyValue: oid }),
				expect.objectContaining({ label: "Source", value: "workstation (desktop)" }),
			])
		);
	});

	it("uses an honest fallback for older commits without device metadata", () => {
		const model = buildActiveNoteGitDetailsViewModel({
			kind: "available",
			path: "Note.md",
			commit: {
				oid,
				timestamp: 1_700_000_000,
				timezoneOffsetMinutes: 0,
				authorName: "Someone",
				authorEmail: "someone@example.com",
				message: "Update note",
			},
		});
		expect(model.rows.find((row) => row.label === "Source")?.value).toContain("Unavailable");
	});

	it("shortens hashes to the conventional seven characters", () => {
		expect(shortCommitHash(oid)).toBe("0123456");
	});
});
