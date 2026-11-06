import { clearSubmittedText, refuseImages } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";

/**
 * `/explain` starts a fresh, persisted session seeded with the tail of the
 * current transcript and the bundled explainer role, then runs that turn.
 * The transition and prompt live on the interactive context so ACP/RPC hosts
 * keep their own session lifecycle.
 */
export const EXPLAIN_SLASH_COMMAND: SlashCommandSpec = {
	name: "explain",
	icon: "eye",
	description: "Explain the latest work in a new session",
	inlineHint: "[focus]",
	allowArgs: true,
	handleTui: async (command, runtime) => {
		if (refuseImages(command, runtime)) return;
		clearSubmittedText(runtime);
		await runtime.ctx.handleExplainCommand(command.args.trim());
	},
};
