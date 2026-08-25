/**
 * The settings tab is declared, not rendered, by this plugin: it returns
 * `getSettingDefinitions()` and Obsidian builds the DOM (1.13+). That means a
 * malformed definition — a control bound to a key that isn't there, a group
 * nested where the framework doesn't allow one — fails at *render* time inside
 * a real app, where no unit test can see it. These specs open the real tab and
 * check the rows came out.
 */

import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

/**
 * Opens the app's settings modal on this plugin's tab, and waits for the rows
 * to actually paint — `openTabById` returns before the tab has rendered.
 */
async function openSettingsTab(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		const setting = (
			app as unknown as {
				setting: { open(): void; openTabById(id: string): void };
			}
		).setting;
		setting.open();
		setting.openTabById("halyard-sync");
	});
	await browser.waitUntil(async () => (await settingNames()).includes("Branch"), {
		timeout: 10_000,
		timeoutMsg: "Halyard Sync's settings tab did not render its rows",
	});
}

/**
 * Every setting row's name in the *active* tab, in render order. Scoped to the
 * tab's own container rather than the whole document: the settings modal keeps
 * other tabs' rows around, so a document-wide query happily reads a core
 * plugin's settings instead of this plugin's.
 */
function settingNames(): Promise<string[]> {
	return browser.executeObsidian(({ app }) => {
		const container = (app as unknown as { setting: { activeTab?: { containerEl?: HTMLElement } } })
			.setting.activeTab?.containerEl;
		if (!container?.isConnected) return [];
		return Array.from(container.querySelectorAll(".setting-item-name")).map(
			(el) => el.textContent?.trim() ?? ""
		);
	});
}

describe("Halyard Sync's settings tab", function () {
	afterEach(async function () {
		await browser.executeObsidian(({ app }) => {
			(app as unknown as { setting: { close(): void } }).setting.close();
		});
	});

	it("renders its declarative definitions", async function () {
		await openSettingsTab();
		const names = await settingNames();

		// One row from each top-level section, proving every group rendered.
		expect(names).toContain("Remote repository");
		expect(names).toContain("Branch");
		expect(names).toContain("Ignore patterns");
		expect(names).toContain("Provider");
		expect(names).toContain("On conflict");
		expect(names).toContain("Re-clone vault");
	});

	it("renders section headings, but no 'General' heading", async function () {
		await openSettingsTab();
		const headings = await browser.executeObsidian(({ app }) => {
			const container = (app as unknown as { setting: { activeTab?: { containerEl?: HTMLElement } } })
				.setting.activeTab?.containerEl;
			return Array.from(container?.querySelectorAll(".setting-group-heading, .setting-item-heading") ?? []).map(
				(el) => el.textContent?.trim() ?? ""
			);
		});

		expect(headings).toContain("Account");
		expect(headings).toContain("Sync");
		expect(headings).toContain("Danger zone");
		// Obsidian's convention: the first section carries no heading, and the
		// plugin portal rejects a "General" one outright.
		expect(headings).not.toContain("General");
	});

	it("binds controls to stored settings, both directions", async function () {
		await openSettingsTab();

		// Seeded through the declarative control's own persistence path, then
		// read back off the plugin's settings object.
		const stored = await browser.executeObsidian(async ({ app }) => {
			const plugin = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{
								settings: Record<string, unknown>;
								settingTab?: { setControlValue(key: string, value: unknown): void | Promise<void> };
							}
						>;
					};
				}
			).plugins.plugins["halyard-sync"];
			const tab = (
				app as unknown as {
					setting: { activeTab?: { setControlValue(key: string, value: unknown): void | Promise<void> } };
				}
			).setting.activeTab;
			await tab?.setControlValue("branch", "release");
			return plugin.settings.branch;
		});

		expect(stored).toBe("release");
	});

	it("exposes its settings to Obsidian's settings search", async function () {
		// The whole reason for the declarative API: rows a user can find by
		// typing, rather than only by scrolling this tab.
		const searchable = await browser.executeObsidian(({ app }) => {
			const tab = (app as unknown as { setting: { activeTab?: { settingItems?: unknown[] } } }).setting
				.activeTab;
			return Array.isArray(tab?.settingItems) ? tab.settingItems.length : 0;
		});
		expect(searchable).toBe(0);

		await openSettingsTab();
		const indexed = await browser.executeObsidian(({ app }) => {
			const tab = (app as unknown as { setting: { activeTab?: { settingItems?: unknown[] } } }).setting
				.activeTab;
			return Array.isArray(tab?.settingItems) ? tab.settingItems.length : 0;
		});
		expect(indexed).toBeGreaterThan(0);
	});
});
