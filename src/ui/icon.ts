/** The shared Halyard block-and-rope silhouette. Opposed chevrons distinguish
 * bidirectional sync from Halyard Fetch's one-way artifact delivery glyph. */

import { addIcon } from "obsidian";

export const HALYARD_SYNC_ICON_ID = "halyard-sync";

export function registerHalyardSyncIcon(): void {
	addIcon(
		HALYARD_SYNC_ICON_ID,
		`<circle cx="50" cy="21" r="10.5" fill="none" stroke="currentColor" stroke-width="8"/>` +
			`<path class="halyard-sync-icon-rope" d="M39.5 30 C 32 33, 27 40, 27 48 V 79 ` +
			`M60.5 30 C 68 33, 73 40, 73 48 V 79" fill="none" stroke="currentColor" ` +
			`stroke-width="8" stroke-linecap="round"/>` +
			`<path d="M17 60 L27 50 L37 60 M63 69 L73 79 L83 69" fill="none" ` +
			`stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`
	);
}
