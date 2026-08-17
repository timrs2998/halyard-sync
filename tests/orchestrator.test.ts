import { describe, expect, it } from "vitest";
import type { AheadBehind, FilterCheckResult, MergeOutcome } from "../src/git/engine";
import { AsyncLock } from "../src/sync/async-lock";
import type { ConflictResult, ConflictStrategyName } from "../src/sync/conflicts";
import {
	describeBranchMismatch,
	describeMissingUpstreamBranch,
	MAX_SYNC_HISTORY_ENTRIES,
	SyncOrchestrator,
	type OrchestratorEngine,
	type SyncHistoryEntry,
	type SyncStatusEvent,
} from "../src/sync/orchestrator";

describe("describeBranchMismatch", () => {
	it("names both the checked-out and configured branch", () => {
		const message = describeBranchMismatch("feature-x", "main");
		expect(message).toContain("feature-x");
		expect(message).toContain("main");
	});
});

describe("describeMissingUpstreamBranch", () => {
	it("names the branch", () => {
		expect(describeMissingUpstreamBranch("master")).toContain("master");
	});
});

interface MockScenario {
	commitOid?: string | null;
	remoteOid?: string | null; // null = branch missing on server
	trackingOid?: string | null;
	localOid?: string | null;
	merge?: MergeOutcome;
	aheadBehind?: AheadBehind;
	failFetch?: boolean;
	filterCheck?: FilterCheckResult;
	/** Defaults to "main" — matches every existing test's `branch: () => "main"`,
	 * so only tests that care about a mismatch need to override it. */
	currentBranch?: string | null;
}

function makeEngine(scenario: MockScenario) {
	const calls: string[] = [];
	const engine: OrchestratorEngine = {
		detectUnsupportedFilters: async () => {
			calls.push("detectUnsupportedFilters");
			return scenario.filterCheck ?? { kind: "ok" };
		},
		currentBranch: async () => {
			calls.push("currentBranch");
			return scenario.currentBranch === undefined ? "main" : scenario.currentBranch;
		},
		getChangedFiles: async () => {
			calls.push("getChangedFiles");
			return [];
		},
		stageAndCommit: async () => {
			calls.push("stageAndCommit");
			return scenario.commitOid ?? null;
		},
		listRemoteRef: async (branch) => {
			calls.push("listRemoteRef");
			const oid = scenario.remoteOid ?? null;
			return oid === null ? null : { ref: `refs/heads/${branch}`, oid };
		},
		remoteTrackingRef: async () => {
			calls.push("remoteTrackingRef");
			return scenario.trackingOid ?? null;
		},
		localRef: async () => {
			calls.push("localRef");
			return scenario.localOid ?? null;
		},
		fetch: async () => {
			calls.push("fetch");
			if (scenario.failFetch === true) throw new Error("network unreachable");
			return {};
		},
		mergeUpstream: async () => {
			calls.push("mergeUpstream");
			return scenario.merge ?? { kind: "uptodate" };
		},
		aheadBehind: async () => {
			calls.push("aheadBehind");
			return (
				scenario.aheadBehind ?? {
					state: "uptodate",
					ahead: 0,
					behind: 0,
					approximate: false,
				}
			);
		},
		push: async () => {
			calls.push("push");
			return {};
		},
	};
	return { calls, engine };
}

function makeConflicts(result: ConflictResult) {
	const applied: Array<{ strategy: ConflictStrategyName; files: string[] }> = [];
	return {
		applied,
		runner: {
			apply: async (strategy: ConflictStrategyName, files: string[]) => {
				applied.push({ strategy, files });
				return result;
			},
		},
	};
}

function makeOrchestrator(
	scenario: MockScenario,
	options?: {
		conflictResult?: ConflictResult;
		strategy?: ConflictStrategyName;
		now?: () => number;
		initialHistory?: SyncHistoryEntry[];
		onHistoryEntry?: (history: readonly SyncHistoryEntry[]) => void;
	}
) {
	const { calls, engine } = makeEngine(scenario);
	const conflicts = makeConflicts(
		options?.conflictResult ?? { kind: "manual", message: "paused" }
	);
	const events: SyncStatusEvent[] = [];
	let pauseAutoSyncCalls = 0;
	const orchestrator = new SyncOrchestrator({
		engine,
		conflicts: conflicts.runner,
		branch: () => "main",
		conflictStrategy: () => options?.strategy ?? "prBranch",
		platform: "test",
		pauseAutoSync: () => {
			pauseAutoSyncCalls += 1;
		},
		now: options?.now ?? (() => 1_700_000_000_000),
		initialHistory: options?.initialHistory,
		onHistoryEntry: options?.onHistoryEntry,
	});
	orchestrator.on((event) => events.push(event));
	return { calls, conflicts, events, orchestrator, pauseAutoSyncCalls: () => pauseAutoSyncCalls };
}

