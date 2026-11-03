import { describe, expect, it, vi } from "vitest";
import { VaultMirror, VaultMirrorError } from "../../src/git/libgit2/fs-backend";
import { MockAdapter } from "../helpers/mock-adapter";

describe("VaultMirror path normalization", () => {
	it("treats root, '/', '.' consistently via toAdapterPath", () => {
		const mirror = new VaultMirror();
		mirror.writeFile("/a.txt", new Uint8Array([1]));
		expect(mirror.readdir("/")).toEqual(["a.txt"]);
		expect(mirror.readdir(".")).toEqual(["a.txt"]);
		expect(mirror.readdir("")).toEqual(["a.txt"]);
	});

	it("collapses backslashes and dot segments", () => {
		const mirror = new VaultMirror();
		mirror.writeFile("notes\\a.md", new Uint8Array([1]));
		expect(mirror.has("notes/a.md")).toBe(true);
		expect(mirror.has("notes//./a.md")).toBe(true);
	});
});

describe("VaultMirror writes", () => {
	it("writeFile implicitly creates parent directories", () => {
		const mirror = new VaultMirror();
		mirror.writeFile("deep/nested/f.bin", new Uint8Array([1, 2, 3]));
		expect(mirror.has("deep")).toBe(true);
		expect(mirror.has("deep/nested")).toBe(true);
		expect(mirror.stat("deep").isDirectory).toBe(true);
		expect([...mirror.readFile("deep/nested/f.bin")]).toEqual([1, 2, 3]);
	});

	it("copies the input buffer (mutating the caller's array afterward has no effect)", () => {
		const mirror = new VaultMirror();
		const data = new Uint8Array([9, 9]);
		mirror.writeFile("f.bin", data);
		data[0] = 0;
		expect([...mirror.readFile("f.bin")]).toEqual([9, 9]);
	});

	it("throws EISDIR when writing over an existing directory", () => {
		const mirror = new VaultMirror();
		mirror.mkdir("dir");
		expect(() => mirror.writeFile("dir", new Uint8Array(0))).toThrow(VaultMirrorError);
		try {
			mirror.writeFile("dir", new Uint8Array(0));
		} catch (err) {
			expect((err as VaultMirrorError).code).toBe("EISDIR");
		}
	});
});

describe("VaultMirror mkdir", () => {
	it("tolerates an existing directory", () => {
		const mirror = new VaultMirror();
		mirror.mkdir("dir");
		expect(() => mirror.mkdir("dir")).not.toThrow();
	});

	it("throws EEXIST when the path is a file", () => {
		const mirror = new VaultMirror();
		mirror.writeFile("a.txt", new Uint8Array(0));
		expect(() => mirror.mkdir("a.txt")).toThrow(
			expect.objectContaining({ code: "EEXIST" })
		);
	});
});

describe("VaultMirror unlink/rmdir", () => {
	it("removes a file", () => {
		const mirror = new VaultMirror();
		mirror.writeFile("a.txt", new Uint8Array(0));
		mirror.unlink("a.txt");
		expect(mirror.has("a.txt")).toBe(false);
	});

	it("throws ENOENT unlinking a missing file", () => {
		const mirror = new VaultMirror();
		expect(() => mirror.unlink("nope")).toThrow(
			expect.objectContaining({ code: "ENOENT" })
		);
	});

	it("throws EISDIR unlinking a directory", () => {
		const mirror = new VaultMirror();
		mirror.mkdir("dir");
		expect(() => mirror.unlink("dir")).toThrow(
			expect.objectContaining({ code: "EISDIR" })
		);
	});

	it("removes an empty directory", () => {
		const mirror = new VaultMirror();
		mirror.mkdir("dir");
		mirror.rmdir("dir");
		expect(mirror.has("dir")).toBe(false);
	});

	it("throws ENOTEMPTY for a non-empty directory", () => {
		const mirror = new VaultMirror();
		mirror.writeFile("dir/f.txt", new Uint8Array(0));
		expect(() => mirror.rmdir("dir")).toThrow(
			expect.objectContaining({ code: "ENOTEMPTY" })
		);
	});

	it("throws ENOTDIR when rmdir targets a file", () => {
		const mirror = new VaultMirror();
		mirror.writeFile("a.txt", new Uint8Array(0));
		expect(() => mirror.rmdir("a.txt")).toThrow(
			expect.objectContaining({ code: "ENOTDIR" })
		);
	});
});

describe("VaultMirror rename", () => {
	it("moves a file to a new path, creating parents", () => {
		const mirror = new VaultMirror();
		mirror.writeFile("a.txt", new Uint8Array([7]));
		mirror.rename("a.txt", "sub/b.txt");
		expect(mirror.has("a.txt")).toBe(false);
		expect([...mirror.readFile("sub/b.txt")]).toEqual([7]);
	});

	it("throws ENOENT renaming a missing path", () => {
		const mirror = new VaultMirror();
		expect(() => mirror.rename("nope", "x")).toThrow(
			expect.objectContaining({ code: "ENOENT" })
		);
	});
});

