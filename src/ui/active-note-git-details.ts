/** Pure view-model helpers for the active-note Git details section. */

import type { ActiveNoteGitDetailsResult, CommitMetadata } from "../git/engine";
import { parseSyncCommitAttribution } from "../sync/commit-message";

export type ActiveNoteGitDetailsPanelState =
	| { kind: "not-applicable" }
	| { kind: "loading"; path: string }
	| ActiveNoteGitDetailsResult;

export interface ActiveNoteGitDetailsRow {
	label: string;
	value: string;
	/** A value the renderer can offer through a copy button. */
	copyValue?: string;
	copyLabel?: string;
}

export interface ActiveNoteGitDetailsViewModel {
	kind: ActiveNoteGitDetailsPanelState["kind"];
	path: string | null;
	message: string;
	rows: ActiveNoteGitDetailsRow[];
	commitMessage: string | null;
}

function commitAuthor(commit: CommitMetadata): string {
	if (commit.authorName && commit.authorEmail) return `${commit.authorName} <${commit.authorEmail}>`;
	return commit.authorName || commit.authorEmail || "Unknown author";
}

function commitSource(commit: CommitMetadata): string {
	const attribution = parseSyncCommitAttribution(commit.message);
	if (attribution.deviceName && attribution.platform) {
		return `${attribution.deviceName} (${attribution.platform})`;
	}
	if (attribution.deviceName) return attribution.deviceName;
	if (attribution.platform) return `${attribution.platform} (device unavailable)`;
	return "Unavailable (older or non-Halyard commit)";
}

function commitSubject(message: string): string {
	const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return subject || "No commit message";
}

export function shortCommitHash(oid: string): string {
	return oid.slice(0, 7);
}

export function buildActiveNoteGitDetailsViewModel(
	state: ActiveNoteGitDetailsPanelState
): ActiveNoteGitDetailsViewModel {
	switch (state.kind) {
		case "not-applicable":
			return {
				kind: state.kind,
				path: null,
				message: "Open a Markdown note to view its Git history.",
				rows: [],
				commitMessage: null,
			};
		case "loading":
			return {
				kind: state.kind,
				path: state.path,
				message: "Checking Git history…",
				rows: [],
				commitMessage: null,
			};
		case "available": {
				const commit = state.commit;
				return {
					kind: state.kind,
					path: state.path,
					message: "Latest committed version",
					rows: [
						{ label: "Timestamp", value: new Date(commit.timestamp * 1000).toLocaleString() },
						{ label: "Author", value: commitAuthor(commit) },
						{
							label: "Commit",
							value: shortCommitHash(commit.oid),
							copyValue: commit.oid,
							copyLabel: "Copy full commit hash",
						},
						{ label: "Source", value: commitSource(commit) },
					],
					commitMessage: commitSubject(commit.message),
				};
			}
		case "untracked":
		case "no-history":
		case "unavailable":
		case "error":
			return {
				kind: state.kind,
				path: "path" in state ? state.path : null,
				message: state.message,
				rows: [],
				commitMessage: null,
			};
	}
}
