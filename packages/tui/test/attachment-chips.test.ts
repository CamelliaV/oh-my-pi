import { beforeAll, describe, expect, it } from "bun:test";
import { AttachmentChipsBand } from "@oh-my-pi/pi-tui/prompt/attachment-chips";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { chipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { ImageBudget } from "@oh-my-pi/pi-tui";
import { setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getAvailableSymbolPresets, SYMBOL_PRESETS } from "@oh-my-pi/pi-tui/theme/symbols";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";

// 2x2 red PNG — real header so the band's dimension probe decodes 2x2.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBhQAAA9+AQBHYLp7wAAAABJRU5ErkJggg==";

function makeBand(): { editor: CustomEditor; band: AttachmentChipsBand } {
	const editor = new CustomEditor(getEditorTheme());
	return {
		editor,
		band: new AttachmentChipsBand(
			() => editor,
			new ImageBudget(8),
			() => {},
		),
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("AttachmentChipsBand", () => {
	it("renders nothing while no attachment is staged", () => {
		const { band } = makeBand();
		expect(band.render(80)).toEqual([]);
	});

	it("renders an 8-row card with the chip token caption and paste line caption", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("line1\nline2\nline3");
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows).toHaveLength(8);
		expect(rows[0]).toContain(chipLabel("paste", 1));
		expect(rows[7]).toContain("+3 lines");
		// Snippet: leading content rows inside the border rails.
		expect(rows[1]).toContain("line1");
		expect(rows[2]).toContain("line2");
	});

	it("captions a single-line paste with its character count", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("x".repeat(42));
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows[7]).toContain("42 chars");
	});

	it("hides the card once its inline token is deleted from the buffer", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("line1\nline2");
		expect(band.render(80)).toHaveLength(8);
		editor.setText("no token here");
		expect(band.render(80)).toEqual([]);
	});

	it("captions an image card with probed pixel dimensions and shows both cards side by side", () => {
		const { editor, band } = makeBand();
		editor.pendingImages.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
		editor.insertAtom(chipLabel("image", 1), "[Image #1, 2x2]");
		editor.insertTextAttachment("hello");
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows).toHaveLength(8);
		expect(rows[0]).toContain(chipLabel("image", 1));
		expect(rows[0]).toContain(chipLabel("paste", 1));
		expect(rows[7]).toContain("2x2");
		expect(rows[7]).toContain("5 chars");
	});

	it("renders a contact-sheet preview under a distinct video chip", () => {
		const { editor, band } = makeBand();
		editor.pendingImages.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
		editor.pendingImageLinks.push("/tmp/launch.mp4");
		editor.insertAtom(chipLabel("video", 1), "[Video #1, 2x2]");

		const rows = band.render(80).map(Bun.stripANSI);

		expect(rows[0]).toContain(chipLabel("video", 1));
		expect(rows[0]).not.toContain(chipLabel("image", 1));
		expect(rows[7]).toContain("2x2");
	});

	it("omits cards that do not fit the terminal width instead of wrapping", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("first");
		editor.insertTextAttachment("second");
		// 22 cols per card + 2 gap: at width 30 only the first card fits.
		const rows = band.render(30).map(Bun.stripANSI);
		expect(rows[0]).toContain(chipLabel("paste", 1));
		expect(rows[0]).not.toContain(chipLabel("paste", 2));
	});

	it("describes a paste as a click-to-preview card with a bounded hovercard", () => {
		const editor = new CustomEditor(getEditorTheme());
		const previews: number[] = [];
		const band = new AttachmentChipsBand(
			() => editor,
			new ImageBudget(8),
			() => {},
			chip => previews.push(chip.n),
		);
		editor.insertTextAttachment(`${"x".repeat(500)}\nsecond`);
		// The band ignores the context while describing its own cards.
		const root = band.describe({} as DescribeContext);
		const card = root.c?.[0];
		if (!card || !("k" in card) || card.k !== "card") throw new Error("expected a card");
		expect(card.p?.actions).toEqual({ click: "preview" });
		expect(card.p?.title).toBe("Click to preview");
		const hovercard = card.p?.hovercard;
		if (!hovercard || hovercard.k !== "col") throw new Error("expected a hovercard column");
		const hoverBody = hovercard.c?.[1];
		if (!hoverBody || !("k" in hoverBody) || hoverBody.k !== "text") throw new Error("expected hover text");
		const hoverText = hoverBody.p?.spans?.[0]?.t ?? "";
		expect(hoverText.split("\n")[0]).toHaveLength(120);
		const preview = card.c?.[0];
		if (!preview || !("k" in preview) || preview.k !== "text") throw new Error("expected preview text");
		const previewText = preview.p?.spans?.[0]?.t ?? "";
		expect(previewText.split("\n")[0]).toHaveLength(60);
		expect(preview.p?.lines).toBe(6);
		band.handleNativeEvent({ type: "action", key: "chips/paste:1", act: "preview", mods: [] });
		expect(previews).toEqual([1]);
	});

	it("describes images as click-to-zoom with a larger media box", () => {
		const { editor, band } = makeBand();
		editor.pendingImages.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
		editor.insertAtom(chipLabel("image", 1), "[Image #1, 2x2]");
		const root = band.describe({} as DescribeContext);
		const card = root.c?.[0];
		if (!card || !("k" in card) || card.k !== "card") throw new Error("expected a card");
		const image = card.c?.[0];
		if (!image || !("k" in image) || image.k !== "image") throw new Error("expected an image");
		expect(image.p?.actions).toEqual({ click: "zoom" });
		expect(image.p?.max).toEqual({ w: "32ch", h: "12lines" });
	});

	it("follows the live editor across setEditorComponent swaps", () => {
		let current = new CustomEditor(getEditorTheme());
		const band = new AttachmentChipsBand(
			() => current,
			new ImageBudget(8),
			() => {},
		);
		current.insertTextAttachment("old");
		expect(band.render(80).length).toBeGreaterThan(0);
		current = new CustomEditor(getEditorTheme());
		expect(band.render(80)).toEqual([]);
		current.insertTextAttachment("new");
		expect(band.render(80).join("")).toContain("new");
	});
});

