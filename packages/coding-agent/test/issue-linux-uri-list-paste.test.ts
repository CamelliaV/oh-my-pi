/**
 * Repro: Linux saved-file screenshot clipboard pasted as "Clipboard is empty".
 *
 * KDE Spectacle's save-to-file flow (and file-manager `Ctrl+C`) puts only a
 * `text/uri-list` entry pointing at the saved PNG on the Wayland clipboard —
 * no image bytes, and an empty `text/plain`. Before the fix,
 * `InputController.handleImagePaste` had no Linux file-URL probe (only the
 * macOS `public.file-url` one), so `readImage` returned null, `readText`
 * returned "", and the paste dead-ended with "Clipboard is empty".
 *
 * Defended contract: when the clipboard advertises `text/uri-list` entries
 * that resolve to a local image file, `handleImagePaste` MUST attach the
 * image; when the uri-list holds no local image, it falls through to the
 * existing smart-paste behavior unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function createCtx() {
	const pasteText = vi.fn();
	const insertText = vi.fn();
	const insertAtom = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const pendingImages: ImageContent[] = [];
	const pendingImageLinks: (string | undefined)[] = [];
	const ctx = {
		editor: {
			pasteText,
			insertText,
			insertAtom,
			imageLinks: undefined,
			pendingImages,
			pendingImageLinks,
		} as unknown as InteractiveModeContext["editor"],
		ui: { requestRender, getFocused: () => null } as unknown as InteractiveModeContext["ui"],
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "h", path: "/tmp/h.png", displayPath: "/tmp/h.png" }),
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		spies: { pasteText, insertText, insertAtom, requestRender, showStatus, pendingImages, pendingImageLinks },
	};
}

describe("InputController.handleImagePaste (Linux text/uri-list)", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "linux-uri-paste-"));
		imgPath = path.join(tmpDir, "屏幕截图_20261003_223056.png");
		await fs.writeFile(imgPath, ONE_PX_PNG);
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("attaches the image when only a uri-list file URL is on the clipboard (Spectacle save flow)", async () => {
		const { ctx, spies } = createCtx();
		const controller = new InputController(ctx, {
			readImage: async () => null, // no image bytes: uri-list-only clipboard
			readText: async () => "", // Spectacle's text/plain is empty
			readMacFileUrls: async () => [], // off-darwin no-op
			readLinuxFileUrls: async () => [imgPath],
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		// The path must become an attachment, never literal editor text, and
		// the flow must not dead-end on "Clipboard is empty".
		expect(spies.showStatus).not.toHaveBeenCalledWith("Clipboard is empty");
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(1);
		expect(spies.pendingImages[0]?.type).toBe("image");
	});

	it("resolves percent-encoded URI entries to local paths", async () => {
		const { ctx, spies } = createCtx();
		// Percent-encoded non-ASCII directory names, as Spectacle emits them.
		const uri = new URL(`file://${imgPath}`).href;
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "",
			readMacFileUrls: async () => [],
			readLinuxFileUrls: async () => [uri],
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pendingImages.length).toBe(1);
		expect(spies.pasteText).not.toHaveBeenCalled();
	});

	it("falls through to smart-paste text when the uri-list has no local image", async () => {
		const { ctx, spies } = createCtx();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "just some copied prose",
			readMacFileUrls: async () => [],
			readLinuxFileUrls: async () => [], // e.g. a uri-list of remote http entries
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pendingImages.length).toBe(0);
		expect(spies.pasteText).toHaveBeenCalledWith("just some copied prose");
	});
});
