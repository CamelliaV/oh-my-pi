import { describe, expect, it, vi } from "bun:test";
import type { Mock } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

interface InjectHarness {
	runtime: { ctx: InteractiveModeContext; notifyConfigChanged?: () => Promise<void> };
	injectToolsByName: Mock<(names: string[]) => Promise<string[]>>;
	showError: Mock<(msg: string) => void>;
	showStatus: Mock<(msg: string, opts?: unknown) => void>;
	notifyConfigChanged: Mock<() => Promise<void>>;
}

/**
 * `catalog` is the injectable inventory (registered tools plus built-ins the
 * session could still construct), which is deliberately wider than the active
 * set — a `--lightweight` session starts with an empty registry, so validating
 * against the active set reported every injection as unknown.
 */
function createHarness(
	catalog: readonly string[] = ["read", "edit", "bash", "grep", "ls"],
	declines: readonly string[] = [],
): InjectHarness {
	const injectToolsByName = vi.fn(async (names: string[]) => names.filter(name => !declines.includes(name)));
	const showError = vi.fn();
	const showStatus = vi.fn((_msg: string, _opts?: unknown) => {});
	const notifyConfigChanged = vi.fn(async () => {});
	const session = {
		getInjectableToolNames: async () => [...catalog],
		injectToolsByName,
	};
	const runtime = {
		ctx: {
			session,
			showError,
			showStatus,
			editor: {
				setText: () => {},
				addToHistory: () => {},
			},
		} as unknown as InteractiveModeContext,
		notifyConfigChanged,
	};
	return { runtime, injectToolsByName, showError, showStatus, notifyConfigChanged };
}

describe("/inject slash command", () => {
	it("injects named tools from the injectable catalog", async () => {
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/inject read,bash", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.injectToolsByName).toHaveBeenCalledWith(["read", "bash"]);
		expect(harness.notifyConfigChanged).toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("injects a built-in the session never constructed at startup", async () => {
		// Empty active set (`--lightweight`): the catalog still offers `bash`.
		const harness = createHarness(["bash", "read"]);

		await executeBuiltinSlashCommand("/inject bash", harness.runtime);

		expect(harness.injectToolsByName).toHaveBeenCalledWith(["bash"]);
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("reports unknown tools and does not mutate the whitelist", async () => {
		const harness = createHarness(["read", "bash"]);

		const handled = await executeBuiltinSlashCommand("/inject read,notatool", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.injectToolsByName).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith(expect.stringContaining("Unknown tools: notatool"));
	});

	it("`--all` restores the full injectable catalog", async () => {
		const harness = createHarness(["read", "edit", "bash"]);

		const handled = await executeBuiltinSlashCommand("/inject --all", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.injectToolsByName).toHaveBeenCalledWith(["read", "edit", "bash"]);
	});

	it("surfaces a catalog entry the session refused to materialize", async () => {
		const harness = createHarness(["read", "ask"], ["ask"]);

		await executeBuiltinSlashCommand("/inject read,ask", harness.runtime);

		expect(harness.injectToolsByName).toHaveBeenCalledWith(["read", "ask"]);
		expect(harness.showError).toHaveBeenCalledWith(expect.stringContaining("Not exposed by this session: ask"));
	});

	it("`list` shows the injectable catalog without mutating tools", async () => {
		const harness = createHarness(["read", "bash"]);

		const handled = await executeBuiltinSlashCommand("/inject list", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.injectToolsByName).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("Available tools: read, bash"),
			expect.anything(),
		);
	});

	it("shows usage for an empty argument list", async () => {
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/inject", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.injectToolsByName).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("Usage: /inject"), expect.anything());
	});

	it("splits on whitespace as well as commas", async () => {
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/inject read bash", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.injectToolsByName).toHaveBeenCalledWith(["read", "bash"]);
	});
});
