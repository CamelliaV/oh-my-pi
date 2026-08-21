import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { WorkspaceInspectorComponent } from "./component";

let inspectorOpening = false;

async function openInspector(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("Workspace Inspector requires the interactive TUI", "info");
		return;
	}
	if (inspectorOpening) return;
	inspectorOpening = true;
	try {
		await ctx.ui.custom(
			async (tui, _theme, _keybindings, done) =>
				WorkspaceInspectorComponent.create({
					cwd: ctx.cwd,
					tui,
					onClose: () => done(undefined),
					notify: (message, type) => ctx.ui.notify(message, type),
					select: async (title, options) => ctx.ui.select(title, options),
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
		inspectorOpening = false;
	}
}

/** Built-in read-only Git/LSP workspace inspector. */
export const createWorkspaceInspectorExtension: ExtensionFactory = pi => {
	pi.registerCommand("changes", {
		description: "Open the read-only Git changes, history, and LSP inspector",
		handler: async (_args, ctx) => openInspector(ctx),
	});
	pi.registerShortcut("alt+g", {
		description: "Open the Git changes and LSP inspector",
		handler: ctx => openInspector(ctx),
	});
};
