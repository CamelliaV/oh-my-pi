import type { AgentSession } from "../session/agent-session";
import { getWikiState } from "./state";
import type { WikiHistoryEntry, WikiSkillCandidate } from "./types";

function describeCandidate(candidate: WikiSkillCandidate): string {
	const validation = candidate.validation;
	return `### ${candidate.name} (${candidate.id})\nStatus: ${candidate.status}\n${candidate.description}\n${candidate.reason}\n${validation ? `Validation: ${validation.kind}${validation.kind === "behavioral" ? ` (${validation.baseline} → ${validation.candidate})` : " (explicit approval, not a test result)"}\n${validation.report}` : "Not yet validated."}`;
}

/** Shared TUI/ACP operation; evaluator commands only come from explicit user settings. */
export async function runWikiSkillCommand(session: AgentSession, args: string): Promise<string> {
	const state = getWikiState(session);
	if (!state || session.settings.get("memory.backend") !== "wiki")
		throw new Error("Wiki memory is not active for this session.");
	const [verb = "list", id, ...reason] = args.trim().split(/\s+/).filter(Boolean);
	await state.skills.reconcile((await state.snapshot()).pages);
	if (verb === "list") {
		const candidates = await state.skills.list();
		return (
			candidates.map(describeCandidate).join("\n\n") ||
			"No Wiki skill candidates. Use /memory skill propose after recording reusable task evidence."
		);
	}
	if (verb === "propose") {
		await state.maintain();
		const candidates = await state.skills.propose((await state.snapshot()).pages);
		return candidates.map(describeCandidate).join("\n\n") || "No new supported skill candidate was proposed.";
	}
	if (!id) throw new Error("Usage: /memory skill <list|propose|show ID|validate ID|approve ID|reject ID REASON>");
	if (verb === "show") {
		const candidate = (await state.skills.list()).find(item => item.id === id);
		if (!candidate) throw new Error(`Wiki skill candidate ${id} not found.`);
		return `${describeCandidate(candidate)}\n\n${candidate.body}`;
	}
	let candidate: WikiSkillCandidate;
	if (verb === "validate") candidate = await state.skills.validate(id, state.config.skillValidationCommand);
	else if (verb === "approve") candidate = await state.skills.approve(id);
	else if (verb === "reject") {
		if (!reason.length) throw new Error("Usage: /memory skill reject ID REASON");
		candidate = await state.skills.reject(id, reason.join(" "));
	} else throw new Error("Usage: /memory skill <list|propose|show ID|validate ID|approve ID|reject ID REASON>");
	await session.refreshSkills();
	return describeCandidate(candidate);
}

function positiveRevision(value: string | undefined, label: string): number {
	if (!value || !/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive integer.`);
	const revision = Number(value);
	if (!Number.isSafeInteger(revision)) throw new Error(`${label} is too large.`);
	return revision;
}

function formatHistory(id: string, revisions: readonly WikiHistoryEntry[]): string {
	if (!revisions.length) return `No history found for ${id}.`;
	return [
		`## ${id} history`,
		"",
		...revisions.map(
			revision =>
				`${revision.current ? "*" : " "} r${revision.revision} — ${revision.change.operation} — ${revision.status} — ${revision.updatedAt}\n  ${revision.change.reason}`,
		),
	].join("\n");
}

/** User-visible history operations never invoke the maintenance model. */
export async function runWikiHistoryCommand(
	session: AgentSession,
	action: "history" | "diff" | "restore",
	args: string,
): Promise<string> {
	const state = getWikiState(session);
	if (!state || session.settings.get("memory.backend") !== "wiki")
		throw new Error("Wiki memory is not active for this session.");
	const [id, first, second, ...extra] = args.trim().split(/\s+/).filter(Boolean);
	if (!id || extra.length)
		throw new Error(
			`Usage: /memory ${action} ID ${action === "history" ? "" : action === "diff" ? "[FROM] [TO]" : "REVISION"}`.trim(),
		);
	if (action === "history") return formatHistory(id, await state.history(id));
	if (action === "restore") {
		const revision = positiveRevision(first, "Revision");
		const restored = await state.restore(id, revision);
		return `Restored ${id}@${restored.restoredFrom} as ${id}@${restored.revision}.`;
	}
	const revisions = await state.history(id);
	const current = revisions.find(revision => revision.current);
	if (!current) throw new Error(`No history found for ${id}.`);
	const from = first ? positiveRevision(first, "FROM revision") : current.revision - 1;
	const to = second ? positiveRevision(second, "TO revision") : current.revision;
	if (from < 1 || to < 1 || from === to) throw new Error("Diff requires two distinct positive revisions.");
	return state.diff(id, from, to);
}