describe("VaultMirror readdir", () => {
	it("lists only direct children, not nested descendants", () => {
		const mirror = new VaultMirror();
		mirror.writeFile("a/b/c.txt", new Uint8Array(0));
		mirror.writeFile("a/d.txt", new Uint8Array(0));
		expect(mirror.readdir("a").sort()).toEqual(["b", "d.txt"]);
	});

	it("throws ENOENT for a missing directory", () => {
		const mirror = new VaultMirror();
		expect(() => mirror.readdir("missing")).toThrow(
			expect.objectContaining({ code: "ENOENT" })
		);
	});
});

describe("VaultMirror symlink surface", () => {
	it("symlink and readlink both throw ENOSYS", () => {
		const mirror = new VaultMirror();
		expect(() => mirror.symlink("target", "link")).toThrow(
			expect.objectContaining({ code: "ENOSYS" })
		);
		expect(() => mirror.readlink("link")).toThrow(
			expect.objectContaining({ code: "ENOSYS" })
		);
	});
});

describe("VaultMirror <-> DataAdapterLike hydrate/flush", () => {
	it("hydrateAll mirrors an adapter's whole tree, including nested folders", async () => {
		const adapter = new MockAdapter();
		await adapter.mkdir(".git/objects");
		await adapter.write(".git/HEAD", "ref: refs/heads/main");
		await adapter.write("note.md", "hello");

		const mirror = new VaultMirror();
		await mirror.hydrateAll(adapter);

		expect(mirror.has(".git/objects")).toBe(true);
		expect(mirror.stat(".git/objects").isDirectory).toBe(true);
		expect(new TextDecoder().decode(mirror.readFile(".git/HEAD"))).toBe(
			"ref: refs/heads/main"
		);
		expect(new TextDecoder().decode(mirror.readFile("note.md"))).toBe("hello");
	});

	it("hydrateFile picks up mtime/ctime from adapter.stat", async () => {
		const adapter = new MockAdapter();
		await adapter.write("a.txt", "x");
		const mirror = new VaultMirror();
		await mirror.hydrateFile(adapter, "a.txt");
		const st = mirror.stat("a.txt");
		// MockAdapter.stat() always reports ctime 1000 / mtime 2000.
		expect(st.ctimeMs).toBe(1000);
		expect(st.mtimeMs).toBe(2000);
	});

	it("flush writes only dirty files back to the adapter", async () => {
		const adapter = new MockAdapter();
		await adapter.write("a.txt", "original");
		const mirror = new VaultMirror();
		await mirror.hydrateAll(adapter);

		// Not modified after hydration -> flush should not rewrite it.
		await mirror.flush(adapter);
		expect(adapter.log.filter((entry) => entry[0] === "writeBinary")).toHaveLength(0);

		mirror.writeFile("a.txt", new TextEncoder().encode("changed"));
		mirror.writeFile("new/b.txt", new TextEncoder().encode("new file"));
		await mirror.flush(adapter);

		expect(await adapter.read("a.txt")).toBe("changed");
		expect(await adapter.read("new/b.txt")).toBe("new file");
	});

	it("flush removes files deleted in the mirror from the adapter", async () => {
		const adapter = new MockAdapter();
		await adapter.write("a.txt", "x");
		await adapter.write("b.txt", "y");
		const mirror = new VaultMirror();
		await mirror.hydrateAll(adapter);

		mirror.unlink("a.txt");
		await mirror.flush(adapter);

		expect(adapter.files.has("a.txt")).toBe(false);
		expect(adapter.files.has("b.txt")).toBe(true);
	});

	it("round-trips through a fresh mirror after flush", async () => {
		const adapter = new MockAdapter();
		const mirror = new VaultMirror();
		mirror.writeFile("sub/deep/file.md", new TextEncoder().encode("content"));
		await mirror.flush(adapter);

		const mirror2 = new VaultMirror();
		await mirror2.hydrateAll(adapter);
		expect(new TextDecoder().decode(mirror2.readFile("sub/deep/file.md"))).toBe(
			"content"
		);
	});

	it("yields to the event loop periodically during a large hydrate, without losing any files", async () => {
		const adapter = new MockAdapter();
		for (let i = 0; i < 450; i++) {
			await adapter.write(`note-${i}.md`, "x");
		}
		const mirror = new VaultMirror();

		vi.useFakeTimers();
		try {
			const setTimeoutSpy = vi.spyOn(window, "setTimeout");
			const hydrate = mirror.hydrateAll(adapter);
			await vi.runAllTimersAsync();
			await hydrate;
			// 450 files, yielding every 200 -> real timer-based yields at
			// file #200 and #400 (the other 448 calls take the "resolve
			// immediately" branch and never touch setTimeout at all).
			expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}

		expect(mirror.readdir("").filter((n) => n.startsWith("note-"))).toHaveLength(450);
	});

	it("yields to the event loop periodically during a large flush", async () => {
		const adapter = new MockAdapter();
		const mirror = new VaultMirror();
		for (let i = 0; i < 450; i++) {
			mirror.writeFile(`note-${i}.md`, new TextEncoder().encode("x"));
		}

		vi.useFakeTimers();
		try {
			const setTimeoutSpy = vi.spyOn(window, "setTimeout");
			const flush = mirror.flush(adapter);
			await vi.runAllTimersAsync();
			await flush;
			expect(setTimeoutSpy).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}

		expect(adapter.files.size).toBe(450);
	});
});

