import { completeSimple } from "@oh-my-pi/pi-ai";
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelRoleValue } from "../config/model-resolver";
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
		const signal = request.signal
			? AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs)])
			: AbortSignal.timeout(config.timeoutMs);
		signal.throwIfAborted();
		const input = redactSecrets(request.prompt, session.obfuscator);
		const local = settings.get("providers.memoryModel");
		usage.calls++;
		if (local !== ONLINE_MEMORY_MODEL_KEY && isTinyMemoryLocalModelKey(local)) {
			const text = await withTimeout(
				tinyModelClient.complete(local, input, {
					systemPrompt: request.system,
					maxTokens: request.maxTokens,
					signal,
				}),
				config.timeoutMs,
				"Wiki model timed out",
			);
			if (!text?.trim()) throw new Error("Wiki model returned no response");
			return redactSecrets(text, session.obfuscator);
		}
		const selector = request.task === "recall" ? config.recallModel : config.model;
		const resolved = resolveModelRoleValue(selector, registry.getAvailable(), { settings });
		if (!resolved.model) throw new Error(`Wiki model is not available: ${selector}`);
		const model = resolved.model;
		if (!(await registry.getApiKey(model, session.sessionId)))
			throw new Error(`Wiki model has no configured credential: ${model.provider}`);
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
					signal,
				},
			),
			config.timeoutMs,
			"Wiki model timed out",
		);
		usage.inputTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		usage.outputTokens += message.usage.output;
		usage.cost += message.usage.cost.total;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(redactSecrets(message.errorMessage ?? "Wiki model request failed", session.obfuscator));
		}
		const text = message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.trim();
		if (!text) throw new Error("Wiki model returned no text");
		return redactSecrets(text, session.obfuscator);
	};
}
