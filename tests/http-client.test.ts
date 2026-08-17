import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	withRequestLogging,
	withRequestTimeout,
	type RequestLogEntry,
	type RequestUrlLikeParam,
	type RequestUrlLikeResponse,
} from "../src/git/http-client";

function response(status = 200): RequestUrlLikeResponse {
	return { status, headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

describe("withRequestTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves normally when the call finishes before the timeout", async () => {
		const inner = vi.fn().mockResolvedValue(response(200));
		const wrapped = withRequestTimeout(inner, () => 1000);
		const result = await wrapped({ url: "https://example.com" });
		expect(result.status).toBe(200);
	});

	it("rejects with a 'timed out' message when the call never settles", async () => {
		const inner = () => new Promise<RequestUrlLikeResponse>(() => {}); // never resolves
		const wrapped = withRequestTimeout(inner, () => 5000);
		const promise = wrapped({ url: "https://example.com/repo.git" });
		const assertion = expect(promise).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
	});

	it("includes the URL in the timeout message", async () => {
		const inner = () => new Promise<RequestUrlLikeResponse>(() => {});
		const wrapped = withRequestTimeout(inner, () => 100);
		const promise = wrapped({ url: "https://example.com/owner/repo.git" });
		const assertion = expect(promise).rejects.toThrow(/example\.com\/owner\/repo\.git/);
		await vi.advanceTimersByTimeAsync(100);
		await assertion;
	});

	it("passes through immediately with no timer when getTimeoutMs() <= 0", async () => {
		const inner = vi.fn().mockResolvedValue(response(204));
		const wrapped = withRequestTimeout(inner, () => 0);
		const result = await wrapped({ url: "https://example.com" });
		expect(result.status).toBe(204);
	});

	it("propagates the underlying rejection when it fails before the timeout", async () => {
		const inner = () => Promise.reject(new Error("real network error"));
		const wrapped = withRequestTimeout(inner, () => 5000);
		await expect(wrapped({ url: "https://example.com" })).rejects.toThrow("real network error");
	});

	it("re-reads the timeout getter on every call (live setting, no snapshot)", async () => {
		let currentTimeout = 50;
		const inner = () => new Promise<RequestUrlLikeResponse>(() => {});
		const wrapped = withRequestTimeout(inner, () => currentTimeout);

		const first = wrapped({ url: "https://example.com/a" });
		const firstAssertion = expect(first).rejects.toThrow(/timed out after 50ms/);
		await vi.advanceTimersByTimeAsync(50);
		await firstAssertion;

		currentTimeout = 200;
		const second = wrapped({ url: "https://example.com/b" });
		const secondAssertion = expect(second).rejects.toThrow(/timed out after 200ms/);
		await vi.advanceTimersByTimeAsync(200);
		await secondAssertion;
	});
});

describe("withRequestLogging", () => {
	it("logs url/method/status/duration on success and returns the response unchanged", async () => {
		const inner = vi.fn().mockResolvedValue(response(201));
		const entries: RequestLogEntry[] = [];
		const wrapped = withRequestLogging(inner, (e) => entries.push(e));

		const result = await wrapped({ url: "https://example.com/repo.git", method: "POST" });

		expect(result.status).toBe(201);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			url: "https://example.com/repo.git",
			method: "POST",
			status: 201,
			error: null,
		});
		expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
	});

	it("defaults method to GET when not specified", async () => {
		const inner = vi.fn().mockResolvedValue(response(200));
		const entries: RequestLogEntry[] = [];
		const wrapped = withRequestLogging(inner, (e) => entries.push(e));
		await wrapped({ url: "https://example.com" });
		expect(entries[0].method).toBe("GET");
	});

	it("logs and rethrows on failure, with status null and the error message captured", async () => {
		const inner = () => Promise.reject(new Error("network unreachable"));
		const entries: RequestLogEntry[] = [];
		const wrapped = withRequestLogging(inner, (e) => entries.push(e));

		await expect(wrapped({ url: "https://example.com" })).rejects.toThrow("network unreachable");
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBeNull();
		expect(entries[0].error).toBe("network unreachable");
	});

	it("never includes headers or body in the logged entry (no field carries them)", async () => {
		const inner = vi.fn().mockResolvedValue(response(200));
		const entries: RequestLogEntry[] = [];
		const wrapped = withRequestLogging(inner, (e) => entries.push(e));
		const param: RequestUrlLikeParam = {
			url: "https://example.com",
			headers: { Authorization: "Bearer super-secret-token" },
			body: "sensitive body",
		};
		await wrapped(param);
		const logged = JSON.stringify(entries[0]);
		expect(logged).not.toContain("super-secret-token");
		expect(logged).not.toContain("sensitive body");
	});
});
