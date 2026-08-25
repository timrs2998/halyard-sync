/*
 * engine_shim.c — small C-side collector helpers backing
 * `src/git/libgit2/engine.ts`'s real `Libgit2Module`/`Libgit2Repository`
 * implementation.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS: several libgit2 C entry points hand back arrays of
 * structs (`git_status_entry`, `git_remote_head`, raw `git_oid`s from a
 * revwalk) or expect a caller-populated struct in (`git_index_entry`). Doing
 * that field-by-field from JS across the WASM boundary would mean hardcoding
 * struct offsets/sizes in TypeScript — exactly the kind of "guessed ABI detail"
 * this whole project's honesty standard warns against, and one that would
 * silently break on a libgit2/Emscripten struct-layout change with no compiler
 * to catch it.
 *
 * Every function below instead does the struct-shaped work in C (where the
 * real compiler enforces field layout against the real, current headers) and
 * hands JS back either a single scalar/oid, or a flat, JS-trivial-to-parse
 * byte buffer: repeated `[uint32 statusFlags|placeholder][uint32
 * byteLen][bytes...]`-shaped records with no struct offsets for the caller to
 * know at all. `engine.ts` is the only consumer; see its per-function doc
 * comments for the exact record shape each of these produces.
 *
 * Added for `merge()`/`listPathsWithAttribute()`:
 * `halyard_merge_conflict_paths_collect` (flattens a `git_index_conflict_iterator`'s
 * `git_index_entry` triples into conflicted-path strings) and
 * `halyard_list_paths_with_attribute` (flattens every index path's resolved
 * `git_attr_get` value into path/value pairs) — see each function's own doc
 * comment below. Everything else `merge()` needs (annotated commits,
 * `git_merge_analysis`, `git_merge_commits`, `git_index_has_conflicts`) is
 * just opaque-handle/scalar libgit2 calls with no struct decoding involved,
 * so `engine.ts` calls those directly rather than needing a shim for them —
 * consistent with this file's "only shim what needs struct-layout knowledge"
 * scope.
 * =============================================================================
 */

#include <stdlib.h>
#include <string.h>

#include <emscripten.h>
#include <git2.h>
#include <git2/status.h>
#include <git2/sys/transport.h>

/* ---------------------------------------------------------------------------
 * Shared growable buffer helper (same shape as transport_shim.c's buf_append,
 * duplicated locally rather than shared across translation units to keep
 * each native .c file independently readable — these are small static
 * helpers, not a library).
 * ---------------------------------------------------------------------------
 */

static int buf_append(uint8_t **buf, size_t *len, size_t *cap, const void *data, size_t add) {
	if (*len + add > *cap) {
		size_t new_cap = *cap == 0 ? 4096 : *cap;
		while (new_cap < *len + add) new_cap *= 2;
		uint8_t *grown = (uint8_t *)realloc(*buf, new_cap);
		if (grown == NULL) return -1;
		*buf = grown;
		*cap = new_cap;
	}
	memcpy(*buf + *len, data, add);
	*len += add;
	return 0;
}

static int append_u32(uint8_t **buf, size_t *len, size_t *cap, uint32_t v) {
	return buf_append(buf, len, cap, &v, sizeof(v));
}

/* ---------------------------------------------------------------------------
 * status(): flat records of [uint32 statusFlags][uint32 pathLen][path bytes]
 * ---------------------------------------------------------------------------
 *
 * Backs `Libgit2Repository.status()`. `*out_count` is the number of records;
 * the caller (engine.ts) reads exactly that many length-prefixed records
 * sequentially out of `*out_buf`, then frees it with `_free`. Renamed entries
 * report the *new* path (index_to_workdir wins over head_to_index when both
 * are present), matching what a caller diffing "what does the working tree
 * look like now" cares about; the raw `status` bitmask (unchanged from
 * `git_status_t`) still tells the caller everything needed to distinguish
 * index-new/deleted/renamed, matching binding.ts's `StatusEntry.statusFlags`
 * contract of exposing the bitmask raw rather than pre-decoded.
 */
