import {
	type Component,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	sliceByColumn,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import {
	bottomBorder,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorderSplit,
} from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { PromptBlock, PromptSection, PromptSnapshot } from "./snapshot";

interface ViewerOptions {
	tui: TUI;
	snapshot: PromptSnapshot;
	onClose: () => void;
}

interface FlatRow {
	readonly sectionIndex: number;
	readonly blockIndex: number;
	/** -1 = section header row */
	readonly kind: "section" | "block";
}

type Pane = "list" | "content";

/**
 * Read-only fullscreen viewer for the invisible system-side prompt content
 * behind the /context categories: system prompt blocks, system context blocks,
 * per-tool wire schemas, and the rendered skills catalog.
 */
export class PromptViewerComponent implements Component {
	#tui: TUI;
	#onClose: () => void;
	#snapshot: PromptSnapshot;
	#rows: FlatRow[] = [];
	#selected = 0;
	#focus: Pane = "list";
	#listScroll = 0;
	#contentScroll = 0;
	#contentPan = 0;
	#softWrap = true;
	#lastWidth = 0;
	#drag: { pane: Pane; row: number; col: number; scroll: number; pan: number; moved: boolean } | null = null;

	constructor(options: ViewerOptions) {
		this.#tui = options.tui;
		this.#onClose = options.onClose;
		this.#snapshot = options.snapshot;
		options.snapshot.sections.forEach((section, sectionIndex) => {
			this.#rows.push({ sectionIndex, blockIndex: -1, kind: "section" });
			section.blocks.forEach((_block, blockIndex) => {
				this.#rows.push({ sectionIndex, blockIndex, kind: "block" });
			});
		});
		const firstBlock = this.#rows.findIndex(rowData => rowData.kind === "block");
		this.#selected = firstBlock >= 0 ? firstBlock : 0;
	}

	invalidate(): void {
		this.#tui.requestRender();
	}

	#currentBlock(): PromptBlock | null {
		const rowData = this.#rows[this.#selected];
		if (!rowData || rowData.kind !== "block") return null;
		return this.#snapshot.sections[rowData.sectionIndex]?.blocks[rowData.blockIndex] ?? null;
	}

	#contentLines(): string[] {
		const block = this.#currentBlock();
		if (!block) {
			if (this.#snapshot.error) return [`Snapshot failed: ${this.#snapshot.error}`];
			return ["Select a block on the left"];
		}
		const text = block.text.length > 0 ? block.text : "(empty)";
		return replaceTabs(text).split("\n");
	}

	#sidebarWidth(): number {
		const preferred = Math.max(24, Math.floor(this.#lastWidth * 0.34));
		return Math.max(1, Math.min(preferred, Math.max(1, this.#lastWidth - 12)));
	}

	#viewportHeight(): number {
		return Math.max(1, (process.stdout.rows || 40) - 5);
	}

	#wrappedContentLength(): number {
		const lines = this.#contentLines();
		if (!this.#softWrap) return lines.length;
		const bodyWidth = Math.max(10, splitBodyWidth(this.#lastWidth, this.#sidebarWidth()));
		let total = 0;
		for (const line of lines) total += Math.max(1, Math.ceil((line ? visibleWidth(line) : 0) / bodyWidth));
		return total;
	}

	#scrollContent(delta: number): void {
		const max = Math.max(0, this.#wrappedContentLength() - this.#viewportHeight());
		this.#contentScroll = Math.max(0, Math.min(max, this.#contentScroll + delta));
		this.#tui.requestRender();
	}

	#selectRow(index: number): void {
		this.#selected = Math.max(0, Math.min(this.#rows.length - 1, index));
		const height = this.#viewportHeight();
		if (this.#selected < this.#listScroll) this.#listScroll = this.#selected;
		if (this.#selected >= this.#listScroll + height) this.#listScroll = this.#selected - height + 1;
		this.#contentScroll = 0;
		this.#contentPan = 0;
		this.#tui.requestRender();
	}

	#move(delta: number): void {
		if (this.#focus === "content") {
			this.#scrollContent(delta);
			return;
		}
		let index = this.#selected;
		const end = delta > 0 ? this.#rows.length - 1 : 0;
		while (index !== end) {
			index += delta > 0 ? 1 : -1;
			if (this.#rows[index]?.kind === "block") break;
		}
		this.#selectRow(index);
	}

	handleInput(data: string): void {
		if (
			routeSgrMouseInput(data, event => {
				const pane: Pane = event.col <= this.#sidebarWidth() ? "list" : "content";
				if (event.wheel !== null) {
					if (pane === "list") this.#move(event.wheel * 3 > 0 ? 1 : -1);
					else this.#scrollContent(event.wheel * 3);
					return true;
				}
				if (event.wheelX !== null && pane === "content") {
					this.#contentPan = Math.max(0, this.#contentPan + event.wheelX * 8);
					this.#tui.requestRender();
					return true;
				}
				if (event.leftClick) {
					this.#drag = { pane, row: event.row, col: event.col, scroll: 0, pan: 0, moved: false };
					this.#drag.scroll = pane === "content" ? this.#contentScroll : this.#listScroll;
					this.#drag.pan = pane === "content" ? this.#contentPan : 0;
					return true;
				}
				if (event.motion && this.#drag) {
					const dy = this.#drag.row - event.row;
					const dx = event.col - this.#drag.col;
					if (!this.#drag.moved && Math.abs(dy) + Math.abs(dx) < 5) return true;
					this.#drag.moved = true;
					if (this.#drag.pane === "content" && (dy !== 0 || dx !== 0)) {
						this.#scrollContent(dy);
						this.#contentPan = Math.max(0, this.#drag.pan + dx);
					} else if (dy !== 0) {
						this.#move(dy > 0 ? 1 : -1);
					}
					return true;
				}
				if (event.release) {
					if (this.#drag && !this.#drag.moved && this.#drag.pane === "list") {
						const index = this.#listScroll + this.#drag.row - 2;
						if (index >= 0 && index < this.#rows.length && this.#rows[index]?.kind === "block") {
							this.#focus = "list";
							this.#selectRow(index);
						}
					}
					this.#drag = null;
				}
				return true;
			})
		)
			return;
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.#onClose();
			return;
		}
		if (matchesKey(data, "1") || matchesKey(data, "2") || matchesKey(data, "3") || matchesKey(data, "4")) {
			const sectionIndex = Number(data) - 1;
			const rowIndex = this.#rows.findIndex(
				rowData => rowData.kind === "block" && rowData.sectionIndex === sectionIndex,
			);
			if (rowIndex >= 0) {
				this.#focus = "list";
				this.#selectRow(rowIndex);
			}
			return;
		}
		if (matchesKey(data, "tab")) {
			this.#focus = this.#focus === "list" ? "content" : "list";
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "w")) {
			this.#softWrap = !this.#softWrap;
			this.#contentPan = 0;
			this.#contentScroll = 0;
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			if (this.#focus !== "content") {
				this.#focus = "content";
			} else {
				this.#contentPan = Math.max(0, this.#contentPan + (matchesKey(data, "right") ? 16 : -16));
			}
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.#move(-1);
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.#move(1);
			return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			const page = this.#viewportHeight();
			if (this.#focus === "content") this.#scrollContent(matchesKey(data, "pageDown") ? page : -page);
			else this.#move(matchesKey(data, "pageDown") ? page : -page);
			return;
		}
		if (matchesKey(data, "g")) {
			if (this.#focus === "content") {
				this.#contentScroll = 0;
				this.#tui.requestRender();
			} else {
				const first = this.#rows.findIndex(rowData => rowData.kind === "block");
				if (first >= 0) this.#selectRow(first);
			}
			return;
		}
		if (matchesKey(data, "shift+g")) {
			if (this.#focus === "content") {
				this.#contentScroll = Math.max(0, this.#wrappedContentLength() - this.#viewportHeight());
				this.#tui.requestRender();
			} else {
				for (let index = this.#rows.length - 1; index >= 0; index -= 1) {
					if (this.#rows[index]?.kind === "block") {
						this.#selectRow(index);
						break;
					}
				}
			}
			return;
		}
	}

	render(width: number): readonly string[] {
		this.#lastWidth = width;
		const height = Math.max(16, process.stdout.rows || 40);
		const sidebarWidth = this.#sidebarWidth();
		const bodyRows = Math.max(8, height - 4);
		const title = `System Prompt Viewer · ${this.#snapshot.sections
			.map(section => `${section.label} ${formatNumber(section.tokens)}`)
			.join(" · ")}`;
		const lines: string[] = [topBorderSplit(width, title, sidebarWidth)];

		const left: string[] = [];
		const viewport = this.#viewportHeight();
		for (let index = this.#listScroll; index < Math.min(this.#rows.length, this.#listScroll + viewport); index += 1) {
			const rowData = this.#rows[index];
			if (!rowData) continue;
			if (rowData.kind === "section") {
				const section: PromptSection = this.#snapshot.sections[rowData.sectionIndex];
				left.push(
					`${theme.fg("accent", section.label)} ${theme.fg("muted", `${formatNumber(section.tokens)} tok`)}`,
				);
				continue;
			}
			const block = this.#snapshot.sections[rowData.sectionIndex]?.blocks[rowData.blockIndex];
			if (!block) continue;
			const marker = index === this.#selected ? theme.fg("accent", "▸") : " ";
			left.push(`${marker} ${block.label} ${theme.fg("muted", `${formatNumber(block.tokens)} tok`)}`);
		}

		const contentHeader = this.#currentBlock()?.label ?? "";
		const right: string[] = [];
		if (contentHeader) right.push(theme.fg("muted", contentHeader));
		const bodyWidth = splitBodyWidth(width, sidebarWidth);
		const rawLines = this.#contentLines();
		const pan = this.#softWrap ? 0 : this.#contentPan;
		if (this.#softWrap) {
			const wrapped: string[] = [];
			for (const line of rawLines) {
				if (!line) {
					wrapped.push("");
					continue;
				}
				wrapped.push(...wrapTextWithAnsi(line, bodyWidth));
			}
			right.push(...wrapped.slice(this.#contentScroll, this.#contentScroll + viewport));
		} else {
			right.push(...rawLines.slice(this.#contentScroll, this.#contentScroll + viewport));
		}

		for (let index = 0; index < bodyRows; index += 1) {
			const bodyLine = pan > 0 ? sliceByColumn(right[index] ?? "", pan, bodyWidth) : (right[index] ?? "");
			lines.push(splitRow(left[index] ?? "", bodyLine, width, sidebarWidth));
		}
		lines.push(dividerSplit(width, sidebarWidth));
		const wrapState = this.#softWrap ? "wrap" : `pan ${this.#contentPan}`;
		const hints = `1-4 sections  Tab pane  w wrap  g/G ends  PgUp/PgDn  wheel/drag scroll  ←/→ pan  Esc`;
		lines.push(
			row(
				`${theme.fg("accent", `${formatNumber(this.#snapshot.sections.reduce((sum, section) => sum + section.tokens, 0))} tok total`)}  ${theme.fg("muted", wrapState)}  ${theme.fg("dim", hints)}`,
				width,
			),
		);
		lines.push(bottomBorder(width));
		return lines;
	}
}
