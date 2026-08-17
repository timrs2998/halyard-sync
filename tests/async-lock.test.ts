import { describe, expect, it } from "vitest";
import { AsyncLock } from "../src/sync/async-lock";

describe("AsyncLock", () => {
	it("runs a single task and returns its result", async () => {
		const lock = new AsyncLock();
		const result = await lock.run(async () => 42);
		expect(result).toBe(42);
	});

	it("serializes overlapping tasks in call order", async () => {
		const lock = new AsyncLock();
		const order: string[] = [];
		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((r) => (releaseFirst = r));

		const first = lock.run(async () => {
			order.push("first-start");
			await firstGate;
			order.push("first-end");
		});
		const second = lock.run(async () => {
			order.push("second-start");
			order.push("second-end");
		});

		// Second must not start until first releases, even though first is
		// still awaiting its gate.
		await new Promise((r) => setTimeout(r, 0));
		expect(order).toEqual(["first-start"]);

		releaseFirst();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
	});

	it("releases the lock even when a task throws, so later tasks still run", async () => {
		const lock = new AsyncLock();
		await expect(
			lock.run(async () => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");

		const result = await lock.run(async () => "after failure");
		expect(result).toBe("after failure");
	});
});
