import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

describe("Halyard Sync loads in a real Obsidian instance", function () {
	afterEach(async function () {
		await obsidianPage.resetVault("e2e/vaults/simple");
	});

	it("registers its commands", async function () {
		const commandIds = await browser.executeObsidian(({ app }) => {
			return Object.keys((app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands);
		});
		expect(commandIds).toContain("halyard-sync:sync-now");
		expect(commandIds).toContain("halyard-sync:open-setup-wizard");
		expect(commandIds).toContain("halyard-sync:toggle-auto-sync");
	});

	it("adds a ribbon icon", async function () {
		const ribbon = browser.$(".halyard-sync-ribbon-icon");
		await expect(ribbon).toExist();
		await expect(ribbon.$(".halyard-sync-icon-rope")).toExist();
		const ariaLabel = await ribbon.getAttribute("aria-label");
		expect(ariaLabel).toContain("Halyard Sync:");
	});

	it("shows the unconfigured status in the status bar", async function () {
		// Read textContent directly rather than relying on WDIO's
		// visibility-based getText(): Obsidian's emulated-mobile UI doesn't
		// render the desktop status-bar strip, so getText() would see "" there
		// even though the plugin set it correctly.
		const text = await browser.executeObsidian(() => document.querySelector(".status-bar")?.textContent ?? "");
		expect(text).toContain("set up Halyard Sync");
	});

	it("renders the read-only active-note Git details section in the sidebar", async function () {
		await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, { activateSyncView?: () => Promise<void> }> };
			}).plugins.plugins["halyard-sync"];
			await plugin.activateSyncView?.();
		});
		await browser.waitUntil(
			async () =>
				(await browser.executeObsidian(
					({ app }) => {
						const panels = app.workspace.getLeavesOfType("halyard-sync-panel") as unknown as Array<{
							view: { contentEl: Element };
						}>;
						return panels.some(({ view }) =>
							view.contentEl.querySelector(".halyard-active-note-git-details") !== null
						);
					}
				)),
			{ timeout: 10_000, timeoutMsg: "Halyard Sync panel did not render active-note Git details" }
		);
		const text = await browser.executeObsidian(({ app }) => {
			const panel = app.workspace.getLeavesOfType("halyard-sync-panel")[0] as unknown as
				{ view: { contentEl: Element } } | undefined;
			return panel?.view.contentEl.textContent ?? "";
		});
		expect(text).toContain("Active note Git details");
	});

	it("opens the setup wizard from the command palette", async function () {
		await browser.executeObsidianCommand("halyard-sync:open-setup-wizard");

		const modal = browser.$(".halyard-sync-wizard-modal");
		await expect(modal).toExist();
	});
});
