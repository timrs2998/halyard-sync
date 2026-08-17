import * as path from "path";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";

// wdio-obsidian-service downloads and caches real Obsidian builds into this directory.
const cacheDir = path.resolve(".obsidian-cache");

// Single pinned version for now to keep the local/CI loop fast. Widen with
// OBSIDIAN_VERSIONS (e.g. "earliest/earliest latest/latest") once this is
// stable — see https://jesse-r-s-hines.github.io/wdio-obsidian-service/wdio-obsidian-service/README#specifying-obsidian-versions
const desktopVersions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "latest/latest", { cacheDir });

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",

	specs: ["./e2e/specs/**/*.e2e.ts"],

	maxInstances: Number(env.WDIO_MAX_INSTANCES || 4),

	// This plugin is isDesktopOnly: false, so it's tested both as desktop
	// Obsidian and under Obsidian's emulated-mobile UI.
	capabilities: [
		...desktopVersions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
			browserName: "obsidian",
			"wdio:obsidianOptions": {
				appVersion,
				installerVersion,
				plugins: ["."],
				vault: "e2e/vaults/simple",
			},
		})),
		...desktopVersions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
			browserName: "obsidian",
			"wdio:obsidianOptions": {
				appVersion,
				installerVersion,
				emulateMobile: true,
				plugins: ["."],
				vault: "e2e/vaults/simple",
			},
			"goog:chromeOptions": {
				mobileEmulation: {
					deviceMetrics: { width: 390, height: 844 },
				},
			},
		})),
	],

	services: ["obsidian"],
	reporters: ["obsidian"],

	mochaOpts: {
		ui: "bdd",
		timeout: 60 * 1000,
	},
	waitforInterval: 250,
	waitforTimeout: 5 * 1000,
	logLevel: "warn",

	cacheDir,

	injectGlobals: false,
};
