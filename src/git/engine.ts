/**
 * GitEngine — a mechanism-only wrapper around the libgit2-over-WASM binding
 * (`src/git/libgit2/engine.ts`) for a vault repo. Policy — scheduling,
 * conflict strategy, auth flows — lives elsewhere; this class only performs
 * git operations against the injected module, mirror, and adapter.
 *
 * ---------------------------------------------------------------------------
 * Repository lifecycle
 * ---------------------------------------------------------------------------
 *
 * libgit2 requires an explicit lifecycle: a `Libgit2Repository` handle is
 * opened once and freed once. `GitEngine` hides that behind `ensureRepo()`
 * (opens `.git` lazily on first use) and `close()`. Construction goes through
 * the async `createGitEngine(...)` factory below, because loading the
 * compiled WASM module is unavoidably asynchronous (see `libgit2/loader.ts`).
 *
 * ---------------------------------------------------------------------------
 * VaultMirror re-hydration (read this before touching getChangedFiles)
 * ---------------------------------------------------------------------------
 *
 * `VaultMirror` (see `libgit2/fs-backend.ts`) is an in-memory mirror of the
 * vault, mounted once into the WASM module's classic FS for this engine's
 * whole lifetime (which can span many sync cycles — the engine is cached in
 * `main.ts`, not rebuilt every sync). Direct Obsidian edits to notes made
 * BETWEEN sync cycles never go through any git operation, so they'd never
 * reach the in-memory mirror on their own. `getChangedFiles()` therefore
 * resets and re-hydrates the mirror from the real adapter immediately before
 * scanning — the "populate" half of the IDBFS-style `syncfs` pattern
 * `fs-backend.ts`'s header comment describes, done once per sync rather than
 * once per engine construction. Every mutating method flushes back to the
 * adapter afterwards (the "persist" half) so Obsidian's normal (non-git)
 * view of the vault sees the result immediately, not just at engine
 * teardown.
 */

import {
	type GitCryptFilterHooks,
	type Libgit2Author,
	type Libgit2Module,
	type Libgit2Repository,
	Libgit2Error,
	GIT_STATUS,
	type NetworkCallbacks,
	type StatusEntry,
} from "./libgit2/binding";
import {
	VaultMirror,
	deriveErrnoCodes,
	describeClassicFsBackend,
	type ClassicFsBackendGlobals,
	type FsNode,
} from "./libgit2/fs-backend";
import type { NativeModule } from "./libgit2/native-module";
import type { DataAdapterLike } from "./fs-adapter";
import type { RequestUrlLike } from "./http-client";
import { decryptBlob, encryptBlob } from "./gitcrypt";
import type { GitCryptKeyMaterial } from "../auth/secrets";

// ---------------------------------------------------------------------------
// Ignore filter (pure)
// ---------------------------------------------------------------------------

/**
 * Files that must never be synced: workspace layout churns on every app
 * launch and is device-specific; .trash is Obsidian's local recycle bin.
 *
 * Takes the config folder (`Vault#configDir`) rather than assuming Obsidian's
 * default name for it: a vault whose config folder was renamed would
 * otherwise sync its workspace files on every app launch.
 */
export function defaultIgnores(configDir: string): string[] {
	return [`${configDir}/workspace`, ".trash/"];
}

/** The workspace-ignore line `main.ts`'s `seedGitignore` writes. */
function workspaceIgnoreLine(configDir: string): string {
	return `${configDir}/workspace*`;
}

/**
 * Repoints a stale workspace-ignore line at the vault's real configuration
 * folder. Older versions wrote this line with Obsidian's default folder name
 * baked in, so a vault whose config folder is named anything else has been
 * syncing its workspace files ever since. Returns null when there is nothing
 * to do, so the caller can skip the write entirely.
 *
 * Matches on the line's shape (`<something>/workspace*`) rather than on the
 * specific name older versions used, which keeps the plugin from having to
 * carry a hardcoded config-folder name around at all. Deliberately narrow: it
 * rewrites nothing when the file already carries the correct line — a vault
 * also opened on a machine that does use the default name may legitimately
 * want both — and it leaves every other line untouched.
 */
export function migrateWorkspaceIgnoreLine(contents: string, configDir: string): string | null {
	const wanted = workspaceIgnoreLine(configDir);
	const isWorkspaceIgnore = (line: string) => /^[^/\s][^/]*\/workspace\*$/.test(line.trim());
	const lines = contents.split("\n");
	if (lines.some((line) => line.trim() === wanted)) return null;
	if (!lines.some((line) => isWorkspaceIgnore(line))) return null;
	return lines.map((line) => (isWorkspaceIgnore(line) ? wanted : line)).join("\n");
}

/**
 * Glob-ish matcher, deliberately dependency-free:
 *   - "dir/"     -> that directory and everything under it
 *   - "prefix*"  -> path prefix match
 *   - "*.suffix" -> path suffix match
 *   - "plain"    -> prefix match (so "<configDir>/workspace" also covers
 *                   "<configDir>/workspace.json" / "workspace-mobile.json")
 */
function matchPattern(pattern: string, filepath: string): boolean {
	if (pattern.endsWith("/")) {
		return (
			filepath === pattern.slice(0, -1) || filepath.startsWith(pattern)
		);
	}
	if (pattern.startsWith("*")) {
		return filepath.endsWith(pattern.slice(1));
	}
	if (pattern.endsWith("*")) {
		return filepath.startsWith(pattern.slice(0, -1));
	}
	return filepath.startsWith(pattern);
}

/**
 * `defaultIgnores` plus (when supplied) the calling plugin's own `data.json`
 * — see `GitEngineOptions.ownDataPath`'s doc comment for why this can't just
 * be a user-editable ignore glob.
 */
function defaultIgnoresFor(configDir: string, ownDataPath?: string): string[] {
	const defaults = defaultIgnores(configDir);
	return ownDataPath !== undefined ? [...defaults, ownDataPath] : defaults;
}

