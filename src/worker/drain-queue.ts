export async function drainQueueBatches(
  processBatch: () => Promise<number>,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const processed = await processBatch();
    total += processed;
    if (processed < batchSize) return total;
  }
}
