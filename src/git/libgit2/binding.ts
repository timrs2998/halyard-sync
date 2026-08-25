/**
 * The libgit2-over-WASM binding contract: the minimal surface a compiled
 * libgit2 WASM module (see `build/`) exposes to TypeScript.
 * `src/git/libgit2/engine.ts` implements it; `src/git/engine.ts`'s
 * `GitEngine` is written against it.
 *
 * Every operation returns a Promise rather than wrapping libgit2's C API 1:1.
 * libgit2's entry points are synchronous (`int git_remote_fetch(...)`), but
 * every filesystem and network operation here is backed by Obsidian's
 * `DataAdapter` and `requestUrl`, which are Promise-based. Emscripten
 * Asyncify bridges the two (see `build/BUILD.md`), so the behavior observable
 * from JS is asynchronous regardless — the contract states that up front
 * instead of hiding it behind a synchronous-looking facade.
 *
 * `writeBlobAndStageOid` and the filter-registration surface exist to support
 * gitattributes filters, which is the capability this binding was built for.
 */

// ---------------------------------------------------------------------------
// Primitive scalar types
// ---------------------------------------------------------------------------

/** A 40-character lowercase hex SHA-1 object id. libgit2 is not built with
 * the experimental SHA-256 backend here. */
export type Oid = string;

/** A repo-relative path, forward slashes, no leading slash — what
 * `fs-adapter.ts`'s `toAdapterPath` normalizes to. */
export type RepoPath = string;

export interface Libgit2Author {
	name: string;
	email: string;
	/** Unix seconds. Omitted -> libgit2 uses wall-clock time at commit time. */
	time?: number;
	/** Minutes offset from UTC, matching `git_time.offset`. */
	offset?: number;
}

export class Libgit2Error extends Error {
	constructor(
		message: string,
		/** libgit2's negative `int` return code — `git2/errors.h`
		 * `git_error_code` (GIT_ENOTFOUND = -3, GIT_EEXISTS = -4,
		 * GIT_EMERGECONFLICT = -13). Kept raw rather than mapped to a string
		 * enum: callers match on the exact value to preserve libgit2
		 * semantics. */
		readonly code: number,
		/** libgit2's `git_error_klass` (e.g. GIT_ERROR_NET, GIT_ERROR_HTTP),
		 * from `git_error_last()->klass`. */
		readonly klass?: number
	) {
		super(message);
		this.name = "Libgit2Error";
	}
}

// ---------------------------------------------------------------------------
// Networking callbacks. The http-transport layer needs the credential-retry
// loop libgit2's own transports drive via `git_credential_acquire_cb`.
// ---------------------------------------------------------------------------

export interface Libgit2Credentials {
	username: string;
	password: string;
}

export type CredentialCallback = (
	url: string,
	usernameFromUrl: string | null,
	/** Bitmask of allowed credential types the transport will accept next —
	 * mirrors `git_credtype_t` passed into `git_credential_acquire_cb`. Only
	 * `GIT_CREDENTIAL_USERPASS_PLAINTEXT` (1) is relevant: this plugin is
	 * HTTPS-token-only. */
	allowedTypes: number
) => Libgit2Credentials | null | Promise<Libgit2Credentials | null>;

export type ProgressCallback = (stage: string, current: number, total: number) => void;
export type SidebandMessageCallback = (message: string) => void;

export interface NetworkCallbacks {
	onCredentials?: CredentialCallback;
	onProgress?: ProgressCallback;
	/** libgit2's sideband progress channel (`git_indexer_progress_cb` /
	 * remote message callback), carrying merge and fetch server messages. */
	onSidebandMessage?: SidebandMessageCallback;
}

// ---------------------------------------------------------------------------
// Repository lifecycle
// ---------------------------------------------------------------------------

export interface CloneOptions {
	url: string;
	/** Local path inside the mounted FS backend (see fs-backend.ts): the
	 * vault root. */
	dir: string;
	/** Branch to check out. Undefined -> the remote's HEAD. */
	ref?: string;
	/** git_fetch_options.depth. Shallow by default, to bound mobile memory. */
	depth?: number;
	/** Maps to fetching a single refspec instead of all branches — libgit2
	 * has no dedicated "singleBranch" flag; it's expressed as a refspec
	 * (`+refs/heads/<ref>:refs/remotes/<remote>/<ref>`) passed to
	 * `git_remote_fetch` during clone. */
	singleBranch?: boolean;
	remote?: string;
}

export interface InitOptions {
	dir: string;
	defaultBranch?: string;
}

// ---------------------------------------------------------------------------
// The binding surface
// ---------------------------------------------------------------------------

