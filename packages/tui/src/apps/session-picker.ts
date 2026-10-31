import { logger } from "@oh-my-pi/pi-utils";
import {
	SessionSelectorComponent,
	type SessionSelectorEntry,
	type SessionSelectorOptions,
	type SessionHistoryMatcher,
} from "../overlays/session-selector";
import { runStandaloneTui } from "./standalone-picker";

/** Persistence and history capabilities supplied by the session-owning host. */
export interface SessionPickerHost<T extends SessionSelectorEntry = SessionSelectorEntry> {
	loadPinnedIds?(): Promise<ReadonlySet<string>>;
	loadHistoryMatcher?(): SessionHistoryMatcher;
	deleteSession?(session: T): Promise<boolean>;
	/** Hide a visible session. */
	hideSession?(session: T): Promise<boolean>;
	/** Restore a hidden session. */
	unhideSession?(session: T): Promise<boolean>;
	/** Rename the session and resolve with the title as stored, or null when it did not happen. */
	renameSession?(session: T, title: string): Promise<string | null>;
	setSessionPinned?(session: T, pinned: boolean): Promise<void>;
	loadAllSessions?(): Promise<T[]>;
	loadHiddenSessions?(): Promise<T[]>;
}

/** Presentation and capability controls for the standalone session picker. */
export interface SessionPickerOptions<T extends SessionSelectorEntry = SessionSelectorEntry> {
	allSessions?: T[];
	/** Prefill the search box. Fuzzy `--resume` uses this to disambiguate. */
	initialQuery?: string;
	title?: string;
	scopeLabel?: string | false;
	showCwd?: boolean;
	allowDelete?: boolean;
	/** Rename the selected session; resolve with the title as stored, or null when it did not happen. */
	onRename?: (session: T, title: string) => Promise<string | null>;
	allowGlobalScope?: boolean;
	historySearch?: boolean;
	pinnedIds?: ReadonlySet<string>;
	/** Open the picker on the hidden-sessions scope (e.g. `/hidden`). */
	initialScope?: "hidden";
}

/**
 * Map the caller's presentation options and the host's capabilities onto the
 * selector component. Kept separate from {@link selectSession} so tests can
 * prove every capability a host offers actually reaches the picker: a dropped
 * field silently removes the key it enables (Tab scope switching once died
 * here for `omp -r`, because only a preloaded global list could toggle).
 */
export function sessionSelectorOptions<T extends SessionSelectorEntry>(
	options: SessionPickerOptions<T>,
	host: SessionPickerHost<T>,
	context: {
		pinnedIds?: ReadonlySet<string>;
		historyMatcher?: SessionHistoryMatcher;
		getTerminalRows: () => number;
	},
): SessionSelectorOptions<T> {
	return {
		onDelete: options.allowDelete === false ? undefined : host.deleteSession,
		onHide: host.hideSession,
		onUnhide: host.unhideSession,
		onRename: host.renameSession,
		historyMatcher: context.historyMatcher,
		allSessions: options.allSessions,
		// `allowGlobalScope: false` keeps source-owned pickers (import) pinned
		// to the list they were given; every other picker lazily loads the
		// cross-project catalogue on Tab.
		loadAllSessions: options.allowGlobalScope === false ? undefined : host.loadAllSessions,
		loadHiddenSessions: host.loadHiddenSessions,
		initialScope: options.initialScope,
		getTerminalRows: context.getTerminalRows,
		fillHeight: true,
		standalone: true,
		title: options.title,
		initialQuery: options.initialQuery,
		scopeLabel: options.scopeLabel,
		showCwd: options.showCwd,
		pinnedIds: context.pinnedIds,
	};
}

/**
 * Show the TUI session selector and return the selected session, or null if
 * cancelled. The default OMP picker supports deletion, transcript-history
 * search, and an all-projects scope; foreign import pickers disable those
 * source-owned capabilities.
 */
export async function selectSession<T extends SessionSelectorEntry>(
	sessions: T[],
	options: SessionPickerOptions<T> = {},
	host: SessionPickerHost<T> = {},
): Promise<T | null> {
	// Rank sessions with prompt-history matches too, recovering prompts the 4KB
	// session-list prefix never sees. Best-effort: a missing/locked history.db
	// must not break the picker.
	const pinnedIds = options.pinnedIds ?? (await host.loadPinnedIds?.());

	let historyMatcher: ((query: string) => string[]) | undefined;
	if (options.historySearch !== false) {
		try {
			historyMatcher = host.loadHistoryMatcher?.();
		} catch (error) {
			logger.warn("History storage unavailable for session ranking", { error: String(error) });
		}
	}

	return runStandaloneTui<T | null>(
		({ ui, finish }) => {
			const selector = new SessionSelectorComponent(
				sessions,
				(session: T) => finish(session),
				() => finish(null),
				() => {
					ui.stop();
					process.exit(0);
				},
				{
					onDelete: options.allowDelete === false ? undefined : host.deleteSession,
					onHide: host.hideSession,
					onUnhide: host.unhideSession,
					loadHiddenSessions: host.loadHiddenSessions,
					initialScope: options.initialScope,
					onRename: options.onRename ?? host.renameSession,
					onSetPinned: host.setSessionPinned,
					historyMatcher,
					allSessions: options.allSessions,
					// Without the lazy loader, scope could only toggle when a caller
					// preloaded `allSessions` — i.e. never from `omp -r` in a folder
					// that has its own sessions. `allowGlobalScope: false` keeps
					// source-owned pickers (import) pinned to the list they were given.
					loadAllSessions: options.allowGlobalScope === false ? undefined : host.loadAllSessions,
					getTerminalRows: () => ui.terminal.rows,
					fillHeight: true,
					standalone: true,
					title: options.title,
					initialQuery: options.initialQuery,
					scopeLabel: options.scopeLabel,
					showCwd: options.showCwd,
					pinnedIds,
				},
			);
			selector.setOnRequestRender(() => ui.requestRender());
			return selector;
		},
		// Present as a fullscreen overlay so the picker borrows the terminal's
		// alternate screen buffer (vim/less idiom): the list scrolls and rows are
		// clickable via the mouse tracking the overlay enables for its lifetime.
		// Anchored top-left at full size so a mouse row maps directly to a rendered
		// line (the overlay paints from screen row 0).
		{
			overlay: {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			},
		},
	);
}