describe("AttachmentChipsBand — Kitty placeholder thumbnails", () => {
	it("keeps every card row exactly card-width so the borders align", () => {
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = TERMINAL.imageProtocol;
		const originalCellDims = { ...getCellDimensions() };
		mutable.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 21 });
		try {
			// Real PNG header for 560x502 so the probe yields a >1-column grid.
			const header = Buffer.alloc(33);
			header.write("\x89PNG\r\n\x1a\n", 0, "binary");
			header.writeUInt32BE(13, 8);
			header.write("IHDR", 12);
			header.writeUInt32BE(560, 16);
			header.writeUInt32BE(502, 20);
			const { editor, band } = makeBand();
			editor.pendingImages.push({ type: "image", data: header.toString("base64"), mimeType: "image/png" });
			editor.insertAtom(chipLabel("image", 1), "[Image #1, 560x502]");
			const rows = band.render(80);
			expect(rows).toHaveLength(8);
			// Thumbnail path actually engaged: the placement APC rides row 1.
			expect(rows[1]).toContain("\x1b_Ga=p,U=1");
			// Regression: the placement APC was counted as visible width, which
			// dropped row 1's centering pad and painted its right border 3 cells
			// inside the card. Every row must measure exactly the card width.
			for (const row of rows) {
				expect(visibleWidth(row)).toBe(22);
			}
		} finally {
			mutable.imageProtocol = originalProtocol;
			setKittyGraphics({ unicodePlaceholders: false });
			setCellDimensions(originalCellDims);
		}
	});
	it("converts a non-PNG attachment before the Kitty transmit (f=100 accepts only PNG)", async () => {
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = TERMINAL.imageProtocol;
		const originalCellDims = { ...getCellDimensions() };
		mutable.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 21 });
		try {
			// Regression: pasted images are re-encoded JPEG/WebP; transmitting those raw
			// bytes as f=100 made Ghostty reject the data (EINVAL) and render blank cells.
			const jpeg = await new Bun.Image(Buffer.from(TINY_PNG, "base64")).jpeg().toBase64();
			const editor = new CustomEditor(getEditorTheme());
			const budget = new ImageBudget(8);
			const repaint = Promise.withResolvers<void>();
			const band = new AttachmentChipsBand(
				() => editor,
				budget,
				() => repaint.resolve(),
			);
			editor.pendingImages.push({ type: "image", data: jpeg, mimeType: "image/jpeg" });
			editor.insertAtom(chipLabel("image", 1), "[Image #1, 2x2]");
			// Conversion in flight: icon fallback, nothing transmitted yet.
			band.render(80);
			expect(budget.hasPendingTransmits()).toBe(false);
			await repaint.promise;
			const rows = band.render(80);
			expect(rows.some(row => row.includes("\x1b_Ga=p,U=1"))).toBe(true);
			const transmits = budget.takeTransmits();
			expect(transmits).toHaveLength(1);
			const payload = transmits[0]!.slice(transmits[0]!.indexOf(";") + 1);
			expect(payload.startsWith("iVBOR")).toBe(true);
		} finally {
			mutable.imageProtocol = originalProtocol;
			setKittyGraphics({ unicodePlaceholders: false });
			setCellDimensions(originalCellDims);
		}
	});
});

describe("composer token glyphs", () => {
	// Chip glyphs sit inside the editable buffer, so the hardware caret column is computed from
	// their measured width. A text-presentation pictograph (e.g. 🖼 U+1F5BC) measures 1 cell while
	// emoji-rendering terminals draw it 2, leaving the caret one cell behind per chip (#16270).
	it("measure the same width whether or not the terminal renders pictographs as emoji", () => {
		const keys = ["chip.image", "chip.video", "chip.paste", "icon.extensionSkill", "icon.model"] as const;
		for (const preset of getAvailableSymbolPresets()) {
			const symbols = SYMBOL_PRESETS[preset];
			for (const key of keys) {
				const glyph = symbols[key];
				const asEmoji = glyph.replace(/\p{Extended_Pictographic}(?!\uFE0F)/gu, "$&\uFE0F");
				expect({ preset, key, width: visibleWidth(glyph) }).toEqual({
					preset,
					key,
					width: visibleWidth(asEmoji),
				});
			}
		}
	});
});