/**
 * One open repository handle. A real implementation wraps a `git_repository*`
 * living in WASM linear memory; this interface never exposes that pointer to
 * TS — every method here is the *only* legal way to touch it, so the
 * eventual engine rewrite can't accidentally leak or double-free a native
 * handle. `close()` must be called exactly once (maps to `git_repository_free`
 * + `git_libgit2_shutdown` bookkeeping) — see `Libgit2Module.openRepository`.
 */
export interface Libgit2Repository {
	// -- lifecycle / remote config -------------------------------------------

	/** `git_remote_create` plus persisting the URL into repo config
	 * (`remote.<name>.url`). `setConfig` remains available for setting the
	 * author identity separately. */
	addRemote(name: string, url: string, opts?: { force?: boolean }): Promise<void>;

	/** `git_config_set_string` on the repo's local config (`.git/config`):
	 * `user.name`, `user.email`, `remote.<x>.url`. */
	setConfig(key: string, value: string): Promise<void>;

	/** `git_config_get_string` (via `git_repository_config` +
	 * `git_config_get_entry`); returns null on `GIT_ENOTFOUND` rather than
	 * throwing. */
	getConfig(key: string): Promise<string | null>;

	// -- gitattributes filter detection (pure index/tree reads) --------------

	/** All repo-relative paths libgit2 believes are attribute-filterable
	 * with the given attribute (i.e. equivalent to walking the index and
	 * checking each path's `.gitattributes`-resolved `filter` value via
	 * `git_attr_get`). Reports every filter; deciding which are supported is
	 * the caller's job. */
	listPathsWithAttribute(attribute: string): Promise<Array<{ path: RepoPath; value: string }>>;

	// -- status / diff --------------------------------------------------------

	/** `git_status_list_new` + `git_status_byindex` for every entry,
	 * collected into a flat array (the WASM boundary makes an opaque
	 * `git_status_list*` handle plus a "get me entry N" API awkward to
	 * consume from TS relative to just returning the whole list once).
	 * `pathspec`/ignore filtering happens via `git_status_options.pathspec`
	 * and `GIT_STATUS_OPT_EXCLUDE_STANDARD | ...`, taking over the role of
	 * `createIgnoreFilter`'s `filter` callback in `getChangedFiles`. libgit2's
	 * status pathspec is glob-based and runs natively, so ignore globs pass
	 * through mostly as-is. */
	status(opts?: { pathspecs?: string[] }): Promise<StatusEntry[]>;

	// -- staging / commit ------------------------------------------------------

	/** `git_index_add_bypath`, or `git_index_remove_bypath` for deletions
	 * (the caller picks from the status entry), then `git_index_write`. */
	stagePath(path: RepoPath): Promise<void>;
	unstagePath(path: RepoPath): Promise<void>;

	/**
	 * Write `content` to the object database as a blob (`git_blob_create_from_buffer`)
	 * and insert a `git_index_entry` pointing directly at the resulting oid
	 * (`git_index_add`, not `git_index_add_bypath`) — bypassing the
	 * working-tree read/hash that `stagePath` performs.
	 *
	 * This exists for the git-crypt clean-filter path. The filter shim
	 * (`native/filter_shim.c`) encrypts content in JS via WebCrypto, so the
	 * *ciphertext* blob's oid must land in the index without libgit2
	 * re-reading the plaintext working-tree file and re-running the filter.
	 */
	writeBlobAndStageOid(path: RepoPath, content: Uint8Array): Promise<Oid>;

	/** `git_signature_new` (or `_now`) + `git_commit_create` against the
	 * current index tree and HEAD parent. Returns null when the index tree
	 * is unchanged from HEAD's tree (`git_index_write_tree` producing the
	 * same oid as `HEAD^{tree}`): the "nothing to commit" case. */
	commit(message: string, author: Libgit2Author): Promise<Oid | null>;

	// -- refs -------------------------------------------------------------

	/** `git_reference_name_to_id` on a fully-qualified ref
	 * (`refs/heads/<branch>`, `refs/remotes/<remote>/<branch>`, etc.);
	 * returns null on `GIT_ENOTFOUND` rather than throwing. */
	resolveRef(ref: string): Promise<Oid | null>;

	/** `git_reference_create` with `force`, used for
	 * `GitEngine.hardResetToRemote`'s branch-pointer move
	 * (`refs/heads/<branch>` -> the remote-tracking oid). */
	writeRef(ref: string, oid: Oid, opts?: { force?: boolean }): Promise<void>;

	/** `git_repository_head` + `git_reference_shorthand`; null for an
	 * unborn or detached HEAD. */
	currentBranch(): Promise<string | null>;

	// -- objects ------------------------------------------------------------

	/** `git_blob_lookup` + `git_blob_rawcontent`/`git_blob_rawsize`, but
	 * resolved from a `(commit-ish, path)` pair the way `readBlob` does
	 * resolved from a `(commit-ish, path)` pair rather than a blob oid:
	 * resolve `oid` to a commit, walk its tree for `filepath`, read that
	 * entry's blob. Saves every caller resolving the tree entry first. */
	readBlob(commitOid: Oid, path: RepoPath): Promise<Uint8Array>;

