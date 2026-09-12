import type { WikiEvidence, WikiEvidenceRole, WikiSource } from "./types";

/** Decode only the native capture envelope; arbitrary retained JSON has no role authority. */
export function wikiSourcePassages(source: WikiSource): Array<{ role: WikiEvidenceRole; content: string }> {
	if (source.source === "task-observations") {
		try {
			const records: unknown = JSON.parse(source.content);
			if (
				Array.isArray(records) &&
				records.length > 0 &&
				records.every(
					record =>
						record !== null &&
						typeof record === "object" &&
						(record.role === "user" || record.role === "assistant" || record.role === "toolResult") &&
						typeof record.content === "string" &&
						(record.tool === undefined || typeof record.tool === "string") &&
						(record.error === undefined || typeof record.error === "boolean"),
				)
			) {
				return records.map(record => ({
					role: record.role === "toolResult" ? "observation" : record.role,
					content: record.content,
				}));
			}
		} catch {
			// A malformed legacy envelope remains quoteable, but cannot establish a speaker.
		}
	}
	return [{ role: "unknown", content: source.content }];
}

/** Exact quotation proves provenance, not entailment of generated page prose. */
export function wikiSourceEvidence(source: WikiSource, quote: string, passage?: number): WikiEvidence | undefined {
	if (!quote.trim()) return undefined;
	const passages = wikiSourcePassages(source);
	if (passage !== undefined) {
		if (!Number.isSafeInteger(passage) || passage < 0) return undefined;
		const selected = passages[passage];
		if (!selected?.content.includes(quote)) return undefined;
		return { id: source.id, revision: source.revision, quote, role: selected.role, passage };
	}
	let role: WikiEvidenceRole | undefined;
	for (const selected of passages) {
		if (!selected.content.includes(quote)) continue;
		role = role === undefined || role === selected.role ? selected.role : "unknown";
	}
	return role === undefined ? undefined : { id: source.id, revision: source.revision, quote, role };
}
