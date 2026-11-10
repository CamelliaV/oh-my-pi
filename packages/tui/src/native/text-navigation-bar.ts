import type { Component } from "../tui";
import { node, span, text } from "./describe";
import type { NativeNode, NativeUiEvent } from "./node";
import type { TextNavigationDirection } from "./text-navigation";

/** Reading controls live in the dock, leaving the composer's focus and draft alone. */
export class TextNavigationBar implements Component {
	#node: NativeNode | undefined;
	#position = "";
	#error = "";

	constructor(readonly navigate: (direction: TextNavigationDirection) => void) {}

	get visible(): boolean {
		return this.#position !== "" || this.#error !== "";
	}

	setPosition(index: number, total: number): void {
		this.#position = `Text ${index + 1}/${total}`;
		this.#error = "";
		this.#node = undefined;
	}

	setError(error: string): void {
		this.#error = error;
		this.#node = undefined;
	}

	hide(): void {
		this.#position = "";
		this.#error = "";
		this.#node = undefined;
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {
		this.#node = undefined;
	}

	describe(): NativeNode {
		return (this.#node ??= node("row", { gap: "sm", align: "center", wrap: true, role: "omp.text.navigation" }, [
			text([span(this.#error || this.#position, this.#error ? "error" : "muted")]),
			node(
				"button",
				{ text: "Previous", variant: "quiet", title: "Previous text · Alt+PageUp", actions: { click: "previous" } },
				undefined,
				"previous",
			),
			node(
				"button",
				{ text: "Next", variant: "quiet", title: "Next text · Alt+PageDown", actions: { click: "next" } },
				undefined,
				"next",
			),
			node(
				"button",
				{
					text: "Latest",
					variant: "quiet",
					title: "Return to latest output · Alt+End",
					actions: { click: "latest" },
				},
				undefined,
				"latest",
			),
			text([span("Esc exits", "dim")]),
		]));
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "previous" || event.act === "next" || event.act === "latest") this.navigate(event.act);
	}
}
