import { completeSimple } from "@oh-my-pi/pi-ai";
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { redactSecrets } from "../secrets/redact";
import type { AgentSession } from "../session/agent-session";
import { concreteThinkingLevel, shouldDisableReasoning, toReasoningEffort } from "../thinking";
import { isTinyMemoryLocalModelKey, ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";
import type { WikiConfig } from "./config";
import type { WikiComplete } from "./types";

export interface WikiUsage {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

/** Reuses OMP's model selection, credentials, transport, local runtime and cancellation. */
export function createWikiComplete(
	session: AgentSession,
	settings: Settings,
	registry: ModelRegistry,
	config: WikiConfig,
	usage: WikiUsage,
): WikiComplete {
	return async request => {
		request.signal?.throwIfAborted();
		const input = redactSecrets(request.prompt, session.obfuscator);
		const local = settings.get("providers.memoryModel");
		if (local !== ONLINE_MEMORY_MODEL_KEY && isTinyMemoryLocalModelKey(local)) {
			usage.calls++;
			const attempt = attemptSignal(request.signal, config.timeoutMs);
			try {
				const text = await withTimeout(
					tinyModelClient.complete(local, input, {
						systemPrompt: request.system,
						maxTokens: request.maxTokens,
						signal: attempt,
					}),
					config.timeoutMs,
					"Wiki model timed out",
					request.signal,
				);
				if (!text?.trim()) throw new Error("Wiki model returned no response");
				return redactSecrets(text, session.obfuscator);
			} catch (error) {
				request.signal?.throwIfAborted();
				if (request.task !== "recall") throw error;
			}
		}
		const selectors =
			request.task === "recall"
				? uniqueSelectors(
						config.recallModel,
						session.model ? formatModelString(session.model) : undefined,
						config.model,
					)
				: [config.model];
		let lastError: Error | undefined;
		for (const selector of selectors) {
			request.signal?.throwIfAborted();
			const resolved = resolveModelRoleValue(selector, registry.getAvailable(), { settings });
			if (!resolved.model) {
				lastError = new Error(`Wiki model is not available: ${selector}`);
				continue;
			}
			const model = resolved.model;
			if (!(await registry.getApiKey(model, session.sessionId))) {
				lastError = new Error(`Wiki model has no configured credential: ${model.provider}`);
				continue;
			}
			usage.calls++;
			const attempt = attemptSignal(request.signal, config.timeoutMs);
			try {
				const message = await withTimeout(
					completeSimple(
						model,
						{
							systemPrompt: [request.system],
							messages: [{ role: "user", content: input, timestamp: Date.now() }],
						},
						{
							apiKey: registry.resolver(model, session.sessionId),
							sessionId: session.sessionId,
							reasoning: toReasoningEffort(concreteThinkingLevel(resolved.thinkingLevel)),
							disableReasoning: shouldDisableReasoning(concreteThinkingLevel(resolved.thinkingLevel)),
							maxTokens: request.maxTokens,
							temperature: 0,
							signal: attempt,
						},
					),
					config.timeoutMs,
					"Wiki model timed out",
					request.signal,
				);
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					throw new Error(redactSecrets(message.errorMessage ?? "Wiki model request failed", session.obfuscator));
				}
				usage.inputTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
				usage.outputTokens += message.usage.output;
				usage.cost += message.usage.cost.total;
				const text = message.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n")
					.trim();
				if (!text) throw new Error("Wiki model returned no text");
				return redactSecrets(text, session.obfuscator);
			} catch (error) {
				request.signal?.throwIfAborted();
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}
		throw lastError ?? new Error("Wiki model request failed");
	};
}

function uniqueSelectors(...values: Array<string | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function attemptSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const attempt = AbortSignal.timeout(timeoutMs);
	return parent ? AbortSignal.any([parent, attempt]) : attempt;
}
