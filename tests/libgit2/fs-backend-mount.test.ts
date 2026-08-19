/**
 * Real test of `fs-backend.ts`'s `VaultMirror`-backed classic-FS mount
 * against the actual compiled libgit2-WASM module — the thing
 * `filter-smoke.test.ts`/`asyncify-double-suspension.test.ts` deliberately
 * sidestepped by using Emscripten's `NODEFS` (a real host directory)
 * instead, and which `fs-backend.ts`'s own header comment flagged as "not
 * verified against a real Emscripten FS instance."
 *
 * This test mounts a `VaultMirror` — hydrated from (and, at the end,
 * flushed back to) a `MockAdapter`, the exact same in-memory
 * `DataAdapterLike` mock `tests/helpers/mock-adapter.ts` already provides
 * for `fs-adapter.test.ts` and `fs-backend.test.ts` — into the real
 * compiled module's classic FS via `describeClassicFsBackend`, then drives
 * a real init → write → stage → commit → modify → force-checkout cycle
 * through `engine.ts`'s real `Libgit2Repository`, proving the production FS
 * path (no host directory, no NODEFS) actually works end to end.
 *
 * Skipped (not failed) when the compiled module doesn't exist.
 */

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapLibgit2Module } from "../../src/git/libgit2/engine";
import {
	VaultMirror,
	deriveErrnoCodes,
	describeClassicFsBackend,
	type ClassicFsBackendGlobals,
	type FsNode,
} from "../../src/git/libgit2/fs-backend";
import type { RequestUrlLike } from "../../src/git/http-client";
import { MockAdapter } from "../helpers/mock-adapter";
import { loadModuleFactory } from "./helpers/test-module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_JS = join(__dirname, "..", "..", "src", "git", "libgit2", "build", "dist", "tether-libgit2.js");

const factory = loadModuleFactory(MODULE_JS);

const neverRequestUrl: RequestUrlLike = async () => {
	throw new Error("fs-backend-mount.test.ts performs no network operations");
};

const AUTHOR = { name: "Test", email: "test@example.com" };

describe.skipIf(factory === null)("VaultMirror mounted into the real compiled module (not NODEFS)", () => {
	it("init -> write -> stage -> commit -> modify -> force-checkout -> flush, entirely through the VaultMirror mount", async () => {
			const Module = await factory!();

		const mirror = new VaultMirror();
		const errnoCodes = deriveErrnoCodes(Module);
		const globals: ClassicFsBackendGlobals = {
			ErrnoError: Module.FS.ErrnoError,
			createNode: (parent: FsNode | null, name: string, mode: number, dev: number) =>
				Module.FS.createNode(parent, name, mode, dev),
			isDir: (mode: number) => Module.FS.isDir(mode),
			errnoCodes,
		};
		const backend = describeClassicFsBackend(mirror, globals);

		Module.FS.mkdir("/repo");
		Module.FS.mount(backend, {}, "/repo");

		const git2 = await wrapLibgit2Module(Module, { requestUrl: neverRequestUrl });
		const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

		// Write the working-tree file THROUGH the mount (exercises this
		// backend's own node_ops.mknod + stream_ops.write, not a shortcut).
		Module.FS.writeFile("/repo/hello.txt", "hello from VaultMirror\n");
		expect(new TextDecoder().decode(Module.FS.readFile("/repo/hello.txt"))).toBe(
			"hello from VaultMirror\n"
		);

		await repo.stagePath("hello.txt");
		const oid = await repo.commit("first commit via VaultMirror mount", AUTHOR);
		expect(oid).toMatch(/^[0-9a-f]{40}$/);

		// Independent read-back: readBlob resolves (commit, path) via the same
		// mounted repo, proving the committed object database (also entirely
		// backed by this mount — `.git/objects/...`) round-trips correctly.
		const committed = await repo.readBlob(oid!, "hello.txt");
		expect(new TextDecoder().decode(committed)).toBe("hello from VaultMirror\n");

		// Mutate the working tree (through the mount), then force-checkout to
		// prove read-back after a real libgit2 checkout_tree call works too —
		// same shape as filter-smoke.test.ts's delete-then-checkout assertion,
		// just against this mount instead of NODEFS.
		Module.FS.writeFile("/repo/hello.txt", "modified out from under git\n");
		await repo.checkout("main", { force: true });
		expect(new TextDecoder().decode(Module.FS.readFile("/repo/hello.txt"))).toBe(
			"hello from VaultMirror\n"
		);

		await repo.close();

		// Flush the in-memory mirror back to a mock DataAdapter and confirm it
		// received the right bytes — the other half of the production FS
		// story (fs-backend.ts's `VaultMirror.flush`), proving the whole
		// mount -> git operations -> flush round trip, not just the mount.
		const adapter = new MockAdapter();
		await mirror.flush(adapter);

		expect(await adapter.read("hello.txt")).toBe("hello from VaultMirror\n");
		expect(await adapter.exists(".git/HEAD")).toBe(true);
		expect(await adapter.read(".git/HEAD")).toContain("refs/heads/main");
	}, 30_000);

	it("directories, renames, and deletions round-trip through the mount", async () => {
			const Module = await factory!();
		const mirror = new VaultMirror();
		const errnoCodes = deriveErrnoCodes(Module);
		const backend = describeClassicFsBackend(mirror, {
			ErrnoError: Module.FS.ErrnoError,
			createNode: (parent: FsNode | null, name: string, mode: number, dev: number) =>
				Module.FS.createNode(parent, name, mode, dev),
			isDir: (mode: number) => Module.FS.isDir(mode),
			errnoCodes,
		});
		Module.FS.mkdir("/vault");
		Module.FS.mount(backend, {}, "/vault");

		Module.FS.mkdir("/vault/sub");
		Module.FS.writeFile("/vault/sub/a.txt", "a");
		expect(Module.FS.readdir("/vault/sub").sort()).toEqual(["a.txt"]);

		Module.FS.rename("/vault/sub/a.txt", "/vault/sub/b.txt");
		expect(new TextDecoder().decode(Module.FS.readFile("/vault/sub/b.txt"))).toBe("a");

		Module.FS.unlink("/vault/sub/b.txt");
		expect(() => Module.FS.readFile("/vault/sub/b.txt")).toThrow();

		Module.FS.rmdir("/vault/sub");
		expect(mirror.has("sub")).toBe(false);
	});
});
