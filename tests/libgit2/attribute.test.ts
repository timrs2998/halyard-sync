/**
 * Real, end-to-end tests for `Libgit2Repository.listPathsWithAttribute()` in
 * `src/git/libgit2/engine.ts`, run against the real compiled
 * `build/dist/tether-libgit2.{js,wasm}` module — same artifact/mount pattern
 * as `tests/libgit2/engine.test.ts` and `tests/libgit2/merge.test.ts`.
 * Skipped (not failed) when the compiled module doesn't exist.
 *
 * This is the libgit2-side equivalent of the still-live isomorphic-git
 * `GitEngine.detectUnsupportedFilters()` (see `src/git/engine.ts` and
 * `src/git/gitcrypt.ts`'s consumer of that shape) — the mechanism a later,
 * separate phase will use to detect `.gitattributes` `filter=` declarations
 * against this engine instead of isomorphic-git's index.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { wrapLibgit2Module, type Libgit2ModuleFactory } from "../../src/git/libgit2/engine";
import type { RequestUrlLike } from "../../src/git/http-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const MODULE_JS = join(__dirname, "..", "..", "src", "git", "libgit2", "build", "dist", "tether-libgit2.js");

function loadFactory(): Libgit2ModuleFactory | null {
	try {
		const mod = require(MODULE_JS);
		return typeof mod === "function" ? mod : mod.default;
	} catch {
		return null;
	}
}

const factory = loadFactory();

const unusedRequestUrl: RequestUrlLike = async () => {
	throw new Error("attribute.test.ts never performs network operations");
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function freshModule(mountDir: string): Promise<any> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const Module: any = await factory!();
	Module.FS.mkdir("/repo");
	Module.FS.mount(Module.NODEFS, { root: mountDir }, "/repo");
	return Module;
}

const AUTHOR = { name: "Test", email: "test@example.com" };

describe.skipIf(factory === null)(
	"engine.ts Libgit2Repository.listPathsWithAttribute() (real, against the compiled module)",
	() => {
		it("returns exactly the paths whose gitattributes-resolved value matches, not a blanket match", async () => {
			const dir = mkdtempSync(join(tmpdir(), "tether-attr-"));
			const Module = await freshModule(dir);
			const git2 = await wrapLibgit2Module(Module, { requestUrl: unusedRequestUrl });
			const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

			Module.FS.writeFile(
				"/repo/.gitattributes",
				"secret.txt filter=git-crypt\nother.txt filter=git-lfs\n"
			);
			Module.FS.writeFile("/repo/secret.txt", "ciphertext-ish\n");
			Module.FS.writeFile("/repo/other.txt", "lfs pointer-ish\n");
			Module.FS.writeFile("/repo/plain.txt", "nothing special\n");

			await repo.stagePath(".gitattributes");
			await repo.stagePath("secret.txt");
			await repo.stagePath("other.txt");
			await repo.stagePath("plain.txt");
			await repo.commit("add files with gitattributes", AUTHOR);

			const filterResults = await repo.listPathsWithAttribute("filter");
			const byPath = Object.fromEntries(filterResults.map((r) => [r.path, r.value]));

			expect(byPath["secret.txt"]).toBe("git-crypt");
			expect(byPath["other.txt"]).toBe("git-lfs");
			// Not a blanket "any gitattributes present" answer: plain.txt has no
			// `filter=` declaration at all and must not appear.
			expect(byPath["plain.txt"]).toBeUndefined();
			expect(byPath[".gitattributes"]).toBeUndefined();
			expect(filterResults.length).toBe(2);

			// A genuinely different attribute name that nothing declares at all
			// must come back empty — proves this isn't secretly keying off
			// "filter" as a magic string either.
			const noSuchAttr = await repo.listPathsWithAttribute("no-such-attribute");
			expect(noSuchAttr).toEqual([]);

			await repo.close();
		});

		it("an empty repo (no .gitattributes at all) returns no matches", async () => {
			const dir = mkdtempSync(join(tmpdir(), "tether-attr-empty-"));
			const Module = await freshModule(dir);
			const git2 = await wrapLibgit2Module(Module, { requestUrl: unusedRequestUrl });
			const repo = await git2.init({ dir: "/repo", defaultBranch: "main" });

			Module.FS.writeFile("/repo/a.txt", "hello\n");
			await repo.stagePath("a.txt");
			await repo.commit("just a file", AUTHOR);

			expect(await repo.listPathsWithAttribute("filter")).toEqual([]);

			await repo.close();
		});
	}
);
