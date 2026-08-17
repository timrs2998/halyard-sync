# libgit2-over-WASM engine layer

This directory holds the git engine: real libgit2 compiled to WebAssembly,
plus the TypeScript binding `src/git/engine.ts` runs against. No native git
binary, no subprocess, no SSH — which is what makes the plugin work on iOS and
Android.

See the top-level [DESIGN.md](../../../DESIGN.md) for the constraints the
plugin as a whole operates under, and [build/BUILD.md](build/BUILD.md) for how
to regenerate the compiled module.

## Files

| File | What it is |
|---|---|
| `binding.ts` | The TS-side contract: the minimal surface the compiled module exposes. Fully implemented by `engine.ts`. |
| `engine.ts` | The `Libgit2Module` / `Libgit2Repository` implementation. Wraps the compiled module's `ccall`/`cwrap` surface with error mapping (`Libgit2Error`, via `git_error_last()`) and malloc/free discipline. |
| `loader.ts` | Loads the `.wasm` at runtime via `app.vault.adapter.readBinary`, against a path derived from the plugin's own `manifest.dir`. |
| `fs-backend.ts` | `VaultMirror`, an in-memory mirror of the vault, and `describeClassicFsBackend`, which mounts it into the module's Emscripten FS. |
| `http-transport.ts` | `basicAuthHeader`, `SmartHttpRequestSpec`, `SmartHttpProtocolError`, `validateSmartHttpResponse` — what `engine.ts`'s dispatch closure consumes. |
| `native/filter_shim.c` | The git-crypt-compatible clean/smudge filter. Matches libgit2's bare `filter` attribute and dispatches on the resolved value, so both the default key and `filter=git-crypt-<name>` named keys round-trip. |
| `native/transport_shim.c` | Registers the smart-HTTP subtransport under both `http` and `https`. No TLS is terminated in C; `requestUrl` opens every real connection. |
| `native/engine_shim.c` | C collectors backing `engine.ts`. Each builds a libgit2 struct or flattens libgit2 struct arrays into a flat byte buffer, so `engine.ts` never hardcodes a struct offset. |
| `build/` | Version pins, build script, Dockerfile, `.dockerignore`, `BUILD.md`. |
| `build/dist/*` | Compiled output — see below. |

## Compiled output vs. authored source

**Authored, reviewable as source:** everything under `native/*.c`, the four
`.ts` files above, `build/build.sh`, `build/Dockerfile`, `build/versions.env`,
`build/BUILD.md`, this README, and every file under `tests/libgit2/`.

**Compiled output, regenerable, never hand-edited:**
`build/dist/tether-libgit2.js` and `build/dist/tether-libgit2.wasm`. They are
committed so that running the plugin, running the tests, or contributing needs
no Docker or Emscripten. Regenerate them via `build/BUILD.md` whenever
`native/*.c` or the build flags change.

## Bugs worth knowing about before touching `fs-backend.ts`

Each of these surfaced on a first real mount or a first real network fetch,
none were predicted in advance, and each is easy to reintroduce.

1. **`node_ops.rename` must set `oldNode.name = newName`.** Emscripten's
   top-level `FS.rename()` re-inserts the renamed node into its own name/hash
   cache using whatever `.name` the node carries *after* the backend's
   `rename` returns. Leaving the old name there makes a later lookup for the
   now-nonexistent path hit a stale cache entry instead of missing. That
   presented as `git_repository_init` failing with `GIT_ELOCKED` — "failed to
   lock file '.git/config.lock' for writing" — because its second internal
   config-lock check believed a lockfile was still held.

2. **`node_ops.readlink` must return `EINVAL` on an existing non-symlink,
   never `ENOSYS`.** `git_repository_init`'s path-resolution walk
   speculatively calls `readlink()` on each existing path component — normal
   `realpath`-style probing, which real filesystems answer with `ENOENT` or
   `EINVAL`. `ENOSYS` means "this operation does not exist", which libgit2
   treats as a hard failure. Symlink *creation* still correctly returns
   `ENOSYS` via `node_ops.symlink`.

3. **`flush()` must persist empty directories explicitly.** It used to create
   directories only as a side effect of writing a file into one, so
   `git_repository_init`'s empty `.git/objects/info` and `.git/objects/pack`
   never reached the adapter. Invisible while a mirror was hydrated once and
   flushed at teardown; fatal once `getChangedFiles()` began re-hydrating
   before every working-tree scan, with `git_odb_open` failing on the second
   pass.

4. **`stream_ops.mmap` is required for real fetches.** `git_indexer` mmaps an
   incoming packfile to build its `.idx`. The implementation copies the
   requested byte range into a fresh `Module._malloc`'d buffer, via the
   optional `malloc`/`getHeapU8` fields on `ClassicFsBackendGlobals`.

Also load-bearing: `node_ops.getattr`/`mknod` must use real
`FS.createNode(...)` nodes rather than bare `{ path }` objects, and `mknod`
must honor a directory request instead of always writing a file.

## Out of scope

- **A libgit2-native credential-retry loop.** Credentials resolve once, up
  front, rather than mid-transport — see `installHttpDispatch`'s doc comment
  in `engine.ts` for why, and what it costs.
- **Unifying `native/transport_shim.c`'s C request framing with a TS
  request-builder.** The C side must build requests in C regardless, since
  that is what libgit2's subtransport contract calls. The part that needed
  sharing — credential and header attachment via `basicAuthHeader` — is
  already reused at the JS dispatch layer.
- **Filters other than git-crypt**, submodules, LFS, and SSH.