	/** `git_merge_base` over exactly two oids, the only arity `aheadBehind`
	 * needs. Null when there is no common ancestor — shallow history, or
	 * genuinely unrelated — which callers treat as "diverged". */
	findMergeBase(oidA: Oid, oidB: Oid): Promise<Oid | null>;

	/** `git_revwalk` seeded at `ref`, topological order, collecting oids
	 * until exhausted or `until` is reached, checked per-oid. No default
	 * depth limit: `aheadBehind` needs the true count, so bounding the walk
	 * is the caller's job. */
	log(ref: string, opts?: { until?: Oid }): Promise<Oid[]>;

	// -- merge / checkout ---------------------------------------------------

	/**
	 * `git_merge` (analysis + merge trees) followed by `git_index_write` and
	 * either a fast-forward ref move or `git_commit_create` with two
	 * parents, mirroring `GitEngine.mergeUpstream`'s branch on
	 * `result.fastForward` / `result.alreadyMerged`. Conflicts are reported,
	 * never auto-resolved with markers written into the working tree —
	 * `MergeOutcome`'s `"conflict"` case corresponds to libgit2 leaving the
	 * index in a conflicted state (`git_index_conflict_iterator`) *without*
	 * this binding checking anything out. Checkout is a separate explicit
	 * call, so a conflicted merge can never dirty the working tree.
	 *
	 * `favor` maps to `git_merge_options.file_favor`
	 * (`GIT_MERGE_FILE_FAVOR_*`) — `"normal"` (default) is the behavior
	 * described above: an overlapping hunk is a real conflict. `"union"`
	 * is a genuinely different behavior, not a conflict-resolution
	 * strategy: an overlapping hunk is never a conflict at all, it just
	 * concatenates both sides' distinct lines into the merged file. A
	 * `"union"` merge can therefore never produce `MergeOutcome`'s
	 * `"conflict"` case — see `HalyardSyncSettings.autoMergeOverlappingEdits`'s
	 * doc comment for why this is opt-in and off by default.
	 */
	merge(
		ours: string,
		theirs: string,
		author: Libgit2Author,
		opts?: { favor?: MergeFileFavor }
	): Promise<MergeOutcome>;

	/** `git_checkout_tree` + `git_repository_set_head`, `GIT_CHECKOUT_FORCE`
	 * when `force` is set — same as engine.ts's post-merge/hard-reset
	 * checkout calls. */
	checkout(ref: string, opts?: { force?: boolean }): Promise<void>;

	// -- network ------------------------------------------------------------

	/** `git_remote_fetch` against the given refspec (or the remote's
	 * configured refspecs when `branch` is omitted); `tags: false` always
	 * (`GIT_REMOTE_DOWNLOAD_TAGS_NONE`), matching engine.ts's `fetch()`.
	 * `depth` maps to `git_fetch_options.depth` (`GIT_FETCH_DEPTH_FULL`/`0`
	 * when omitted) — previously accepted by `CloneOptions.depth` but never
	 * actually threaded down to this call, so every clone silently fetched
	 * full history regardless of the requested depth. Only `clone()` passes
	 * a non-default value today; ordinary incremental sync fetches
	 * deliberately keep requesting full depth (0) — re-shallowing on every
	 * fetch risks losing the merge-base commit `mergeUpstream`'s three-way
	 * merge needs when the remote has advanced by more than `depth` commits
	 * since the last sync. */
	fetch(remote: string, branch?: string, net?: NetworkCallbacks, depth?: number): Promise<FetchSummary>;

	/** `git_remote_push` with a single `+refs/heads/<ref>:refs/heads/<remoteRef>`
	 * refspec (`force` prefixes it with `+`), matching engine.ts's `push()`. */
	push(remote: string, opts?: PushOptions, net?: NetworkCallbacks): Promise<void>;

	/** Releases the underlying `git_repository*` (and any cached objects).
	 * Must be called exactly once per `openRepository`/`clone`/`init` result. */
	close(): Promise<void>;
}

export interface StatusEntry {
	path: RepoPath;
	/** Raw `git_status_t` bitmask (see libgit2's `git2/status.h`): bits 0-4
	 * are INDEX_{NEW,MODIFIED,DELETED,RENAMED,TYPECHANGE} (1<<0 .. 1<<4),
	 * bits 7-12 are WT_{NEW,MODIFIED,DELETED,TYPECHANGE,RENAMED,UNREADABLE}
	 * (1<<7 .. 1<<12), bit 14 IGNORED (1<<14), bit 15 CONFLICTED (1<<15).
	 * Exposed raw rather than decoded into engine.ts's `ChangeStatus` union:
	 * `classifyStatusRow` must distinguish index dirt from worktree dirt, and
	 * decoding here would discard that. */
	statusFlags: number;
}

