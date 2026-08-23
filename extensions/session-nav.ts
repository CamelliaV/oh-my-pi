/**
 * session-nav — viewport jump between user-turn blocks in the omp TUI.
 *
 * Alt+U or `/turns` opens a fuzzy-searchable list of every user message on the
 * ACTIVE branch (root→leaf, i.e. exactly the turns visible in the transcript):
 *
 *   enter   jump: open a fullscreen scrollable transcript viewer with the
 *           viewport positioned ON that message block. Read-only — the session
 *           is never touched.
 *   ctrl+r  rewind the session to that message (/tree Enter semantics; crop!)
 *   ctrl+b  branch a new session file at that message (crop!)
 *   esc     close
 *
 * Inside the transcript viewer:
 *   n / p     jump to next / previous user-message block
 *   ↑↓ pgup/pgdn g/G home/end — free scroll
 *   ctrl+o    toggle tool-output expansion (same as the live transcript)
 *   Pointer note: SGR mouse tracking stays OFF for the whole viewer — plain
 *   drag selects/copies text natively; the terminal translates wheel to arrow
 *   keys on the alt screen (kitty), so scrolling still works without grabs.
 *   esc       back to the picker
 *
 * The viewer renders through the REAL transcript pipeline: ChatTranscriptBuilder
 * + its component tree (user-message frames, markdown, tool cards, usage rows),
 * assembled with the same rules as TranscriptContainer (blocks stripped of
 * plain-blank edge rows, joined by exactly one blank separator row).
 *
 * ctrl+r/ctrl+b are blocked while the agent streams; enter/view works any time.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@oh-my-pi/pi-coding-agent";
import {
	CollapsedSyntheticMessageComponent,
	UserMessageComponent,
} from "@oh-my-pi/pi-coding-agent";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import type { Component, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";
import {
	extractPrintableText,
	fuzzyFilter,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	ScrollView,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

interface TurnItem {
	entryId: string;
	/** 1-based ordinal among rendered user-turn blocks on the branch. */
	num: number;
	/** Full concatenated text parts (fuzzy target). */
	text: string;
	/** First non-empty line, tab-replaced (row preview). */
	preview: string;
	/** HH:MM local time of the entry. */
	time: string;
}

interface PickerResult {
	action: "navigate" | "branch";
	item: TurnItem;
}

/** Structural slice of SessionEntry the collectors read. */
interface BranchEntryLike {
	id?: string;
	timestamp?: string;
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

const MAX_FLASH_MS = 2500;

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		if (line.trim()) return line.trim();
	}
	return "";
}

function formatTime(timestamp: string | undefined): string {
	const date = timestamp ? new Date(timestamp) : undefined;
	if (!date || Number.isNaN(date.getTime())) return "--:--";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content as Array<{ type: string; text?: string }>) {
		if (part.type === "text" && typeof part.text === "string") text += part.text;
	}
	return text;
}

/**
 * Collect rendered-turn items from the active branch. Mirrors ChatTranscriptBuilder's
 * block-creation rules exactly (user + developer roles, non-empty text) so picker
 * ordinals line up 1:1 with the viewer's user-message blocks.
 */
function collectTurns(branch: readonly BranchEntryLike[]): TurnItem[] {
	const items: TurnItem[] = [];
	for (const entry of branch) {
		if (entry.type !== "message" || !entry.id) continue;
		const message = entry.message;
		if (!message || (message.role !== "user" && message.role !== "developer")) continue;
		const text = textParts(message.content);
		if (!text) continue; // builder skips textless entries; they render no block
		items.push({
			entryId: entry.id,
			num: items.length + 1,
			text,
			preview: firstLine(replaceTabs(text)),
			time: formatTime(entry.timestamp),
		});
	}
	return items;
}

const NON_WHITESPACE = /\S/;

