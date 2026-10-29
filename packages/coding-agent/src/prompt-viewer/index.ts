import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { PromptViewerComponent } from "./component";

let viewerOpening = false;

async function openViewer(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("System Prompt Viewer requires the interactive TUI", "info");
		return;
	}
	if (!ctx.getPromptSnapshot) {
		ctx.ui.notify("System Prompt Viewer is unavailable in this session", "warning");
		return;
	}
	if (viewerOpening) return;
	viewerOpening = true;
	try {
		const snapshot = ctx.getPromptSnapshot();
		await ctx.ui.custom(
			async (tui, _theme, _keybindings, done) =>
				new PromptViewerComponent({
					tui,
					snapshot,
					onClose: () => done(undefined),
				}),
			{
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					margin: 0,
					fullscreen: true,
				},
			},
		);
	} finally {
		viewerOpening = false;
	}
}

/** Read-only viewer for the system prompt / context / tools / skills content behind /context. */
export const createPromptViewerExtension: ExtensionFactory = pi => {
	pi.registerCommand("prompt", {
		description: "Read the system prompt, context, tool schemas, and skills catalog sent to the model",
		handler: async (_args, ctx) => openViewer(ctx),
	});
	pi.registerShortcut("alt+s", {
		description: "Open the system prompt viewer",
		handler: ctx => openViewer(ctx),
	});
};