export const GIT_STATUS = {
	CURRENT: 0,
	INDEX_NEW: 1 << 0,
	INDEX_MODIFIED: 1 << 1,
	INDEX_DELETED: 1 << 2,
	INDEX_RENAMED: 1 << 3,
	INDEX_TYPECHANGE: 1 << 4,
	WT_NEW: 1 << 7,
	WT_MODIFIED: 1 << 8,
	WT_DELETED: 1 << 9,
	WT_TYPECHANGE: 1 << 10,
	WT_RENAMED: 1 << 11,
	WT_UNREADABLE: 1 << 12,
	IGNORED: 1 << 14,
	CONFLICTED: 1 << 15,
} as const;

export type MergeOutcome =
	| { kind: "uptodate" }
	| { kind: "fastforward"; oid: Oid }
	| { kind: "merged"; oid: Oid }
	| { kind: "conflict"; paths: RepoPath[] };

/** See `Libgit2Repository.merge()`'s doc comment for what `"union"` actually
 * does — it is not a conflict-resolution strategy, it changes whether an
 * overlapping hunk is a conflict at all. */
export type MergeFileFavor = "normal" | "union";

export interface PushOptions {
	ref?: string;
	remoteRef?: string;
	force?: boolean;
}

export interface FetchSummary {
	/** New and updated refs after the fetch,
	 * `refs/remotes/<remote>/<branch>` -> oid. */
	updatedRefs: Record<string, Oid>;
}

export interface RemoteRefInfo {
	ref: string;
	oid: Oid;
}

// ---------------------------------------------------------------------------
// Module-level entry points
// ---------------------------------------------------------------------------

/**
 * The compiled-module surface: constructing and opening repositories, plus
 * the one network primitive (`listRemoteRefs`) that needs only a URL.
 */
export interface Libgit2Module {
	clone(options: CloneOptions, net?: NetworkCallbacks): Promise<Libgit2Repository>;
	/** `git_repository_init`. Kept module-level so "open a fresh repo" is
	 * symmetric with `clone`; remote and config setup are separate calls. */
	init(options: InitOptions): Promise<Libgit2Repository>;
	/** `git_repository_open` against a `dir` that already contains `.git`,
	 * e.g. an app restart over an existing clone. libgit2 needs this
	 * explicitly: `git_repository*` handles are never implicit. */
	openRepository(dir: string): Promise<Libgit2Repository>;

	/** `git_remote_create` (detached, no repo) + `git_remote_ls`, matching
	 * `GitEngine.listRemoteRef`'s cheap check: one small HTTPS request, no
	 * pack transfer. Returns every advertised ref under `prefix`. */
	listRemoteRefs(url: string, prefix: string, net?: NetworkCallbacks): Promise<RemoteRefInfo[]>;

	/**
	 * Registers the git-crypt-compatible clean/smudge filter
	 * (`native/filter_shim.c`'s `git_filter_register` call, exposed here so
	 * TS controls *when* it is active rather than it being live from module
	 * load). The crypto callbacks it dispatches to
	 * (`native/filter_shim.c`'s `__gitcrypt_encrypt` / `__gitcrypt_decrypt`
	 * EM_JS declarations) are supplied by `src/git/gitcrypt.ts` via `hooks`.
	 */
	registerGitCryptFilter(hooks: GitCryptFilterHooks): Promise<void>;

	/** `git_filter_unregister("git-crypt")` — mostly for tests that need a
	 * clean module state between cases. */
	unregisterGitCryptFilter(): Promise<void>;
}

/**
 * The JS-side of the seam `native/filter_shim.c` calls into via `EM_JS`. See
 * that file's header comment for the exact C signatures this must satisfy
 * once compiled; this TS shape is what the (future) implementation of
 * `Libgit2Module.registerGitCryptFilter` hands to the WASM glue, which then
 * installs it as the global(s) the `EM_JS` blocks call by name.
 *
 * Both functions are async here (WebCrypto's `SubtleCrypto` is
 * Promise-based) — reconciling that with the filter's synchronous C
 * callback signature is the Asyncify bridging documented in
 * `native/filter_shim.c` and flagged as a risk in `build/BUILD.md`.
 */
export interface GitCryptFilterHooks {
	/** Clean (worktree -> odb): encrypt plaintext before it's written into a
	 * blob. `keyName` is the git-crypt key name from `.gitattributes`
	 * (`filter=git-crypt-<keyName>`), "" for the default unnamed key. */
	encrypt(keyName: string, plaintext: Uint8Array): Promise<Uint8Array>;
	/** Smudge (odb -> worktree): decrypt ciphertext read from a blob. */
	decrypt(keyName: string, ciphertext: Uint8Array): Promise<Uint8Array>;
}
