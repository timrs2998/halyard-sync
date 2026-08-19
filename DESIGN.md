# Tether Sync — Design

An Obsidian plugin that syncs a vault with a GitHub/GitLab repository on iOS, Android,
macOS, and Windows. Fully self-contained: every dependency is bundled into `main.js`;
the user installs nothing besides the plugin.

## Constraints (verified 2026-07)

These are environmental facts that drive the whole design:

1. **No native git on mobile.** Obsidian mobile runs plugins in a Capacitor webview
   with no shell. The sync engine is **libgit2, compiled to WebAssembly**
   (`src/git/libgit2/`; see that directory's README) — a real git implementation, not
   a from-scratch reimplementation, which gains real `git_filter_register` support
   (native git-crypt) that a pure-JS engine never could. It runs on *all* platforms:
   one code path, no desktop/mobile divergence.
2. **HTTPS only.** This build has no SSH transport compiled in and mobile has no
   subprocess. Git-over-HTTPS with a token is the only portable transport. "SSH setup"
   is therefore out of scope by necessity; the requirement's spirit (easy auth) is met
   via OAuth device flow instead.
3. **No CORS proxy needed.** Obsidian's `requestUrl` API goes through the native layer
   and bypasses CORS on both Electron and Capacitor. A custom libgit2 smart-HTTP
   subtransport (`native/transport_shim.c` + `engine.ts`'s `installHttpDispatch`)
   dispatches every request through it. Caveat: `requestUrl` buffers whole responses
   (no streaming), which caps pack sizes by device memory — mitigated by shallow
   clones.
4. **No background execution on mobile.** iOS suspends webview JS when backgrounded
   (process may be killed after ~10 min); Android throttles similarly. Sync can only
   run in the foreground: on launch, on foregrounding, after edits (debounced), and on
   a foreground interval.
5. **`.git/` lives inside the vault**, accessed via `app.vault.adapter` (the DataAdapter
   operates below Obsidian's index, which ignores dotfiles — and, separately, can also
   reach the plugin's OWN directory, e.g. `manifest.dir`, which is how the compiled
   `.wasm` binary is loaded; see point 8 below). The whole working tree is mirrored
   into an in-memory `VaultMirror` (`src/git/libgit2/fs-backend.ts`) and mounted into
   the WASM module's classic filesystem, since libgit2's C entry points are synchronous
   and `DataAdapter` is Promise-based — see that file's header comment for the
   sync/async reconciliation and why a full in-memory mirror (not per-call Asyncify)
   was chosen for the FS layer specifically (the network transport goes the opposite
   way — see point 3 and `http-transport.ts`'s header comment).
6. **Secrets:** Obsidian ≥1.11 exposes `app.secretStorage` (OS keychain on desktop).
   Use it when available; fall back to plugin `data.json` with a visible warning.
   Git-crypt key material is stored the same way, under a separate key prefix
   (`auth/secrets.ts`'s `GitCryptKeyStore`).

   `minAppVersion` is `1.13.0`, set by the settings tab rather than by secrets:
   the tab is declarative (`getSettingDefinitions`, `settings.ts`), which is what
   puts its rows in Obsidian's settings search, and both that API and
   `ButtonComponent.setDestructive` are 1.13.0+.
7. **Bundling gotcha:** the git-crypt filter's Basic-auth header building
   (`src/git/libgit2/http-transport.ts`'s `basicAuthHeader`) needs a Buffer polyfill on
   mobile — esbuild `inject` of a `polyfill-buffer.js` that uses the global Node Buffer
   on desktop and the `buffer` npm polyfill on mobile.
8. **WASM packaging: everything ships inside `main.js`.** esbuild bundles the
   compiled Emscripten glue (`build/dist/tether-libgit2.js`) like any other module,
   and the 1.67 MB `.wasm` binary is embedded alongside it as base64 (~2.3 MB), decoded
   once per engine construction by `src/git/libgit2/wasm-binary.ts` and handed to a
   `Module.instantiateWasm` override.

   This is forced by how Obsidian distributes plugins. **The community installer and
   BRAT fetch exactly `manifest.json`, `main.js` and `styles.css` from a release and
   ignore every other asset.** A separate `.wasm` therefore reaches only users who
   copy files by hand; everyone else gets `ENOENT` at first sync. Fetching it at
   runtime is not an alternative — the developer policies forbid a plugin carrying its
   own update mechanism and require every network destination to be disclosed, and it
   would make a working install depend on being online.

   An earlier revision shipped the binary as a sibling file, having weighed the bundle
   size against "no corresponding benefit". That was wrong: the benefit it missed is
   that the plugin installs at all. `e2e/specs/libgit2-loader.e2e.ts` now asserts the
   engine builds with **no** `.wasm` on disk, so the regression cannot return
   silently.

## Architecture

```
src/
  main.ts                Plugin entry: lifecycle, commands, wiring, WASM loading
  settings.ts            Settings model + tab UI (incl. git-crypt key import)
  git/
    fs-adapter.ts        DataAdapterLike/AdapterStatLike structural types +
                         toAdapterPath path normalization, reused by VaultMirror
    http-client.ts       requestUrl-based structural types (RequestUrlLike), shared
                         by the libgit2 HTTP transport wiring and the WASM loader
    gitcrypt.ts          git-crypt on-disk format: encrypt/decrypt blobs, key-file parsing
    engine.ts            GitEngine: clone/fetch/commit/push/merge/status/branch ops,
                         now backed by the libgit2 binding (see libgit2/ below)
    libgit2/             The real, compiled-to-WASM libgit2 engine — binding.ts's
                         contract, engine.ts's Libgit2Module/Libgit2Repository
                         implementation, fs-backend.ts's VaultMirror + classic-FS
                         mount, http-transport.ts's pure-TS HTTP helpers, loader.ts's
                         WASM-instantiation wiring, native/*.c, build/. See that
                         directory's own README.
  auth/
    secrets.ts           SecretStorage wrapper with data.json fallback (tokens AND,
                         separately, git-crypt key material via GitCryptKeyStore)
    github.ts            GitHub OAuth device flow + PR creation (REST)
    gitlab.ts            GitLab OAuth device flow + MR creation (REST)
    providers.ts         Provider abstraction (detect from remote URL) + PAT fallback
  sync/
    orchestrator.ts      The sync state machine (single-flight, serialized)
    conflicts.ts         Conflict strategies: PR branch / discard local / keep local
    scheduler.ts         Intervals, visibilitychange, debounced post-edit, catch-up
    async-lock.ts        Serializes engine-touching operations across the plugin
  ui/
    statusbar.ts         Status bar item: idle/syncing/conflict/error/blocked/locked
    sync-view.ts         Right-sidebar sync panel: persistent status/history/actions,
                         the standing complement to the status bar's tooltip and the
                         ribbon's one-shot menu
    sync-panel-model.ts  Pure view-model for the sync panel (obsidian-import-free,
                         unit-tested — sync-view.ts is a thin DOM renderer over it)
    modals.ts            Setup wizard, device-code modal, conflict resolution modal,
                         git-crypt key-file import
```

### Git layer

The engine (`git/engine.ts`'s `GitEngine`) wraps the real libgit2-over-WASM binding
(`git/libgit2/engine.ts`'s `Libgit2Module`/`Libgit2Repository`, wrapping the compiled
`build/dist/tether-libgit2.{js,wasm}` module's `ccall`/`cwrap` surface) instead of a
pure-JS reimplementation:

- **Lifecycle is now explicit and async.** Unlike a pure-JS engine, a real
  `git_repository*` handle must be opened once and freed once; `createGitEngine(...)`
  (async — it loads the compiled WASM module and hydrates the whole vault into an
  in-memory `VaultMirror`, both real work) replaces what used to be a synchronous
  `new GitEngine(...)`, and `main.ts`'s `getEngine()` is now `Promise<GitEngine>`,
  cached after first resolution (not rebuilt on every settings change — see
  `GitEngine.updateOptions()` — since rebuilding means reloading the WASM module and
  re-hydrating the vault, real costs a settings-tab keystroke must not pay for).
- **Filesystem:** `libgit2/fs-backend.ts`'s `VaultMirror` mirrors the vault into
  memory and is mounted into the WASM module's classic FS (`Module.FS.mount`).
  `GitEngine.getChangedFiles()` resets and re-hydrates the mirror from the real
  adapter before every working-tree scan, so direct Obsidian edits made between sync
  cycles (which never go through any git operation) are still seen; every mutating
  method flushes back to the adapter afterwards.
- **Network:** a custom libgit2 smart-HTTP subtransport
  (`libgit2/native/transport_shim.c`, registered for both `http`/`https`) dispatches
  every request through `Module.__httpDispatch`, wired to the real `requestUrl` in
  `libgit2/engine.ts`'s `installHttpDispatch`, so there is no proxy and no CORS story
  of our own. Credentials
  (`net.onCredentials`) are resolved ONCE up front and baked into every request for
  that fetch/push/listRemoteRefs call — there is no libgit2-native "try anonymous,
  retry with credentials on 401" loop (a real, documented gap, not an oversight; see
  `installHttpDispatch`'s doc comment). Before reaching `requestUrl`, `main.ts` wraps
  it with a live-settings-driven timeout and opt-in per-request diagnostic logging
  (`http-client.ts`'s `withRequestTimeout`/`withRequestLogging`, settings
  `networkTimeoutSeconds`/`verboseNetworkLogging`) — the fix for "syncing" hanging
  forever behind a proxy/firewall that silently drops connections instead of
  rejecting them, rather than any change to the transport itself. `http-transport.ts`
  now holds only the two pieces of this path that ARE real TypeScript —
  `basicAuthHeader` and `validateSmartHttpResponse` — reused by `installHttpDispatch`
  rather than reimplemented in C.
- **Clone:** `depth: 1, singleBranch: true` by default (mobile memory). Un-shallowing
  is not implemented; the escape hatch is re-clone with full depth (desktop).
- **Status:** `Libgit2Repository.status()` (real `git_status_list_new`), filtered in
  JS by an ignore predicate (`.obsidian/workspace*`, `.trash/`, this plugin's own
  `data.json`, user-configurable globs) — kept as a JS-side filter rather than a
  libgit2 pathspec so its semantics keep matching exactly what the settings UI
  documents to users. The plugin's own `data.json` is always excluded (not just a
  seeded default the user could remove): the plugin rewrites it on every sync
  (`lastSyncAt`, rolling history), so leaving it syncable would mean every sync
  dirties a file the next sync then commits — a self-sustaining commit loop with no
  real vault change behind it.
- **Merge:** fast-forward when possible. Diverged: a real, entirely in-memory 3-way
  merge (`git_merge_commits`, deliberately never the working-tree-touching top-level
  `git_merge()` — see `libgit2/engine.ts`'s `merge()` doc comment) that never writes
  conflict markers into notes (the obsidian-git mobile precedent shows marker-writing
  causes data loss) and never touches the index/working tree on a conflict. On
  conflict, hand off to the conflict strategy. **`autoMergeOverlappingEdits`**
  (settings, off by default): when on, passes `favor: "union"` into the merge so an
  overlapping-lines edit on two devices is no longer classified as a conflict at
  all — both sides' distinct lines are concatenated into the file instead of
  stopping and running the conflict strategy below. A different kind of setting
  than the conflict strategy itself: it changes whether something is DETECTED as a
  conflict, not what happens once one is. Gated behind an explicit confirm modal
  (Settings → Sync) since a sentence-level overlapping edit, not just an
  append-only one, ends up silently concatenated with no marker distinguishing
  which version is current.
  - `.gitignore` seeded on init: `.obsidian/workspace*`, `.trash/`, this plugin's own
    `data.json`.
- **git-crypt:** a real, native `git_filter_register`-based clean/smudge filter
  (`libgit2/native/filter_shim.c`), wired at runtime to `gitcrypt.ts`'s real
  `encryptBlob`/`decryptBlob` (a pure-TS/WebCrypto port of git-crypt's on-disk
  format) once the relevant key(s) are imported — see "gitattributes filter drivers"
  below for the three-way ok/locked/blocked split this enables. Both the default
  (unnamed) git-crypt key AND named keys (`filter=git-crypt-<name>`) are supported:
  the native filter matches on the bare `filter` attribute (not an exact
  `"filter=git-crypt"` value — see `filter_shim.c`'s header comment for the
  libgit2 attribute-clause DSL this rests on) and dispatches each path's clean/
  smudge call to the key name its `.gitattributes` value resolves to, so a repo
  can mix a default key for most paths with one or more named keys for specific
  subtrees. Key material is stored per (host, key name) in `auth/secrets.ts`'s
  `GitCryptKeyStore`.

### Auth

Provider is detected from the remote URL: github.com -> GitHub, gitlab.com or the
configured GitLab self-managed base -> GitLab, bitbucket.org -> Bitbucket, dev.azure.com
/ `*.visualstudio.com` -> Azure DevOps, the configured Gitea/Forgejo self-managed base
-> Gitea, else generic (PAT only, no PR creation).

Only GitHub and GitLab have shipped OAuth device-flow (RFC 8628) support as of this
writing (Bitbucket has no device grant; Gitea/Forgejo have it as an open feature
request, not released — tracked as a later addition, see "Future: Gitea/Forgejo device
flow" below). Every other provider is PAT-only. This is a hard external constraint, not
a design choice — do not build a "sign in" button for a provider that can't do the
device grant.

- **GitHub:** OAuth device flow (`POST login/device/code`, poll
  `login/oauth/access_token`), public `client_id` only, scope `repo`. The device-code
  modal shows the user code, a "copy" button, and a link to
  `https://github.com/login/device`. Git auth: `onAuth: () => ({ username:
  'x-access-token', password: token })`. PR: `POST /repos/{owner}/{repo}/pulls`.
- **GitLab:** RFC 8628 device flow (GA in GitLab 17.9; gitlab.com and current
  self-managed). Scopes `write_repository` + `api` (api needed for MR creation).
  Git auth username `oauth2`. Self-managed instances get a configurable base URL;
  instances <17.9 fall back to PAT. MR: `POST /projects/:id/merge_requests`.
- **Bitbucket Cloud:** PAT only (API tokens — Atlassian is retiring app passwords:
  no new ones since 2025-09-09, brownout 2026-06-09 to 2026-07-27, fully removed
  2026-07-28; build against API tokens, not app passwords). Git auth: username =
  Atlassian account email, password = API token — verify this exact convention against
  current Atlassian docs before wiring `onAuth`, since Basic-auth username conventions
  for API tokens are the one under-documented detail here. PR: `POST
  /2.0/repositories/{workspace}/{repo_slug}/pullrequests` with `{title, source:
  {branch: {name}}, destination: {branch: {name}}}`.
- **Gitea / Forgejo (incl. Codeberg):** PAT only (no released device flow). Self-hosted,
  so detection needs a settings field (`giteaSelfManagedBase`), same pattern as GitLab's
  self-managed base. Git auth convention (username vs. token-as-password vs. a specific
  header) must be verified against current Gitea/Forgejo docs before implementation —
  don't assume it matches GitHub's `x-access-token` pattern. PR: `POST
  /api/v1/repos/{owner}/{repo}/pulls`, token needs repo write scope.
- **Azure DevOps:** PAT only — Entra ID device flow exists in principle but routinely
  hits tenant conditional-access/admin-consent policies in real orgs, which reintroduces
  the setup friction device flow exists to avoid; not worth it for v1. Git auth: empty
  username, PAT as password (Base64-encoded Basic auth per Microsoft's docs). Host
  detection: `dev.azure.com` or `*.visualstudio.com`. PR creation via the Azure DevOps
  REST API's pull requests endpoint (verify exact path/API version at implementation
  time).
- **Any other host (sourcehut, unlisted self-hosted forges, ...):** the generic
  provider — PAT only, configurable git username (default `oauth2`), no PR creation
  (`createPullRequest` returns null; the `prBranch` conflict strategy already degrades
  gracefully to "branch pushed, open a PR/MR manually" in that case — see
  `sync/conflicts.ts`). This is intentionally not provider-specific: sourcehut in
  particular doesn't have a pull-request concept at all (patch-over-email workflow), so
  there is nothing provider-specific to add for it.
- **PAT fallback (always available, any provider):** a settings field with per-provider
  guidance (GitHub fine-grained PAT: Contents R/W + Metadata R + Pull requests R/W;
  GitLab: `write_repository` + `api`; Bitbucket: Repositories R/W + Pull requests R/W;
  Gitea/Forgejo: repo write; Azure DevOps: Code (Read & Write)).
- **Client IDs** ship as constants but are overridable in settings (the plugin isn't
  published yet; the owner registers the OAuth apps and drops in the IDs — a
  placeholder + settings override keeps the code shippable without them).
- Tokens live in `app.secretStorage` keyed by remote host; `data.json` fallback only
  when SecretStorage is unavailable, with a warning banner in settings.

**Guarded, three ways: gitattributes filter drivers (git-crypt, LFS, custom).**
`GitEngine.detectUnsupportedFilters()` / `detectUnsupportedFiltersInWorkingTree()`
(git/engine.ts) classify a repo's declared `filter=` attributes into one of three
outcomes (`FilterCheckResult`), not a flat allow/refuse:

- **`"ok"`** — no filters at all, or every distinct git-crypt-family key name in use
  (default and/or one or more named keys) has a configured key on this device (see
  "git-crypt support" above). Proceeds normally; the native filter
  (`libgit2/native/filter_shim.c`) transparently encrypts/decrypts each path with
  its own key.
- **`"locked"`** — only git-crypt-family filters, but at least one key name in use
  (default or named) has NO configured key yet. NOT the same as fundamentally
  unsupported: recoverable by importing the missing key(s) in settings, with no
  re-clone needed. Surfaced as a new `"locked"` `SyncState` (🔑, distinct from
  `"blocked"`'s 🔒), naming the SPECIFIC missing key name(s) rather than a generic
  notice — auto-sync pauses (nothing is committed/pushed unencrypted while a
  git-crypt path can't be decrypted/encrypted), but resolving it is a settings-only
  action. All-or-nothing by design: even one missing named key locks the WHOLE
  repository, never a partial sync of just the paths whose keys ARE present — the
  same risk-averse posture `merge()` takes with conflict markers (see above).
- **`"blocked"`** — Git LFS, or any other custom filter driver this engine cannot
  run at all regardless of key material. Unconditionally unsupported, exactly as
  strict as before native git-crypt support existed: this plugin has no filter
  driver for these at all, so content would be read/written raw instead of
  decrypted/transformed. For an encrypting filter that's a silent-corruption trap,
  not just a missing feature.

The check runs at the setup wizard (both clone and init-from-vault, before anything
is staged/committed) and at the top of every orchestrator sync — the latter matters
because a filter (or a key going stale/removed) can change via a merge from another
device, not just at initial setup. Only `"blocked"` refuses setup outright
(`UnsupportedGitAttributesError`); `"locked"` is allowed through setup and surfaces as
the `"locked"` sync state on the first real sync attempt instead.

**Explicit non-goals (see prior review):** SSH (no compiled-in transport, no shell
on mobile — impossible, not just undesirable), OS credential-manager delegation
(desktop-only, requires user-installed GCM — violates "no setup"), and an OAuth
authorization-code+PKCE flow via a custom `obsidian://` redirect for providers without
device flow (technically possible via `registerObsidianProtocolHandler`, but depends on
each provider's OAuth app accepting a non-http(s) redirect URI, unverified for
Bitbucket, and the fallback — hosting a stateless redirect-relay page ourselves —
reintroduces the infrastructure dependency the project avoids elsewhere; PAT already
covers these providers adequately).

**Future: Gitea/Forgejo device flow.** Once either ships RFC 8628 (tracked upstream;
not released as of this writing), add a device-flow module for it following the
GitHub/GitLab pattern — the provider abstraction already anticipates this
(`deviceFlowSupported` on `ForgeProvider`).

### Sync orchestrator

Single-flight state machine; a sync is never started while one is running (queued-once
semantics: a request during a run marks "run again after").

```
idle -> [gitattributes filter check: blocked -> "blocked" state; locked -> "locked" state]
     -> [checked-out-branch guard: HEAD != settings.branch -> "blocked" state]
     -> staging: status() -> add/remove -> commit (if dirty)
     -> fetching: cheap ref check (listRemoteRef) -> skip if remote unchanged & local clean
        [missing-upstream-branch guard: had a tracking ref, remote no longer
         advertises it (renamed/deleted) -> "blocked" state]
     -> fetch
     -> integrating:
          remote unchanged        -> push if ahead
          fast-forwardable        -> ff merge -> push if ahead
          diverged                -> real in-memory 3-way merge (git_merge_commits)
                                     ok       -> push
                                     conflict -> conflict strategy
     -> idle | conflict | error | blocked | locked
```

Both guards above are real, run every cycle (not just at setup), and pause
auto-sync via the same `"blocked"` state the gitattributes check uses — see
`orchestrator.ts`'s `describeBranchMismatch`/`describeMissingUpstreamBranch` for
the exact conditions and messages. Neither is a filter/encryption concern; both
catch real git state changing out from under the plugin (a manual `git checkout`
on the same repo, or a remote branch renamed/deleted upstream).

Commit identity: `name` from settings (default "Tether Sync"), `email` default
`tether-sync@localhost`. Commit message template `vault sync: {date} ({platform})`.

### Conflict strategies (user setting, default = PR branch)

1. **PR branch (default):** commit local state to `sync-conflict/{device}-{timestamp}`,
   push that branch, create a PR/MR via REST (GitHub `POST /repos/{owner}/{repo}/pulls`,
   GitLab `POST /projects/:id/merge_requests`), then hard-reset the working branch to
   `origin/{branch}`. Local work is preserved on the remote branch; the vault converges
   to upstream; the user resolves at their leisure in the forge UI. A notice links to
   the created PR.
2. **Discard local:** hard reset to `origin/{branch}` (requires an explicit
   confirmation modal listing the files that differ, unless "don't ask again").
3. **Keep local / manual:** pause auto-sync, show conflict state in the status bar,
   let the user pick a resolution from the conflict modal (which offers 1 and 2).

If PR creation fails (e.g. token lacks scope), the branch is still pushed and the
notice degrades to "conflict branch pushed — open a PR manually", never losing data.

### Scheduling & power

| Setting              | Desktop default | Mobile default |
|----------------------|-----------------|----------------|
| Sync on startup      | on              | on             |
| Sync on foreground   | off             | on (visibilitychange) |
| Foreground interval  | 5 min           | 30 min         |
| Debounced post-edit  | off             | off            |
| Cheap ref check first| on              | on             |

- All timers via `registerInterval`; catch-up logic persists `lastSyncAt` and syncs on
  launch/foreground if the interval elapsed while closed (mobile can't run backgrounded,
  so this is the primary mobile mechanism).
- **Battery notes surfaced in settings UI (mobile):** the interval only ticks while
  Obsidian is foregrounded; the ref-check makes no-op polls cost ~1 small HTTPS request;
  radio wakeups dominate cost, so the recommended mobile pattern is
  startup + foreground + long interval, not tight polling. A "Battery saver" preset
  applies: interval off, startup+foreground only.

### UI

- **Setup wizard (modal, launched from settings or first-run notice):**
  remote URL -> provider detection -> auth method (device flow "Sign in with
  GitHub/GitLab" or PAT) -> clone (with progress) or "init from existing vault"
  (init + branch + remote add + initial commit/push). Both mutating paths now
  confirm first: Initialize warns on a pre-existing `.git` it didn't create;
  Clone warns when the vault already has real content (anything besides
  `.obsidian`) that its overwrite-by-name behavior could clobber.
- **Ribbon icon:** the one entry point guaranteed visible regardless of theme
  or layout (the status bar item can be hidden by some of them). Left click
  mirrors the status bar (sync now, or open the conflict modal if conflicted);
  right click opens a quick menu (sync now, resolve conflict, open sync panel,
  view history, pause/resume, setup wizard) — a lightweight stand-in for a
  dedicated pane for occasional actions.
- **Status bar:** ⟳ syncing / ✓ idle+last-sync-time / ⚠ conflict / ✗ error /
  🔒 blocked / 🔑 key needed (locked); click = sync now (or open conflict modal in
  conflict state). `statusBarView`'s switch has no catch-all `default` for its known
  cases — an unhandled `SyncState` fails a `never` check at compile time instead of
  silently rendering as idle (this is exactly what caught the need to add a case for
  `"locked"` when it was introduced).
- **Sync panel (right sidebar, `ui/sync-view.ts`):** a persistent, always-visible
  view of sync status, next scheduled sync, and recent history, with a one-click
  resync/resolve action — the standing complement to the status bar (whose detail
  lives in a tooltip that disappears the moment you look away) and the ribbon's
  right-click menu (one-shot actions, no live view). Opened via the ribbon menu,
  the "Open sync panel" command, or `Plugin.activateSyncView()`. No diff/staging
  UI — conflict resolution already has its own modal, which this panel just opens.
  Formatting logic lives in `sync-panel-model.ts` (obsidian-import-free,
  unit-tested); the view itself is a thin renderer over it, same split
  `statusbar.ts` uses.
- **Settings → Encryption (git-crypt):** import a git-crypt key file (exported via
  `git-crypt export-key`) via a hidden `<input type=file>` triggered by a button (no
  higher-level "pick a file" API in Obsidian) — parsed via `gitcrypt.ts`'s
  `parseKeyFile`, stored via `auth/secrets.ts`'s `GitCryptKeyStore`. Importing (or
  clearing) a key re-registers the native filter on an already-running engine
  immediately (`GitEngine.syncGitCryptFilter()`), no plugin reload needed.
- **Settings → Account → Advanced:** also holds `networkTimeoutSeconds` (every
  git/API request gives up after this long instead of hanging indefinitely; 0
  disables it) and `verboseNetworkLogging` (per-request URL/method/status/duration
  to the dev console, never headers/bodies) — see "Network" under "Git layer" above.
- **Commands:** Sync now · Open setup wizard · Resolve conflict · Open sync panel ·
  Pause/resume auto-sync · View sync history.
- **Conflict modal:** lists conflicting files with a lightweight per-file stat
  (`GitEngine.conflictFileStats`) — line-count comparison between local and
  remote-tracking blobs, or "added locally/remotely" / "binary" — enough to
  gauge what's at stake before an irreversible discard without a full diff
  viewer.
- Engine-touching operations (`SyncOrchestrator.sync`/`resolveConflict` and
  the plugin's clone/init/re-clone/discard) are serialized through a single
  `AsyncLock` (`sync/async-lock.ts`, wired as `runExclusive`): the
  orchestrator's own single-flight guard only prevented sync-vs-sync overlap,
  not a Danger Zone re-clone racing an in-flight auto-sync against the same
  `.git` directory.

### Ignore scope & external-plugin interop

What gets tracked is everything in the vault except: `DEFAULT_IGNORES`
(`git/engine.ts`) — `.obsidian/workspace*` and `.trash/`, both device-local and
never meaningful to sync — plus this plugin's own `data.json` (`ownDataPath`,
always excluded since it rewrites itself on every sync and would otherwise look
like a permanent local change), plus whatever the user adds to `ignoreGlobs` in
settings. `GitEngine.getChangedFiles()` is the one place `ignoreFilter` is
consulted (`engine.ts:804`) — it gates what can ever be staged/committed, not
what a checkout/merge restores, which matters for the guarantee below.

**`registerExternalIgnorePattern(pattern: string): Promise<boolean>`** (public
method on `TetherSyncPlugin`, `main.ts`) is an integration point other vault
plugins can feature-detect via `app.plugins.plugins["tether-sync"]` and call to
get their own managed folder/file excluded, without the user having to
hand-configure `ignoreGlobs` themselves. Additive and idempotent — it only ever
appends a new pattern, never removes one, since one caller's request is never
grounds to un-exclude something else. [Tether Fetch](https://github.com/timrs2998/tether-fetch)
is the first (and so far only) consumer: it registers each source's
destination folder, and its own `data.json` (which can hold plaintext fallback
tokens when `secretStorage` is unavailable), before that folder is ever
populated, which is why the ordering matters. Because `ignoreFilter` only ever gates staging, a path
excluded from before its first write is never part of any commit's tree on any
device, which is the actual mechanism that rules out a checkout/merge on one
device racing a mid-materialize write from another plugin on the same vault —
there's nothing in any tree for a checkout to restore or delete. This doesn't
retroactively fix a path that was already tracked before the pattern was
registered; that needs a one-time manual untrack, deliberately not automated
here given how hard-to-reverse history-rewriting operations are.

## Tooling

- TypeScript + esbuild (obsidian-sample-plugin conventions): single CJS `main.js`,
  `obsidian`/`electron` external, `buffer` polyfill injected (NOT external),
  `ws` external (referenced, but never actually invoked, by the compiled Emscripten
  glue's dead WebSocket-transport code path — see `libgit2/loader.ts`), the compiled
  the compiled `.wasm` embedded into `main.js` as base64, `npm run dev` watch,
  `version-bump.mjs` + `versions.json`.
- Deps: `buffer` — the polyfill exists solely for
  `libgit2/http-transport.ts`'s `basicAuthHeader`. Dev: `obsidian` (^1.13), `esbuild`,
  `typescript`, `vitest` — pure-logic tests (sync decision table, provider detection,
  conflict branch naming, scheduler catch-up math) AND real tests against the actual
  compiled libgit2-WASM module (`tests/libgit2/*.test.ts`, `tests/engine-smoke.test.ts`,
  `tests/gitattributes-guard.test.ts`) — nothing needs a live Obsidian vault, but the
  engine tests are genuinely real, not mocked.
- **Lint (`eslint.config.mjs`, `npm run lint`):** `eslint:recommended` +
  `typescript-eslint`'s `recommended` config, wired into CI
  (`.github/workflows/ci.yml` and `release.yml`).
  `@typescript-eslint/no-unused-vars` is off — tsconfig's `noUnusedLocals`/
  `noUnusedParameters` already cover unused-variable/import detection more
  precisely (compiler-enforced, with the standard leading-underscore escape
  hatch), and having both would just mean two differently-configured versions
  of the same check. `no-undef` is off per typescript-eslint's own documented
  guidance (the compiler's `lib`/`types`-aware checking already does this job
  correctly for ambient globals; the ESLint rule can't see those and false-
  positives on them).
- `manifest.json`: `id: tether-sync`, `isDesktopOnly: false`,
  `minAppVersion: 1.13.0` (see point 6 above for what sets that floor).
