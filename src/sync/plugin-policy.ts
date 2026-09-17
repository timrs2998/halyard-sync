/**
 * Pure policy helpers for Obsidian community-plugin distribution.
 *
 * The policy is stored in a marked block in the vault's tracked `.gitignore`.
 * Halyard Sync settings hold the user's desired policy while it is waiting for
 * the explicit index-removal migration; the managed block is the repository's
 * effective policy once it has been applied.
 */

export const PLUGIN_POLICY_BEGIN = "# BEGIN HALYARD SYNC PLUGIN POLICY";
export const PLUGIN_POLICY_END = "# END HALYARD SYNC PLUGIN POLICY";

export type PluginSyncMode = "shared" | "code-only" | "device-local";
export type CommunityPluginsSyncMode = "shared" | "device-local";

export const DEFAULT_PLUGIN_SYNC_MODE: PluginSyncMode = "shared";
export const DEFAULT_COMMUNITY_PLUGINS_SYNC_MODE: CommunityPluginsSyncMode = "shared";

export interface PluginPolicySettings {
	pluginSyncPolicies: Record<string, PluginSyncMode>;
	communityPluginsSync: CommunityPluginsSyncMode;
}

export interface PluginPolicyStatus {
	desiredPatterns: string[];
	activePatterns: string[];
	/** Exact paths still present in the local HEAD and eligible for removal. */
	trackedPaths: string[];
	/** True when the desired policy is not fully committed and pushed. */
	pending: boolean;
	/** True when a local migration commit exists but its push still needs retrying. */
	pushPending: boolean;
	hasRepository: boolean;
}

export interface InstalledPluginForPolicy {
	id: string;
	name: string;
}

export function normalizePluginSyncMode(value: unknown): PluginSyncMode {
	return value === "code-only" || value === "device-local" || value === "shared"
		? value
		: DEFAULT_PLUGIN_SYNC_MODE;
}

export function normalizeCommunityPluginsSyncMode(value: unknown): CommunityPluginsSyncMode {
	return value === "device-local" || value === "shared"
		? value
		: DEFAULT_COMMUNITY_PLUGINS_SYNC_MODE;
}

export function normalizePluginSyncPolicies(value: unknown): Record<string, PluginSyncMode> {
	if (value === null || typeof value !== "object") return {};
	const result: Record<string, PluginSyncMode> = {};
	for (const [id, mode] of Object.entries(value)) {
		if (!isSafePluginId(id)) continue;
		result[id] = normalizePluginSyncMode(mode);
	}
	return result;
}

/**
 * Derive deterministic `.gitignore` patterns. Shared code has no ignore
 * pattern; code-only ignores Obsidian's standard settings file; device-local
 * ignores the complete plugin folder. Halyard Sync's own folder is omitted:
 * its data file is an unconditional engine exclusion and its code must remain
 * distributable so another device can install the same release.
 */
export function derivePluginPolicyPatterns(
	configDir: string,
	pluginSyncPolicies: Record<string, PluginSyncMode>,
	communityPluginsSync: CommunityPluginsSyncMode,
	ownPluginId?: string
): string[] {
	const patterns: string[] = [];
	const normalizedConfigDir = normalizePathSegment(configDir);
	if (normalizedConfigDir.length === 0) return [];

	for (const id of Object.keys(pluginSyncPolicies).sort((a, b) => a.localeCompare(b))) {
		if (id === ownPluginId || !isSafePluginId(id)) continue;
		const mode = normalizePluginSyncMode(pluginSyncPolicies[id]);
		const folder = `${normalizedConfigDir}/plugins/${id}`;
		if (mode === "code-only") patterns.push(`${folder}/data.json`);
		if (mode === "device-local") patterns.push(`${folder}/`);
	}

	if (communityPluginsSync === "device-local") {
		patterns.push(`${normalizedConfigDir}/community-plugins.json`);
	}
	return [...new Set(patterns)].sort((a, b) => a.localeCompare(b));
}

