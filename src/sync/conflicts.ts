/**
 * Conflict strategies (see DESIGN.md "Conflict strategies").
 *
 * The invariant across all strategies: local commits are never lost without
 * an explicit user decision. `prBranch` parks them on a pushed remote
 * branch before the vault converges to upstream; `discardLocal` requires
 * the caller to have confirmed with the user; `keepLocal` changes nothing.
 */

import type { ForgeProvider } from "../auth/providers";

export type ConflictStrategyName = "prBranch" | "discardLocal" | "keepLocal";

export const DEFAULT_CONFLICT_STRATEGY: ConflictStrategyName = "prBranch";

// ---------------------------------------------------------------------------
// Naming (pure)
// ---------------------------------------------------------------------------

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local time, filesystem/ref-safe: "20260719-142305". */
export function formatConflictTimestamp(d: Date): string {
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	);
}

/** Strip anything that is not valid in a git ref component. */
function sanitizeRefComponent(name: string): string {
	const cleaned = name
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "");
	return cleaned.length > 0 ? cleaned : "device";
}

export function conflictBranchName(deviceName: string, when: Date): string {
	return `sync-conflict/${sanitizeRefComponent(deviceName)}-${formatConflictTimestamp(when)}`;
}

/**
 * Default device name: platform label + random 4-char suffix. Generated
 * once by the caller and persisted in settings (the suffix keeps two
 * devices of the same kind from colliding on branch names).
 */
export function generateDeviceName(
	isMobile: boolean,
	random: () => number = Math.random
): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let suffix = "";
	for (let i = 0; i < 4; i++) {
		const idx = Math.min(alphabet.length - 1, Math.floor(random() * alphabet.length));
		suffix += alphabet[idx];
	}
	return `${isMobile ? "mobile" : "desktop"}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Structural subset of GitEngine the strategies need. */
export interface ConflictEngine {
	push(options?: { ref?: string; remoteRef?: string; force?: boolean }): Promise<unknown>;
	fetch(branch: string): Promise<unknown>;
	hardResetToRemote(branch: string): Promise<string>;
}

export type ConflictResult =
	| {
			kind: "resolved";
			message: string;
			/** Set when a PR/MR was created. */
			prUrl?: string;
			/** Conflict branch name, when one was pushed. */
			branch?: string;
			/** True when the branch was pushed but PR creation failed/unavailable. */
			degraded?: boolean;
	  }
	| { kind: "manual"; message: string };

export interface ConflictResolverOptions {
	engine: ConflictEngine;
	provider: () => Pick<ForgeProvider, "createPullRequest"> | null;
	getToken: () => Promise<string | null>;
	branch: () => string;
	deviceName: () => string;
	repoPath: () => string;
	/** keepLocal pauses auto-sync via this hook. */
	pauseAutoSync: () => void;
	now?: () => Date;
}

/** Shared cap on how many conflicting files are listed in UI/PR text. */
export const MAX_CONFLICT_FILES_SHOWN = 20;

function formatFileList(files: string[], limit = MAX_CONFLICT_FILES_SHOWN): string {
	if (files.length === 0) return "(file list unavailable)";
	const shown = files.slice(0, limit).map((f) => `- ${f}`);
	if (files.length > limit) shown.push(`- …and ${files.length - limit} more`);
	return shown.join("\n");
}

export class ConflictResolver {
	constructor(private readonly opts: ConflictResolverOptions) {}

	async apply(strategy: ConflictStrategyName, files: string[]): Promise<ConflictResult> {
		switch (strategy) {
			case "prBranch":
				return this.prBranch(files);
			case "discardLocal": {
				// Caller is responsible for having confirmed with the user. Fetch
				// first so the reset target is the CURRENT remote, not whatever
				// stale tracking ref is left over from the last sync — the user
				// may have taken time to decide while the modal was open.
				const branch = this.opts.branch();
				await this.opts.engine.fetch(branch);
				await this.opts.engine.hardResetToRemote(branch);
				return {
					kind: "resolved",
					message: "Local changes discarded — the vault now matches the remote.",
				};
			}
			case "keepLocal":
				this.opts.pauseAutoSync();
				return {
					kind: "manual",
					message:
						"Auto-sync paused with your local changes kept. Resolve the " +
						"conflict later from the status bar or command palette.",
				};
		}
	}

	private async prBranch(files: string[]): Promise<ConflictResult> {
		const branch = this.opts.branch();
		const device = this.opts.deviceName();
		const when = (this.opts.now ?? (() => new Date()))();
		const conflictBranch = conflictBranchName(device, when);

		// Push FIRST: once local commits exist on the remote branch, nothing
		// below can lose data. If this throws, the orchestrator lands in the
		// error state with the vault untouched.
		await this.opts.engine.push({
			ref: branch,
			remoteRef: `refs/heads/${conflictBranch}`,
		});

		let prUrl: string | undefined;
		let degradedReason: string | null = null;
		try {
			const provider = this.opts.provider();
			const token = await this.opts.getToken();
			if (provider === null) {
				degradedReason = "no provider configured";
			} else if (token === null) {
				degradedReason = "no access token available";
			} else {
				const pr = await provider.createPullRequest(
					{
						repoPath: this.opts.repoPath(),
						sourceBranch: conflictBranch,
						targetBranch: branch,
						title: `Vault sync conflict from ${device}`,
						body:
							`Automatic conflict branch created by Halyard Sync on ` +
							`${device} at ${when.toISOString()}.\n\n` +
							`Conflicting files:\n${formatFileList(files)}\n\n` +
							`Merge this branch to keep those changes; close it to drop them.`,
					},
					token
				);
				if (pr === null) {
					degradedReason = "this git host cannot create pull requests";
				} else {
					prUrl = pr.url;
				}
			}
		} catch (err) {
			degradedReason = err instanceof Error ? err.message : String(err);
		}

		// Converge the vault to upstream — fetch first since time may have
		// passed while the PR was being created, then reset to the current
		// remote. Local work is safe on the remote branch regardless of
		// whether the PR was created.
		await this.opts.engine.fetch(branch);
		await this.opts.engine.hardResetToRemote(branch);

		if (prUrl !== undefined) {
			return {
				kind: "resolved",
				message:
					`Conflicting changes moved to branch '${conflictBranch}' and a ` +
					`pull request was opened. The vault now follows the remote.`,
				prUrl,
				branch: conflictBranch,
			};
		}
		return {
			kind: "resolved",
			message:
				`Conflicting changes were pushed to branch '${conflictBranch}', but a ` +
				`pull request could not be created (${degradedReason ?? "unknown"}). ` +
				`Open a PR/MR for that branch manually to merge them back.`,
			branch: conflictBranch,
			degraded: true,
		};
	}
}
