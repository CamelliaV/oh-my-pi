/** Calculate age in seconds from an ISO date string. Returns undefined on invalid input. */
export function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
	if (!dateStr) return undefined;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return undefined;
		return Math.floor((Date.now() - date.getTime()) / 1000);
	} catch {
		return undefined;
	}
}

/** Clamp a result count to [1, maxVal], returning defaultVal when value is absent or NaN. */
export function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
	if (!value || Number.isNaN(value)) return defaultVal;
	return Math.min(maxVal, Math.max(1, value));
}

function rejectWithAbortReason(reject: (reason?: unknown) => void, signal: AbortSignal): void {
	try {
		signal.throwIfAborted();
		reject(new DOMException("The operation was aborted.", "AbortError"));
	} catch (error) {
		reject(error);
	}
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	signal?.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let timer: NodeJS.Timeout | undefined;
	const cleanup = (): void => {
		clearTimeout(timer);
		timer = undefined;
		signal?.removeEventListener("abort", onAbort);
	};
	const onAbort = (): void => {
		cleanup();
		if (signal) rejectWithAbortReason(reject, signal);
	};
	timer = setTimeout(() => {
		cleanup();
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	return promise;
}

function waitUntilDoneOrAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => rejectWithAbortReason(reject, signal);
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** Serial minimum-interval pacing keyed by upstream provider identity. */
export class RequestPacer {
	#nextRequestAt = new Map<string, number>();
	#queues = new Map<string, Promise<void>>();

	async wait(key: string, delayMs: number, signal?: AbortSignal): Promise<void> {
		if (delayMs <= 0) return;
		const prior = this.#queues.get(key)?.catch(() => {}) ?? Promise.resolve();
		const queued = prior.then(async () => {
			signal?.throwIfAborted();
			const waitMs = Math.max(0, (this.#nextRequestAt.get(key) ?? 0) - Date.now());
			if (waitMs > 0) await abortableSleep(waitMs, signal);
			signal?.throwIfAborted();
			this.#nextRequestAt.set(key, Date.now() + delayMs);
		});
		this.#queues.set(
			key,
			queued.catch(() => {}),
		);
		await waitUntilDoneOrAborted(queued, signal);
	}

	reset(): void {
		this.#nextRequestAt.clear();
		this.#queues.clear();
	}
}
