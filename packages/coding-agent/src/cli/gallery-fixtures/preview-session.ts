import type { AgentSession } from "../../session/agent-session";

export const GALLERY_CONTEXT_WINDOW = 200_000;

export interface GallerySessionOptions {
	contextTokens?: number;
	fastMode?: boolean;
	advisorStatus?: "running" | "quota_exhausted" | "error" | "paused";
	advisorYielded?: boolean;
	usingSubscription?: boolean;
	cost?: number;
	premiumRequests?: number;
	advisorCost?: number;
	goalStatus?: "active" | "paused" | "complete" | "budget-limited" | "dropped";
}

/** Deterministic session double for production composer/status renderers. */
export function createGallerySession(options: GallerySessionOptions = {}): AgentSession {
	const contextTokens = options.contextTokens ?? 124_000;
	const model = {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		contextWindow: GALLERY_CONTEXT_WINDOW,
		thinking: true,
		provider: "anthropic",
	};
	const messages = [{ role: "user", content: "Show the production preview" }];
	const goalStatus = options.goalStatus ?? "active";
	return {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		state: { messages, model, thinkingLevel: "high" },
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isStreaming: false,
		modelRegistry: { isUsingOAuth: () => options.usingSubscription ?? false },
		settings: {
			get: (path: string) => path === "goal.statusInFooter",
			getGroup: () => ({ enabled: true, reserveTokens: 20_000 }),
		},
		sessionManager: {
			getBranch: () => GALLERY_SESSION_BRANCH,
			getUsageStatistics: () => ({
				input: 12_400,
				output: 3_600,
				cacheRead: 48_000,
				cacheWrite: 1_200,
				totalTokens: 65_200,
				orchestrationInput: 900,
				orchestrationOutput: 240,
				orchestrationCacheRead: 3_000,
				premiumRequests: options.premiumRequests ?? 2,
				cost: options.cost ?? 0.42,
			}),
			getSessionName: () => "gallery",
			getSessionId: () => "gallery-session-id",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => options.fastMode ?? false,
		getContextUsage: () => ({
			tokens: contextTokens,
			contextWindow: GALLERY_CONTEXT_WINDOW,
			percent: (contextTokens / GALLERY_CONTEXT_WINDOW) * 100,
		}),
		contextUsageRevision: 0,
		getGoalModeState: () => ({
			goal: { status: goalStatus, tokensUsed: 12_400, tokenBudget: 50_000 },
		}),
		getAdvisorStatusOverview: () =>
			options.advisorStatus
				? {
						configured: true,
						advisors: [{ status: options.advisorStatus, yielded: options.advisorYielded ?? false }],
					}
				: { configured: false, advisors: [] },
		getAdvisorCost: () => options.advisorCost ?? 0.08,
		isAdvisorUsingSubscription: () => false,
		getPrewalkState: () => false,
		compactionSpeculation: "idle",
	} as unknown as AgentSession;
}

/**
 * Deterministic persisted branch for `session_usage` previews — two work
 * units, four billed requests. Replayed by the production component, so the
 * gallery shows exactly what a resumed session with this history would.
 */
const GALLERY_SESSION_BRANCH = buildGallerySessionBranch();

function buildGallerySessionBranch() {
	const t0 = 1_789_000_000_000;
	const requests = [
		{ at: 2_000, duration: 2_400_000, input: 1_200_000, output: 84_000, cacheRead: 22_000_000, cacheWrite: 340_000 },
		{
			at: 2_462_000,
			duration: 1_500_000,
			input: 900_000,
			output: 51_000,
			cacheRead: 16_000_000,
			cacheWrite: 210_000,
		},
		{
			at: 1_844_000_000,
			duration: 1_860_000,
			input: 1_400_000,
			output: 77_000,
			cacheRead: 27_000_000,
			cacheWrite: 390_000,
		},
		{
			at: 1_847_864_000,
			duration: 1_080_000,
			input: 700_000,
			output: 38_000,
			cacheRead: 13_000_000,
			cacheWrite: 160_000,
		},
	] as const;
	const entries: object[] = [];
	for (const work of [0, 2]) {
		const userAt = t0 + (work === 0 ? 0 : 1_800_000_000);
		entries.push({ type: "message", message: { role: "user", content: "continue", timestamp: userAt } });
		for (const spec of [requests[work]!, requests[work + 1]!]) {
			entries.push({
				type: "message",
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					stopReason: "stop",
					usage: {
						input: spec.input,
						output: spec.output,
						cacheRead: spec.cacheRead,
						cacheWrite: spec.cacheWrite,
						totalTokens: spec.input + spec.output + spec.cacheRead + spec.cacheWrite,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: t0 + spec.at,
					duration: spec.duration,
				},
			});
		}
	}
	return entries;
}
