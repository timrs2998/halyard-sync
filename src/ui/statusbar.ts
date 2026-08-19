/**
 * Status bar item driven by orchestrator events.
 *
 * Uses plain DOM (no obsidian imports) so the formatting logic is
 * unit-testable. Everything is wrapped in try/catch: some layouts —
 * notably certain mobile configurations — may detach or hide the status
 * bar element, and rendering must never break the sync pipeline.
 */

import type { SyncOrchestrator, SyncState, SyncStatusEvent } from "../sync/orchestrator";

export function formatRelativeTime(at: number, now: number): string {
	const diff = Math.max(0, now - at);
	if (diff < 60_000) return "just now";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

export interface StatusBarView {
	text: string;
	tooltip: string;
}

/**
 * "unconfigured": step 1 of the wizard has never saved a remote URL.
 * "incomplete": a remote URL is saved but no repo exists yet — the wizard
 * was opened and abandoned somewhere in steps 2-3 (or is still open right
 * now). "ready": a repo exists and syncing can actually do something.
 * See `main.ts`'s `setupState()` for how this gets computed.
 */
export type SetupState = "unconfigured" | "incomplete" | "ready";

/**
 * `setupState` overrides EVERYTHING else, including `isPaused` — showing
 * "sync error"/"click to sync now" before there's even a repo to sync is
 * actively misleading. `isPaused` otherwise only overrides the idle/default
 * display: an active sync, conflict, or error is always more specific and
 * useful than "paused" (a manual sync can still run while auto-sync is
 * paused, and the conflict state already explains a keep-local pause via
 * its own message).
 */
export function statusBarView(
	event: SyncStatusEvent,
	now: number,
	isPaused = false,
	setupState: SetupState = "ready"
): StatusBarView {
	if (setupState === "unconfigured") {
		return {
			text: "⚙ set up Tether Sync",
			tooltip: "Not set up yet — click to run the setup wizard.",
		};
	}
	if (setupState === "incomplete") {
		return {
			text: "⚙ finish setup",
			tooltip: "Setup isn't finished yet — click to continue the wizard.",
		};
	}
	switch (event.state) {
		case "staging":
		case "fetching":
		case "integrating":
		case "pushing":
			return {
				text: "⟳ syncing",
				tooltip: event.reason !== null ? `Syncing (${event.reason})…` : "Syncing…",
			};
		case "conflict":
			return {
				text: "⚠ conflict",
				tooltip: event.message ?? "Sync conflict — click to resolve",
			};
		case "blocked":
			return {
				text: "🔒 sync blocked",
				tooltip: event.message ?? "Sync blocked — this repository can't be synced safely",
			};
		case "locked":
			return {
				text: "🔑 key needed",
				tooltip:
					event.message ??
					"This repository is encrypted with git-crypt — import its key in settings to unlock syncing",
			};
		case "error":
			return {
				text: "✗ sync error",
				tooltip: event.message ?? "Sync failed — click to retry",
			};
		case "idle":
			if (isPaused) {
				return {
					text: "⏸ Auto-sync paused",
					tooltip:
						"Automatic syncing is paused — manual sync via the command " +
						"palette or by clicking here still works.",
				};
			}
			return {
				text:
					event.lastSyncAt !== null
						? `✓ ${formatRelativeTime(event.lastSyncAt, now)}`
						: "✓ vault sync",
				tooltip:
					event.message ??
					(event.lastSyncAt !== null
						? `Synced ${formatRelativeTime(event.lastSyncAt, now)} — click to sync now`
						: "Click to sync now"),
			};
		default: {
			// Exhaustiveness guard: a new SyncState variant that isn't handled
			// above fails to compile here instead of silently rendering as idle.
			const unhandled: never = event.state;
			throw new Error(`statusBarView: unhandled sync state '${String(unhandled)}'`);
		}
	}
}

export type StatusBarClickTarget = "sync" | "conflict" | "detail" | "setup";

/**
 * Which handler a status-bar click should route to. `setupState` is checked
 * first and overrides the state entirely — same reasoning as
 * `statusBarView`'s own `setupState` override just above ("unconfigured"
 * and "incomplete" both route to "setup": reopening the wizard is the right
 * action either way, it just resumes further along for "incomplete").
 * Otherwise, error/blocked/locked route to "detail" (open the sync panel)
 * rather than blindly retrying like idle/syncing do — the failure reason is
 * a full sentence that doesn't fit in a glance at a hover tooltip, and a raw
 * click used to silently re-trigger the same failing sync with no way to
 * read why.
 */
export function statusBarClickTarget(
	state: SyncState,
	setupState: SetupState = "ready"
): StatusBarClickTarget {
	if (setupState !== "ready") return "setup";
	if (state === "conflict") return "conflict";
	if (state === "error" || state === "blocked" || state === "locked") return "detail";
	return "sync";
}

export interface StatusBarHandlers {
	/** Click while idle or actively syncing. */
	onSyncClick: () => void;
	/** Click while conflicted. */
	onConflictClick: () => void;
	/** Click while in error/blocked/locked — surface detail instead of retrying blind. */
	onDetailClick: () => void;
	/** Click before the setup wizard has ever been completed. */
	onSetupClick: () => void;
}

export class StatusBarController {
	private lastEvent: SyncStatusEvent;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly el: HTMLElement,
		orchestrator: SyncOrchestrator,
		private readonly handlers: StatusBarHandlers,
		/** Reads the live `autoSyncPaused` setting (same DI pattern as scheduler/orchestrator getters). */
		private readonly isPaused: () => boolean = () => false,
		/** Reads `plugin.setupState()` — same DI pattern. Synchronous by
		 * design (see that method's doc comment on the cache backing it). */
		private readonly getSetupState: () => SetupState = () => "ready",
		private readonly now: () => number = Date.now
	) {
		this.lastEvent = orchestrator.status;
		try {
			el.classList.add("mod-clickable");
			el.addEventListener("click", () => {
				switch (statusBarClickTarget(this.lastEvent.state, this.getSetupState())) {
					case "setup":
						this.handlers.onSetupClick();
						break;
					case "conflict":
						this.handlers.onConflictClick();
						break;
					case "detail":
						this.handlers.onDetailClick();
						break;
					case "sync":
						this.handlers.onSyncClick();
						break;
				}
			});
		} catch {
			// Status bar element unavailable in this layout.
		}
		this.unsubscribe = orchestrator.on((event) => {
			this.lastEvent = event;
			this.render();
		});
		this.render();
	}

	/** Re-render (keeps the relative last-sync time fresh). */
	refresh(): void {
		this.render();
	}

	dispose(): void {
		this.unsubscribe();
	}

	private render(): void {
		try {
			const view = statusBarView(this.lastEvent, this.now(), this.isPaused(), this.getSetupState());
			this.el.textContent = view.text;
			this.el.setAttribute("aria-label", view.tooltip);
		} catch {
			// Never let a status render failure surface.
		}
	}
}