EMSCRIPTEN_KEEPALIVE
int halyard_status_collect(
	git_repository *repo,
	const char **pathspecs,
	int npathspecs,
	uint8_t **out_buf,
	size_t *out_count) {
	git_status_options opts;
	int rc = git_status_options_init(&opts, GIT_STATUS_OPTIONS_VERSION);
	if (rc < 0) return rc;

	opts.show = GIT_STATUS_SHOW_INDEX_AND_WORKDIR;
	opts.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED |
		GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS |
		GIT_STATUS_OPT_RENAMES_HEAD_TO_INDEX |
		GIT_STATUS_OPT_RENAMES_INDEX_TO_WORKDIR;
	if (npathspecs > 0) {
		opts.pathspec.strings = (char **)pathspecs;
		opts.pathspec.count = (size_t)npathspecs;
	}

	git_status_list *list = NULL;
	rc = git_status_list_new(&list, repo, &opts);
	if (rc < 0) return rc;

	size_t count = git_status_list_entrycount(list);
	uint8_t *buf = NULL;
	size_t len = 0, cap = 0;

	for (size_t i = 0; i < count; i++) {
		const git_status_entry *e = git_status_byindex(list, i);
		if (e == NULL) continue;
		const char *path = NULL;
		if (e->index_to_workdir != NULL) path = e->index_to_workdir->new_file.path;
		else if (e->head_to_index != NULL) path = e->head_to_index->new_file.path;
		if (path == NULL) path = "";

		uint32_t statusFlags = (uint32_t)e->status;
		uint32_t pathLen = (uint32_t)strlen(path);
		if (append_u32(&buf, &len, &cap, statusFlags) < 0 ||
			append_u32(&buf, &len, &cap, pathLen) < 0 ||
			buf_append(&buf, &len, &cap, path, pathLen) < 0) {
			free(buf);
			git_status_list_free(list);
			return -1;
		}
	}

	git_status_list_free(list);
	*out_buf = buf;
	*out_count = count;
	return 0;
}

/* ---------------------------------------------------------------------------
 * writeBlobAndStageOid(): build the blob + git_index_entry entirely in C.
 * ---------------------------------------------------------------------------
 *
 * Backs `Libgit2Repository.writeBlobAndStageOid` (and is also what a real
 * `stagePath` implementation reuses once a filter is registered, since it's
 * the only way to land a filter-transformed oid directly — see binding.ts's
 * doc comment on `writeBlobAndStageOid`). `out_oid` must point at a
 * caller-allocated 20-byte buffer. Does NOT call `git_index_write` —
 * `engine.ts` does that once after every mutation, same as the rest of the
 * index-mutating entry points already exported directly (`git_index_add_bypath`
 * etc.).
 */
EMSCRIPTEN_KEEPALIVE
int halyard_index_add_blob(
	git_repository *repo,
	git_index *index,
	const char *path,
	const uint8_t *content,
	size_t content_len,
	int is_executable,
	uint8_t *out_oid) {
	git_oid blob_oid;
	int rc = git_blob_create_from_buffer(&blob_oid, repo, content, content_len);
	if (rc < 0) return rc;

	git_index_entry entry;
	memset(&entry, 0, sizeof(entry));
	entry.mode = is_executable ? GIT_FILEMODE_BLOB_EXECUTABLE : GIT_FILEMODE_BLOB;
	entry.file_size = (uint32_t)content_len;
	entry.id = blob_oid;
	entry.path = path;

	rc = git_index_add(index, &entry);
	if (rc < 0) return rc;

	memcpy(out_oid, blob_oid.id, GIT_OID_SHA1_SIZE);
	return 0;
}

/* ---------------------------------------------------------------------------
 * log(): flat array of 20-byte oids, topological order, via git_revwalk.
 * ---------------------------------------------------------------------------
 *
 * Backs `Libgit2Repository.log`. `start_oid`/`until_oid` are caller-owned
 * 20-byte buffers (`until_oid` may be NULL for an unbounded walk, matching
 * binding.ts's optional `until`). Inclusive of `until_oid` when given — the
 * walk stops (successfully) the same iteration it emits the matching oid, so
 * `engine.ts`'s `findIndex`-equivalent loop over the result translates
 * directly from `GitEngine.aheadBehind`'s `countCommits` today, per
 * binding.ts's doc comment on `log`.
 */
