import { describe, expect, it } from "vitest";
import {
	conflictBranchName,
	ConflictResolver,
	formatConflictTimestamp,
	generateDeviceName,
	type ConflictResolverOptions,
} from "../src/sync/conflicts";

const WHEN = new Date(2026, 6, 19, 14, 23, 5); // 2026-07-19 14:23:05 local

describe("conflict branch naming", () => {
	it("formats the timestamp as yyyyMMdd-HHmmss", () => {
		expect(formatConflictTimestamp(WHEN)).toBe("20260719-142305");
	});

	it("builds sync-conflict/{device}-{timestamp}", () => {
		expect(conflictBranchName("desktop-a1b2", WHEN)).toBe(
			"sync-conflict/desktop-a1b2-20260719-142305"
		);
	});

	it("sanitizes ref-hostile characters in the device name", () => {
		expect(conflictBranchName("Tim's Laptop~^:?", WHEN)).toBe(
			"sync-conflict/Tim-s-Laptop-20260719-142305"
		);
		expect(conflictBranchName("...", WHEN)).toBe(
			"sync-conflict/device-20260719-142305"
		);
	});
});

describe("generateDeviceName", () => {
	it("prefixes by platform and appends a 4-char suffix", () => {
		expect(generateDeviceName(false, () => 0)).toBe("desktop-aaaa");
		expect(generateDeviceName(true, () => 0)).toBe("mobile-aaaa");
		expect(generateDeviceName(false, () => 0.9999)).toMatch(/^desktop-[a-z0-9]{4}$/);
	});
});

interface ResolverHarness {
	resolver: ConflictResolver;
	pushes: Array<{ ref?: string; remoteRef?: string; force?: boolean }>;
	fetches: string[];
	resets: string[];
	/** Combined call order, to assert fetch happens before reset. */
	calls: string[];
	prCalls: Array<{ repoPath: string; sourceBranch: string; targetBranch: string }>;
	paused: boolean[];
}

function makeResolver(overrides?: {
	prResult?: { url: string } | null | Error;
	token?: string | null;
	failPush?: boolean;
}): ResolverHarness {
	const harness: ResolverHarness = {
		resolver: undefined as unknown as ConflictResolver,
		pushes: [],
		fetches: [],
		resets: [],
		calls: [],
		prCalls: [],
		paused: [],
	};
	const options: ConflictResolverOptions = {
		engine: {
			push: async (opts) => {
				if (overrides?.failPush === true) throw new Error("push rejected");
				harness.pushes.push(opts ?? {});
				harness.calls.push("push");
				return {};
			},
			fetch: async (branch) => {
				harness.fetches.push(branch);
				harness.calls.push("fetch");
				return {};
			},
			hardResetToRemote: async (branch) => {
				harness.resets.push(branch);
				harness.calls.push("reset");
				return "reset-oid";
			},
		},
		provider: () => ({
			createPullRequest: async (params) => {
				harness.prCalls.push({
					repoPath: params.repoPath,
					sourceBranch: params.sourceBranch,
					targetBranch: params.targetBranch,
				});
				const result = overrides?.prResult;
				if (result instanceof Error) throw result;
				if (result === undefined) return { url: "https://example.com/pr/1" };
				return result;
			},
		}),
		getToken: async () => (overrides?.token === undefined ? "tok" : overrides.token),
		branch: () => "main",
		deviceName: () => "desktop-a1b2",
		repoPath: () => "owner/repo",
		pauseAutoSync: () => harness.paused.push(true),
		now: () => WHEN,
	};
	harness.resolver = new ConflictResolver(options);
	return harness;
}

describe("ConflictResolver prBranch", () => {
	it("pushes the conflict branch, opens a PR, then fetches and hard-resets", async () => {
		const h = makeResolver();
		const result = await h.resolver.apply("prBranch", ["a.md"]);

		expect(h.pushes).toEqual([
			{
				ref: "main",
				remoteRef: "refs/heads/sync-conflict/desktop-a1b2-20260719-142305",
			},
		]);
		expect(h.prCalls).toEqual([
			{
				repoPath: "owner/repo",
				sourceBranch: "sync-conflict/desktop-a1b2-20260719-142305",
				targetBranch: "main",
			},
		]);
		expect(h.fetches).toEqual(["main"]);
		expect(h.resets).toEqual(["main"]);
		// Fetch must happen after the PR dance but before the final reset, so
		// the reset target reflects the current remote rather than a stale
		// tracking ref.
		expect(h.calls).toEqual(["push", "fetch", "reset"]);
		expect(result.kind).toBe("resolved");
		if (result.kind === "resolved") {
			expect(result.prUrl).toBe("https://example.com/pr/1");
			expect(result.branch).toBe("sync-conflict/desktop-a1b2-20260719-142305");
			expect(result.degraded).toBeUndefined();
		}
	});

	it("degrades but still converges when PR creation fails", async () => {
		const h = makeResolver({ prResult: new Error("403 insufficient scope") });
		const result = await h.resolver.apply("prBranch", ["a.md"]);

		expect(h.pushes).toHaveLength(1); // branch was pushed — data is safe
		expect(h.fetches).toEqual(["main"]); // still fetches before the reset
		expect(h.resets).toEqual(["main"]);
		expect(result.kind).toBe("resolved");
		if (result.kind === "resolved") {
			expect(result.degraded).toBe(true);
			expect(result.prUrl).toBeUndefined();
			expect(result.message).toContain("403 insufficient scope");
			expect(result.message).toContain("sync-conflict/desktop-a1b2-20260719-142305");
		}
	});

	it("degrades when the provider cannot create PRs (generic host)", async () => {
		const h = makeResolver({ prResult: null });
		const result = await h.resolver.apply("prBranch", []);
		expect(result.kind).toBe("resolved");
		if (result.kind === "resolved") expect(result.degraded).toBe(true);
		expect(h.resets).toEqual(["main"]);
	});

	it("degrades when no token is available", async () => {
		const h = makeResolver({ token: null });
		const result = await h.resolver.apply("prBranch", []);
		expect(h.prCalls).toHaveLength(0);
		if (result.kind === "resolved") expect(result.degraded).toBe(true);
	});

	it("propagates a failed branch push without touching the vault", async () => {
		const h = makeResolver({ failPush: true });
		await expect(h.resolver.apply("prBranch", ["a.md"])).rejects.toThrow(
			"push rejected"
		);
		expect(h.fetches).toHaveLength(0); // never even reached the fetch
		expect(h.resets).toHaveLength(0); // never lose local commits
	});
});

describe("ConflictResolver other strategies", () => {
	it("discardLocal fetches before hard-resetting to the remote", async () => {
		const h = makeResolver();
		const result = await h.resolver.apply("discardLocal", ["a.md"]);
		expect(h.fetches).toEqual(["main"]);
		expect(h.resets).toEqual(["main"]);
		// Fetch must happen before the reset so it targets the current remote,
		// not a stale tracking ref from whenever the vault last synced.
		expect(h.calls).toEqual(["fetch", "reset"]);
		expect(h.pushes).toHaveLength(0);
		expect(result.kind).toBe("resolved");
	});

	it("keepLocal pauses auto-sync and stays manual", async () => {
		const h = makeResolver();
		const result = await h.resolver.apply("keepLocal", ["a.md"]);
		expect(h.paused).toEqual([true]);
		expect(h.resets).toHaveLength(0);
		expect(h.pushes).toHaveLength(0);
		expect(result.kind).toBe("manual");
	});
});
