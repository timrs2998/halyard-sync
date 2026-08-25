/**
 * A custom Emscripten filesystem backend bridging Obsidian's `DataAdapter`
 * (via the same `DataAdapterLike` structural interface `fs-adapter.ts`
 * already defines — reused here, not reinvented) into whatever compiled
 * libgit2-WASM ends up using for its filesystem calls.
 *
 * ---------------------------------------------------------------------------
 * READ THIS FIRST: the sync/async mismatch this file exists to solve
 * ---------------------------------------------------------------------------
 *
 * `fs-adapter.ts`'s `ObsidianFs` wraps `DataAdapter` 1:1 against an
 * `fs.promises`-shaped API, where every call is already async.
 *
 * A compiled libgit2 has no such luxury. Its C entry points
 * (`git_odb_read`, `git_index_add_bypath`, `p_open`/`p_read` in libgit2's
 * own `posix.h` abstraction, ...) are synchronous, and Emscripten's classic
 * FS layer (`FS.mount(backend, opts, mountpoint)`) calls a custom backend's
 * `node_ops`/`stream_ops` *synchronously from WASM* — there is no `await` in
 * a `stream_ops.read()` implementation (confirmed against Emscripten's
 * shipped backends: MEMFS's and IDBFS's `node_ops`/`stream_ops` are plain
 * synchronous functions; IDBFS's actual IndexedDB I/O only happens in the
 * separate, explicitly-invoked `syncfs(mount, populate, callback)` entry
 * point, not per-file-op — see
 * https://github.com/emscripten-core/emscripten/blob/main/src/lib/libidbfs.js).
 * `DataAdapter.readBinary`/`writeBinary`/`list`/`stat` are all
 * `Promise`-returning; there is no synchronous variant on mobile
 * (Capacitor's `DataAdapter` implementation goes through an async bridge to
 * native code same as everywhere else in Obsidian mobile).
 *
 * Two ways to reconcile that, both real options, with a concrete
 * recommendation:
 *
 * 1. **Asyncify every FS op** (`EM_ASYNC_JS`/`Asyncify.handleSleep`, see
 *    `native/README.md` and `build/BUILD.md`) so each `stream_ops.read()` can
 *    itself `await` a `DataAdapter` call. Rejected: Asyncify documents that
 *    "it is not safe to start an async operation while another is already
 *    running" (https://emscripten.org/docs/porting/asyncify.html), and
 *    libgit2's internals — tree walks, the ODB, the index — issue many FS
 *    calls in tight sequences TS does not control. Making each individually
 *    async reintroduces exactly that reentrancy hazard, buying true lazy
 *    streaming that this plugin does not need.
 * 2. **Mirror the whole repo into memory, synchronously-backed, and
 *    explicitly sync it to `DataAdapter` before/after libgit2 runs** — the
 *    same shape as Emscripten's own IDBFS (`MEMFS` node backing +
 *    `syncfs(populate)`/`syncfs(!populate)` as the only async boundary).
 *    This is what `VaultMirror` below implements. It costs the whole working
 *    tree resident in memory during a sync — consistent with constraints this
 *    plugin already accepts, since shallow (`depth: 1`) clones and
 *    whole-buffered `requestUrl` responses already cap pack sizes by device
 *    memory.
 *
 * **Recommendation: option 2.** It is what `VaultMirror` is built for. If a
 * future engineer with real profiling data finds full-mirror too expensive
 * for large vaults, option 1 (Asyncify, scoped to *only* the FS layer, not
 * the whole library) is the fallback to revisit — but do that with real
 * numbers, not speculatively.
 *
 * ---------------------------------------------------------------------------
 * What's real vs scaffolded in this file
 * ---------------------------------------------------------------------------
 *
 * `VaultMirror` (the in-memory tree + its manipulation methods + the
 * `DataAdapterLike` hydrate/flush pair) is plain TypeScript with no
 * Emscripten/WASM dependency at all — it is fully unit-tested in
 * `tests/libgit2/fs-backend.test.ts` against the same `MockAdapter` helper
 * `fs-adapter.test.ts` uses.
 *
 * `describeClassicFsBackend` at the bottom documents (as a plain object
 * literal, not executable against anything) the shape Emscripten's classic
 * `FS.mount()` custom-backend mechanism needs (`node_ops`/`stream_ops`,
 * confirmed against `src/lib/libmemfs.js` and `src/lib/libidbfs.js` in the
 * emscripten-core/emscripten source, since Emscripten's own prose docs at
 * https://emscripten.org/docs/api_reference/Filesystem-API.html describe
 * only the *built-in* backends' usage, not the node_ops/stream_ops contract
 * a custom one must implement). This function's actual bodies here are thin
 * wrappers that just call into `VaultMirror`'s already-tested methods —
 * the wrapper glue itself is NOT executable without a compiled Emscripten
 * runtime present (it needs `FS.ErrnoError`, `FS.createNode`, and friends,
 * none of which exist outside that runtime), so it is written but not
 * covered by any test that would prove it wires up correctly end to end.
 * Treat it as "shaped correctly per Emscripten's documented backend
 * contract," not "verified against a real Emscripten FS instance."
 */

import type { AdapterStatLike, DataAdapterLike } from "../fs-adapter";
import { toAdapterPath } from "../fs-adapter";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Symbolic (string) error codes, deliberately mirroring `fs-adapter.ts`'s
 * `FsError` convention rather than Emscripten's actual runtime errno
 * integers. Emscripten's musl-derived `ERRNO_CODES` table assigns numbers
 * that do NOT match POSIX/glibc's familiar values (e.g. its `ENOENT` is not
 * 2) and that table only exists inside a built module (`Module.ERRNO_CODES`
 * / `FS.ErrnoError`), so hardcoding integers here would bake in numbers
 * nothing can check at authoring time. The classic FS wrapper at the bottom
 * of this file translates the symbolic codes below into a real
 * `FS.ErrnoError(Module.ERRNO_CODES[code])` against the live runtime.
 */