EMSCRIPTEN_KEEPALIVE
int halyard_revwalk_collect(
	git_repository *repo,
	const uint8_t *start_oid,
	const uint8_t *until_oid,
	uint8_t **out_buf,
	size_t *out_count) {
	git_oid start;
	memcpy(start.id, start_oid, GIT_OID_SHA1_SIZE);
	git_oid until;
	int has_until = until_oid != NULL;
	if (has_until) memcpy(until.id, until_oid, GIT_OID_SHA1_SIZE);

	git_revwalk *walk = NULL;
	int rc = git_revwalk_new(&walk, repo);
	if (rc < 0) return rc;
	git_revwalk_sorting(walk, GIT_SORT_TOPOLOGICAL);
	rc = git_revwalk_push(walk, &start);
	if (rc < 0) {
		git_revwalk_free(walk);
		return rc;
	}

	uint8_t *buf = NULL;
	size_t len = 0, cap = 0;
	size_t count = 0;
	git_oid oid;
	for (;;) {
		rc = git_revwalk_next(&oid, walk);
		if (rc == GIT_ITEROVER) {
			rc = 0;
			break;
		}
		if (rc < 0) break;
		if (buf_append(&buf, &len, &cap, oid.id, GIT_OID_SHA1_SIZE) < 0) {
			rc = -1;
			break;
		}
		count++;
		if (has_until && memcmp(oid.id, until.id, GIT_OID_SHA1_SIZE) == 0) {
			rc = 0;
			break;
		}
	}
	git_revwalk_free(walk);
	if (rc != 0) {
		free(buf);
		return rc;
	}

	*out_buf = buf;
	*out_count = count;
	return 0;
}

/* ---------------------------------------------------------------------------
 * readBlob(commitOid, path): resolve commit -> tree -> path -> blob and copy
 * its raw content out, entirely in C.
 * ---------------------------------------------------------------------------
 *
 * Backs `Libgit2Repository.readBlob`. Deliberately narrows
 * `git_blob_rawsize()`'s `git_object_size_t` (a fixed 64-bit type) to a
 * `size_t` (32-bit on this wasm32 build, confirmed via build.sh's own
 * `size_t`-is-`unsigned long`-but-32-bit-wide note) BEFORE crossing back into
 * JS, rather than exporting `git_blob_rawsize`/`git_blob_rawcontent`
 * individually and marshaling a 64-bit value through `ccall` — Emscripten's
 * `ccall`/`cwrap` "number" return-type marshaling for a genuine 64-bit C
 * return value is a real, separate ABI question this phase did not need to
 * answer, since no blob this plugin will ever handle approaches 4GiB (the
 * plugin's own whole-buffered-response design in DESIGN.md already assumes
 * device-memory-bounded content far below that). Every other collector in
 * this file follows the same discipline: only 32-bit scalars and flat byte
 * buffers ever cross the boundary.
 */
EMSCRIPTEN_KEEPALIVE
int halyard_read_blob_at_path(
	git_repository *repo,
	const uint8_t *commit_oid,
	const char *path,
	uint8_t **out_buf,
	size_t *out_len) {
	git_oid coid;
	memcpy(coid.id, commit_oid, GIT_OID_SHA1_SIZE);

	git_commit *commit = NULL;
	int rc = git_commit_lookup(&commit, repo, &coid);
	if (rc < 0) return rc;

	git_tree *tree = NULL;
	rc = git_commit_tree(&tree, commit);
	if (rc < 0) {
		git_commit_free(commit);
		return rc;
	}

	git_tree_entry *entry = NULL;
	rc = git_tree_entry_bypath(&entry, tree, path);
	if (rc < 0) {
		git_tree_free(tree);
		git_commit_free(commit);
		return rc;
	}

	git_blob *blob = NULL;
	rc = git_blob_lookup(&blob, repo, git_tree_entry_id(entry));
	git_tree_entry_free(entry);
	git_tree_free(tree);
	git_commit_free(commit);
	if (rc < 0) return rc;

	size_t size = (size_t)git_blob_rawsize(blob);
	const void *content = git_blob_rawcontent(blob);
	uint8_t *buf = (uint8_t *)malloc(size > 0 ? size : 1);
	if (buf == NULL) {
		git_blob_free(blob);
		return -1;
	}
	memcpy(buf, content, size);
	git_blob_free(blob);

	*out_buf = buf;
	*out_len = size;
	return 0;
}

