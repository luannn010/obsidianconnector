export async function drainQueueBatches(
  processBatch: (limit: number) => Promise<number>,
  batchSize: number,
  maxTotal = Number.POSITIVE_INFINITY,
): Promise<number> {
  let total = 0;
  while (total < maxTotal) {
    const requested = Math.min(batchSize, maxTotal - total);
    const processed = await processBatch(requested);
    total += processed;
    if (processed < requested) return total;
  }
  return total;
}
