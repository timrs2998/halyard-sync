/**
 * Settings model + settings tab UI.
 *
 * The model is pure data (defaults derived from platform); the tab renders
 * four sections: General, Account, Sync, Danger zone. Tokens are NEVER part
 * of this model — they live in SecretStore (see auth/secrets.ts).
 */

import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import { detectProvider, type ProviderKind } from "./auth/providers";
import {
	DEFAULT_CONFLICT_STRATEGY,
	type ConflictStrategyName,
} from "./sync/conflicts";
import type { SyncHistoryEntry } from "./sync/orchestrator";
import { defaultScheduleOptions, type ScheduleOptions } from "./sync/scheduler";
import type { GitCryptKeyChecklistEntry } from "./git/engine";
import { attachGitCryptKeyImportButton, ConfirmModal, SetupWizardModal, renderTokenSetting } from "./ui/modals";
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

export class TetherSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: TetherSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.renderGeneral(containerEl);
		this.renderAccount(containerEl);
		this.renderEncryption(containerEl);
		this.renderSync(containerEl);
		this.renderDanger(containerEl);
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
	}

	// -- General ------------------------------------------------------------

	private renderGeneral(el: HTMLElement): void {
		new Setting(el).setName("General").setHeading();

		new Setting(el)
			.setName("Remote repository")
			.setDesc(
				this.plugin.settings.remoteUrl.length > 0
					? this.plugin.settings.remoteUrl
					: "Not configured — run the setup wizard."
			)
			.addButton((btn) =>
				btn.setButtonText("Setup wizard").onClick(() => {
					new SetupWizardModal(this.app, this.plugin, () => this.display()).open();
				})
			);

		new Setting(el)
			.setName("Branch")
			.setDesc("The branch this vault syncs with.")
			.addText((text) =>
				text.setValue(this.plugin.settings.branch).onChange(async (value) => {
					this.plugin.settings.branch = value.trim() || "main";
					await this.save();
				})
			);

		new Setting(el)
			.setName("Ignore patterns")
			.setDesc(
				"Files/folders to exclude from sync, one per line — in addition to " +
					"the built-in .obsidian/workspace*, .trash/, and this plugin's own " +
					"data.json. 'dir/' matches a folder and everything under it, " +
					"'*.ext' a suffix, 'prefix*' a prefix, anything else a plain prefix " +
					"match."
			)
			.addTextArea((textarea) => {
				textarea
					.setValue(this.plugin.settings.ignoreGlobs.join("\n"))
					.setPlaceholder("attachments/large/\n*.psd")
					.onChange(async (value) => {
						this.plugin.settings.ignoreGlobs = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						await this.save();
					});
				textarea.inputEl.rows = 4;
			});

		new Setting(el)
			.setName("Device name")
			.setDesc("Names conflict branches created by this device.")
			.addText((text) =>
				text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
					this.plugin.settings.deviceName = value.trim();
					await this.save();
				})
			);

		new Setting(el)
			.setName("Commit author name")
			.addText((text) =>
				text.setValue(this.plugin.settings.authorName).onChange(async (value) => {
					this.plugin.settings.authorName = value.trim() || "Tether Sync";
					await this.save();
				})
			);

		new Setting(el)
			.setName("Commit author email")
			.addText((text) =>
				text.setValue(this.plugin.settings.authorEmail).onChange(async (value) => {
					this.plugin.settings.authorEmail =
						value.trim() || "tether-sync@localhost";
					await this.save();
				})
			);
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

	private renderAccount(el: HTMLElement): void {
		new Setting(el).setName("Account").setHeading();

		if (this.plugin.secretStore.insecure) {
			const warning = el.createDiv({
				cls: "callout mod-warning tether-sync-warning-banner",
			});
			warning.setText(
				"Warning: this Obsidian version has no secure secret storage. " +
					"Tokens will be saved in plain text inside the plugin's data.json. " +
					"Prefer a token with the narrowest possible scope."
			);
		}

		const kind = this.detectKind();
		const provider = this.plugin.getProvider();
		const providerDesc =
			kind === null ? "No valid remote URL configured yet." : PROVIDER_LABELS[kind];

		new Setting(el)
			.setName("Provider")
			.setDesc(`Detected from the remote URL: ${providerDesc}`);

		const { patSetting, checkExisting } = renderTokenSetting({
			container: el,
			app: this.app,
			plugin: this.plugin,
			provider,
			saveButtonText: "Save",
			onSaved: () => this.display(),
			onError: (message) => new Notice(`Tether Sync: ${message}`),
		});
		checkExisting(() => {
			patSetting.setName("Personal access token (saved)");
			patSetting.addButton((btn) =>
				btn.setButtonText("Clear").setWarning().onClick(async () => {
					await this.plugin.clearToken();
					this.display();
				})
			);
		});

		// Advanced (client-id overrides etc.) in a collapsible.
		const details = el.createEl("details");
		details.createEl("summary", { text: "Advanced" });

		new Setting(details)
			.setName("GitHub OAuth client ID")
			.setDesc(
				"Override the built-in client ID. Leave empty to use the default; " +
					"device-flow sign-in is hidden when no ID is configured."
			)
			.addText((text) =>
				text.setValue(this.plugin.settings.githubClientId).onChange(async (value) => {
					this.plugin.settings.githubClientId = value.trim();
					await this.save();
				})
			);

		new Setting(details)
			.setName("GitLab OAuth application ID")
			.setDesc("Same as above, for GitLab.")
			.addText((text) =>
				text.setValue(this.plugin.settings.gitlabClientId).onChange(async (value) => {
					this.plugin.settings.gitlabClientId = value.trim();
					await this.save();
				})
			);

		new Setting(details)
			.setName("Self-managed GitLab URL")
			.setDesc(
				"If your remote is a self-managed GitLab instance, enter its base URL " +
					"(e.g. https://gitlab.example.com) so it is treated as GitLab."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.gitlabSelfManagedBase)
					.onChange(async (value) => {
						this.plugin.settings.gitlabSelfManagedBase = value.trim();
						await this.save();
					})
			);

		new Setting(details)
			.setName("Self-managed Gitea/Forgejo URL")
			.setDesc(
				"If your remote is a self-hosted Gitea, Forgejo, or Codeberg-like " +
					"instance, enter its base URL (e.g. https://git.example.com) so it " +
					"is treated as Gitea/Forgejo."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.giteaSelfManagedBase)
					.onChange(async (value) => {
						this.plugin.settings.giteaSelfManagedBase = value.trim();
						await this.save();
					})
			);

		new Setting(details)
			.setName("Bitbucket account email")
			.setDesc(
				"Your Atlassian account email. Bitbucket's REST API needs it " +
					"(alongside the API token) to open pull requests on conflict — git " +
					"sync itself doesn't need this."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.bitbucketAccountEmail)
					.setPlaceholder("you@example.com")
					.onChange(async (value) => {
						this.plugin.settings.bitbucketAccountEmail = value.trim();
						await this.save();
					})
			);

		new Setting(details)
			.setName("Token username (generic hosts)")
			.setDesc("Username sent alongside the token on generic git hosts.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.genericUsername)
					.setPlaceholder("oauth2")
					.onChange(async (value) => {
						this.plugin.settings.genericUsername = value.trim() || "oauth2";
						await this.save();
					})
			);

		new Setting(details)
			.setName("Network request timeout (seconds)")
			.setDesc(
				"Every git/API request gives up after this long and reports a clear " +
					"timeout error instead of hanging indefinitely — the fix for \"syncing\" " +
					"getting stuck forever behind a proxy or firewall that silently drops " +
					"connections rather than rejecting them (e.g. some corporate TLS-" +
					"inspecting proxies). Takes effect on the next request, no restart " +
					"needed. 0 disables the timeout."
			)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.networkTimeoutSeconds))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.networkTimeoutSeconds =
							Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
						await this.save();
					})
			);

		new Setting(details)
			.setName("Verbose network logging")
			.setDesc(
				"Logs each git/API request's URL, method, status, and duration to the " +
					"developer console (Ctrl+Shift+I, or Cmd+Option+I on macOS) — never " +
					"headers or bodies, so tokens are never logged. Useful for narrowing " +
					"down where a hang or connection failure is actually happening."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.verboseNetworkLogging).onChange(async (value) => {
					this.plugin.settings.verboseNetworkLogging = value;
					await this.save();
				})
			);
	}

	// -- Encryption (git-crypt) -----------------------------------------------

	private renderEncryption(el: HTMLElement): void {
		new Setting(el).setName("Encryption (git-crypt)").setHeading();

		el.createEl("p", {
			cls: "setting-item-description",
			text:
				"Only relevant if the remote repository uses git-crypt. Tether Sync " +
				"can run git-crypt's clean/smudge filter natively — including " +
				"per-subtree NAMED keys, not just the default key — once every key " +
				"the repository references is imported below. A repository is " +
				"'locked' (auto-sync paused) as long as even one referenced key is " +
				"still missing, even if other paths use a key you already have.",
		});

		const checklistEl = el.createDiv({ cls: "tether-sync-gitcrypt-checklist" });
		this.renderGitCryptChecklist(checklistEl);
	}

	/**
	 * One row per git-crypt-family key name the connected repository
	 * declares (default + named — see `GitCryptKeyChecklistEntry`), each
	 * showing its import status and either a "Clear" or an "Import key
	 * file…" action. Re-renders just this sub-tree (not the whole tab) on
	 * every state change, so unrelated sections (e.g. the "Advanced"
	 * `<details>` in Account) don't lose their open/closed state.
	 */
	private renderGitCryptChecklist(container: HTMLElement): void {
		container.empty();
		const loadingEl = container.createEl("p", {
			cls: "setting-item-description",
			text: "Checking which git-crypt keys this repository needs…",
		});
		void this.plugin.gitCryptChecklist().then((entries) => {
			loadingEl.remove();
			if (entries === null) {
				container.createEl("p", {
					cls: "setting-item-description",
					text:
						"Not connected yet, or the repository's gitattributes can't be " +
						"scanned yet — finish the setup wizard's clone/initialize step " +
						"first. This section will show every git-crypt key the " +
						"repository needs once it can.",
				});
				return;
			}
			if (entries.length === 0) {
				container.createEl("p", {
					cls: "setting-item-description",
					text: "This repository does not use git-crypt.",
				});
				return;
			}
			for (const entry of entries) {
				this.renderGitCryptChecklistRow(container, entry);
			}
		});
	}

	private renderGitCryptChecklistRow(container: HTMLElement, entry: GitCryptKeyChecklistEntry): void {
		const label = entry.keyName === "" ? "Default key" : `Named key: ${entry.keyName}`;
		const setting = new Setting(container)
			.setName(`${entry.configured ? "✓" : "✗"} ${label}`)
			.setDesc(
				entry.configured
					? "Configured on this device."
					: "Not imported on this device yet — syncing is paused until every " +
						"referenced key (this one included) is imported."
			);
		if (entry.configured) {
			setting.addButton((btn) =>
				btn.setButtonText("Clear").setWarning().onClick(async () => {
					await this.plugin.clearGitCryptKey(entry.keyName);
					this.renderGitCryptChecklist(container);
				})
			);
			return;
		}
		attachGitCryptKeyImportButton(setting, {
			container,
			plugin: this.plugin,
			onImported: () => {
				new Notice("Tether Sync: git-crypt key imported");
				this.renderGitCryptChecklist(container);
			},
			onError: (message) => new Notice(`Tether Sync: ${message}`),
		});
	}

	// -- Sync ---------------------------------------------------------------

	private renderSync(el: HTMLElement): void {
		new Setting(el).setName("Sync").setHeading();

		new Setting(el)
			.setName("Auto-sync paused")
			.setDesc(
				"Pause automatic syncing (startup, foreground, interval, and " +
					"post-edit triggers). Manual sync via the command palette or " +
					"status bar still works."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncPaused).onChange(async (value) => {
					await this.plugin.setAutoSyncPaused(value);
				})
			);

		new Setting(el)
			.setName("On conflict")
			.setDesc(
				"What happens when local and remote changes diverge. The default " +
					"(PR branch) pushes your local changes to a separate branch and " +
					"opens a pull request, then follows the remote — nothing is ever " +
					"lost, and you merge at your leisure."
			)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(STRATEGY_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value) => {
						const strategy = value as ConflictStrategyName;
						if (strategy === "discardLocal") {
							// Once armed, every future conflict hard-resets without
							// asking — make the user opt into that explicitly.
							new ConfirmModal(this.app, {
								title: "Always discard local changes on conflict?",
								body:
									"With this strategy, whenever local and remote changes " +
									"diverge, the vault is automatically hard-reset to the " +
									"remote WITHOUT asking. Local edits made since the last " +
									"successful sync will be permanently lost each time.",
								cta: "Always discard on conflict",
								destructive: true,
								onConfirm: async () => {
									this.plugin.settings.conflictStrategy = strategy;
									await this.save();
								},
								onCancel: () => {
									dropdown.setValue(this.plugin.settings.conflictStrategy);
								},
							}).open();
							return;
						}
						this.plugin.settings.conflictStrategy = strategy;
						await this.save();
					});
			});

		new Setting(el)
			.setName("Auto-merge overlapping edits (advanced)")
			.setDesc(
				"When two devices edit the SAME lines of a note before syncing, " +
					"don't treat it as a conflict at all — silently concatenate both " +
					"versions into the file instead of running the 'On conflict' " +
					"strategy above. Good for append-only content (lists, journals); " +
					"for a sentence-level edit, the note ends up containing both " +
					"versions back-to-back with nothing marking which is current. " +
					"Off by default — most vaults are better served by the PR-branch " +
					"conflict flow above, which always tells you when this happened."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoMergeOverlappingEdits)
					.onChange(async (value) => {
						if (!value) {
							this.plugin.settings.autoMergeOverlappingEdits = false;
							await this.save();
							return;
						}
						new ConfirmModal(this.app, {
							title: "Auto-merge overlapping edits?",
							body:
								"From now on, when two devices change the same lines of a " +
								"note before syncing, both versions are silently combined " +
								"into the file — no conflict, no PR, no notice. If that " +
								"happens to a sentence-level edit rather than a list/journal " +
								"append, the note will contain both versions back-to-back " +
								"with nothing marking which one is current.",
							cta: "Enable auto-merge",
							destructive: true,
							onConfirm: async () => {
								this.plugin.settings.autoMergeOverlappingEdits = true;
								await this.save();
							},
							onCancel: () => {
								toggle.setValue(false);
							},
						}).open();
					})
			);

		new Setting(el)
			.setName("Sync on startup")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.save();
				})
			);

		new Setting(el)
			.setName("Sync when app returns to foreground")
			.setDesc("The main mobile trigger — fires when you switch back to Obsidian.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnForeground)
					.onChange(async (value) => {
						this.plugin.settings.syncOnForeground = value;
						await this.save();
					})
			);

		new Setting(el)
			.setName("Sync interval (minutes)")
			.setDesc("Periodic sync while the app is open. 0 disables the interval.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.intervalMinutes))
					.onChange(async (value) => {
						const minutes = Number(value);
						this.plugin.settings.intervalMinutes =
							Number.isFinite(minutes) && minutes >= 0 ? Math.floor(minutes) : 0;
						await this.save();
					})
			);

		new Setting(el)
			.setName("Sync after edits (seconds)")
			.setDesc("Debounced sync after you stop editing. 0 disables it.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.debounceEditSeconds))
					.onChange(async (value) => {
						const seconds = Number(value);
						this.plugin.settings.debounceEditSeconds =
							Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
						await this.save();
					})
			);

		if (this.plugin.isMobile) {
			new Setting(el)
				.setName("Battery saver")
				.setDesc("Disables the periodic interval; syncs only on startup and foreground.")
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.batterySaver).onChange(async (value) => {
						this.plugin.settings.batterySaver = value;
						await this.save();
					})
				);

			const note = el.createEl("p", { cls: "setting-item-description" });
			note.setText(
				"Battery note: the interval only ticks while Obsidian is in the " +
					"foreground (mobile OSes suspend background apps), and a no-op " +
					"check costs about one small HTTPS request. Radio wakeups dominate " +
					"battery cost, so the recommended mobile pattern is sync on " +
					"startup + foreground with a long interval — not tight polling."
			);
		}
	}

	// -- Danger zone ---------------------------------------------------------

	private renderDanger(el: HTMLElement): void {
		new Setting(el).setName("Danger zone").setHeading();

		new Setting(el)
			.setName("Re-clone vault")
			.setDesc(
				"Deletes the local git history and clones the remote again. Local " +
					"changes that were never synced will be lost."
			)
			.addButton((btn) =>
				btn.setButtonText("Re-clone…").setWarning().onClick(() => {
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

		new Setting(el)
			.setName("Discard local changes")
			.setDesc("Hard-resets the vault to the remote branch.")
			.addButton((btn) =>
				btn.setButtonText("Discard…").setWarning().onClick(() => {
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
	}
}
