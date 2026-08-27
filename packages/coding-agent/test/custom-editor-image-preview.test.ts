import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ImageBudget, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const originalProtocol = TERMINAL.imageProtocol;
function pngDraft(): ImageContent {
	return { type: "image", data: PNG_1X1, mimeType: "image/png" };
}

function plainEditor(text: string): CustomEditor {
	const editor = new CustomEditor(getEditorTheme());
	editor.setText(text);
	return editor;
}

/** Wire an editor with a fresh budget, returning the repaint hook spy. */
function wirePreview(editor: CustomEditor) {
	const requestRender = vi.fn();
	editor.setImagePreviewContext(new ImageBudget(8, () => {}), requestRender);
	return requestRender;
}

/** Strip rows the composer rendered inside its frame: everything between the
 *  top border and the tail the plain composer would have rendered anyway. */
function stripRows(lines: readonly string[], text: string): string[] {
	const plain = [...plainEditor(text).render(60)];
	const tail = plain.slice(1); // text + bottom border stay byte-identical
	const offset = lines.length - tail.length;
	expect(offset).toBeGreaterThan(1);
	expect([...lines.slice(offset)]).toEqual(tail);
	expect(lines[0]).toEqual(plain[0]); // top border unchanged
	return lines.slice(1, offset);
}

describe("CustomEditor draft-image preview", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
	});

	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
	});

	it("renders pending images inside the composer frame, above the text", () => {
		const editor = plainEditor("look at this");
		const budget = new ImageBudget(8, () => {});
		editor.setImagePreviewContext(budget, () => {});
		editor.pendingImages = [pngDraft()];

		const rows = stripRows(editor.render(60), "look at this");

		// A kitty placement (direct or unicode-placeholder) was emitted inside
		// the frame and the image data queued for transmit via the budget.
		expect(rows.some(row => row.includes("\x1b_G"))).toBe(true);
		expect(budget.hasPendingTransmits()).toBe(true);
	});

	it("keeps the composer unchanged without pending images or a preview context", () => {
		const text = "no images here";
		const plain = plainEditor(text).render(60);

		const unwired = plainEditor(text);
		unwired.pendingImages = [pngDraft()];
		expect(unwired.render(60)).toEqual(plain);

		const wired = plainEditor(text);
		wirePreview(wired);
		expect(wired.render(60)).toEqual(plain);
	});

	it("renders no preview when the terminal has no image protocol", () => {
		setTerminalImageProtocol(null);
		const editor = plainEditor("text only");
		wirePreview(editor);
		editor.pendingImages = [pngDraft()];

		expect(editor.render(60)).toEqual(plainEditor("text only").render(60));
	});

	it("holds a placeholder for non-PNG drafts until the Kitty conversion lands, then repaints", async () => {
		const jpeg: ImageContent = { type: "image", data: PNG_1X1, mimeType: "image/jpeg" };
		const editor = plainEditor("screenshot incoming");
		const requestRender = wirePreview(editor);
		editor.pendingImages = [jpeg];

		const rowsBefore = stripRows(editor.render(60), "screenshot incoming");
		expect(rowsBefore).toHaveLength(1);
		expect(rowsBefore[0]).toContain("[Image: image/jpeg]");

		// Await the real signal: pump the event loop until the conversion's
		// settle callback fires the wired repaint hook (no guessed duration).
		for (let i = 0; i < 100 && requestRender.mock.calls.length === 0; i++) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
		}
		expect(requestRender).toHaveBeenCalled();

		const rowsAfter = stripRows(editor.render(60), "screenshot incoming");
		// Fit-to-cap semantics scale the thumbnail to the row budget; assert the
		// placeholder was replaced by a real placement, not the exact height.
		expect(rowsAfter.some(row => row.includes("\x1b_G"))).toBe(true);
	});

	it("collapses drafts beyond the preview cap into a +N more line", () => {
		const editor = plainEditor("many screenshots");
		wirePreview(editor);
		editor.pendingImages = Array.from({ length: 6 }, pngDraft);

		const rows = stripRows(editor.render(60), "many screenshots");
		expect(rows[rows.length - 1]!).toContain("+2 more image");
		// Only the capped count emitted placements.
		expect(rows.filter(row => row.includes("\x1b_G"))).toHaveLength(4);
	});
});