export type VaultMirrorErrorCode =
	| "ENOENT"
	| "EEXIST"
	| "ENOTDIR"
	| "EISDIR"
	| "ENOTEMPTY"
	| "ENOSYS"
	| "EIO";

/**
 * The errno codes the classic-FS *backend wiring* needs beyond what
 * `VaultMirror` itself ever throws — currently just `EINVAL`, needed by
 * `describeClassicFsBackend`'s `node_ops.readlink` (see its own comment for
 * why: a real bug found while testing this against the compiled module,
 * where libgit2's own path resolution speculatively calls `readlink()` on
 * existing non-symlink paths and expects EINVAL, not VaultMirror's blanket
 * ENOSYS-for-all-symlink-ops answer).
 */
export type FsBackendErrnoCode = VaultMirrorErrorCode | "EINVAL";

export class VaultMirrorError extends Error {
	constructor(
		readonly code: VaultMirrorErrorCode,
		readonly syscall: string,
		readonly path: string
	) {
		super(`${code}: ${syscall} '${path}'`);
		this.name = "VaultMirrorError";
	}
}

// ---------------------------------------------------------------------------
// In-memory tree
// ---------------------------------------------------------------------------

interface FileEntry {
	kind: "file";
	data: Uint8Array;
	mtimeMs: number;
	ctimeMs: number;
	/** Written since the last `flush()`; `flush()` only touches these. */
	dirty: boolean;
}

interface DirEntry {
	kind: "dir";
}

type Entry = FileEntry | DirEntry;

