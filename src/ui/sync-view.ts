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

import { ItemView, Setting, type WorkspaceLeaf } from "obsidian";
import { TETHER_SYNC_ICON_ID } from "./icon";
import { SyncHistoryModal } from "./modals";
import { buildSyncPanelViewModel } from "./sync-panel-model";
import type TetherSyncPlugin from "../main";

export const TETHER_SYNC_VIEW_TYPE = "tether-sync-panel";

export class TetherSyncView extends ItemView {
	private unsubscribe: (() => void) | null = null;
	private refreshTimer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: TetherSyncPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return TETHER_SYNC_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Tether Sync";
	}

	getIcon(): string {
		return TETHER_SYNC_ICON_ID;
	}

	async onOpen(): Promise<void> {
		this.unsubscribe = this.plugin.orchestrator.on(() => this.render());
		// Keeps relative times and the next-sync countdown fresh even when no
		// status event fires for a while — same interval statusbar.ts's
		// controller already uses for the same reason.
		this.refreshTimer = window.setInterval(() => this.render(), 30_000);
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("tether-sync-view");

		const model = buildSyncPanelViewModel(
			this.plugin.orchestrator.status,
			this.plugin.orchestrator.history,
			Date.now(),
			this.plugin.scheduler.nextFireAt,
			this.plugin.settings.autoSyncPaused,
			this.plugin.setupState()
		);

		container.createEl("h3", { text: model.headline });
		container.createEl("p", { text: model.detail, cls: "tether-sync-view-detail" });

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
		} else {
			new Setting(container).addButton((btn) =>
				btn
					.setButtonText(model.syncing ? "Syncing…" : "Sync now")
					.setCta()
					.setDisabled(model.syncing)
					.onClick(() => this.plugin.syncNow())
			);
		}

		container.createEl("p", { text: model.nextSyncText, cls: "tether-sync-view-next-sync" });

		container.createEl("h4", { text: "Recent activity" });
		if (model.recentHistory.length === 0) {
			container.createEl("p", { text: "No syncs recorded yet." });
			return;
		}
		const list = container.createEl("ul", { cls: "tether-sync-history-list" });
		for (const row of model.recentHistory) {
			const item = list.createEl("li");
			item.createEl("strong", { text: row.label });
			item.createSpan({ text: ` — ${row.when}` });
			if (row.message !== null) {
				item.createDiv({ text: row.message, cls: "tether-sync-history-message" });
			}
		}
		new Setting(container).addButton((btn) =>
			btn
				.setButtonText(model.hasMoreHistory ? "View full history" : "View history")
				.onClick(() => new SyncHistoryModal(this.app, this.plugin.orchestrator.history).open())
		);
	}
}