/* ---------------------------------------------------------------------------
 * fetch()/push(): build a one-entry git_strarray refspec (or none) entirely
 * in C, same "no strarray offsets in JS" reasoning as everywhere else in
 * this file.
 * ---------------------------------------------------------------------------
 *
 * `halyard_remote_fetch` backs `Libgit2Repository.fetch` — `refspec` is NULL
 * to use the remote's configured refspecs (binding.ts: "or the remote's
 * configured refspecs when `branch` is omitted"), or a single explicit
 * `+refs/heads/<branch>:refs/remotes/<remote>/<branch>`-shaped string built
 * by `engine.ts`. `depth` is `GIT_FETCH_DEPTH_FULL` (0) for a full fetch,
 * matching `CloneOptions.depth`'s optional-shallow contract.
 */
EMSCRIPTEN_KEEPALIVE
int halyard_remote_fetch(git_remote *remote, const char *refspec, int depth) {
	char *refspec_copy = NULL;
	git_strarray refspecs;
	git_strarray *refspecs_ptr = NULL;
	if (refspec != NULL) {
		refspec_copy = strdup(refspec);
		if (refspec_copy == NULL) return -1;
		refspecs.strings = &refspec_copy;
		refspecs.count = 1;
		refspecs_ptr = &refspecs;
	}

	git_fetch_options opts;
	int rc = git_fetch_options_init(&opts, GIT_FETCH_OPTIONS_VERSION);
	if (rc < 0) {
		free(refspec_copy);
		return rc;
	}
	opts.depth = depth;

	rc = git_remote_fetch(remote, refspecs_ptr, &opts, NULL);
	free(refspec_copy);
	return rc;
}

/** Backs `Libgit2Repository.push` — always exactly one explicit refspec
 * (`engine.ts` builds `+refs/heads/<ref>:refs/heads/<remoteRef>` per
 * binding.ts's `push` doc comment; the `+` force-prefix is engine.ts's job,
 * not this function's). */
EMSCRIPTEN_KEEPALIVE
int halyard_remote_push(git_remote *remote, const char *refspec) {
	char *refspec_copy = strdup(refspec);
	if (refspec_copy == NULL) return -1;
	git_strarray refspecs;
	refspecs.strings = &refspec_copy;
	refspecs.count = 1;
	int rc = git_remote_push(remote, &refspecs, NULL);
	free(refspec_copy);
	return rc;
}

/* ---------------------------------------------------------------------------
 * listRemoteRefs(): connect to a URL with no local repo, list advertised
 * refs, disconnect. Flat records: [20-byte oid][uint32 nameLen][name bytes].
 * ---------------------------------------------------------------------------
 *
 * Backs `Libgit2Module.listRemoteRefs` — `git_remote_create_detached` (not
 * `_create_anonymous`, which needs a repo) matches binding.ts's doc comment
 * that this is callable with "just a URL", no open repository. Routes
 * through whatever subtransport is registered for the URL's scheme
 * (`halyard_register_http_transport`, see transport_shim.c) exactly like
 * fetch/push do — no separate network path.
 */
