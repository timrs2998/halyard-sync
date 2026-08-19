/**
 * Real, end-to-end tests for `Libgit2Repository.merge()` in
 * `src/git/libgit2/engine.ts`, run against the real compiled
 * `build/dist/tether-libgit2.{js,wasm}` module — same artifact
 * `tests/libgit2/engine.test.ts` already exercises, same NODEFS-mount
 * pattern (proving `merge()`'s own libgit2 call sequence, not
 * `fs-backend.ts`'s `VaultMirror` glue, which `fs-backend-mount.test.ts`
 * covers separately). Skipped (not failed) when the compiled module doesn't
 * exist.
 *
 * All four `MergeOutcome` cases are covered against a real, purpose-built
 * diverging-branch history (`main` vs. `feature`, both built via real
 * `engine.ts` calls, not hand-crafted git plumbing) — see each `it` block's
 * own comment for the exact history shape and what's independently verified
 * via the real `git` CLI on the same on-disk repo.
 *
 * The conflict case's safety assertions are the most load-bearing part of
 * this file: they prove `merge()` never writes `<<<<<<<` conflict markers
 * into the working tree and never moves `HEAD`/the index on a conflicting
 * merge — see `engine.ts`'s `merge()` doc comment for exactly why (never
 * calling the top-level `git_merge()` C entry point, using
 * `git_merge_commits()` — a pure in-memory merge — instead).
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapLibgit2Module } from "../../src/git/libgit2/engine";
import type { RequestUrlLike } from "../../src/git/http-client";
import { mountHostDir } from "./helpers/nodefs-mount";
import type { TestNativeModule } from "./helpers/test-module";
import { loadModuleFactory } from "./helpers/test-module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_JS = join(__dirname, "..", "..", "src", "git", "libgit2", "build", "dist", "tether-libgit2.node.js");

const factory = loadModuleFactory(MODULE_JS);

const unusedRequestUrl: RequestUrlLike = async () => {
	throw new Error("merge.test.ts never performs network operations");
};

async function freshModule(mountDir: string): Promise<TestNativeModule> {
	const Module = await factory!();
	mountHostDir(Module, mountDir, "/repo");
	return Module;
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd }).toString("utf8").trim();
}

const AUTHOR = { name: "Test", email: "test@example.com" };

describe.skipIf(factory === null)("engine.ts Libgit2Repository.merge() (real, against the compiled module)", () => {
	it("uptodate: theirs is already an ancestor of (or equal to) ours", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-merge-uptodate-"));
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: unusedRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		Module.FS.writeFile("/repo/shared.txt", "base\n");
		await repo.stagePath("shared.txt");
		const base = await repo.commit("base", AUTHOR);
		await repo.writeRef("refs/heads/feature", base!, { force: true });

		// feature === main, both at `base` — nothing to merge either direction.
		const outcome = await repo.merge("main", "refs/heads/feature", AUTHOR);
		expect(outcome).toEqual({ kind: "uptodate" });

		await repo.close();
	});

	it("fastforward: ours is a strict ancestor of theirs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-merge-ff-"));
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: unusedRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		Module.FS.writeFile("/repo/shared.txt", "base\n");
		await repo.stagePath("shared.txt");
		const base = await repo.commit("base", AUTHOR);
		await repo.writeRef("refs/heads/feature", base!, { force: true });

		// Advance `feature` one commit past `base`; `main` stays at `base`.
		await repo.checkout("feature", { force: true });
		Module.FS.writeFile("/repo/feature-only.txt", "new on feature\n");
		await repo.stagePath("feature-only.txt");
		const featureTip = await repo.commit("feature work", AUTHOR);
		await repo.checkout("main", { force: true });
		expect(existsSync(join(dir, "feature-only.txt"))).toBe(false);

		const outcome = await repo.merge("main", "refs/heads/feature", AUTHOR);
		expect(outcome).toEqual({ kind: "fastforward", oid: featureTip });

		// Independent verification: main really moved, and the working tree
		// really reflects feature's content now.
		expect(git(["rev-parse", "refs/heads/main"], dir)).toBe(featureTip);
		expect(readFileSync(join(dir, "feature-only.txt"), "utf8")).toBe("new on feature\n");

		// A second merge is now a genuine no-op.
		const again = await repo.merge("main", "refs/heads/feature", AUTHOR);
		expect(again).toEqual({ kind: "uptodate" });

		await repo.close();
	});

	it("merged: a real three-way merge of non-overlapping changes succeeds cleanly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-merge-clean-"));
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: unusedRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		Module.FS.writeFile("/repo/fileA.txt", "A0\n");
		Module.FS.writeFile("/repo/fileB.txt", "B0\n");
		await repo.stagePath("fileA.txt");
		await repo.stagePath("fileB.txt");
		const base = await repo.commit("base", AUTHOR);
		await repo.writeRef("refs/heads/feature", base!, { force: true });

		// feature: change fileB only.
		await repo.checkout("feature", { force: true });
		Module.FS.writeFile("/repo/fileB.txt", "B1\n");
		await repo.stagePath("fileB.txt");
		const featureTip = await repo.commit("feature: touch B", AUTHOR);

		// main: change fileA only (non-overlapping with feature's change).
		await repo.checkout("main", { force: true });
		Module.FS.writeFile("/repo/fileA.txt", "A1\n");
		await repo.stagePath("fileA.txt");
		const mainTip = await repo.commit("main: touch A", AUTHOR);

		const outcome = await repo.merge("main", "refs/heads/feature", AUTHOR);
		expect(outcome.kind).toBe("merged");
		const mergeOid = (outcome as { kind: "merged"; oid: string }).oid;
		expect(mergeOid).toMatch(/^[0-9a-f]{40}$/);

		// Independent verification via the real git CLI: a real two-parent
		// merge commit, and the working tree really reflects BOTH sides.
		expect(git(["rev-parse", "refs/heads/main"], dir)).toBe(mergeOid);
		const parents = git(["log", "-1", "--format=%P", mergeOid], dir).split(" ");
		expect(parents.sort()).toEqual([mainTip, featureTip].sort());
		expect(git(["show", `${mergeOid}:fileA.txt`], dir)).toBe("A1");
		expect(git(["show", `${mergeOid}:fileB.txt`], dir)).toBe("B1");
		expect(readFileSync(join(dir, "fileA.txt"), "utf8")).toBe("A1\n");
		expect(readFileSync(join(dir, "fileB.txt"), "utf8")).toBe("B1\n");
		expect(git(["status", "--porcelain"], dir)).toBe("");

		await repo.close();
	});

	it("conflict: the same file changed incompatibly on both sides — no markers, no ref move, no index write", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-merge-conflict-"));
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: unusedRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		Module.FS.writeFile("/repo/conflict.txt", "base\n");
		await repo.stagePath("conflict.txt");
		const base = await repo.commit("base", AUTHOR);
		await repo.writeRef("refs/heads/feature", base!, { force: true });

		await repo.checkout("feature", { force: true });
		Module.FS.writeFile("/repo/conflict.txt", "theirs change\n");
		await repo.stagePath("conflict.txt");
		await repo.commit("feature: conflicting change", AUTHOR);

		await repo.checkout("main", { force: true });
		Module.FS.writeFile("/repo/conflict.txt", "ours change\n");
		await repo.stagePath("conflict.txt");
		const oursTip = await repo.commit("main: conflicting change", AUTHOR);

		// Snapshot repo state BEFORE the conflicting merge attempt.
		const headBefore = git(["rev-parse", "HEAD"], dir);
		expect(headBefore).toBe(oursTip);
		const contentBefore = readFileSync(join(dir, "conflict.txt"), "utf8");
		expect(contentBefore).toBe("ours change\n");
		const statusBefore = git(["status", "--porcelain"], dir);

		const outcome = await repo.merge("main", "refs/heads/feature", AUTHOR);
		expect(outcome).toEqual({ kind: "conflict", paths: ["conflict.txt"] });

		// --- SAFETY: the repository must be untouched. ---------------------
		// No conflict markers were ever written into the working tree.
		const contentAfter = readFileSync(join(dir, "conflict.txt"), "utf8");
		expect(contentAfter).toBe(contentBefore);
		expect(contentAfter).not.toContain("<<<<<<<");
		expect(contentAfter).not.toContain("=======");
		expect(contentAfter).not.toContain(">>>>>>>");

		// HEAD/main did not move; nothing was staged; no merge state entered.
		expect(git(["rev-parse", "HEAD"], dir)).toBe(headBefore);
		expect(git(["status", "--porcelain"], dir)).toBe(statusBefore);
		expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);

		await repo.close();
	});

	it("favor: 'union' — the same file changed incompatibly on both sides merges cleanly, keeping both lines", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tether-merge-union-"));
		const Module = await freshModule(dir);
		const git2 = await wrapLibgit2Module(Module, { requestUrl: unusedRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		Module.FS.writeFile("/repo/conflict.txt", "base\n");
		await repo.stagePath("conflict.txt");
		const base = await repo.commit("base", AUTHOR);
		await repo.writeRef("refs/heads/feature", base!, { force: true });

		await repo.checkout("feature", { force: true });
		Module.FS.writeFile("/repo/conflict.txt", "theirs change\n");
		await repo.stagePath("conflict.txt");
		await repo.commit("feature: conflicting change", AUTHOR);

		await repo.checkout("main", { force: true });
		Module.FS.writeFile("/repo/conflict.txt", "ours change\n");
		await repo.stagePath("conflict.txt");
		await repo.commit("main: conflicting change", AUTHOR);

		// Same overlapping-hunk setup as the "conflict" case above, but with
		// `favor: "union"` — this must NEVER report a conflict: both distinct
		// lines land in the merged file instead, no markers, no exception.
		const outcome = await repo.merge("main", "refs/heads/feature", AUTHOR, { favor: "union" });
		expect(outcome.kind).toBe("merged");

		const content = readFileSync(join(dir, "conflict.txt"), "utf8");
		expect(content).toContain("ours change");
		expect(content).toContain("theirs change");
		expect(content).not.toContain("<<<<<<<");
		expect(content).not.toContain("=======");
		expect(content).not.toContain(">>>>>>>");
		expect(git(["status", "--porcelain"], dir)).toBe("");

		await repo.close();
	});
});
