import { encode } from 'gpt-tokenizer';

export interface TokenBudget {
  limit: number;
  used: number;
  truncated: boolean;
  omitted: number;
  continuation?: string;
}

export interface BudgetEnvelope<T, M extends object> {
  budget: TokenBudget;
  results: T[];
  metadata: M;
}

export function countSerializedTokens(value: unknown): number {
  return encode(JSON.stringify(value)).length;
}

function continuationFor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function packWithinTokenBudget<
  T extends { ref: string },
  M extends object,
>(items: T[], limit: number, metadata: M): BudgetEnvelope<T, M> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Token budget must be a positive integer');
  }
  const selected: T[] = [];
  for (const item of items) {
    const candidate = {
      metadata,
      budget: {
        limit,
        used: 0,
        truncated: selected.length + 1 < items.length,
        omitted: items.length - selected.length - 1,
        continuation:
          selected.length + 1 < items.length
            ? continuationFor(selected.length + 1)
            : undefined,
      },
      results: [...selected, item],
    };
    if (countSerializedTokens(candidate) > limit) break;
    selected.push(item);
  }
  const omitted = items.length - selected.length;
  const budget: TokenBudget = {
    limit,
    used: 0,
    truncated: omitted > 0,
    omitted,
    ...(omitted > 0 ? { continuation: continuationFor(selected.length) } : {}),
  };
  const envelope: BudgetEnvelope<T, M> = {
    metadata,
    budget,
    results: selected,
  };
  budget.used = countSerializedTokens(envelope);
  while (budget.used > limit && selected.length > 0) {
    selected.pop();
    budget.omitted = items.length - selected.length;
    budget.truncated = true;
    budget.continuation = continuationFor(selected.length);
    budget.used = countSerializedTokens(envelope);
  }
  return envelope;
}
