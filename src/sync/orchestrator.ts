/**
 * Sync orchestrator — a single-flight state machine.
 *
 * A sync never runs concurrently with another; a request that arrives while
 * one is running marks "run again after" (queued once, later requests
 * collapse into the same rerun). `requestSync` never throws: every failure
 * lands in the `error` state with the message preserved for the status bar.
 *
 * Dependencies (engine, conflict resolver, settings getters) are injected;
 * nothing here imports obsidian, so the decision table is unit-testable.
 */

import { describeGitCryptLocked, describeUnsupportedFilters } from "../git/engine";
import type { AheadBehind, ChangedFile, FilterCheckResult, MergeOutcome, RemoteRefInfo } from "../git/engine";
import type { ConflictResult, ConflictStrategyName } from "./conflicts";

/**
 * Friendly message for `sync()`'s checked-out-branch guard: real git usage
 * outside the plugin (a manual `git checkout` on the same repo) can leave
 * HEAD on a different branch than `settings.branch` — committing still
 * lands correctly on whatever's checked out (`GitEngine.stageAndCommit`
 * commits onto HEAD), but fetch/merge/push all target the CONFIGURED
 * branch name explicitly, so a mismatch here means the vault would commit
 * to one branch while syncing an unrelated one. Caught and paused rather
 * than letting that happen silently.
 */
export function describeBranchMismatch(currentBranch: string, expectedBranch: string): string {
	return (
		`This vault is checked out to '${currentBranch}', but Tether Sync is ` +
		`configured to sync '${expectedBranch}' — check out '${expectedBranch}' ` +
		"again (or update the branch in Settings) to resume."
	);
}

/**
 * Friendly message for `sync()`'s missing-upstream-branch guard: a branch
 * that was successfully fetched before (a remote-tracking ref exists) but
 * is no longer advertised by the remote at all has most likely been renamed
 * or deleted upstream (e.g. a repo's default branch renaming master -> main)
 * — falling through to a plain push in that case would silently create a
 * fresh, disconnected branch under the old name instead of surfacing this.
 */
export function describeMissingUpstreamBranch(branch: string): string {
	return (
		`'${branch}' no longer exists on the remote (renamed or deleted) — ` +
		"update the branch in Settings to the new name, or restore it upstream, to resume."
	);
}

export type SyncState =
	| "idle"
	| "staging"
	| "fetching"
	| "integrating"
	| "pushing"
	| "conflict"
	| "error"
	| "blocked"
	| "locked";

export interface SyncStatusEvent {
	state: SyncState;
	/** Why the current/last run started ("startup", "interval", ...). */
	reason: string | null;
	/** Error detail, conflict explanation, or resolution notice. */
	message: string | null;
	lastSyncAt: number | null;
	/** Files that conflicted, while in the conflict state. */
	conflictFiles: string[] | null;
	/** PR/MR created by the most recent conflict resolution. */
	prUrl: string | null;
}

export type SyncStatusListener = (event: SyncStatusEvent) => void;

export type SyncHistoryOutcome = "synced" | "error" | "conflict-resolved";

export interface SyncHistoryEntry {
	at: number;
	outcome: SyncHistoryOutcome;
	message: string | null;
}

/** Rolling history is capped, not paginated. */
export const MAX_SYNC_HISTORY_ENTRIES = 20;

/** Structural subset of GitEngine the orchestrator drives. */
export interface OrchestratorEngine {
	detectUnsupportedFilters(): Promise<FilterCheckResult>;
	/** Null on an unborn HEAD (no commit yet) — see `Libgit2Repository.currentBranch()`'s
	 * own doc comment. Used only for the checked-out-branch mismatch guard below. */
	currentBranch(): Promise<string | null>;
	getChangedFiles(): Promise<ChangedFile[]>;
	stageAndCommit(message: string): Promise<string | null>;
	listRemoteRef(branch: string): Promise<RemoteRefInfo | null>;
	remoteTrackingRef(branch: string): Promise<string | null>;
	localRef(branch: string): Promise<string | null>;
	fetch(branch?: string): Promise<unknown>;
	mergeUpstream(branch: string): Promise<MergeOutcome>;
	aheadBehind(branch: string): Promise<AheadBehind>;
	push(options?: { ref?: string; remoteRef?: string; force?: boolean }): Promise<unknown>;
}

export interface ConflictStrategyRunner {
	apply(strategy: ConflictStrategyName, files: string[]): Promise<ConflictResult>;
}

