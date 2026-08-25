/**
 * Pure view-model for the sync sidebar panel (`sync-view.ts`'s `HalyardSyncView`
 * is a thin DOM renderer over this) — deliberately zero `obsidian` imports,
 * same reasoning as `statusbar.ts`'s header comment: the `obsidian` npm
 * package ships types only (no runtime JS), so anything importing it can't
 * be loaded under vitest. Keeping this split is what makes the panel's
 * formatting logic unit-testable at all.
 */

import type { SyncHistoryEntry, SyncStatusEvent } from "../sync/orchestrator";
import { HISTORY_OUTCOME_LABELS } from "./history-format";
import { formatRelativeTime, statusBarView, type SetupState } from "./statusbar";

const MAX_PANEL_HISTORY_ENTRIES = 5;

/**
 * Pure "next automatic sync" line. `nextFireAt` is the scheduler's estimate
 * (see `SyncScheduler.nextFireAt`'s own doc comment on precision/scope —
 * periodic interval only, not startup/foreground/edit triggers).
 */
export function formatNextSync(nextFireAt: number | null, isPaused: boolean, now: number): string {
	if (isPaused) return "Auto-sync is paused.";
	if (nextFireAt === null) {
		return "Periodic auto-sync is off — only startup, foreground, and edit triggers apply.";
	}
	const diffMs = nextFireAt - now;
	if (diffMs <= 0) return "Next automatic sync: due now.";
	const minutes = Math.round(diffMs / 60_000);
	if (minutes < 1) return "Next automatic sync: less than a minute.";
	return `Next automatic sync: in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export interface SyncPanelHistoryRow {
	label: string;
	when: string;
	message: string | null;
}

export interface SyncPanelViewModel {
	headline: string;
	detail: string;
	syncing: boolean;
	/** Mirrors the ribbon's left-click convention: conflicted state offers
	 * ONLY conflict resolution, an incomplete setup offers ONLY the wizard —
	 * neither ever shows alongside "sync now" — see `main.ts`'s
	 * `setupRibbonIcon`. */
	primaryAction: "sync" | "resolveConflict" | "setup";
	/** Only meaningful when `primaryAction` is "setup" — distinguishes
	 * "never started" from "started but never finished" wording. */
	setupButtonText: "Run setup wizard" | "Continue setup";
	nextSyncText: string;
	recentHistory: SyncPanelHistoryRow[];
	hasMoreHistory: boolean;
}

export function buildSyncPanelViewModel(
	event: SyncStatusEvent,
	history: readonly SyncHistoryEntry[],
	now: number,
	nextFireAt: number | null,
	isPaused: boolean,
	setupState: SetupState
): SyncPanelViewModel {
	const view = statusBarView(event, now, isPaused, setupState);
	const syncing =
		event.state === "staging" ||
		event.state === "fetching" ||
		event.state === "integrating" ||
		event.state === "pushing";
	const ordered = [...history].reverse();
	const primaryAction =
		setupState !== "ready" ? "setup" : event.state === "conflict" ? "resolveConflict" : "sync";
	return {
		headline: view.text,
		detail: view.tooltip,
		syncing,
		primaryAction,
		setupButtonText: setupState === "incomplete" ? "Continue setup" : "Run setup wizard",
		nextSyncText: formatNextSync(nextFireAt, isPaused, now),
		recentHistory: ordered.slice(0, MAX_PANEL_HISTORY_ENTRIES).map((entry) => ({
			label: HISTORY_OUTCOME_LABELS[entry.outcome],
			when: `${new Date(entry.at).toLocaleString()} (${formatRelativeTime(entry.at, now)})`,
			message: entry.message,
		})),
		hasMoreHistory: ordered.length > MAX_PANEL_HISTORY_ENTRIES,
	};
}
