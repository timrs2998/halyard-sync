// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"node_modules/**",
			"main.js",
			// Compiled Emscripten glue, not authored source — see
			// src/git/libgit2/README.md's "compiled output vs authored source".
			"src/git/libgit2/build/dist/**",
			"src/git/libgit2/build/.build-work/**",
			".obsidian-cache/**",
		],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			// tsconfig's noUnusedLocals/noUnusedParameters already cover this,
			// with the compiler's own leading-underscore convention for
			// intentionally-unused parameters — avoid a second, differently
			// configured copy of the same check disagreeing with it.
			"@typescript-eslint/no-unused-vars": "off",
			// TypeScript's own checker (with this project's lib/types config)
			// already catches genuinely undefined identifiers more accurately
			// than this rule can for ambient globals — the typescript-eslint
			// project's own documented recommendation.
			"no-undef": "off",
		},
	}
);
