#!/usr/bin/env bash
#
# Compiles libgit2 + native/filter_shim.c + native/transport_shim.c into a
# WASM module + JS glue.
#
# =============================================================================
# STATUS: this has actually been built and its output actually exercised.
# Run for real via Docker (`emscripten/emsdk:6.0.3`) — see BUILD.md for the
# exact commands, every real compiler/runtime error hit along the way and
# how each was fixed, and the resolved answer to the Asyncify
# double-suspension question. `tests/libgit2/filter-smoke.test.ts` and
# `tests/libgit2/asyncify-double-suspension.test.ts` load the real compiled
# output of this script and pass. If you change this script or the native/
# sources, re-run it (see BUILD.md's "How to actually build it") and re-run
# those two test files before trusting a new `dist/` — nothing here is
# unverified anymore, but that only stays true if the artifact is kept in
# sync with the source.
# =============================================================================
#
# Usage:
#   ./build.sh
#   (or, on Windows/Docker Desktop, see BUILD.md — do NOT use $(pwd)-expanded
#   POSIX paths in -v bind mounts from git-bash; use Windows-style paths and
#   a named volume for .build-work. Both gotchas cost real time — see
#   BUILD.md's "Windows/Docker Desktop gotchas" section.)
#
# Produces (on success):
#   dist/tether-libgit2.js    — Emscripten glue (MODULARIZE'd factory function)
#   dist/tether-libgit2.wasm  — the compiled module
#
# Env overrides: WORKDIR (default: ./.build-work), JOBS (default: nproc).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$HERE/versions.env"

WORKDIR="${WORKDIR:-$HERE/.build-work}"
DIST="$HERE/dist"
JOBS="${JOBS:-$(command -v nproc >/dev/null 2>&1 && nproc || echo 4)}"

echo "== halyard-sync libgit2-wasm build =="
echo "libgit2:  $LIBGIT2_REF"
echo "emsdk:    $EMSDK_VERSION"
echo "workdir:  $WORKDIR"
echo

if ! command -v git >/dev/null 2>&1; then
	echo "error: git is required and not on PATH" >&2
	exit 1
fi

mkdir -p "$WORKDIR" "$DIST"

# ---------------------------------------------------------------------------
# 1. Emscripten SDK — install/activate the pinned version, idempotently.
# ---------------------------------------------------------------------------
EMSDK_DIR="$WORKDIR/emsdk"
if [ ! -d "$EMSDK_DIR" ]; then
	git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
(
	cd "$EMSDK_DIR"
	git fetch --depth 1 origin main
	git checkout main
	# `reset --hard` (not `pull --ff-only`): this is a throwaway build-cache
	# clone, re-fetched with `--depth 1` every run, so its `main` is
	# routinely a shallow history that doesn't fast-forward against a fresh
	# `origin/main` (real failure hit on a rebuild: "Your branch and
	# 'origin/main' have diverged ... fatal: Not possible to fast-forward").
	# A hard reset to whatever origin/main now is is always correct here —
	# there is no local work in this clone to lose.
	git reset --hard origin/main
	./emsdk install "$EMSDK_VERSION"
	./emsdk activate "$EMSDK_VERSION"
)
# shellcheck source=/dev/null
source "$EMSDK_DIR/emsdk_env.sh"

if ! command -v emcc >/dev/null 2>&1; then
	echo "error: emcc not on PATH after activating emsdk $EMSDK_VERSION — activation failed" >&2
	exit 1
fi
echo "emcc: $(emcc --version | head -n1)"

# ---------------------------------------------------------------------------
# 2. libgit2 source, pinned tag.
# ---------------------------------------------------------------------------
LIBGIT2_DIR="$WORKDIR/libgit2"
if [ ! -d "$LIBGIT2_DIR" ]; then
	git clone https://github.com/libgit2/libgit2.git "$LIBGIT2_DIR"
