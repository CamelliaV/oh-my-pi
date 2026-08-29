import type { Model } from "@oh-my-pi/pi-ai";
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { isClaudeModelId } from "@oh-my-pi/pi-catalog/identity";
import { $env } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../../config/model-registry";

/**
 * Anthropic hosted-search affinity.
 *
 * The standalone `anthropic` search provider targets official Anthropic with its
 * own credentials (`ANTHROPIC_SEARCH_API_KEY` / stored `anthropic` auth) and a
 * fixed cheap model. That path cannot reach a custom Messages relay: the key
 * belongs to another provider, `isOAuth` is inferred from the `sk-ant-oat`
 * prefix (so relay keys never get the Claude Code fingerprint a
 * `claude_code_only` group requires), and the default model may not exist in
 * the relay's group at all.
 *
 * Affinity closes exactly that gap: when the running model speaks Anthropic
 * Messages against an endpoint the standalone path cannot reach, hosted search
 * reuses *that* model's transport — base URL, provider credential, cloak state,
 * request model id and provider headers.
 *
 * Scope is deliberately narrower than Codex affinity, because reusing the
 * running model is a cost decision as well as a routing one:
 *
 * - Official `api.anthropic.com` models are excluded. The standalone path
 *   already reaches them, and it does so on the cheap `ANTHROPIC_SEARCH_MODEL`
 *   default; promoting affinity there would silently bill hosted search at the
 *   running model's rate (e.g. Opus) and reorder a chain that was working.
 * - An explicit `ANTHROPIC_SEARCH_API_KEY` / `ANTHROPIC_SEARCH_BASE_URL` wins.
 *   Those name a deliberate search endpoint; affinity must not override them.
 *
 * Kept in this light module, importable by the lazy provider registry
 * (`web/search/provider.ts`) without loading any provider implementation.
 */
export function isAnthropicSearchAffinityModel(model: Model | undefined): model is Model<"anthropic-messages"> {
	if (model?.api !== "anthropic-messages") return false;
	if (isOfficialAnthropicApiUrl(model.baseUrl)) return false;
	if ($env.ANTHROPIC_SEARCH_API_KEY || $env.ANTHROPIC_SEARCH_BASE_URL) return false;
	const identityIds = model.requestModelId ? [model.id, model.requestModelId] : [model.id];
	return identityIds.some(id => isClaudeModelId(id));
}

/** Active-model transport that hosted Anthropic search reuses under affinity. */
export interface AnthropicSearchTransport {
	/** Credential provider — the active model's, not necessarily `anthropic`. */
	provider: string;
	baseUrl: string;
	/** Wire `model` value; the relay's group may not carry the standalone default. */
	model: string;
	/**
	 * Whether to claim the Claude Code fingerprint (CC billing block, system
	 * identity line, JSON `metadata.user_id`). Taken from the resolved model
	 * rather than the token prefix, because relay keys are not `sk-ant-oat`
	 * yet still route to a cloaked, CC-only group.
	 */
	isOAuth: boolean;
	modelHeaders?: Record<string, string>;
	/**
	 * Provider-declared `anthropic-beta` tokens (`compat.extraBetas`). A relay
	 * that gates every request on a beta gates the search request too, and the
	 * search path builds its own header set rather than going through the
	 * streaming client, so they have to travel with the transport.
	 */
	extraBetas?: readonly string[];
}

/**
 * Resolve the affinity transport for hosted Anthropic search, or `undefined`
 * when the active model is not an Anthropic Messages model (leaving the
 * standalone official-credential path in charge).
 *
 * Whether a given relay actually honours `web_search_20250305` cannot be known
 * statically — same as Codex affinity, the attempt runs and the provider chain
 * falls through to the next source if the upstream rejects or flattens it.
 */
export function resolveAnthropicSearchTransport(
	activeModel: Model | undefined,
	modelRegistry: ModelRegistry | undefined,
): AnthropicSearchTransport | undefined {
	if (!isAnthropicSearchAffinityModel(activeModel)) return undefined;
	const modelHeaders = {
		...(modelRegistry?.getProviderHeaders(activeModel.provider) ?? {}),
		...(activeModel.headers ?? {}),
	};
	const extraBetas = activeModel.compat?.extraBetas;
	return {
		provider: activeModel.provider,
		baseUrl: activeModel.baseUrl,
		model: activeModel.requestModelId ?? activeModel.id,
		isOAuth: activeModel.isOAuth === true,
		modelHeaders: Object.keys(modelHeaders).length > 0 ? modelHeaders : undefined,
		extraBetas: extraBetas && extraBetas.length > 0 ? extraBetas : undefined,
	};
}
