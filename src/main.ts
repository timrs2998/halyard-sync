/**
 * Tether Sync — plugin entry: wires the git core, auth, orchestrator,
 * scheduler, settings tab, status bar, and commands together.
 */

import { Menu, normalizePath, Notice, Platform, Plugin, requestUrl } from "obsidian";
import { createProvider, normalizeRemoteUrl, sshUrlToHttps, type ForgeProvider } from "./auth/providers";
import { DEFAULT_GITCRYPT_KEY_NAME, detectSecretStorage, GitCryptKeyStore, SecretStore } from "./auth/secrets";
import {
	createGitEngine,
	describeGitError,
	deriveGitCryptKeyChecklist,
	GitEngine,
	migrateWorkspaceIgnoreLine,
	UnsupportedGitAttributesError,
	type ConflictFileStat,
	type GitCryptKeyChecklistEntry,
} from "./git/engine";
import { parseGitConfigRemoteUrl } from "./git/gitconfig";
import { withRequestLogging, withRequestTimeout, type RequestUrlLike } from "./git/http-client";
import { wrapLibgit2Module } from "./git/libgit2/engine";
import { instantiateLibgit2Module } from "./git/libgit2/loader";
import { libgit2WasmBytes } from "./git/libgit2/wasm-binary";
import { parseKeyFile } from "./git/gitcrypt";
import { AsyncLock } from "./sync/async-lock";
import { ConflictResolver, generateDeviceName } from "./sync/conflicts";
import { SyncOrchestrator, type OrchestratorEngine } from "./sync/orchestrator";
import { SyncScheduler } from "./sync/scheduler";
import {
	defaultSettings,
	TetherSyncSettingTab,
	type TetherSyncSettings,
} from "./settings";
import { registerTetherSyncIcon, TETHER_SYNC_ICON_ID } from "./ui/icon";
import { ConflictModal, SetupWizardModal, SyncHistoryModal } from "./ui/modals";
import { StatusBarController, statusBarView, type SetupState } from "./ui/statusbar";
import { TETHER_SYNC_VIEW_TYPE, TetherSyncView } from "./ui/sync-view";

/** data.json shape. `fallbackSecrets` exists only when SecretStorage is unavailable. */
interface SavedData extends TetherSyncSettings {
	fallbackSecrets?: Record<string, string>;
}

/** Outcome of `TetherSyncPlugin.testConnection` — see `ui/modals.ts`. */
export interface TestConnectionResult {
	/** Every advertised branch, sorted. */
	branches: string[];
	/** No refs advertised at all — a reachable but empty repository. */
	isEmptyRepo: boolean;
	/** Whether `branch` is among `branches`. */
	branchFound: boolean;
	/** The configured branch, echoed so callers can name it in a message. */
	branch: string;
}

export default class TetherSyncPlugin extends Plugin {
	settings!: TetherSyncSettings;
	secretStore!: SecretStore;
	gitCryptKeyStore!: GitCryptKeyStore;
	orchestrator!: SyncOrchestrator;
	scheduler!: SyncScheduler;
	readonly isMobile: boolean = Platform.isMobile;

	/**
	 * Cached once resolved (loading the compiled WASM module + hydrating the
	 * whole vault into `VaultMirror` is real, non-trivial work — see
	 * `git/engine.ts`'s `createGitEngine` doc comment). Caching the PROMISE
	 * (not just the resolved value) means concurrent first-callers share one
	 * in-flight build instead of racing to load the module twice.
	 */
	private enginePromise: Promise<GitEngine> | null = null;
	private fallbackSecrets: Record<string, string> = {};
	private statusBar: StatusBarController | null = null;
	/**
	 * Cache backing `setupState()` — `.git` existence is an async check
	 * (`app.vault.adapter.exists`), but the ribbon/status bar/sync panel all
	 * render synchronously, so this is set at startup, right after every
	 * clone/init/adopt success, and re-verified on the same periodic timer
	 * the status bar already refreshes on (see `onload`'s `setInterval`) —
	 * catches the rare external case (repo deleted/moved outside the plugin
	 * while it's running) within that interval instead of never.
	 *
	 * Starts `null` (not `false`) deliberately: `startAfterLayoutReady()`'s
	 * first real check hasn't resolved yet at the point the ribbon/status
	 * bar/panel are first constructed in `onload()`, and `false` would read
	 * as a confirmed "no repo" — showing "finish setup" to an already fully
	 * set up vault for the brief window before that check lands. `null`
	 * means "don't know yet"; `setupState()` treats it as `ready` (the
	 * common case for anyone reopening an already-configured vault) rather
	 * than flashing an incorrect setup prompt on ordinary startup.
	 */
	private repoExistsCache: boolean | null = null;
	private progressListener: ((message: string) => void) | null = null;
	/**
	 * Serializes every engine-touching operation: the orchestrator's sync
	 * loop AND the one-off operations below (clone/init/re-clone/discard)
	 * share the same `.git` directory but previously had no coordination —
	 * a Danger Zone re-clone racing an in-flight auto-sync could rename
	 * `.git` out from under it mid-operation.
	 */
	private readonly engineLock = new AsyncLock();
	private unsubscribeRibbon: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.migrateGitignoreConfigDir();

		const fallback = {
			load: async () => ({ ...this.fallbackSecrets }),
			save: async (secrets: Record<string, string>) => {
				this.fallbackSecrets = secrets;
				await this.persist();
			},
		};
		this.secretStore = new SecretStore(detectSecretStorage(this.app), fallback);
		this.gitCryptKeyStore = new GitCryptKeyStore(detectSecretStorage(this.app), fallback);

