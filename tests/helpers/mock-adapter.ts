import type {
	AdapterStatLike,
	DataAdapterLike,
} from "../../src/git/fs-adapter";

/**
 * In-memory mock of Obsidian's DataAdapter. Mirrors the real behaviors the
 * shim depends on: vault-relative paths, `list` returning FULL paths,
 * `stat` returning null for missing entries, generic (uncoded) errors.
 */
export class MockAdapter implements DataAdapterLike {
	files = new Map<string, Uint8Array>();
	folders = new Set<string>();
	log: Array<[string, ...unknown[]]> = [];

	private assertParent(path: string): void {
		const idx = path.lastIndexOf("/");
		if (idx === -1) return;
		const parent = path.slice(0, idx);
		if (!this.folders.has(parent)) {
			throw new Error(`Folder does not exist: ${parent}`);
		}
	}

	async exists(path: string): Promise<boolean> {
		return path === "/" || this.files.has(path) || this.folders.has(path);
	}

	async stat(path: string): Promise<AdapterStatLike | null> {
		if (this.files.has(path)) {
			return {
				type: "file",
				ctime: 1000,
				mtime: 2000,
				size: this.files.get(path)!.byteLength,
			};
		}
		if (path === "/" || this.folders.has(path)) {
			return { type: "folder", ctime: 1000, mtime: 2000, size: 0 };
		}
		return null;
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path === "/" ? "" : `${path}/`;
		const isChild = (p: string) =>
			p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
		return {
			// Real adapters return full vault-relative paths, not names.
			files: [...this.files.keys()].filter(isChild),
			folders: [...this.folders].filter(isChild),
		};
	}

	async read(path: string): Promise<string> {
		const data = this.files.get(path);
		if (data === undefined) throw new Error(`File does not exist: ${path}`);
		return new TextDecoder().decode(data);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.files.get(path);
		if (data === undefined) throw new Error(`File does not exist: ${path}`);
		return data.slice().buffer as ArrayBuffer;
	}

	async write(path: string, data: string): Promise<void> {
		this.log.push(["write", path]);
		this.assertParent(path);
		this.files.set(path, new TextEncoder().encode(data));
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.log.push(["writeBinary", path]);
		this.assertParent(path);
		this.files.set(path, new Uint8Array(data));
	}

	async mkdir(path: string): Promise<void> {
		this.log.push(["mkdir", path]);
		// Real adapters create intermediate folders.
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			this.folders.add(parts.slice(0, i).join("/"));
		}
	}

	async remove(path: string): Promise<void> {
		this.log.push(["remove", path]);
		if (!this.files.delete(path)) {
			throw new Error(`File does not exist: ${path}`);
		}
	}

	async rmdir(path: string, recursive: boolean): Promise<void> {
		this.log.push(["rmdir", path, recursive]);
		if (!this.folders.has(path)) {
			throw new Error(`Folder does not exist: ${path}`);
		}
		this.folders.delete(path);
		if (recursive) {
			for (const f of [...this.files.keys()]) {
				if (f.startsWith(`${path}/`)) this.files.delete(f);
			}
			for (const d of [...this.folders]) {
				if (d.startsWith(`${path}/`)) this.folders.delete(d);
			}
		}
	}
}
