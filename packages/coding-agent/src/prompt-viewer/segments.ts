/**
 * Structural segmentation for the System Prompt Viewer: splits a prompt block
 * into named segments at top-level markers so each source region becomes its
 * own row. The split is lossless — `segments.map(s => s.text).join("")` is the
 * original text — and never splits inside a fenced code block.
 */

import * as os from "node:os";

export interface PromptSegment {
	readonly label: string;
	readonly text: string;
}

/**
 * Line-start markers that open a segment: harness section symbols, markdown
 * H1/H2 headings, the wrapper tags the harness injects, and the memory
 * section headers.
 */
const SEGMENT_OPENERS = [
	/^§ \S/,
	/^#{1,2} \S/,
	/^<skills>/,
	/^<project-context>/,
	/^<repo-rules>/,
	/^<workstation>/,
	/^<critical>/,
	/^<memory_guidance>/,
	/^Memory summary:/,
	/^Learned lessons \(/,
];

export function splitIntoSegments(text: string): readonly PromptSegment[] {
	if (text.length === 0) return [{ label: "(empty)", text: "" }];
	const boundaries: { offset: number; label: string }[] = [];
	let offset = 0;
	let fenced = false;
	for (const line of text.split("\n")) {
		// Fences toggle verbatim mode: headings and tags inside stay literal.
		if (!fenced && SEGMENT_OPENERS.some(pattern => pattern.test(line))) {
			const trimmed = line.trim();
			// `# Context file: <abs>` names its own source file — shorten $HOME so
			// the row still fits the sidebar, and never truncate the path itself.
			const contextFile = /^# Context file: (.+)$/.exec(trimmed);
			const home = os.homedir();
			const label = contextFile
				? `# Context file: ${contextFile[1].startsWith(home) ? `~${contextFile[1].slice(home.length)}` : contextFile[1]}`
				: trimmed.startsWith("<") && trimmed.endsWith(">")
					? trimmed
					: trimmed.slice(0, 72);
			boundaries.push({ offset, label });
		}
		const trimmedStart = line.trimStart();
		if (trimmedStart.startsWith("```") || trimmedStart.startsWith("~~~")) fenced = !fenced;
		offset += line.length + 1; // account for the "\n" consumed by split()
	}
	if (boundaries.length === 0) return [{ label: "(preamble)", text }];
	const segments: PromptSegment[] = [];
	if (boundaries[0].offset > 0) segments.push({ label: "(preamble)", text: text.slice(0, boundaries[0].offset) });
	for (let index = 0; index < boundaries.length; index += 1) {
		const boundary = boundaries[index];
		const end = index + 1 < boundaries.length ? boundaries[index + 1].offset : text.length;
		segments.push({ label: boundary.label, text: text.slice(boundary.offset, end) });
	}
	// A marker whose whole segment is its own line (`§ Runtime`, `<project-context>`)
	// is a heading for what follows: fold it into the next segment and keep the
	// nesting in the label instead of spending a row on 3 tokens.
	const merged: PromptSegment[] = [];
	let pendingLabels: string[] = [];
	let pendingText = "";
	for (const segment of segments) {
		if (segment.text.replace(/\n$/, "").split("\n").length === 1 && segment.label !== "(preamble)") {
			pendingLabels.push(segment.label);
			pendingText += segment.text;
			continue;
		}
		merged.push({
			label: [...pendingLabels, segment.label].join(" · "),
			text: pendingText + segment.text,
		});
		pendingLabels = [];
		pendingText = "";
	}
	if (pendingLabels.length > 0) merged.push({ label: pendingLabels.join(" · "), text: pendingText });
	return merged;
}