		if (this.settings.deviceName.length === 0) {
			this.settings.deviceName = generateDeviceName(this.isMobile);
			await this.persist();
		}

		const pauseAutoSync = () => {
			void this.setAutoSyncPaused(true);
		};

		const resolver = new ConflictResolver({
			engine: {
				push: async (options) => (await this.getEngine()).push(options),
				fetch: async (branch) => (await this.getEngine()).fetch(branch),
				hardResetToRemote: async (branch) => (await this.getEngine()).hardResetToRemote(branch),
			},
			provider: () => this.getProvider(),
			getToken: () => this.getToken(),
			branch: () => this.settings.branch,
			deviceName: () => this.settings.deviceName,
			repoPath: () => {
				try {
					return normalizeRemoteUrl(this.settings.remoteUrl).repoPath;
				} catch {
					return "";
				}
			},
			pauseAutoSync,
		});

		this.orchestrator = new SyncOrchestrator({
			engine: this.lazyEngine(),
			conflicts: resolver,
			branch: () => this.settings.branch,
			conflictStrategy: () => this.settings.conflictStrategy,
			platform: this.isMobile ? "mobile" : "desktop",
			pauseAutoSync,
			runExclusive: (fn) => this.engineLock.run(fn),
			onSyncComplete: async (at) => {
				this.settings.lastSyncAt = at;
				await this.persist();
			},
			initialHistory: this.settings.syncHistory,
			onHistoryEntry: async (history) => {
				this.settings.syncHistory = [...history];
				await this.persist();
			},
		});

		this.scheduler = new SyncScheduler({
			requestSync: (reason) => {
				if (this.isConfigured()) this.orchestrator.requestSync(reason);
			},
			getOptions: () => this.settings,
			getLastSyncAt: () => this.settings.lastSyncAt,
			registerInterval: (id) => this.registerInterval(id),
		});
		if (this.settings.autoSyncPaused) this.scheduler.pause();

		this.registerDomEvent(document, "visibilitychange", () => {
			this.scheduler.handleVisibilityChange(!document.hidden);
		});
		this.registerEvent(
			this.app.vault.on("modify", () => this.scheduler.onFileModified())
		);

		try {
			// Keep the status bar even on mobile: some layouts show it, and the
			// controller guards every render.
			const el = this.addStatusBarItem();
			this.statusBar = new StatusBarController(
				el,
				this.orchestrator,
				{
					onSyncClick: () => this.syncNow(),
					onConflictClick: () => void this.openConflictModal(),
					onDetailClick: () => void this.activateSyncView(),
					onSetupClick: () => this.openSetupWizard(),
				},
				() => this.settings.autoSyncPaused,
				() => this.setupState()
			);
			this.registerInterval(
				window.setInterval(() => {
					void this.refreshRepoExistsCache().then(() => this.statusBar?.refresh());
				}, 60_000)
			);
		} catch {
			this.statusBar = null;
		}

		this.registerView(TETHER_SYNC_VIEW_TYPE, (leaf) => new TetherSyncView(leaf, this));

		registerTetherSyncIcon();
		this.setupRibbonIcon();

		this.addSettingTab(new TetherSyncSettingTab(this.app, this));
		this.registerCommands();

