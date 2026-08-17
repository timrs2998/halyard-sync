/**
 * Scheduling & power policy (see the DESIGN.md table).
 *
 * Mobile cannot run in the background, so the scheduler leans on catch-up:
 * `lastSyncAt` is persisted (by the orchestrator's completion hook) and a
 * sync fires on startup/foreground when more than one interval elapsed
 * while the app was closed. Timers are injected so the catch-up math and
 * debounce are unit-testable with fake clocks.
 */

export interface ScheduleOptions {
	syncOnStartup: boolean;
	/** Sync when the app returns to the foreground (mobile's main trigger). */
	syncOnForeground: boolean;
	/** Foreground poll interval; 0 = off. */
	intervalMinutes: number;
	/** Debounced sync after edits; 0 = off. */
	debounceEditSeconds: number;
	/** Forces the interval off; startup + foreground triggers only. */
	batterySaver: boolean;
}

export function defaultScheduleOptions(isMobile: boolean): ScheduleOptions {
	return {
		syncOnStartup: true,
		syncOnForeground: isMobile,
		intervalMinutes: isMobile ? 30 : 5,
		debounceEditSeconds: 0,
		batterySaver: false,
	};
}

export function effectiveIntervalMinutes(options: ScheduleOptions): number {
	return options.batterySaver ? 0 : Math.max(0, options.intervalMinutes);
}

export interface SchedulerDeps {
	requestSync: (reason: string) => void;
	getOptions: () => ScheduleOptions;
	/** Persisted by the orchestrator's onSyncComplete hook. */
	getLastSyncAt: () => number | null;
	now?: () => number;
	setIntervalFn?: (fn: () => void, ms: number) => number;
	clearIntervalFn?: (id: number) => void;
	setTimeoutFn?: (fn: () => void, ms: number) => number;
	clearTimeoutFn?: (id: number) => void;
	/** Obsidian's Plugin.registerInterval, for lifecycle cleanup. */
	registerInterval?: (id: number) => void;
}

export class SyncScheduler {
	private paused = false;
	private intervalId: number | null = null;
	private debounceId: number | null = null;
	/** Assume visible at startup; only a hidden->visible edge triggers. */
	private wasVisible = true;
	/** Wall-clock estimate of the next periodic-interval sync, recomputed on
	 * every `applyOptions()` call and every actual interval tick. Covers only
	 * the periodic interval, not startup/foreground/edit-debounce triggers —
	 * "next scheduled sync" in the UI means "next automatic check-in", not a
	 * guarantee nothing will sync before then. Not wall-clock-precise (a real
	 * `setInterval` can drift slightly); good enough for display, not a
	 * scheduling primitive. */
	private nextFireAtValue: number | null = null;

	constructor(private readonly deps: SchedulerDeps) {}

	get isPaused(): boolean {
		return this.paused;
	}

	/** Estimated time of the next periodic sync, or null when the interval is
	 * off (battery saver / intervalMinutes 0) or auto-sync is paused. */
	get nextFireAt(): number | null {
		return this.paused ? null : this.nextFireAtValue;
	}

	pause(): void {
		this.paused = true;
		this.cancelDebounce();
	}

	resume(): void {
		this.paused = false;
	}

	/** Call once when the plugin is ready to sync (repo exists, configured). */
	start(): void {
		this.applyOptions();
		if (this.paused) return;
		const options = this.deps.getOptions();
		if (options.syncOnStartup) {
			this.deps.requestSync("startup");
		} else if (this.isCatchUpDue()) {
			this.deps.requestSync("catch-up");
		}
	}

	/** Re-read options and rebuild the interval timer (call on settings change). */
	applyOptions(): void {
		const setIntervalFn =
			this.deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms) as unknown as number);
		const clearIntervalFn = this.deps.clearIntervalFn ?? ((id) => clearInterval(id));
		if (this.intervalId !== null) {
			clearIntervalFn(this.intervalId);
			this.intervalId = null;
		}
		const minutes = effectiveIntervalMinutes(this.deps.getOptions());
		if (minutes > 0) {
			const ms = minutes * 60_000;
			const now = this.deps.now ?? Date.now;
			this.nextFireAtValue = now() + ms;
			this.intervalId = setIntervalFn(() => {
				this.nextFireAtValue = now() + ms;
				if (!this.paused) this.deps.requestSync("interval");
			}, ms);
			this.deps.registerInterval?.(this.intervalId);
		} else {
			this.nextFireAtValue = null;
		}
	}

	stop(): void {
		const clearIntervalFn = this.deps.clearIntervalFn ?? ((id) => clearInterval(id));
		if (this.intervalId !== null) {
			clearIntervalFn(this.intervalId);
			this.intervalId = null;
		}
		this.nextFireAtValue = null;
		this.cancelDebounce();
	}

	/** Feed raw visibility state; reacts only to the hidden->visible edge. */
	handleVisibilityChange(visible: boolean): void {
		const was = this.wasVisible;
		this.wasVisible = visible;
		if (was || !visible) return;
		if (this.paused) return;
		const options = this.deps.getOptions();
		if (options.syncOnForeground) {
			this.deps.requestSync("foreground");
		} else if (this.isCatchUpDue()) {
			this.deps.requestSync("catch-up");
		}
	}

	/** Vault `modify` hook: debounced trailing-edge sync. */
	onFileModified(): void {
		if (this.paused) return;
		const seconds = this.deps.getOptions().debounceEditSeconds;
		if (seconds <= 0) return;
		const setTimeoutFn =
			this.deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
		this.cancelDebounce();
		this.debounceId = setTimeoutFn(() => {
			this.debounceId = null;
			if (!this.paused) this.deps.requestSync("edit");
		}, seconds * 1000);
	}

	/**
	 * True when more than one interval elapsed since the last completed sync
	 * (e.g. while the app was closed). Never-synced counts as due.
	 */
	isCatchUpDue(): boolean {
		const minutes = effectiveIntervalMinutes(this.deps.getOptions());
		if (minutes <= 0) return false;
		const last = this.deps.getLastSyncAt();
		if (last === null) return true;
		const now = (this.deps.now ?? Date.now)();
		return now - last > minutes * 60_000;
	}

	private cancelDebounce(): void {
		if (this.debounceId === null) return;
		const clearTimeoutFn = this.deps.clearTimeoutFn ?? ((id) => clearTimeout(id));
		clearTimeoutFn(this.debounceId);
		this.debounceId = null;
	}
}