export interface OrchestratorOptions {
	engine: OrchestratorEngine;
	conflicts: ConflictStrategyRunner;
	branch: () => string;
	conflictStrategy: () => ConflictStrategyName;
	/** Embedded in commit messages, e.g. "desktop" / "mobile". */
	platform: string;
	/** Stops the scheduler when a sync hits something that won't fix itself on retry. */
	pauseAutoSync?: () => void;
	/**
	 * Serializes engine-touching work against other operations that share the
	 * same `.git` directory outside the orchestrator (setup wizard clone/init,
	 * Danger Zone re-clone/discard) — the orchestrator's own single-flight
	 * guard only protects sync-vs-sync. Defaults to running `fn` directly.
	 */
	runExclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
	now?: () => number;
	/** Persistence hook for lastSyncAt (scheduler catch-up reads it back). */
	onSyncComplete?: (at: number) => void | Promise<void>;
	/** Seeds `history` from persisted state (survives plugin reload). */
	initialHistory?: SyncHistoryEntry[];
	/** Fired after a new entry is appended to `history`, for persistence. */
	onHistoryEntry?: (history: readonly SyncHistoryEntry[]) => void | Promise<void>;
}

export class SyncOrchestrator {
	private state: SyncState = "idle";
	private reason: string | null = null;
	private message: string | null = null;
	private lastSyncAt: number | null = null;
	private conflictFiles: string[] | null = null;
	private prUrl: string | null = null;

	private running = false;
	private queuedReason: string | null = null;
	private readonly listeners = new Set<SyncStatusListener>();
	private readonly historyEntries: SyncHistoryEntry[];

	constructor(private readonly opts: OrchestratorOptions) {
		this.historyEntries = (opts.initialHistory ?? []).slice(-MAX_SYNC_HISTORY_ENTRIES);
	}

	/** Most-recent-last; capped at MAX_SYNC_HISTORY_ENTRIES. */
	get history(): readonly SyncHistoryEntry[] {
		return [...this.historyEntries];
	}

	get status(): SyncStatusEvent {
		return {
			state: this.state,
			reason: this.reason,
			message: this.message,
			lastSyncAt: this.lastSyncAt,
			conflictFiles: this.conflictFiles === null ? null : [...this.conflictFiles],
			prUrl: this.prUrl,
		};
	}

	get isRunning(): boolean {
		return this.running;
	}

	get isConflicted(): boolean {
		return this.state === "conflict";
	}