fi
(
	cd "$LIBGIT2_DIR"
	git fetch --tags origin
	git checkout "$LIBGIT2_REF"
)

# ---------------------------------------------------------------------------
# 2b. Real, necessary patch discovered on the first actual build (see
# BUILD.md's "what actually happened" section): libgit2's src/util/integer.h
# picks which `__builtin_u{add,mul}*_overflow` intrinsic to use for
# `git__{add,multiply}_sizet_overflow` by comparing `SIZE_MAX == UINT_MAX`
# vs `SIZE_MAX == ULONG_MAX` -- a VALUE comparison, not a type comparison.
# Emscripten's wasm32 target has `int` and `long` both 32-bit, so
# `UINT_MAX == ULONG_MAX == SIZE_MAX` numerically, and the `#if` chain always
# picks the first (unsigned-int) branch -- but Emscripten's clang actually
# typedefs `size_t` as `unsigned long`, not `unsigned int`, on this target.
# `__builtin_umul_overflow`'s output-pointer parameter type-checks exactly
# (not just by width), so the mismatch is a hard compiler error:
# "incompatible pointer types passing 'size_t *' (aka 'unsigned long *') to
# parameter of type 'unsigned int *'" in src/util/alloc.c and src/util/array.h.
# This patch forces Emscripten onto the `unsigned long` branch explicitly;
# it only takes effect under `__EMSCRIPTEN__` and leaves every other
# platform's build of libgit2 (which this pipeline never touches anyway --
# each run clones its own throwaway copy) untouched.
sed -i \
	-e 's/# if (SIZE_MAX == UINT_MAX)/# if (SIZE_MAX == UINT_MAX) \&\& !defined(__EMSCRIPTEN__)/' \
	-e 's/# elif (SIZE_MAX == ULONG_MAX)/# elif (SIZE_MAX == ULONG_MAX) || defined(__EMSCRIPTEN__)/' \
	"$LIBGIT2_DIR/src/util/integer.h"

# ---------------------------------------------------------------------------
# 3. Configure + build libgit2 as a static library via emcmake/emmake.
#
# Option choices and why (each is a DRAFT to be validated against libgit2's
# actual CMakeLists.txt at $LIBGIT2_REF on the first real build — option
# names have shifted between libgit2 releases before, e.g. the
# USE_SSH/USE_HTTPS boolean-vs-string-backend-name conventions):
#
#   BUILD_SHARED_LIBS=OFF     — we want one static lib to link into the
#                               final emcc invocation, not a .so (which
#                               means nothing in WASM anyway).
#   BUILD_TESTS=OFF,
#   BUILD_CLI=OFF             — neither is needed; keeps the build fast and
#                               avoids pulling in libgit2's CLI's own extra
#                               dependencies.
#   BUILD_EXAMPLES=OFF        — same reasoning.
#   USE_SSH=OFF               — no SSH transport, ever (see DESIGN.md #2 —
#                               this constraint predates this phase and
#                               applies identically here: no subprocess, no
#                               real sockets in a webview).
#   USE_HTTPS=OFF             — libgit2's own HTTP transport (curl/winhttp/
#                               a native TLS backend) is meaningless in
#                               WASM and would need native TLS libraries we
#                               have no way to link; http-transport.ts's
#                               custom git_smart_subtransport replaces this
#                               entirely, registered at runtime via
#                               git_transport_register, not compiled in.
#   USE_THREADS=OFF           — no pthreads: this build does not pass
#                               `-pthread`/`-sUSE_PTHREADS`, since Emscripten
#                               pthreads need
#                               SharedArrayBuffer + cross-origin-isolation
#                               headers Obsidian's webview environment does
#                               not control, and libgit2's threading is an
#                               optimization, not a correctness requirement,
#                               for our single-repo-at-a-time usage (all
#                               engine-touching operations are already
#                               serialized through one AsyncLock — see
#                               DESIGN.md's "Engine-touching operations...
#                               serialized" note — so no benefit is lost).
#   USE_SHA1=CollisionDetection (libgit2's default) — left as default
#                               rather than swapping to a "builtin"/OpenSSL
#                               backend we'd need to separately vendor or
#                               link; CollisionDetection is a pure-C
#                               algorithm with no external dependency, which
#                               matters a lot for a WASM build with no
#                               system OpenSSL to link against.
#   USE_HTTP_PARSER=builtin,
#   REGEX_BACKEND=builtin     — avoid depending on system libraries that
#                               don't exist in an Emscripten sysroot the way
#                               they would on a real OS.
#
CMAKE_BUILD_DIR="$WORKDIR/libgit2-build"
mkdir -p "$CMAKE_BUILD_DIR"
(
	cd "$CMAKE_BUILD_DIR"
	emcmake cmake "$LIBGIT2_DIR" \
		-DCMAKE_BUILD_TYPE=Release \
		-DBUILD_SHARED_LIBS=OFF \
		-DBUILD_TESTS=OFF \
		-DBUILD_CLI=OFF \
		-DBUILD_EXAMPLES=OFF \
		-DUSE_SSH=OFF \
		-DUSE_HTTPS=OFF \
		-DUSE_THREADS=OFF \
		-DREGEX_BACKEND=builtin \
		-DUSE_HTTP_PARSER=builtin \
		-DUSE_GSSAPI=OFF \
		-DUSE_NTLMCLIENT=OFF
	emmake make -j"$JOBS" libgit2package
)

