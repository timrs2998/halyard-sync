/**
 * Modals: generic confirmation, OAuth device-code, conflict resolution, and
 * the first-run setup wizard.
 */

import { Modal, Notice, Setting, type App } from "obsidian";
import {
	detectProvider,
	normalizeRemoteUrl,
	type ForgeProvider,
	type ProviderKind,
} from "../auth/providers";
import { describeConflictFile, describeGitError, type ConflictFileStat } from "../git/engine";
import { MAX_CONFLICT_FILES_SHOWN, type ConflictStrategyName } from "../sync/conflicts";
import type { SyncHistoryEntry } from "../sync/orchestrator";
import { HISTORY_OUTCOME_LABELS } from "./history-format";
import { formatRelativeTime } from "./statusbar";
import type TetherSyncPlugin from "../main";

const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	bitbucket: "Bitbucket",
	gitea: "a Gitea/Forgejo host",
	azuredevops: "Azure DevOps",
	generic: "a generic git host",
};

// ---------------------------------------------------------------------------
// Shared token-entry UI (setup wizard's auth step + settings tab's Account
// section render the identical device-flow-button + PAT-field pattern; this
// used to be copy-pasted in both places, which is exactly how the same
// silent-failure bug once had to be fixed twice).
// ---------------------------------------------------------------------------

export interface TokenSettingOptions {
	container: HTMLElement;
	app: App;
	plugin: TetherSyncPlugin;
	provider: ForgeProvider | null;
	saveButtonText: string;
	/** Called after the token is saved successfully (device flow or PAT). */
	onSaved: () => void;
	/** Called instead of throwing — caller decides how to surface it (inline text, Notice, ...). */
	onError: (message: string) => void;
}

export interface TokenSettingHandle {
	/** The PAT field's Setting, in case the caller wants to further decorate it (e.g. rename, add a Clear button). */
	patSetting: Setting;
	/** Fires the callback if a token is already saved for the current host. */
	checkExisting(onHasToken: () => void): void;
}

export function renderTokenSetting(opts: TokenSettingOptions): TokenSettingHandle {
	const { container, app, plugin, provider } = opts;

	if (provider !== null && provider.deviceFlowSupported) {
		new Setting(container)
			.setName(`Sign in with ${provider.label}`)
			.setDesc("Opens a one-time device code you confirm in the browser.")
			.addButton((btn) =>
				btn.setButtonText("Sign in").setCta().onClick(() => {
					new DeviceCodeModal(app, provider, async (token) => {
						try {
							await plugin.setToken(token);
						} catch (err) {
							opts.onError(`Couldn't save token: ${describeGitError(err)}`);
							return;
						}
						opts.onSaved();
					}).open();
				})
			);
	}

	// Three separate rows, not one: a single row carrying the text field AND
	// up to two buttons squeezed every control into one narrow modal's worth
	// of horizontal space (visibly cramped in a 3-4 column modal). The label
	// row stays its own `Setting` (callers rename it, e.g. settings.ts's
	// "(saved)" suffix) so splitting the controls out doesn't change that
	// contract.
	let patValue = "";
	const patSetting = new Setting(container).setName("Personal access token").setDesc(
		provider !== null
			? provider.patInstructions
			: "Paste an access token with repository read/write permission."
	);

	new Setting(container).addText((text) => {
		text.inputEl.type = "password";
		text.inputEl.addClass("tether-sync-wide-input");
		text.setPlaceholder("Paste token…").onChange((value) => {
			patValue = value.trim();
		});
	});

	const patButtonsSetting = new Setting(container);
	if (provider !== null && provider.patUrl !== undefined) {
		const patUrl = provider.patUrl;
		patButtonsSetting.addButton((btn) =>
			btn
				.setButtonText(`Open ${provider.label} token page`)
				.setTooltip("Opens in your browser")
				.onClick(() => window.open(patUrl, "_blank"))
		);
	}
	patButtonsSetting.addButton((btn) => {
		btn.setButtonText(opts.saveButtonText).onClick(async () => {
			if (patValue.length === 0) {
				opts.onError("Paste a token first.");
				return;
			}
			try {
				await plugin.setToken(patValue);
			} catch (err) {
				opts.onError(`Couldn't save token: ${describeGitError(err)}`);
				return;
			}
			opts.onSaved();
		});
		// A malformed remote URL has no token-storage host to save under —
		// don't let the UI pretend saving would work.
		btn.setDisabled(provider === null);
	});

	return {
		patSetting,
		checkExisting: (onHasToken) => {
			void plugin.hasToken().then((has) => {
				if (has) onHasToken();
			});
		},
	};
}

