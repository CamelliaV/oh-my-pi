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