STATIC_LIB="$(find "$CMAKE_BUILD_DIR" -maxdepth 1 -name 'libgit2.a' -print -quit)"
if [ -z "$STATIC_LIB" ]; then
	echo "error: libgit2.a not found under $CMAKE_BUILD_DIR — check the emmake build log above" >&2
	exit 1
fi
echo "built: $STATIC_LIB"

# ---------------------------------------------------------------------------
# 4. Compile the filter shim and link everything into the final module.
#
# Flags, and why (again, draft — first-build territory, see BUILD.md):
#
#   -sASYNCIFY=1              — required by native/filter_shim.c's
#                                EM_ASYNC_JS calls (see that file's header
#                                for the detailed risk writeup) and by
#                                http-transport.ts's future C glue (not
#                                written yet — the phase brief scoped the
#                                C shim to the filter only). ASYNCIFY_IMPORTS
#                                is left to Emscripten's automatic handling
#                                of EM_ASYNC_JS-declared functions rather
#                                than listed manually; this needs
#                                double-checking against the real Emscripten
#                                docs for whichever minor version 6.0.3 turns
#                                out to need it spelled out explicitly.
#                                CONFIRMED on the real first build:
#                                ASYNCIFY_IMPORTS did NOT need to be listed
#                                manually — EM_ASYNC_JS's automatic handling
#                                worked as documented.
#   -sASYNCIFY_STACK_SIZE=1048576 — raised defensively alongside the real
#                                stack-size bug below (same symptom, adjacent
#                                cause: this is Asyncify's OWN separate
#                                bookkeeping buffer for recording the C call
#                                stack across a suspend, not the normal wasm
#                                stack). Raising this alone did NOT fix the
#                                crash described below -- keeping it raised
#                                anyway since a deep real call chain plus a
#                                genuine async suspend (the actual crypto
#                                callback, exercised later once the real bug
#                                was fixed) is exactly the situation this
#                                buffer needs headroom for, and 1MiB costs
#                                nothing meaningful in a desktop/mobile
#                                Obsidian webview.
#   -sSTACK_SIZE=5242880       — THE REAL BUG on the first build (not the
#                                Asyncify stack above, which was a red
#                                herring investigated first because the trap
#                                surfaced on the first call that went through
#                                an EM_ASYNC_JS-registered filter). The
#                                actual crash reproduced on a call with NO
#                                filter attached at all and NO Asyncify
#                                suspend involved: a plain
#                                `git_index_add_bypath` on an unfiltered
#                                file trapped with "RuntimeError: memory
#                                access out of bounds" too. Root cause:
#                                libgit2's src/libgit2/blob.c
#                                `write_file_stream()` stack-allocates
#                                `char buffer[GIT_BUFSIZE_FILEIO]`, and
#                                `GIT_BUFSIZE_FILEIO` is 65536 (64KiB,
#                                src/util/git2_util.h's
#                                `GIT_BUFSIZE_DEFAULT`) -- a single stack
#                                frame bigger than (or equal to) Emscripten's
#                                classic default total wasm stack size,
#                                guaranteeing overflow the moment that
#                                function is reached, independent of
#                                Asyncify entirely. Raising `-sSTACK_SIZE`
#                                to 5MiB made both the unfiltered and
#                                filtered `git_index_add_bypath` calls
#                                succeed. Lesson for future EXPORTED_FUNCTIONS
#                                additions: a real crash's stack trace
#                                pointing deep into wasm-only frames (no JS
#                                boundary yet crossed) is a stack-overflow
#                                signal first, not necessarily an Asyncify
#                                problem, even when the call path also
#                                happens to involve Asyncify.
#   -sALLOW_MEMORY_GROWTH=1   — vault sizes are not known upfront; a fixed
#                                heap would need worst-case sizing guesswork.
#   -sMODULARIZE=1
#   -sEXPORT_NAME=TetherLibgit2 — a factory function
#                                `TetherLibgit2(moduleOverrides)` rather
#                                than a global, so multiple instances (e.g.
#                                test isolation) don't collide and so it
#                                bundles cleanly under esbuild.
#   -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,setValue,getValue,HEAPU8
#                              — the JS-side primitives filter_shim.c's
#                                EM_ASYNC_JS blocks and the future TS binding
#                                layer both need directly.
#   -sFILESYSTEM=1             — classic FS (not WasmFS) per fs-backend.ts's
#                                recommendation; explicit here since it's a
#                                real behavioral choice, not the default in
#                                every Emscripten configuration.
#   --no-entry                 — this is a library module, not an
#                                executable; there is no `main()`.
#
# EXPORTED_FUNCTIONS is the single biggest "this is a draft" item in this
# whole pipeline: it is binding.ts's contract translated into the libgit2 C
# function names that would back it, checked individually against libgit2's
# public headers where this phase's research actually fetched them (remote.h,
# status.h, filter.h, sys/filter.h, sys/transport.h — see those files' own
# doc comments for citations) and filled in with well-known, stable libgit2
# entry points elsewhere (git_repository_*, git_index_*, git_commit_create,
# git_reference_*, git_revwalk_*, git_checkout_tree, git_merge*) that were
# NOT individually re-verified against the header in this session. Expect to
# adjust this list once real compiler errors ("undefined symbol") say
# otherwise.
# NOTE: this list was revised after a real build attempt (see BUILD.md's
# "what actually happened" section). Additions beyond the original draft,
# and why: git_index_write_tree/git_tree_lookup/git_tree_free/
# git_signature_free/git_checkout_options_init/git_checkout_head/
# git_object_free/git_error_last were all missing from the first draft but
# are required to drive a real add->commit->checkout cycle (the smoke test's
# actual call sequence) — git_commit_create needs a git_tree*, which needs
# git_index_write_tree + git_tree_lookup; nothing in the original draft could
# produce one. git_error_last is needed to get a human-readable message out
# of a negative return code while debugging.
# NOTE (Phase 4 — real merge()/listPathsWithAttribute()): added
# git_reference_lookup, git_annotated_commit_from_ref/_id/_free,
# git_merge_commits, git_index_has_conflicts, git_index_conflict_iterator_new/
# _next/_free, git_attr_get/_value, git_index_entrycount/_get_byindex, plus
# native/engine_shim.c's new tether_merge_conflict_paths_collect and
# tether_list_paths_with_attribute collectors — see engine.ts's merge()/
# listPathsWithAttribute() header comments for exactly how each is used and,
# for merge() specifically, why the top-level git_merge() C entry point
# (already exported, unused by this phase) was deliberately NOT called.
EXPORTED_FUNCTIONS='[
  "_git_libgit2_init","_git_libgit2_shutdown",
  "_git_repository_init","_git_repository_open","_git_repository_free",
  "_git_repository_head","_git_repository_set_head",
  "_git_remote_create","_git_remote_lookup","_git_remote_free",
  "_git_remote_ls","_git_remote_fetch","_git_remote_push",
  "_git_remote_set_url","_git_remote_create_detached","_git_remote_url",
  "_git_remote_connect","_git_remote_disconnect",
  "_git_transport_register","_git_transport_unregister",
  "_git_config_set_string","_git_config_get_string","_git_repository_config",
  "_git_repository_config_snapshot",
  "_git_config_free",
  "_git_status_list_new","_git_status_list_free",
  "_git_status_list_entrycount","_git_status_byindex","_git_status_options_init",
  "_git_index_add_bypath","_git_index_remove_bypath","_git_index_add",
  "_git_index_write","_git_index_write_tree","_git_index_write_tree_to",
  "_git_repository_index","_git_index_free",
  "_git_blob_create_from_buffer","_git_blob_lookup",
  "_git_blob_rawcontent","_git_blob_rawsize","_git_blob_free",
  "_git_tree_lookup","_git_tree_free","_git_tree_entry_bypath","_git_tree_id",
  "_git_tree_entry_id","_git_tree_entry_free","_git_commit_tree",
  "_git_signature_now","_git_signature_new","_git_signature_free",
  "_git_commit_create","_git_commit_lookup","_git_commit_free",
  "_git_object_free",
  "_git_reference_name_to_id","_git_reference_create",
  "_git_reference_shorthand","_git_reference_free",
  "_git_reference_iterator_glob_new","_git_reference_next",
  "_git_reference_iterator_free","_git_reference_name","_git_reference_target",
  "_git_reference_lookup",
  "_git_merge_base","_git_revwalk_new","_git_revwalk_push",
  "_git_revwalk_next","_git_revwalk_free","_git_revwalk_sorting",
  "_git_merge_analysis","_git_merge","_git_merge_commits",
  "_git_annotated_commit_from_ref","_git_annotated_commit_id",
  "_git_annotated_commit_free","_git_index_has_conflicts",
  "_git_index_conflict_iterator_new","_git_index_conflict_next",
  "_git_index_conflict_iterator_free",
  "_git_attr_get","_git_attr_value",
  "_git_index_entrycount","_git_index_get_byindex",
  "_git_checkout_tree",
  "_git_checkout_options_init","_git_checkout_head",
  "_git_filter_register","_git_filter_unregister",
  "_git_error_last",
  "_git_object_lookup","_git_oid_tostr","_git_oid_fromstr",
  "_tether_register_gitcrypt_filter","_tether_unregister_gitcrypt_filter",
  "_tether_register_http_transport","_tether_unregister_http_transport",
  "_tether_test_clone_and_checkout",
  "_git_fetch_options_init",
  "_tether_status_collect","_tether_index_add_blob",
  "_tether_revwalk_collect","_tether_remote_ls_collect",
  "_tether_list_refs_with_glob","_tether_read_blob_at_path",
  "_tether_remote_fetch","_tether_remote_push",
  "_tether_merge_conflict_paths_collect","_tether_list_paths_with_attribute",
  "_tether_merge_commits_opts",
  "_malloc","_free"
]'

