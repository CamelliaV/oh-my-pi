import { describe, expect, it, vi } from "bun:test";
import type { Mock } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

interface InjectHarness {
	runtime: { ctx: InteractiveModeContext; notifyConfigChanged?: () => Promise<void> };
	injectToolsByName: Mock<(names: string[], mode?: string) => Promise<string[]>>;
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
	const injectToolsByName = vi.fn(async (names: string[], _mode?: string) =>
		names.filter(name => !declines.includes(name)),
	);
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
		expect(harness.injectToolsByName).toHaveBeenCalledWith(["read", "bash"], "add");
		expect(harness.notifyConfigChanged).toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("injects a built-in the session never constructed at startup", async () => {
		// Empty active set (`--lightweight`): the catalog still offers `bash`.
		const harness = createHarness(["bash", "read"]);

		await executeBuiltinSlashCommand("/inject bash", harness.runtime);

		expect(harness.injectToolsByName).toHaveBeenCalledWith(["bash"], "add");
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
		expect(harness.injectToolsByName).toHaveBeenCalledWith(["read", "edit", "bash"], "only");
	});

	it("surfaces a catalog entry the session refused to materialize", async () => {
		const harness = createHarness(["read", "ask"], ["ask"]);

		await executeBuiltinSlashCommand("/inject read,ask", harness.runtime);

		expect(harness.injectToolsByName).toHaveBeenCalledWith(["read", "ask"], "add");
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
		expect(harness.injectToolsByName).toHaveBeenCalledWith(["read", "bash"], "add");
	});

	it("is additive by default and reports the resulting roster", async () => {
		const harness = createHarness(["read", "write"]);

		await executeBuiltinSlashCommand("/inject read", harness.runtime);
		await executeBuiltinSlashCommand("/inject write", harness.runtime);

		// Two separate additive injections: the second must not narrow the first.
		expect(harness.injectToolsByName.mock.calls.map(call => call[1])).toEqual(["add", "add"]);
		expect(harness.showStatus).toHaveBeenLastCalledWith(
			expect.stringContaining("Injected 1 tool(s) [add]"),
			expect.anything(),
		);
	});

	it("`--only` replaces the set and `--remove` drops tools", async () => {
		const harness = createHarness();

		await executeBuiltinSlashCommand("/inject --only read,bash", harness.runtime);
		expect(harness.injectToolsByName).toHaveBeenLastCalledWith(["read", "bash"], "only");

		await executeBuiltinSlashCommand("/inject --remove bash", harness.runtime);
		expect(harness.injectToolsByName).toHaveBeenLastCalledWith(["bash"], "remove");
	});
});
