import { describe, expect, it } from "vitest";
import { buildSyncPanelViewModel, formatNextSync } from "../src/ui/sync-panel-model";
import type { SyncHistoryEntry, SyncStatusEvent } from "../src/sync/orchestrator";

function event(partial: Partial<SyncStatusEvent>): SyncStatusEvent {
	return {
		state: "idle",
		reason: null,
		message: null,
		lastSyncAt: null,
		conflictFiles: null,
		prUrl: null,
		...partial,
	};
}

describe("formatNextSync", () => {
	it("reports paused regardless of nextFireAt", () => {
		expect(formatNextSync(1_000, true, 0)).toBe("Auto-sync is paused.");
		expect(formatNextSync(null, true, 0)).toBe("Auto-sync is paused.");
	});

	it("reports the interval as off when nextFireAt is null and not paused", () => {
		expect(formatNextSync(null, false, 0)).toBe(
			"Periodic auto-sync is off — only startup, foreground, and edit triggers apply."
		);
	});

	it("reports 'due now' once the estimate has passed", () => {
		expect(formatNextSync(1_000, false, 5_000)).toBe("Next automatic sync: due now.");
		expect(formatNextSync(5_000, false, 5_000)).toBe("Next automatic sync: due now.");
	});

	it("rounds to whole minutes, singular vs plural", () => {
		expect(formatNextSync(60_000, false, 0)).toBe("Next automatic sync: in 1 minute.");
		expect(formatNextSync(5 * 60_000, false, 0)).toBe("Next automatic sync: in 5 minutes.");
	});

	it("reports 'less than a minute' below the rounding threshold", () => {
		expect(formatNextSync(20_000, false, 0)).toBe("Next automatic sync: less than a minute.");
	});
});

describe("buildSyncPanelViewModel", () => {
	it("carries the status bar's headline/detail through unchanged", () => {
		const model = buildSyncPanelViewModel(
			event({ state: "error", message: "network unreachable" }),
			[],
			0,
			null,
			false,
			"ready"
		);
		expect(model.headline).toBe("✗ sync error");
		expect(model.detail).toBe("network unreachable");
	});

	it("flags syncing for every active-sync state", () => {
		for (const state of ["staging", "fetching", "integrating", "pushing"] as const) {
			const model = buildSyncPanelViewModel(event({ state }), [], 0, null, false, "ready");
			expect(model.syncing).toBe(true);
			expect(model.primaryAction).toBe("sync");
		}
	});

	it("routes to resolveConflict only in the conflict state, never alongside sync", () => {
		const conflicted = buildSyncPanelViewModel(
			event({ state: "conflict", message: "2 files" }),
			[],
			0,
			null,
			false,
			"ready"
		);
		expect(conflicted.primaryAction).toBe("resolveConflict");

		const idle = buildSyncPanelViewModel(event({ state: "idle" }), [], 0, null, false, "ready");
		expect(idle.primaryAction).toBe("sync");
	});

	it("routes to setup, overriding conflict/error/anything else, when unconfigured or incomplete", () => {
		for (const state of ["idle", "conflict", "error", "blocked", "locked"] as const) {
			const unconfigured = buildSyncPanelViewModel(event({ state }), [], 0, null, false, "unconfigured");
			expect(unconfigured.primaryAction).toBe("setup");
			expect(unconfigured.headline).toBe("⚙ set up Halyard Sync");
			expect(unconfigured.setupButtonText).toBe("Run setup wizard");

			const incomplete = buildSyncPanelViewModel(event({ state }), [], 0, null, false, "incomplete");
			expect(incomplete.primaryAction).toBe("setup");
			expect(incomplete.headline).toBe("⚙ finish setup");
			expect(incomplete.setupButtonText).toBe("Continue setup");
		}
	});

	it("orders recent history most-recent-first, capped at 5, and flags overflow", () => {
		const history: SyncHistoryEntry[] = Array.from({ length: 7 }, (_, i) => ({
			at: i * 1000,
			outcome: "synced",
			message: null,
		}));
		const model = buildSyncPanelViewModel(event({}), history, 10_000, null, false, "ready");
		expect(model.recentHistory).toHaveLength(5);
		expect(model.recentHistory[0].when).toContain(new Date(6000).toLocaleString());
		expect(model.hasMoreHistory).toBe(true);
	});

	it("does not flag overflow when history fits within the cap", () => {
		const history: SyncHistoryEntry[] = [
			{ at: 0, outcome: "synced", message: null },
			{ at: 1000, outcome: "error", message: "oops" },
		];
		const model = buildSyncPanelViewModel(event({}), history, 10_000, null, false, "ready");
		expect(model.recentHistory).toHaveLength(2);
		expect(model.hasMoreHistory).toBe(false);
		expect(model.recentHistory[0].label).toBe("✗ Error");
		expect(model.recentHistory[0].message).toBe("oops");
	});

	it("threads nextFireAt/isPaused through to nextSyncText", () => {
		const model = buildSyncPanelViewModel(event({}), [], 0, 60_000, false, "ready");
		expect(model.nextSyncText).toBe("Next automatic sync: in 1 minute.");

		const paused = buildSyncPanelViewModel(event({}), [], 0, 60_000, true, "ready");
		expect(paused.nextSyncText).toBe("Auto-sync is paused.");
	});
});
