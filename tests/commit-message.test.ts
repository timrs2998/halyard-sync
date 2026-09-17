import { describe, expect, it } from "vitest";
import { formatSyncCommitMessage, parseSyncCommitAttribution } from "../src/sync/commit-message";

describe("Halyard Sync commit metadata", () => {
	it("writes structured platform and device attribution", () => {
		const message = formatSyncCommitMessage(
			"2026-09-16T12:34:56.000Z",
			"desktop",
			"Tim's laptop"
		);
		expect(message).toBe(
			"vault sync: 2026-09-16T12:34:56.000Z (platform=desktop; device=Tim's laptop)"
		);
		expect(parseSyncCommitAttribution(message)).toEqual({
			platform: "desktop",
			deviceName: "Tim's laptop",
		});
	});

	it("sanitizes delimiters in device labels", () => {
		const message = formatSyncCommitMessage("now", "mobile", "phone; (iOS)");
		expect(message).toContain("device=phone iOS");
		expect(parseSyncCommitAttribution(message).deviceName).toBe("phone iOS");
	});

	it("parses legacy platform-only sync messages", () => {
		expect(parseSyncCommitAttribution("vault sync: 2026-01-01T00:00:00.000Z (desktop)")).toEqual({
			platform: "desktop",
			deviceName: null,
		});
	});

	it("does not invent attribution for unrelated commits", () => {
		expect(parseSyncCommitAttribution("Update note")).toEqual({ platform: null, deviceName: null });
	});
});
