/**
 * Halyard Sync's custom icon: two anchored nodes joined by a halyard cord,
 * registered once via Obsidian's `addIcon` so it can be referenced by ID
 * from `setIcon`/`addRibbonIcon`/`getIcon` anywhere in the plugin — chosen
 * instead of the built-in "refresh-cw" glyph because that circular-arrows
 * shape is the generic sync icon every app reuses (Obsidian Sync, GitHub
 * Desktop, etc.); a distinct glyph makes the ribbon icon recognizable at a
 * glance among a crowded icon rail.
 *
 * `addIcon`'s `svgContent` is inserted into a fixed 0 0 100 100 viewBox, so
 * all coordinates below are in that space. The cord is its own `<path>`
 * with a class hook (`halyard-sync-icon-cord`) so `styles.css` can animate
 * just that element (dash flow) while syncing, without touching the two
 * anchor dots.
 */

import { addIcon } from "obsidian";

export const HALYARD_SYNC_ICON_ID = "halyard-sync-cord";

export function registerHalyardSyncIcon(): void {
	addIcon(
		HALYARD_SYNC_ICON_ID,
		`<circle cx="26" cy="26" r="9" fill="currentColor" stroke="none"/>` +
			`<circle cx="74" cy="74" r="9" fill="currentColor" stroke="none"/>` +
			`<path class="halyard-sync-icon-cord" d="M30 34 C 55 34, 45 66, 70 66" ` +
			`fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>`
	);
}
