# Building the libgit2-WASM module

Compiles libgit2 plus this directory's native shims to a single Emscripten
module: `build/dist/tether-libgit2.js` and `build/dist/tether-libgit2.wasm`.

**Both outputs are committed to the repo.** You only need to run this build if
you change `native/*.c`, `build/build.sh`, or `build/versions.env`. Everything
else — running the plugin, running the test suite, contributing — works from
the committed artifacts and needs no Docker or Emscripten.

## Prerequisites

Docker. Nothing else; the toolchain lives entirely inside the image.

## Pinned versions

See `versions.env`:

| | Version | Source of truth |
|---|---|---|
| libgit2 | `v1.9.6` | `api.github.com/repos/libgit2/libgit2/releases` |
| Emscripten SDK | `6.0.3` | emsdk's `emscripten-releases-tags.json` |

Re-verify both before bumping either, and re-run `tests/libgit2/` afterward.

## Build

```sh
cd src/git/libgit2
docker build -t tether-sync-libgit2-wasm -f build/Dockerfile .

# A named volume, not a host bind mount — see "Windows gotchas" below.
docker volume create tether-libgit2-buildwork

docker run --rm \
  -v "$(pwd)/build/dist:/work/build/dist" \
  -v "tether-libgit2-buildwork:/work/build/.build-work" \
  tether-sync-libgit2-wasm
```

The build context is `src/git/libgit2`, not `build/`. Mount `dist` at
`/work/build/dist` — `build.sh`'s `DIST` is `$HERE/dist`, so mounting
`/work/dist` makes the build appear to succeed while writing nothing to the
host.

**Timing.** A cold build (empty volume, fresh emsdk and libgit2 clones) takes
10–15 minutes, dominated by the one-time ~300MB emsdk download. A warm rebuild
takes under a minute plus a ~90-second libgit2 recompile — see "Known
inefficiency".

## What the build does

1. Clones and activates the pinned emsdk.
2. Clones libgit2 at the pinned tag.
3. Patches one line-pair in libgit2's `src/util/integer.h`, scoped to
   `__EMSCRIPTEN__`. This is the only modification made to libgit2's source;
   see "libgit2 on wasm32" below.
4. Configures libgit2 via `emcmake` as a static library. The make target is
   `libgit2package` — `git2` is `LIBGIT2_FILENAME`'s default output filename,
   not a target, and `emmake make git2` fails.
5. Compiles `native/filter_shim.c`, `native/transport_shim.c` and
   `native/engine_shim.c`, and links them against static libgit2 into one
   module (`emcc -sMODULARIZE=1`).

## Windows and Docker Desktop gotchas

Recorded because each one silently wastes a build cycle.

1. **`-v "$(pwd)/...":...` bind mounts silently no-op under git-bash.** A
   POSIX-style MSYS path (`/c/Users/...`) does not reliably translate for
   Docker Desktop: the mount can succeed with no error while binding to
   nothing, and the container's writes vanish with `--rm`. Pass the
   Windows-style path (`C:\Users\...\dist`) as the host side instead.
2. **Use a named volume for `.build-work`.** That directory holds the emsdk
   and libgit2 clones plus the build tree (~1.5GB, mostly small files), and a
   host bind mount crawls across Docker Desktop's Windows file-sharing layer.
   A named volume is dramatically faster. A bind mount is fine for `dist` —
   two small files, written once.
3. **`.dockerignore` must exclude `build/.build-work` and `build/dist`.**
   Otherwise a populated `.build-work` enters the build context and either
   bloats the build absurdly or fails outright with BuildKit's
   `invalid file request`. `src/git/libgit2/.dockerignore` handles this.

## libgit2 on wasm32

libgit2 does not compile for wasm32 unpatched:

```
src/util/alloc.c:28:34: error: incompatible pointer types passing 'size_t *'
(aka 'unsigned long *') to parameter of type 'unsigned int *'
```

`src/util/integer.h` selects which `__builtin_u{add,mul}*_overflow` intrinsic
backs `git__{add,multiply}_sizet_overflow` by comparing `SIZE_MAX == UINT_MAX`
against `SIZE_MAX == ULONG_MAX` — a *value* comparison. On wasm32 `int` and
`long` are both 32-bit, so those are numerically equal and the `#if` chain
always takes the `unsigned int` branch. But Emscripten's clang typedefs
`size_t` as `unsigned long`, and the builtin's output-pointer parameter
type-checks exactly rather than by width, making this a hard error.

`build.sh` forces the `unsigned long` branch under `__EMSCRIPTEN__` via
`sed -i` right after checkout. Nothing else in libgit2, its `src/util/*.c`, or
its bundled `deps/{zlib,pcre2,xdiff,llhttp}` needs changing.

## Asyncify and the two suspension points

Two independent Asyncify suspension seams exist: `transport_shim.c`'s
`EM_ASYNC_JS` HTTP dispatch, and `filter_shim.c`'s `EM_ASYNC_JS` crypto hooks.
Asyncify documents that starting an async operation while another is running
is unsafe, which makes their interaction the sharpest risk in this build.

`tests/libgit2/asyncify-double-suspension.test.ts` covers it: a real bare repo
containing a real git-crypt ciphertext blob, served over real smart HTTP by a
real `git http-backend` process, cloned and checked out through a single
`ccall` that internally runs `git_remote_fetch` (suspending in the transport,
possibly several times) and then `git_checkout_tree` (suspending in the filter
to smudge the ciphertext back to plaintext). It passes deterministically, and
the decrypted result is compared byte-for-byte against the original plaintext.

This works because the two suspensions are never on the stack simultaneously.
The fetch's suspend/resume cycle fully unwinds and rewinds — libgit2 finishes
downloading and indexing the pack — before `git_checkout_tree` runs, even
though both happen inside one top-level C call. Asyncify's hazard is two
*overlapping* suspensions, not two sequential fully-resolved ones.

**Residual risk:** a filter callback firing while a transport read is still
logically in flight. No path in libgit2 v1.9.6 interleaves object streaming
with filtering mid-fetch, so this cannot currently arise — but a future
libgit2 upgrade that restructures those internals would need this re-checked.

## Known inefficiency

Every run fully recompiles libgit2 (~90s) even when only `native/*.c` changed.
`git checkout "$LIBGIT2_REF"` and the `sed -i` patch both run unconditionally
and touch file mtimes, which is enough for `make` to treat every source as
stale. Guarding both with idempotency checks would fix it. Left alone
deliberately, and noted here so nobody rediscovers it by watching a "no-op"
rebuild take 90 seconds.

## Out of scope

SSH transport (`USE_SSH=OFF`, permanently — no SSH on mobile), threads,
GSSAPI, NTLM, the SHA-256 object-format backend, submodules, and LFS.
