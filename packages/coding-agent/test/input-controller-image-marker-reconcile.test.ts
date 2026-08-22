/**
 * Contract: deleting an `[Image #N]` marker token from the composer draft drops
 * the corresponding pending image — its preview disappears and the image is no
 * longer attached to the outgoing message. Surviving markers compact back to
 * `1..K` so the positional `[Image #N]` ↔ `pendingImages[N-1]` mapping holds
 * for submit and queue merge. Regression guard for the behavior where the
 * preview strip kept rendering an image whose marker the user had deleted.
 */
import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";

function img(seed: string): ImageContent {
	return { type: "image", mimeType: "image/png", data: Buffer.from(seed).toString("base64") };
}

function createHarness(pendingImages: ImageContent[], links?: (string | undefined)[]) {
	let text = "";
	const editor = {
		pendingImages,
		pendingImageLinks: links ?? pendingImages.map(() => undefined),
		imageLinks: undefined as readonly (string | undefined)[] | undefined,
		onChange: undefined as ((text: string) => void) | undefined,
		setText(newText: string) {
			text = newText;
		},
	};
	let renderCount = 0;
	const ctx = { editor, ui: { requestRender: () => renderCount++ } };
	new InputController(ctx as never);
	expect(editor.onChange).toBeTypeOf("function");
	return {
		editor,
		get renderCount() {
			return renderCount;
		},
		type(newText: string) {
			text = newText;
			editor.onChange?.(newText);
		},
		get text() {
			return text;
		},
	};
}

describe("InputController pending-image marker reconciliation", () => {
	it("drops the pending image when its only marker is deleted", () => {
		const a = img("a");
		const h = createHarness([a], ["file://a"]);
		h.type("[Image #1] look");
		expect(h.editor.pendingImages).toEqual([a]);

		// User backspaced over the atomic `[Image #1]` token.
		h.type(" look");
		expect(h.editor.pendingImages).toEqual([]);
		expect(h.editor.pendingImageLinks).toEqual([]);
		expect(h.editor.imageLinks).toBeUndefined();
		expect(h.renderCount).toBeGreaterThan(0);
	});

	it("removes only the deleted image and compacts remaining markers", () => {
		const [a, b, c] = [img("a"), img("b"), img("c")];
		const h = createHarness([a, b, c]);
		h.type("[Image #1] one [Image #2] two [Image #3] three");

		// Marker #2 deleted; #3 must survive and renumber to #2.
		h.type("[Image #1] one [Image #3] three");
		expect(h.editor.pendingImages).toEqual([a, c]);
		expect(h.text).toBe("[Image #1] one [Image #2] three");
	});

	it("keeps state untouched while markers stay dense", () => {
		const [a, b] = [img("a"), img("b")];
		const h = createHarness([a, b]);
		h.type("[Image #1] x [Image #2] y");
		expect(h.editor.pendingImages).toEqual([a, b]);
		expect(h.text).toBe("[Image #1] x [Image #2] y");
		expect(h.renderCount).toBe(0);
	});

	it("ignores dangling numbers without a backing image (undo restored a marker)", () => {
		const a = img("a");
		const h = createHarness([a]);
		h.type("[Image #1] x [Image #9]");
		expect(h.editor.pendingImages).toEqual([a]);
		expect(h.text).toBe("[Image #1] x [Image #9]");
	});
});