/** Infer the UI modes from the currently effective managed block. */
export function inferPluginPolicySettings(
	configDir: string,
	patterns: readonly string[],
	plugins: readonly InstalledPluginForPolicy[],
	ownPluginId?: string
): PluginPolicySettings {
	const normalized = new Set(patterns.map(normalizePattern));
	const normalizedConfigDir = normalizePathSegment(configDir);
	const pluginSyncPolicies: Record<string, PluginSyncMode> = {};
	for (const plugin of plugins) {
		if (plugin.id === ownPluginId || !isSafePluginId(plugin.id)) continue;
		const folder = `${normalizedConfigDir}/plugins/${plugin.id}`;
		pluginSyncPolicies[plugin.id] = normalized.has(`${folder}/`)
			? "device-local"
			: normalized.has(`${folder}/data.json`)
				? "code-only"
				: "shared";
	}
	// Preserve repository policy for plugins that are not installed here. A
	// consuming device must not erase another device's exclusion merely because
	// it cannot enumerate that plugin locally.
	const pluginPrefix = `${normalizedConfigDir}/plugins/`;
	for (const pattern of normalized) {
		if (!pattern.startsWith(pluginPrefix)) continue;
		const remainder = pattern.slice(pluginPrefix.length);
		let id: string | null = null;
		let mode: PluginSyncMode | null = null;
		if (remainder.endsWith("/data.json")) {
			id = remainder.slice(0, -"/data.json".length);
			mode = "code-only";
		} else if (remainder.endsWith("/")) {
			id = remainder.slice(0, -1);
			mode = "device-local";
		}
		if (id !== null && mode !== null && id !== ownPluginId && isSafePluginId(id)) {
			const current = pluginSyncPolicies[id];
			// A folder exclusion is stronger than a settings-only exclusion if
			// both markers are present due to a hand merge.
			if (current !== "device-local") pluginSyncPolicies[id] = mode;
		}
	}
	return {
		pluginSyncPolicies,
		communityPluginsSync: normalized.has(`${normalizedConfigDir}/community-plugins.json`)
			? "device-local"
			: "shared",
	};
}

