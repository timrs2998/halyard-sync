/**
 * Minimal, read-only `.git/config` parsing — just enough to pull
 * `remote.<name>.url` out of an existing repo's config text for the setup
 * wizard's prepopulation hint (see `main.ts`'s `detectExistingRemoteUrl`).
 * Not a general INI parser: no multi-line values, no `include`/`includeIf`
 * directives, no quote-escaping beyond what a plain `git remote add` (or
 * libgit2's equivalent `git_remote_create`) ever writes.
 */
export function parseGitConfigRemoteUrl(configText: string, remoteName: string): string | null {
	const sectionHeader = /^\[remote\s+"([^"]+)"\]$/;
	let inTargetSection = false;
	for (const rawLine of configText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith("[")) {
			const match = sectionHeader.exec(line);
			inTargetSection = match !== null && match[1] === remoteName;
			continue;
		}
		if (!inTargetSection) continue;
		const urlMatch = /^url\s*=\s*(.+)$/.exec(line);
		if (urlMatch) return urlMatch[1].trim();
	}
	return null;
}
