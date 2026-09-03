import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Box, type Component, Container, type ImageBudget, Markdown, Text } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { resolveImageOptions } from "../../tools/render-utils";
import { attachmentSgr, collapseImageMarkers, renderPlaceholders } from "../composer-attachments";
import { imageReferenceHyperlink } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";
import { ImageStrip } from "./image-strip";
import type { ReactionTarget } from "./reaction";
import { formatSessionUsageRow, type SessionUsageSnapshot } from "./work-usage";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers.
//
// The zone must be *closed* within the same render. `133;B` sets a sticky
// cursor semantic of `.input` in Ghostty (and Ghostty-derived terminals such
// as cmux) that only a command-start marker clears; leaving it latched makes
// `cursorIsAtPrompt()` permanently true and tags every subsequently painted
// cell as `.input`. Combined with `cursor-click-to-move = true` (Ghostty's
// default) that turns every left-click inside the pane into a burst of
// synthesized arrow keys on omp's pty, slamming the editor caret to column 0
// (#8030, #6115).
//
// `133;C` is therefore emitted immediately followed by `133;D;0` at the end of
// the bubble. That clears the input state without reintroducing the grouping
// problem the marker was originally omitted to avoid: the command zone opens
// and finishes inside this component, so later assistant/tool output can never
// be grouped under the first submitted prompt.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_COMMAND_START = "\x1b]133;C\x07";
const OSC133_COMMAND_DONE = "\x1b]133;D;0\x07";
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_COMMAND_START + OSC133_COMMAND_DONE;

/**
 * Component that renders a user message. Accepts an agent reaction badge
 * (see {@link ReactionTarget}) drawn right-aligned in the bubble's top padding row.
 */
export class UserMessageComponent extends Container implements ReactionTarget {
	// Memoized OSC 133 zone wrapping keyed on the underlying container render
	// (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	// component reference-stable for the transcript's incremental assembly and
	// never mutates the container's cached array.
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	readonly #frame: Box;
	#sessionLine: Text | undefined;
	/**
	 * Monotonic content version reported to the transcript container via
	 * {@link getTranscriptBlockVersion}. Bumped when an async Kitty PNG
	 * conversion lands: a committed, finalized user bubble would otherwise be
	 * replayed from its previous bytes (placeholder row) without re-rendering,
	 * stranding the converted image off-screen forever — the same contract
	 * {@link AssistantMessageComponent} uses for late tool images.
	 */
	#blockVersion = 0;
	readonly #bgColor: (value: string) => string;
	#reaction: string | undefined;
	#badgeLine: Text | undefined;

