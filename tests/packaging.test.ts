/**
 * Build-artifact checks: what the release actually contains.
 *
 * These assert facts about files on the developer's disk, not behaviour inside
 * Obsidian, so they belong in the Node-side suite rather than in `e2e/`. That
 * placement is deliberate twice over: `e2e/` is scanned by the plugin portal's
 * review, which flags Node built-in imports there (Node APIs do not exist on
 * mobile — a rule aimed at plugin code, and one worth honouring literally in
 * every directory the review reads rather than silenced with an override).
 *
 * The companion check — that a real three-file install still builds a working
 * engine — stays in `e2e/specs/libgit2-loader.e2e.ts`, where a real Obsidian
 * is doing the loading.
 */

import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WASM = join(ROOT, "src", "git", "libgit2", "build", "dist", "tether-libgit2.wasm");
const MAIN_JS = join(ROOT, "main.js");

// main.js is a build output, not committed — a fresh checkout that has not run
// `npm run build` has nothing to measure.
describe.skipIf(!existsSync(MAIN_JS))("plugin packaging", () => {
	it("embeds the wasm binary in main.js rather than shipping it alongside", () => {
		// Obsidian's community installer and BRAT deliver exactly main.js,
		// manifest.json and styles.css; a sibling .wasm never arrives, which is
		// why the binary is base64-embedded (see libgit2/wasm-binary.ts). The
		// base64 embed makes main.js roughly the binary's size plus a third, so
		// a main.js smaller than the binary means the embed was dropped and
		// installs would regress to ENOENT at first sync.
		expect(statSync(MAIN_JS).size).toBeGreaterThan(statSync(WASM).size);
	});
});
