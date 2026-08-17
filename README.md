# Tether Sync

[![CI](https://github.com/timrs2998/tether-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/timrs2998/tether-sync/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/timrs2998/tether-sync?sort=semver)](https://github.com/timrs2998/tether-sync/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-%3E%3D1.11.4-7c3aed)](https://obsidian.md)
[![Mobile](https://img.shields.io/badge/mobile-iOS%20%7C%20Android-brightgreen)](#platform-support)
[![Engine: libgit2](https://img.shields.io/badge/engine-libgit2%20(WASM)-orange)](src/git/libgit2/README.md)

Sync an Obsidian vault with a git repository over HTTPS — on **iOS, Android, macOS
and Windows**.

Git here is real [libgit2](https://github.com/libgit2/libgit2), compiled to
WebAssembly and bundled into the plugin, so nothing needs installing on the device.
No native git binary, no shell, no SSH keys — but real git plumbing underneath,
including a real git-crypt-compatible filter.

## AI disclaimer

This plugin was developed with substantial AI assistance (Claude).

## Supported providers

| Provider | Sign-in button | PRs/MRs on conflict | Notes |
|---|---|---|---|
| GitHub | OAuth device flow\* | yes | fine-grained PAT also works |
| GitLab (incl. self-managed 17.9+) | OAuth device flow\* | yes | self-managed base URL under Advanced |
| Bitbucket Cloud | PAT only | yes | needs an **API token**, not an app password |
| Gitea / Forgejo / Codeberg | PAT only | yes | self-managed base URL under Advanced |
| Azure DevOps | PAT only | yes | PR creation resolves the repo GUID first |
| Any other host | PAT only | no (branch still pushed) | configurable git username, default `oauth2` |

\* Appears only if the distribution has OAuth client IDs configured — see
[OAuth client IDs](#oauth-client-ids-for-distributors). GitHub and GitLab are the
only forges with a usable device grant: Bitbucket has none, Gitea/Forgejo's is an
unreleased feature request, and Azure DevOps's Entra ID flow routinely trips tenant
conditional-access policies.

**Bitbucket app passwords are being retired** — no new ones since 2025-09-09,
brownout 2026-06-09 to 2026-07-27, removed 2026-07-28. Use an Atlassian API token.
Settings → Advanced also needs your Atlassian account email, which the REST API's
Basic-auth convention requires for pull requests even though git sync itself doesn't.

## How it works

- The vault is the git repository; `.git/` lives inside it.
- Each sync commits your changes, checks the remote with one cheap request, fetches
  if it moved, merges (fast-forward or 3-way), and pushes.
- Merges never write conflict markers into notes. Genuine collisions go through the
  [conflict model](#conflict-model).
- `.obsidian/workspace*` and `.trash/` never sync. Add your own ignore globs as
  needed.

## Platform support

| | Desktop (Win/macOS/Linux) | Mobile (iOS/Android) |
|---|---|---|
| Sync engine | libgit2 → WebAssembly (bundled) | libgit2 → WebAssembly (bundled) |
| Transport | HTTPS | HTTPS |
| Background sync | while Obsidian is open | foreground only (OS limitation) |
| Token storage | OS keychain (Obsidian ≥1.11) | secure storage, with fallback |

## Installation

**Community plugin directory** — not yet listed; submission is pending.

**BRAT** (beta) — install [BRAT](https://github.com/TfTHacker/obsidian42-brat),
then "Add beta plugin" with `timrs2998/tether-sync`.

**Manual** — download `manifest.json`, `main.js`, `styles.css` **and
`tether-libgit2.wasm`** from the
[latest release](https://github.com/timrs2998/tether-sync/releases) into
`<vault>/.obsidian/plugins/tether-sync/`. All four files are required; a missing
`.wasm` fails at first sync, not at load.

## Setup

Run **"Tether Sync: Open setup wizard"** from the command palette or click the ribbon
icon. Three steps:

1. **Remote URL** — the repository's **HTTPS** URL
   (`https://github.com/you/vault.git`). SSH URLs are rejected: SSH cannot run inside
   Obsidian on mobile, so HTTPS is the only transport that works everywhere.
2. **Authenticate** — either **Sign in with GitHub / GitLab** (device flow: confirm a
   short code in your browser), or a personal access token:
   - **GitHub:** fine-grained PAT scoped to the repository with *Contents:
     read/write*, *Metadata: read*, *Pull requests: read/write* (the last lets
     conflict branches open PRs).
   - **GitLab:** scopes `write_repository` **and** `api` (`api` creates merge
     requests). Set your instance URL under Advanced for self-managed.
   - **Bitbucket Cloud:** an API token with Repositories and Pull requests
     read/write, plus your Atlassian account email under Advanced.
   - **Gitea / Forgejo / Codeberg:** any token with repository read/write. Self-hosted
     needs its base URL under Advanced.
   - **Azure DevOps:** a PAT with *Code (Read & Write)*.
   - **Any other host:** any token with repo read/write; the username sent alongside
     it is configurable (default `oauth2`).
3. **Connect** — *Clone* the repository into the vault (shallow), or *Initialize* it
   from the current vault contents if the remote is empty.

## Conflict model

Most syncs merge cleanly. When edits truly overlap, the plugin **never** writes
`<<<<<<<` markers into notes and **never** discards anything silently. Pick a
strategy under Settings → Sync → On conflict:

- **PR branch (default).** Your local state is pushed to
  `sync-conflict/{device}-{timestamp}`, a pull or merge request opens against the
  sync branch, and the vault follows the remote. Your work is parked on the forge
  where you can merge it with a real diff UI, from any device, whenever you like. If
  PR creation fails — a token scope, say — the branch is still pushed and you're told
  to open the PR yourself. Nothing is lost either way.
- **Discard local.** Hard-reset to the remote, after confirmation listing the
  differing files.
- **Keep local and pause.** Nothing changes; auto-sync pauses until you resolve it
  from the status bar or the "Resolve conflict" command.

## Sync schedule

| Setting | Desktop default | Mobile default |
|---|---|---|
| Sync on startup | on | on |
| Sync on foreground | off | on |
| Interval | 5 min | 30 min |
| Debounced sync after edits | off | off |

**Mobile battery.** Mobile OSes suspend Obsidian in the background, so the interval
only ticks while the app is open — the effective mechanism is startup plus
foreground, with catch-up when more than one interval passed while closed. A no-op
check costs roughly one small HTTPS request, but radio wakeups dominate battery cost,
so prefer long intervals over tight polling. **Battery saver** disables the interval
entirely and keeps only the startup and foreground triggers.

## git-crypt support

Tether Sync runs git-crypt's clean/smudge filter natively — a real compiled-in
`git_filter_register`, not a subprocess — so a git-crypt-encrypted repository syncs
correctly rather than being detected and refused. Both the **default key** and
**named keys** (`git-crypt init <name>`, `filter=git-crypt-<name>` in
`.gitattributes`) work, and one repository can mix a default key for most paths with
named keys for specific subtrees.

1. On a machine where the repository is already unlocked, export each key the device
   needs: `git-crypt export-key <file>`, or `git-crypt export-key -k <name> <file>`
   for a named one.
2. In Settings → **Encryption (git-crypt)**, you'll see every key the repository's
   `.gitattributes` references, marked ✓ configured or ✗ missing. Click **Import key
   file…** next to a missing entry. The file's embedded key name decides which slot
   it fills, so there's nothing to select manually.
3. Sync as normal. Encrypted paths encrypt on commit and decrypt on checkout using
   the right key per path, and the conflict modal's per-file line counts decrypt too
   instead of showing "(binary)".

Until every referenced key is configured, the repository shows **🔑 key needed** —
distinct from **🔒 sync blocked** — naming exactly which keys are missing. Auto-sync
pauses, but nothing is broken and no re-clone is needed. This is all-or-nothing by
design: one missing named key pauses the whole repository rather than syncing some
paths and not others.

## Security

- Tokens live in Obsidian's **SecretStorage** (OS keychain on desktop) when available
  (Obsidian ≥1.11).
- Where it isn't, they fall back to `data.json` **in plain text**, and settings shows
  a warning. Use the narrowest scope you can.
- Git traffic goes through Obsidian's native `requestUrl` — no third-party proxy, no
  CORS middleman.

## OAuth client IDs (for distributors)

The device flows need OAuth app client IDs. This repository ships with **empty** IDs
(`DEFAULT_GITHUB_CLIENT_ID` / `DEFAULT_GITLAB_CLIENT_ID`), so the sign-in buttons stay
hidden and **PAT auth works out of the box with no registration**. A distributor
registers the OAuth apps — GitHub: a device-flow-enabled OAuth app; GitLab: an
application with `write_repository api` scopes — and either fills the constants in or
uses the settings overrides under Account → Advanced.

## Limitations

- **HTTPS only, no SSH** — impossible on mobile: no subprocess, no SSH transport.
- **Shallow clones by default** (mobile memory; `requestUrl` buffers whole
  responses). Escape hatch: re-clone on desktop.
- **No submodules, no LFS, no rebase or history rewrite.**
- **No gitattributes filter drivers besides git-crypt.** Git LFS and any other custom
  clean/smudge filter are unconditionally unsupported: the wizard and every sync
  refuse a repo whose `.gitattributes` declares one, and auto-sync pauses rather than
  silently committing plaintext — or a literal LFS pointer — into what should stay
  transformed.
- **No background sync on mobile** — iOS and Android suspend the app; catch-up on
  launch and foreground compensates.
- Very large vaults or huge binaries can hit mobile memory limits during clone and
  fetch: the whole working tree is mirrored into memory for the duration of a sync
  (see `src/git/libgit2/fs-backend.ts`).

## Development

```bash
npm install
npm run dev      # esbuild watch -> main.js (also copies tether-libgit2.wasm)
npm run build    # typecheck + production bundle + copy tether-libgit2.wasm
npm run lint     # eslint
npm test         # vitest: pure logic + real tests against the compiled libgit2
npm run test:e2e # real Obsidian, driven headlessly via WebdriverIO
```

Both `dev` and `build` copy `src/git/libgit2/build/dist/tether-libgit2.wasm` next to
`main.js` — **that file must ship alongside `main.js`, `manifest.json` and
`styles.css`**. The loader reads it via `app.vault.adapter.readBinary` against a path
derived from the plugin's own `manifest.dir`; see `src/git/libgit2/loader.ts`.

The compiled `.wasm` and `.js` glue are committed, so contributing needs no Docker or
Emscripten. Regenerate them only when `src/git/libgit2/native/*.c` changes — see
[`src/git/libgit2/build/BUILD.md`](src/git/libgit2/build/BUILD.md).

`npm run test:e2e` uses
[wdio-obsidian-service](https://github.com/jesse-r-s-hines/wdio-obsidian-service),
which downloads a real Obsidian build (cached in `.obsidian-cache/`, gitignored) and
drives it against `e2e/vaults/simple` — once as desktop Obsidian, once under
emulated-mobile UI. Requires `main.js` and `tether-libgit2.wasm` to be built first.

Architecture lives in [DESIGN.md](DESIGN.md), the engine layer in
[`src/git/libgit2/README.md`](src/git/libgit2/README.md), and contributor conventions
in [AGENTS.md](AGENTS.md).

## Prior art and credits

- **[obsidian-git](https://github.com/Vinzent03/obsidian-git)** (Vinzent03) — the
  plugin that defined git-in-Obsidian, and the reference every design decision here
  was measured against. Tether Sync differs by compiling libgit2 to WebAssembly for
  real mobile support, and by refusing to write conflict markers into notes.
- **[libgit2](https://github.com/libgit2/libgit2)** — the actual git implementation
  this plugin runs. GPLv2 with a linking exception; see
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- **[isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)** — powered
  the engine before the libgit2 cutover, and its `onAuth` and `HttpClient` shapes
  still inform the binding's API.
- **[git-crypt](https://github.com/AGWA/git-crypt)** (Andrew Ayer) — the file format
  the native filter interoperates with. Implemented from scratch against the format;
  no git-crypt source is used.
- **[Emscripten](https://emscripten.org)** — the toolchain that makes libgit2 run in
  a webview at all.
- **[wdio-obsidian-service](https://github.com/jesse-r-s-hines/wdio-obsidian-service)**
  (Jesse Hines) — end-to-end testing against real Obsidian.
- **[obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin)** —
  build scaffolding conventions.
- **[BRAT](https://github.com/TfTHacker/obsidian42-brat)** (TfTHacker) — the beta
  distribution path used above.

## License

MIT — see [LICENSE](LICENSE). Third-party notices, including libgit2's GPLv2 linking
exception, are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