# ---------------------------------------------------------------------------
# Two link steps, from the same objects
# ---------------------------------------------------------------------------
#
# The SHIPPED module (`tether-libgit2.js`) is linked for the web only:
#
#   -sENVIRONMENT=web,worker  drops Emscripten's Node.js branch from the glue.
#                             That branch is dead inside Obsidian either way
#                             (desktop is Electron's *renderer* process, which
#                             the glue's own environment check excludes from
#                             "node"; mobile has no Node at all), but it is a
#                             literal `require("node:fs")` in the shipped
#                             bytes, which any scanner reading the plugin —
#                             including the Obsidian plugin portal's — reports
#                             as "uses the Node.js fs module ... can read and
#                             write any file on the system". Users read that on
#                             the plugin's listing. Linking it out is the honest
#                             fix: the capability genuinely isn't there.
#   (no -lnodefs.js)          same reasoning. NODEFS maps a mount point onto a
#                             real host directory via node:fs, and nothing in
#                             the plugin mounts it — that is VaultMirror's job,
#                             see ../fs-backend.ts.
#
# The TEST module (`tether-libgit2.node.js`) keeps both, because the Node-based
# suite under `tests/libgit2/` mounts a real temp directory through NODEFS and
# cross-checks the module's on-disk output against the real `git` CLI. It is
# never shipped: esbuild bundles only the file `loader.ts` imports.
COMMON_LINK_FLAGS=(
	-O3
	-I"$LIBGIT2_DIR/include"
	"$HERE/../native/filter_shim.c"
	"$HERE/../native/transport_shim.c"
	"$HERE/../native/engine_shim.c"
	"$STATIC_LIB"
	-sASYNCIFY=1
	-sASYNCIFY_STACK_SIZE=1048576
	-sSTACK_SIZE=5242880
	-sALLOW_MEMORY_GROWTH=1
	-sMODULARIZE=1
	-sEXPORT_NAME=TetherLibgit2
	-sEXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS"
	-sFILESYSTEM=1
	--no-entry
)

RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","stringToUTF8","stringToNewUTF8","lengthBytesUTF8","setValue","getValue","HEAPU8","HEAP32","HEAPU32","FS"]'
RUNTIME_METHODS_NODE='["ccall","cwrap","UTF8ToString","stringToUTF8","stringToNewUTF8","lengthBytesUTF8","setValue","getValue","HEAPU8","HEAP32","HEAPU32","FS","NODEFS"]'

echo
echo "== linking shipped module (web/worker, no NODEFS) =="
emcc \
	"${COMMON_LINK_FLAGS[@]}" \
	-sENVIRONMENT=web,worker \
	-sEXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS" \
	-o "$DIST/tether-libgit2.js"

# The shipped glue must not carry a Node filesystem path at all. Checked here
# rather than trusted: this split is the whole point of the two link steps, and
# a flag that silently stopped taking effect on an Emscripten upgrade would
# otherwise reintroduce it unnoticed.
if grep -qE 'require\("(node:)?fs"\)' "$DIST/tether-libgit2.js"; then
	echo "error: shipped glue still references Node's fs module - check -sENVIRONMENT" >&2
	exit 1
fi

echo
echo "== linking test module (adds NODEFS, node environment) =="
emcc \
	"${COMMON_LINK_FLAGS[@]}" \
	-sEXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS_NODE" \
	-lnodefs.js \
	-o "$DIST/tether-libgit2.node.js"

# Both links produce the same wasm — the module's code does not depend on which
# JS environment its glue targets — so committing the second copy would add
# ~1.7MB of duplicate binary to the repo for nothing. Verified rather than
# assumed, then dropped; `tests/libgit2/helpers/test-module.ts` points the test
# glue at the shipped wasm through Emscripten's `locateFile` hook.
if ! cmp -s "$DIST/tether-libgit2.wasm" "$DIST/tether-libgit2.node.wasm"; then
	echo "error: shipped and test wasm differ - the test glue needs its own copy after all" >&2
	exit 1
fi
rm "$DIST/tether-libgit2.node.wasm"

echo
echo "== build complete =="
ls -la "$DIST"