// ---------------------------------------------------------------------------
// git-crypt key import (settings' Encryption section) — one row per
// git-crypt-family key name the repo declares (default + named, see
// `GitCryptKeyChecklistEntry` in `git/engine.ts`), each with its own import
// action wired to THIS row's `Setting` by `attachGitCryptKeyImportButton`.
// ---------------------------------------------------------------------------

export interface GitCryptKeyImportOptions {
	/** Where the hidden `<input type="file">` is attached — any element that
	 * outlives the click (the row's own container is fine; it's invisible). */
	container: HTMLElement;
	plugin: TetherSyncPlugin;
	/** Called after a key file is successfully parsed and stored. */
	onImported: () => void;
	/** Called instead of throwing — same convention as `renderTokenSetting`. */
	onError: (message: string) => void;
}

/**
 * Wires an "Import key file…" button onto an EXISTING `Setting` row via a
 * hidden `<input type="file">` — Obsidian has no higher-level "pick a file
 * from disk" API, and a git-crypt key file is a binary export
 * (`git-crypt export-key [-k <name>] <path>`, see `git/gitcrypt.ts`'s
 * `parseKeyFile` doc comment for the exact format) the user already has
 * sitting on disk from unlocking the repo on some other machine.
 *
 * Deliberately does NOT ask which key name the imported file is for: the
 * button can be attached to any row (e.g. the settings checklist's row for a
 * specific missing name), but `plugin.importGitCryptKey` always routes the
 * file to the slot its OWN embedded key name says it belongs to — clicking
 * the wrong row's button with the right file still ends up in the right
 * place. There is nothing to "detect an existing token" the way
 * `renderTokenSetting` does for an OAuth device flow, since a key can only
 * ever be imported this way.
 */
export function attachGitCryptKeyImportButton(setting: Setting, opts: GitCryptKeyImportOptions): void {
	const { container, plugin } = opts;

	const fileInput = container.createEl("input", { type: "file", cls: "tether-sync-hidden-file-input" });
	fileInput.addEventListener("change", () => {
		void (async () => {
			const file = fileInput.files?.[0];
			if (!file) return;
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				await plugin.importGitCryptKey(bytes);
				opts.onImported();
			} catch (err) {
				opts.onError(err instanceof Error ? err.message : String(err));
			} finally {
				fileInput.value = "";
			}
		})();
	});

	setting.addButton((btn) =>
		btn.setButtonText("Import key file…").onClick(() => fileInput.click())
	);
}

// ---------------------------------------------------------------------------
// ConfirmModal
// ---------------------------------------------------------------------------

export interface ConfirmModalOptions {
	title: string;
	body: string;
	cta: string;
	destructive?: boolean;
	onConfirm: () => void | Promise<void>;
	/** Runs when the modal is dismissed without confirming (Cancel or click-away). */
	onCancel?: () => void;
}

export class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(app: App, private readonly opts: ConfirmModalOptions) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		this.contentEl.createEl("p", { text: this.opts.body });
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) => {
				btn.setButtonText(this.opts.cta).onClick(async () => {
					this.confirmed = true;
					this.close();
					try {
						await this.opts.onConfirm();
					} catch (err) {
						new Notice(
							`Tether Sync: ${err instanceof Error ? err.message : String(err)}`
						);
					}
				});
				if (this.opts.destructive === true) btn.setWarning();
				else btn.setCta();
			});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) this.opts.onCancel?.();
	}
}

// ---------------------------------------------------------------------------
// DeviceCodeModal
// ---------------------------------------------------------------------------

