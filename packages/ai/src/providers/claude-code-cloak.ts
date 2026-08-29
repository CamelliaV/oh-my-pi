/**
 * Claude Code Cloak
 *
 * Fork-owned seam for request-shape divergences that keep OMP's OAuth-cloaked
 * Anthropic Messages traffic indistinguishable from real Claude Code to
 * CC-client-fingerprinting relays (sub2api-style `claude_code_only` groups,
 * which validate UA + system blocks + `metadata.user_id` shape together).
 *
 * Deliberately outside `providers/anthropic.ts`: that file is upstream-owned
 * and ~4.4k lines, so every cloak edit landed inside it becomes permanent
 * merge surface for the fork. New cloak logic belongs here, with a one-line
 * call site there.
 */

/**
 * Real Claude Code always pairs `session_id` with a non-empty `device_id` in
 * the JSON `metadata.user_id` envelope, and CC-fingerprinting relays reject
 * envelopes where `device_id` is missing or empty. When an OAuth-shaped caller
 * supplies session-stable JSON without one, fill it in instead of regenerating
 * the whole id — regenerating would churn backend session attribution.
 *
 * The envelope's own `account_uuid` scopes the derived id when present, so a
 * caller that knows its account keeps a stable per-account device id even if
 * the ambient `accountId` is absent.
 *
 * `deriveDeviceId` is injected rather than imported to keep this module free of
 * an import cycle back into `anthropic.ts`, which owns install-id-derived
 * device ids.
 */
export function enrichClaudeJsonUserIdDeviceId(
	userId: string,
	deriveDeviceId: (accountId?: string) => string,
	accountId?: string,
): string {
	if (userId.length === 0 || userId[0] !== "{") return userId;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return userId;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return userId;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.device_id === "string" && obj.device_id.length > 0) return userId;
	obj.device_id = deriveDeviceId(
		typeof obj.account_uuid === "string" && obj.account_uuid.length > 0 ? obj.account_uuid : accountId,
	);
	return JSON.stringify(obj);
}

/**
 * Selects which bytes of a Messages request body seed the Claude Code `cch`
 * attestation.
 *
 * Real Claude Code hashes the *whole* body, so `cch` changes on every request.
 * On `api.anthropic.com` that is free: the edge strips the billing-header
 * system block before the prompt reaches the cache layer, so the mutation is
 * invisible to prefix matching. A relay forwards the block verbatim as ordinary
 * system text, so there the mutation lands in `system[0]` — the *first* block of
 * the cached prefix — and invalidates it on every single turn. Measured against
 * a CC-fingerprinting relay: 0/6 cache hits and 329k cache-write tokens over one
 * six-request session, versus 3/6 hits and 165k writes once `cch` held still.
 * Upstream declined to fix this (anthropics/claude-code#68900), and dropping the
 * block outright is not available to us: `claude_code_only` relays reject
 * CC-scoped credentials that arrive without it.
 *
 * So off-official endpoints hash only the session-stable region — the system
 * blocks, tools, and trailing scalars — excluding `messages`. `cch` then changes
 * exactly when the cached prefix itself changes, which is the whole point.
 * Relays that gate on `claude_code_only` validate the header's *shape*, not the
 * hash (they cannot recompute it without the seed), so a prefix-scoped value
 * still clears the gate.
 *
 * Order-independent by construction: Anthropic SDK payloads serialize
 * `messages` before `system`, and the returned region is clipped to stop at the
 * `messages` array if it ever precedes `system` instead. If neither marker is
 * found the full body is returned, matching real CC.
 */
export function selectClaudeCchHashRegion(body: Buffer, stable: boolean): Buffer {
	if (!stable) return body;
	const systemIdx = body.indexOf(CCH_SYSTEM_ARRAY_MARKER);
	if (systemIdx === -1) return body;
	const messagesIdx = body.indexOf(CCH_MESSAGES_ARRAY_MARKER, systemIdx);
	return messagesIdx === -1 ? body.subarray(systemIdx) : body.subarray(systemIdx, messagesIdx);
}

const cchRegionEncoder = new TextEncoder();
const CCH_SYSTEM_ARRAY_MARKER = cchRegionEncoder.encode(`"system":[`);
const CCH_MESSAGES_ARRAY_MARKER = cchRegionEncoder.encode(`"messages":[`);
