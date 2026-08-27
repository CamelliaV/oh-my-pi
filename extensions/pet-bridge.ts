/**
 * pet-bridge — pushes agent lifecycle state to the omp desktop-pet daemon.
 *
 * The pet is an independent GUI process (desktop-pet/omp_pet.py, launched via
 * `omppet`). This extension is the omp side of the pair: it subscribes to the
 * agent lifecycle events, maintains a compact per-session state machine, and
 * forwards transitions over a unix socket so the pet can render what the agent
 * is doing WITHOUT going through the desktop notification system (which cindy
 * keeps disabled globally).
 *
 * Wire protocol (JSON lines over $XDG_RUNTIME_DIR/omp-pet.sock):
 *   → {"t":"hello","session":str,"proj":str,"pid":int}   on every (re)connect
 *   → {"t":"state","s":"thinking|tool|waiting|retry|compact","tool"?,"detail"?}
 *   → {"t":"settle","ok":bool,"aborted":bool,"label":str} terminal agent end
 *   → {"t":"poke","id":int,"kind":"pet|feed|play"}        ← pet_poke tool
 *   ← {"t":"poked","id":int,"reaction":str}
 *   → {"t":"bye"}                                         on session shutdown
 *
 * Everything degrades silently when the daemon is absent: connects are lazy,
 * bounded-timeout, and backed off — a missing pet must never cost more than a
 * failed connect() per 5s.
 */
import * as net from "node:net";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";

type WorkingState = "thinking" | "tool" | "waiting" | "retry" | "compact";

interface PetFrame {
	t: "hello" | "state" | "settle" | "poke" | "bye";
	[key: string]: unknown;
}

const CONNECT_TIMEOUT_MS = 2_000;
const RECONNECT_BACKOFF_MS = 5_000;
const POKE_TIMEOUT_MS = 3_000;
const QUEUE_CAP = 50;

function socketPath(): string {
	if (process.env.OMP_PET_SOCKET) return process.env.OMP_PET_SOCKET;
	const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
	const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
	return path.join(runtimeDir, "omp-pet.sock");
}