describe("UserMessageComponent inline images", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
	});

	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
	});

	it("renders message images inside the bubble frame", () => {
		const budget = new ImageBudget(8, () => {});
		const component = new UserMessageComponent(
			"what is on this [Image #1]?",
			false,
			undefined,
			undefined,
			[pngDraft()],
			budget,
		);

		const lines = component.render(60);
		expect(lines.length).toBeGreaterThan(3);
		expect(lines[0]).toContain("╭"); // bubble frame top
		expect(lines.some(line => line.includes("\x1b_G"))).toBe(true);
		expect(lines.some(line => line.includes("what is on this"))).toBe(true);
		expect(lines[lines.length - 1]).toContain("╰"); // bubble frame bottom
		expect(budget.hasPendingTransmits()).toBe(true);
	});

	it("renders no image rows without a budget (marker-only transcript)", () => {
		const withBudget = new UserMessageComponent(
			"what is on this [Image #1]?",
			false,
			undefined,
			undefined,
			[pngDraft()],
			new ImageBudget(8, () => {}),
		).render(60);
		const withoutBudget = new UserMessageComponent(
			"what is on this [Image #1]?",
			false,
			undefined,
			undefined,
			[pngDraft()],
			undefined,
		).render(60);

		expect(withoutBudget.length).toBeLessThan(withBudget.length);
		expect(withoutBudget.some(line => line.includes("\x1b_G"))).toBe(false);
	});

	it("requests a repaint when a non-PNG bubble image finishes converting", async () => {
		// Regression: model-boundary normalization persists pasted PNGs as webp;
		// the bubble strip must convert for kitty AND ask the host to repaint,
		// otherwise the dim placeholder stays on an otherwise idle screen.
		const webp: ImageContent = { type: "image", data: PNG_1X1, mimeType: "image/webp" };
		const requestRepaint = vi.fn();
		const component = new UserMessageComponent(
			"look at this [Image #1]",
			false,
			undefined,
			undefined,
			[webp],
			new ImageBudget(8, () => {}),
			requestRepaint,
		);

		const before = component.render(60);
		expect(before.some(line => line.includes("[Image: image/webp]"))).toBe(true);

		for (let i = 0; i < 100 && requestRepaint.mock.calls.length === 0; i++) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
		}
		expect(requestRepaint).toHaveBeenCalled();

		const after = component.render(60);
		expect(after.some(line => line.includes("\x1b_G"))).toBe(true);
	});

	it("re-renders a committed bubble after conversion via the block version contract", async () => {
		// Regression (real-world wallpaper session): TranscriptContainer replays
		// the cached bytes of committed, finalized blocks without calling
		// render(). A webp bubble whose first render showed the placeholder
		// would keep replaying it forever unless the conversion's repaint also
		// bumps getTranscriptBlockVersion — the same contract assistant messages
		// use for late tool images.
		const webp: ImageContent = { type: "image", data: PNG_1X1, mimeType: "image/webp" };
		const requestRepaint = vi.fn();
		const container = new TranscriptContainer();
		const component = new UserMessageComponent(
			"wallpaper probe [Image #1]",
			false,
			undefined,
			undefined,
			[webp],
			new ImageBudget(8, () => {}),
			requestRepaint,
		);
		container.addChild(component);

		const first = container.render(80);
		expect(first.some(line => line.includes("[Image: image/webp]"))).toBe(true);
		expect(first.some(line => line.includes("\x1b_G"))).toBe(false);

		// Commit the finalized bubble into native history (flush policy offers
		// the complete settled prefix), then let the conversion land.
		const flush = container.peekFlushBatch(80);
		expect(flush).toBeDefined();
		container.acknowledgeFinalizedBatch(flush!.id);

		for (let i = 0; i < 100 && requestRepaint.mock.calls.length === 0; i++) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
		}
		expect(requestRepaint).toHaveBeenCalled();

		// A resize epoch replays the committed ledger: the late conversion must
		// surface in the replayed history instead of the placeholder forever.
		container.beginReplay();
		const replay = container.peekReplayBatch(80);
		expect(replay?.rows.some(line => line.includes("\x1b_G"))).toBe(true);
		expect(replay?.rows.some(line => line.includes("wallpaper probe"))).toBe(true);
	});
});