EMSCRIPTEN_KEEPALIVE
int halyard_remote_ls_collect(
	const char *url,
	uint8_t **out_buf,
	size_t *out_count) {
	git_remote *remote = NULL;
	int rc = git_remote_create_detached(&remote, url);
	if (rc < 0) return rc;

	rc = git_remote_connect(remote, GIT_DIRECTION_FETCH, NULL, NULL, NULL);
	if (rc < 0) {
		git_remote_free(remote);
		return rc;
	}

	const git_remote_head **heads = NULL;
	size_t heads_len = 0;
	rc = git_remote_ls(&heads, &heads_len, remote);
	if (rc < 0) {
		git_remote_disconnect(remote);
		git_remote_free(remote);
		return rc;
	}

	uint8_t *buf = NULL;
	size_t len = 0, cap = 0;
	for (size_t i = 0; i < heads_len; i++) {
		const git_remote_head *h = heads[i];
		uint32_t nameLen = (uint32_t)strlen(h->name);
		if (buf_append(&buf, &len, &cap, h->oid.id, GIT_OID_SHA1_SIZE) < 0 ||
			append_u32(&buf, &len, &cap, nameLen) < 0 ||
			buf_append(&buf, &len, &cap, h->name, nameLen) < 0) {
			free(buf);
			git_remote_disconnect(remote);
			git_remote_free(remote);
			return -1;
		}
	}

	git_remote_disconnect(remote);
	git_remote_free(remote);
	*out_buf = buf;
	*out_count = heads_len;
	return 0;
}

/* ---------------------------------------------------------------------------
 * Local ref enumeration by glob, same flat record shape as listRemoteRefs
 * above. Used by engine.ts's `fetch()` to report `FetchSummary.updatedRefs`
 * by re-reading whatever local refs/remotes/<remote>/(glob) now point at after a
 * successful `git_remote_fetch`, rather than needing a second network round
 * trip to ask the remote again.
 * ---------------------------------------------------------------------------
 */
/* ---------------------------------------------------------------------------
 * merge(): `git_merge_commits` with a real, non-default `git_merge_options` —
 * struct-layout knowledge, same reasoning as every other function in this
 * file (a hand-built options struct from JS offsets is exactly what this
 * file exists to avoid). Tunes the merge-file diff itself, not the
 * never-write-conflict-markers safety property engine.ts's `merge()` already
 * guarantees: this still only ever produces an in-memory `git_index` (or a
 * negative rc), never touches the repository's real index/working tree,
 * regardless of these flags.
 *
 * `find_renames`/`rename_threshold`: GIT_MERGE_FIND_RENAMES + the standard
 * percentage threshold (git's own CLI default is 50), so a note renamed on
 * one device and edited on another is recognized as the same file instead of
 * surfacing as an unrelated add+delete.
 * `file_favor`: passed through as-is (`GIT_MERGE_FILE_FAVOR_NORMAL` today —
 * the caller decides; UNION would silently interleave both sides' text with
 * no conflict at all, which is a real behavior change, not a tuning knob, so
 * engine.ts does not default to it).
 * `diff_patience`/`diff_minimal`: GIT_MERGE_FILE_DIFF_PATIENCE +
 * GIT_MERGE_FILE_DIFF_MINIMAL — patience/histogram-style diff produces fewer
 * spurious overlapping hunks than plain Myers on reordered outline/list
 * content, which is the common shape of a note edited on two devices.
 * `ignore_whitespace_change`: GIT_MERGE_FILE_IGNORE_WHITESPACE_CHANGE —
 * avoids a false conflict from a whitespace-only difference introduced by an
 * editor's autoformat.
 * ---------------------------------------------------------------------------
 */