/** Read only the complete, well-formed Halyard block. */
export function readManagedPluginPolicyPatterns(contents: string): string[] {
	const lines = contents.split(/\r?\n/);
	const begin = lines.findIndex((line) => line.trim() === PLUGIN_POLICY_BEGIN);
	if (begin < 0) return [];
	const end = lines.findIndex((line, index) => index > begin && line.trim() === PLUGIN_POLICY_END);
	if (end < 0) return [];
	return lines
		.slice(begin + 1, end)
		.map(normalizePattern)
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Keep only patterns that Halyard Sync can produce for the configured vault.
 * A managed block is repository data, so its contents are not trusted merely
 * because they sit between the two markers. This narrower form is used when a
 * remote policy controls local-file preservation; user ignore rules must never
 * turn into an implicit backup/restore list.
 */
export function deterministicPluginPolicyPatterns(
	configDir: string,
	patterns: readonly string[]
): string[] {
	const normalizedConfigDir = normalizePathSegment(configDir);
	if (normalizedConfigDir.length === 0 || hasUnsafePathSegment(normalizedConfigDir)) return [];
	const pluginPrefix = `${normalizedConfigDir}/plugins/`;
	const communityPluginsPath = `${normalizedConfigDir}/community-plugins.json`;
	const result = new Set<string>();
	for (const rawPattern of patterns) {
		const pattern = normalizePattern(rawPattern);
		if (pattern === communityPluginsPath) {
			result.add(pattern);
			continue;
		}
		if (!pattern.startsWith(pluginPrefix)) continue;
		const remainder = pattern.slice(pluginPrefix.length);
		const isDirectory = remainder.endsWith("/");
		const suffix = isDirectory ? "/" : "/data.json";
		if (!remainder.endsWith(suffix)) continue;
		const pluginId = remainder.slice(0, -suffix.length);
		if (!isSafePluginId(pluginId)) continue;
		result.add(`${pluginPrefix}${pluginId}${suffix}`);
	}
	return [...result].sort((a, b) => a.localeCompare(b));
}

export function isManagedPluginPolicyBlockWellFormed(contents: string): boolean {
	const lines = contents.split(/\r?\n/).map((line) => line.trim());
	const begins = lines.filter((line) => line === PLUGIN_POLICY_BEGIN).length;
	const ends = lines.filter((line) => line === PLUGIN_POLICY_END).length;
	if (begins === 0 && ends === 0) return true;
	if (begins !== 1 || ends !== 1) return false;
	return lines.indexOf(PLUGIN_POLICY_BEGIN) < lines.indexOf(PLUGIN_POLICY_END);
}

/**
 * Replace one complete managed block while preserving every user-authored
 * line, its order, and its LF/CRLF convention. An unmatched marker is left
 * untouched so a hand-edited or interrupted file is never silently damaged.
 */
export function upsertManagedPluginPolicyBlock(contents: string, patterns: readonly string[]): string {
	const newline = contents.includes("\r\n") ? "\r\n" : "\n";
	const lines = contents.split(/\r?\n/);
	const begin = lines.findIndex((line) => line.trim() === PLUGIN_POLICY_BEGIN);
	let kept = lines;
	if (begin >= 0) {
		const end = lines.findIndex((line, index) => index > begin && line.trim() === PLUGIN_POLICY_END);
		if (end < 0) return contents;
		kept = [...lines.slice(0, begin), ...lines.slice(end + 1)];
	} else if (lines.some((line) => line.trim() === PLUGIN_POLICY_END)) {
		return contents;
	}

	const normalizedPatterns = [...new Set(patterns.map(normalizePattern))]
		.filter((pattern) => pattern.length > 0 && !pattern.startsWith("#"))
		.sort((a, b) => a.localeCompare(b));
	if (normalizedPatterns.length === 0) return kept.join(newline);

	const block = [
		PLUGIN_POLICY_BEGIN,
		"# This block is managed by Halyard Sync. Edit the policy in its settings.",
		...normalizedPatterns,
		PLUGIN_POLICY_END,
	];
	let result = kept.join(newline);
	if (result.length > 0 && !result.endsWith(newline)) result += newline;
	return result + block.join(newline) + newline;
}

export function policyPatternsEqual(a: readonly string[], b: readonly string[]): boolean {
	const normalize = (values: readonly string[]) =>
		[...new Set(values.map(normalizePattern).filter((value) => value.length > 0))].sort((x, y) =>
			x.localeCompare(y)
		);
	const left = normalize(a);
	const right = normalize(b);
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Candidate exact paths used for the safe index-removal migration. */
export function policyMigrationCandidatePaths(
	configDir: string,
	plugins: readonly InstalledPluginForPolicy[],
	localFiles: readonly string[],
	pluginSyncPolicies: Record<string, PluginSyncMode>,
	communityPluginsSync: CommunityPluginsSyncMode,
	ownPluginId?: string
): string[] {
	const result = new Set<string>();
	const normalizedConfigDir = normalizePathSegment(configDir);
	if (normalizedConfigDir.length === 0) return [];
	for (const plugin of plugins) {
		if (plugin.id === ownPluginId || !isSafePluginId(plugin.id)) continue;
		const folder = `${normalizedConfigDir}/plugins/${plugin.id}`;
		const mode = normalizePluginSyncMode(pluginSyncPolicies[plugin.id]);
		if (mode === "shared") continue;
		if (mode === "code-only") {
			result.add(`${folder}/data.json`);
			continue;
		}
		// These are the standard package files, so a locally deleted file is
		// still offered for removal from the index.
		for (const file of ["main.js", "manifest.json", "styles.css", "data.json"]) {
			result.add(`${folder}/${file}`);
		}
		for (const path of localFiles) {
			const normalizedPath = normalizePattern(path);
			if (normalizedPath.startsWith(`${folder}/`)) result.add(normalizedPath);
		}
	}
	if (communityPluginsSync === "device-local") {
		result.add(`${normalizedConfigDir}/community-plugins.json`);
	}
	return [...result].sort((a, b) => a.localeCompare(b));
}

function normalizePattern(pattern: string): string {
	return String(pattern).replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function normalizePathSegment(path: string): string {
	const normalized = normalizePattern(path).replace(/^\/+|\/+$/g, "");
	const parts = normalized.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return "";
	return parts.join("/");
}

function isSafePluginId(id: string): boolean {
	const normalized = normalizePattern(id);
	return normalized.length > 0 &&
		normalized === id &&
		!normalized.includes("/") &&
		!/[\0\r\n*?]/.test(normalized) &&
		!normalized.includes("[") &&
		!normalized.includes("]") &&
		!hasUnsafePathSegment(normalized);
}

function hasUnsafePathSegment(path: string): boolean {
	return path.split("/").some((part) =>
		part === "." ||
		part === ".." ||
		part === ".git" ||
		part.includes("*") ||
		part.includes("?") ||
		part.includes("[") ||
		part.includes("]") ||
		[...part].some((character) => {
			const code = character.charCodeAt(0);
			return code < 0x20 || code === 0x7f;
		})
	);
}
