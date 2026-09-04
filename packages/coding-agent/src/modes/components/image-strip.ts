import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type Component, Image, type ImageBudget, ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { isSettingsInitialized, settings } from "../../config/settings";
import { convertImageToPng } from "../../utils/image-loading";
import { theme } from "../theme/theme";

export interface ImageStripOptions {
	/** Shared TUI image budget: graphics ids, transmit-once, live-graphics cap. */
	budget?: ImageBudget;
	/** Stable prefix for per-image graphics keys so ids never collide across strips. */
	keyPrefix: string;
	/** Max rows one image may occupy. */
	maxRows: number;
	/** Max images rendered before the rest collapse into a "… +N more" line. */
	maxImages: number;
	/** Repaint hook fired when an async Kitty PNG conversion lands. */
	requestRender?: () => void;
	/** Extra caps from settings (columns clamp); height is governed by {@link maxRows}. */
	maxWidthCells?: number;
}

/**
 * A strip of images rendered as live terminal graphics (kitty/iTerm2/Sixel).
 * Shared by the composer's draft-image preview and the user-message bubble, so
 * a pasted screenshot is visible while composing and stays visible in the
 * transcript after submit and on resume.
 *
 * Rendering mirrors the transcript's tool-result images: stable per-object
 * graphics keys (repaints replace placements instead of stacking), non-PNG
 * payloads converted for kitty behind a dim placeholder, budget demotion to a
 * text fallback, and a hard cap with a "… +N more" overflow line.
 */
export class ImageStrip implements Component {
	#images: readonly ImageContent[] = [];
	#displayImages: (ImageContent | undefined)[] = [];
	#components: (Image | undefined)[] = [];
	#options: ImageStripOptions;
	#keySeq = 0;
	#keys = new WeakMap<ImageContent, string>();
	#convertedKitty = new WeakMap<ImageContent, ImageContent>();
	#kittyConversionsInFlight = new Set<ImageContent>();
	#kittyConversionsFailed = new WeakSet<ImageContent>();

	constructor(options: ImageStripOptions) {
		this.#options = options;
	}

	setImages(images: readonly ImageContent[]): void {
		this.#images = images;
	}

	invalidate(): void {
		// Image components cache by width internally; nothing extra to drop.
	}

	/**
	 * Non-PNG images still awaiting a kitty-conversion outcome — not yet
	 * converted, conversion in flight, or conversion not even started because
	 * the terminal protocol was still unknown at the strip's last render (the
	 * 18.1.x append-only transcript freezes finalized blocks, so the block must
	 * not finalize until every conversion either landed or failed). Zero when
	 * rendering is disabled, the protocol is a known non-kitty one, or every
	 * non-PNG image has a conversion outcome.
	 */
	get conversionsPending(): number {
		if (this.#images.length === 0) return 0;
		if (!this.#options.budget || (isSettingsInitialized() && !settings.get("terminal.showImages"))) return 0;
		if (TERMINAL.imageProtocol !== undefined && TERMINAL.imageProtocol !== ImageProtocol.Kitty) return 0;
		let pending = 0;
		for (const image of this.#images) {
			if (image.mimeType === "image/png") continue;
			if (this.#convertedKitty.has(image) || this.#kittyConversionsFailed.has(image)) continue;
			pending++;
		}
		return pending;
	}

	render(width: number): readonly string[] {
		const images = this.#images;
		const budget = this.#options.budget;
		if (images.length === 0 || !TERMINAL.imageProtocol || !budget) return [];
		if (isSettingsInitialized() && !settings.get("terminal.showImages")) return [];
		this.#convertKittyImages(images);

		// Display list: kitty only displays PNG, so a non-PNG image appears once
		const display = images.map(image =>
			TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
				? this.#convertedKitty.get(image)
				: image,
		);
		this.#syncComponents(display, images);

		const lines: string[] = [];
		const limit = Math.min(this.#components.length, this.#options.maxImages);
		for (let i = 0; i < limit; i++) {
			const component = this.#components[i];
			if (component) lines.push(...component.render(width));
			else lines.push(theme.fg("dim", `[Image: ${images[i]!.mimeType}]`));
		}
		const hidden = this.#components.length - limit;
		if (hidden > 0) {
			lines.push(theme.fg("dim", `… +${hidden} more image${hidden === 1 ? "" : "s"}`));
		}
		return lines;
	}

	/** Rebuild components when the display list changed (paste, submit, queue
	 *  merge, or a Kitty conversion landing); identical lists reuse them. */
	#syncComponents(display: (ImageContent | undefined)[], images: readonly ImageContent[]): void {
		if (display.length === this.#components.length && display.every((image, i) => image === this.#displayImages[i])) {
			return;
		}
		this.#displayImages = display;
		this.#components = display.map((image, i) =>
			image
				? new Image(
						image.data,
						image.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{
							maxWidthCells: this.#options.maxWidthCells,
							maxHeightCells: this.#options.maxRows,
							budget: this.#options.budget,
							imageKey: this.#imageKey(images[i]!),
						},
					)
				: undefined,
		);
	}

	#imageKey(image: ImageContent): string {
		let key = this.#keys.get(image);
		if (key === undefined) {
			key = `${this.#options.keyPrefix}:${++this.#keySeq}`;
			this.#keys.set(image, key);
		}
		return key;
	}

	#convertKittyImages(images: readonly ImageContent[]): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (const image of images) {
			if (image.mimeType === "image/png") continue;
			if (this.#convertedKitty.has(image) || this.#kittyConversionsInFlight.has(image)) continue;
			this.#kittyConversionsInFlight.add(image);
			convertImageToPng(image)
				.then(converted => {
					this.#kittyConversionsInFlight.delete(image);
					this.#convertedKitty.set(image, converted);
					this.#options.requestRender?.();
				})
				.catch(() => {
					// Conversion failed — the placeholder line stays.
					this.#kittyConversionsInFlight.delete(image);
				});
		}
	}
}
