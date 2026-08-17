import { describe, expect, it } from "vitest";
import { formatRelativeTime, statusBarClickTarget, statusBarView } from "../src/ui/statusbar";
import type { SyncStatusEvent } from "../src/sync/orchestrator";

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

describe("formatRelativeTime", () => {
	it("buckets into just now / minutes / hours / days", () => {
		const now = 10 * 24 * 60 * 60_000;
		expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
		expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3m ago");
		expect(formatRelativeTime(now - 2 * 60 * 60_000, now)).toBe("2h ago");
		expect(formatRelativeTime(now - 5 * 24 * 60 * 60_000, now)).toBe("5d ago");
		expect(formatRelativeTime(now + 60_000, now)).toBe("just now"); // clock skew
	});
});

describe("statusBarClickTarget", () => {
	it("routes conflict to 'conflict'", () => {
		expect(statusBarClickTarget("conflict")).toBe("conflict");
	});

	it("routes error/blocked/locked to 'detail' instead of a blind retry", () => {
		expect(statusBarClickTarget("error")).toBe("detail");
		expect(statusBarClickTarget("blocked")).toBe("detail");
		expect(statusBarClickTarget("locked")).toBe("detail");
	});

	it("routes idle and every active-sync state to 'sync'", () => {
		for (const state of ["idle", "staging", "fetching", "integrating", "pushing"] as const) {
			expect(statusBarClickTarget(state)).toBe("sync");
		}
	});

	it("routes to 'setup' regardless of state when unconfigured or incomplete", () => {
		for (const state of [
			"idle",
			"conflict",
			"error",
			"blocked",
			"locked",
			"staging",
		] as const) {
			expect(statusBarClickTarget(state, "unconfigured")).toBe("setup");
			expect(statusBarClickTarget(state, "incomplete")).toBe("setup");
		}
	});
});

describe("statusBarView", () => {
	it("shows the syncing glyph with the trigger reason during any active state", () => {
		for (const state of ["staging", "fetching", "integrating", "pushing"] as const) {
			const view = statusBarView(event({ state, reason: "interval" }), 0);
			expect(view.text).toBe("⟳ syncing");
			expect(view.tooltip).toContain("interval");
		}
	});

	it("shows the last sync time when idle", () => {
		const view = statusBarView(event({ lastSyncAt: 0 }), 3 * 60_000);
		expect(view.text).toBe("✓ 3m ago");
	});

	it("shows conflict and error states with their message as tooltip", () => {
		const conflict = statusBarView(
			event({ state: "conflict", message: "2 conflicting files" }),
			0
		);
		expect(conflict.text).toBe("⚠ conflict");
		expect(conflict.tooltip).toBe("2 conflicting files");

		const error = statusBarView(
			event({ state: "error", message: "network unreachable" }),
			0
		);
		expect(error.text).toBe("✗ sync error");
		expect(error.tooltip).toBe("network unreachable");
	});

	it("shows a blocked state with its message as tooltip", () => {
		const blocked = statusBarView(
			event({
				state: "blocked",
				message: "This repository declares a gitattributes content filter...",
			}),
			0
		);
		expect(blocked.text).toBe("🔒 sync blocked");
		expect(blocked.tooltip).toContain("gitattributes");
	});

	it("shows a locked state (git-crypt, no key configured) distinctly from blocked", () => {
		const locked = statusBarView(
			event({
				state: "locked",
				message: "This repository is encrypted with git-crypt...",
			}),
			0
		);
		expect(locked.text).toBe("🔑 key needed");
		expect(locked.text).not.toBe("🔒 sync blocked");
		expect(locked.tooltip).toContain("git-crypt");
	});

	it("shows a paused indicator instead of the idle view when auto-sync is paused", () => {
		const view = statusBarView(event({ lastSyncAt: 0 }), 3 * 60_000, true);
		expect(view.text).toBe("⏸ Auto-sync paused");
		expect(view.tooltip).toContain("paused");
	});

	it("lets an active sync, conflict, or error take priority over the paused indicator", () => {
		const syncing = statusBarView(event({ state: "staging" }), 0, true);
		expect(syncing.text).toBe("⟳ syncing");

		const conflict = statusBarView(
			event({ state: "conflict", message: "paused with local changes" }),
			0,
			true
		);
		expect(conflict.text).toBe("⚠ conflict");
		expect(conflict.tooltip).toBe("paused with local changes");

		const error = statusBarView(event({ state: "error", message: "oops" }), 0, true);
		expect(error.text).toBe("✗ sync error");
	});

	it("shows a setup prompt overriding everything, including conflict/error, when unconfigured", () => {
		for (const state of ["idle", "conflict", "error", "blocked", "locked", "staging"] as const) {
			const view = statusBarView(event({ state, message: "should be ignored" }), 0, false, "unconfigured");
			expect(view.text).toBe("⚙ set up Tether Sync");
			expect(view.tooltip).toContain("setup wizard");
		}
	});

	it("shows a distinct 'finish setup' prompt for the incomplete state", () => {
		const view = statusBarView(event({ state: "idle" }), 0, false, "incomplete");
		expect(view.text).toBe("⚙ finish setup");
		expect(view.tooltip).toContain("continue the wizard");
	});
});
