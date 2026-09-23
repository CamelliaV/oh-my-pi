import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ImageStrip as TuiImageStrip, type ImageStripOptions as TuiImageStripOptions } from "@oh-my-pi/pi-tui/chat/image-strip";
import { isSettingsInitialized, settings } from "../../config/settings";
import { convertImageToPng } from "@oh-my-pi/pi-tui/chat/image-loading";

export type ImageStripOptions = Omit<TuiImageStripOptions, "showImages" | "convertToPng">;

/** Coding-agent image strip: honors terminal.showImages and kitty PNG conversion. */
export class ImageStrip extends TuiImageStrip {
	constructor(options: ImageStripOptions) {
		super({
			...options,
			showImages: !isSettingsInitialized() || settings.get("terminal.showImages"),
			convertToPng: image => convertImageToPng(image),
		});
	}
}

export type { ImageContent };
