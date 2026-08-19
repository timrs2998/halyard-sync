# AGENTS.md

Conventions for working in this repository, whether you're a human or an agent.

This plugin was developed with substantial AI assistance (Claude).

## What this plugin is

Tether Sync syncs an Obsidian vault with a git repository over HTTPS, on desktop and
mobile, using real libgit2 compiled to WebAssembly. Two guarantees drive most design
decisions and must not regress:

1. **Never write conflict markers into a note.** Conflicts are reported and parked on
   a branch; they are never resolved by dirtying the working tree.
2. **Never lose local work.** Every conflict strategy either preserves local state on
   a pushed branch or asks for explicit confirmation first.

## Layout

```
src/
  main.ts            Plugin entry: lifecycle, commands, wiring, WASM loading
  settings.ts        Settings model and tab UI, incl. git-crypt key import
  git/
    engine.ts        GitEngine: clone/fetch/commit/push/merge/status/branch
    fs-adapter.ts    DataAdapter structural types + path normalization
    http-client.ts   requestUrl structural types, timeout and logging wrappers
    gitcrypt.ts      git-crypt on-disk format: blob encrypt/decrypt, key parsing
    libgit2/         The compiled engine. See its own README.
  auth/              Provider abstraction, device flows, PAT fallback, secrets
  sync/              Orchestrator state machine, conflict strategies, scheduler
  ui/                Status bar, sync panel, modals
tests/               vitest, including tests/libgit2/ against the real module
e2e/                 WebdriverIO against real Obsidian
```

## Commands

| Command | What it gates |
|---|---|
| `npm run dev` | esbuild watch → `main.js`, plus the `.wasm` copy |
| `npm run build` | `tsc --noEmit`, production esbuild, `.wasm` copy. **Type errors fail here.** |
| `npm run lint` | eslint, mirroring the plugin portal's own review config: `eslint-plugin-obsidianmd` + typescript-eslint **type-checked**. Findings here are the ones the portal reports. |
| `npm test` | vitest, ~380 tests, against the real compiled libgit2 module |
| `npm run test:e2e` | Real Obsidian, desktop and emulated-mobile. Needs a build first. |

All four must pass before a PR.

Some tests shell out to real `git`. `tests/gitcrypt.test.ts`'s cross-compatibility
suite is gated on `hasGitCrypt()` and **skips silently** without the git-crypt CLI
installed — CI installs it, so a local pass is weaker than a CI pass. Install
git-crypt locally if you touch `gitcrypt.ts` or `filter_shim.c`.

## The WASM module

`src/git/libgit2/build/dist/` holds **compiled output, committed on purpose** so that
running, testing and contributing need no Docker or Emscripten. One `.wasm`, two glue
files linked from the same objects:

- `tether-libgit2.js` — shipped. Linked `-sENVIRONMENT=web,worker` with no NODEFS, so
  the bundle carries no Node filesystem code (the portal reports any `require("fs")`
  in `main.js` as filesystem access on the public listing).
- `tether-libgit2.node.js` — `tests/libgit2/` only, adds NODEFS so those suites can
  mount a real temp directory and cross-check against the `git` CLI.

- **Don't hand-edit it.** Regenerate via
  [`src/git/libgit2/build/BUILD.md`](src/git/libgit2/build/BUILD.md) — Docker only.
- Regeneration is required only when `native/*.c`, `build/build.sh`, or
  `build/versions.env` changes. `.github/workflows/build-wasm.yml` rebuilds on those
  paths and runs the full test suite against the rebuild, so a broken recipe fails
  there. Commit the rebuilt files with the change that caused them.
- **The binary is embedded in `main.js` as base64** (`wasm-binary.ts`), not
  shipped beside it. Obsidian's community installer and BRAT fetch only
  `manifest.json`, `main.js` and `styles.css` from a release and drop every
  other asset, so a sibling file reaches nobody who didn't copy it by hand.
  `e2e/specs/libgit2-loader.e2e.ts` guards this by asserting the engine builds
  with no `.wasm` on disk.
- Read [`src/git/libgit2/README.md`](src/git/libgit2/README.md) before touching
  `fs-backend.ts`. It lists four real bugs that are easy to reintroduce.

## Testing philosophy

Test against real artifacts, not mocks.

- `tests/libgit2/` runs against the **actual compiled module**, with real repos, a
  real `git http-backend` smart-HTTP server, and real `git cat-file` cross-checks.
- `tests/gitcrypt.test.ts` verifies round-trips against the **real git-crypt CLI** in
  both directions, not just self-consistency.
- Pure logic (sync decision table, provider detection, conflict branch naming,
  scheduler catch-up math, status classification) is unit-tested directly. Nothing
  needs a live vault.
- `sync-panel-model.ts` exists so the sync panel's logic is testable without
  importing obsidian; `sync-view.ts` stays a thin DOM renderer over it. Preserve that
  split.

## Hard rules

- **Never commit `data.json`.** It can hold plaintext tokens and git-crypt key
  material. It is gitignored; leave it that way.
- **Never commit secrets** in tests, fixtures, or docs — no real tokens, no private
  remote URLs, no personal repository paths.
- `main.js` is build output and gitignored.
- Use `requestUrl`, never `fetch`.
- `isDesktopOnly: false`, so no Node or Electron APIs, no subprocesses, and no
  filesystem access outside `app.vault.adapter` in plugin code. (Tests may shell out;
  they run under Node.)
- Engine-touching operations serialize through the async lock. Don't bypass it.
- `createGitEngine` is async and expensive — it loads WASM and hydrates the vault.
  Cache it; use `updateOptions()` for settings changes rather than rebuilding.

## Style

- Tabs for indentation; see `.editorconfig`. Double-quoted strings.
- `noUnusedLocals` and `noUnusedParameters` are on. Prefix intentionally unused
  parameters with `_`.
- Comments explain **why**, not what. Don't narrate history — if a comment describes
  a previous implementation, delete it and let git history carry that.
- Document real gaps honestly where they live. The credential-retry limitation in
  `installHttpDispatch` is the model: state what doesn't work and why, don't hide it.
- Prefer active verbs and short sentences in comments and user-facing strings alike.
- Never point users at `DESIGN.md` from UI text.

## Releasing

- `npm version x.y.z` — the repo's `version` hook runs `version-bump.mjs`, so
  `package.json`, `manifest.json` and `versions.json` all move together. It commits
  and tags `x.y.z`.
- `git push origin main --tags`
- `.github/workflows/release.yml` re-verifies the tag against `manifest.json` and
  attaches `manifest.json`, `main.js` and `styles.css` as individual assets —
  never a zip.

The tag takes no `v` prefix: Obsidian's validation requires it to equal
`manifest.json`'s version exactly. `.npmrc` sets `tag-version-prefix=""` so
`npm version` doesn't add one. Don't hand-edit the three version files; the one
command keeps them consistent.