export function createIgnoreFilter(
	userGlobs: string[],
	defaults: string[]
): (filepath: string) => boolean {
	const patterns = [...defaults, ...userGlobs]
		.map((p) => p.replace(/\\/g, "/").replace(/^\.?\//, "").trim())
		.filter((p) => p.length > 0);
	return (filepath) => patterns.some((p) => matchPattern(p, filepath));
}

// ---------------------------------------------------------------------------
// status() classification (pure) — operates on libgit2's StatusEntry bitmask.
// ---------------------------------------------------------------------------

export type ChangeStatus = "added" | "modified" | "deleted";

export interface ChangedFile {
	path: string;
	status: ChangeStatus;
}

/**
 * Classify one `StatusEntry` into the staging action needed to make the
 * index mirror the working tree. Deliberately only inspects the WT_* bits
 * (worktree vs index) rather than also branching on INDEX_* (index vs HEAD):
 * anything already staged-but-uncommitted is already reflected in the index
 * `commit()` reads directly (via `git_index_write_tree`), so it needs no
 * action here regardless of these bits — this function's only job is
 * "what, if anything, needs to be (re)staged from the working tree,"
 * matching `classifyStatusRow`'s old behavior of skipping when
 * workdir === HEAD (mirrored here as "no WT_* bit set").
 */
export function classifyStatusEntry(entry: StatusEntry): ChangeStatus | null {
	const f = entry.statusFlags;
	if (f & GIT_STATUS.WT_NEW) return "added";
	if (f & GIT_STATUS.WT_DELETED) return "deleted";
	if (f & (GIT_STATUS.WT_MODIFIED | GIT_STATUS.WT_TYPECHANGE | GIT_STATUS.WT_RENAMED)) {
		return "modified";
	}
	return null;
}

export function classifyStatusEntries(entries: StatusEntry[]): ChangedFile[] {
	const changes: ChangedFile[] = [];
	for (const entry of entries) {
		const status = classifyStatusEntry(entry);
		if (status !== null) changes.push({ path: entry.path, status });
	}
	return changes;
}

// ---------------------------------------------------------------------------
// Unsupported gitattributes filters (pure parsing) + the three-way
// allowed/locked/blocked split
// ---------------------------------------------------------------------------

/**
 * Distinct `filter=<name>` values declared by one `.gitattributes` file's
 * content (e.g. `* filter=git-crypt diff=git-crypt` -> ["git-crypt"]).
 * Deliberately generalized rather than hardcoded to git-crypt: Git LFS and
 * any other clean/smudge filter driver hit the identical problem when no
 * key/filter is configured for them.
 */
export function parseFilterAttributes(content: string): string[] {
	const names = new Set<string>();
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		// First token is the pattern; the rest are attributes.
		for (const attr of line.split(/\s+/).slice(1)) {
			const match = /^filter=(.+)$/.exec(attr);
			if (match && match[1].length > 0) names.add(match[1]);
		}
	}
	return [...names];
}

/** The unnamed/default git-crypt filter name, as declared in `.gitattributes`
 * (`filter=git-crypt`). Named keys (`filter=git-crypt-<name>`) are the
 * SAME family — `native/filter_shim.c`'s bare-`"filter"`-attribute matching
 * runs its clean/smudge logic for either form (see that file's header
 * comment for the libgit2 attribute-clause DSL research this rests on) —
 * they're just a different key slot, not a different degree of support. */
const GIT_CRYPT_FILTER_NAME = "git-crypt";
const GIT_CRYPT_NAMED_PREFIX = `${GIT_CRYPT_FILTER_NAME}-`;

/** True for `"git-crypt"` (default) or `"git-crypt-<name>"` (named) —
 * i.e. any `filter=` value the native filter shim can actually run,
 * regardless of whether a key happens to be configured for it. */
function isGitCryptFamilyFilterName(name: string): boolean {
	return name === GIT_CRYPT_FILTER_NAME || name.startsWith(GIT_CRYPT_NAMED_PREFIX);
}

/** `"git-crypt"` -> `""` (the default key slot); `"git-crypt-<name>"` ->
 * `"<name>"`. Only meaningful for names `isGitCryptFamilyFilterName` accepts. */
function gitCryptKeyNameFromFilterName(name: string): string {
	return name === GIT_CRYPT_FILTER_NAME ? "" : name.slice(GIT_CRYPT_NAMED_PREFIX.length);
}

/** Inverse of `gitCryptKeyNameFromFilterName` — used by callers building a
 * human-readable label for a key slot ("" -> "default"). */
export function describeGitCryptKeyName(keyName: string): string {
	return keyName === "" ? "default" : keyName;
}

/**
 * Explain why declared filter(s) make this repository unsafe to sync — this
 * is ONLY reached for a filter this engine cannot run AT ALL regardless of
 * key material (Git LFS, or any other unrecognized custom filter driver);
 * git-crypt (default or named) never lands here anymore — see
 * `classifyFilters`, which routes every git-crypt-family name into `"ok"`/
 * `"locked"` instead, since the native filter shim can run either form.
 */
export function describeUnsupportedFilters(filters: string[]): string {
	const names = filters.join(", ");
	const hint = filters.includes("lfs") ? " This looks like Git LFS." : "";
	return (
		`This repository declares a gitattributes content filter Halyard Sync ` +
		`cannot run (${names}).${hint} Halyard Sync has no native git and cannot ` +
		"decrypt or transform file content the way a real git client would — it " +
		"would read and write the raw filtered bytes as-is (for an encrypting " +
		"filter, that means committing PLAINTEXT into what should stay " +
		"encrypted). Do not use Halyard Sync with this repository. Auto-sync has " +
		"been paused."
	);
}

/**
 * Message for the new `"locked"` state: unlike `describeUnsupportedFilters`,
 * this is explicitly recoverable — importing the missing key(s) in settings
 * and re-syncing is enough, no re-clone or "this repo can never work here"
 * framing. Names the SPECIFIC missing key(s) rather than a generic "a key is
 * missing" — the settings checklist (`renderEncryption` in `settings.ts`)
 * shows the same names so a user can act on this message directly.
 */
export function describeGitCryptLocked(missingKeyNames: string[]): string {
	const labels = missingKeyNames.map(describeGitCryptKeyName);
	const list = labels.length > 0 ? labels.join(", ") : "the required key";
	const plural = labels.length === 1 ? "key" : "keys";
	const pronoun = labels.length === 1 ? "it is" : "they are";
	return (
		`This repository uses git-crypt ${plural} that aren't imported on this ` +
		`device yet: ${list}. Files using ${labels.length === 1 ? "that key" : "those keys"} ` +
		`can't be synced until ${pronoun} imported — files using keys you already ` +
		"have are unaffected once every key is present, but until then the whole " +
		"repository is paused (no partial sync of some files while others wait). " +
		"Import the missing key(s) in Halyard Sync's settings (Encryption section) " +
		"to unlock syncing. Nothing has been committed or pushed unencrypted."
	);
}

export class UnsupportedGitAttributesError extends Error {
	constructor(readonly filters: string[]) {
		super(describeUnsupportedFilters(filters));
		this.name = "UnsupportedGitAttributesError";
	}
}

/**
 * Result of checking a repository's declared gitattributes filters against
 * what this engine can actually run:
 *   - `"ok"`: no filters, or every distinct git-crypt-family name in use
 *     (default and/or named) has a configured key on this device — safe to
 *     proceed.
 *   - `"locked"`: only git-crypt-family filters, but at least one of the
 *     names in use has NO configured key — recoverable (import the missing
 *     key(s)), NOT the same as fundamentally unsupported. All-or-nothing by
 *     design: even one missing named key locks the WHOLE repository, never
 *     a partial sync of just the paths whose keys ARE present (see
 *     `classifyFilters`'s doc comment for why — same risk-averse posture as
 *     `merge()`'s never-write-conflict-markers policy).
 *   - `"blocked"`: anything else (LFS, or any other custom filter driver
 *     this engine cannot run regardless of key material) — unconditionally
 *     unsupported, exactly as strict as before named-key support existed.
 */
export type FilterCheckResult =
	| { kind: "ok" }
	| { kind: "locked"; missingKeyNames: string[]; presentKeyNames: string[] }
	| { kind: "blocked"; filters: string[] };

// ---------------------------------------------------------------------------
// Settings checklist derivation (pure) — "which git-crypt keys does this
// repo need, and which of those are already configured on this device."
// Separate from `classifyFilters`'s ok/locked/blocked split above: that one
// decides whether syncing may proceed right now; this one just describes
// the full picture for the settings UI (`renderEncryption` in settings.ts),
// including names that ARE already configured (shown with a Clear button)
// and, since no Obsidian DOM is available in this repo's test environment,
// is unit-tested directly rather than through any rendered markup.
// ---------------------------------------------------------------------------

export interface GitCryptKeyChecklistEntry {
	/** "" = the default/unnamed key. */
	keyName: string;
	configured: boolean;
}

/** Sorts the default key ("") first, then named keys alphabetically —
 * a stable, predictable order for the settings checklist. */
function compareGitCryptKeyNames(a: string, b: string): number {
	if (a === b) return 0;
	if (a === "") return -1;
	if (b === "") return 1;
	return a.localeCompare(b);
}

/**
 * Given every distinct git-crypt-family key name a repo's gitattributes
 * currently declares (`declaredKeyNames`, `""` = default) and every name
 * currently configured on this device (`configuredKeyNames`), derive the
 * checklist entries the settings UI renders: one row per declared name, each
 * flagged with whether it's configured. Deliberately ignores any configured
 * name the repo doesn't actually declare (a stale/leftover key from a
 * previous repo isn't this repo's concern to show).
 */
export function deriveGitCryptKeyChecklist(
	declaredKeyNames: string[],
	configuredKeyNames: string[]
): GitCryptKeyChecklistEntry[] {
	const configured = new Set(configuredKeyNames);
	return [...new Set(declaredKeyNames)]
		.sort(compareGitCryptKeyNames)
		.map((keyName) => ({ keyName, configured: configured.has(keyName) }));
}

function basename(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? p : p.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Friendly error messages (pure)
// ---------------------------------------------------------------------------

/**
 * Translate a clone/init/push failure into actionable text, the same way
 * `auth/providers.ts`'s `describeApiError` does for provider REST calls.
 *
 * `Libgit2Error` carries libgit2's raw message and, when available, its
 * `git_error_klass` — but not the HTTP status code. The native transport
 * shim (`native/transport_shim.c`) returns -1 on a non-2xx response without
 * calling `git_error_set` with the status, so whatever libgit2 set last
 * propagates instead, often a generic smart-HTTP message rather than "401".
 *
 * The 401/403/404 matching below is therefore best-effort text matching, a
 * real limitation that closing would require native changes. Network
 * failures are matched the same way, since `requestUrl` throws plain
 * `Error`s.
 */
export function describeGitError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (err instanceof Libgit2Error) {
		if (/\b401\b|\b403\b|unauthorized|forbidden|authentication/i.test(message)) {
			return "Authentication failed — check your token has the right scope and hasn't expired.";
		}
		if (/\b404\b|not found/i.test(message)) {
			return "Repository not found — check the URL and that your token has access.";
		}
		if (/unsupported url protocol/i.test(message)) {
			return "This repository's remote is configured for SSH, which Halyard Sync " +
				"can't use (no SSH transport on mobile) — open the setup wizard and " +
				"re-enter the HTTPS URL to fix it.";
		}
	}
	// Covers both Node-style codes (mobile's underlying HTTP stack) and
	// Chromium's `net::ERR_*` codes (Obsidian desktop/Electron).
	if (
		/network|fetch|dns|enotfound|econnrefused|econnreset|etimedout|time(d)?[ -]?out|offline|net::err_/i.test(
			message
		)
	) {
		return "Network error — check your connection and try again.";
	}
	return message;
}

/**
 * One-line summary for a conflicting file: line-count comparison when both
 * sides are text, "added locally/remotely" when only one side has it, or
 * "binary" — never a real diff, just enough to gauge how much is at stake
 * before an irreversible discard. Falls back to the bare path when no stat
 * was computed (best-effort — a failed stats fetch must not block resolving
 * the conflict).
 */
export function describeConflictFile(path: string, stat: ConflictFileStat | undefined): string {
	if (stat === undefined) return path;
	if (stat.binary) return `${path} (binary)`;
	if (stat.localLines === null) return `${path} (added remotely)`;
	if (stat.remoteLines === null) return `${path} (added locally)`;
	if (stat.localLines === stat.remoteLines) return `${path} (${stat.localLines} lines, both changed)`;
	return `${path} (${stat.localLines} → ${stat.remoteLines} lines)`;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type MergeOutcome =
	| { kind: "uptodate" }
	| { kind: "fastforward"; oid: string }
	| { kind: "merged"; oid: string }
	| { kind: "conflict"; files: string[] };

export interface RemoteRefInfo {
	ref: string;
	oid: string;
}

export interface AheadBehind {
	state: "uptodate" | "ahead" | "behind" | "diverged";
	/** null = count unknown (shallow history cut off before the merge base) */
	ahead: number | null;
	behind: number | null;
	/** true when history was too shallow to compute exact counts */
	approximate: boolean;
}

/**
 * Lightweight per-file signal for the conflict modal — not a real diff (no
 * diffing library, and a full diff viewer is more than a "which files, how
 * much changed" glance needs), just enough to tell "one line changed" apart
 * from "the whole file was replaced" before an irreversible discard.
 */
export interface ConflictFileStat {
	path: string;
	/** Line count in the local (ours) version; null if absent there (added remotely). */
	localLines: number | null;
	/** Line count in the remote-tracking (theirs) version; null if absent there (added locally). */
	remoteLines: number | null;
	/** True when either side isn't decodable as UTF-8 text (or, for a
	 * git-crypt path, couldn't be decrypted with the configured key). */
	binary: boolean;
}

export interface GitAuthor {
	name: string;
	email: string;
}

export interface GitEngineOptions {
	/** The wrapped libgit2 module entry point (see `libgit2/loader.ts`). */
	module: Libgit2Module;
	/** The in-memory FS mirror already mounted into `module`'s classic FS at
	 * `dir` — see `createGitEngine` below, which does that mounting. */
	mirror: VaultMirror;
	/** The real Obsidian adapter (or a structural mock in tests) `mirror` is
	 * hydrated from / flushed back to. */
	adapter: DataAdapterLike;
	/** Repo root inside `module`'s mounted classic FS (NOT a vault-relative
	 * adapter path — see `createGitEngine`'s `REPO_MOUNT_DIR`). */
	dir: string;
	author: GitAuthor;
	remote?: string;
	ignoreGlobs?: string[];
	/** Vault-relative path to the calling plugin's own `data.json` (e.g.
	 * `.obsidian/plugins/halyard-sync/data.json`), always ignored in addition
	 * to `defaultIgnores` and `ignoreGlobs`. This can't just be folded into
	 * `ignoreGlobs`/`defaultIgnores`: the plugin rewrites its own data.json
	 * on every sync (lastSyncAt, rolling history — see `main.ts`'s
	 * `onSyncComplete`/`onHistoryEntry`), so without excluding it, every sync
	 * dirties a file that the next sync then stages and commits, syncing
	 * forever with no real vault change behind it. */
	ownDataPath?: string;
	/** The vault's configuration folder (`Vault#configDir`) — the workspace
	 * files `defaultIgnores` excludes live under it, and its name is
	 * user-configurable, so the engine has to be told rather than assume. */
	configDir: string;
	/** Resolves HTTPS Basic-auth credentials for a fetch, push, or
	 * listRemoteRef call. Null proceeds without credentials. */
	onAuth?: (url: string) => Promise<{ username: string; password: string } | null>;
	onProgress?: (stage: string, current: number, total: number) => void;
	/** Resolves every git-crypt key currently configured for the CURRENT
	 * remote, keyed by key name (`""` = default/unnamed) — used both to
	 * decide `detectUnsupportedFilters`'s ok/locked split (per-name) and to
	 * register the native git-crypt filter's multi-key dispatch. Empty map
	 * (or undefined) means no keys configured at all. */
	getGitCryptKeys?: () => Promise<Map<string, GitCryptKeyMaterial>>;
	/** See `HalyardSyncSettings.autoMergeOverlappingEdits`'s doc comment — off
	 * (`"normal"` favor, real conflicts reported) unless explicitly set. */
	autoMergeOverlappingEdits?: boolean;
}

export interface CloneOptions {
	url: string;
	ref?: string;
	/** Shallow by default: mobile memory is the constraint. */
	depth?: number;
	singleBranch?: boolean;
}

export interface InitOptions {
	url: string;
	defaultBranch?: string;
}

export interface PushOptions {
	ref?: string;
	remoteRef?: string;
	force?: boolean;
}

// ---------------------------------------------------------------------------
// git-crypt filter wiring
// ---------------------------------------------------------------------------

/**
 * Builds the native filter's encrypt/decrypt hooks so they dispatch on the
 * `keyName` the filter shim actually calls them with (see
 * `native/filter_shim.c`'s `filter_check` — the resolved `.gitattributes`
 * value determines which name reaches here, `""` for the default/unnamed
 * key). `keys` should already only contain names this repo's current
 * `classifyFilters` result reported as present — a lookup miss here would
 * mean the guard above this was bypassed somehow, so it fails loudly
 * (a clear thrown error) rather than silently falling back to some other
 * key or corrupting data by encrypting/decrypting with the wrong material.
 */
function gitCryptFilterHooks(keys: Map<string, GitCryptKeyMaterial>): GitCryptFilterHooks {
	const requireKey = (keyName: string): GitCryptKeyMaterial => {
		const key = keys.get(keyName);
		if (key === undefined) {
			throw new Error(
				`git-crypt filter invoked for the "${describeGitCryptKeyName(keyName)}" key, ` +
					"but no key material is configured for it on this device — refusing to " +
					"proceed with the wrong (or no) key rather than risk corrupting data."
			);
		}
		return key;
	};
	return {
		encrypt: async (keyName, plaintext) => {
			const key = requireKey(keyName);
			return encryptBlob(key.aesKey, key.hmacKey, plaintext);
		},
		decrypt: async (keyName, ciphertext) => {
			const key = requireKey(keyName);
			return decryptBlob(key.aesKey, ciphertext);
		},
	};
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class GitEngine {
	private repo: Libgit2Repository | null = null;
	private closed = false;
	private ignoreFilter: (filepath: string) => boolean;

	constructor(private readonly opts: GitEngineOptions) {
		this.ignoreFilter = createIgnoreFilter(
			opts.ignoreGlobs ?? [],
			defaultIgnoresFor(opts.configDir, opts.ownDataPath)
		);
	}

	/**
	 * Updates author identity / ignore globs in place without tearing down
	 * the (expensive: WASM module + hydrated mirror + open repo handle)
	 * engine state — settings edits (e.g. every keystroke in the ignore-globs
	 * textarea) must not each pay the cost of reloading the WASM module and
	 * re-hydrating the whole vault, which a full engine rebuild would.
	 */
	updateOptions(patch: Partial<Pick<GitEngineOptions, "author" | "ignoreGlobs" | "onAuth" | "onProgress" | "getGitCryptKeys" | "autoMergeOverlappingEdits">>): void {
		if (patch.author !== undefined) this.opts.author = patch.author;
		if (patch.ignoreGlobs !== undefined) {
			this.opts.ignoreGlobs = patch.ignoreGlobs;
			this.ignoreFilter = createIgnoreFilter(
				patch.ignoreGlobs,
				defaultIgnoresFor(this.opts.configDir, this.opts.ownDataPath)
			);
		}
		if (patch.onAuth !== undefined) this.opts.onAuth = patch.onAuth;
		if (patch.onProgress !== undefined) this.opts.onProgress = patch.onProgress;
		if (patch.getGitCryptKeys !== undefined) this.opts.getGitCryptKeys = patch.getGitCryptKeys;
		if (patch.autoMergeOverlappingEdits !== undefined) {
			this.opts.autoMergeOverlappingEdits = patch.autoMergeOverlappingEdits;
		}
	}

	/**
	 * A dedicated remote name, NOT "origin" — this plugin never wants to
	 * touch a remote the user manages with their own git tooling. A vault
	 * can predate Halyard Sync entirely (already `git clone`d by hand, often
	 * over SSH, with its own `origin` the user's own scripts/CLI still rely
	 * on); this plugin adds and exclusively owns "halyard-sync" instead,
	 * fetching/pushing/tracking refs there (`refs/remotes/halyard-sync/*`)
	 * and leaving "origin" (or any other remote) completely untouched. This
	 * is also what makes `ensureRemote`'s force-overwrite safe: it only ever
	 * force-overwrites a remote name this plugin itself created.
	 */
	private get remote(): string {
		return this.opts.remote ?? "halyard-sync";
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("GitEngine: method called after close()");
	}

	/** Opens (once) the repository already on disk at `opts.dir`. Throws if
	 * nothing has been cloned/initialized yet — callers that just ran
	 * `clone()`/`initFromExistingVault()` already have `this.repo` set
	 * directly by those methods, so this path is only hit on a fresh engine
	 * instance pointed at an existing `.git`. */
	private async ensureRepo(): Promise<Libgit2Repository> {
		this.assertOpen();
		if (this.repo !== null) return this.repo;
		const hasGit = await this.opts.adapter.exists(".git");
		if (!hasGit) {
			throw new Error(
				"GitEngine: no repository found — call clone() or initFromExistingVault() first"
			);
		}
		this.repo = await this.opts.module.openRepository(this.opts.dir);
		await this.syncGitCryptFilter();
		return this.repo;
	}

	private async flush(): Promise<void> {
		await this.opts.mirror.flush(this.opts.adapter);
	}

	private libgit2Author(): Libgit2Author {
		return { name: this.opts.author.name, email: this.opts.author.email };
	}

	/**
	 * (Re-)registers or unregisters the module-level git-crypt filter to
	 * match whatever `getGitCryptKeys()` currently resolves to. Safe to call
	 * repeatedly (e.g. right after a key is imported in settings, so an
	 * already-open engine picks it up without a full rebuild) — always
	 * unregisters first so a cleared/changed key doesn't leave stale hooks
	 * installed.
	 */
	async syncGitCryptFilter(): Promise<void> {
		if (this.opts.getGitCryptKeys === undefined) return;
		try {
			await this.opts.module.unregisterGitCryptFilter();
		} catch {
			// Not previously registered — fine, this call is best-effort reset.
		}
		const keys = await this.opts.getGitCryptKeys();
		if (keys.size === 0) return;
		await this.opts.module.registerGitCryptFilter(gitCryptFilterHooks(keys));
	}

	private buildNetworkCallbacks(): NetworkCallbacks {
		const onAuth = this.opts.onAuth;
		const onProgress = this.opts.onProgress;
		return {
			...(onAuth ? { onCredentials: async (url: string) => onAuth(url) } : {}),
			...(onProgress ? { onProgress } : {}),
		};
	}

	async clone(options: CloneOptions): Promise<void> {
		this.assertOpen();
		const net = this.buildNetworkCallbacks();
		this.repo = await this.opts.module.clone(
			{
				url: options.url,
				dir: this.opts.dir,
				ref: options.ref,
				depth: options.depth ?? 1,
				singleBranch: options.singleBranch ?? true,
				remote: this.remote,
			},
			net
		);
		await this.flush();
		await this.syncGitCryptFilter();
	}

	/** Turn an existing vault into a repo pointed at `url` (no commit/push). */
	async initFromExistingVault(options: InitOptions): Promise<void> {
		this.assertOpen();
		const defaultBranch = options.defaultBranch ?? "main";
		const repo = await this.opts.module.init({ dir: this.opts.dir, defaultBranch });
		await repo.addRemote(this.remote, options.url, { force: true });
		await repo.setConfig("user.name", this.opts.author.name);
		await repo.setConfig("user.email", this.opts.author.email);
		this.repo = repo;
		await this.flush();
		await this.syncGitCryptFilter();
	}

	async getRemoteUrl(): Promise<string | null> {
		const repo = await this.ensureRepo();
		return repo.getConfig(`remote.${this.remote}.url`);
	}

	/**
	 * Force this plugin's OWN remote's ("halyard-sync", see the `remote`
	 * getter above) URL to `url` — idempotent, local-only (one
	 * `git_remote_set_url` call if the remote already exists, else a fresh
	 * `git_remote_create`, no network access). Safe to force-overwrite
	 * precisely because "halyard-sync" is a name only this plugin ever
	 * creates — never "origin" or anything else the user's own git tooling
	 * might rely on. Needed because `ensureRepo()` happily opens a `.git`
	 * that predates this plugin's involvement (or whose wizard run got
	 * interrupted after step 1 saved `settings.remoteUrl` but before
	 * step 3's clone/init ever created "halyard-sync"), and in that case
	 * nothing else reconciles the remote against `settings.remoteUrl`.
	 * Without this, every subsequent fetch/push/listRemoteRef would either
	 * find no such remote at all, or use a stale URL, and fail deep in
	 * libgit2 with a raw error instead of the friendly validation
	 * `auth/providers.ts#normalizeRemoteUrl` would have given at setup time.
	 * Callers should run this once whenever they open a repo they didn't
	 * just clone/init in the same call.
	 */
	async ensureRemote(url: string): Promise<void> {
		const repo = await this.ensureRepo();
		await repo.addRemote(this.remote, url, { force: true });
	}

	/**
	 * Distinct filter names declared by every path currently in the index,
	 * classified into ok/locked/blocked (see `FilterCheckResult`). Cheap —
	 * reads the index via `listPathsWithAttribute`, not a working-tree walk —
	 * so this is safe to call on every sync. Only meaningful once a
	 * commit/clone has populated the index; see
	 * `detectUnsupportedFiltersInWorkingTree` for the pre-init case.
	 */
	async detectUnsupportedFilters(): Promise<FilterCheckResult> {
		const repo = await this.ensureRepo();
		const entries = await repo.listPathsWithAttribute("filter");
		return this.classifyFilters(entries.map((e) => e.value));
	}

	/**
	 * Same check, but walks the raw working tree instead of the index. Used
	 * for "initialize from existing vault", which must refuse to run before
	 * anything is staged — at that point there is no index yet to read, and
	 * no libgit2 repository open yet either, so this operates directly on
	 * `opts.adapter` rather than through libgit2 at all.
	 */
	async detectUnsupportedFiltersInWorkingTree(): Promise<FilterCheckResult> {
		const names = new Set<string>();
		const adapter = this.opts.adapter;
		const walk = async (dir: string): Promise<void> => {
			let listing: { files: string[]; folders: string[] };
			try {
				listing = await adapter.list(dir);
			} catch {
				return;
			}
			for (const folder of listing.folders) {
				if (basename(folder) === ".git") continue;
				await walk(folder);
			}
			for (const file of listing.files) {
				if (basename(file) !== ".gitattributes") continue;
				const content = await this.readTextFile(file);
				if (content === null) continue;
				for (const name of parseFilterAttributes(content)) names.add(name);
			}
		};
		await walk("/");
		return this.classifyFilters([...names]);
	}

	/**
	 * Splits every distinct declared `filter=` name into ok/locked/blocked
	 * (see `FilterCheckResult`'s doc comment). Any name outside the
	 * git-crypt family (LFS, an unrecognized custom filter) unconditionally
	 * blocks the WHOLE result — unchanged from before named-key support.
	 * Within the git-crypt family, every distinct KEY NAME in use (default
	 * and/or named) is checked against `getGitCryptKeys()`'s configured map;
	 * if even one is missing, the whole result is `"locked"` naming exactly
	 * the missing ones — never a partial per-path sync (see
	 * `FilterCheckResult`'s doc comment for why: the same risk-averse,
	 * all-or-nothing posture `merge()` takes elsewhere in this codebase).
	 */
	private async classifyFilters(values: string[]): Promise<FilterCheckResult> {
		const names = [...new Set(values)];
		const nonGitCrypt = names.filter((n) => !isGitCryptFamilyFilterName(n));
		if (nonGitCrypt.length > 0) return { kind: "blocked", filters: names };
		if (names.length === 0) return { kind: "ok" };
		const keyNames = [...new Set(names.map(gitCryptKeyNameFromFilterName))];
		const configured = this.opts.getGitCryptKeys ? await this.opts.getGitCryptKeys() : new Map<string, GitCryptKeyMaterial>();
		const missingKeyNames = keyNames.filter((n) => !configured.has(n));
		const presentKeyNames = keyNames.filter((n) => configured.has(n));
		if (missingKeyNames.length === 0) return { kind: "ok" };
		return { kind: "locked", missingKeyNames, presentKeyNames };
	}

	private async readTextFile(path: string): Promise<string | null> {
		try {
			return await this.opts.adapter.read(path);
		} catch {
			return null;
		}
	}

	/**
	 * Working-tree changes vs the index, with ignore filter applied.
	 * Re-hydrates the mirror from the real adapter first — see this file's
	 * header comment on why that's necessary every call, not just once at
	 * engine construction.
	 */
	async getChangedFiles(): Promise<ChangedFile[]> {
		const repo = await this.ensureRepo();
		this.opts.mirror.reset();
		await this.opts.mirror.hydrateAll(this.opts.adapter);
		const entries = await repo.status();
		const filtered = entries.filter((e) => !this.ignoreFilter(e.path));
		return classifyStatusEntries(filtered);
	}

	/**
	 * Stage all changes and commit. Returns the new commit oid, or null if
	 * the working tree was clean (no commit created).
	 */
	async stageAndCommit(message: string): Promise<string | null> {
		const repo = await this.ensureRepo();
		const changes = await this.getChangedFiles();
		if (changes.length === 0) return null;
		for (const change of changes) {
			if (change.status === "deleted") {
				await repo.unstagePath(change.path);
			} else {
				await repo.stagePath(change.path);
			}
		}
		const oid = await repo.commit(message, this.libgit2Author());
		await this.flush();
		return oid;
	}

	async fetch(branch?: string): Promise<void> {
		const repo = await this.ensureRepo();
		const net = this.buildNetworkCallbacks();
		await repo.fetch(this.remote, branch, net);
		await this.flush();
	}

	/**
	 * Cheap remote ref check (~one small HTTPS request, no pack transfer).
	 * Returns null when the branch does not exist on the server.
	 */
	async listRemoteRef(branch: string): Promise<RemoteRefInfo | null> {
		this.assertOpen();
		const url = await this.getRemoteUrl();
		if (!url) {
			throw new Error(`No URL configured for remote '${this.remote}'`);
		}
		const ref = `refs/heads/${branch}`;
		const net = this.buildNetworkCallbacks();
		const refs = await this.opts.module.listRemoteRefs(url, ref, net);
		const match = refs.find((r) => r.ref === ref);
		return match ? { ref: match.ref, oid: match.oid } : null;
	}

	/**
	 * Verify a remote URL and the current credentials by performing a real ref
	 * advertisement against it. Returns every advertised branch.
	 *
	 * Deliberately goes over the git smart-HTTP transport rather than a
	 * provider REST call, even though a REST call would be simpler: the two
	 * exercise different code paths and different server behaviour. A REST
	 * probe reports "token is valid" while `git fetch` is still broken — which
	 * is exactly what happened with the protocol-v2 bug (see
	 * `libgit2/engine.ts`'s `Git-Protocol` note), where the API was fine and
	 * every sync failed. A connection test that cannot fail the way real syncs
	 * fail is not worth showing.
	 *
	 * Unlike `listRemoteRef`, this needs no repository: `listRemoteRefs` builds
	 * a detached remote from the URL alone, so the wizard can call it before
	 * anything has been cloned or initialized.
	 */
	async testConnection(url: string): Promise<RemoteRefInfo[]> {
		this.assertOpen();
		if (!url) throw new Error("No remote URL to test.");
		const net = this.buildNetworkCallbacks();
		return this.opts.module.listRemoteRefs(url, "refs/heads/", net);
	}

	/** Oid of the local branch head, or null if the branch doesn't exist. */
	async localRef(branch: string): Promise<string | null> {
		const repo = await this.ensureRepo();
		return repo.resolveRef(`refs/heads/${branch}`);
	}

	/** Oid of the remote-tracking ref, or null if never fetched. */
	async remoteTrackingRef(branch: string): Promise<string | null> {
		const repo = await this.ensureRepo();
		return repo.resolveRef(`refs/remotes/${this.remote}/${branch}`);
	}

	/**
	 * Merge the remote-tracking ref into the local branch.
	 *
	 * Assumes local changes are already committed (call stageAndCommit
	 * first) and that HEAD is currently on `branch` (every real caller
	 * checks that branch out via clone/init before ever syncing — same
	 * assumption the underlying `Libgit2Repository.merge()` documents).
	 *
	 * Conflicts never write markers into notes: the binding's `merge()``
	 * builds the three-way merge entirely in-memory
	 * (`git_merge_commits`, never the working-tree-touching `git_merge()`)
	 * and only ever flushes/checks out on a genuinely clean result — see
	 * `libgit2/engine.ts`'s `merge()` doc comment for the full reasoning.
	 *
	 * When `autoMergeOverlappingEdits` is on, passes `favor: "union"`
	 * through — an overlapping hunk is then never reported as a conflict at
	 * all (see `HalyardSyncSettings.autoMergeOverlappingEdits`'s doc comment
	 * for what that actually does and why it's opt-in).
	 */
	async mergeUpstream(branch: string): Promise<MergeOutcome> {
		const repo = await this.ensureRepo();
		const local = await this.localRef(branch);
		const theirs = await this.remoteTrackingRef(branch);
		if (theirs === null || theirs === local) {
			return { kind: "uptodate" };
		}
		const outcome = await repo.merge(
			branch,
			`refs/remotes/${this.remote}/${branch}`,
			this.libgit2Author(),
			{ favor: this.opts.autoMergeOverlappingEdits ? "union" : "normal" }
		);
		await this.flush();
		switch (outcome.kind) {
			case "uptodate":
				return { kind: "uptodate" };
			case "fastforward":
				return { kind: "fastforward", oid: outcome.oid };
			case "merged":
				return { kind: "merged", oid: outcome.oid };
			case "conflict":
				return { kind: "conflict", files: outcome.paths };
		}
	}

	/** Every repo-relative path (per the index) whose `filter` attribute
	 * resolves to a git-crypt-family value (default or named), mapped to the
	 * KEY NAME that applies to it (`""` for the default) — used by
	 * `conflictFileStats` to know which key decrypts which blob before a
	 * line count means anything. Best-effort: an empty map on failure, since
	 * a failed attribute scan must not block showing conflict stats at all. */
	private async gitCryptPathKeyNames(repo: Libgit2Repository): Promise<Map<string, string>> {
		try {
			const entries = await repo.listPathsWithAttribute("filter");
			const map = new Map<string, string>();
			for (const entry of entries) {
				if (isGitCryptFamilyFilterName(entry.value)) {
					map.set(entry.path, gitCryptKeyNameFromFilterName(entry.value));
				}
			}
			return map;
		} catch {
			return new Map();
		}
	}

	/**
	 * Every distinct git-crypt-family key name (`""` = default, or a named
	 * key) declared ANYWHERE in the repo's current gitattributes — regardless
	 * of whether a key is currently configured for it. Used to build the
	 * settings checklist (`deriveGitCryptKeyChecklist`), not to decide
	 * ok/locked/blocked (that's `classifyFilters`, which also needs to know
	 * about non-git-crypt filters this ignores). Empty when the repo
	 * declares no git-crypt filter at all. Requires an already-open
	 * repository (throws via `ensureRepo()` otherwise) — callers with no
	 * repo yet (not connected) should catch and treat that as "unknown".
	 */
	async declaredGitCryptKeyNames(): Promise<string[]> {
		const repo = await this.ensureRepo();
		const entries = await repo.listPathsWithAttribute("filter");
		const names = new Set<string>();
		for (const entry of entries) {
			if (isGitCryptFamilyFilterName(entry.value)) {
				names.add(gitCryptKeyNameFromFilterName(entry.value));
			}
		}
		return [...names];
	}

	/**
	 * Per-file line-count stat for each conflicting path, comparing the local
	 * branch tip against the remote-tracking ref (best-effort: a file missing
	 * or unreadable on a given side just reports `null` there, never throws).
	 * git-crypt-encrypted paths are decrypted (via `gitcrypt.ts`'s
	 * `decryptBlob`, using whatever key is currently configured) before line
	 * counting — `readBlob` returns the raw stored (ciphertext) bytes,
	 * since libgit2's blob read never runs the clean/smudge filter pipeline.
	 * Falls back to "(binary)" when no key is configured or decryption fails,
	 * same as any other undecodable blob.
	 */
	async conflictFileStats(branch: string, files: string[]): Promise<ConflictFileStat[]> {
		const repo = await this.ensureRepo();
		const localOid = await this.localRef(branch);
		const remoteOid = await this.remoteTrackingRef(branch);
		const pathKeyNames = await this.gitCryptPathKeyNames(repo);
		const configuredKeys = this.opts.getGitCryptKeys
			? await this.opts.getGitCryptKeys()
			: new Map<string, GitCryptKeyMaterial>();
		const stats: ConflictFileStat[] = [];
		for (const path of files) {
			const keyName = pathKeyNames.get(path);
			// Falls back to "(binary)" (via readBlobLineCount's undecryptable-blob
			// path below) when this specific path's key name has no configured
			// material — same defensive pattern used throughout this file, never
			// a silent wrong-key decrypt attempt.
			const decryptKey = keyName !== undefined ? (configuredKeys.get(keyName) ?? null) : null;
			const local = await this.readBlobLineCount(repo, localOid, path, decryptKey);
			const remote = await this.readBlobLineCount(repo, remoteOid, path, decryptKey);
			stats.push({
				path,
				localLines: local.lines,
				remoteLines: remote.lines,
				binary: local.binary || remote.binary,
			});
		}
		return stats;
	}

	private async readBlobLineCount(
		repo: Libgit2Repository,
		oid: string | null,
		filepath: string,
		gitCryptKey: GitCryptKeyMaterial | null
	): Promise<{ lines: number | null; binary: boolean }> {
		if (oid === null) return { lines: null, binary: false };
		let blob: Uint8Array;
		try {
			blob = await repo.readBlob(oid, filepath);
		} catch {
			return { lines: null, binary: false }; // missing at this ref (added/deleted on this side)
		}
		if (gitCryptKey !== null) {
			try {
				blob = await decryptBlob(gitCryptKey.aesKey, blob);
			} catch {
				return { lines: null, binary: true }; // wrong/stale key, or not actually a git-crypt blob
			}
		}
		if (blob.includes(0)) return { lines: null, binary: true };
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(blob);
			if (text.length === 0) return { lines: 0, binary: false };
			const segments = text.split("\n").length;
			// A single trailing newline is the common case and shouldn't count
			// as an extra (empty) line — matches what an editor's line count
			// would show, not just "number of newline-separated segments".
			const lines = text.endsWith("\n") ? segments - 1 : segments;
			return { lines, binary: false };
		} catch {
			return { lines: null, binary: true }; // failed UTF-8 decode
		}
	}

	async push(options: PushOptions = {}): Promise<void> {
		const repo = await this.ensureRepo();
		const net = this.buildNetworkCallbacks();
		await repo.push(this.remote, options, net);
	}

	/**
	 * Point the local branch at the remote-tracking oid and force-checkout,
	 * discarding local commits and working-tree changes. Returns the oid the
	 * branch now points at.
	 */
	async hardResetToRemote(branch: string): Promise<string> {
		const repo = await this.ensureRepo();
		const oid = await this.remoteTrackingRef(branch);
		if (oid === null) {
			throw new Error(
				`No remote-tracking ref for '${branch}' — fetch before resetting`
			);
		}
		await repo.writeRef(`refs/heads/${branch}`, oid, { force: true });
		await repo.checkout(`refs/heads/${branch}`, { force: true });
		await this.flush();
		return oid;
	}

	async currentBranch(): Promise<string | null> {
		const repo = await this.ensureRepo();
		return repo.currentBranch();
	}

	/**
	 * Relationship between the local branch and its remote-tracking ref.
	 * Shallow clones may not contain the merge base; unknown is reported as
	 * diverged (approximate) so callers err on the side of the merge path.
	 */
	async aheadBehind(branch: string): Promise<AheadBehind> {
		const repo = await this.ensureRepo();
		const local = await this.localRef(branch);
		const remote = await this.remoteTrackingRef(branch);
		if (local === null && remote === null) {
			return { state: "uptodate", ahead: 0, behind: 0, approximate: false };
		}
		if (remote === null) {
			return { state: "ahead", ahead: null, behind: 0, approximate: true };
		}
		if (local === null) {
			return { state: "behind", ahead: 0, behind: null, approximate: true };
		}
		if (local === remote) {
			return { state: "uptodate", ahead: 0, behind: 0, approximate: false };
		}

		let base: string | null;
		try {
			base = await repo.findMergeBase(local, remote);
		} catch {
			// Missing objects (shallow clone) or no common history.
			base = null;
		}
		if (base === null) {
			return { state: "diverged", ahead: null, behind: null, approximate: true };
		}
		if (base === remote) {
			const ahead = await this.countCommits(repo, local, base);
			return { state: "ahead", ahead, behind: 0, approximate: ahead === null };
		}
		if (base === local) {
			const behind = await this.countCommits(repo, remote, base);
			return { state: "behind", ahead: 0, behind, approximate: behind === null };
		}
		const ahead = await this.countCommits(repo, local, base);
		const behind = await this.countCommits(repo, remote, base);
		return {
			state: "diverged",
			ahead,
			behind,
			approximate: ahead === null || behind === null,
		};
	}

	/** Commits reachable from `tip` back to (excluding) `base`; null if unknown. */
	private async countCommits(
		repo: Libgit2Repository,
		tip: string,
		base: string
	): Promise<number | null> {
		try {
			const commits = await repo.log(tip);
			const index = commits.findIndex((c) => c === base);
			return index >= 0 ? index : null;
		} catch {
			// log() throws when shallow history is missing parent objects.
			return null;
		}
	}

	/** Releases the underlying `git_repository*`, if one is open. Must be
	 * called once per engine (see `main.ts`'s teardown on plugin unload) —
	 * safe to call even if a repo was never opened, and safe to call twice. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.repo !== null) {
			await this.repo.close();
			this.repo = null;
		}
	}
}

// ---------------------------------------------------------------------------
// Construction — mounts a VaultMirror into the (already-instantiated) raw
// WASM module before wrapping it into the Libgit2Module contract, since
// `binding.ts`'s contract deliberately never leaks the raw module handle
// needed to call `Module.FS.mount(...)` (see `libgit2/engine.ts`'s
// `wrapLibgit2Module` doc comment).
// ---------------------------------------------------------------------------

/** Mount path inside the WASM module's classic FS — arbitrary (never seen by
 * anything outside this module and the libgit2 calls it drives), distinct
 * from any real vault-relative adapter path. */
export const REPO_MOUNT_DIR = "/repo";

export interface CreateGitEngineOptions {
	/** Instantiates the raw (not-yet-wrapped) compiled module — see
	 * `libgit2/loader.ts`'s `instantiateLibgit2Module`. Injected rather than
	 * called directly here so this module has no hard dependency on the
	 * Emscripten glue's import path (keeps this file testable with a mock
	 * factory, and keeps the loader's WASM-packaging concerns fully
	 * separate from the engine's git-operation concerns). */
	instantiateModule: () => Promise<NativeModule>;
	/** Wraps the raw module into the `Libgit2Module` contract (`git_libgit2_init`
	 * + HTTP transport registration) — normally `wrapLibgit2Module` from
	 * `libgit2/engine.ts`, injected for the same testability reason as
	 * `instantiateModule`. */
	wrapModule: (rawModule: NativeModule, requestUrl: RequestUrlLike) => Promise<Libgit2Module>;
	requestUrl: RequestUrlLike;
	adapter: DataAdapterLike;
	author: GitAuthor;
	remote?: string;
	ignoreGlobs?: string[];
	ownDataPath?: string;
	configDir: string;
	onAuth?: GitEngineOptions["onAuth"];
	onProgress?: GitEngineOptions["onProgress"];
	getGitCryptKeys?: GitEngineOptions["getGitCryptKeys"];
	autoMergeOverlappingEdits?: boolean;
}

/**
 * Mounts a fresh `VaultMirror` (hydrated from `options.adapter`) into a
 * freshly-instantiated compiled module's classic FS at `REPO_MOUNT_DIR`,
 * wraps it into the `Libgit2Module` contract, and returns a `GitEngine`
 * ready to use. Called once per engine lifetime (see `main.ts`'s `getEngine()`
 * caching) — NOT once per sync, since instantiating the WASM module is real,
 * non-trivial work.
 */
export async function createGitEngine(options: CreateGitEngineOptions): Promise<GitEngine> {
	const rawModule = await options.instantiateModule();
	const mirror = new VaultMirror();
	await mirror.hydrateAll(options.adapter);

	const Module = rawModule;
	const errnoCodes = deriveErrnoCodes(Module);
	const globals: ClassicFsBackendGlobals = {
		ErrnoError: Module.FS.ErrnoError,
		createNode: (parent: FsNode | null, name: string, mode: number, dev: number) =>
			Module.FS.createNode(parent, name, mode, dev),
		isDir: (mode: number) => Module.FS.isDir(mode),
		errnoCodes,
		// Real mmap/msync support (see fs-backend.ts's stream_ops.mmap doc
		// comment) — needed for a real network fetch to work against this
		// mount at all (git_indexer mmaps the incoming packfile).
		malloc: (size: number) => Module._malloc(size),
		getHeapU8: () => Module.HEAPU8,
	};
	const backend = describeClassicFsBackend(mirror, globals);
	Module.FS.mkdir(REPO_MOUNT_DIR);
	Module.FS.mount(backend, {}, REPO_MOUNT_DIR);

	const module = await options.wrapModule(rawModule, options.requestUrl);

	return new GitEngine({
		module,
		mirror,
		adapter: options.adapter,
		dir: REPO_MOUNT_DIR,
		author: options.author,
		remote: options.remote,
		ignoreGlobs: options.ignoreGlobs,
		ownDataPath: options.ownDataPath,
		configDir: options.configDir,
		onAuth: options.onAuth,
		onProgress: options.onProgress,
		getGitCryptKeys: options.getGitCryptKeys,
		autoMergeOverlappingEdits: options.autoMergeOverlappingEdits,
	});
}
