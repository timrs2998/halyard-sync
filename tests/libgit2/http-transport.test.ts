import { describe, expect, it } from "vitest";
import {
	SmartHttpProtocolError,
	basicAuthHeader,
	detectUnsupportedProtocolVersion,
	validateSmartHttpResponse,
	type SmartHttpRequestSpec,
} from "../../src/git/libgit2/http-transport";

const encode = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

/** Verbatim from gitlab.com, which is what exposed the v2 bug. */
const V2_ADVERTISEMENT =
	"001e# service=git-upload-pack\n" +
	"0000000eversion 2\n" +
	"0028agent=git/2.55.0-rc1.g1ea786d-Linux\n" +
	"0013ls-refs=unborn\n" +
	"0027fetch=shallow wait-for-done filter\n" +
	"0012server-option\n" +
	"0017object-format=sha1\n" +
	"0000";

/** The same repo, same endpoint, without the `Git-Protocol` header. */
const V0_ADVERTISEMENT =
	"001e# service=git-upload-pack\n" +
	"0000015941459bc7b32d91de0f6899b9aefef36796a77c92 HEAD\0" +
	"multi_ack thin-pack side-band side-band-64k ofs-delta shallow\n" +
	"0000";

describe("basicAuthHeader", () => {
	it("base64-encodes 'username:password' as a Basic auth header", () => {
		const expected = `Basic ${Buffer.from("x-access-token:sekret").toString("base64")}`;
		expect(basicAuthHeader({ username: "x-access-token", password: "sekret" })).toBe(expected);
	});
});

describe("validateSmartHttpResponse", () => {
	const spec: SmartHttpRequestSpec = {
		method: "GET",
		url: "https://example.com/owner/repo.git/info/refs?service=git-upload-pack",
		headers: {},
		expectedResponseContentType: "application/x-git-upload-pack-advertisement",
	};

	it("accepts a matching status + content-type", () => {
		expect(() =>
			validateSmartHttpResponse(spec, {
				status: 200,
				headers: { "content-type": "application/x-git-upload-pack-advertisement" },
			})
		).not.toThrow();
	});

	it("ignores a charset suffix and header name casing", () => {
		expect(() =>
			validateSmartHttpResponse(spec, {
				status: 200,
				headers: {
					"content-type": "Application/X-Git-Upload-Pack-Advertisement; charset=utf-8",
				},
			})
		).not.toThrow();
	});

	it("throws SmartHttpProtocolError for a non-2xx status", () => {
		expect(() =>
			validateSmartHttpResponse(spec, { status: 404, headers: {} })
		).toThrow(SmartHttpProtocolError);
	});

	it("throws for a mismatched content-type (e.g. an HTML login page)", () => {
		expect(() =>
			validateSmartHttpResponse(spec, {
				status: 200,
				headers: { "content-type": "text/html" },
			})
		).toThrow(SmartHttpProtocolError);
	});

	it("cannot distinguish v0 from v2 — they share a content-type", () => {
		// Documents WHY detectUnsupportedProtocolVersion has to exist: this
		// check passes a v2 advertisement, because the only difference is the
		// body. Real gitlab.com sends this exact content-type either way.
		expect(() =>
			validateSmartHttpResponse(spec, {
				status: 200,
				headers: { "content-type": "application/x-git-upload-pack-advertisement" },
			})
		).not.toThrow();
	});
});

describe("detectUnsupportedProtocolVersion", () => {
	it("flags a real gitlab.com protocol v2 advertisement", () => {
		expect(detectUnsupportedProtocolVersion(encode(V2_ADVERTISEMENT))).toBe(2);
	});

	it("passes a real protocol v0 ref advertisement", () => {
		expect(detectUnsupportedProtocolVersion(encode(V0_ADVERTISEMENT))).toBe(null);
	});

	it("passes an empty or truncated body without throwing", () => {
		expect(detectUnsupportedProtocolVersion(new Uint8Array(0))).toBe(null);
		expect(detectUnsupportedProtocolVersion(encode("001e# service=git-upload"))).toBe(null);
	});

	it("does not flag v1, which libgit2 does understand", () => {
		expect(detectUnsupportedProtocolVersion(encode("000eversion 1\n0000"))).toBe(null);
	});

	it("is not fooled by a ref or capability that merely contains 'version'", () => {
		const body =
			"001e# service=git-upload-pack\n" +
			"00000045deadbeefdeadbeefdeadbeefdeadbeefdeadbeef refs/heads/version 2\n" +
			"0000";
		expect(detectUnsupportedProtocolVersion(encode(body))).toBe(null);
	});

	it("flags a hypothetical future version above 2", () => {
		expect(detectUnsupportedProtocolVersion(encode("000eversion 3\n0000"))).toBe(3);
	});
});
