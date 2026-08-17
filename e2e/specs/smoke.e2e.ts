import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

describe("Tether Sync loads in a real Obsidian instance", function () {
	afterEach(async function () {
		await obsidianPage.resetVault("e2e/vaults/simple");
	});

	it("registers its commands", async function () {
		const commandIds = await browser.executeObsidian(({ app }) => {
			return Object.keys((app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands);
		});
		expect(commandIds).toContain("tether-sync:sync-now");
		expect(commandIds).toContain("tether-sync:open-setup-wizard");
		expect(commandIds).toContain("tether-sync:toggle-auto-sync");
	});

	it("adds a ribbon icon", async function () {
		const ribbon = browser.$(".tether-sync-ribbon-icon");
		await expect(ribbon).toExist();
		const ariaLabel = await ribbon.getAttribute("aria-label");
		expect(ariaLabel).toContain("Tether Sync:");
	});

	it("shows the unconfigured status in the status bar", async function () {
		// Read textContent directly rather than relying on WDIO's
		// visibility-based getText(): Obsidian's emulated-mobile UI doesn't
		// render the desktop status-bar strip, so getText() would see "" there
		// even though the plugin set it correctly.
		const text = await browser.executeObsidian(() => document.querySelector(".status-bar")?.textContent ?? "");
		expect(text).toContain("set up Tether Sync");
	});

	it("opens the setup wizard from the command palette", async function () {
		await browser.executeObsidianCommand("tether-sync:open-setup-wizard");

		const modal = browser.$(".tether-sync-wizard-modal");
		await expect(modal).toExist();
	});
});
