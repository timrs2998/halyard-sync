import { describe, expect, it } from "vitest";
import {
	defaultScheduleOptions,
	effectiveIntervalMinutes,
	SyncScheduler,
	type ScheduleOptions,
	type SchedulerDeps,
} from "../src/sync/scheduler";

/** Deterministic clock + timer fakes wired through the injectable deps. */
class FakeTimers {
	nowMs = 0;
	private nextId = 1;
	private timers = new Map<
		number,
		{ at: number; fn: () => void; every: number | null }
	>();

	setInterval = (fn: () => void, ms: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.nowMs + ms, fn, every: ms });
		return id;
	};
	setTimeout = (fn: () => void, ms: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.nowMs + ms, fn, every: null });
		return id;
	};
	clear = (id: number): void => {
		this.timers.delete(id);
	};

	advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			let nextId: number | null = null;
			let nextAt = Infinity;
			for (const [id, timer] of this.timers) {
				if (timer.at <= target && timer.at < nextAt) {
					nextAt = timer.at;
					nextId = id;
				}
			}
			if (nextId === null) break;
			const timer = this.timers.get(nextId)!;
			this.nowMs = timer.at;
			if (timer.every !== null) timer.at += timer.every;
			else this.timers.delete(nextId);
			timer.fn();
		}
		this.nowMs = target;
	}

	get pendingCount(): number {
		return this.timers.size;
	}
}

function makeScheduler(
	optionOverrides: Partial<ScheduleOptions> = {},
	lastSyncAt: number | null = null
) {
	const timers = new FakeTimers();
	const requests: string[] = [];
	const options: ScheduleOptions = {
		...defaultScheduleOptions(false),
		...optionOverrides,
	};
	const state = { lastSyncAt, options };
	const deps: SchedulerDeps = {
		requestSync: (reason) => requests.push(reason),
		getOptions: () => state.options,
		getLastSyncAt: () => state.lastSyncAt,
		now: () => timers.nowMs,
		setIntervalFn: timers.setInterval,
		clearIntervalFn: timers.clear,
		setTimeoutFn: timers.setTimeout,
		clearTimeoutFn: timers.clear,
	};
	return { scheduler: new SyncScheduler(deps), timers, requests, state };
}

describe("defaults", () => {
	it("desktop: startup on, foreground off, 5 min interval", () => {
		expect(defaultScheduleOptions(false)).toEqual({
			syncOnStartup: true,
			syncOnForeground: false,
			intervalMinutes: 5,
			debounceEditSeconds: 0,
			batterySaver: false,
		});
	});

	it("mobile: startup + foreground on, 30 min interval", () => {
		expect(defaultScheduleOptions(true)).toEqual({
			syncOnStartup: true,
			syncOnForeground: true,
			intervalMinutes: 30,
			debounceEditSeconds: 0,
			batterySaver: false,
		});
	});

	it("battery saver forces the interval off", () => {
		expect(
			effectiveIntervalMinutes({ ...defaultScheduleOptions(true), batterySaver: true })
		).toBe(0);
	});
});

describe("startup & interval", () => {
	it("start() syncs on startup and then on every interval tick", () => {
		const { scheduler, timers, requests } = makeScheduler({ intervalMinutes: 5 });
		scheduler.start();
		expect(requests).toEqual(["startup"]);
		timers.advance(5 * 60_000);
		timers.advance(5 * 60_000);
		expect(requests).toEqual(["startup", "interval", "interval"]);
	});

	it("start() without syncOnStartup falls back to catch-up when due", () => {
		// Last sync 11 minutes "before launch" with a 10-minute interval.
		const { scheduler, timers, requests } = makeScheduler(
			{ syncOnStartup: false, intervalMinutes: 10 },
			-11 * 60_000
		);
		timers.nowMs = 0;
		scheduler.start();
		expect(requests).toEqual(["catch-up"]);
	});

	it("start() without syncOnStartup stays quiet when the interval has not elapsed", () => {
		const { scheduler, requests } = makeScheduler(
			{ syncOnStartup: false, intervalMinutes: 10 },
			-5 * 60_000
		);
		scheduler.start();
		expect(requests).toEqual([]);
	});

	it("never-synced counts as catch-up due", () => {
		const { scheduler, requests } = makeScheduler(
			{ syncOnStartup: false, intervalMinutes: 10 },
			null
		);
		scheduler.start();
		expect(requests).toEqual(["catch-up"]);
	});

	it("battery saver registers no interval timer and disables catch-up", () => {
		const { scheduler, timers, requests } = makeScheduler(
			{ syncOnStartup: false, batterySaver: true, intervalMinutes: 5 },
			-60 * 60_000
		);
		scheduler.start();
		expect(timers.pendingCount).toBe(0);
		timers.advance(60 * 60_000);
		expect(requests).toEqual([]);
	});

	it("applyOptions() replaces the old interval timer", () => {
		// lastSyncAt "now" so no catch-up interferes.
		const harness = makeScheduler({ intervalMinutes: 5, syncOnStartup: false }, 0);
		harness.scheduler.start();
		harness.state.options = { ...harness.state.options, intervalMinutes: 30 };
		harness.scheduler.applyOptions();
		expect(harness.timers.pendingCount).toBe(1);
		harness.timers.advance(5 * 60_000);
		expect(harness.requests).toEqual([]);
		harness.timers.advance(25 * 60_000);
		expect(harness.requests).toEqual(["interval"]);
	});
});

