/**
 * Settings model + settings tab UI.
 *
 * The model is pure data (defaults derived from platform); the tab declares
 * its rows through Obsidian's declarative settings API (1.13+), which is what
 * puts them in the app's settings search. Tokens are NEVER part of this model
 * — they live in SecretStore (see auth/secrets.ts).
 */

import {
	Notice,
	PluginSettingTab,
	Setting,
	type App,
	type SettingDefinitionItem,
	type SettingGroupItem,
} from "obsidian";
import { detectProvider, type ProviderKind } from "./auth/providers";
import {
	DEFAULT_CONFLICT_STRATEGY,
	type ConflictStrategyName,
} from "./sync/conflicts";
import type { SyncHistoryEntry } from "./sync/orchestrator";
import { defaultScheduleOptions, type ScheduleOptions } from "./sync/scheduler";
import type { GitCryptKeyChecklistEntry } from "./git/engine";
import {
	attachGitCryptKeyImportButton,
	ConfirmModal,
	createTokenSettingRenderers,
	SetupWizardModal,
	type TokenSettingRenderers,
} from "./ui/modals";
import type TetherSyncPlugin from "./main";

export interface TetherSyncSettings extends ScheduleOptions {
	remoteUrl: string;
	branch: string;
	/** Names conflict branches; generated once on first load. */
	deviceName: string;
	authorName: string;
	authorEmail: string;
	ignoreGlobs: string[];
	/** Username sent with a PAT on generic hosts. */
	genericUsername: string;
	/** Origin of a self-managed GitLab instance ("" = none). */
	gitlabSelfManagedBase: string;
	/** Origin of a self-managed Gitea/Forgejo instance ("" = none). */
	giteaSelfManagedBase: string;
	/** Atlassian account email — required for Bitbucket's REST API (PR creation). */
	bitbucketAccountEmail: string;
	/** OAuth client ID overrides ("" = use the built-in constant). */
	githubClientId: string;
	gitlabClientId: string;
	conflictStrategy: ConflictStrategyName;
	/**
	 * Off by default. When on, an overlapping edit (same lines changed on
	 * two devices) is no longer a conflict at all: the merge concatenates
	 * both sides' distinct lines into the file instead of stopping and
	 * running `conflictStrategy`. That means a note can end up containing
	 * both edits back-to-back with no marker distinguishing them — fine for
	 * append-only content (lists, journals), actively misleading for a
	 * sentence-level edit where only one version should "win". This is a
	 * different kind of setting than `conflictStrategy`: it changes whether
	 * something is detected as a conflict in the first place, not what
	 * happens once one is detected — see `GitEngine.mergeUpstream`'s doc
	 * comment.
	 */
	autoMergeOverlappingEdits: boolean;
	autoSyncPaused: boolean;
	lastSyncAt: number | null;
	/** Rolling history of recent sync outcomes (see SyncOrchestrator.history). */
	syncHistory: SyncHistoryEntry[];
	/** Every git/API request gives up after this long instead of hanging
	 * indefinitely (e.g. behind a proxy that silently drops connections).
	 * 0 disables the timeout. See `git/http-client.ts`'s `withRequestTimeout`. */
	networkTimeoutSeconds: number;
	/** Logs each request's URL/method/status/duration (never headers or
	 * bodies) to the developer console. See `withRequestLogging`. */
	verboseNetworkLogging: boolean;
}

export function defaultSettings(isMobile: boolean): TetherSyncSettings {
	return {
		remoteUrl: "",
		branch: "main",
		deviceName: "",
		authorName: "Tether Sync",
		authorEmail: "tether-sync@localhost",
		ignoreGlobs: [],
		genericUsername: "oauth2",
		gitlabSelfManagedBase: "",
		giteaSelfManagedBase: "",
		bitbucketAccountEmail: "",
		githubClientId: "",
		gitlabClientId: "",
		conflictStrategy: DEFAULT_CONFLICT_STRATEGY,
		autoMergeOverlappingEdits: false,
		autoSyncPaused: false,
		lastSyncAt: null,
		syncHistory: [],
		networkTimeoutSeconds: 30,
		verboseNetworkLogging: false,
		...defaultScheduleOptions(isMobile),
	};
}