/** A plain blank row: empty or whitespace-only with no ANSI bytes (TranscriptContainer's rule). */
function isPlainBlank(line: string): boolean {
	return !NON_WHITESPACE.test(line);
}

function stripPlainBlankEdges(lines: readonly string[]): readonly string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isPlainBlank(lines[start]!)) start++;
	while (end > start && isPlainBlank(lines[end - 1]!)) end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

/**
 * Fullscreen scrollable transcript built from the REAL component tree, with
 * per-turn row offsets for block jumping. Assembly mirrors TranscriptContainer:
 * each block's plain-blank edge rows are trimmed and blocks are joined by
 * exactly one blank separator row.
 */
class TranscriptViewer implements Component {
	#builder: ChatTranscriptBuilder;
	#scrollView: ScrollView;
	#handle: { hide(): void } | undefined;
	#disposed = false;
	#turnRows: number[] = [];
	#targetTurn = 0;
	#builtWidth = -1;
	/** Sum of child transcript-block versions at last assembly; late async
	 *  work (Kitty PNG conversion landing) bumps child versions and forces
	 *  re-assembly so image rows replace their placeholder/fallback rows. */
	#assembledVersion = -1;
	#totalRows = 0;
	#overlayOptions: OverlayOptions = {
		mouseTracking: false,
		fullscreen: true,
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
	};

	constructor(
		branch: readonly BranchEntryLike[],
		private readonly tui: TUI,
		private readonly theme: Theme,
		cwd: string,
		startTurn: number,
	) {
		this.#builder = new ChatTranscriptBuilder({
			ui: tui,
			cwd,
			requestRender: () => this.tui.requestRender(),
		});
		this.#builder.rebuild(
			branch.filter(entry => entry.type === "message") as never,
		);
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: { track: t => this.theme.fg("dim", t), thumb: t => this.theme.fg("accent", t) },
		});
		this.#targetTurn = Math.max(0, startTurn);
		this.#handle = tui.showOverlay(this, this.#overlayOptions);
	}

	#dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#handle?.hide();
		this.#handle = undefined;
		this.#builder.dispose();
	}

	/** Sum of child transcript-block versions; changes when late async image
	 *  work (Kitty PNG conversion) lands in any block. */
	#contentVersion(): number {
		let version = 0;
		for (const child of this.#builder.container.children) {
			const component = child as { getTranscriptBlockVersion?: () => number };
			if (typeof component.getTranscriptBlockVersion === "function") {
				version += component.getTranscriptBlockVersion();
			}
		}
		return version;
	}

	/** Render every block child, assemble with separator rows, record turn-block row offsets. */
	#assemble(contentWidth: number, preserveScroll: boolean): void {
		const offset = preserveScroll ? this.#scrollView.getScrollOffset() : undefined;
		const children = this.#builder.container.children;
		const lines: string[] = [];
		const turnRows: number[] = [];
		let first = true;
		for (const child of children) {
			const rows = stripPlainBlankEdges(child.render(contentWidth));
			if (rows.length === 0) continue;
			if (!first) lines.push(""); // one blank separator between blocks
			first = false;
			if (child instanceof UserMessageComponent || child instanceof CollapsedSyntheticMessageComponent) {
				turnRows.push(lines.length);
			}
			lines.push(...rows);
		}
		this.#turnRows = turnRows;
		this.#builtWidth = contentWidth;
		this.#assembledVersion = this.#contentVersion();
		this.#totalRows = lines.length;
		this.#scrollView.setLines(lines);
		if (offset !== undefined) {
			this.#scrollView.setScrollOffset(Math.min(offset, Math.max(0, this.#totalRows - 1)));
		}
	}

	#jumpToTarget(): void {
		const row = this.#turnRows[this.#targetTurn] ?? 0;
		this.#scrollView.setScrollOffset(Math.max(0, row - 1));
	}

	#jumpTurns(delta: number): void {
		if (this.#turnRows.length === 0) return;
		this.#targetTurn = Math.min(Math.max(0, this.#targetTurn + delta), this.#turnRows.length - 1);
		this.#jumpToTarget();
	}

	/** Which turn block the viewport top currently sits on (last block start ≤ offset+1). */
	#currentTurnFromOffset(): number {
		const top = this.#scrollView.getScrollOffset() + 1;
		let current = 0;
		for (let i = 0; i < this.#turnRows.length; i++) {
			if (this.#turnRows[i]! <= top) current = i;
			else break;
		}
		return current;
	}

	/** Keep n/p relative to wherever the user last scrolled/jumped. */
	#syncTarget(): void {
		this.#targetTurn = this.#currentTurnFromOffset();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.#dispose();
			return;
		}
		// Fullscreen overlays get SGR mouse tracking from the TUI engine; route
		// the wheel to 3-rows-per-notch scrolling (same rate as Workspace Inspector).
		if (routeSgrMouseInput(data, event => {
			if (event.wheel === null) return false;
			this.#scrollView.scroll(event.wheel * 3);
			return true;
		})) {
			this.#syncTarget();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "n") || matchesKey(data, "ctrl+n")) this.#jumpTurns(1);
		else if (matchesKey(data, "p") || matchesKey(data, "ctrl+p")) this.#jumpTurns(-1);
		else if (matchesKey(data, "up")) this.#scrollView.scroll(-1);
		else if (matchesKey(data, "down")) this.#scrollView.scroll(1);
		else if (matchesKey(data, "pageUp")) this.#scrollView.scroll(-(this.#viewportRows() - 1));
		else if (matchesKey(data, "pageDown")) this.#scrollView.scroll(this.#viewportRows() - 1);
		else if (matchesKey(data, "home") || matchesKey(data, "g")) this.#scrollView.scrollToTop();
		else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) this.#scrollView.scrollToBottom();
		else if (matchesKey(data, "ctrl+o")) {
			const expanded = !this.#builder.expanded;
			this.#builder.setExpanded(expanded);
			this.#builtWidth = -1; // force re-assembly with new block heights
		} else {
			return;
		}
		this.#syncTarget();
		this.tui.requestRender();
	}

	#viewportRows(): number {
		return Math.max(3, this.tui.terminal.rows - 2);
	}

	render(width: number): readonly string[] {
		// ScrollView reserves the final column for its scrollbar; transcript
		// components carry their own 1-col left gutter (same widths as the live
		// transcript and AgentTranscriptViewer).
		const contentWidth = Math.max(1, width - 1);
		// Late async image work (Kitty PNG conversion) bumps a block's version
		// without changing width: re-assemble so placeholder/fallback rows are
		// replaced by the rendered image rows, keeping the scroll position.
		const stale = this.#contentVersion() !== this.#assembledVersion;
		const widthChanged = contentWidth !== this.#builtWidth;
		if (widthChanged || stale) {
			this.#assemble(contentWidth, this.#builtWidth >= 0);
			// A late conversion re-assembly must not yank the viewport: only
			// width changes (open, resize) re-anchor onto the target turn.
			if (widthChanged) this.#jumpToTarget();
		}
		const viewport = this.#viewportRows();
		this.#scrollView.setHeight(viewport);
		const total = this.#totalRows;
		const rows = [...this.#scrollView.render(width)];
		const currentTurn = Math.min(this.#targetTurn + 1, this.#turnRows.length);
		const currentLine = Math.min(this.#scrollView.getScrollOffset() + 1, total);
		const position =
			` ${this.theme.fg("accent", this.theme.icon.goal)} ` +
			this.theme.fg("dim", "turn ") +
			this.theme.fg("accent", this.theme.bold(String(currentTurn))) +
			this.theme.fg("dim", `/${this.#turnRows.length}`) +
			this.theme.fg("dim", " · ") +
			`${this.theme.fg("accent", "☰")} ` +
			this.theme.fg("accent", this.theme.bold(String(currentLine))) +
			this.theme.fg("dim", `/${total}`);
		const hints = this.theme.fg("dim", `n/p turn ↑↓ pgup/pgdn g/G ctrl+o:${this.#builder.expanded ? "collapse" : "expand"} esc `);
		rows.push(`${position}${" ".repeat(Math.max(1, width - visibleWidth(position) - visibleWidth(hints)))}${hints}`);
		return rows;
	}
}

/** Overlay picker listing user turns with incremental fuzzy search. */
class TurnPicker implements Component {
	#query = "";
	#filtered: readonly TurnItem[];
	#index = 0;
	#window = 0;
	#flash: { message: string; at: number } | null = null;

	constructor(
		private readonly items: readonly TurnItem[],
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly cwd: string,
		private readonly isBusy: () => boolean,
		private readonly done: (result: PickerResult | undefined) => void,
		private readonly branch: () => readonly BranchEntryLike[],
	) {
		this.#filtered = items;
		this.#index = items.length - 1; // start on the most recent turn
	}

	#applyFilter(): void {
		const query = this.#query.trim();
		this.#filtered = query ? fuzzyFilter([...this.items], query, item => item.text) : this.items;
		this.#index = query ? 0 : this.#filtered.length - 1;
		this.#window = 0;
	}

	/** Rows the list may show: leaves room for header, hint row, and the surrounding UI. */
	#visibleRows(): number {
		return Math.max(4, Math.min(16, this.tui.terminal.rows - 8));
	}

	#clamp(): void {
		const total = this.#filtered.length;
		if (total === 0) {
			this.#index = 0;
			this.#window = 0;
			return;
		}
		this.#index = Math.min(Math.max(0, this.#index), total - 1);
		const visible = this.#visibleRows();
		if (this.#index < this.#window) this.#window = this.#index;
		else if (this.#index >= this.#window + visible) this.#window = this.#index - visible + 1;
		this.#window = Math.min(Math.max(0, this.#window), Math.max(0, total - visible));
	}

	#busyFlash(): boolean {
		if (!this.isBusy()) return false;
		this.#flash = { message: "agent is streaming — esc aborts it first", at: Date.now() };
		this.tui.requestRender();
		return true;
	}

	handleInput(data: string): void {
		this.#flash = null;
		const visible = this.#visibleRows();
		const total = this.#filtered.length;

		if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || data === "\r") {
			const item = this.#filtered[this.#index];
			if (!item) return;
			// Viewport jump: read-only, never mutates the session.
			new TranscriptViewer(this.branch(), this.tui, this.theme, this.cwd, item.num - 1);
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			const item = this.#filtered[this.#index];
			if (!item || this.#busyFlash()) return;
			this.done({ action: "navigate", item });
			return;
		}
		if (matchesKey(data, "ctrl+b")) {
			const item = this.#filtered[this.#index];
			if (!item || this.#busyFlash()) return;
			this.done({ action: "branch", item });
			return;
		}
		if (matchesKey(data, "up")) this.#index = Math.max(0, this.#index - 1);
		else if (matchesKey(data, "down")) this.#index = Math.min(total - 1, this.#index + 1);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "left")) this.#index = Math.max(0, this.#index - visible);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "right")) this.#index = Math.min(total - 1, this.#index + visible);
		else if (matchesKey(data, "home")) this.#index = 0;
		else if (matchesKey(data, "end")) this.#index = total - 1;
		else if (matchesKey(data, "backspace")) {
			if (this.#query.length > 0) {
				this.#query = [...this.#query].slice(0, -1).join("");
				this.#applyFilter();
			}
		} else {
			const printable = extractPrintableText(data);
			if (printable === undefined || printable.length === 0) return;
			if (this.#query.length === 0 && printable.trim().length === 0) return;
			this.#query += printable;
			this.#applyFilter();
		}
		this.#clamp();
		this.tui.requestRender();
	}

	render(width: number): readonly string[] {
		this.#clamp();
		const theme = this.theme;
		const rows: string[] = [];
		const inner = Math.max(20, width - 4);

		const queryLabel = this.#query ? `  /${this.#query}` : "";
		rows.push(theme.fg("accent", theme.bold("User turns")) + theme.fg("muted", `  ${this.#filtered.length}/${this.items.length}${queryLabel}`));

		const visible = this.#visibleRows();
		const window = this.#filtered.slice(this.#window, this.#window + visible);
		const rowIndexWidth = this.items.length >= 10 ? 2 : 1;
		for (let i = 0; i < window.length; i++) {
			const item = window[i]!;
			const selected = this.#window + i === this.#index;
			const gutter = selected ? theme.fg("accent", "▶ ") : "  ";
			const head = selected
				? theme.fg("text", `${String(item.num).padStart(rowIndexWidth, " ")} ${item.time} `)
				: theme.fg("dim", `${String(item.num).padStart(rowIndexWidth, " ")} ${item.time} `);
			const budget = Math.max(4, inner - (visibleWidth(gutter) + item.num.toString().length + item.time.length + 2));
			const line = `${gutter}${head}${truncateToWidth(item.preview, budget)}`;
			rows.push(selected ? theme.fg("text", line) : line);
		}
		if (window.length === 0) rows.push(theme.fg("muted", "  no matching turns"));

		const flash =
			this.#flash && Date.now() - this.#flash.at < MAX_FLASH_MS ? theme.fg("warning", `  ${this.#flash.message}`) : "";
		const hint = "↑↓ search · enter jump · ^r rewind · ^b branch · esc";
		rows.push(flash || theme.fg("dim", `  ${hint}`));
		return rows;
	}
}

type CommandCapableContext = ExtensionContext & Partial<Pick<ExtensionCommandContext, "navigateTree" | "branch">>;

async function openTurnPicker(ctx: CommandCapableContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") {
		ctx.ui.notify("session-nav: interactive TUI only", "warning");
		return;
	}

	const items = collectTurns(ctx.sessionManager.getBranch() as readonly BranchEntryLike[]);
	if (items.length === 0) {
		ctx.ui.notify("No user messages on this branch yet");
		return;
	}

	const result = await ctx.ui.custom<PickerResult | undefined>(
		(tui, theme, _keybindings, done) =>
			new TurnPicker(
				items,
				tui,
				theme,
				ctx.cwd,
				() => !ctx.isIdle(),
				done,
				() => ctx.sessionManager.getBranch() as readonly BranchEntryLike[],
			),
		{ overlay: true, overlayOptions: { anchor: "center", width: "72%", maxHeight: "80%", margin: 1 } },
	);

	if (!result) return;

	try {
		if (result.action === "branch") {
			if (typeof ctx.branch !== "function") throw new Error("branch unavailable in this mode");
			await ctx.branch(result.item.entryId);
		} else {
			if (typeof ctx.navigateTree !== "function") throw new Error("navigateTree unavailable in this mode");
			await ctx.navigateTree(result.item.entryId);
		}
	} catch (error) {
		ctx.ui.notify(`session-nav: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export default function sessionNavExtension(pi: ExtensionAPI): void {
	pi.setLabel("Session Nav");

	pi.registerCommand("turns", {
		description: "Jump between user turns (viewport jump / rewind / branch)",
		handler: async (_args, ctx) => {
			await openTurnPicker(ctx);
		},
	});

	// The interactive host hands shortcuts a full command context (see
	// InputController.registerExtensionShortcuts), so navigateTree/branch are
	// available at runtime even though the declared handler type is narrower.
	pi.registerShortcut("alt+u", {
		description: "Jump between user turns",
		handler: async ctx => {
			await openTurnPicker(ctx as CommandCapableContext);
		},
	});
}