export interface VaultMirrorStat {
	path: string;
	isDirectory: boolean;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

/**
 * How many adapter round-trips `hydrateDir`/`flush` do before yielding to
 * the browser's event loop (a real macrotask, via `setTimeout`, not just a
 * microtask — `await`ing an already-resolved promise doesn't reliably give
 * the renderer a chance to repaint/handle input, since microtasks all drain
 * before the message loop moves on). This is a UI-responsiveness measure,
 * not a throughput one: a large vault's full hydrate-then-flush cycle
 * (`GitEngine`'s doc comment on why that happens every sync) is many
 * sequential adapter round-trips with nothing else in this codebase
 * interrupting them, which is exactly the shape that can make Obsidian feel
 * frozen for the walk's duration even though every individual step is
 * cheap. The exact number isn't critical — small enough that "many seconds
 * without a yield" can't happen.
 */
const YIELD_EVERY = 200;

function maybeYield(counter: { n: number }): Promise<void> {
	counter.n += 1;
	if (counter.n % YIELD_EVERY !== 0) return Promise.resolve();
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function parentOf(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? "" : p.slice(0, idx);
}

/**
 * A synchronous, in-memory mirror of some subtree of the vault, keyed by the
 * same normalized path convention as `fs-adapter.ts`'s `toAdapterPath`
 * (`""` is the root here rather than `"/"`, matching `DataAdapter`'s own
 * "root has no leading slash" convention — see `hydrateAll`'s use of
 * `toAdapterPath` below, which maps `"/"` to `"/"`; this class strips that
 * down to `""` internally so child-path prefixing (`${dir}/${name}`) doesn't
 * need root-vs-non-root special casing at every call site).
 *
 * Every method here is synchronous and touches only the in-memory `entries`
 * map — this is deliberate (see the file header): these are the methods a
 * compiled Emscripten backend's `node_ops`/`stream_ops` would call directly,
 * with no `await` anywhere in that path. Getting data in and out of
 * `DataAdapter` is exclusively `hydrate*`/`flush`'s job.
 */
export class VaultMirror {
	private readonly entries = new Map<string, Entry>();

	constructor() {
		this.entries.set("", { kind: "dir" });
	}

	private normalize(path: string): string {
		const p = toAdapterPath(path);
		return p === "/" ? "" : p;
	}

	private requireDir(path: string, syscall: string): void {
		const entry = this.entries.get(path);
		if (entry === undefined) throw new VaultMirrorError("ENOENT", syscall, path);
		if (entry.kind !== "dir") throw new VaultMirrorError("ENOTDIR", syscall, path);
	}

	// -- reads ----------------------------------------------------------

	has(path: string): boolean {
		return this.entries.has(this.normalize(path));
	}

	stat(path: string): VaultMirrorStat {
		const p = this.normalize(path);
		const entry = this.entries.get(p);
		if (entry === undefined) throw new VaultMirrorError("ENOENT", "stat", path);
		if (entry.kind === "dir") {
			return { path: p, isDirectory: true, size: 0, mtimeMs: 0, ctimeMs: 0 };
		}
		return {
			path: p,
			isDirectory: false,
			size: entry.data.byteLength,
			mtimeMs: entry.mtimeMs,
			ctimeMs: entry.ctimeMs,
		};
	}

	readdir(path: string): string[] {
		const p = this.normalize(path);
		this.requireDir(p, "scandir");
		const prefix = p === "" ? "" : `${p}/`;
		const names: string[] = [];
		for (const key of this.entries.keys()) {
			if (key === p || key === "") continue;
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			if (rest.includes("/")) continue; // not a direct child
			names.push(rest);
		}
		return names;
	}

	readFile(path: string): Uint8Array {
		const p = this.normalize(path);
		const entry = this.entries.get(p);
		if (entry === undefined) throw new VaultMirrorError("ENOENT", "open", path);
		if (entry.kind === "dir") throw new VaultMirrorError("EISDIR", "read", path);
		return entry.data;
	}

	// -- writes -----------------------------------------------------------

	/** Marks the written file dirty so `flush()` persists it. Creates parent
	 * directories implicitly (mirrors `ObsidianFs.writeFile`'s
	 * mkdir-and-retry behavior in `fs-adapter.ts`, minus the real adapter
	 * round-trip since this is all in-memory). */
	writeFile(path: string, data: Uint8Array, now = Date.now()): void {
		const p = this.normalize(path);
		const existing = this.entries.get(p);
		if (existing?.kind === "dir") throw new VaultMirrorError("EISDIR", "write", path);
		this.ensureParents(p);
		const copy = new Uint8Array(data.byteLength);
		copy.set(data);
		this.entries.set(p, {
			kind: "file",
			data: copy,
			mtimeMs: now,
			ctimeMs: existing?.kind === "file" ? existing.ctimeMs : now,
			dirty: true,
		});
	}

	private ensureParents(path: string): void {
		const parent = parentOf(path);
		if (parent === "" || this.entries.has(parent)) return;
		this.ensureParents(parent);
		this.entries.set(parent, { kind: "dir" });
	}

	mkdir(path: string): void {
		const p = this.normalize(path);
		const existing = this.entries.get(p);
		if (existing !== undefined) {
			if (existing.kind === "dir") return; // tolerate, same as ObsidianFs.mkdir
			throw new VaultMirrorError("EEXIST", "mkdir", path);
		}
		this.ensureParents(p);
		this.entries.set(p, { kind: "dir" });
	}

	unlink(path: string): void {
		const p = this.normalize(path);
		const entry = this.entries.get(p);
		if (entry === undefined) throw new VaultMirrorError("ENOENT", "unlink", path);
		if (entry.kind === "dir") throw new VaultMirrorError("EISDIR", "unlink", path);
		this.entries.delete(p);
		this.deletions.add(p);
	}

	rmdir(path: string): void {
		const p = this.normalize(path);
		this.requireDir(p, "rmdir");
		if (this.readdir(p).length > 0) {
			throw new VaultMirrorError("ENOTEMPTY", "rmdir", path);
		}
		this.entries.delete(p);
	}

	rename(oldPath: string, newPath: string): void {
		const from = this.normalize(oldPath);
		const to = this.normalize(newPath);
		const entry = this.entries.get(from);
		if (entry === undefined) throw new VaultMirrorError("ENOENT", "rename", oldPath);
		this.ensureParents(to);
		this.entries.delete(from);
		this.entries.set(to, entry.kind === "file" ? { ...entry, dirty: true } : entry);
		if (entry.kind === "file") this.deletions.add(from);
	}

	// Symlinks are unsupported vault-wide (same policy as fs-adapter.ts:
	// DataAdapter has no symlink surface and mobile filesystems don't
	// expose them either).
	symlink(_target: string, path: string): never {
		throw new VaultMirrorError("ENOSYS", "symlink", path);
	}
	readlink(path: string): never {
		throw new VaultMirrorError("ENOSYS", "readlink", path);
	}

	// -- DataAdapter bridge (the only async surface in this class) --------

	/** Paths deleted/renamed-away since the last `flush()`, so `flush()`
	 * knows to remove them from the adapter too (a plain overwrite pass
	 * over `entries` would never observe a deletion). */
	private readonly deletions = new Set<string>();

	/**
	 * Discards every in-memory entry (back to just the empty root), for a
	 * caller that keeps one `VaultMirror` (and one mounted, already-live
	 * WASM module) alive across many git operations spread over time — see
	 * `src/git/engine.ts`'s `GitEngine`, which re-hydrates before every
	 * working-tree scan (`getChangedFiles`) so direct Obsidian edits made
	 * BETWEEN sync cycles (i.e. not through any git operation at all) are
	 * seen. `hydrateAll` alone is not enough for that reuse pattern: it only
	 * ever ADDS/overwrites entries from the adapter's current listing, so a
	 * file deleted directly through Obsidian since the last hydrate would
	 * never be removed from this in-memory map without an explicit reset
	 * first. Safe to call between flushes (i.e. once nothing is dirty) —
	 * calling it with unflushed dirty entries would silently drop them.
	 */
	reset(): void {
		this.entries.clear();
		this.entries.set("", { kind: "dir" });
		this.deletions.clear();
	}

	/**
	 * Recursively read `subtree` (default: the whole vault) out of
	 * `adapter` into memory. This is the "populate" half of the IDBFS-style
	 * `syncfs(populate=true, ...)` analogue — see the file header for why
	 * this is eager rather than lazy/read-through.
	 */
	async hydrateAll(adapter: DataAdapterLike, subtree = ""): Promise<void> {
		const root = this.normalize(subtree);
		await this.hydrateDir(adapter, root, { n: 0 });
	}

	private async hydrateDir(
		adapter: DataAdapterLike,
		dir: string,
		yieldCounter: { n: number }
	): Promise<void> {
		this.entries.set(dir, { kind: "dir" });
		const adapterPath = dir === "" ? "/" : dir;
		const listing = await adapter.list(adapterPath);
		for (const folder of listing.folders) {
			await this.hydrateDir(adapter, this.normalize(folder), yieldCounter);
		}
		for (const file of listing.files) {
			await this.hydrateFile(adapter, this.normalize(file));
			await maybeYield(yieldCounter);
		}
	}

	/** Read a single file out of `adapter` into memory (not marked dirty:
	 * this reflects what's already persisted). */
	async hydrateFile(adapter: DataAdapterLike, path: string): Promise<void> {
		const p = this.normalize(path);
		const adapterPath = p === "" ? "/" : p;
		const [buf, st] = await Promise.all([
			adapter.readBinary(adapterPath),
			adapter.stat(adapterPath),
		]);
		const stat: AdapterStatLike = st ?? { type: "file", ctime: 0, mtime: 0, size: buf.byteLength };
		this.entries.set(p, {
			kind: "file",
			data: new Uint8Array(buf),
			mtimeMs: stat.mtime,
			ctimeMs: stat.ctime,
			dirty: false,
		});
	}

	/**
	 * Write every dirty file back to `adapter` and remove every path deleted
	 * since the last flush, then clear both tracking sets. This is the
	 * "persist" half of the IDBFS-style `syncfs(populate=false, ...)`
	 * analogue: call it after a libgit2 operation that may have written to
	 * the working tree or `.git/` (checkout, commit, merge, fetch) and
	 * before control returns to code that might read the vault through
	 * Obsidian's normal (non-git) APIs.
	 */
	async flush(adapter: DataAdapterLike): Promise<void> {
		const yieldCounter = { n: 0 };
		for (const path of this.deletions) {
			const adapterPath = path === "" ? "/" : path;
			try {
				await adapter.remove(adapterPath);
			} catch {
				// Already gone, or was a directory (rename/unlink only ever
				// tracks file deletions above) — best-effort, matches
				// ObsidianFs's own tolerance of adapter quirks.
			}
			await maybeYield(yieldCounter);
		}
		this.deletions.clear();

		// Directories first, INCLUDING ones with no files under them at all
		// (e.g. `git_repository_init` creates empty `.git/objects/info` and
		// `.git/objects/pack`) — a real bug found while wiring `GitEngine`'s
		// getChangedFiles() re-hydration (see engine.ts's header comment on
		// why it resets+re-hydrates the mirror every call): flushing only
		// ever created a directory as an implicit side effect of writing a
		// FILE into it, so a purely-empty directory was silently never
		// persisted to the adapter at all — invisible on the very first
		// hydrate-at-construction/flush-at-teardown lifecycle (nothing ever
		// re-read the adapter afterwards), but fatal the moment a caller
		// resets and re-hydrates the SAME mirror from the adapter later
		// (`git_odb_open`'s "failed to load object database in
		// '.../objects/'" once those directories silently didn't come back).
		// `adapter.mkdir` is expected to be recursive (see `ObsidianFs`'s own
		// doc comment: "DataAdapter.mkdir is recursive on all platforms"), so
		// iteration order here doesn't need to be parent-before-child.
		for (const [path, entry] of this.entries) {
			if (entry.kind !== "dir" || path === "") continue;
			if (!(await adapter.exists(path))) {
				await adapter.mkdir(path);
			}
			await maybeYield(yieldCounter);
		}

		for (const [path, entry] of this.entries) {
			if (entry.kind !== "file" || !entry.dirty) continue;
			const adapterPath = path === "" ? "/" : path;
			const parent = parentOf(path);
			if (parent !== "" && !(await adapter.exists(parent))) {
				await adapter.mkdir(parent);
			}
			await adapter.writeBinary(adapterPath, entry.data.slice().buffer);
			entry.dirty = false;
			await maybeYield(yieldCounter);
		}
	}
}

// ---------------------------------------------------------------------------
// Classic Emscripten FS backend — real, mounted, and tested against the
// compiled module (see tests/libgit2/fs-backend-mount.test.ts)
// ---------------------------------------------------------------------------

/**
 * Emscripten's classic (non-WasmFS) filesystem lets a custom backend be
 * mounted via `FS.mount(backendModule, opts, mountpoint)`, where
 * `backendModule` provides `mount(mount)` returning a root node, plus
 * `node_ops` and `stream_ops` objects whose methods `FS`'s internal
 * dispatch calls synchronously.
 *
 * Everything in this section was corrected against the ACTUAL compiled
 * `build/dist/halyard-libgit2.js` glue — not Emscripten's upstream source,
 * which this build doesn't vendor a copy of — by reading the real, minified
 * `FS`/`MEMFS`/`NODEFS` implementations bundled into that file directly
 * (`node -e "require('...halyard-libgit2.js')..."` plus literal string
 * searches for `createNode(parent`, `stream_ops:{`, etc. — see this
 * project's phase notes / README for the exact commands). Several real,
 * consequential corrections came out of that versus the original
 * (unexecuted) scaffolding this replaced:
 *
 *   1. **`node_ops.lookup`/`mknod` must return a REAL `FS.FSNode`**, created
 *      via the generic `FS.createNode(parent, name, mode, dev)` (confirmed:
 *      this generic constructor exists distinctly from each backend's own
 *      `createNode` helper — MEMFS and NODEFS both call it internally and
 *      then assign `.node_ops`/`.stream_ops` themselves), not a bare
 *      `{ path }` object as the original scaffolding assumed. A node's mode
 *      bits (`S_IFDIR`/`S_IFREG`/`S_IFLNK` — genuine POSIX `st_mode`
 *      constants, confirmed via `FS.isDir`/`isFile`/`isLink`'s own
 *      `(mode&61440)===16384/32768/40960` checks in the compiled glue) must
 *      be set correctly, since `FS.mkdir`/`FS.mknod` dispatch on them.
 *   2. **`mknod` is the ONLY creation entry point for both files AND
 *      directories** — there is no separate `node_ops.mkdir`.
 *      `FS.mkdir(path, mode)` is real sugar for
 *      `FS.mknod(path, mode | S_IFDIR, 0)`, which resolves the parent and
 *      calls `parent.node_ops.mknod(parent, name, mode, dev)` — confirmed
 *      against both MEMFS's and NODEFS's real `mknod`, which branch on
 *      `FS.isDir(mode)` internally. The original scaffolding's `mknod`
 *      unconditionally wrote a (possibly zero-byte) *file*, which would have
 *      silently broken every directory creation once actually mounted.
 *   3. **`readdir` must NOT prepend `"."`/`".."`** — confirmed by reading
 *      NODEFS's real `readdir` (`return fs.readdirSync(path)`, Node's own
 *      `readdirSync` never includes dot-entries) and independently by the
 *      fact that `filter-smoke.test.ts`/`asyncify-double-suspension.test.ts`
 *      already pass real add→commit→checkout/fetch cycles through NODEFS
 *      without them. The original scaffolding's `[".", "..", ...]` prefix
 *      was untested and, per this evidence, wrong for what libgit2 actually
 *      needs.
 *   4. **`stream_ops.open`/`close`/`dup` are OPTIONAL and can be omitted** —
 *      confirmed by reading MEMFS's real `stream_ops`, which defines only
 *      `read`/`write`/`llseek`/`mmap`/`msync` (no `open`/`close`/`dup` at
 *      all — those exist on NODEFS only because NODEFS needs a real host fd
 *      to `open`/`close`). Since `VaultMirror`'s I/O is already
 *      synchronous/in-memory with no fd to manage, this backend omits them
 *      the same way MEMFS does.
 *   5. **`mmap`/`msync` are NOT implemented here** — MEMFS's real `mmap`
 *      reaches into `mmapAlloc`/`HEAP8`, internal Emscripten globals this
 *      build does not export to `Module`. Every operation this phase's test
 *      actually exercises (`git_repository_init`, `git_index_add_bypath`,
 *      `git_commit_create`, `git_checkout_head`) works without it — real
 *      evidence, not a guess — but a future caller whose libgit2 call graph
 *      needs to `mmap` a file through this mount (e.g. reading a large
 *      existing pack file) will hit `FS.checkOpExists`'s generic
 *      "unimplemented op" `ErrnoError` until this gap is closed. Flagged
 *      explicitly rather than silently omitted.
 *   6. **`node_ops.rename` must update BOTH `node.mirrorPath` AND
 *      `node.name`** — see `FsNode.name`'s own doc comment for the exact,
 *      real `GIT_ELOCKED` bug (`git_repository_init` failing on its very
 *      first config-file lock/write/rename cycle) this fixes, and why:
 *      FS's generic top-level `rename()` re-caches the renamed node under
 *      whatever `.name` it has *after* this backend's `rename` returns, so
 *      leaving `.name` stale poisons that cache for every later lookup of
 *      the old path. Confirmed by first reproducing the exact failure
 *      against a minimal from-scratch (non-`VaultMirror`) backend with
 *      per-call logging, then confirming the one-line fix resolved it,
 *      before applying the same fix here — see this repo's phase notes for
 *      the full reproduction.
 *
 * `errnoCodes` (below) is intentionally NOT hardcoded from reading the glue
 * — see `deriveErrnoCodes`'s own header comment for why these are derived
 * by probing the real, running module instead.
 */

/** The subset of Emscripten's `Module.FS` surface this backend needs beyond
 * `ErrnoError` — confirmed present on the real compiled module (see the
 * section header comment above for how). */
export interface EmscriptenFsGlobals {
	ErrnoError: new (errno: number) => Error & { errno: number };
	/** Generic node constructor — `FS.createNode(parent, name, mode, dev)`.
	 * Distinct from any one backend's own same-named helper (MEMFS/NODEFS
	 * each wrap this and then assign `node_ops`/`stream_ops`, which is
	 * exactly what this backend's `mount`/`lookup`/`mknod` do too). */
	createNode(parent: FsNode | null, name: string, mode: number, dev: number): FsNode;
	isDir(mode: number): boolean;
}

/** A table of filesystem callbacks FS invokes on a node — see `FsNode`. */
export type FsOpTable = Record<string, (...args: never[]) => unknown>;

/** An Emscripten `FS.FSNode` instance, structurally — real fields
 * (`mode`, `node_ops`, `stream_ops`) plus one custom field this backend
 * adds (`mirrorPath`, this mount's own bookkeeping of which `VaultMirror`
 * path the node corresponds to; real backends do the analogous thing —
 * NODEFS recomputes a real host path by walking `.parent`/`.name` instead,
 * but storing it directly is simpler and just as correct here since we
 * always know the path at node-creation time). */
export interface FsNode {
	mode: number;
	/** Real Emscripten `FSNode`s carry this; `rename` below MUST update it
	 * (see that method's comment) — a real bug found while testing this
	 * against the compiled module: FS's generic top-level `rename()` (which
	 * every syscall trap ultimately goes through) re-inserts the renamed
	 * node into its own internal name/hash cache using whatever `node.name`
	 * currently is, AFTER calling this backend's `node_ops.rename` but
	 * BEFORE returning — if this backend doesn't update `.name` itself, the
	 * node ends up cached under its OLD name forever, so a later, unrelated
	 * lookup for that old (now-deleted-from-VaultMirror) path gets a cache
	 * HIT instead of correctly missing, entirely bypassing this backend's
	 * own `node_ops.lookup`/`getattr`. Concretely: `git_repository_init`
	 * failed with `GIT_ELOCKED` ("failed to lock file
	 * '.git/config.lock' for writing") because after the FIRST successful
	 * config-lock-write-rename cycle, libgit2's OWN internal
	 * `git_fs_path_exists('.git/config.lock')` pre-check (before a SECOND,
	 * unrelated lock attempt elsewhere in init) got a false positive from
	 * this exact stale-cache-key bug. */
	name: string;
	/** The op tables FS assigns to every node it hands back (see
	 * `describeClassicFsBackend`). Typed loosely on purpose: FS calls these
	 * from its own syscall traps, this backend only ever *installs* them, and
	 * Emscripten's own backends each carry a different subset — so a precise
	 * signature here would describe FS's internals rather than this
	 * backend's contract. The tables this backend actually builds are fully
	 * typed at their definition site. */
	node_ops: FsOpTable;
	stream_ops: FsOpTable;
	mirrorPath?: string;
}

/** Genuine POSIX `st_mode` file-type bits (`S_IFDIR`/`S_IFREG`/`S_IFLNK`) —
 * confirmed against the compiled glue's own `FS.isDir`/`isFile`/`isLink`
 * (`(mode & 0o170000) === 0o040000/0o100000/0o120000`). Unlike the errno
 * table, these are standard POSIX values Emscripten does not remap, so
 * hardcoding them here (unlike `VaultMirrorErrorCode`'s numbers) is safe. */
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

export interface ClassicFsBackendGlobals extends EmscriptenFsGlobals {
	/** Emscripten's runtime errno table, mapping symbolic codes to that
	 * runtime's actual (non-POSIX) integers — see `deriveErrnoCodes`. */
	errnoCodes: Record<FsBackendErrnoCode, number>;
	/**
	 * Backing for `mmap`/`msync` (see `stream_ops.mmap`'s doc comment below
	 * for why these were added this phase, and exactly what real gap they
	 * close). Both optional: omitting them keeps the old, documented
	 * behavior (an `ENOSYS`-shaped failure on any `mmap` attempt) for any
	 * existing caller that doesn't provide them — e.g.
	 * `tests/libgit2/fs-backend-mount.test.ts`, whose init/stage/commit/
	 * checkout cycle never needed `mmap` and predates this addition.
	 *
	 * `getHeapU8` is a live GETTER, not a snapshot: Emscripten's `HEAPU8`
	 * typed array is reassigned to a new buffer on WASM memory growth
	 * (confirmed by reading the compiled glue's `updateMemoryViews()`), so
	 * caching a single `Uint8Array` reference at construction time would
	 * silently start writing into a detached, stale buffer the moment the
	 * heap ever grows after this backend is built.
	 */
	malloc?: (size: number) => number;
	getHeapU8?: () => Uint8Array;
}

/**
 * Empirically derives `errnoCodes` by provoking real failures against a
 * throwaway MEMFS scratch directory on the SAME running module `Module.FS`
 * belongs to — rather than hardcoding numbers read out of one specific
 * compiled build (this build's numbers were confirmed to be
 * `{ENOENT:44, EEXIST:20, ENOTDIR:54, EISDIR:31, ENOTEMPTY:55, EIO:29,
 * ENOSYS:52}` by literally decompiling `build/dist/halyard-libgit2.js`, but
 * per `VaultMirrorErrorCode`'s own header comment, trusting a hand-copied
 * number with no compiler/runtime to check it against is exactly the
 * "guessed ABI detail" this project's honesty standard warns against —
 * these numbers come from Emscripten's bundled musl errno table, which is
 * NOT POSIX-standard and DOES shift across Emscripten versions/configs).
 *
 * `ENOENT`/`EEXIST`/`ENOTDIR`/`EISDIR`/`ENOTEMPTY` are derived by actually
 * triggering each condition against MEMFS (present in every Emscripten
 * classic-FS build, confirmed via `Module.FS.filesystems.MEMFS`) and reading
 * the resulting `ErrnoError.errno`. `EIO` and `ENOSYS` could not be
 * triggered this way without deep, version-fragile spelunking (no MEMFS
 * operation reliably produces either — verified by trying `readlink` on a
 * regular file, which gives `EINVAL`, not `ENOSYS`, and by there being no
 * natural way to force a real I/O failure out of an in-memory backend), so
 * those two fall back to the values confirmed by the decompilation above,
 * with this comment as the explicit, honest caveat for whoever rebuilds
 * against a different Emscripten version: if this mount's error mapping
 * ever looks wrong specifically for an `ENOSYS`/`EIO` case (e.g. the
 * deliberate `symlink`/`readlink` rejection below), re-derive these two by
 * decompiling the new build the same way, or find a reliable MEMFS-level
 * trigger for them.
 */
export function deriveErrnoCodes(Module: {
	FS: {
		mkdir(path: string): void;
		writeFile(path: string, data: string): void;
		rmdir(path: string): void;
		unlink(path: string): void;
		stat(path: string): unknown;
		readlink(path: string): unknown;
	};
}): Record<FsBackendErrnoCode, number> {
	const probe = (fn: () => void): number => {
		try {
			fn();
			throw new Error("deriveErrnoCodes: probe unexpectedly did not throw");
		} catch (err) {
			const errno = (err as { errno?: number }).errno;
			if (typeof errno !== "number") throw err;
			return errno;
		}
	};

	const FS = Module.FS;
	const root = "/__halyard_errno_probe__";
	FS.mkdir(root);
	FS.mkdir(`${root}/dir`);
	FS.writeFile(`${root}/file`, "x");
	FS.mkdir(`${root}/nonempty`);
	FS.writeFile(`${root}/nonempty/f`, "x");

	const codes: Record<FsBackendErrnoCode, number> = {
		ENOENT: probe(() => FS.stat(`${root}/does-not-exist`)),
		EEXIST: probe(() => FS.mkdir(`${root}/dir`)),
		ENOTDIR: probe(() => FS.mkdir(`${root}/file/child`)),
		EISDIR: probe(() => FS.unlink(`${root}/dir`)),
		ENOTEMPTY: probe(() => FS.rmdir(`${root}/nonempty`)),
		EINVAL: probe(() => FS.readlink(`${root}/file`)),
		// See header comment: not reliably triggerable via MEMFS, so these
		// two are the decompiled, cited fallback values for this build.
		EIO: 29,
		ENOSYS: 52,
	};

	return codes;
}

/**
 * Builds a real, mountable classic-FS backend (`mount`/`node_ops`/
 * `stream_ops`) wired to `mirror`. Pass the result to
 * `Module.FS.mount(backend, opts, mountpoint)` — see
 * `tests/libgit2/fs-backend-mount.test.ts` for a real, passing
 * mount→add→commit→checkout→flush cycle through this exact function against
 * the compiled module (not NODEFS).
 */
export function describeClassicFsBackend(mirror: VaultMirror, globals: ClassicFsBackendGlobals) {
	const rethrow = (err: unknown): never => {
		if (err instanceof VaultMirrorError) {
			throw new globals.ErrnoError(globals.errnoCodes[err.code]);
		}
		throw new globals.ErrnoError(globals.errnoCodes.EIO);
	};

	function childPath(parent: FsNode, name: string): string {
		const parentPath = parent.mirrorPath ?? "";
		return parentPath === "" ? name : `${parentPath}/${name}`;
	}

	function attach(node: FsNode, path: string): FsNode {
		node.mirrorPath = path;
		node.node_ops = node_ops;
		node.stream_ops = stream_ops;
		return node;
	}

	const node_ops = {
		getattr(node: FsNode) {
			try {
				const stat = mirror.stat(node.mirrorPath ?? "");
				const mtime = new Date(stat.mtimeMs);
				const ctime = new Date(stat.ctimeMs);
				return {
					dev: 0,
					ino: 0,
					mode: node.mode,
					nlink: 1,
					uid: 0,
					gid: 0,
					rdev: 0,
					size: stat.size,
					atime: mtime,
					mtime,
					ctime,
					blksize: 4096,
					blocks: Math.ceil(stat.size / 4096),
				};
			} catch (err) {
				return rethrow(err);
			}
		},
		setattr(node: FsNode, attr: { mode?: number; size?: number }) {
			if (attr.mode !== undefined) node.mode = attr.mode;
			if (attr.size !== undefined) {
				const path = node.mirrorPath ?? "";
				try {
					const existing = mirror.has(path) ? mirror.readFile(path) : new Uint8Array(0);
					const resized = new Uint8Array(attr.size);
					resized.set(existing.subarray(0, Math.min(existing.byteLength, attr.size)));
					mirror.writeFile(path, resized);
				} catch (err) {
					rethrow(err);
				}
			}
		},
		lookup(parent: FsNode, name: string) {
			const path = childPath(parent, name);
			if (!mirror.has(path)) throw new globals.ErrnoError(globals.errnoCodes.ENOENT);
			const isDir = mirror.stat(path).isDirectory;
			const node = globals.createNode(parent, name, (isDir ? S_IFDIR : S_IFREG) | 0o777, 0);
			return attach(node, path);
		},
		mknod(parent: FsNode, name: string, mode: number, dev: number) {
			const path = childPath(parent, name);
			try {
				if (globals.isDir(mode)) mirror.mkdir(path);
				else mirror.writeFile(path, new Uint8Array(0));
			} catch (err) {
				return rethrow(err);
			}
			const node = globals.createNode(parent, name, mode, dev);
			return attach(node, path);
		},
		unlink(parent: FsNode, name: string) {
			try {
				mirror.unlink(childPath(parent, name));
			} catch (err) {
				rethrow(err);
			}
		},
		rmdir(parent: FsNode, name: string) {
			try {
				mirror.rmdir(childPath(parent, name));
			} catch (err) {
				rethrow(err);
			}
		},
		rename(oldNode: FsNode, newParent: FsNode, newName: string) {
			const to = childPath(newParent, newName);
			try {
				mirror.rename(oldNode.mirrorPath ?? "", to);
				oldNode.mirrorPath = to;
				// MUST update `.name` too — see FsNode.name's doc comment for
				// the real GIT_ELOCKED bug this fixes.
				oldNode.name = newName;
			} catch (err) {
				rethrow(err);
			}
		},
		readdir(node: FsNode) {
			try {
				return mirror.readdir(node.mirrorPath ?? "");
			} catch (err) {
				return rethrow(err);
			}
		},
		// `node_ops.symlink`'s real signature is `(parent, newName, oldpath)`
		// — confirmed against NODEFS's own `symlink(parent,newName,oldpath)`.
		symlink(parent: FsNode, name: string, target: string) {
			try {
				mirror.symlink(target, childPath(parent, name));
			} catch (err) {
				rethrow(err);
			}
		},
		// NOT a passthrough to `mirror.readlink()` (which unconditionally
		// throws ENOSYS — VaultMirror has no symlink concept at all): a real
		// bug found while testing this against the compiled module.
		// `git_repository_init` itself failed ("failed to resolve path
		// '/repo/.git/': Function not implemented", i.e. ENOSYS) because
		// libgit2's own path-resolution walk speculatively calls `readlink()`
		// on each existing path component to check whether it's a symlink to
		// follow — completely normal realpath-style behavior any real
		// filesystem's `readlink()` answers with ENOENT (missing) or EINVAL
		// (exists, but isn't a symlink), never ENOSYS (which means "this
		// filesystem/operation doesn't exist at all" and made libgit2 treat
		// the probe as a hard failure instead of "not a symlink, keep
		// going"). Since nothing in a `VaultMirror` is ever a symlink, an
		// existing path is always the EINVAL case.
		readlink(node: FsNode) {
			const path = node.mirrorPath ?? "";
			if (!mirror.has(path)) throw new globals.ErrnoError(globals.errnoCodes.ENOENT);
			throw new globals.ErrnoError(globals.errnoCodes.EINVAL);
		},
	};

	const stream_ops = {
		// No `open`/`close`/`dup` — optional, and unneeded for an in-memory
		// backend with no real fd; see the section header comment (point 4).
		read(
			stream: { node: FsNode },
			buffer: Uint8Array,
			offset: number,
			length: number,
			position: number
		): number {
			let data: Uint8Array;
			try {
				data = mirror.readFile(stream.node.mirrorPath ?? "");
			} catch (err) {
				return rethrow(err);
			}
			const end = Math.min(position + length, data.byteLength);
			const n = Math.max(0, end - position);
			if (n > 0) buffer.set(data.subarray(position, end), offset);
			return n;
		},
		write(
			stream: { node: FsNode },
			buffer: Uint8Array,
			offset: number,
			length: number,
			position: number
		): number {
			const path = stream.node.mirrorPath ?? "";
			let existing: Uint8Array;
			try {
				existing = mirror.has(path) ? mirror.readFile(path) : new Uint8Array(0);
			} catch {
				existing = new Uint8Array(0);
			}
			const end = position + length;
			const merged = new Uint8Array(Math.max(existing.byteLength, end));
			merged.set(existing);
			merged.set(buffer.subarray(offset, offset + length), position);
			try {
				mirror.writeFile(path, merged);
			} catch (err) {
				return rethrow(err);
			}
			return length;
		},
		llseek(stream: { position: number; node: FsNode }, offset: number, whence: number): number {
			// whence: 0 = SEEK_SET, 1 = SEEK_CUR, 2 = SEEK_END — standard
			// POSIX values, unlike the errno table these are NOT
			// runtime-specific, so hardcoding them here is safe (confirmed
			// against both MEMFS's and NODEFS's real `llseek`).
			let position = offset;
			if (whence === 1) position += stream.position;
			else if (whence === 2) {
				try {
					position += mirror.stat(stream.node.mirrorPath ?? "").size;
				} catch {
					// leave position as-is; a subsequent read/write will surface
					// the real error via its own mirror call.
				}
			}
			if (position < 0) throw new globals.ErrnoError(globals.errnoCodes.EIO);
			return position;
		},
		/**
		 * A real gap found and closed this phase, exactly where
		 * `fs-backend.ts`'s own prior-phase header comment predicted it
		 * would: a real network fetch into a `VaultMirror`-backed repo (as
		 * opposed to the NODEFS-backed fetch tests in
		 * `http-transport-auth.test.ts`) failed with libgit2's
		 * `git_indexer`/ODB machinery reporting "failed to mmap" — the
		 * incoming packfile gets `mmap`'d to build its `.idx`, and this
		 * backend had no `mmap`/`msync` at all (see this file's own header
		 * comment, point 5, from before this phase).
		 *
		 * Unlike MEMFS's real `mmap` (which reaches into Emscripten-internal
		 * `mmapAlloc`/`HEAP8` globals this build doesn't export to `Module`,
		 * per this file's header comment), this implementation doesn't need
		 * those: it just copies the requested byte range into a fresh
		 * `Module._malloc`'d buffer via `globals.malloc`/`globals.getHeapU8`
		 * (both already exported and used elsewhere — see `engine.ts`'s
		 * marshaling helpers) and always reports `allocated: true`, so `FS`'s
		 * generic `munmap` path always frees it rather than assuming it
		 * aliases the wasm heap directly (which it never does here). `msync`
		 * mirrors MEMFS's own real implementation: delegate straight to this
		 * backend's own `write` above.
		 *
		 * Falls back to the pre-existing "unimplemented" behavior when
		 * `malloc`/`getHeapU8` aren't provided (`ClassicFsBackendGlobals`
		 * marks them optional specifically so an existing caller that never
		 * needed `mmap` — e.g. `fs-backend-mount.test.ts` — isn't forced to
		 * wire them up).
		 */
		mmap(
			stream: { node: FsNode },
			length: number,
			position: number
		): { ptr: number; allocated: boolean } {
			if (!globals.malloc || !globals.getHeapU8) {
				throw new globals.ErrnoError(globals.errnoCodes.ENOSYS);
			}
			let data: Uint8Array;
			try {
				data = mirror.has(stream.node.mirrorPath ?? "")
					? mirror.readFile(stream.node.mirrorPath ?? "")
					: new Uint8Array(0);
			} catch (err) {
				return rethrow(err);
			}
			const ptr = globals.malloc(Math.max(length, 1));
			if (!ptr) throw new globals.ErrnoError(globals.errnoCodes.EIO);
			const slice = data.subarray(position, position + length);
			globals.getHeapU8().set(slice, ptr);
			return { ptr, allocated: true };
		},
		msync(
			stream: { node: FsNode },
			buffer: Uint8Array,
			offset: number,
			length: number,
			_mmapFlags: unknown
		): number {
			stream_ops.write(stream, buffer, 0, length, offset);
			return 0;
		},
	};

	return {
		mount(_mountInfo: { opts: unknown; mountpoint: string }): FsNode {
			const root = globals.createNode(null, "/", S_IFDIR | 0o777, 0);
			return attach(root, "");
		},
		node_ops,
		stream_ops,
	};
}