/** requestSync is fire-and-forget; wait for the run loop to drain. */
async function drain(orchestrator: SyncOrchestrator): Promise<void> {
	while (orchestrator.isRunning) {
		await new Promise((r) => setTimeout(r, 0));
	}
	await new Promise((r) => setTimeout(r, 0));
}

describe("SyncOrchestrator decision table", () => {
	it("clean tree + unchanged remote -> skips fetch, merge, and push", async () => {
		const { calls, orchestrator } = makeOrchestrator({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("idle");
		expect(orchestrator.status.lastSyncAt).toBe(1_700_000_000_000);
		expect(calls).not.toContain("fetch");
		expect(calls).not.toContain("mergeUpstream");
		expect(calls).not.toContain("push");
	});

	it("local commit + unchanged remote -> merges (uptodate) and pushes", async () => {
		const { calls, orchestrator } = makeOrchestrator({
			commitOid: "bbb",
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "bbb",
			merge: { kind: "uptodate" },
			aheadBehind: { state: "ahead", ahead: 1, behind: 0, approximate: false },
		});
		orchestrator.requestSync("edit");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("idle");
		expect(calls).not.toContain("fetch"); // cheap ref check skipped it
		expect(calls).toContain("push");
	});

	it("remote moved + fast-forwardable -> fetch, ff, no push", async () => {
		const { calls, orchestrator } = makeOrchestrator({
			commitOid: null,
			remoteOid: "ccc",
			trackingOid: "aaa",
			localOid: "aaa",
			merge: { kind: "fastforward", oid: "ccc" },
			aheadBehind: { state: "uptodate", ahead: 0, behind: 0, approximate: false },
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("idle");
		expect(calls).toContain("fetch");
		expect(calls).toContain("mergeUpstream");
		expect(calls).not.toContain("push");
	});

	it("branch missing on the remote -> no fetch/merge, pushes when ahead", async () => {
		const { calls, orchestrator } = makeOrchestrator({
			commitOid: "bbb",
			remoteOid: null,
			trackingOid: null,
			localOid: "bbb",
			aheadBehind: { state: "ahead", ahead: null, behind: 0, approximate: true },
		});
		orchestrator.requestSync("manual");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("idle");
		expect(calls).not.toContain("fetch");
		expect(calls).not.toContain("mergeUpstream");
		expect(calls).toContain("push");
	});

	it("checked-out branch differs from the configured branch -> blocked, pauses, never commits/fetches/pushes", async () => {
		const { calls, orchestrator, pauseAutoSyncCalls } = makeOrchestrator({
			currentBranch: "feature-x",
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("blocked");
		expect(orchestrator.status.message).toContain("feature-x");
		expect(orchestrator.status.message).toContain("main");
		expect(pauseAutoSyncCalls()).toBe(1);
		expect(calls).not.toContain("stageAndCommit");
		expect(calls).not.toContain("listRemoteRef");
		expect(calls).not.toContain("fetch");
		expect(calls).not.toContain("push");
	});

	it("unborn HEAD (null currentBranch) is not treated as a mismatch", async () => {
		const { orchestrator } = makeOrchestrator({
			currentBranch: null,
			commitOid: "bbb",
			remoteOid: null,
			trackingOid: null,
			localOid: "bbb",
			aheadBehind: { state: "ahead", ahead: null, behind: 0, approximate: true },
		});
		orchestrator.requestSync("manual");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("idle");
	});

	it("branch previously tracked but no longer on the remote -> blocked instead of pushing a fresh disconnected branch", async () => {
		const { calls, orchestrator, pauseAutoSyncCalls } = makeOrchestrator({
			commitOid: "bbb",
			remoteOid: null, // gone from the remote now
			trackingOid: "aaa", // but we DID fetch it successfully before
			localOid: "bbb",
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("blocked");
		expect(orchestrator.status.message).toContain("main");
		expect(pauseAutoSyncCalls()).toBe(1);
		expect(calls).not.toContain("fetch");
		expect(calls).not.toContain("mergeUpstream");
		expect(calls).not.toContain("push");
	});

	it("diverged -> invokes the configured conflict strategy with the files", async () => {
		const { conflicts, orchestrator } = makeOrchestrator(
			{
				commitOid: "bbb",
				remoteOid: "ccc",
				trackingOid: "aaa",
				localOid: "bbb",
				merge: { kind: "conflict", files: ["notes/a.md", "notes/b.md"] },
			},
			{
				strategy: "prBranch",
				conflictResult: {
					kind: "resolved",
					message: "pushed to branch",
					prUrl: "https://example.com/pr/1",
				},
			}
		);
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(conflicts.applied).toEqual([
			{ strategy: "prBranch", files: ["notes/a.md", "notes/b.md"] },
		]);
		// Automatic resolution -> back to idle, PR URL surfaced.
		expect(orchestrator.status.state).toBe("idle");
		expect(orchestrator.status.prUrl).toBe("https://example.com/pr/1");
		expect(orchestrator.status.conflictFiles).toBeNull();
	});

	it("diverged with no file list (MergeNotSupportedError) reports an honest message", async () => {
		// Emitted by mergeUpstream when isomorphic-git's MergeNotSupportedError
		// can't enumerate files — must not claim "(0 conflicting files)".
		const { conflicts, events, orchestrator } = makeOrchestrator(
			{
				commitOid: "bbb",
				remoteOid: "ccc",
				trackingOid: "aaa",
				localOid: "bbb",
				merge: { kind: "conflict", files: [] },
			},
			{
				strategy: "keepLocal",
				conflictResult: { kind: "manual", message: "auto-sync paused" },
			}
		);
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(conflicts.applied).toEqual([{ strategy: "keepLocal", files: [] }]);
		const conflictEvent = events.find((e) => e.state === "conflict");
		expect(conflictEvent?.message).toBe(
			"Local and remote changes diverged (the specific files could not be determined)."
		);
	});

	it("keepLocal strategy leaves the orchestrator in the conflict state", async () => {
		const { orchestrator } = makeOrchestrator(
			{
				commitOid: "bbb",
				remoteOid: "ccc",
				trackingOid: "aaa",
				localOid: "bbb",
				merge: { kind: "conflict", files: ["x.md"] },
			},
			{
				strategy: "keepLocal",
				conflictResult: { kind: "manual", message: "auto-sync paused" },
			}
		);
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("conflict");
		expect(orchestrator.isConflicted).toBe(true);
		expect(orchestrator.status.conflictFiles).toEqual(["x.md"]);
		expect(orchestrator.status.message).toBe("auto-sync paused");
	});

	it("captures engine errors in the error state without throwing", async () => {
		const { orchestrator } = makeOrchestrator({
			commitOid: null,
			remoteOid: "ccc",
			trackingOid: "aaa",
			localOid: "aaa",
			failFetch: true,
		});
		expect(() => orchestrator.requestSync("interval")).not.toThrow();
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("error");
		expect(orchestrator.status.message).toBe("network unreachable");
	});

	it("recovers out of the error state: a later successful sync returns to idle", async () => {
		// The orchestrator holds no "stuck" bit once it hits error — requestSync
		// always attempts a fresh run. This is the mirror image of the previous
		// test: same engine mock, but failFetch flips off before the retry, the
		// same way a real transient network blip would resolve itself.
		const scenario: MockScenario = {
			commitOid: null,
			remoteOid: "ccc",
			trackingOid: "aaa",
			localOid: "aaa",
			failFetch: true,
		};
		const { orchestrator } = makeOrchestrator(scenario);
		orchestrator.requestSync("interval");
		await drain(orchestrator);
		expect(orchestrator.status.state).toBe("error");

		scenario.failFetch = false;
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("idle");
		expect(orchestrator.status.message).toBeNull();
		expect(orchestrator.history.map((h) => h.outcome)).toEqual(["error", "synced"]);
	});

	it("an unsupported gitattributes filter blocks the sync, pauses auto-sync, and never stages/pushes", async () => {
		const { calls, orchestrator, pauseAutoSyncCalls } = makeOrchestrator({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
			filterCheck: { kind: "blocked", filters: ["git-crypt"] },
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("blocked");
		expect(orchestrator.status.message).toContain("git-crypt");
		expect(orchestrator.status.message).toContain("cannot run");
		expect(pauseAutoSyncCalls()).toBe(1);
		expect(calls).not.toContain("stageAndCommit");
		expect(calls).not.toContain("push");
	});

	it("records a blocked sync as an 'error' history entry", async () => {
		const { orchestrator } = makeOrchestrator({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
			filterCheck: { kind: "blocked", filters: ["lfs"] },
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.history).toHaveLength(1);
		expect(orchestrator.history[0]?.outcome).toBe("error");
		expect(orchestrator.history[0]?.message).toContain("lfs");
	});

	it("a git-crypt repo with no configured key locks the sync (distinct from blocked), pauses auto-sync, and never stages/pushes", async () => {
		const { calls, orchestrator, pauseAutoSyncCalls } = makeOrchestrator({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
			filterCheck: { kind: "locked", missingKeyNames: [""], presentKeyNames: [] },
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("locked");
		expect(orchestrator.status.message).toContain("git-crypt");
		expect(orchestrator.status.message).toContain("Import");
		expect(pauseAutoSyncCalls()).toBe(1);
		expect(calls).not.toContain("stageAndCommit");
		expect(calls).not.toContain("push");
	});

	it("names the specific missing key(s) in the locked message, not just a generic notice", async () => {
		const { orchestrator } = makeOrchestrator({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
			filterCheck: {
				kind: "locked",
				missingKeyNames: ["finance", "personal"],
				presentKeyNames: [""],
			},
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("locked");
		expect(orchestrator.status.message).toContain("finance");
		expect(orchestrator.status.message).toContain("personal");
	});

	it("records a locked sync as an 'error' history entry", async () => {
		const { orchestrator } = makeOrchestrator({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
			filterCheck: { kind: "locked", missingKeyNames: [""], presentKeyNames: [] },
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.history).toHaveLength(1);
		expect(orchestrator.history[0]?.outcome).toBe("error");
		expect(orchestrator.history[0]?.message).toContain("git-crypt");
	});
});

describe("SyncOrchestrator single-flight semantics", () => {
	it("queues at most one rerun for requests arriving mid-sync", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		let commits = 0;
		const base = makeEngine({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
		});
		const engine: OrchestratorEngine = {
			...base.engine,
			stageAndCommit: async () => {
				commits += 1;
				if (commits === 1) await gate;
				return null;
			},
		};
		const orchestrator = new SyncOrchestrator({
			engine,
			conflicts: { apply: async () => ({ kind: "manual", message: "" }) },
			branch: () => "main",
			conflictStrategy: () => "prBranch",
			platform: "test",
		});

		orchestrator.requestSync("first");
		// Three more while the first is blocked -> exactly one rerun.
		orchestrator.requestSync("second");
		orchestrator.requestSync("third");
		orchestrator.requestSync("fourth");
		release();
		await drain(orchestrator);

		expect(commits).toBe(2);
		expect(orchestrator.status.state).toBe("idle");
	});

	it("emits progress states to listeners in order", async () => {
		const { events, orchestrator } = makeOrchestrator({
			commitOid: "bbb",
			remoteOid: "ccc",
			trackingOid: "aaa",
			localOid: "bbb",
			merge: { kind: "merged", oid: "ddd" },
			aheadBehind: { state: "ahead", ahead: 2, behind: 0, approximate: false },
		});
		orchestrator.requestSync("manual");
		await drain(orchestrator);

		expect(events.map((e) => e.state)).toEqual([
			"staging",
			"fetching",
			"integrating",
			"pushing",
			"idle",
		]);
		expect(events[events.length - 1]?.reason).toBe("manual");
	});

	it("resolveConflict applies the chosen strategy and returns to idle", async () => {
		const { conflicts, orchestrator } = makeOrchestrator(
			{
				commitOid: "bbb",
				remoteOid: "ccc",
				trackingOid: "aaa",
				localOid: "bbb",
				merge: { kind: "conflict", files: ["x.md"] },
			},
			{
				strategy: "keepLocal",
				conflictResult: { kind: "manual", message: "paused" },
			}
		);
		orchestrator.requestSync("interval");
		await drain(orchestrator);
		expect(orchestrator.status.state).toBe("conflict");

		// The modal later applies discardLocal; swap the runner's answer.
		conflicts.runner.apply = async (strategy, files) => {
			conflicts.applied.push({ strategy, files });
			return { kind: "resolved", message: "discarded" };
		};
		const result = await orchestrator.resolveConflict("discardLocal");
		expect(result?.kind).toBe("resolved");
		expect(conflicts.applied[conflicts.applied.length - 1]).toEqual({
			strategy: "discardLocal",
			files: ["x.md"],
		});
		expect(orchestrator.status.state).toBe("idle");
		expect(orchestrator.status.conflictFiles).toBeNull();
	});

	it("resolveConflict is a no-op outside the conflict state", async () => {
		const { orchestrator } = makeOrchestrator({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
		});
		await expect(orchestrator.resolveConflict("discardLocal")).resolves.toBeNull();
	});
});

describe("SyncOrchestrator history recording", () => {
	const cleanScenario: MockScenario = {
		commitOid: null,
		remoteOid: "aaa",
		trackingOid: "aaa",
		localOid: "aaa",
	};

	it("records a 'synced' entry on a successful sync, including the no-op skip path", async () => {
		const { orchestrator } = makeOrchestrator(cleanScenario);
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.history).toEqual([
			{ at: 1_700_000_000_000, outcome: "synced", message: null },
		]);
	});

	it("records an 'error' entry (with the failure message) when a sync throws", async () => {
		const { orchestrator } = makeOrchestrator({
			commitOid: null,
			remoteOid: "ccc",
			trackingOid: "aaa",
			localOid: "aaa",
			failFetch: true,
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.history).toEqual([
			{ at: 1_700_000_000_000, outcome: "error", message: "network unreachable" },
		]);
	});

	it("records an 'error' entry when resolveConflict's strategy throws", async () => {
		const { conflicts, orchestrator } = makeOrchestrator(
			{
				commitOid: "bbb",
				remoteOid: "ccc",
				trackingOid: "aaa",
				localOid: "bbb",
				merge: { kind: "conflict", files: ["x.md"] },
			},
			{ strategy: "keepLocal", conflictResult: { kind: "manual", message: "paused" } }
		);
		orchestrator.requestSync("interval");
		await drain(orchestrator);
		expect(orchestrator.status.state).toBe("conflict");

		conflicts.runner.apply = async () => {
			throw new Error("token revoked");
		};
		const result = await orchestrator.resolveConflict("discardLocal");

		expect(result).toBeNull();
		expect(orchestrator.status.state).toBe("error");
		const history = orchestrator.history;
		expect(history[history.length - 1]).toEqual({
			at: 1_700_000_000_000,
			outcome: "error",
			message: "token revoked",
		});
	});

	it("records a 'conflict-resolved' entry when the conflict strategy auto-resolves", async () => {
		const { orchestrator } = makeOrchestrator(
			{
				commitOid: "bbb",
				remoteOid: "ccc",
				trackingOid: "aaa",
				localOid: "bbb",
				merge: { kind: "conflict", files: ["notes/a.md"] },
			},
			{
				strategy: "prBranch",
				conflictResult: { kind: "resolved", message: "pushed to branch" },
			}
		);
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.history).toEqual([
			{ at: 1_700_000_000_000, outcome: "conflict-resolved", message: "pushed to branch" },
		]);
	});

	it("does not record an entry while a conflict stays unresolved (keepLocal)", async () => {
		const { orchestrator } = makeOrchestrator(
			{
				commitOid: "bbb",
				remoteOid: "ccc",
				trackingOid: "aaa",
				localOid: "bbb",
				merge: { kind: "conflict", files: ["x.md"] },
			},
			{ strategy: "keepLocal", conflictResult: { kind: "manual", message: "paused" } }
		);
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("conflict");
		expect(orchestrator.history).toEqual([]);
	});

	it("caps history at MAX_SYNC_HISTORY_ENTRIES, dropping the oldest", async () => {
		const { orchestrator } = makeOrchestrator(cleanScenario);
		for (let i = 0; i < MAX_SYNC_HISTORY_ENTRIES + 5; i++) {
			orchestrator.requestSync("interval");
			await drain(orchestrator);
		}
		expect(orchestrator.history).toHaveLength(MAX_SYNC_HISTORY_ENTRIES);
	});

	it("seeds history from initialHistory and appends after it, respecting the cap", async () => {
		const seeded: SyncHistoryEntry = { at: 1, outcome: "synced", message: "old" };
		const { orchestrator } = makeOrchestrator(cleanScenario, {
			initialHistory: [seeded],
		});
		expect(orchestrator.history).toEqual([seeded]);

		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.history).toEqual([
			seeded,
			{ at: 1_700_000_000_000, outcome: "synced", message: null },
		]);
	});

	it("invokes onHistoryEntry with the updated snapshot after each new entry", async () => {
		const snapshots: Array<readonly SyncHistoryEntry[]> = [];
		const { orchestrator } = makeOrchestrator(cleanScenario, {
			onHistoryEntry: (history) => snapshots.push(history),
		});
		orchestrator.requestSync("manual");
		await drain(orchestrator);

		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toEqual([
			{ at: 1_700_000_000_000, outcome: "synced", message: null },
		]);
	});
});

describe("SyncOrchestrator runExclusive wiring", () => {
	/**
	 * Regression coverage for the mutual-exclusion fix: a sync must run its
	 * engine-touching work through `runExclusive` so it can be serialized
	 * against one-off operations (setup wizard clone/init, Danger Zone
	 * re-clone/discard) that share the same `.git` directory outside the
	 * orchestrator.
	 */
	function makeOrchestratorWithExclusive(scenario: MockScenario, conflictResult?: ConflictResult) {
		const { engine } = makeEngine(scenario);
		const conflicts = makeConflicts(conflictResult ?? { kind: "manual", message: "paused" });
		let exclusiveCalls = 0;
		const orchestrator = new SyncOrchestrator({
			engine,
			conflicts: conflicts.runner,
			branch: () => "main",
			conflictStrategy: () => "prBranch",
			platform: "test",
			now: () => 1_700_000_000_000,
			runExclusive: async (fn) => {
				exclusiveCalls += 1;
				return fn();
			},
		});
		return { orchestrator, conflicts, exclusiveCalls: () => exclusiveCalls };
	}

	it("runs a normal sync through runExclusive", async () => {
		const { orchestrator, exclusiveCalls } = makeOrchestratorWithExclusive({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
		});
		orchestrator.requestSync("interval");
		await drain(orchestrator);

		expect(orchestrator.status.state).toBe("idle");
		expect(exclusiveCalls()).toBe(1);
	});

	it("runs conflict resolution through runExclusive too", async () => {
		const { orchestrator, exclusiveCalls } = makeOrchestratorWithExclusive(
			{
				commitOid: "bbb",
				remoteOid: "ccc",
				trackingOid: "aaa",
				localOid: "bbb",
				merge: { kind: "conflict", files: ["x.md"] },
			},
			{ kind: "manual", message: "paused" }
		);
		orchestrator.requestSync("interval");
		await drain(orchestrator);
		expect(orchestrator.status.state).toBe("conflict");
		// One call so far, for the sync that discovered the conflict.
		expect(exclusiveCalls()).toBe(1);

		await orchestrator.resolveConflict("discardLocal");
		expect(exclusiveCalls()).toBe(2);
	});

	it("a real AsyncLock serializes an orchestrator sync against a concurrent one-off operation", async () => {
		const lock = new AsyncLock();
		const { engine } = makeEngine({
			commitOid: null,
			remoteOid: "aaa",
			trackingOid: "aaa",
			localOid: "aaa",
		});
		const order: string[] = [];
		const orchestrator = new SyncOrchestrator({
			engine,
			conflicts: { apply: async () => ({ kind: "manual", message: "" }) },
			branch: () => "main",
			conflictStrategy: () => "prBranch",
			platform: "test",
			runExclusive: (fn) => lock.run(fn),
		});

		let releaseOneOff: () => void = () => {};
		const oneOffGate = new Promise<void>((r) => (releaseOneOff = r));
		const oneOff = lock.run(async () => {
			order.push("one-off-start");
			await oneOffGate;
			order.push("one-off-end");
		});

		orchestrator.requestSync("manual");
		await new Promise((r) => setTimeout(r, 0));
		// The sync must be queued behind the one-off operation, not racing it.
		expect(order).toEqual(["one-off-start"]);

		releaseOneOff();
		await oneOff;
		await drain(orchestrator);

		expect(order[order.length - 1]).toBe("one-off-end");
		expect(orchestrator.status.state).toBe("idle");
	});
});
