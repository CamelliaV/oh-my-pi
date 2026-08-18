import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatCompact } from "../src/client/data/formatters";
import { MetricCluster } from "../src/client/ui/MetricCluster";
import type { AggregatedStats } from "../src/shared-types";

const stats: AggregatedStats = {
	totalRequests: 1,
	successfulRequests: 1,
	failedRequests: 0,
	errorRate: 0,
	totalInputTokens: 100,
	totalOutputTokens: 20,
	totalCacheReadTokens: 300,
	totalCacheWriteTokens: 40,
	cacheRate: 0.75,
	cacheTelemetryRequests: 3,
	cacheEligibleRequests: 4,
	cacheSavings: 0.695,
	actualCost: 0.5,
	estimatedCost: 0.6,
	actualCostRequests: 2,
	estimatedCostRequests: 3,
	unknownCostRequests: 1,
	totalCost: 0,
	totalPremiumRequests: 0,
	avgDuration: 1000,
	avgTtft: 100,
	avgTokensPerSecond: 20,
	firstTimestamp: 1,
	lastTimestamp: 1,
};

describe("overview token metrics", () => {
	it("distinguishes uncached input and cache reads and shows their reconciled total", () => {
		const html = renderToStaticMarkup(<MetricCluster stats={stats} />);

		expect(html).toContain("Uncached Input");
		expect(html).toContain("Cache Read");
		expect(html).toContain("Conversation Total");
		expect(html).toContain("Uncached input + cache reads + cache writes + output");
		expect(html).toContain("Cache Rate");
		expect(html).toContain("Cache Savings");
		expect(html).toContain("75.0%");
		expect(html).toContain("69.5%");
		expect(html).toContain("cache writes can make this negative");
		expect(html).toContain("3/4");
		expect(html).toContain("$0.50 actual");
		expect(html).toContain("~$0.60 estimate");
		expect(html).toContain("1 req N/A");

		const expectedTotal = formatCompact(
			stats.totalInputTokens +
				stats.totalOutputTokens +
				stats.totalCacheReadTokens +
				stats.totalCacheWriteTokens,
		);
		expect(html).toContain(`<div class="stats-metric-value">${expectedTotal}</div>`);
	});

	it("renders N/A when provider cache telemetry is unavailable", () => {
		const html = renderToStaticMarkup(
			<MetricCluster
				stats={{ ...stats, cacheRate: null, cacheTelemetryRequests: 0, cacheEligibleRequests: 1 }}
			/>,
		);

		expect(html).toContain("Cache Rate · 0/1");
		expect(html).toContain("N/A");
	});
});
