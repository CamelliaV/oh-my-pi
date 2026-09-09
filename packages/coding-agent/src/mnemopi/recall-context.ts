import type { RecallResult } from "@oh-my-pi/pi-mnemopi";
import { complete } from "@oh-my-pi/pi-mnemopi/core/local-llm";
import {
	type ResolvedMnemopiRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { logger, prompt, withTimeout } from "@oh-my-pi/pi-utils";
import memoryRelevancePrompt from "../prompts/system/memory-relevance.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import { redactSecrets } from "../secrets/redact";

const SELECTION_TIMEOUT_MS = 20_000;
const SELECTION_MAX_TOKENS = 1024;

/** Retrieval returns candidates; automatic context requires evidence that they answer this question. */
export async function selectRecallContext(
	query: string,
	candidates: readonly RecallResult[],
	runtime: ResolvedMnemopiRuntimeOptions | undefined,
	obfuscator?: SecretObfuscator,
): Promise<RecallResult[]> {
	if (candidates.length === 0) return [];
	const safeCandidates = candidates.map(candidate => ({
		...candidate,
		content: redactSecrets(candidate.content, obfuscator),
		source: candidate.source == null ? candidate.source : redactSecrets(candidate.source, obfuscator),
	}));
	// With memory LLMs disabled, only strong lexical evidence is eligible for
	// automatic injection. Explicit recall still exposes semantic candidates.
	if (!runtime?.llm || runtime.llm.enabled === false) {
		return safeCandidates.filter(candidate => (candidate.keyword_score ?? 0) >= 0.7);
	}
	const rendered = prompt.render(memoryRelevancePrompt, {
		query: JSON.stringify(redactSecrets(query, obfuscator)),
		records: JSON.stringify(
			safeCandidates.map((candidate, index) => ({
				id: String(index),
				content: candidate.content,
				source: candidate.source,
				timestamp: candidate.timestamp,
			})),
		),
	});
	try {
		const response = await withTimeout(
			withMnemopiRuntimeOptions({ ...runtime, llm: { ...runtime.llm, maxTokens: SELECTION_MAX_TOKENS } }, () =>
				complete(rendered, 0, { maxTokens: SELECTION_MAX_TOKENS, signal: AbortSignal.timeout(SELECTION_TIMEOUT_MS) }),
			),
			SELECTION_TIMEOUT_MS,
			"Memory relevance selection timed out",
		);
		if (!response) return [];
		const parsed: unknown = JSON.parse(response);
		if (parsed === null || typeof parsed !== "object" || !("ids" in parsed) || !Array.isArray(parsed.ids)) return [];
		const byId = new Map(safeCandidates.map((candidate, index) => [String(index), candidate]));
		const selected: RecallResult[] = [];
		for (const id of parsed.ids) {
			if (typeof id !== "string") continue;
			const candidate = byId.get(id);
			if (!candidate) continue;
			selected.push(candidate);
			byId.delete(id);
		}
		return selected;
	} catch (error) {
		logger.debug("Mnemopi: context selection unavailable; omitting automatic memories", {
			error: redactSecrets(String(error), obfuscator),
		});
		return [];
	}
}
