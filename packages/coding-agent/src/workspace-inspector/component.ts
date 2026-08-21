import * as path from "node:path";
import {
	type Component,
	matchesKey,
	routeSgrMouseInput,
	sliceByColumn,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { type LspNavigationAction, type LspNavigationLocation, queryLspLocations } from "../lsp";
import { renderDiff } from "../modes/components/diff";
import {
	bottomBorder,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorderSplit,
} from "../modes/components/overlay-box";
import { theme } from "../modes/theme/theme";
import { replaceTabs } from "../tools/render-utils";
import {
	type GitSnapshotResult,
	type HistoryEntry,
	loadCommitDiff,
	loadDiff,
	loadHistory,
	loadWorkspaceSnapshot,
	type WorkspaceChange,
	type WorkspaceSnapshot,
} from "./git-snapshot";

type View = "changes" | "history";
type Focus = "files" | "diff";
type Pane = "files" | "diff";

interface DiffRow {
	rendered: string;
	content: string;
	line: number | null;
}
interface InspectorOptions {
	cwd: string;
	tui: TUI;
	onClose: () => void;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
	select: (title: string, options: string[]) => Promise<string | undefined>;
}

function parseHunkHeader(line: string): { oldLine: number; newLine: number } | null {
	const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	if (!match) return null;
	return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

function parseDiffRows(raw: string): { text: string; rows: DiffRow[] } {
	const rows: DiffRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
		const hunk = parseHunkHeader(line);
		if (hunk) {
			oldLine = hunk.oldLine;
			newLine = hunk.newLine;
			rows.push({ rendered: line, content: line, line: null });
			continue;
		}
		if (!line.startsWith(" ") && !line.startsWith("+") && !line.startsWith("-")) continue;
		if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
		const prefix = line[0] ?? " ";
		const content = line.slice(1);
		if (prefix === "-") {
			rows.push({ rendered: `-${oldLine}|${content}`, content, line: null });
			oldLine += 1;
		} else if (prefix === "+") {
			rows.push({ rendered: `+${newLine}|${content}`, content, line: newLine });
			newLine += 1;
		} else {
			rows.push({ rendered: ` ${newLine}|${content}`, content, line: newLine });
			oldLine += 1;
			newLine += 1;
		}
	}
	return { text: rows.map(row => row.rendered).join("\n"), rows };
}

function formatStatus(change: WorkspaceChange): string {
	const staged = change.index === " " ? "·" : change.index;
	const worktree = change.worktree === " " ? "·" : change.worktree;
	const stagedColor = change.index === " " ? "muted" : "accent";
	const workColor = change.worktree === " " ? "muted" : "warning";
	return `${theme.fg(stagedColor, staged)}${theme.fg(workColor, worktree)}`;
}
function formatChange(change: WorkspaceChange): string {
	const counts =
		change.index === "?" && change.worktree === "?"
			? theme.fg("toolDiffAdded", "U")
			: `${theme.fg("toolDiffAdded", `+${change.additions}`)}${theme.fg("toolDiffRemoved", ` -${change.deletions}`)}`;
	const ext = path.extname(change.path).slice(1).toLowerCase() || change.path;
	return `${formatStatus(change)} ${counts} ${theme.getLangIconStyled(ext)} ${change.path}`;
}

function formatLocation(location: LspNavigationLocation, cwd: string): string {
	const displayPath = path.relative(cwd, location.path) || path.basename(location.path);
	return `${displayPath}:${location.line}:${location.column} [${location.serverName}]`;
}

export class WorkspaceInspectorComponent implements Component {
	#cwd: string;
	#tui: TUI;
	#onClose: () => void;
	#notify: InspectorOptions["notify"];
	#select: InspectorOptions["select"];
	#view: View = "changes";
	#focus: Focus = "files";
	#snapshot: WorkspaceSnapshot | null = null;
	#history: HistoryEntry[] = [];
	#selected = 0;
	#diffCursor = 0;
	#fileScroll = 0;
	#diffScroll = 0;
	#historyScroll = 0;
	#diffRows: DiffRow[] = [];
	#diffLines: string[] = [];
	#locations: LspNavigationLocation[] = [];
	#locationCursor = 0;
	#locationScroll = 0;
	#softWrap = true;
	#sourceLines: string[] | null = null;
	#sourceLocation: LspNavigationLocation | null = null;
	#status = "Loading…";
	#loading = true;
	#generation = 0;
	#detailGeneration = 0;
	#requestController = new AbortController();
	#lastWidth = 0;
	#diffPan = 0;
	#drag: { pane: Pane; row: number; col: number; scroll: number; pan: number; moved: boolean } | null = null;

	constructor(options: InspectorOptions) {
		this.#cwd = options.cwd;
		this.#tui = options.tui;
		this.#onClose = options.onClose;
		this.#notify = options.notify;
		this.#select = options.select;
	}

	static async create(options: InspectorOptions): Promise<WorkspaceInspectorComponent> {
		const component = new WorkspaceInspectorComponent(options);
		await component.refresh();
		return component;
	}

	async refresh(): Promise<void> {
		const generation = ++this.#generation;
		this.#loading = true;
		this.#status = "Refreshing…";
		this.#requestController.abort();
		this.#requestController = new AbortController();
		this.#tui.requestRender();
		if (this.#view === "history") {
			try {
				this.#history = await loadHistory(this.#cwd, 50, this.#requestController.signal);
				if (generation !== this.#generation) return;
				this.#selected = Math.min(this.#selected, Math.max(0, this.#history.length - 1));
				await this.#loadHistoryDiff(generation);
			} catch (error) {
				if (generation === this.#generation) this.#status = error instanceof Error ? error.message : String(error);
			}
			this.#loading = false;
			this.#tui.requestRender();
			return;
		}
		const result: GitSnapshotResult = await loadWorkspaceSnapshot(this.#cwd, this.#requestController.signal);
		if (generation !== this.#generation) return;
		this.#snapshot = result.snapshot;
		this.#status = result.error ?? (result.snapshot ? "Ready" : "Not a Git repository");
		if (this.#snapshot && this.#snapshot.changes.length > 0) {
			this.#selected = Math.min(this.#selected, this.#snapshot.changes.length - 1);
			await this.#loadSelectedDiff(generation);
		} else {
			this.#diffRows = [];
			this.#diffLines = [];
		}
		this.#loading = false;
		this.#tui.requestRender();
	}
	requestRefresh(): void {
		void this.refresh();
	}

	dispose(): void {
		this.#requestController.abort();
	}

	invalidate(): void {
		this.#tui.requestRender();
	}

	render(width: number): readonly string[] {
		this.#lastWidth = width;
		const height = Math.max(16, process.stdout.rows || 40);
		const sidebarWidth = this.#sidebarWidth();
		const bodyRows = Math.max(8, height - 4);
		const title = `Workspace Inspector · ${this.#view === "changes" ? "Changes" : "History"}`;
		const lines: string[] = [topBorderSplit(width, title, sidebarWidth)];
		const left = this.#view === "changes" ? this.#renderChangesList() : this.#renderHistoryList();
		const right = this.#renderRightPane();
		const wrap = this.#softWrap;
		const pan = wrap ? 0 : this.#diffPan;
		const bodyWidth = splitBodyWidth(width, sidebarWidth);
		const rightWrapped: string[] = [];
		if (wrap) {
			for (const line of right) {
				if (!line) {
					rightWrapped.push("");
					continue;
				}
				const segments = wrapTextWithAnsi(line, bodyWidth);
				rightWrapped.push(...segments);
			}
		}
		const body = wrap ? rightWrapped : right;
		for (let index = 0; index < bodyRows; index += 1) {
			const bodyLine = pan > 0 ? sliceByColumn(body[index] ?? "", pan, bodyWidth) : (body[index] ?? "");
			lines.push(splitRow(left[index] ?? "", bodyLine, width, sidebarWidth));
		}
		lines.push(dividerSplit(width, sidebarWidth));
		lines.push(this.#renderFooter(width));
		lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(data: string): void {
		if (
			routeSgrMouseInput(data, event => {
				const pane = event.col <= this.#sidebarWidth() ? "files" : "diff";
				if (event.wheel !== null) {
					this.#wheel(pane, event.wheel);
					return true;
				}
				if (event.wheelX !== null && pane === "diff") {
					this.#diffPan = Math.max(0, this.#diffPan + event.wheelX * 8);
					this.#tui.requestRender();
					return true;
				}
				if (event.leftClick) {
					this.#drag = { pane, row: event.row, col: event.col, scroll: 0, pan: 0, moved: false };
					this.#drag.scroll = this.#paneScroll(pane);
					this.#drag.pan = pane === "diff" ? this.#diffPan : 0;
					return true;
				}
				if (event.motion && this.#drag) {
					const dy = this.#drag.row - event.row;
					const dx = event.col - this.#drag.col;
					if (!this.#drag.moved && Math.abs(dy) + Math.abs(dx) < 5) return true;
					this.#drag.moved = true;
					if (this.#drag.pane === "diff" && (dy !== 0 || dx !== 0)) {
						this.#scrollPane("diff", dy);
						this.#diffPan = Math.max(0, this.#drag.pan + dx);
					} else if (dy !== 0) {
						this.#scrollPane("files", dy);
					}
					return true;
				}
				if (event.release) {
					if (this.#drag && !this.#drag.moved && this.#drag.pane === "files") this.#clickFileRow(this.#drag.row);
					this.#drag = null;
				}
				return true;
			})
		)
			return;
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			if (this.#sourceLines) {
				this.#sourceLines = null;
				this.#sourceLocation = null;
				this.#tui.requestRender();
				return;
			}
			if (this.#locations.length > 0) {
				this.#locations = [];
				this.#locationCursor = 0;
				this.#locationScroll = 0;
				this.#tui.requestRender();
				return;
			}
			this.#onClose();
			return;
		}
		if (matchesKey(data, "1")) {
			this.#switchView("changes");
			return;
		}
		if (matchesKey(data, "2")) {
			this.#switchView("history");
			return;
		}
		if (matchesKey(data, "w")) {
			this.#softWrap = !this.#softWrap;
			this.#diffPan = 0;
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.#focus = this.#focus === "files" ? "diff" : "files";
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			if (this.#focus !== "diff") {
				this.#focus = "diff";
				this.#tui.requestRender();
				return;
			}
			this.#diffPan = Math.max(0, this.#diffPan + (matchesKey(data, "right") ? 16 : -16));
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "r")) {
			this.requestRefresh();
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
		if (matchesKey(data, "d")) {
			void this.#navigate("definition");
			return;
		}
		if (matchesKey(data, "shift+r")) {
			void this.#navigate("references");
			return;
		}
		if (matchesKey(data, "o")) {
			void this.#openLocation();
		}
	}

	#sidebarWidth(): number {
		const preferred = Math.max(18, Math.floor(this.#lastWidth * 0.38));
		return Math.max(1, Math.min(preferred, Math.max(1, this.#lastWidth - 12)));
	}

	#visibleRowIndex(screenRow: number): number | null {
		const scroll = this.#view === "changes" ? this.#fileScroll : this.#historyScroll;
		const index = scroll + screenRow - 2;
		const length = this.#view === "changes" ? (this.#snapshot?.changes.length ?? 0) : this.#history.length;
		return index >= 0 && index < length ? index : null;
	}

	/** Content line count of the pane that the pointer is over (wrapped rows when soft-wrap is on). */
	#paneLines(pane: Pane): number {
		if (pane === "files") {
			return this.#view === "changes" ? (this.#snapshot?.changes.length ?? 0) : this.#history.length;
		}
		const base: string[] =
			this.#sourceLines ?? (this.#locations.length > 0 ? this.#locations.map(() => "") : this.#diffLines);
		if (!this.#softWrap) return base.length;
		const bodyWidth = Math.max(10, splitBodyWidth(this.#lastWidth, this.#sidebarWidth()));
		let total = 0;
		for (const line of base) total += Math.max(1, Math.ceil((line ? visibleWidth(line) : 0) / bodyWidth));
		return total;
	}

	#paneScroll(pane: Pane): number {
		if (pane === "files") return this.#view === "changes" ? this.#fileScroll : this.#historyScroll;
		return this.#rightPaneScroll();
	}

	/** Vertical scroll of the right pane regardless of which sub-view it shows. */
	#rightPaneScroll(): number {
		return this.#sourceLines ? this.#diffScroll : this.#locationScroll;
	}

	/** Scroll the pane under the pointer by `delta` lines, clamped to content. */
	#scrollPane(pane: Pane, delta: number): void {
		const viewport = Math.max(1, (process.stdout.rows || 40) - 5);
		const length = this.#paneLines(pane);
		const max = Math.max(0, length - viewport);
		if (pane === "files") {
			if (this.#view === "changes") this.#fileScroll = Math.max(0, Math.min(max, this.#fileScroll + delta));
			else this.#historyScroll = Math.max(0, Math.min(max, this.#historyScroll + delta));
		} else if (this.#locations.length > 0) {
			this.#locationScroll = Math.max(0, Math.min(max, this.#locationScroll + delta));
		} else {
			this.#diffScroll = Math.max(0, Math.min(max, this.#diffScroll + delta));
		}
		this.#tui.requestRender();
	}

	/** Wheel over a pane: 3 lines per notch. */
	#wheel(pane: Pane, direction: -1 | 1): void {
		this.#scrollPane(pane, direction * 3);
	}

	/** Left-click (no drag) on a sidebar row: select and load its diff. */
	#clickFileRow(screenRow: number): void {
		const index = this.#visibleRowIndex(screenRow);
		if (index === null) return;
		this.#selected = index;
		this.#focus = "files";
		this.#keepFileVisible();
		if (this.#view === "changes") void this.#loadSelectedDiff(this.#generation);
		else void this.#loadHistoryDiff(this.#generation);
		this.#tui.requestRender();
	}

	#move(delta: number): void {
		if (this.#focus === "diff") {
			if (this.#sourceLines) {
				this.#diffScroll = Math.max(
					0,
					Math.min(Math.max(0, this.#sourceLines.length - 1), this.#diffScroll + delta),
				);
			} else if (this.#locations.length > 0) {
				this.#locationCursor = Math.max(0, Math.min(this.#locations.length - 1, this.#locationCursor + delta));
				this.#keepLocationVisible();
			} else if (this.#view === "changes") {
				this.#diffCursor = Math.max(0, Math.min(this.#diffRows.length - 1, this.#diffCursor + delta));
				this.#keepDiffCursorVisible();
			} else {
				this.#diffScroll = Math.max(0, Math.min(Math.max(0, this.#diffLines.length - 1), this.#diffScroll + delta));
			}
			this.#tui.requestRender();
			return;
		}
		const length = this.#view === "changes" ? (this.#snapshot?.changes.length ?? 0) : this.#history.length;
		if (length === 0) return;
		this.#selected = Math.max(0, Math.min(length - 1, this.#selected + delta));
		this.#keepFileVisible();
		if (this.#view === "changes") void this.#loadSelectedDiff(this.#generation);
		else void this.#loadHistoryDiff(this.#generation);
		this.#tui.requestRender();
	}

	#switchView(view: View): void {
		if (view === this.#view) return;
		this.#view = view;
		this.#focus = "files";
		this.#selected = 0;
		this.#fileScroll = 0;
		this.#historyScroll = 0;
		this.#diffScroll = 0;
		this.#diffPan = 0;
		this.#sourceLines = null;
		this.#sourceLocation = null;
		this.#locations = [];
		this.#locationCursor = 0;
		this.#locationScroll = 0;
		void this.refresh();
	}

	async #loadSelectedDiff(generation: number): Promise<void> {
		const detailGeneration = ++this.#detailGeneration;
		const change = this.#snapshot?.changes[this.#selected];
		if (!change) return;
		try {
			const raw = await loadDiff(this.#cwd, change, this.#requestController.signal);
			if (generation !== this.#generation || detailGeneration !== this.#detailGeneration) return;
			const parsed = parseDiffRows(raw);
			this.#diffRows = parsed.rows;
			this.#diffLines =
				raw.includes("Binary files ") || raw.includes("GIT binary patch")
					? ["Binary file changed"]
					: renderDiff(parsed.text, { filePath: change.path }).split("\n");
			this.#diffCursor = Math.max(0, Math.min(this.#diffCursor, Math.max(0, this.#diffRows.length - 1)));
			this.#diffScroll = 0;
			this.#diffPan = 0;
			this.#sourceLines = null;
			this.#locations = [];
			this.#status = "Ready";
		} catch (error) {
			if (generation === this.#generation && detailGeneration === this.#detailGeneration) {
				this.#status = error instanceof Error ? error.message : String(error);
			}
		}
		this.#tui.requestRender();
	}

	async #loadHistoryDiff(generation: number): Promise<void> {
		const detailGeneration = ++this.#detailGeneration;
		const entry = this.#history[this.#selected];
		if (!entry) return;
		try {
			const raw = await loadCommitDiff(this.#cwd, entry.sha, this.#requestController.signal);
			if (generation !== this.#generation || detailGeneration !== this.#detailGeneration) return;
			const parsed = parseDiffRows(raw);
			const firstFile = /^diff --git a\/(.+) b\//m.exec(raw)?.[1];
			this.#diffLines =
				raw.includes("Binary files ") || raw.includes("GIT binary patch")
					? ["Binary file changed"]
					: renderDiff(parsed.text, { filePath: firstFile }).split("\n");
			this.#diffScroll = 0;
			this.#diffPan = 0;
			this.#sourceLines = null;
			this.#status = "Ready";
		} catch (error) {
			if (generation === this.#generation && detailGeneration === this.#detailGeneration) {
				this.#status = error instanceof Error ? error.message : String(error);
			}
		}
		this.#tui.requestRender();
	}

	async #navigate(action: LspNavigationAction): Promise<void> {
		const change = this.#snapshot?.changes[this.#selected];
		if (!change || this.#view !== "changes") {
			this.#notify("LSP navigation is available for working-tree changes", "info");
			return;
		}
		const row = this.#diffRows[this.#diffCursor] ?? this.#diffRows.find(candidate => candidate.line !== null);
		const line = row?.line;
		if (!line) {
			this.#notify("Select an added or context line first", "info");
			return;
		}
		const tokens = [...new Set((row.content.match(/[$A-Za-z_][\w$]*/g) ?? []).filter(token => token.length > 1))];
		if (tokens.length === 0) {
			this.#notify("No symbol found on the selected line", "info");
			return;
		}
		const symbol = tokens.length === 1 ? tokens[0] : await this.#select("Select symbol", tokens);
		const detailGeneration = this.#detailGeneration;
		if (!symbol) return;
		this.#status = `Querying ${action} for ${symbol}…`;
		this.#tui.requestRender();
		try {
			const locations = await queryLspLocations({
				cwd: this.#cwd,
				file: path.resolve(this.#cwd, change.path),
				line,
				symbol,
				action,
				signal: this.#requestController.signal,
			});
			if (detailGeneration !== this.#detailGeneration) return;
			this.#locations = locations;
			this.#locationCursor = 0;
			this.#locationScroll = 0;
			this.#status =
				this.#locations.length > 0
					? `${this.#locations.length} location(s)`
					: `No ${action.replace("_", " ")} found`;
		} catch (error) {
			this.#status = error instanceof Error ? error.message : String(error);
		}
		this.#tui.requestRender();
	}

	async #openLocation(): Promise<void> {
		const location = this.#locations[this.#locationCursor];
		if (!location) return;
		try {
			const text = await Bun.file(location.path).text();
			this.#sourceLines = text.replace(/\r\n/g, "\n").split("\n");
			this.#sourceLocation = location;
			this.#diffScroll = Math.max(0, location.line - 4);
			this.#status = `Source ${formatLocation(location, this.#cwd)}`;
		} catch (error) {
			this.#notify(error instanceof Error ? error.message : String(error), "error");
		}
		this.#tui.requestRender();
	}

	#keepFileVisible(): void {
		const height = Math.max(1, (process.stdout.rows || 40) - 5);
		if (this.#view === "changes") {
			if (this.#selected < this.#fileScroll) this.#fileScroll = this.#selected;
			if (this.#selected >= this.#fileScroll + height) this.#fileScroll = this.#selected - height + 1;
			return;
		}
		if (this.#selected < this.#historyScroll) this.#historyScroll = this.#selected;
		if (this.#selected >= this.#historyScroll + height) this.#historyScroll = this.#selected - height + 1;
	}

	#keepDiffCursorVisible(): void {
		const height = Math.max(1, (process.stdout.rows || 40) - 5);
		if (this.#diffCursor < this.#diffScroll) this.#diffScroll = this.#diffCursor;
		if (this.#diffCursor >= this.#diffScroll + height) this.#diffScroll = this.#diffCursor - height + 1;
	}

	#keepLocationVisible(): void {
		const height = Math.max(1, (process.stdout.rows || 40) - 5);
		if (this.#locationCursor < this.#locationScroll) this.#locationScroll = this.#locationCursor;
		if (this.#locationCursor >= this.#locationScroll + height) {
			this.#locationScroll = this.#locationCursor - height + 1;
		}
	}

	#renderChangesList(): string[] {
		const changes = this.#snapshot?.changes ?? [];
		const rows = [`${changes.length} changed file(s)`];
		for (let index = this.#fileScroll; index < changes.length; index += 1) {
			const change = changes[index];
			const marker = index === this.#selected ? theme.fg("accent", "▸") : " ";
			rows.push(`${marker} ${formatChange(change)}`);
		}
		if (changes.length === 0) rows.push(theme.fg("muted", "Working tree is clean"));
		return rows;
	}
	#renderHistoryList(): string[] {
		const rows = [`${this.#history.length} commit(s)`];
		for (let index = this.#historyScroll; index < this.#history.length; index += 1) {
			const entry = this.#history[index];
			const marker = index === this.#selected ? theme.fg("accent", "▸") : " ";
			rows.push(
				`${marker} ${theme.styledSymbol("icon.git", "muted")} ${theme.fg("muted", entry.sha)} ${entry.subject}`,
			);
		}
		if (this.#history.length === 0) rows.push(theme.fg("muted", "No commits"));
		return rows;
	}

	#renderRightPane(): string[] {
		if (this.#sourceLines && this.#sourceLocation) {
			const start = Math.max(0, this.#diffScroll);
			return [
				`SOURCE ${formatLocation(this.#sourceLocation, this.#cwd)}`,
				...this.#sourceLines
					.slice(start, start + 100)
					.map((line, index) => `${start + index + 1}|${replaceTabs(line)}`),
			];
		}
		if (this.#locations.length > 0) {
			return [
				"LOCATIONS  press o to preview",
				...this.#locations.slice(this.#locationScroll).map((location, offset) => {
					const index = this.#locationScroll + offset;
					const marker = index === this.#locationCursor ? theme.fg("accent", "▸") : " ";
					return `${marker} ${formatLocation(location, this.#cwd)}`;
				}),
			];
		}
		const lines = this.#diffLines.length > 0 ? this.#diffLines : [this.#loading ? "Loading…" : this.#status];
		if (this.#view === "history")
			return [this.#history[this.#selected]?.subject ?? "", ...lines.slice(this.#diffScroll)];
		return [
			this.#snapshot?.changes[this.#selected]?.path ?? "",
			...lines.slice(this.#diffScroll).map((line, index) => {
				const rowIndex = this.#diffScroll + index;
				const marker = this.#focus === "diff" && rowIndex === this.#diffCursor ? theme.fg("accent", "▸") : " ";
				return `${marker}${line}`;
			}),
		];
	}

	#renderFooter(width: number): string {
		const branch = this.#snapshot ? `${this.#snapshot.branch}@${this.#snapshot.head ?? "-"}` : "no repository";
		const hints =
			"1 changes  2 history  Tab pane  w wrap  d def  R refs  o preview  r refresh  wheel/drag scroll  wheel-tilt/←/→ pan  Esc";
		return row(`${theme.fg("accent", branch)}  ${theme.fg("muted", this.#status)}  ${theme.fg("dim", hints)}`, width);
	}
}