	constructor(
		text: string,
		synthetic = false,
		imageLinks?: readonly (string | undefined)[],
		sessionUsage?: SessionUsageSnapshot,
		images?: readonly ImageContent[],
		imageBudget?: ImageBudget,
		requestRepaint?: () => void,
		/** Graphics-key prefix for the inline image strip. MUST be unique per
		 * message (e.g. `user:<timestamp>`): the strip numbers its images from 1,
		 * so a shared prefix makes every message's first image resolve to the same
		 * budget graphics id — a later message's placement then shows an earlier
		 * message's pixels instead of re-transmitting its own. Stable across
		 * transcript rebuilds so a re-created component replaces the placement
		 * rather than re-transmitting. */
		imageKeyPrefix = "user",
	) {
		super();
		// Display-only collapse: the stored/wire text carries bracketed `[Image #N, WxH]` markers,
		// but the transcript shows the same compact `<icon> #N` chip the composer used. Runs before
		// Markdown layout so wrapping and bubble padding are computed on the visible text.
		text = collapseImageMarkers(text, Number.POSITIVE_INFINITY, () => {});
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		this.#bgColor = bgColor;
		// Paint the magic keywords ("ultrathink"/"orchestrate"/"workflowz") inside the rendered
		// bubble too — matching the live editor glow. The Markdown component routes code spans and
		// fenced blocks through its own code styling (never `color`), so those are already excluded;
		// `highlightMagicKeywords` additionally restores the bubble's own foreground after each
		// painted keyword so the gradient never bleeds into the rest of the line.
		const keywordReset = theme.getFgOnBgAnsi("userMessageText", "userMessageBg");
		const baseText = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) =>
					theme.fgOnBg("userMessageText", "userMessageBg", highlightMagicKeywords(value, keywordReset));
		const color = (value: string) =>
			renderPlaceholders(value, {
				renderText: baseText,
				renderReference: (label, kind, index, form) => {
					// Chip tokens keep their composer identity color; the bubble's own
					// foreground resumes after the token (same pattern as keywords).
					const styled =
						form === "chip"
							? `${attachmentSgr(kind, index)}\x1b[1m${label}\x1b[22m${keywordReset}`
							: theme.fg("accent", `\x1b[1m${label}\x1b[22m`);
					return kind === "image" || kind === "video"
						? imageReferenceHyperlink(label, index, imageLinks, () => styled)
						: styled;
				},
			});
		const md = new Markdown(text, 1, 1, getMarkdownTheme(), {
			bgColor,
			color,
		});
		md.setIgnoreTight(true);
		// Frame the bubble with the same rounded outline tool cards use, so user
		// input reads as a card even when userMessageBg is "" (terminal default,
		// transparent under terminal background opacity).
		this.#frame = new Box(0, 0, undefined, {
			chars: theme.boxRound,
			color: str => theme.fg("borderAccent", str),
		});
		this.#frame.setIgnoreTight(true);
		this.#frame.addChild(md);
		if (images && images.length > 0 && imageBudget) {
			// Images render inside the bubble frame below the text, mirroring the
			// tool-card inline images: same budget, same transcript-scale caps.
			// The repaint hook matters twice on kitty: a non-PNG payload converts
			// asynchronously, and the conversion completing must both request a
			// repaint AND bump the block version — a committed, finalized bubble
			// is otherwise replayed from its cached bytes (placeholder row) and
			// never re-renders.
			const caps = resolveImageOptions();
			const strip = new ImageStrip({
				budget: imageBudget,
				keyPrefix: imageKeyPrefix,
				maxWidthCells: caps.maxWidthCells,
				maxRows: caps.maxHeightCells ?? 20,
				maxImages: 8,
				requestRender: () => {
					this.#blockVersion++;
					requestRepaint?.();
				},
			});
			strip.setImages(images);
			this.#frame.addChild(strip);
		}
		this.addChild(this.#frame);
		if (sessionUsage) this.setSessionUsage(sessionUsage);
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	/** Show cumulative completed-session usage as a dedicated row inside this input card. */
	setSessionUsage(snapshot: SessionUsageSnapshot | undefined): void {
		if (!snapshot) {
			if (this.#sessionLine) this.#frame.removeChild(this.#sessionLine);
			this.#sessionLine = undefined;
		} else {
			const text = formatSessionUsageRow(snapshot);
			if (this.#sessionLine) {
				this.#sessionLine.setText(text);
			} else {
				this.#sessionLine = new Text(text, 1, 0).setStyleFn(value => theme.bg("userMessageBg", value));
				this.#frame.addChild(this.#sessionLine);
			}
		}
		this.#zoneSource = undefined;
		this.#zoneLines = undefined;
		this.invalidate();
	}

	setReaction(emoji: string): void {
		if (this.#reaction === emoji) return;
		this.#reaction = emoji;
		if (this.#badgeLine) {
			this.#frame.removeChild(this.#badgeLine);
			this.#badgeLine = undefined;
		}
		if (emoji) {
			// Badge as the first row INSIDE the rounded frame (this fork's bubble
			// shape): upstream's borderless bubble overwrote its own top padding
			// row, which here would wipe the frame's top border instead.
			this.#badgeLine = new Text(emoji, 1, 0).setStyleFn(value => this.#bgColor(value));
			this.#badgeLine.setIgnoreTight?.(true);
			this.#frame.children.unshift(this.#badgeLine);
			this.#frame.invalidate?.();
		}
		this.#zoneLines = undefined;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		const wrapped = lines.slice();
		wrapped[0] = OSC133_ZONE_START + wrapped[0];
		wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1] + OSC133_ZONE_CLOSE;
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}

/**
 * Collapsed placeholder for a synthetic (agent-attributed) user input in the
 * file/remote-backed transcript viewer — chiefly the advisor's `Session update`
 * replay dumps, which can each be hundreds of KiB of Markdown and, on cold open,
 * blocked the TUI for tens of seconds while every historical body was laid out
 * before the viewport clip (issue #6308).
 *
 * Collapsed by default: renders one dim summary row (label · size · line count ·
 * expand hint) and builds NO Markdown. The heavy {@link UserMessageComponent} is
 * constructed lazily only when expanded via `ctrl+o`, so blocks above the
 * viewport never pay layout cost until the reader asks to see them. The raw
 * observability data stays intact in `__advisor.jsonl`.
 */
export class CollapsedSyntheticMessageComponent implements Component {
	#expanded = false;
	#cache?: { width: number; lines: readonly string[] };
	#body?: UserMessageComponent;
	readonly #summary: string;

	constructor(
		private readonly text: string,
		private readonly imageLinks?: readonly (string | undefined)[],
	) {
		this.#summary = summarizeSyntheticInput(text);
	}

	/** ctrl+o toggle: reveal/hide the full Markdown body. */
	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#body?.invalidate?.();
	}

	dispose(): void {
		this.#body?.dispose?.();
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines = this.#expanded ? this.#renderExpanded(width) : [` ${this.#summaryRow(width)}`];
		this.#cache = { width, lines };
		return lines;
	}

	#renderExpanded(width: number): readonly string[] {
		if (!this.#body) this.#body = new UserMessageComponent(this.text, true, this.imageLinks);
		return [` ${this.#summaryRow(width)}`, ...this.#body.render(width)];
	}

	#summaryRow(width: number): string {
		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		return theme.fg("dim", truncateSummary(`${this.#summary} ${hint}`, Math.max(10, width - 1)));
	}
}

/** Truncate a plain summary label to `maxWidth` display columns, appending `…`. */
function truncateSummary(text: string, maxWidth: number): string {
	if (Bun.stringWidth(text, { countAnsiEscapeCodes: false }) <= maxWidth) return text;
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = Bun.stringWidth(ch, { countAnsiEscapeCodes: false });
		if (w + cw > maxWidth - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/**
 * One-line summary for a collapsed synthetic input: `<label> · <size> · <n>
 * lines`. The label is the first Markdown heading's text (e.g. `Session
 * update`), falling back to `Synthetic input` when the body opens with none.
 */
function summarizeSyntheticInput(text: string): string {
	const size = formatBytes(Buffer.byteLength(text, "utf-8"));
	const lineCount = text === "" ? 0 : text.split("\n").length;
	const dot = theme.sep.dot.trim();
	return `${syntheticInputLabel(text)} ${dot} ${size} ${dot} ${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

/** First Markdown heading text in `text`, else `Synthetic input`. */
function syntheticInputLabel(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		return heading ? heading[1]!.trim() || "Synthetic input" : "Synthetic input";
	}
	return "Synthetic input";
}