const PROVIDER_LABELS: Record<ProviderKind, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	bitbucket: "Bitbucket (personal access token only)",
	gitea: "Gitea/Forgejo (personal access token only)",
	azuredevops: "Azure DevOps (personal access token only)",
	generic: "Generic git host (personal access token only)",
};

const STRATEGY_LABELS: Record<ConflictStrategyName, string> = {
	prBranch: "PR branch (recommended)",
	discardLocal: "Discard local changes",
	keepLocal: "Keep local & pause sync",
};

/**
 * Settings keys the declarative controls bind to. Everything else in
 * `TetherSyncSettings` is plugin state rather than a user-facing control
 * (`lastSyncAt`, `syncHistory`, `deviceName`'s generated default, ...).
 */
type BoundKey =
	| "branch"
	| "ignoreGlobs"
	| "deviceName"
	| "authorName"
	| "authorEmail"
	| "githubClientId"
	| "gitlabClientId"
	| "gitlabSelfManagedBase"
	| "giteaSelfManagedBase"
	| "bitbucketAccountEmail"
	| "genericUsername"
	| "networkTimeoutSeconds"
	| "verboseNetworkLogging"
	| "autoSyncPaused"
	| "conflictStrategy"
	| "autoMergeOverlappingEdits"
	| "syncOnStartup"
	| "syncOnForeground"
	| "intervalMinutes"
	| "debounceEditSeconds"
	| "batterySaver";

/** Text fields that fall back to a fixed value when cleared. */
const TEXT_FALLBACKS: Partial<Record<BoundKey, string>> = {
	branch: "main",
	authorName: "Tether Sync",
	authorEmail: "tether-sync@localhost",
	genericUsername: "oauth2",
};

export class TetherSyncSettingTab extends PluginSettingTab {
	/**
	 * git-crypt checklist state, since `getSettingDefinitions()` is
	 * synchronous but the checklist needs a repository scan:
	 * `undefined` = not requested yet, `null` = requested and still running or
	 * not scannable, otherwise the entries. Resolving it calls `update()`,
	 * which re-runs `getSettingDefinitions()` with the answer in hand.
	 */
	private gitCryptEntries: GitCryptKeyChecklistEntry[] | null | undefined = undefined;
	private gitCryptLoading = false;
	/** Same pattern for "is a token already saved for this host?". */
	private hasSavedToken = false;
	private tokenChecked = false;

