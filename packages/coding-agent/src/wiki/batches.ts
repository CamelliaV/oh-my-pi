/** Bound each JSON array as rendered inside untrusted_data, never the complete corpus. */
export function wikiBatches<T>(items: readonly T[], maxChars: number): T[][] {
	if (!Number.isSafeInteger(maxChars) || maxChars < 2) {
		throw new RangeError("Wiki JSON batch budget must be a safe integer of at least two characters");
	}
	const batches: T[][] = [];
	let batch: T[] = [];
	let chars = 2;
	for (const item of items) {
		const size = (JSON.stringify(item) ?? "null").replaceAll("<", "\\u003c").length;
		if (size + 2 > maxChars) throw new RangeError("A complete Wiki item exceeds the JSON batch budget");
		const separator = batch.length ? 1 : 0;
		if (chars + separator + size > maxChars) {
			batches.push(batch);
			batch = [];
			chars = 2;
		}
		chars += (batch.length ? 1 : 0) + size;
		batch.push(item);
	}
	if (batch.length) batches.push(batch);
	return batches;
}