/** One short human-readable hint about what a tool call is doing. */
function summarizeArgs(args: unknown): string | undefined {
	if (args == null || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const candidate =
		record.command ?? record.path ?? record.file_path ?? record.pattern ?? record.query ?? record.url;
	const text = typeof candidate === "string" ? candidate : JSON.stringify(args);
	const cleaned = text.replace(/\s+/g, " ").trim();
	return cleaned ? cleaned.slice(0, 60) : undefined;
}

class PetBridge {
	#socket: net.Socket | undefined;
	#connecting = false;
	#lastAttempt = 0;
	#queue: string[] = [];
	#pending = new Map<number, (reaction: string) => void>();
	#nextId = 1;
	#rxBuffer = "";
	#connected = false;
	#sessionLabel = "";
	#lastStateFrame = "";
	#openAsks = new Set<string>();
	#terminalError: string | null = null;

	hello(ctx: ExtensionContext): void {
		const name = ctx.sessionManager.getSessionName?.() ?? "";
		this.#sessionLabel = name || path.basename(ctx.cwd);
		this.#send({
			t: "hello",
			session: this.#sessionLabel,
			proj: path.basename(ctx.cwd),
			pid: process.pid,
		});
	}

	setState(state: WorkingState, tool?: string, detail?: string, fresh?: boolean): void {
		const frame: PetFrame = { t: "state", s: state };
		if (tool) frame.tool = tool;
		if (detail) frame.detail = detail;
		if (fresh) frame.fresh = true;
		const serialized = JSON.stringify(frame);
		if (serialized === this.#lastStateFrame) return;
		this.#lastStateFrame = serialized;
		this.#send(frame);
	}

	/** First working frame of a turn: tells the pet to restart its turn clock. */
	beginTurn(): void {
		this.#terminalError = null; // a fresh turn must not inherit an old failure
		this.setState("thinking", undefined, undefined, true);
	}

	settle(ok: boolean, aborted: boolean): void {
		this.#openAsks.clear();
		this.#lastStateFrame = "";
		this.#send({ t: "settle", ok, aborted, label: this.#sessionLabel });
	}

	/** `ask` tool call started — parked on user input until its end event. */
	noteAskStart(toolCallId: string): void {
		this.#openAsks.add(toolCallId);
	}

	noteAskEnd(toolCallId: string): void {
		this.#openAsks.delete(toolCallId);
	}

	hasOpenAsks(): boolean {
		return this.#openAsks.size > 0;
	}

	/**
	 * Turn ended while an `ask` is still parked on user input. That is NOT a
	 * completion — surface it as waiting so the pet keeps its attention pose
	 * until the user answers (or starts fresh work).
	 */
	settleWaitingForAsk(): void {
		this.#lastStateFrame = "";
		this.setState("waiting", "ask");
	}

	/**
	 * Terminal auto-retry failure (empty-stop retry cap, retry cancelled, …).
	 * Turn-recovery DROPS the failed assistant turn from the branch, so
	 * agent_end's stopReason classification sees a clean history and would
	 * celebrate — remember the failure here and let agent_end surface it.
	 */
	noteRetryFailure(finalError: string | undefined): void {
		if (finalError) this.#terminalError = finalError;
	}

	consumeTerminalError(): boolean {
		const wasSet = this.#terminalError !== null;
		this.#terminalError = null;
		return wasSet;
	}

	poke(kind: string): Promise<string> {
		const id = this.#nextId++;
		const { promise, resolve } = Promise.withResolvers<string>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			resolve("（桌宠没有回应——它可能没在运行；让用户执行 omppet 启动它）");
		}, POKE_TIMEOUT_MS);
		this.#pending.set(id, reaction => {
			clearTimeout(timer);
			resolve(reaction);
		});
		this.#send({ t: "poke", id, kind });
		return promise;
	}

	describe(): string {
		if (this.#connected) return "桌宠在线。";
		if (this.#connecting) return "桌宠正在连接……";
		return "桌宠离线（未检测到 omppet 守护进程）。";
	}

	bye(): void {
		this.#send({ t: "bye" });
		const socket = this.#socket;
		this.#socket = undefined;
		this.#connected = false;
		socket?.end();
	}

	#send(frame: PetFrame): void {
		const line = `${JSON.stringify(frame)}\n`;
		if (this.#connected && this.#socket) {
			this.#socket.write(line);
			return;
		}
		if (this.#queue.length >= QUEUE_CAP) this.#queue.shift();
		this.#queue.push(line);
		this.#connect();
	}

	#connect(): void {
		if (this.#connected || this.#connecting) return;
		const now = Date.now();
		if (now - this.#lastAttempt < RECONNECT_BACKOFF_MS) return;
		this.#lastAttempt = now;
		this.#connecting = true;

		const socket = net.connect(socketPath());
		socket.setNoDelay(true);

		const drop = (): void => {
			this.#connecting = false;
			this.#connected = false;
			if (this.#socket === socket) this.#socket = undefined;
			socket.destroy();
		};

		socket.setTimeout(CONNECT_TIMEOUT_MS, () => drop());
		socket.once("error", () => drop());
		socket.once("close", () => {
			this.#connecting = false;
			this.#connected = false;
			if (this.#socket === socket) this.#socket = undefined;
			for (const [, resolve] of this.#pending) resolve("（桌宠连接中断）");
			this.#pending.clear();
		});
		socket.once("connect", () => {
			this.#connecting = false;
			this.#connected = true;
			this.#socket = socket;
			socket.setTimeout(0);
			// Fresh connection ⇒ re-identify before any queued frames.
			const queued = this.#queue.splice(0);
			socket.write(`${JSON.stringify({ t: "hello", session: this.#sessionLabel, pid: process.pid })}\n`);
			for (const line of queued) socket.write(line);
		});
		socket.on("data", (chunk: string | Uint8Array) => this.#onData(chunk));
	}

	#onData(chunk: string | Uint8Array): void {
		this.#rxBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		let newline = this.#rxBuffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.#rxBuffer.slice(0, newline).trim();
			this.#rxBuffer = this.#rxBuffer.slice(newline + 1);
			if (line) {
				try {
					const frame = JSON.parse(line) as { t?: string; id?: number; reaction?: string };
					if (frame.t === "poked" && typeof frame.id === "number") {
						const resolve = this.#pending.get(frame.id);
						if (resolve) {
							this.#pending.delete(frame.id);
							resolve(typeof frame.reaction === "string" ? frame.reaction : "……");
						}
					}
				} catch {
					// Malformed daemon frame — ignore; the pet is decorative.
				}
			}
			newline = this.#rxBuffer.indexOf("\n");
		}
	}
}

/** True when the final assistant message ended in an error/abort worth surfacing. */
function classifySettle(messages: readonly unknown[]): { ok: boolean; aborted: boolean } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: string } | undefined;
		if (message?.role === "assistant") {
			return { ok: message.stopReason !== "error", aborted: message.stopReason === "aborted" };
		}
	}
	return { ok: true, aborted: false };
}

/**
 * True when the final assistant message is a question left for the user. A turn
 * that ends this way is not a completion — the agent is parked on an answer.
 */
function endsWithQuestion(messages: readonly unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (!Array.isArray(message.content)) return false;
		let text = "";
		for (const block of message.content as Array<{ type?: string; text?: string }>) {
			if (block?.type === "text" && typeof block.text === "string") text += block.text;
		}
		return /[?？]\s*[)）】」』"']*$/.test(text.trimEnd());
	}
	return false;
}