	constructor(app: App, private readonly plugin: TetherSyncPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			// The first section deliberately carries no heading: Obsidian's
			// settings convention is that a tab's primary settings sit
			// directly under the tab title.
			...this.generalItems(),
			{ type: "group", heading: "Account", items: this.accountItems() },
			{ type: "group", heading: "Encryption (git-crypt)", items: this.encryptionItems() },
			{ type: "group", heading: "Sync", items: this.syncItems() },
			{ type: "group", heading: "Danger zone", items: this.dangerItems() },
		];
	}

	/**
	 * Reads the control's backing setting. `ignoreGlobs` is the one control
	 * whose stored shape (a string array) differs from its editor's (one
	 * pattern per line).
	 */
	getControlValue(key: string): unknown {
		if (key === "ignoreGlobs") return this.plugin.settings.ignoreGlobs.join("\n");
		return this.plugin.settings[key as keyof TetherSyncSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key as BoundKey) {
			case "ignoreGlobs":
				settings.ignoreGlobs = String(value)
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0);
				break;
			// Pausing is not just a stored flag — the scheduler has to be told,
			// so this goes through the plugin rather than writing the field.
			case "autoSyncPaused":
				await this.plugin.setAutoSyncPaused(Boolean(value));
				return;
			case "conflictStrategy": {
				const strategy = value as ConflictStrategyName;
				if (strategy === "discardLocal") {
					// Once armed, every future conflict hard-resets without
					// asking — make the user opt into that explicitly.
					this.confirmOrRevert({
						title: "Always discard local changes on conflict?",
						body:
							"With this strategy, whenever local and remote changes diverge, " +
							"the vault is automatically hard-reset to the remote WITHOUT " +
							"asking. Local edits made since the last successful sync will be " +
							"permanently lost each time.",
						cta: "Always discard on conflict",
						apply: () => {
							settings.conflictStrategy = strategy;
						},
					});
					return;
				}
				settings.conflictStrategy = strategy;
				break;
			}
			case "autoMergeOverlappingEdits": {
				if (value !== true) {
					settings.autoMergeOverlappingEdits = false;
					break;
				}
				this.confirmOrRevert({
					title: "Auto-merge overlapping edits?",
					body:
						"From now on, when two devices change the same lines of a note " +
						"before syncing, both versions are silently combined into the file " +
						"— no conflict, no PR, no notice. If that happens to a " +
						"sentence-level edit rather than a list/journal append, the note " +
						"will contain both versions back-to-back with nothing marking " +
						"which one is current.",
					cta: "Enable auto-merge",
					apply: () => {
						settings.autoMergeOverlappingEdits = true;
					},
				});
				return;
			}
			case "networkTimeoutSeconds":
				settings.networkTimeoutSeconds = nonNegative(value, 30);
				break;
			case "intervalMinutes":
				settings.intervalMinutes = Math.floor(nonNegative(value, 0));
				break;
			case "debounceEditSeconds":
				settings.debounceEditSeconds = Math.floor(nonNegative(value, 0));
				break;
			default: {
				if (typeof value === "boolean") {
					(settings as unknown as Record<string, boolean>)[key] = value;
					break;
				}
				const text = String(value).trim();
				(settings as unknown as Record<string, string>)[key] =
					text.length > 0 ? text : (TEXT_FALLBACKS[key as BoundKey] ?? "");
				break;
			}
		}
		await this.plugin.saveSettings();
	}

	/**
	 * Gates a destructive setting behind a confirmation: persists on confirm,
	 * and on cancel re-renders so the control snaps back to the value that is
	 * actually stored.
	 */
	private confirmOrRevert(opts: {
		title: string;
		body: string;
		cta: string;
		apply: () => void;
	}): void {
		new ConfirmModal(this.app, {
			title: opts.title,
			body: opts.body,
			cta: opts.cta,
			destructive: true,
			onConfirm: async () => {
				opts.apply();
				await this.plugin.saveSettings();
				this.update();
			},
			onCancel: () => this.update(),
		}).open();
	}

	// -- General ------------------------------------------------------------

	private generalItems(): SettingDefinitionItem[] {
		return [
			{
				name: "Remote repository",
				desc:
					this.plugin.settings.remoteUrl.length > 0
						? this.plugin.settings.remoteUrl
						: "Not configured — run the setup wizard.",
				render: (setting: Setting) => {
					setting.addButton((btn) =>
						btn.setButtonText("Setup wizard").onClick(() => {
							new SetupWizardModal(this.app, this.plugin, () => this.update()).open();
						})
					);
				},
			},
			{
				name: "Branch",
				desc: "The branch this vault syncs with.",
				control: { type: "text", key: "branch" },
			},
			{
				name: "Ignore patterns",
				desc:
					"Files/folders to exclude from sync, one per line — in addition to " +
					`the built-in ${this.app.vault.configDir}/workspace*, .trash/, and ` +
					"this plugin's own data.json. 'dir/' matches a folder and everything " +
					"under it, '*.ext' a suffix, 'prefix*' a prefix, anything else a " +
					"plain prefix match.",
				control: {
					type: "textarea",
					key: "ignoreGlobs",
					rows: 4,
					placeholder: "attachments/large/\n*.psd",
				},
			},
			{
				name: "Device name",
				desc: "Names conflict branches created by this device.",
				control: { type: "text", key: "deviceName" },
			},
			{ name: "Commit author name", control: { type: "text", key: "authorName" } },
			{ name: "Commit author email", control: { type: "text", key: "authorEmail" } },
		];
	}

	// -- Account ------------------------------------------------------------

	private detectKind(): ProviderKind | null {
		try {
			return detectProvider(
				this.plugin.settings.remoteUrl,
				this.plugin.settings.gitlabSelfManagedBase,
				this.plugin.settings.giteaSelfManagedBase
			);
		} catch {
			return null;
		}
	}

	private accountItems(): SettingGroupItem[] {
		const kind = this.detectKind();
		const providerDesc =
			kind === null ? "No valid remote URL configured yet." : PROVIDER_LABELS[kind];
		const renderers = this.tokenRenderers();

		const items: SettingGroupItem[] = [];

		if (this.plugin.secretStore.insecure) {
			items.push({
				name: "No secure secret storage",
				desc:
					"This Obsidian version has no secure secret storage. Tokens will be " +
					"saved in plain text inside the plugin's data.json. Prefer a token " +
					"with the narrowest possible scope.",
				render: (setting: Setting) => {
					setting.settingEl.addClass("tether-sync-warning-banner");
				},
			});
		}

		items.push({ name: "Provider", desc: `Detected from the remote URL: ${providerDesc}` });

		if (renderers.deviceFlow !== null) {
			items.push({ name: "Sign in", render: renderers.deviceFlow });
		}

		items.push(
			{
				// Renamed once the async probe confirms a token is already
				// stored — see `tokenRenderers`.
				name: this.hasSavedToken ? "Personal access token (saved)" : "Personal access token",
				render: (setting: Setting) => {
					renderers.patLabel(setting);
					if (this.hasSavedToken) {
						setting.setName("Personal access token (saved)");
						setting.addButton((btn) =>
							btn.setButtonText("Clear").setDestructive().onClick(async () => {
								await this.plugin.clearToken();
								this.hasSavedToken = false;
								this.update();
							})
						);
					}
				},
			},
			{ name: "Token", searchable: false, render: renderers.patInput },
			{ name: "Save token", searchable: false, render: renderers.patButtons },
			{
				// A sub-page rather than an inline group: a group cannot nest
				// inside another group's items, and these rows (client-ID
				// overrides, self-managed base URLs, network tuning) are the
				// ones a typical vault never touches — the same reason they
				// used to sit behind a collapsible.
				type: "page",
				name: "Advanced",
				desc: "OAuth client IDs, self-managed hosts, and network tuning.",
				items: this.advancedAccountItems(),
			}
		);

		return items;
	}

	/**
	 * Builds the shared token rows and, the first time through, kicks off the
	 * "is a token already saved for this host?" probe — resolving it calls
	 * `update()`, which re-renders the rows with the answer.
	 */
	private tokenRenderers(): TokenSettingRenderers {
		const renderers = createTokenSettingRenderers({
			app: this.app,
			plugin: this.plugin,
			provider: this.plugin.getProvider(),
			saveButtonText: "Save",
			onSaved: () => {
				this.tokenChecked = false;
				this.update();
			},
			onError: (message) => new Notice(`Tether Sync: ${message}`),
		});
		if (!this.tokenChecked) {
			this.tokenChecked = true;
			renderers.checkExisting(() => {
				this.hasSavedToken = true;
				this.update();
			});
		}
		return renderers;
	}

	private advancedAccountItems(): SettingGroupItem[] {
		return [
			{
				name: "GitHub OAuth client ID",
				desc:
					"Override the built-in client ID. Leave empty to use the default; " +
					"device-flow sign-in is hidden when no ID is configured.",
				control: { type: "text", key: "githubClientId" },
			},
			{
				name: "GitLab OAuth application ID",
				desc: "Same as above, for GitLab.",
				control: { type: "text", key: "gitlabClientId" },
			},
			{
				name: "Self-managed GitLab URL",
				desc:
					"If your remote is a self-managed GitLab instance, enter its base URL " +
					"(e.g. https://gitlab.example.com) so it is treated as GitLab.",
				control: { type: "text", key: "gitlabSelfManagedBase" },
			},
			{
				name: "Self-managed Gitea/Forgejo URL",
				desc:
					"If your remote is a self-hosted Gitea, Forgejo, or Codeberg-like " +
					"instance, enter its base URL (e.g. https://git.example.com) so it " +
					"is treated as Gitea/Forgejo.",
				control: { type: "text", key: "giteaSelfManagedBase" },
			},
			{
				name: "Bitbucket account email",
				desc:
					"Your Atlassian account email. Bitbucket's REST API needs it " +
					"(alongside the API token) to open pull requests on conflict — git " +
					"sync itself doesn't need this.",
				control: {
					type: "text",
					key: "bitbucketAccountEmail",
					placeholder: "you@example.com",
				},
			},
			{
				name: "Token username (generic hosts)",
				desc: "Username sent alongside the token on generic git hosts.",
				control: { type: "text", key: "genericUsername", placeholder: "oauth2" },
			},
			{
				name: "Network request timeout (seconds)",
				desc:
					"Every git/API request gives up after this long and reports a clear " +
					'timeout error instead of hanging indefinitely — the fix for "syncing" ' +
					"getting stuck forever behind a proxy or firewall that silently drops " +
					"connections rather than rejecting them (e.g. some corporate TLS-" +
					"inspecting proxies). Takes effect on the next request, no restart " +
					"needed. 0 disables the timeout.",
				control: { type: "number", key: "networkTimeoutSeconds", min: 0 },
			},
			{
				name: "Verbose network logging",
				desc:
					"Logs each git/API request's URL, method, status, and duration to the " +
					"developer console (Ctrl+Shift+I, or Cmd+Option+I on macOS) — never " +
					"headers or bodies, so tokens are never logged. Useful for narrowing " +
					"down where a hang or connection failure is actually happening.",
				control: { type: "toggle", key: "verboseNetworkLogging" },
			},
		];
	}

	// -- Encryption (git-crypt) ----------------------------------------------

	private encryptionItems(): SettingGroupItem[] {
		return [
			{
				name: "About git-crypt support",
				desc:
					"Only relevant if the remote repository uses git-crypt. Tether Sync " +
					"can run git-crypt's clean/smudge filter natively — including " +
					"per-subtree NAMED keys, not just the default key — once every key " +
					"the repository references is imported below. A repository is " +
					"'locked' (auto-sync paused) as long as even one referenced key is " +
					"still missing, even if other paths use a key you already have.",
			},
			...this.gitCryptChecklistItems(),
		];
	}

	/**
	 * One row per git-crypt-family key name the connected repository declares
	 * (default + named — see `GitCryptKeyChecklistEntry`), each showing its
	 * import status and either a "Clear" or an "Import key file…" action.
	 *
	 * The scan is asynchronous while `getSettingDefinitions()` is not, so the
	 * first call renders a placeholder row and requests the scan; its result
	 * is cached and `update()` re-renders this group with the real rows.
	 */
	private gitCryptChecklistItems(): SettingGroupItem[] {
		if (this.gitCryptEntries === undefined) {
			if (!this.gitCryptLoading) {
				this.gitCryptLoading = true;
				void this.plugin.gitCryptChecklist().then((entries) => {
					this.gitCryptEntries = entries;
					this.gitCryptLoading = false;
					this.update();
				});
			}
			return [{ name: "Checking which git-crypt keys this repository needs…" }];
		}

		if (this.gitCryptEntries === null) {
			return [
				{
					name: "Not connected yet",
					desc:
						"The repository's gitattributes can't be scanned yet — finish the " +
						"setup wizard's clone/initialize step first. This section will show " +
						"every git-crypt key the repository needs once it can.",
				},
			];
		}

		if (this.gitCryptEntries.length === 0) {
			return [{ name: "This repository does not use git-crypt." }];
		}

		return this.gitCryptEntries.map((entry) => this.gitCryptChecklistItem(entry));
	}

	private gitCryptChecklistItem(entry: GitCryptKeyChecklistEntry): SettingGroupItem {
		const label = entry.keyName === "" ? "Default key" : `Named key: ${entry.keyName}`;
		return {
			name: `${entry.configured ? "✓" : "✗"} ${label}`,
			desc: entry.configured
				? "Configured on this device."
				: "Not imported on this device yet — syncing is paused until every " +
					"referenced key (this one included) is imported.",
			render: (setting: Setting) => {
				if (entry.configured) {
					setting.addButton((btn) =>
						btn.setButtonText("Clear").setDestructive().onClick(async () => {
							await this.plugin.clearGitCryptKey(entry.keyName);
							this.refreshGitCryptChecklist();
						})
					);
					return;
				}
				attachGitCryptKeyImportButton(setting, {
					container: setting.settingEl,
					plugin: this.plugin,
					onImported: () => {
						new Notice("Tether Sync: git-crypt key imported");
						this.refreshGitCryptChecklist();
					},
					onError: (message) => new Notice(`Tether Sync: ${message}`),
				});
			},
		};
	}

	/** Drops the cached scan so the next render re-runs it. */
	private refreshGitCryptChecklist(): void {
		this.gitCryptEntries = undefined;
		this.update();
	}

	// -- Sync ---------------------------------------------------------------

	private syncItems(): SettingGroupItem[] {
		const items: SettingGroupItem[] = [
			{
				name: "Auto-sync paused",
				desc:
					"Pause automatic syncing (startup, foreground, interval, and " +
					"post-edit triggers). Manual sync via the command palette or " +
					"status bar still works.",
				control: { type: "toggle", key: "autoSyncPaused" },
			},
			{
				name: "On conflict",
				desc:
					"What happens when local and remote changes diverge. The default " +
					"(PR branch) pushes your local changes to a separate branch and " +
					"opens a pull request, then follows the remote — nothing is ever " +
					"lost, and you merge at your leisure.",
				control: {
					type: "dropdown",
					key: "conflictStrategy",
					options: STRATEGY_LABELS,
				},
			},
			{
				name: "Auto-merge overlapping edits (advanced)",
				desc:
					"When two devices edit the SAME lines of a note before syncing, " +
					"don't treat it as a conflict at all — silently concatenate both " +
					"versions into the file instead of running the 'On conflict' " +
					"strategy above. Good for append-only content (lists, journals); " +
					"for a sentence-level edit, the note ends up containing both " +
					"versions back-to-back with nothing marking which is current. " +
					"Off by default — most vaults are better served by the PR-branch " +
					"conflict flow above, which always tells you when this happened.",
				control: { type: "toggle", key: "autoMergeOverlappingEdits" },
			},
			{ name: "Sync on startup", control: { type: "toggle", key: "syncOnStartup" } },
			{
				name: "Sync when app returns to foreground",
				desc: "The main mobile trigger — fires when you switch back to Obsidian.",
				control: { type: "toggle", key: "syncOnForeground" },
			},
			{
				name: "Sync interval (minutes)",
				desc: "Periodic sync while the app is open. 0 disables the interval.",
				control: { type: "number", key: "intervalMinutes", min: 0 },
			},
			{
				name: "Sync after edits (seconds)",
				desc: "Debounced sync after you stop editing. 0 disables it.",
				control: { type: "number", key: "debounceEditSeconds", min: 0 },
			},
		];

		if (this.plugin.isMobile) {
			items.push(
				{
					name: "Battery saver",
					desc: "Disables the periodic interval; syncs only on startup and foreground.",
					control: { type: "toggle", key: "batterySaver" },
				},
				{
					name: "Battery note",
					desc:
						"The interval only ticks while Obsidian is in the foreground " +
						"(mobile OSes suspend background apps), and a no-op check costs " +
						"about one small HTTPS request. Radio wakeups dominate battery " +
						"cost, so the recommended mobile pattern is sync on startup + " +
						"foreground with a long interval — not tight polling.",
				}
			);
		}

		return items;
	}

	// -- Danger zone ---------------------------------------------------------

	private dangerItems(): SettingGroupItem[] {
		return [
			{
				name: "Re-clone vault",
				desc:
					"Deletes the local git history and clones the remote again. Local " +
					"changes that were never synced will be lost.",
				render: (setting: Setting) => {
					setting.addButton((btn) =>
						btn.setButtonText("Re-clone…").setDestructive().onClick(() => {
							new ConfirmModal(this.app, {
								title: "Re-clone vault?",
								body:
									"This deletes the local .git history and re-downloads the " +
									"repository. Any local changes not yet synced will be " +
									"overwritten by the remote version. Continue?",
								cta: "Re-clone",
								destructive: true,
								onConfirm: async () => {
									await this.plugin.recloneVault();
								},
							}).open();
						})
					);
				},
			},
			{
				name: "Discard local changes",
				desc: "Hard-resets the vault to the remote branch.",
				render: (setting: Setting) => {
					setting.addButton((btn) =>
						btn.setButtonText("Discard…").setDestructive().onClick(() => {
							new ConfirmModal(this.app, {
								title: "Discard local changes?",
								body:
									"This fetches the remote branch and hard-resets the vault to " +
									"it. All local commits and uncommitted edits that are not on " +
									"the remote will be permanently lost. Continue?",
								cta: "Discard local changes",
								destructive: true,
								onConfirm: async () => {
									await this.plugin.discardLocalChanges();
								},
							}).open();
						})
					);
				},
			},
		];
	}
}

/** Parses a numeric control's value, falling back when it isn't usable. */
function nonNegative(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