describe("nextFireAt", () => {
	it("is null before start() and set to now + interval once started", () => {
		const { scheduler, timers } = makeScheduler({ intervalMinutes: 5, syncOnStartup: false }, 0);
		expect(scheduler.nextFireAt).toBeNull();
		scheduler.start();
		expect(scheduler.nextFireAt).toBe(timers.nowMs + 5 * 60_000);
	});

	it("advances by one interval on every tick", () => {
		const { scheduler, timers } = makeScheduler({ intervalMinutes: 5, syncOnStartup: false }, 0);
		scheduler.start();
		timers.advance(5 * 60_000);
		expect(scheduler.nextFireAt).toBe(timers.nowMs + 5 * 60_000);
		timers.advance(5 * 60_000);
		expect(scheduler.nextFireAt).toBe(timers.nowMs + 5 * 60_000);
	});

	it("is null when the interval is off (battery saver or intervalMinutes 0)", () => {
		const { scheduler: bySaver } = makeScheduler(
			{ batterySaver: true, intervalMinutes: 5, syncOnStartup: false },
			0
		);
		bySaver.start();
		expect(bySaver.nextFireAt).toBeNull();

		const { scheduler: byZero } = makeScheduler(
			{ intervalMinutes: 0, syncOnStartup: false },
			0
		);
		byZero.start();
		expect(byZero.nextFireAt).toBeNull();
	});

	it("is null while paused, and reflects the underlying interval again on resume", () => {
		const { scheduler, timers } = makeScheduler({ intervalMinutes: 5, syncOnStartup: false }, 0);
		scheduler.start();
		const expected = timers.nowMs + 5 * 60_000;
		scheduler.pause();
		expect(scheduler.nextFireAt).toBeNull();
		scheduler.resume();
		expect(scheduler.nextFireAt).toBe(expected);
	});

	it("is null after stop()", () => {
		const { scheduler } = makeScheduler({ intervalMinutes: 5, syncOnStartup: false }, 0);
		scheduler.start();
		scheduler.stop();
		expect(scheduler.nextFireAt).toBeNull();
	});
});

describe("visibility & catch-up", () => {
	it("triggers only on the hidden -> visible edge", () => {
		const { scheduler, requests } = makeScheduler({
			syncOnStartup: false,
			syncOnForeground: true,
		});
		scheduler.handleVisibilityChange(true); // visible -> visible: no edge
		expect(requests).toEqual([]);
		scheduler.handleVisibilityChange(false); // hide
		expect(requests).toEqual([]);
		scheduler.handleVisibilityChange(true); // hidden -> visible
		expect(requests).toEqual(["foreground"]);
	});

	it("foreground catch-up fires when syncOnForeground is off but overdue", () => {
		const { scheduler, timers, requests, state } = makeScheduler({
			syncOnStartup: false,
			syncOnForeground: false,
			intervalMinutes: 10,
		});
		state.lastSyncAt = 0;
		scheduler.handleVisibilityChange(false);
		timers.nowMs = 11 * 60_000; // app hidden past one interval
		scheduler.handleVisibilityChange(true);
		expect(requests).toEqual(["catch-up"]);
	});

	it("no foreground catch-up when within the interval", () => {
		const { scheduler, timers, requests, state } = makeScheduler({
			syncOnStartup: false,
			syncOnForeground: false,
			intervalMinutes: 10,
		});
		state.lastSyncAt = 0;
		scheduler.handleVisibilityChange(false);
		timers.nowMs = 9 * 60_000;
		scheduler.handleVisibilityChange(true);
		expect(requests).toEqual([]);
	});
});

describe("edit debounce", () => {
	it("collapses rapid edits into one trailing sync", () => {
		const { scheduler, timers, requests } = makeScheduler({
			debounceEditSeconds: 30,
		});
		scheduler.onFileModified();
		timers.advance(10_000);
		scheduler.onFileModified(); // resets the timer
		timers.advance(29_000);
		expect(requests).toEqual([]);
		timers.advance(1_000);
		expect(requests).toEqual(["edit"]);
	});

	it("does nothing when the debounce is off (0 seconds)", () => {
		const { scheduler, timers, requests } = makeScheduler({
			debounceEditSeconds: 0,
		});
		scheduler.onFileModified();
		timers.advance(120_000);
		expect(requests).toEqual([]);
	});
});

describe("pause", () => {
	it("suppresses every trigger while paused and resumes cleanly", () => {
		const { scheduler, timers, requests } = makeScheduler({
			intervalMinutes: 5,
			syncOnForeground: true,
			debounceEditSeconds: 10,
		});
		scheduler.start();
		expect(requests).toEqual(["startup"]);

		scheduler.pause();
		timers.advance(5 * 60_000); // interval tick swallowed
		scheduler.handleVisibilityChange(false);
		scheduler.handleVisibilityChange(true);
		scheduler.onFileModified();
		timers.advance(60_000);
		expect(requests).toEqual(["startup"]);

		scheduler.resume();
		timers.advance(5 * 60_000);
		expect(requests).toEqual(["startup", "interval"]);
	});

	it("pause cancels a pending debounce", () => {
		const { scheduler, timers, requests } = makeScheduler({
			debounceEditSeconds: 30,
		});
		scheduler.onFileModified();
		scheduler.pause();
		timers.advance(60_000);
		expect(requests).toEqual([]);
	});
});