		this.app.workspace.onLayoutReady(() => {
			void this.startAfterLayoutReady();
		});
	}

	onunload(): void {
		this.scheduler.stop();
		this.statusBar?.dispose();
		this.statusBar = null;
		this.unsubscribeRibbon?.();
		this.unsubscribeRibbon = null;
		// Deliberately no detachLeavesOfType here: Obsidian's plugin guidelines
		// call it out, since tearing down leaves on unload destroys the user's
		// layout across a plugin update. Obsidian cleans up views registered
		// via registerView on its own.
		const pending = this.enginePromise;
		this.enginePromise = null;
		if (pending !== null) {
			void pending.then((engine) => engine.close()).catch(() => {
				// Best effort — the plugin is unloading either way.
			});
		}
	}

	/**
	 * Ribbon icon: the one always-visible, always-discoverable entry point —
	 * the status bar item can be hidden by some layouts/themes, and everything
	 * else lives behind the command palette. Left click mirrors the status
	 * bar (sync now, or resolve if conflicted); right click opens a quick menu
	 * so the plugin doesn't need a full dedicated pane for occasional actions.
	 */
	private setupRibbonIcon(): void {
		const ribbonEl = this.addRibbonIcon(TETHER_SYNC_ICON_ID, "Tether Sync", () => {
			if (this.setupState() !== "ready") {
				this.openSetupWizard();
				return;
			}
			const status = this.orchestrator.status;
			if (status.state === "conflict") void this.openConflictModal();
			else this.syncNow();
		});
		ribbonEl.addClass("tether-sync-ribbon-icon");

		const updateRibbon = () => {
			const status = this.orchestrator.status;
			const view = statusBarView(status, Date.now(), this.settings.autoSyncPaused, this.setupState());
			ribbonEl.setAttribute("aria-label", `Tether Sync: ${view.tooltip}`);
			ribbonEl.toggleClass("tether-sync-ribbon-attention", status.state === "conflict");
			ribbonEl.toggleClass(
				"tether-sync-ribbon-error",
				status.state === "error" || status.state === "blocked" || status.state === "locked"
			);
			// Cord "flows" (see styles.css) during the states statusbar.ts's own
			// switch treats as active syncing — kept in sync with that list
			// rather than re-deriving it, since it's the single source of truth
			// for what counts as "syncing" in the UI.
			ribbonEl.toggleClass(
				"tether-sync-ribbon-syncing",
				status.state === "staging" ||
					status.state === "fetching" ||
					status.state === "integrating" ||
					status.state === "pushing"
			);
		};
		updateRibbon();
		this.unsubscribeRibbon = this.orchestrator.on(updateRibbon);

		ribbonEl.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("Sync now").setIcon(TETHER_SYNC_ICON_ID).onClick(() => this.syncNow())
			);
			if (this.orchestrator.isConflicted) {
				menu.addItem((item) =>
					item
						.setTitle("Resolve conflict")
						.setIcon("alert-triangle")
						.onClick(() => this.openConflictModal())
				);
			}
			menu.addItem((item) =>
				item
					.setTitle("Open sync panel")
					.setIcon("panel-right")
					.onClick(() => void this.activateSyncView())
			);
			menu.addItem((item) =>
				item
					.setTitle("View sync history")
					.setIcon("history")
					.onClick(() => new SyncHistoryModal(this.app, this.orchestrator.history).open())
			);
			menu.addItem((item) =>
				item
					.setTitle(this.settings.autoSyncPaused ? "Resume auto-sync" : "Pause auto-sync")
					.setIcon(this.settings.autoSyncPaused ? "play" : "pause")
					.onClick(() => void this.setAutoSyncPaused(!this.settings.autoSyncPaused))
			);
			menu.addItem((item) =>
				item
					.setTitle("Open setup wizard")
					.setIcon("wrench")
					.onClick(() => this.openSetupWizard())
			);
			menu.showAtMouseEvent(evt);
		});
	}

	// -- Settings & persistence ---------------------------------------------

	private async loadSettings(): Promise<void> {
		const saved = ((await this.loadData()) ?? {}) as Partial<SavedData>;
		const { fallbackSecrets, ...rest } = saved;
		this.fallbackSecrets = fallbackSecrets ?? {};
		this.settings = { ...defaultSettings(this.isMobile), ...rest };
	}

	/** Save settings and re-apply anything derived from them. */
	async saveSettings(): Promise<void> {
		await this.persist();
		// Update an already-built engine in place rather than tearing it down:
		// rebuilding would reload the compiled WASM module and re-hydrate the
		// whole vault, which every keystroke in (e.g.) the ignore-globs
		// textarea must not pay for. If no engine has been built yet, the
		// next getEngine() call picks up these settings at construction time
		// anyway.
		if (this.enginePromise !== null) {
			const pending = this.enginePromise;
			void pending
				.then((engine) =>
					engine.updateOptions({
						author: {
							name: this.settings.authorName,
							email: this.settings.authorEmail,
						},
						ignoreGlobs: this.settings.ignoreGlobs,
						autoMergeOverlappingEdits: this.settings.autoMergeOverlappingEdits,
					})
				)
				.catch(() => {
					// Engine failed to build in the first place — nothing to update.
				});
		}
		this.scheduler.applyOptions();
	}

	/**
	 * Optional integration point for other vault plugins that manage their own
	 * folder or file and want it excluded from sync (e.g. Tether Fetch's
	 * mirrored destination folders — see that plugin's DESIGN.md "Explode &
	 * materialize"). Not part of any formal inter-plugin API/contract, just a
	 * plain method another plugin can feature-detect via
	 * `app.plugins.plugins["tether-sync"]`.
	 *
	 * Additive and idempotent only: never removes an existing pattern, since
	 * one caller asking to exclude a path is never grounds to stop excluding
	 * something else. Returns whether the pattern was newly added.
	 */
	async registerExternalIgnorePattern(pattern: string): Promise<boolean> {
		if (this.settings.ignoreGlobs.includes(pattern)) return false;
		this.settings.ignoreGlobs = [...this.settings.ignoreGlobs, pattern];
		await this.saveSettings();
		return true;
	}

	private async persist(): Promise<void> {
		const data: SavedData = { ...this.settings };
		// Tokens go to data.json only in SecretStorage-fallback mode.
		if (Object.keys(this.fallbackSecrets).length > 0) {
			data.fallbackSecrets = this.fallbackSecrets;
		}
		await this.saveData(data);
	}

	// -- Engine & provider ---------------------------------------------------

	/**
	 * Wraps Obsidian's `requestUrl` with a live-settings-driven timeout and
	 * opt-in diagnostic logging (see `git/http-client.ts`'s
	 * `withRequestTimeout`/`withRequestLogging`) — the fix for "syncing"
	 * hanging forever behind a proxy/firewall that silently drops
	 * connections instead of rejecting them, reported from a corporate
	 * network. Both wrappers re-read `this.settings` on every call rather
	 * than capturing a snapshot, so changing either setting takes effect on
	 * the very next request even against an already-built, cached engine —
	 * no restart or re-clone needed. Safe to call repeatedly: cheap
	 * closures, no shared state between wrapped instances.
	 */
	private wrapRequestUrl(fn: RequestUrlLike): RequestUrlLike {
		const withTimeout = withRequestTimeout(fn, () => this.settings.networkTimeoutSeconds * 1000);
		return withRequestLogging(withTimeout, (entry) => {
			if (!this.settings.verboseNetworkLogging) return;
			const outcome =
				entry.error !== null ? `FAILED: ${entry.error}` : `${entry.status}`;
			console.debug(
				`[Tether Sync] ${entry.method} ${entry.url} -> ${outcome} (${entry.durationMs}ms)`
			);
		});
	}

	private async buildEngine(): Promise<GitEngine> {
		return createGitEngine({
			instantiateModule: () => instantiateLibgit2Module(async () => libgit2WasmBytes()),
			wrapModule: (rawModule, requestUrlFn) => wrapLibgit2Module(rawModule, { requestUrl: requestUrlFn }),
			requestUrl: this.wrapRequestUrl(requestUrl),
			adapter: this.app.vault.adapter,
			author: {
				name: this.settings.authorName,
				email: this.settings.authorEmail,
			},
			ignoreGlobs: this.settings.ignoreGlobs,
			autoMergeOverlappingEdits: this.settings.autoMergeOverlappingEdits,
			ownDataPath: this.manifest.dir ? normalizePath(`${this.manifest.dir}/data.json`) : undefined,
			configDir: this.app.vault.configDir,
			onAuth: async () => {
				const token = await this.getToken();
				if (token === null) return null;
				const provider = this.getProvider();
				return provider !== null
					? provider.gitAuth(token)
					: { username: this.settings.genericUsername || "oauth2", password: token };
			},
			onProgress: (stage, current, total) => {
				if (this.progressListener === null) return;
				const totalStr = total > 0 ? `/${total}` : "";
				this.progressListener(`${stage} (${current}${totalStr})`);
			},
			getGitCryptKeys: () => this.gitCryptKeyStore.getAllKeys(this.tokenHost()),
		});
	}

	private getEngine(): Promise<GitEngine> {
		if (this.enginePromise === null) {
			this.enginePromise = this.buildEngine().catch((err) => {
				// Allow a retry on the next call instead of permanently caching a
				// failed build (e.g. a transient WASM-instantiation failure).
				this.enginePromise = null;
				throw err;
			});
		}
		return this.enginePromise;
	}

	/**
	 * Delegating wrapper so the orchestrator always sees the current engine.
	 *
	 * `detectUnsupportedFilters` — the first call every single sync cycle
	 * makes, unconditionally — re-checks `.git` still exists on the real
	 * adapter first. The cached engine's `VaultMirror` is an in-memory
	 * hydration of the vault that only gets written back out to the adapter
	 * on `flush()`; it has no way to notice `.git` was deleted out from
	 * under it (e.g. through the OS file browser while Obsidian keeps
	 * running) on its own, and the NEXT flush would simply recreate `.git`
	 * from that stale in-memory copy — silently undoing what was, for
	 * `.git` specifically, most likely a deliberate action. Discarding the
	 * cached engine and surfacing a clear error instead means the user's
	 * deletion sticks, and `setupState()` correctly reports "incomplete"
	 * (see its own doc comment) until the wizard reconnects it.
	 *
	 * `listRemoteRef` — the first NETWORK call every cycle — re-runs
	 * `ensureRemote` first. This is the per-sync counterpart to the one-time
	 * call in `startAfterLayoutReady()`: that one only guards against a
	 * `.git` that already existed before the plugin ever started; this one
	 * guards against the remote being deleted, repointed, or otherwise
	 * edited *while Obsidian is running* (manually via git CLI, another
	 * tool, a synced `.git` folder overwritten from another device, etc.) —
	 * a real gap since nothing previously re-checked this after startup.
	 * Cheap: one local `.git/config` write, no network, every cycle.
	 */
	private lazyEngine(): OrchestratorEngine {
		return {
			detectUnsupportedFilters: async () => {
				if (!(await this.hasRepo())) {
					await this.discardEngine();
					this.repoExistsCache = false;
					throw new Error(
						"This vault's .git directory is missing — run the setup wizard again to reconnect."
					);
				}
				return (await this.getEngine()).detectUnsupportedFilters();
			},
			currentBranch: async () => (await this.getEngine()).currentBranch(),
			getChangedFiles: async () => (await this.getEngine()).getChangedFiles(),
			stageAndCommit: async (message) => (await this.getEngine()).stageAndCommit(message),
			listRemoteRef: async (branch) => {
				const engine = await this.getEngine();
				await engine.ensureRemote(this.settings.remoteUrl);
				return engine.listRemoteRef(branch);
			},
			remoteTrackingRef: async (branch) => (await this.getEngine()).remoteTrackingRef(branch),
			localRef: async (branch) => (await this.getEngine()).localRef(branch),
			fetch: async (branch) => (await this.getEngine()).fetch(branch),
			mergeUpstream: async (branch) => (await this.getEngine()).mergeUpstream(branch),
			aheadBehind: async (branch) => (await this.getEngine()).aheadBehind(branch),
			push: async (options) => (await this.getEngine()).push(options),
		};
	}

	getProvider(): ForgeProvider | null {
		if (this.settings.remoteUrl.length === 0) return null;
		try {
			return createProvider(this.settings.remoteUrl, {
				requestUrl: this.wrapRequestUrl(requestUrl),
				githubClientId: this.settings.githubClientId,
				gitlabClientId: this.settings.gitlabClientId,
				gitlabSelfManagedBase: this.settings.gitlabSelfManagedBase,
				giteaSelfManagedBase: this.settings.giteaSelfManagedBase,
				bitbucketAccountEmail: this.settings.bitbucketAccountEmail,
				genericUsername: this.settings.genericUsername,
			});
		} catch {
			return null;
		}
	}

	// -- Tokens ---------------------------------------------------------------

	private tokenHost(): string {
		try {
			return normalizeRemoteUrl(this.settings.remoteUrl).host;
		} catch {
			return "default";
		}
	}

	getToken(): Promise<string | null> {
		return this.secretStore.getToken(this.tokenHost());
	}

	async setToken(token: string): Promise<void> {
		await this.secretStore.setToken(this.tokenHost(), token);
	}

	async clearToken(): Promise<void> {
		await this.secretStore.deleteToken(this.tokenHost());
	}

	async hasToken(): Promise<boolean> {
		return (await this.getToken()) !== null;
	}

	// -- git-crypt key management ---------------------------------------------

	async hasGitCryptKey(): Promise<boolean> {
		return this.gitCryptKeyStore.hasKey(this.tokenHost());
	}

	/**
	 * Every git-crypt-family key name this repo's gitattributes currently
	 * declares (default and/or named), each flagged with whether it's
	 * configured on this device — what the settings tab's checklist renders.
	 * Returns null when there's nothing to scan yet: not configured, no repo
	 * cloned/initialized, or the scan itself fails (best-effort, matching
	 * every other "can't tell yet" path in this plugin) — the settings UI
	 * shows a "connect a repository first" message for null, same pattern as
	 * the existing single-key section's "No valid remote URL configured yet."
	 */
	async gitCryptChecklist(): Promise<GitCryptKeyChecklistEntry[] | null> {
		if (!this.isConfigured()) return null;
		if (!(await this.hasRepo())) return null;
		try {
			const engine = await this.getEngine();
			const declared = await engine.declaredGitCryptKeyNames();
			const configured = await this.gitCryptKeyStore.listConfiguredNames(this.tokenHost());
			return deriveGitCryptKeyChecklist(declared, configured);
		} catch {
			return null;
		}
	}

	/** Parses `bytes` as a git-crypt "internal" key-file export (see
	 * `git/gitcrypt.ts`'s `parseKeyFile`), and stores the key material under
	 * the slot its OWN embedded key name says it belongs to (`keyName: null`
	 * -> the default/unnamed slot, `keyName: "finance"` -> that named slot) —
	 * the user never has to type a name; the key file already carries it
	 * (`git-crypt export-key -k <name> <path>` embeds it). Re-registers the
	 * native git-crypt filter immediately if an engine is already built, so
	 * an in-progress session picks up the new key without needing a restart.
	 * Throws `GitCryptKeyFileError`/`GitCryptFormatError` (from
	 * `gitcrypt.ts`) on a malformed file; callers surface that via
	 * `describeGitError`/a plain `.message` read, same as every other
	 * settings-UI error path in this plugin. */
	async importGitCryptKey(bytes: Uint8Array): Promise<void> {
		const parsed = parseKeyFile(bytes);
		const keyName = parsed.keyName ?? DEFAULT_GITCRYPT_KEY_NAME;
		await this.gitCryptKeyStore.setKey(this.tokenHost(), keyName, {
			aesKey: parsed.aesKey,
			hmacKey: parsed.hmacKey,
		});
		await this.refreshGitCryptFilter();
	}

	async clearGitCryptKey(keyName: string = DEFAULT_GITCRYPT_KEY_NAME): Promise<void> {
		await this.gitCryptKeyStore.deleteKey(this.tokenHost(), keyName);
		await this.refreshGitCryptFilter();
	}

	private async refreshGitCryptFilter(): Promise<void> {
		if (this.enginePromise === null) return;
		try {
			const engine = await this.enginePromise;
			await engine.syncGitCryptFilter();
		} catch {
			// Best effort — the next detectUnsupportedFilters()/sync call will
			// still pick up the new key via getGitCryptKey() regardless.
		}
	}

	// -- Actions --------------------------------------------------------------

	/** True once step 1 of the setup wizard has saved a remote URL — NOT a
	 * guarantee a repo actually exists yet (see `hasRepo()`'s own doc
	 * comment); `syncNow()` already handles that narrower "configured but
	 * mid-wizard" gap with its own notice. Public so UI surfaces (ribbon,
	 * status bar, sync panel) can all point an unconfigured user at the
	 * setup wizard instead of showing sync controls that don't do anything
	 * useful yet. */
	isConfigured(): boolean {
		return this.settings.remoteUrl.length > 0;
	}

	/** A `.git` directory alone doesn't mean this plugin set it up — pair with isConfigured(). */
	private async hasRepo(): Promise<boolean> {
		try {
			return await this.app.vault.adapter.exists(".git");
		} catch {
			return false;
		}
	}

	/**
	 * Three-state setup read for UI surfaces (ribbon, status bar, sync
	 * panel) — distinguishes "never started setup" from "started the wizard
	 * but never finished cloning/initializing", since both need to point at
	 * the wizard but the right message differs. Synchronous, backed by
	 * `repoExistsCache` (see that field's doc comment for why this can't
	 * just call the async `hasRepo()` directly here).
	 */
	setupState(): SetupState {
		if (!this.isConfigured()) return "unconfigured";
		// null: haven't checked yet (see repoExistsCache's own doc comment) —
		// assume ready rather than flash "incomplete" during ordinary startup.
		if (this.repoExistsCache === null) return "ready";
		return this.repoExistsCache ? "ready" : "incomplete";
	}

	private async refreshRepoExistsCache(): Promise<void> {
		this.repoExistsCache = await this.hasRepo();
	}

	/**
	 * Best-effort read of an already-existing repo's "origin" remote — used
	 * only to prepopulate the setup wizard's URL field so a vault that was
	 * already `git clone`d by hand (often over SSH) doesn't force the user
	 * to go dig up and retype the HTTPS equivalent themselves. Deliberately
	 * reads `.git/config` directly rather than building a full engine: this
	 * runs before any engine/token/provider setup exists yet, and spinning
	 * up the WASM module + hydrating the whole vault just to peek at one
	 * config line would be real, avoidable cost (see `createGitEngine`'s own
	 * doc comment on why that's expensive) for what's only ever a UI hint —
	 * the user can always edit the field regardless of what this returns.
	 *
	 * Only checks "origin" (the overwhelming git convention for the primary
	 * remote), not every configured remote — no enumeration API exists for
	 * that, and building one just for a prefill hint isn't worth it. Returns
	 * null for a vault with no `.git`, no "origin" remote, or anything
	 * unreadable — the wizard's URL field just starts empty in that case,
	 * same as before this existed.
	 */
	async detectExistingRemoteUrl(): Promise<{ url: string; convertedFromSsh: boolean } | null> {
		if (!(await this.hasRepo())) return null;
		let configText: string;
		try {
			configText = await this.app.vault.adapter.read(".git/config");
		} catch {
			return null;
		}
		const raw = parseGitConfigRemoteUrl(configText, "origin");
		if (raw === null) return null;
		const converted = sshUrlToHttps(raw);
		return converted !== null
			? { url: converted, convertedFromSsh: true }
			: { url: raw, convertedFromSsh: false };
	}

	syncNow(): void {
		if (!this.isConfigured()) {
			new Notice("Tether Sync: not configured yet — opening the setup wizard.");
			this.openSetupWizard();
			return;
		}
		void this.hasRepo().then((hasRepo) => {
			if (!hasRepo) {
				// Remote URL is saved as soon as step 1 of the wizard completes,
				// well before clone/init actually creates a repo — without this
				// check, a manual sync in that window hit a raw "no such .git"
				// error instead of a clear message.
				new Notice(
					"Tether Sync: setup isn't finished — finish the wizard's clone/initialize step first."
				);
				return;
			}
			this.orchestrator.requestSync("manual");
		});
	}

	openSetupWizard(): void {
		new SetupWizardModal(this.app, this).open();
	}

	/** Reveals the right-sidebar sync panel, creating it if it doesn't exist yet. */
	async activateSyncView(): Promise<void> {
		await this.app.workspace.ensureSideLeaf(TETHER_SYNC_VIEW_TYPE, "right", { reveal: true });
	}

	async openConflictModal(): Promise<void> {
		const status = this.orchestrator.status;
		if (status.state !== "conflict") {
			new Notice("Tether Sync: there is no conflict to resolve.");
			return;
		}
		const files = status.conflictFiles ?? [];
		let stats: ConflictFileStat[] = [];
		try {
			const engine = await this.getEngine();
			stats = await engine.conflictFileStats(this.settings.branch, files);
		} catch {
			// Best effort — the modal still works with just the file list.
		}
		new ConflictModal(this.app, files, stats, async (strategy) => {
			const result = await this.orchestrator.resolveConflict(strategy);
			if (result === null) {
				new Notice("Tether Sync: could not resolve — see the status bar.");
				return;
			}
			new Notice(`Tether Sync: ${result.message}`, 10_000);
			if (result.kind === "resolved") {
				// Resolving a conflict lifts a keep-local pause.
				await this.setAutoSyncPaused(false);
			}
		}).open();
	}

	/**
	 * Check the configured remote + saved token by doing a real ref
	 * advertisement — the wizard's "Test connection", matching the equivalent
	 * step in Tether Fetch's add-source wizard.
	 *
	 * Takes `engineLock` like every other engine user: the test can run while
	 * a scheduled sync is in flight, and `GitEngine` is not reentrant.
	 *
	 * Needs no repository, so it works at wizard time before any clone or
	 * init. See `GitEngine.testConnection` for why this goes over the git
	 * transport instead of a cheaper provider REST call.
	 */
	async testConnection(): Promise<TestConnectionResult> {
		const url = this.settings.remoteUrl;
		// Surfaces "SSH URL" / "not a URL" as a clean message rather than
		// letting it fail deep in libgit2.
		normalizeRemoteUrl(url);
		if ((await this.getToken()) === null) {
			throw new Error("No token saved for this host yet — add one above, then test.");
		}
		return this.engineLock.run(async () => {
			const engine = await this.getEngine();
			const refs = await engine.testConnection(url);
			const branches = refs
				.map((r) => r.ref.replace(/^refs\/heads\//, ""))
				.sort((a, b) => a.localeCompare(b));
			return {
				branches,
				// An empty repo advertises nothing; that is a successful
				// connection, not a missing branch, so callers distinguish it.
				isEmptyRepo: branches.length === 0,
				branchFound: branches.includes(this.settings.branch),
				branch: this.settings.branch,
			};
		});
	}

	async cloneRemote(onProgress?: (message: string) => void): Promise<void> {
		await this.engineLock.run(() => this.cloneRemoteLocked(onProgress));
	}

	/**
	 * Unlocked core of `cloneRemote`, so `recloneVault` (which already holds
	 * the lock) can call it directly without re-entering `engineLock.run` —
	 * that would deadlock, since the lock isn't reentrant.
	 */
	private async cloneRemoteLocked(onProgress?: (message: string) => void): Promise<void> {
		const engine = await this.getEngine();
		this.progressListener = onProgress ?? null;
		try {
			await engine.clone({
				url: this.settings.remoteUrl,
				ref: this.settings.branch.length > 0 ? this.settings.branch : undefined,
			});
			// Checked as soon as the tree is on disk, before anything is
			// considered "configured": see UnsupportedGitAttributesError. A
			// "locked" (git-crypt, no key yet) result is allowed through — the
			// orchestrator will surface it as the "locked" sync state on the
			// first real sync attempt, recoverable by importing a key.
			const filters = await engine.detectUnsupportedFilters();
			if (filters.kind === "blocked") {
				throw new UnsupportedGitAttributesError(filters.filters);
			}
			const branch = await engine.currentBranch();
			if (branch !== null && branch !== this.settings.branch) {
				this.settings.branch = branch;
				await this.persist();
			}
		} finally {
			this.progressListener = null;
		}
		this.repoExistsCache = true;
		this.scheduler.start();
	}

	async initFromExistingVault(onProgress?: (message: string) => void): Promise<void> {
		await this.engineLock.run(async () => {
			const engine = await this.getEngine();
			const branch = this.settings.branch.length > 0 ? this.settings.branch : "main";
			this.progressListener = onProgress ?? null;
			try {
				// Checked before anything is staged: at this point there is no git
				// index yet, so the working tree itself has to be scanned directly.
				const filters = await engine.detectUnsupportedFiltersInWorkingTree();
				if (filters.kind === "blocked") {
					throw new UnsupportedGitAttributesError(filters.filters);
				}
				onProgress?.("Initializing repository");
				await engine.initFromExistingVault({
					url: this.settings.remoteUrl,
					defaultBranch: branch,
				});
				await this.seedGitignore();
				onProgress?.("Creating initial commit");
				await engine.stageAndCommit(
					`vault sync: initial import (${this.isMobile ? "mobile" : "desktop"})`
				);
				onProgress?.("Pushing");
				await engine.push({ ref: branch });
			} finally {
				this.progressListener = null;
			}
			this.repoExistsCache = true;
			this.scheduler.start();
		});
	}

	/**
	 * "Adopt" a vault that already has a `.git` repository the wizard didn't
	 * create — unlike `cloneRemote`/`initFromExistingVault` above, this never
	 * force-checks-out or force-commits anything. It only points this
	 * plugin's own remote (`GitEngine`'s `"tether-sync"` — see its doc
	 * comment) at the URL from step 1, makes sure `settings.branch` matches
	 * whatever branch is actually checked out (so the orchestrator operates
	 * on the real branch instead of a stale default), and hands off to the
	 * exact same machinery every later sync already uses
	 * (`SyncOrchestrator.sync()`) to reconcile: stage/commit whatever's
	 * currently uncommitted, fetch, merge, and surface a real conflict
	 * through the normal conflict UI if the histories actually diverge.
	 * Nothing here is a special case the orchestrator doesn't already
	 * handle on every run — including the unsupported-filter check, so this
	 * method doesn't repeat it the way `cloneRemoteLocked` has to (that path
	 * has no orchestrator run yet to catch it).
	 *
	 * This is deliberately the only path `ui/modals.ts`'s `renderCloneStep`
	 * offers once `.git` already exists — Clone's force-checkout and
	 * Initialize's forced branch-pointer reset are both real risks to
	 * existing, possibly-uncommitted work that this path avoids entirely.
	 */
	async adoptExistingRepo(onProgress?: (message: string) => void): Promise<void> {
		await this.engineLock.run(async () => {
			const engine = await this.getEngine();
			this.progressListener = onProgress ?? null;
			try {
				onProgress?.("Connecting to existing repository");
				await engine.ensureRemote(this.settings.remoteUrl);
				const branch = await engine.currentBranch();
				if (branch !== null && branch !== this.settings.branch) {
					this.settings.branch = branch;
					await this.persist();
				}
			} finally {
				this.progressListener = null;
			}
			this.repoExistsCache = true;
			this.scheduler.start();
		});
		// Immediate feedback rather than waiting on syncOnStartup/the
		// interval — the user just clicked a button expecting something to
		// happen now. Its actual outcome (including a blocked/locked/conflict
		// state) surfaces through the normal status bar and sync panel, not
		// through this call — see the doc comment above.
		this.orchestrator.requestSync("manual");
	}

	/** Seed ignores for files that must never sync (see DESIGN.md). Mirrors
	 * `buildEngine`'s `ownDataPath` so the on-disk `.gitignore` (read by any
	 * external git tooling on the same repo) matches what this plugin itself
	 * excludes from staging. */
	private async seedGitignore(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(".gitignore")) return;
		const lines = [`${this.app.vault.configDir}/workspace*`, ".trash/"];
		if (this.manifest.dir) lines.push(normalizePath(`${this.manifest.dir}/data.json`));
		await adapter.write(".gitignore", lines.join("\n") + "\n");
	}

	/**
	 * Earlier versions wrote the workspace ignore with a hardcoded
	 * `.obsidian/` prefix, so a vault whose configuration folder is named
	 * anything else has been syncing its (device-specific, constantly
	 * churning) workspace files ever since. Rewrite that one line to point at
	 * the real config folder.
	 *
	 * The rewrite itself is `migrateWorkspaceIgnoreLine` (pure, tested); this
	 * is just the vault IO around it, and it is a no-op on every subsequent
	 * launch.
	 */
	private async migrateGitignoreConfigDir(): Promise<void> {
		const configDir = this.app.vault.configDir;
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(".gitignore"))) return;
		const migrated = migrateWorkspaceIgnoreLine(await adapter.read(".gitignore"), configDir);
		if (migrated === null) return;
		await adapter.write(".gitignore", migrated);
	}

	async recloneVault(onProgress?: (message: string) => void): Promise<void> {
		await this.engineLock.run(async () => {
			const adapter = this.app.vault.adapter;
			const hadGit = await adapter.exists(".git");
			if (hadGit) {
				// Rename the old repo aside instead of deleting it outright: if the
				// clone below fails partway (e.g. a network drop), it can be
				// restored instead of leaving the vault with no git tracking at all.
				if (await adapter.exists(".git.bak")) {
					await adapter.rmdir(".git.bak", true);
				}
				await adapter.rename(".git", ".git.bak");
			}
			// The old engine's mounted VaultMirror/WASM repo handle no longer
			// reflects reality once `.git` is renamed out from under it — a full
			// rebuild (fresh WASM module, fresh hydrate) is genuinely required
			// here, unlike ordinary settings edits.
			await this.discardEngine();
			try {
				await this.cloneRemoteLocked(onProgress);
			} catch {
				await this.discardEngine();
				if (hadGit) {
					try {
						await adapter.rename(".git.bak", ".git");
					} catch {
						// Best effort: if even the rollback fails, there is nothing
						// more we can safely automate here.
					}
				}
				new Notice(
					"Tether Sync: re-clone failed — your previous repository state " +
						"was restored. Vault files were not modified.",
					10_000
				);
				return;
			}
			if (hadGit) {
				await adapter.rmdir(".git.bak", true).catch(() => {});
			}
			new Notice("Tether Sync: re-clone complete");
		});
	}

	/** Closes (best effort) and drops the cached engine, forcing the next
	 * `getEngine()` call to rebuild from scratch — only for cases where the
	 * underlying `.git` directory's identity actually changed out from under
	 * the engine (re-clone), not for ordinary settings edits (see
	 * `saveSettings`, which updates in place instead). */
	private async discardEngine(): Promise<void> {
		const pending = this.enginePromise;
		this.enginePromise = null;
		if (pending === null) return;
		try {
			const engine = await pending;
			await engine.close();
		} catch {
			// Nothing to close if the previous build itself failed.
		}
	}

	async discardLocalChanges(): Promise<void> {
		await this.engineLock.run(async () => {
			const engine = await this.getEngine();
			await engine.fetch(this.settings.branch);
			await engine.hardResetToRemote(this.settings.branch);
		});
		new Notice("Tether Sync: local changes discarded");
	}

	async setAutoSyncPaused(paused: boolean): Promise<void> {
		this.settings.autoSyncPaused = paused;
		if (paused) this.scheduler.pause();
		else this.scheduler.resume();
		await this.persist();
	}

	// -- Startup & commands ---------------------------------------------------

	private async startAfterLayoutReady(): Promise<void> {
		const hasRepo = await this.hasRepo();
		this.repoExistsCache = hasRepo;
		// A .git directory alone doesn't mean THIS plugin set it up — only
		// treat the vault as configured once a remote is also on record.
		if (hasRepo && this.isConfigured()) {
			// `.git` can predate this plugin entirely (a vault the user already
			// had cloned by hand, often over SSH, before ever running the setup
			// wizard) — reconcile the repo's actual remote URL against the
			// validated `settings.remoteUrl` before syncing off of whatever was
			// already on disk. See `GitEngine.ensureRemote`'s doc comment.
			try {
				const engine = await this.getEngine();
				await engine.ensureRemote(this.settings.remoteUrl);
			} catch (err) {
				new Notice(
					`Tether Sync: could not verify this vault's git remote — ${describeGitError(err)}`,
					30_000
				);
				return;
			}
			this.scheduler.start();
			return;
		}
		const message = hasRepo
			? "Tether Sync found an existing git repository in this vault, but " +
				"isn't configured to use it yet — click here to set it up."
			: "Tether Sync: this vault has no repository yet — click here to run the setup wizard.";
		const notice = new Notice(message, 30_000);
		notice.messageEl.addEventListener("click", () => {
			notice.hide();
			this.openSetupWizard();
		});
	}

	private registerCommands(): void {
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.syncNow(),
		});
		this.addCommand({
			id: "open-setup-wizard",
			name: "Open setup wizard",
			callback: () => this.openSetupWizard(),
		});
		this.addCommand({
			id: "resolve-conflict",
			name: "Resolve conflict",
			callback: () => this.openConflictModal(),
		});
		this.addCommand({
			id: "open-sync-panel",
			name: "Open sync panel",
			callback: () => void this.activateSyncView(),
		});
		this.addCommand({
			id: "view-sync-history",
			name: "View sync history",
			callback: () => {
				new SyncHistoryModal(this.app, this.orchestrator.history).open();
			},
		});
		this.addCommand({
			id: "toggle-auto-sync",
			name: "Pause/resume auto-sync",
			callback: () => {
				const next = !this.settings.autoSyncPaused;
				void this.setAutoSyncPaused(next).then(() => {
					new Notice(`Tether Sync: auto-sync ${next ? "paused" : "resumed"}`);
				});
			},
		});
		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				// app.setting is not in the public typings; probe structurally.
				const appWithSetting = this.app as unknown as {
					setting?: { open(): void; openTabById(id: string): void };
				};
				appWithSetting.setting?.open();
				appWithSetting.setting?.openTabById(this.manifest.id);
			},
		});
	}
}