EMSCRIPTEN_KEEPALIVE
int halyard_merge_commits_opts(
	git_index **out,
	git_repository *repo,
	const git_commit *ours,
	const git_commit *theirs,
	int find_renames,
	unsigned int rename_threshold,
	int file_favor,
	int diff_patience,
	int diff_minimal,
	int ignore_whitespace_change) {
	git_merge_options opts;
	int rc = git_merge_options_init(&opts, GIT_MERGE_OPTIONS_VERSION);
	if (rc < 0) return rc;

	if (find_renames) {
		opts.flags |= GIT_MERGE_FIND_RENAMES;
		if (rename_threshold > 0) opts.rename_threshold = rename_threshold;
	}
	opts.file_favor = (git_merge_file_favor_t)file_favor;
	if (diff_patience) opts.file_flags |= GIT_MERGE_FILE_DIFF_PATIENCE;
	if (diff_minimal) opts.file_flags |= GIT_MERGE_FILE_DIFF_MINIMAL;
	if (ignore_whitespace_change) opts.file_flags |= GIT_MERGE_FILE_IGNORE_WHITESPACE_CHANGE;

	return git_merge_commits(out, repo, ours, theirs, &opts);
}

/* ---------------------------------------------------------------------------
 * merge(): collect conflicting paths out of an in-memory `git_index` built by
 * `git_merge_commits` (see engine.ts's `merge()` header comment for why this
 * phase deliberately calls `git_merge_commits` — a pure, no-disk-writes,
 * no-checkout in-memory merge — instead of the top-level `git_merge()`
 * entry point). Flat records: `[uint32 pathLen][path bytes]`, one per
 * distinct conflicted path.
 * ---------------------------------------------------------------------------
 *
 * `git_index_conflict_next` hands back three possibly-NULL
 * `const git_index_entry*` (ancestor/ours/theirs) per conflicted path;
 * exactly the kind of struct-field access (`->path`) this file exists to do
 * in C rather than have engine.ts hardcode `git_index_entry`'s layout. Real
 * libgit2 index ordering groups every stage of one conflicted path
 * consecutively, so de-duplicating against only the immediately preceding
 * emitted path (rather than a full seen-set) is sufficient here — verified
 * against the real compiled module in tests/libgit2/engine.test.ts's merge
 * conflict case.
 */
EMSCRIPTEN_KEEPALIVE
int halyard_merge_conflict_paths_collect(
	git_index *index,
	uint8_t **out_buf,
	size_t *out_count) {
	git_index_conflict_iterator *iter = NULL;
	int rc = git_index_conflict_iterator_new(&iter, index);
	if (rc < 0) return rc;

	uint8_t *buf = NULL;
	size_t len = 0, cap = 0;
	size_t count = 0;
	const char *last_path = NULL;
	const git_index_entry *ancestor, *ours, *theirs;

	for (;;) {
		rc = git_index_conflict_next(&ancestor, &ours, &theirs, iter);
		if (rc == GIT_ITEROVER) {
			rc = 0;
			break;
		}
		if (rc < 0) break;

		const char *path = NULL;
		if (ancestor != NULL) path = ancestor->path;
		else if (ours != NULL) path = ours->path;
		else if (theirs != NULL) path = theirs->path;
		if (path == NULL) continue;
		if (last_path != NULL && strcmp(last_path, path) == 0) continue;

		uint32_t pathLen = (uint32_t)strlen(path);
		if (append_u32(&buf, &len, &cap, pathLen) < 0 ||
			buf_append(&buf, &len, &cap, path, pathLen) < 0) {
			rc = -1;
			break;
		}
		count++;
		last_path = path;
	}
	git_index_conflict_iterator_free(iter);
	if (rc != 0) {
		free(buf);
		return rc;
	}

	*out_buf = buf;
	*out_count = count;
	return 0;
}

