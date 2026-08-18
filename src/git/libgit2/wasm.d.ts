/** esbuild's base64 loader turns a `.wasm` import into a base64 string
 * (see `esbuild.config.mjs`). */
declare module "*.wasm" {
	const base64: string;
	export default base64;
}
