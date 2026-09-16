/** Pure helpers for owner-scoped external ignore claims. */

export interface ManagedIgnoreClaim {
	label: string;
	patterns: string[];
}

/** User patterns and managed claims intentionally stay separate in storage. */
export function effectiveIgnoreGlobs(
	userGlobs: readonly string[],
	managedIgnoreClaims: Record<string, ManagedIgnoreClaim>
): string[] {
	return [...new Set([
		...userGlobs,
		...Object.values(managedIgnoreClaims).flatMap((claim) => claim.patterns),
	])];
}

/** Returns user/other-owner patterns that overlap a generated destination. */
export function findExcludingPatterns(
	targetPatterns: readonly string[],
	userPatterns: readonly string[],
	managedPatterns: readonly string[]
): string[] {
	const targets = targetPatterns.map(normalizeIgnorePattern).filter((target) => target.length > 0);
	return [...new Set([...userPatterns, ...managedPatterns].filter((pattern) =>
		targets.some((target) => patternExcludesPath(pattern, target))
	))];
}

function normalizeIgnorePattern(pattern: string): string {
	return pattern.replace(/\\/g, "/").replace(/^\.?\//, "").trim();
}

function patternExcludesPath(pattern: string, target: string): boolean {
	const normalized = normalizeIgnorePattern(pattern);
	if (normalized.length === 0) return false;
	const candidates = [target, target.endsWith("/") ? `${target}generated.md` : `${target}/generated.md`];
	return candidates.some((candidate) => {
		if (normalized.startsWith("*")) return candidate.endsWith(normalized.slice(1));
		if (normalized.endsWith("*")) return candidate.startsWith(normalized.slice(0, -1));
		return candidate.startsWith(normalized);
	});
}