/* ---------------------------------------------------------------------------
 * listPathsWithAttribute(): walk every path currently in `index` and ask
 * libgit2's real attribute-resolution machinery (`git_attr_get`, the same
 * `.gitattributes`-parsing/precedence logic real `git`/git-crypt rely on —
 * NOT a reimplementation of gitattributes parsing) for `attr_name`'s value at
 * that path. Flat records: `[uint32 pathLen][path bytes][uint32 valueLen]
 * [value bytes]`, one per path where the attribute resolves to a real string
 * value (`GIT_ATTR_VALUE_STRING` — i.e. `filter=git-crypt`-shaped, not a
 * bare boolean/unspecified attribute), matching binding.ts's
 * `listPathsWithAttribute` contract ("value: string" per path).
 * ---------------------------------------------------------------------------
 *
 * Uses `GIT_ATTR_CHECK_INDEX_ONLY` rather than the default
 * working-directory-then-index precedence: binding.ts's own doc comment for
 * this method describes it as "equivalent to walking the index," and using
 * INDEX_ONLY means a stray uncommitted `.gitattributes` edit in the working
 * tree can't produce a result that doesn't match what's actually staged —
 * consistent with `detectUnsupportedFilters` in src/git/engine.ts, which
 * also reads the INDEX's `.gitattributes` rather than the working tree's.
 * See that file's `detectUnsupportedFiltersInWorkingTree` for the
 * working-tree-walking variant kept for the pre-init case.
 *
 * `git_attr_get`'s repo-level attribute cache reads through the SAME
 * `git_index*` singleton `git_repository_index` always returns for a given
 * `git_repository*` (confirmed via `git_repository_index`'s own real
 * implementation: it lazily creates and then reuses one cached instance for
 * the life of the repository) — so passing `index` in here explicitly is
 * for the entrycount/path walk only; it does not create any risk of reading
 * a *different* index than the one `git_attr_get` itself consults.
 */
EMSCRIPTEN_KEEPALIVE
int halyard_list_paths_with_attribute(
	git_repository *repo,
	git_index *index,
	const char *attr_name,
	uint8_t **out_buf,
	size_t *out_count) {
	size_t n = git_index_entrycount(index);
	uint8_t *buf = NULL;
	size_t len = 0, cap = 0;
	size_t count = 0;

	for (size_t i = 0; i < n; i++) {
		const git_index_entry *entry = git_index_get_byindex(index, i);
		if (entry == NULL || entry->path == NULL) continue;

		const char *value = NULL;
		int rc = git_attr_get(&value, repo, GIT_ATTR_CHECK_INDEX_ONLY, entry->path, attr_name);
		if (rc < 0) {
			free(buf);
			return rc;
		}
		if (git_attr_value(value) != GIT_ATTR_VALUE_STRING) continue;

		uint32_t pathLen = (uint32_t)strlen(entry->path);
		uint32_t valueLen = (uint32_t)strlen(value);
		if (append_u32(&buf, &len, &cap, pathLen) < 0 ||
			buf_append(&buf, &len, &cap, entry->path, pathLen) < 0 ||
			append_u32(&buf, &len, &cap, valueLen) < 0 ||
			buf_append(&buf, &len, &cap, value, valueLen) < 0) {
			free(buf);
			return -1;
		}
		count++;
	}

	*out_buf = buf;
	*out_count = count;
	return 0;
}

EMSCRIPTEN_KEEPALIVE
int halyard_list_refs_with_glob(
	git_repository *repo,
	const char *glob,
	uint8_t **out_buf,
	size_t *out_count) {
	git_reference_iterator *iter = NULL;
	int rc = git_reference_iterator_glob_new(&iter, repo, glob);
	if (rc < 0) return rc;

	uint8_t *buf = NULL;
	size_t len = 0, cap = 0;
	size_t count = 0;
	git_reference *ref = NULL;
	for (;;) {
		rc = git_reference_next(&ref, iter);
		if (rc == GIT_ITEROVER) {
			rc = 0;
			break;
		}
		if (rc < 0) break;

		const git_oid *target = git_reference_target(ref);
		const char *name = git_reference_name(ref);
		if (target != NULL && name != NULL) {
			uint32_t nameLen = (uint32_t)strlen(name);
			if (buf_append(&buf, &len, &cap, target->id, GIT_OID_SHA1_SIZE) < 0 ||
				append_u32(&buf, &len, &cap, nameLen) < 0 ||
				buf_append(&buf, &len, &cap, name, nameLen) < 0) {
				git_reference_free(ref);
				free(buf);
				rc = -1;
				break;
			}
			count++;
		}
		git_reference_free(ref);
	}
	git_reference_iterator_free(iter);
	if (rc != 0) {
		free(buf);
		return rc;
	}

	*out_buf = buf;
	*out_count = count;
	return 0;
}
