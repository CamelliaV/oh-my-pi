import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Box } from "../components/box";
import { ImageBudget } from "../components/image";
import { Text } from "../components/text";
import { applyBackgroundToLine, padding, visibleWidth } from "../utils";
import { type Component, Container } from "../tui";
import { Disclosure } from "../components/disclosure";
import { Markdown } from "../components/markdown";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { ensureThemeSync, getMarkdownTheme, theme } from "../theme";
import {
	attachmentSgr,
	collapseImageMarkers,
	COMPOSER_TOKEN_REGEX,
	composerTokenRegex,
	modelChipStyle,
	modelMentionChipLabel,
	renderPlaceholders,
	skillChipStyle,
} from "../prompt/composer-attachments";
import { MODEL_MENTION_TAG_RE } from "../prompt/model-mention-syntax";
import { imageReferenceHyperlink } from "../prompt/image-references";
import { fileHyperlink } from "../render/hyperlink";
import { highlightMagicKeywords } from "../prompt/magic-keywords";
import { ImageStrip } from "./image-strip";
import { convertImageToPng } from "./image-loading";
import { resolveImageOptions } from "../render/render-utils";
import type { ReactionTarget } from "./reaction";
export interface SessionUsageSnapshot {
	durationMs: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	requests: number;
}


// the bubble. That clears the input state without reintroducing the grouping
// problem the marker was originally omitted to avoid: the command zone opens
// and finishes inside this component, so later assistant/tool output can never
// be grouped under the first submitted prompt.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_COMMAND_START = "\x1b]133;C\x07";
const OSC133_COMMAND_DONE = "\x1b]133;D;0\x07";
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_COMMAND_START + OSC133_COMMAND_DONE;

/** How a user bubble styles its prose and chips (see {@link userBubbleColor}). */
export interface UserBubbleOptions {
	/** Materialized `file://` targets per attached image, indexed by chip number. */
	imageLinks?: readonly (string | undefined)[];
	/** Agent-attributed input: dim, flat prose. */
	synthetic?: boolean;
	/** SKILL.md path for a skill chip by name; `undefined` leaves the chip unlinked. */
	skillPath?: (name: string) => string | undefined;
	/** Cumulative session usage snapshot rendered as a dedicated row in the card. */
	/** Preformatted cumulative session usage line rendered inside the card. */
	sessionUsageText?: string;
	/** Inline image payloads rendered inside the bubble below the text. */
	images?: readonly ImageContent[];
	/** Shared graphics budget the inline image strip allocates placements from. */
	imageBudget?: ImageBudget;
	/** Repaint hook for async image conversions (kitty webp→PNG). */
	requestRepaint?: () => void;
	/**
	 * Graphics-key prefix for the inline image strip. MUST be unique per
	 * message (e.g. `user:<timestamp>`): the strip numbers its images from 1,
	 * so a shared prefix makes every message's first image resolve to the same
	 * budget graphics id — a later message's placement then shows an earlier
	 * message's pixels instead of re-transmitting its own. Stable across
	 * transcript rebuilds so a re-created component replaces the placement
	 * rather than re-transmits.
	 */
	imageKeyPrefix?: string;
}

/**
 * Foreground styling for prose inside a user bubble: the bubble text color with the
 * magic-keyword glow, attachment chips in their composer identity color, and skill
 * chips as soft pills (linked to their SKILL.md) — each token restoring the bubble's
 * own foreground after it. Shared by {@link UserMessageComponent} and the skill
 * callout so both read as one turn.
 */
