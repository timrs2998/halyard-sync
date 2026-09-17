/**
 * Right-sidebar panel: a persistent, always-visible view of sync status,
 * next scheduled sync, and recent history, with a one-click resync/resolve
 * action — the standing complement to the status bar (whose detail lives in
 * a tooltip that disappears the moment you look away) and the ribbon's
 * right-click menu (one-shot actions, no live view). Scoped to what this
 * plugin actually tracks: no diff/staging UI, since conflict resolution
 * already has its own modal (`ConflictModal`) this panel just opens.
 *
 * Thin renderer only — all formatting logic lives in `sync-panel-model.ts`
 * (obsidian-import-free, unit-tested); see that file's header comment for why.
 */

import { ItemView, Notice, Setting, type WorkspaceLeaf } from "obsidian";
import { HALYARD_SYNC_ICON_ID } from "./icon";
import { SyncHistoryModal } from "./modals";
import {
	buildActiveNoteGitDetailsViewModel,
	type ActiveNoteGitDetailsPanelState,
} from "./active-note-git-details";
import { buildSyncPanelViewModel } from "./sync-panel-model";
import type HalyardSyncPlugin from "../main";

export const HALYARD_SYNC_VIEW_TYPE = "halyard-sync-panel";

export class HalyardSyncView extends ItemView {
	private unsubscribe: (() => void) | null = null;
	private refreshTimer: number | null = null;
	private activeNoteRefreshTimer: number | null = null;
	private activeNoteRequest = 0;
	private activeNoteDetails: ActiveNoteGitDetailsPanelState = { kind: "not-applicable" };
	private lastSyncAt: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: HalyardSyncPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return HALYARD_SYNC_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Halyard Sync";
	}

	getIcon(): string {
		return HALYARD_SYNC_ICON_ID;
	}

	async onOpen(): Promise<void> {
		this.lastSyncAt = this.plugin.orchestrator.status.lastSyncAt;
		this.unsubscribe = this.plugin.orchestrator.on((event) => {
			this.render();
			if (event.lastSyncAt !== this.lastSyncAt) {
				this.lastSyncAt = event.lastSyncAt;
				this.scheduleActiveNoteRefresh();
			}
		});
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleActiveNoteRefresh()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleActiveNoteRefresh()));
		// Keeps relative times and the next-sync countdown fresh even when no
		// status event fires for a while — same interval statusbar.ts's
		// controller already uses for the same reason.
		this.refreshTimer = window.setInterval(() => this.render(), 30_000);
		this.render();
		this.scheduleActiveNoteRefresh();
	}

	async onClose(): Promise<void> {
		this.activeNoteRequest += 1;
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.activeNoteRefreshTimer !== null) {
			window.clearTimeout(this.activeNoteRefreshTimer);
			this.activeNoteRefreshTimer = null;
		}
	}

	private scheduleActiveNoteRefresh(): void {
		if (this.activeNoteRefreshTimer !== null) return;
		this.activeNoteRefreshTimer = window.setTimeout(() => {
			this.activeNoteRefreshTimer = null;
			void this.refreshActiveNoteDetails();
		}, 0);
	}

	private async refreshActiveNoteDetails(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const path = file !== null && file.extension.toLowerCase() === "md" ? file.path : null;
		const request = ++this.activeNoteRequest;
		if (path === null) {
			this.activeNoteDetails = { kind: "not-applicable" };
			this.render();
			return;
		}
		this.activeNoteDetails = { kind: "loading", path };
		this.render();
		try {
			const result = await this.plugin.getActiveNoteGitDetails(path);
			if (request !== this.activeNoteRequest) return;
			this.activeNoteDetails = result;
		} catch (err) {
			if (request !== this.activeNoteRequest) return;
			this.activeNoteDetails = { kind: "error", path, message: String(err) };
		}
		this.render();
	}

	private renderActiveNoteGitDetails(container: HTMLElement): void {
		const model = buildActiveNoteGitDetailsViewModel(this.activeNoteDetails);
		const section = container.createDiv({ cls: "halyard-active-note-git-details" });
		section.createEl("h4", { text: "Active note Git details" });
		if (model.path !== null) section.createEl("p", { text: model.path, cls: "halyard-active-note-git-path" });
		section.createEl("p", { text: model.message, cls: "halyard-active-note-git-message" });
		if (model.commitMessage !== null) {
			section.createEl("p", { text: model.commitMessage, cls: "halyard-active-note-git-commit-message" });
		}
		for (const row of model.rows) {
			const setting = new Setting(section).setName(row.label).setDesc(row.value);
			if (row.copyValue !== undefined) {
				setting.addButton((button) => {
					button
						.setButtonText("Copy")
						.setTooltip(`${row.copyLabel ?? "Copy value"}: ${row.copyValue}`)
						.onClick(() => void this.copyValue(row.copyValue as string));
					button.buttonEl.setAttribute("aria-label", `${row.copyLabel ?? "Copy value"}: ${row.copyValue}`);
				});
			}
		}
	}

	private async copyValue(value: string): Promise<void> {
		try {
			if (navigator.clipboard === undefined) throw new Error("Clipboard access is unavailable");
			await navigator.clipboard.writeText(value);
			new Notice("Halyard Sync: commit hash copied");
		} catch {
			new Notice("Halyard Sync: could not copy the commit hash");
		}
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("halyard-sync-view");

		const model = buildSyncPanelViewModel(
			this.plugin.orchestrator.status,
			this.plugin.orchestrator.history,
			Date.now(),
			this.plugin.scheduler.nextFireAt,
			this.plugin.settings.autoSyncPaused,
			this.plugin.setupState(),
			this.plugin.orchestrator.hasExternalWriteBlock
		);

		container.createEl("h3", { text: model.headline });
		container.createEl("p", { text: model.detail, cls: "halyard-sync-view-detail" });
		this.renderActiveNoteGitDetails(container);

		if (model.primaryAction === "setup") {
			// Nothing to sync/resolve/schedule yet — a "Sync now" button here
			// would just bounce back to this same wizard via syncNow()'s own
			// guard, so skip straight to it instead of the normal sync UI below.
			new Setting(container).addButton((btn) =>
				btn
					.setButtonText(model.setupButtonText)
					.setCta()
					.onClick(() => this.plugin.openSetupWizard())
			);
			return;
		}

		if (model.primaryAction === "resolveConflict") {
			new Setting(container).addButton((btn) =>
				btn
					.setButtonText("Resolve conflict")
					.setCta()
					.onClick(() => void this.plugin.openConflictModal())
				);
		} else if (model.primaryAction === "clearExternalWriteBlock") {
			new Setting(container).addButton((btn) =>
				btn
					.setButtonText("Clear generated-write block")
					.setDestructive()
					.onClick(() => void this.plugin.clearExternalWriteBlock())
			);
		} else {
			new Setting(container).addButton((btn) =>
				btn
					.setButtonText(model.syncing ? "Syncing…" : "Sync now")
					.setCta()
					.setDisabled(model.syncing)
					.onClick(() => this.plugin.syncNow())
			);
		}

		container.createEl("p", { text: model.nextSyncText, cls: "halyard-sync-view-next-sync" });

		container.createEl("h4", { text: "Recent activity" });
		if (model.recentHistory.length === 0) {
			container.createEl("p", { text: "No syncs recorded yet." });
			return;
		}
		const list = container.createEl("ul", { cls: "halyard-sync-history-list" });
		for (const row of model.recentHistory) {
			const item = list.createEl("li");
			item.createEl("strong", { text: row.label });
			item.createSpan({ text: ` — ${row.when}` });
			if (row.message !== null) {
				item.createDiv({ text: row.message, cls: "halyard-sync-history-message" });
			}
		}
		new Setting(container).addButton((btn) =>
			btn
				.setButtonText(model.hasMoreHistory ? "View full history" : "View history")
				.onClick(() => new SyncHistoryModal(this.app, this.plugin.orchestrator.history).open())
		);
	}
}
