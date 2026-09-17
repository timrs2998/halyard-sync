/**
 * Structured metadata in Halyard Sync commit messages. The first line remains
 * human-readable, while key/value markers make device attribution available to
 * the active-note history view without changing note contents.
 */

export interface SyncCommitAttribution {
	platform: string | null;
	deviceName: string | null;
}

function safeMarker(value: string): string {
	return value.trim().replace(/[;()\r\n]/g, " ").replace(/\s+/g, " ");
}

export function formatSyncCommitMessage(timestamp: string, platform: string, deviceName: string): string {
	return `vault sync: ${timestamp} (platform=${safeMarker(platform)}; device=${safeMarker(deviceName)})`;
}

/** Parses both the current key/value marker and the legacy `(desktop)` form. */
export function parseSyncCommitAttribution(message: string): SyncCommitAttribution {
	const marker = message.match(/\(([^\r\n)]*)\)/)?.[1]?.trim() ?? "";
	const platformMatch = marker.match(/(?:^|;\s*)platform=([^;]*)/i);
	const deviceMatch = marker.match(/(?:^|;\s*)device=([^;]*)/i);
	if (platformMatch !== null || deviceMatch !== null) {
		return {
			platform: platformMatch?.[1]?.trim() || null,
			deviceName: deviceMatch?.[1]?.trim() || null,
		};
	}
	return { platform: marker.length > 0 ? marker : null, deviceName: null };
}