export function userBubbleColor(
	options: UserBubbleOptions = {},
	tokenRegex: RegExp = COMPOSER_TOKEN_REGEX,
): (value: string) => string {
	const { imageLinks, synthetic = false, skillPath } = options;
	// The Markdown component routes code spans and fenced blocks through its own code styling
	// (never `color`), so those are already excluded; `highlightMagicKeywords` additionally
	// restores the bubble's own foreground after each painted keyword so the gradient never
	// bleeds into the rest of the line.
	const keywordReset = theme.getFgOnBgAnsi("userMessageText", "userMessageBg");
	const bubbleReset = `${keywordReset}${theme.getBgAnsi("userMessageBg")}`;
	const renderText = synthetic
		? (text: string) => theme.fg("dim", text)
		: (text: string) => theme.fgOnBg("userMessageText", "userMessageBg", highlightMagicKeywords(text, keywordReset));
	return (value: string) =>
		renderPlaceholders(
			value,
			{
				renderText,
				renderSkill: (label, name) => {
					const styled = skillChipStyle(label, bubbleReset);
					const path = skillPath?.(name);
					return path ? fileHyperlink(path, styled, { line: 1 }) : styled;
				},
				renderMention: label => modelChipStyle(label, bubbleReset),
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
			},
			tokenRegex,
		);
}

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
	#imageStrip: ImageStrip | undefined;
	readonly #bgColor: (value: string) => string;
	#reaction: string | undefined;

	constructor(text: string, options: UserBubbleOptions = {}) {
		const { sessionUsageText, images, imageBudget, requestRepaint, imageKeyPrefix = "user" } = options;
		super();
		ensureThemeSync();
		// Display-only collapse: the stored/wire text carries bracketed `[Image #N, WxH]` markers,
		// but the transcript shows the same compact `<icon> #N` chip the composer used. Runs before
		// Markdown layout so wrapping and bubble padding are computed on the visible text.
		text = collapseImageMarkers(text, Number.POSITIVE_INFINITY, () => {});
		const mentionLabels: string[] = [];
		MODEL_MENTION_TAG_RE.lastIndex = 0;
		text = text.replace(MODEL_MENTION_TAG_RE, (_tag, _agent: string, name: string) => {
			const label = modelMentionChipLabel(name);
			mentionLabels.push(label);
			return label;
		});
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		this.#bgColor = bgColor;
		const md = new Markdown(text, 1, 1, getMarkdownTheme(), {
			bgColor,
			color: userBubbleColor(options, composerTokenRegex(mentionLabels)),
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
				convertToPng: image => convertImageToPng(image),
				requestRender: () => {
					this.#blockVersion++;
					requestRepaint?.();
				},
			});
			strip.setImages(images);
			this.#imageStrip = strip;
			this.#frame.addChild(strip);
		}
		this.addChild(this.#frame);
		if (sessionUsageText) this.setSessionUsage(sessionUsageText);
	}

	/**
	 * Hold this block in the transcript's ACTIVE (live, re-renderable) state
	 * while the strip's webp→PNG kitty conversions are in flight: the 18.1.x
	 * transcript container treats finalized blocks as append-only (published
	 * bytes never change), so a block that settles with the dim
	 * `[Image: …]` placeholder row would freeze it forever — the conversion
	 * lands ~hundreds of ms later with nobody left to re-render it. Staying
	 * un-finalized keeps the rows mutable until the image actually renders.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#imageStrip === undefined || this.#imageStrip.conversionsPending === 0;
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	/** Show cumulative completed-session usage as a dedicated row inside this input card. */
	setSessionUsage(text: string | undefined): void {
		if (!text) {
			if (this.#sessionLine) this.#frame.removeChild(this.#sessionLine);
			this.#sessionLine = undefined;
		} else {
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
		// The badge is spliced into the rendered rows in `render()` (below the
		// frame's top border), so clearing the zone cache is all the redraw a
		// reaction change needs — no child surgery, no Box cache involvement.
		this.#zoneLines = undefined;
		this.invalidate();
	}

	/** Reaction badge row drawn inside the frame, right-aligned in its interior. */
	#reactionRow(width: number): string {
		const vertical = theme.boxRound.vertical;
		const emoji = this.#reaction!;
		const interior = Math.max(0, width - vertical.length * 2);
		const pad = Math.max(0, interior - visibleWidth(emoji) - 1);
		return (
			theme.fg("borderAccent", vertical) +
			this.#bgColor(" ".repeat(pad) + emoji) +
			theme.fg("borderAccent", vertical)
		);
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
		if (this.#reaction !== undefined && wrapped.length > 1) {
			wrapped.splice(1, 0, this.#reactionRow(width));
		}
		wrapped[0] = OSC133_ZONE_START + wrapped[0];
		wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1] + OSC133_ZONE_CLOSE;
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}

/**
 * Always-visible dim summary row for a collapsed synthetic input. Kept as a
 * small domain renderer so the width-truncated label never pays Markdown
 * layout; the heavy body lives in the {@link Disclosure} detail slot.
 */
class SyntheticSummary implements Component {
	readonly #summary: string;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(summary: string) {
		this.#summary = summary;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		const lines = [` ${theme.fg("dim", truncateSummary(`${this.#summary} ${hint}`, Math.max(10, width - 1)))}`];
		this.#cache = { width, lines };
		return lines;
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
	#disclosure: Disclosure;

	readonly #text: string;
	readonly #imageLinks?: readonly (string | undefined)[];

	constructor(text: string, imageLinks?: readonly (string | undefined)[]) {
		this.#text = text;
		this.#imageLinks = imageLinks;

		// The heavy UserMessageComponent is constructed lazily only on the
		// first expanded render and retained across collapse/re-expand cycles.
		this.#disclosure = new Disclosure({
			summary: new SyntheticSummary(summarizeSyntheticInput(text)),
			body: () => new UserMessageComponent(this.#text, { synthetic: true, imageLinks: this.#imageLinks }),
		});
	}

	/** ctrl+o toggle: reveal/hide the full Markdown body. */
	setExpanded(expanded: boolean): void {
		this.#disclosure.setExpanded(expanded);
	}

	setIgnoreTight(ignore: boolean): this {
		this.#disclosure.setIgnoreTight(ignore);
		return this;
	}

	invalidate(): void {
		this.#disclosure.invalidate();
	}

	dispose(): void {
		this.#disclosure.dispose();
	}

	render(width: number): readonly string[] {
		return this.#disclosure.render(width);
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
