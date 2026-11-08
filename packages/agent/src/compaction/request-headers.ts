import type { Model } from "@oh-my-pi/pi-ai/types";
import { untilAborted } from "@oh-my-pi/pi-utils";

/** Native compaction bypasses stream dispatch, so it must resolve configured headers itself. */
export async function resolveCompactionModelHeaders(model: Model, signal?: AbortSignal): Promise<Model> {
	const resolveHeaders = model.resolveHeaders;
	if (!resolveHeaders) return model;
	const headers = await untilAborted(signal, () => resolveHeaders(signal));
	signal?.throwIfAborted();
	return { ...model, resolveHeaders: undefined, headers: headers ? { ...headers } : undefined };
}
