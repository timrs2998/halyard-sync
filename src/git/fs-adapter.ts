/**
 * Structural DataAdapter types + path normalization shared across the git
 * layer (`fs-backend.ts`'s `VaultMirror`, `main.ts`'s WASM/`.gitignore`
 * plumbing). The vault is driven through `VaultMirror` (an in-memory mirror
 * mounted into the compiled libgit2-WASM module's filesystem — see that
 * file's header comment for why: libgit2's C entry points are synchronous
 * while `DataAdapter` is Promise-based), not through this file.
 *
 * The DataAdapter operates below Obsidian's vault index, so it can read and
 * write dotfiles like `.git/` that the rest of the Obsidian API hides.
 *
 * No value imports from 'obsidian': the adapter is described structurally so
 * unit tests can inject a plain mock object.
 */

/** Structural subset of Obsidian's DataAdapter `stat` result. */
export interface AdapterStatLike {
	type: "file" | "folder";
	ctime: number;
	mtime: number;
	size: number;
}

/** Structural subset of Obsidian's DataAdapter that this shim needs. */
export interface DataAdapterLike {
	exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
	stat(normalizedPath: string): Promise<AdapterStatLike | null>;
	list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }>;
	read(normalizedPath: string): Promise<string>;
	readBinary(normalizedPath: string): Promise<ArrayBuffer>;
	write(normalizedPath: string, data: string): Promise<void>;
	writeBinary(normalizedPath: string, data: ArrayBuffer): Promise<void>;
	mkdir(normalizedPath: string): Promise<void>;
	remove(normalizedPath: string): Promise<void>;
	rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
}

/**
 * Normalize any path handed to us into a vault-relative DataAdapter path:
 * forward slashes, no leading slash, '.'/'..' segments resolved. The vault
 * root is "/" (Obsidian's normalized root path).
 */
export function toAdapterPath(input: string): string {
	const raw = String(input).replace(/\\/g, "/");
	const parts = raw.split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			out.pop();
			continue;
		}
		out.push(part);
	}
	return out.length > 0 ? out.join("/") : "/";
}
