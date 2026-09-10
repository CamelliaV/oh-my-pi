/**
 * A search card reports how fast the answer came back. The number is derived
 * from provider usage, which several providers omit entirely (credential-free
 * scrapes) or report without a duration (a result resumed from an old session)
 * — so the contract that matters is which inputs yield a rate vs. nothing.
 */
import { describe, expect, it } from "bun:test";
import { searchThroughput } from "@oh-my-pi/pi-coding-agent/web/search/types";

describe("searchThroughput", () => {
	it("derives tokens per second over the whole measured call", () => {
		const throughput = searchThroughput({ outputTokens: 420 }, 4200);

		expect(throughput).toEqual({ tokensPerSecond: 100, outputTokens: 420, durationMs: 4200 });
	});

	it("returns null instead of a zero rate when the provider reported no output tokens", () => {
		// A scrape provider reports no usage at all; 0 tok/s would read as a stall.
		expect(searchThroughput(undefined, 4200)).toBeNull();
		expect(searchThroughput({ inputTokens: 900 }, 4200)).toBeNull();
		expect(searchThroughput({ outputTokens: 0 }, 4200)).toBeNull();
	});

	it("returns null for a call too short to time meaningfully", () => {
		// 5 tokens in 12ms is clock noise, not a 416 tok/s measurement.
		expect(searchThroughput({ outputTokens: 5 }, 12)).toBeNull();
		expect(searchThroughput({ outputTokens: 5 }, 99)).toBeNull();
		// The floor itself is measurable.
		expect(searchThroughput({ outputTokens: 5 }, 100)?.tokensPerSecond).toBe(50);
	});

	it("returns null when the caller measured no duration", () => {
		// A result persisted before timing existed carries usage but no elapsed.
		expect(searchThroughput({ outputTokens: 420 }, undefined)).toBeNull();
		expect(searchThroughput({ outputTokens: 420 }, Number.NaN)).toBeNull();
	});
});