describe("VaultMirror.refresh (incremental re-hydration)", () => {
	const text = (m: VaultMirror, p: string) => new TextDecoder().decode(m.readFile(p));
	const reads = (a: MockAdapter) => a.log.filter((e) => e[0] === "readBinary").map((e) => e[1]);

	class CountingAdapter extends MockAdapter {
		async readBinary(path: string): Promise<ArrayBuffer> {
			this.log.push(["readBinary", path]);
			return super.readBinary(path);
		}
	}

	it("re-reads only files whose size or mtime changed", async () => {
		const adapter = new CountingAdapter();
		await adapter.mkdir(".git");
		await adapter.write(".git/HEAD", "ref: refs/heads/main");
		await adapter.write("a.md", "aaa");
		await adapter.write("b.md", "bbb");
		const mirror = new VaultMirror();
		await mirror.hydrateAll(adapter);

		await adapter.write("b.md", "BBB"); // same size, newer mtime
		await adapter.write("c.md", "new");
		adapter.log.length = 0;
		const r = await mirror.refresh(adapter);

		expect(reads(adapter).sort()).toEqual(["b.md", "c.md"]);
		expect(r).toMatchObject({ read: 2, kept: 2 });
		expect(text(mirror, "a.md")).toBe("aaa");
		expect(text(mirror, "b.md")).toBe("BBB");
		expect(text(mirror, "c.md")).toBe("new");
	});

	it("drops files and folders deleted from the adapter, like reset() + hydrateAll()", async () => {
		const adapter = new MockAdapter();
		await adapter.mkdir("dir");
		await adapter.write("dir/x.md", "x");
		await adapter.write("keep.md", "k");
		const mirror = new VaultMirror();
		await mirror.hydrateAll(adapter);

		await adapter.remove("dir/x.md");
		await adapter.rmdir("dir", true);
		await mirror.refresh(adapter);

		expect(mirror.has("dir/x.md")).toBe(false);
		expect(mirror.has("dir")).toBe(false);
		expect(mirror.readdir("")).toEqual(["keep.md"]);
	});

	it("throws away unflushed git work the way reset() did", async () => {
		const adapter = new MockAdapter();
		await adapter.write("a.md", "disk");
		const mirror = new VaultMirror();
		await mirror.hydrateAll(adapter);

		mirror.writeFile("a.md", new TextEncoder().encode("git"));
		mirror.writeFile("only-in-git.md", new TextEncoder().encode("g"));
		mirror.unlink("a.md");
		mirror.writeFile("a.md", new TextEncoder().encode("git again"));
		await mirror.refresh(adapter);

		expect(text(mirror, "a.md")).toBe("disk");
		expect(mirror.has("only-in-git.md")).toBe(false);
		await mirror.flush(adapter);
		expect(adapter.log.filter((e) => e[0] === "writeBinary" || e[0] === "remove")).toHaveLength(0);
	});

	it("leaves the mirror exactly as a fresh hydrate would", async () => {
		const adapter = new MockAdapter();
		await adapter.mkdir("n");
		await adapter.mkdir("n/empty");
		await adapter.write("n/1.md", "one");
		await adapter.write("2.md", "two");
		const mirror = new VaultMirror();
		await mirror.hydrateAll(adapter);
		await adapter.write("n/1.md", "uno!");
		await adapter.remove("2.md");
		await adapter.mkdir("m");
		await adapter.write("m/3.md", "three");
		await mirror.refresh(adapter);

		const fresh = new VaultMirror();
		await fresh.hydrateAll(adapter);
		const snapshot = (m: VaultMirror, dir = ""): unknown =>
			m.readdir(dir).sort().map((name) => {
				const p = dir === "" ? name : `${dir}/${name}`;
				const st = m.stat(p);
				return st.isDirectory ? [name, snapshot(m, p)] : [name, text(m, p), st.mtimeMs];
			});
		expect(snapshot(mirror)).toEqual(snapshot(fresh));
	});
});