	/** Subscribe to status changes; returns an unsubscribe function. */
	on(listener: SyncStatusListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Request a sync. Returns immediately; the run happens asynchronously.
	 * Never throws.
	 */
	requestSync(reason: string): void {
		if (this.running) {
			this.queuedReason = reason;
			return;
		}
		void this.runLoop(reason);
	}

	/**
	 * Apply a strategy to the pending conflict (driven by the conflict
	 * modal). Returns the result, or null when there is nothing to resolve
	 * or a sync is mid-flight.
	 */
	async resolveConflict(strategy: ConflictStrategyName): Promise<ConflictResult | null> {
		if (this.running || this.state !== "conflict") return null;
		const files = this.conflictFiles ?? [];
		this.running = true;
		try {
			const result = await this.exclusive(() => this.opts.conflicts.apply(strategy, files));
			this.applyConflictResult(result);
			return result;
		} catch (err) {
			const message = errorMessage(err);
			this.setState("error", message);
			this.recordHistory("error", message, (this.opts.now ?? Date.now)());
			return null;
		} finally {
			this.running = false;
		}
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		return (this.opts.runExclusive ?? ((f) => f()))(fn);
	}

	private emit(): void {
		const snapshot = this.status;
		for (const listener of [...this.listeners]) {
			try {
				listener(snapshot);
			} catch {
				// A broken listener must not break the sync.
			}
		}
	}

	private setState(state: SyncState, message: string | null = null): void {
		this.state = state;
		this.message = message;
		this.emit();
	}

	private async runLoop(reason: string): Promise<void> {
		this.running = true;
		try {
			let next: string | null = reason;
			while (next !== null) {
				this.queuedReason = null;
				await this.runOnce(next);
				next = this.queuedReason;
			}
		} finally {
			this.running = false;
		}
	}

	private async runOnce(reason: string): Promise<void> {
		this.reason = reason;
		try {
			await this.exclusive(() => this.sync());
		} catch (err) {
			const message = errorMessage(err);
			this.setState("error", message);
			this.recordHistory("error", message, (this.opts.now ?? Date.now)());
		}
	}

	private async sync(): Promise<void> {
		const engine = this.opts.engine;
		const branch = this.opts.branch();
		const now = this.opts.now ?? Date.now;

		// Checked first, every run: a filter driver (git-crypt, LFS, ...) may
		// arrive via a merge from another device just as easily as at setup.
		const filterCheck = await engine.detectUnsupportedFilters();
		if (filterCheck.kind === "blocked") {
			this.opts.pauseAutoSync?.();
			const message = describeUnsupportedFilters(filterCheck.filters);
			this.setState("blocked", message);
			this.recordHistory("error", message, now());
			return;
		}
		if (filterCheck.kind === "locked") {
			// Recoverable (import the missing key(s)), unlike "blocked" — see
			// FilterCheckResult's doc comment. Still pauses auto-sync: nothing
			// should be committed/pushed unencrypted while a git-crypt path can't
			// be decrypted/encrypted correctly.
			this.opts.pauseAutoSync?.();
			const message = describeGitCryptLocked(filterCheck.missingKeyNames);
			this.setState("locked", message);
			this.recordHistory("error", message, now());
			return;
		}

		// Also checked before anything is staged: a manual `git checkout` on
		// this same repo (outside the plugin) leaves HEAD somewhere other
		// than the configured branch. Committing would still land correctly
		// (onto whatever's checked out), but fetch/merge/push below all
		// target `branch` explicitly — continuing would commit to one branch
		// while syncing an unrelated one. Null (unborn HEAD, no commit yet)
		// isn't a mismatch: there's nothing checked out to compare yet.
		const currentBranch = await engine.currentBranch();
		if (currentBranch !== null && currentBranch !== branch) {
			this.opts.pauseAutoSync?.();
			const message = describeBranchMismatch(currentBranch, branch);
			this.setState("blocked", message);
			this.recordHistory("error", message, now());
			return;
		}

		this.setState("staging");
		const commitMessage = `vault sync: ${new Date(now()).toISOString()} (${this.opts.platform})`;
		const committedOid = await engine.stageAndCommit(commitMessage);

		this.setState("fetching");
		const remoteInfo = await engine.listRemoteRef(branch);
		const tracking = await engine.remoteTrackingRef(branch);
		const local = await engine.localRef(branch);
		const remoteUnchanged = remoteInfo !== null && remoteInfo.oid === tracking;

		if (remoteInfo === null && tracking !== null) {
			// A remote-tracking ref exists locally (fetched successfully at
			// least once before), but the remote no longer advertises this
			// branch at all — renamed or deleted upstream, not "never pushed
			// yet" (that case has tracking === null too, but never had a
			// tracking ref to lose in the first place — see the fall-through
			// comment below).
			this.opts.pauseAutoSync?.();
			const message = describeMissingUpstreamBranch(branch);
			this.setState("blocked", message);
			this.recordHistory("error", message, now());
			return;
		}

		if (remoteUnchanged && committedOid === null && local === tracking) {
			// Clean tree, remote where we left it, nothing unpushed: the whole
			// no-op poll cost one listRemoteRef round trip.
			await this.finishIdle(now());
			return;
		}
		if (remoteInfo !== null && !remoteUnchanged) {
			await engine.fetch(branch);
		}
		// remoteInfo === null here means genuinely never pushed before (the
		// "previously tracked, now missing" case already returned above) —
		// nothing to fetch or merge; fall through to push.

		this.setState("integrating");
		// mergeUpstream is run even when the remote was unchanged: a previous
		// run may have fetched and then failed before integrating.
		const outcome: MergeOutcome =
			remoteInfo === null ? { kind: "uptodate" } : await engine.mergeUpstream(branch);
		if (outcome.kind === "conflict") {
			await this.handleConflict(outcome.files, now);
			return;
		}

		const relation = await engine.aheadBehind(branch);
		if (relation.state === "ahead" || relation.state === "diverged") {
			this.setState("pushing");
			await engine.push({ ref: branch });
		}
		await this.finishIdle(now());
	}

	private async handleConflict(files: string[], now: () => number): Promise<void> {
		this.conflictFiles = files;
		// Some merge failures carry no file list — don't claim a bogus
		// "(0 conflicting files)" count when that happens.
		const message =
			files.length === 0
				? "Local and remote changes diverged (the specific files could not be determined)."
				: `Local and remote changes diverged (${files.length} conflicting file${files.length === 1 ? "" : "s"}).`;
		this.setState("conflict", message);
		const strategy = this.opts.conflictStrategy();
		const result = await this.opts.conflicts.apply(strategy, files);
		this.applyConflictResult(result, now);
	}

	private applyConflictResult(
		result: ConflictResult,
		now: () => number = this.opts.now ?? Date.now
	): void {
		if (result.kind === "resolved") {
			this.conflictFiles = null;
			this.prUrl = result.prUrl ?? null;
			void this.finishIdle(now(), result.message, "conflict-resolved");
		} else {
			// keepLocal: remain conflicted; the strategy already paused auto-sync.
			this.setState("conflict", result.message);
		}
	}

	private async finishIdle(
		at: number,
		message: string | null = null,
		outcome: SyncHistoryOutcome = "synced"
	): Promise<void> {
		this.lastSyncAt = at;
		this.setState("idle", message);
		this.recordHistory(outcome, message, at);
		try {
			await this.opts.onSyncComplete?.(at);
		} catch {
			// Persistence failure must not fail the sync itself.
		}
	}

	/** Appends + caps the rolling history, then notifies the persistence hook. */
	private recordHistory(outcome: SyncHistoryOutcome, message: string | null, at: number): void {
		this.historyEntries.push({ at, outcome, message });
		if (this.historyEntries.length > MAX_SYNC_HISTORY_ENTRIES) {
			this.historyEntries.splice(0, this.historyEntries.length - MAX_SYNC_HISTORY_ENTRIES);
		}
		void this.opts.onHistoryEntry?.(this.history);
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
