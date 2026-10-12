import { describe, expect, it, vi } from "bun:test";
import type { Mock } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

interface InjectHarness {
	runtime: { ctx: InteractiveModeContext; notifyConfigChanged?: () => Promise<void> };
	setActiveToolsByName: Mock<(names: string[]) => Promise<void>>;
	showError: Mock<(msg: string) => void>;
	showStatus: Mock<(msg: string, opts?: unknown) => void>;
	notifyConfigChanged: Mock<() => Promise<void>>;
}

function createHarness(enabled: readonly string[] = ["read", "edit", "bash", "grep", "ls"]): InjectHarness {
	const setActiveToolsByName = vi.fn(async (_names: string[]) => {});
	const showError = vi.fn();
	const showStatus = vi.fn((_msg: string, _opts?: unknown) => {});
	const notifyConfigChanged = vi.fn(async () => {});
	const session = {
		getEnabledToolNames: () => [...enabled],
		setActiveToolsByName,
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
	return { runtime, setActiveToolsByName, showError, showStatus, notifyConfigChanged };
}

describe("/inject slash command", () => {
	it("injects named tools via setActiveToolsByName", async () => {
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/inject read,bash", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setActiveToolsByName).toHaveBeenCalledWith(["read", "bash"]);
		expect(harness.notifyConfigChanged).toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("reports unknown tools and does not mutate the whitelist", async () => {
		const harness = createHarness(["read", "bash"]);

		const handled = await executeBuiltinSlashCommand("/inject read,notatool", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setActiveToolsByName).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith(expect.stringContaining("Unknown tools: notatool"));
	});

	it("`--all` restores the full catalog", async () => {
		const harness = createHarness(["read", "edit", "bash"]);

		const handled = await executeBuiltinSlashCommand("/inject --all", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setActiveToolsByName).toHaveBeenCalledWith(expect.arrayContaining(["read", "edit", "bash"]));
		expect(harness.setActiveToolsByName.mock.calls[0]?.[0]).toHaveLength(3);
	});

	it("`list` shows the available catalog without mutating tools", async () => {
		const harness = createHarness(["read", "bash"]);

		const handled = await executeBuiltinSlashCommand("/inject list", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setActiveToolsByName).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("Available tools: bash, read"),
			expect.anything(),
		);
	});

	it("shows usage for an empty argument list", async () => {
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/inject", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setActiveToolsByName).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("Usage: /inject"), expect.anything());
	});

	it("splits on whitespace as well as commas", async () => {
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/inject read bash", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setActiveToolsByName).toHaveBeenCalledWith(["read", "bash"]);
	});
});
