import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Scope discovery to this project's own tests. Vitest's default glob is
		// repo-wide and does not consult .gitignore, so it otherwise picks up
		// third-party test files that land inside the tree — notably
		// src/git/libgit2/build/.build-work/, the emsdk + libgit2 clone
		// build.sh creates, which ships Emscripten's own *.test.js suites.
		//
		// That directory is gitignored and BUILD.md's documented build command
		// keeps it in a Docker named volume, so it only appears in the tree when
		// build.sh runs directly in the workspace — which is exactly what CI's
		// build-wasm job does.
		include: ["tests/**/*.test.ts"],
	},
});
