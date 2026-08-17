/**
 * Pure sync-history label formatting — deliberately zero `obsidian` imports
 * (same reasoning as `statusbar.ts`'s header comment: the `obsidian` npm
 * package ships types only, no runtime JS, so anything that imports it
 * can't be loaded under vitest). Shared by `modals.ts`'s `SyncHistoryModal`
 * and `sync-panel-model.ts`'s panel view-model builder, so the two history
 * displays (full-history modal, sidebar panel's recent-activity list) never
 * drift apart.
 */

import type { SyncHistoryOutcome } from "../sync/orchestrator";

export const HISTORY_OUTCOME_LABELS: Record<SyncHistoryOutcome, string> = {
	synced: "✓ Synced",
	error: "✗ Error",
	"conflict-resolved": "⚠ Conflict resolved",
};
