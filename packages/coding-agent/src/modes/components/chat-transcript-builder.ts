// The transcript builder moved to pi-tui with the v18.2.5 TUI split. Extensions
// published against the old subpath still import it from here, and the compiled
// binary only serves subpaths that exist as files under this export wildcard.
export {
	ChatTranscriptBuilder,
	type ChatTranscriptBuilderDeps,
} from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
