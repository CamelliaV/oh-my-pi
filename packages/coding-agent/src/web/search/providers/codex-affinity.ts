import type { Model } from "@oh-my-pi/pi-ai";
import { bareModelId, classifyModel } from "@oh-my-pi/pi-catalog/identity";

/**
 * Provider APIs whose transports can carry a hosted OpenAI web-search tool for
 * the running model. Kept beside the affinity predicate — in this light module,
 * not `providers/codex.ts` — so the lazy provider registry
 * (`web/search/provider.ts`) can order the chain by active model without
 * loading any provider implementation.
 */
const ACTIVE_GPT_PROVIDER_APIS: Readonly<Record<string, true>> = {
	"openai-codex-responses": true,
	"openai-responses": true,
	"openai-completions": true,
};

/** Whether Codex search can safely reuse the running model's provider transport. */
export function isCodexSearchAffinityModel(model: Model | undefined): model is Model {
	if (!model || ACTIVE_GPT_PROVIDER_APIS[model.api] !== true) return false;
	const identityIds = model.requestModelId ? [model.id, model.requestModelId] : [model.id];
	return identityIds.some(id => classifyModel("openai", bareModelId(id), { lenient: true })?.family === "gpt");
}
