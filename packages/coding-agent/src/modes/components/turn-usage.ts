import type { Usage } from "@oh-my-pi/pi-ai";
import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";

/**
 * Turn-level usage aggregation.
 *
 * A "turn" spans everything between two user messages: one user prompt, every
 * assistant/tool exchange it triggers (including steered continuations, which
 * arrive as new user messages and therefore close the prior turn), until the
 * next user message or session end. Aborted (esc) assistant messages still
 * carry billed usage and are accumulated — the turn row reports what the
 * provider actually charged, not what completed.
 *
 * Shared by the live event pipeline and the transcript rebuild: both feed
 * every billed assistant usage in message order and call `flush()` on the next
 * user message and at the end of the transcript.
 */
export class TurnUsageAccumulator {
	#usage: Usage | undefined;
	#requests = 0;
	#startedAt: number | undefined;
	#endedAt: number | undefined;

	/** True when at least one billed request was accumulated. */
	get active(): boolean {
		return this.#usage !== undefined;
	}

	add(usage: Usage, timestamp?: number): void {
		if (this.#usage === undefined) {
			this.#usage = { ...usage, cost: { ...usage.cost } };
		} else {
			this.#usage.input += usage.input;
			this.#usage.output += usage.output;
			this.#usage.cacheRead += usage.cacheRead;
			this.#usage.cacheWrite += usage.cacheWrite;
			this.#usage.totalTokens += usage.totalTokens;
			if (usage.contextTokens !== undefined) {
				this.#usage.contextTokens = Math.max(this.#usage.contextTokens ?? 0, usage.contextTokens);
			}
			if (usage.cost) {
				this.#usage.cost.input += usage.cost.input;
				this.#usage.cost.output += usage.cost.output;
				this.#usage.cost.cacheRead += usage.cost.cacheRead;
				this.#usage.cost.cacheWrite += usage.cost.cacheWrite;
				this.#usage.cost.total += usage.cost.total;
			}
		}
		this.#requests++;
		if (timestamp !== undefined) {
			if (this.#startedAt === undefined) this.#startedAt = timestamp;
			this.#endedAt = timestamp;
		}
	}

	/** Aggregate and clear. Returns undefined when nothing was accumulated. */
	flush(): { usage: Usage; requests: number; startedAt?: number; endedAt?: number } | undefined {
		if (this.#usage === undefined) return undefined;
		const snapshot = { usage: this.#usage, requests: this.#requests, startedAt: this.#startedAt, endedAt: this.#endedAt };
		this.#usage = undefined;
		this.#requests = 0;
		this.#startedAt = undefined;
		this.#endedAt = undefined;
		return snapshot;
	}
}

/** Format the turn aggregate: request count, token totals, wall-clock span. */
export function formatTurnUsageRow(snapshot: {
	usage: Usage;
	requests: number;
	startedAt?: number;
	endedAt?: number;
}): string {
	const { usage } = snapshot;
	const parts: string[] = [];
	parts.push(`${theme.icon.time} turn ${snapshot.requests} req`);
	parts.push(`${theme.icon.input} ${formatNumber(usage.input + usage.cacheWrite)}`);
	parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
	if (usage.cacheRead > 0) {
		parts.push(`${theme.icon.cache} ${formatNumber(usage.cacheRead)}`);
	}
	if (
		snapshot.startedAt !== undefined &&
		snapshot.endedAt !== undefined &&
		snapshot.endedAt > snapshot.startedAt
	) {
		const seconds = (snapshot.endedAt - snapshot.startedAt) / 1000;
		parts.push(`${theme.icon.throughput} ${seconds.toFixed(0)}s`);
	}
	return parts.join("  ");
}

/** Rendered turn-total row; `muted` styling distinguishes it from per-request rows. */
export function createTurnUsageRowBlock(snapshot: {
	usage: Usage;
	requests: number;
	startedAt?: number;
	endedAt?: number;
}): Container {
	const block = new Container();
	block.addChild(new Spacer(1));
	block.addChild(new Text(theme.fg("dim", formatTurnUsageRow(snapshot)), 1, 0));
	return block;
}