export default function petBridgeExtension(pi: ExtensionAPI): void {
	pi.setLabel("Pet Bridge");

	const bridge = new PetBridge();

	pi.on("session_start", (_event, ctx) => bridge.hello(ctx));
	pi.on("session_switch", (_event, ctx) => bridge.hello(ctx));

	pi.on("before_agent_start", () => bridge.beginTurn());
	pi.on("agent_start", () => bridge.beginTurn());

	pi.on("tool_execution_start", event => {
		// `ask` parks the turn waiting for the user — surface it as waiting,
		// not as a tool churning.
		if (event.toolName === "ask") {
			bridge.noteAskStart(event.toolCallId);
			bridge.setState("waiting", "ask");
			return;
		}
		bridge.setState("tool", event.toolName, summarizeArgs(event.args));
	});
	pi.on("tool_execution_end", event => {
		if (event.toolName === "ask") bridge.noteAskEnd(event.toolCallId);
		bridge.setState("thinking");
	});
	pi.on("tool_approval_requested", event => bridge.setState("waiting", event.toolName));
	pi.on("tool_approval_resolved", () => bridge.setState("thinking"));

	pi.on("auto_retry_start", () => bridge.setState("retry"));
	pi.on("auto_retry_end", event => {
		if (event.success) {
			bridge.setState("thinking");
			return;
		}
		// Terminal failure: hold the retry pose; agent_end settles it as error.
		bridge.noteRetryFailure(event.finalError);
	});
	pi.on("auto_compaction_start", () => bridge.setState("compact"));
	pi.on("auto_compaction_end", () => bridge.setState("thinking"));

	pi.on("agent_end", (event, ctx) => {
		// Auto-retry continuations re-enter the loop on their own; they are not
		// a user-visible settle and must not trigger the celebration/alert pose.
		if (event.willContinue) return;
		const { ok, aborted } = classifySettle(event.messages);
		if (aborted) {
			bridge.settle(false, true);
			return;
		}
		// Terminal auto-retry failure never shows up in stopReason — recovery
		// dropped the failed turn from the branch entirely.
		if (bridge.consumeTerminalError()) {
			bridge.settle(false, false);
			return;
		}
		// A turn that ends on an open question — structured ask still parked, or
		// the model simply asked and stopped — is waiting for input, not done.
		if (bridge.hasOpenAsks() || endsWithQuestion(event.messages)) {
			bridge.settleWaitingForAsk();
			return;
		}
		// Queued steering means more work is imminent — hold the working pose
		// instead of flashing the celebration.
		if (!aborted && ctx.hasPendingMessages()) return;
		bridge.settle(ok, aborted);
	});

	pi.on("session_shutdown", () => bridge.bye());

	pi.registerTool({
		name: "pet_poke",
		label: "Pet Poke",
		description:
			"Interact with the user's desktop pet (a small cat overlay in the screen corner). " +
			"The pet mirrors your working state; use this to celebrate finishing a task, thank the pet, " +
			"or play with it when the user asks. Returns the pet's one-line reaction.",
		parameters: z.object({
			kind: z
				.enum(["pet", "feed", "play"])
				.optional()
				.describe("pet = stroke/pet it, feed = give a treat, play = dangle a toy"),
		}),
		approval: "read",
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { kind?: "pet" | "feed" | "play" };
			const reaction = await bridge.poke(params.kind ?? "pet");
			return { content: [{ type: "text", text: reaction }], details: undefined };
		},
	});

	pi.registerCommand("pet", {
		description: "Interact with the desktop pet (pet|feed|play|status)",
		getArgumentCompletions(prefix: string) {
			if (prefix.includes(" ")) return null;
			const actions = [
				{ label: "pet", value: "pet", description: "Stroke the pet" },
				{ label: "feed", value: "feed", description: "Give the pet a treat" },
				{ label: "play", value: "play", description: "Play with the pet" },
				{ label: "status", value: "status", description: "Show pet daemon status" },
			].filter(item => item.label.startsWith(prefix));
			return actions.length > 0 ? actions : null;
		},
		async handler(args, ctx) {
			const sub = args.trim().split(/\s+/)[0] || "pet";
			if (sub === "status") {
				ctx.ui.notify(`桌宠：${bridge.describe()}`);
				return;
			}
			if (sub !== "pet" && sub !== "feed" && sub !== "play") {
				ctx.ui.notify(`/pet: 未知动作 "${sub}"（可用：pet|feed|play|status）`, "warning");
				return;
			}
			ctx.ui.notify(`桌宠：${await bridge.poke(sub)}`);
		},
	});

	pi.registerShortcut("alt+p", {
		description: "Pet the desktop pet",
		handler: async ctx => {
			ctx.ui.notify(`桌宠：${await bridge.poke("pet")}`);
		},
	});
}