export class DeviceCodeModal extends Modal {
	private cancelled = false;
	private statusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly provider: ForgeProvider,
		private readonly onToken: (token: string) => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`Sign in with ${this.provider.label}`);
		this.contentEl.createEl("p", { text: "Requesting a device code…" });
		void this.run();
	}

	onClose(): void {
		// Stops the poll loop on its next tick.
		this.cancelled = true;
		this.contentEl.empty();
	}

	private setStatus(text: string): void {
		if (this.statusEl !== null) this.statusEl.setText(text);
	}

	private async run(): Promise<void> {
		let start;
		try {
			start = await this.provider.startDeviceFlow();
		} catch (err) {
			this.contentEl.empty();
			this.contentEl.createEl("p", {
				text: `Could not start sign-in: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}
		if (this.cancelled) return;

		this.contentEl.empty();
		this.contentEl.createEl("p", {
			text: `Enter this code at ${this.provider.label} to authorize syncing:`,
		});

		const codeEl = this.contentEl.createEl("div", { text: start.userCode });
		codeEl.addClass("tether-sync-device-code");

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Copy code").onClick(async () => {
					try {
						await navigator.clipboard.writeText(start.userCode);
						new Notice("Code copied");
					} catch {
						new Notice("Could not copy — select the code manually");
					}
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText(`Open ${this.provider.label}`)
					.setCta()
					.onClick(() => {
						window.open(
							start.verificationUriComplete ?? start.verificationUri,
							"_blank"
						);
					})
			);

		const link = this.contentEl.createEl("p");
		link.createEl("a", {
			text: start.verificationUri,
			href: start.verificationUri,
		});

		this.statusEl = this.contentEl.createEl("p", {
			text: "Waiting for authorization…",
		});

		new Setting(this.contentEl).addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => this.close())
		);

		const result = await this.provider.pollDeviceFlow(start, {
			isCancelled: () => this.cancelled,
			onPoll: (status) =>
				this.setStatus(
					status === "slow_down"
						? "Waiting for authorization (server asked to slow down)…"
						: "Waiting for authorization…"
				),
		});

		switch (result.status) {
			case "success":
				try {
					await this.onToken(result.token);
					new Notice(`Signed in with ${this.provider.label}`);
					this.close();
				} catch (err) {
					this.setStatus(
						`Token could not be saved: ${err instanceof Error ? err.message : String(err)}`
					);
				}
				break;
			case "expired":
				this.setStatus("The code expired. Close this dialog and try again.");
				break;
			case "denied":
				this.setStatus("Authorization was denied.");
				break;
			case "cancelled":
				break;
			case "error":
				this.setStatus(`Sign-in failed: ${result.message}`);
				break;
		}
	}
}

// ---------------------------------------------------------------------------
// ConflictModal
// ---------------------------------------------------------------------------

export class ConflictModal extends Modal {
	constructor(
		app: App,
		private readonly files: string[],
		private readonly stats: ConflictFileStat[],
		private readonly onResolve: (strategy: ConflictStrategyName) => Promise<void>
	) {
		super(app);
	}

	private describeFile(path: string): string {
		return describeConflictFile(path, this.stats.find((s) => s.path === path));
	}

	onOpen(): void {
		this.titleEl.setText("Sync conflict");
		this.contentEl.createEl("p", {
			text:
				"This vault and the remote repository were both changed since the " +
				"last sync, and the changes overlap. Pick how to resolve it — no " +
				"option writes conflict markers into your notes.",
		});

		if (this.files.length > 0) {
			this.contentEl.createEl("p", { text: "Conflicting files:" });
			const list = this.contentEl.createEl("ul");
			for (const file of this.files.slice(0, MAX_CONFLICT_FILES_SHOWN)) {
				list.createEl("li", { text: this.describeFile(file) });
			}
			if (this.files.length > MAX_CONFLICT_FILES_SHOWN) {
				list.createEl("li", {
					text: `…and ${this.files.length - MAX_CONFLICT_FILES_SHOWN} more`,
				});
			}
		} else {
			this.contentEl.createEl("p", {
				text: "The specific conflicting files could not be determined.",
			});
		}

		new Setting(this.contentEl)
			.setName("Create PR branch (recommended)")
			.setDesc(
				"Pushes your local changes to a conflict branch and opens a pull " +
				"request; the vault then follows the remote. Nothing is lost."
			)
			.addButton((btn) =>
				btn.setButtonText("Create PR branch").setCta().onClick(async () => {
					this.close();
					await this.onResolve("prBranch");
				})
			);

		new Setting(this.contentEl)
			.setName("Discard local changes")
			.setDesc("Resets the vault to the remote version. Local changes are lost.")
			.addButton((btn) =>
				btn.setButtonText("Discard…").setWarning().onClick(() => {
					const fileSummary =
						this.files.length > 0
							? ` This will overwrite your local version of: ${this.files
									.slice(0, 10)
									.map((f) => this.describeFile(f))
									.join(", ")}${this.files.length > 10 ? ", …" : ""}.`
							: "";
					// Double-confirm: discarding is the only destructive choice.
					new ConfirmModal(this.app, {
						title: "Really discard local changes?",
						body: `Your local edits will be permanently replaced by the remote version.${fileSummary}`,
						cta: "Discard local changes",
						destructive: true,
						onConfirm: async () => {
							this.close();
							await this.onResolve("discardLocal");
						},
					}).open();
				})
			);

		new Setting(this.contentEl)
			.setName("Keep local & pause")
			.setDesc("Keeps everything as is and pauses auto-sync until you decide.")
			.addButton((btn) =>
				btn.setButtonText("Keep local").onClick(async () => {
					this.close();
					await this.onResolve("keepLocal");
				})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// SetupWizardModal
// ---------------------------------------------------------------------------

type WizardStep = "remote" | "auth" | "clone";

export class SetupWizardModal extends Modal {
	private step: WizardStep = "remote";
	private remoteUrl: string;
	private busy = false;
	/** Set once `detectExistingRemote()` resolves with something to show —
	 * rendered as a note under step 1's field so the prefill is never mistaken
	 * for something the user themselves typed or already confirmed. */
	private detectedHint: string | null = null;
	/** Whether this vault already has a `.git` directory — decides which
	 * step-3 actions `renderCloneStep` offers. Checked once at open (a plain
	 * `exists()` call resolves long before the user clicks through steps 1-2
	 * anyway, so there's no visible loading state in practice). */
	private hasExistingGitDir = false;
	/** "Test connection" verdict for step 2. `warning` means reachable and
	 * authenticated but something is off (e.g. the branch doesn't exist). */
	private testState: "untested" | "testing" | "ok" | "warning" | "failed" = "untested";
	private testMessage = "";

	constructor(
		app: App,
		private readonly plugin: TetherSyncPlugin,
		private readonly onDone?: () => void
	) {
		super(app);
		this.remoteUrl = plugin.settings.remoteUrl;
	}

	onOpen(): void {
		this.modalEl.addClass("tether-sync-wizard-modal");
		this.render();
		// Only worth checking when nothing is saved/typed yet — a non-empty
		// remoteUrl means either a prior wizard run or the user already
		// editing, and detection must never clobber either.
		if (this.remoteUrl.length === 0) void this.detectExistingRemote();
		void this.checkExistingGitDir();
	}

	private async checkExistingGitDir(): Promise<void> {
		try {
			this.hasExistingGitDir = await this.app.vault.adapter.exists(".git");
		} catch {
			this.hasExistingGitDir = false;
		}
		if (this.step === "clone") this.render();
	}

	/** Best-effort prepopulation from a vault's already-existing git remote
	 * (see `main.ts`'s `detectExistingRemoteUrl`) — re-checks both guards
	 * from `onOpen()` after the async read resolves, since the user may have
	 * typed something or moved on to a later step in the meantime. */
	private async detectExistingRemote(): Promise<void> {
		const detected = await this.plugin.detectExistingRemoteUrl();
		if (detected === null || this.remoteUrl.length > 0 || this.step !== "remote") return;
		this.remoteUrl = detected.url;
		this.detectedHint = detected.convertedFromSsh
			? "Pre-filled from this vault's existing remote, converted from SSH to HTTPS — double-check before continuing."
			: "Pre-filled from this vault's existing remote — double-check before continuing.";
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDone?.();
	}

	private render(): void {
		this.titleEl.setText("Tether Sync setup");
		this.contentEl.empty();
		switch (this.step) {
			case "remote":
				this.renderRemoteStep();
				break;
			case "auth":
				this.renderAuthStep();
				break;
			case "clone":
				this.renderCloneStep();
				break;
		}
	}

	// Step 1: remote URL.
	private renderRemoteStep(): void {
		this.contentEl.createEl("p", {
			text:
				"Step 1 of 3 — paste the HTTPS URL of the repository this vault " +
				"should sync with (SSH URLs cannot work on mobile).",
		});
		if (this.detectedHint !== null) {
			this.contentEl.createEl("p", {
				text: this.detectedHint,
				cls: "tether-sync-hint-text",
			});
		}
		const errorEl = this.contentEl.createEl("p");
		errorEl.addClass("tether-sync-error-text");

		new Setting(this.contentEl)
			.setName("Remote URL")
			.addText((text) => {
				text.inputEl.addClass("tether-sync-wide-input");
				text
					.setValue(this.remoteUrl)
					.setPlaceholder("https://github.com/owner/repo.git")
					.onChange((value) => {
						this.remoteUrl = value.trim();
						// A manual edit means the prefill is no longer "unverified as
						// typed by the user" — stop describing it as detected.
						this.detectedHint = null;
					});
			});

		new Setting(this.contentEl).addButton((btn) =>
			btn.setButtonText("Next").setCta().onClick(async () => {
				try {
					normalizeRemoteUrl(this.remoteUrl);
				} catch (err) {
					errorEl.setText(err instanceof Error ? err.message : String(err));
					return;
				}
				this.plugin.settings.remoteUrl = this.remoteUrl;
				await this.plugin.saveSettings();
				this.step = "auth";
				this.render();
			})
		);
	}

	// Step 2: authentication.
	private renderAuthStep(): void {
		const provider = this.plugin.getProvider();
		let kindLabel = "unknown host";
		try {
			const kind = detectProvider(
				this.plugin.settings.remoteUrl,
				this.plugin.settings.gitlabSelfManagedBase,
				this.plugin.settings.giteaSelfManagedBase
			);
			kindLabel = PROVIDER_KIND_LABELS[kind];
		} catch {
			// keep default label
		}
		this.contentEl.createEl("p", {
			text: `Step 2 of 3 — authenticate. This remote looks like ${kindLabel}.`,
		});
		const errorEl = this.contentEl.createEl("p");
		errorEl.addClass("tether-sync-error-text");

		const goToClone = () => {
			this.step = "clone";
			this.render();
		};
		// Saving a token invalidates any earlier verdict — a failed test
		// followed by pasting a new token must not keep showing the failure.
		const onTokenSaved = () => {
			this.testState = "untested";
			this.testMessage = "";
			goToClone();
		};
		const { checkExisting } = renderTokenSetting({
			container: this.contentEl,
			app: this.app,
			plugin: this.plugin,
			provider,
			saveButtonText: "Use this token",
			onSaved: onTokenSaved,
			onError: (message) => errorEl.setText(message),
		});
		checkExisting(() => {
			new Setting(this.contentEl)
				.setName("A token is already saved for this host")
				.addButton((btn) => btn.setButtonText("Continue").onClick(goToClone));
		});

		this.renderConnectionTest(this.contentEl);

		new Setting(this.contentEl).addButton((btn) =>
			btn.setButtonText("Back").onClick(() => {
				this.step = "remote";
				this.render();
			})
		);
	}

	/**
	 * "Test connection" — parity with Tether Fetch's wizard step 4, and the
	 * cheapest place to catch a bad URL, a wrong/expired token, or a server
	 * this transport cannot talk to, before the user commits to a clone.
	 *
	 * Optional on purpose: it is a diagnostic, not a gate. Step 3's actions
	 * stay reachable without it, so being offline or rate-limited never blocks
	 * setup. (Tether Fetch has to gate its Next button because its later steps
	 * need the downloaded artifact to detect a content root; nothing here
	 * needs the network until the user picks an action.)
	 */
	private renderConnectionTest(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName("Test connection")
			.setDesc(
				"Asks the remote for its branches using the same git transport a " +
					"real sync uses — verifies the URL, the token, and that the server " +
					"speaks a protocol this plugin understands."
			);

		setting.addButton((btn) =>
			btn
				.setButtonText(this.testState === "testing" ? "Testing…" : "Test connection")
				.setDisabled(this.testState === "testing" || this.busy)
				.onClick(async () => {
					this.testState = "testing";
					this.render();
					try {
						const result = await this.plugin.testConnection();
						this.testState = "ok";
						if (result.isEmptyRepo) {
							this.testMessage =
								"Connected. The repository is empty — use \"Initialize\" below to " +
								"push this vault as its initial content.";
						} else if (result.branchFound) {
							this.testMessage = `Connected. Found branch '${result.branch}'.`;
						} else {
							// Reachable and authenticated, but the branch is wrong — the
							// single most likely misconfiguration once a token works.
							this.testState = "warning";
							this.testMessage =
								`Connected, but there is no branch '${result.branch}' on the remote. ` +
								`Available: ${result.branches.join(", ")}. ` +
								"Change the branch in Settings after setup, or initialize to create it.";
						}
					} catch (err) {
						this.testState = "failed";
						this.testMessage = describeGitError(err);
					}
					this.render();
				})
		);

		if (this.testState === "untested") return;
		const statusEl = containerEl.createEl("p");
		if (this.testState === "testing") {
			statusEl.setText("Testing…");
			return;
		}
		statusEl.addClass(
			this.testState === "ok" ? "tether-sync-hint-text" : "tether-sync-error-text"
		);
		const prefix = this.testState === "ok" ? "✓" : this.testState === "warning" ? "⚠" : "✗";
		statusEl.setText(`${prefix} ${this.testMessage}`);
	}

	// Step 3: connect the vault — behavior branches hard on whether this
	// vault already has a `.git` this wizard didn't create (see
	// `hasExistingGitDir`/`checkExistingGitDir`).
	private renderCloneStep(): void {
		this.contentEl.createEl("p", {
			text: this.hasExistingGitDir
				? "Step 3 of 3 — this vault already has a git repository. Connect " +
					"Tether Sync to it without disturbing what's there."
				: "Step 3 of 3 — connect the vault. Clone if the repository already " +
					"has your notes; initialize if this vault should become the " +
					"repository's initial content.",
		});
		const progressEl = this.contentEl.createEl("p");

		const runStep = async (
			label: string,
			action: () => Promise<void>,
			successMessage = "Tether Sync: setup complete"
		) => {
			if (this.busy) return;
			this.busy = true;
			progressEl.setText(`${label}…`);
			try {
				await action();
				const missingKeys = await this.checkGitCryptAfterSetup();
				if (missingKeys !== null) {
					this.renderGitCryptSetupNote(missingKeys);
					return;
				}
				new Notice(successMessage);
				this.close();
			} catch (err) {
				progressEl.setText(`${label} failed: ${describeGitError(err)}`);
			} finally {
				this.busy = false;
			}
		};

		if (this.hasExistingGitDir) {
			new Setting(this.contentEl)
				.setName("Use existing repository")
				.setDesc(
					"Points Tether Sync's own remote at the URL from step 1, then " +
						"syncs the normal way: any uncommitted changes are committed, " +
						"the remote is fetched, and the two are merged — a real " +
						"conflict is handled exactly like any later sync would. " +
						"Nothing is force-checked-out or force-committed, and your " +
						"existing branch and history are left as they are."
				)
				.addButton((btn) =>
					btn.setButtonText("Use existing repository").setCta().onClick(() => {
						void runStep(
							"Connecting",
							() => this.plugin.adoptExistingRepo((msg) => progressEl.setText(msg)),
							"Tether Sync: connected — watch the status bar or sync panel " +
								"for progress as it reconciles with the remote."
						);
					})
				);
		}

		new Setting(this.contentEl)
			.setName("Clone remote into this vault")
			.setDesc(
				this.hasExistingGitDir
					? "Unavailable — this vault already has a git repository. Use " +
						"\"Use existing repository\" above; if you specifically want to " +
						"discard local history and start over from the remote, finish " +
						"setup and use Danger Zone's \"Re-clone\" instead."
					: "Downloads the repository (shallow). Existing vault files with the " +
						"same names will be overwritten by the remote version."
			)
			.addButton((btn) => {
				btn.setButtonText("Clone").onClick(() => {
					void this.confirmOverwriteExistingFiles(() => {
						void runStep("Cloning", () =>
							this.plugin.cloneRemote((msg) => progressEl.setText(msg))
						);
					});
				});
				btn.setDisabled(this.hasExistingGitDir);
				if (!this.hasExistingGitDir) btn.setCta();
			});

		new Setting(this.contentEl)
			.setName("Initialize from this vault")
			.setDesc(
				this.hasExistingGitDir
					? "Unavailable — this vault already has a git repository. Use " +
						"\"Use existing repository\" above instead."
					: "Creates the repository content from the current vault: init, " +
						"initial commit, and push. Use with an empty remote repository."
			)
			.addButton((btn) => {
				btn.setButtonText("Initialize").onClick(() => {
					void runStep("Initializing", () =>
						this.plugin.initFromExistingVault((msg) => progressEl.setText(msg))
					);
				});
				btn.setDisabled(this.hasExistingGitDir);
			});

		new Setting(this.contentEl).addButton((btn) =>
			btn.setButtonText("Back").onClick(() => {
				this.step = "auth";
				this.render();
			})
		);
	}

	/**
	 * After a successful Clone/Initialize/"Use existing repository" step,
	 * checks whether the connected repository uses git-crypt and, if so,
	 * whether any referenced key is still missing on this device — reusing
	 * the exact same check Settings' Encryption section uses
	 * (`plugin.gitCryptChecklist()`), so the wizard and that section can
	 * never disagree about what a repo needs. Returns null when there's
	 * nothing to report (not git-crypt, or every key is already present),
	 * in which case the wizard's normal "setup complete" flow proceeds
	 * unchanged.
	 */
	private async checkGitCryptAfterSetup(): Promise<string[] | null> {
		try {
			const entries = await this.plugin.gitCryptChecklist();
			if (entries === null) return null;
			const missing = entries
				.filter((entry) => !entry.configured)
				.map((entry) => (entry.keyName === "" ? "default key" : `"${entry.keyName}"`));
			return missing.length > 0 ? missing : null;
		} catch {
			return null;
		}
	}

	/**
	 * Replaces step 3's content with a note instead of the usual
	 * Notice-and-close: a fading Notice is easy to miss for something that
	 * needs a real follow-up action (importing a key in Settings), unlike
	 * the ordinary "setup complete" case.
	 */
	private renderGitCryptSetupNote(missingKeys: string[]): void {
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			text: "Connected — but this repository uses git-crypt, and it's locked on this device.",
		});
		this.contentEl.createEl("p", {
			text:
				`Missing key(s): ${missingKeys.join(", ")}. Syncing is paused until every key the ` +
				"repository references is imported — go to Settings → Tether Sync → Encryption to " +
				"import it. Nothing has been committed or pushed unencrypted in the meantime.",
			cls: "tether-sync-hint-text",
		});
		new Setting(this.contentEl).addButton((btn) =>
			btn.setButtonText("Got it").setCta().onClick(() => this.close())
		);
	}

	/**
	 * Clone's own description already says existing files with matching names
	 * get overwritten, but nothing previously stopped the click. A vault with
	 * real content (not just Obsidian's own `.obsidian` scaffolding) gets an
	 * explicit confirmation instead of a silent overwrite. (Only reachable at
	 * all when `.git` does NOT already exist — see `renderCloneStep`.)
	 */
	private async confirmOverwriteExistingFiles(proceed: () => void): Promise<void> {
		let hasContent: boolean;
		try {
			const listing = await this.app.vault.adapter.list("/");
			hasContent =
				listing.files.length > 0 ||
				listing.folders.some((f) => f !== ".obsidian" && f !== ".git" && f !== ".git.bak");
		} catch {
			hasContent = false;
		}
		if (!hasContent) {
			proceed();
			return;
		}
		new ConfirmModal(this.app, {
			title: "Overwrite existing vault files?",
			body:
				"This vault already has files in it. Cloning will overwrite any file " +
				"whose name matches something in the remote repository — files that " +
				"don't exist in the remote are left alone. Continue?",
			cta: "Clone anyway",
			destructive: true,
			onConfirm: () => proceed(),
		}).open();
	}

}

// ---------------------------------------------------------------------------
// SyncHistoryModal
// ---------------------------------------------------------------------------

/** Read-only, capped list (see SyncOrchestrator.history) — no editing, no pagination. */
export class SyncHistoryModal extends Modal {
	constructor(app: App, private readonly history: readonly SyncHistoryEntry[]) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Sync history");
		if (this.history.length === 0) {
			this.contentEl.createEl("p", { text: "No syncs recorded yet." });
			return;
		}
		const now = Date.now();
		const list = this.contentEl.createEl("ul", { cls: "tether-sync-history-list" });
		// Most recent first.
		for (const entry of [...this.history].reverse()) {
			const item = list.createEl("li");
			item.createEl("strong", { text: HISTORY_OUTCOME_LABELS[entry.outcome] });
			item.createSpan({
				text: ` — ${new Date(entry.at).toLocaleString()} (${formatRelativeTime(entry.at, now)})`,
			});
			if (entry.message !== null) {
				item.createDiv({
					text: entry.message,
					cls: "tether-sync-history-message",
				});
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
