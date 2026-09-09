import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpCrossEncoderReranker,
  OpenAiCompatibleEmbeddingClient,
} from '../../src/knowledge/embedding-client.js';
import type { ContextHit } from '../../src/knowledge/types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('retrieval model HTTP clients', () => {
  it('authenticates an embedding request with the configured bearer token', async () => {
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('authorization') !== 'Bearer embedding-secret')
        return new Response('unauthorized', { status: 401 });
      const request = JSON.parse(String(init?.body)) as {
        model?: string;
        input?: string[];
      };
      if (
        request.model !== 'BAAI/bge-small-en-v1.5' ||
        request.input?.[0] !== 'allocation ownership'
      )
        return new Response('bad request', { status: 400 });
      return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    };
    const client = new OpenAiCompatibleEmbeddingClient(
      'http://retrieval.local:8080',
      'BAAI/bge-small-en-v1.5',
      3,
      'embedding-secret',
    );

    await expect(client.embed('allocation ownership')).resolves.toEqual([
      0.1, 0.2, 0.3,
    ]);
  });

  it('authenticates reranking and sends the configured model', async () => {
    globalThis.fetch = async (input, init) => {
      if (!String(input).endsWith('/v1/rerank'))
        return new Response('not found', { status: 404 });
      const headers = new Headers(init?.headers);
      if (headers.get('authorization') !== 'Bearer reranker-secret')
        return new Response('unauthorized', { status: 401 });
      const request = JSON.parse(String(init?.body)) as {
        model?: string;
        documents?: Array<{ id: string; text: string }>;
      };
      if (
        request.model !== 'cross-encoder/ms-marco-MiniLM-L-6-v2' ||
        JSON.stringify(request.documents) !==
          JSON.stringify([
            { id: 'chunk:one', text: 'first' },
            { id: 'chunk:two', text: 'second' },
          ])
      )
        return new Response('bad request', { status: 400 });
      return Response.json({
        results: [
          { id: 'chunk:two', score: 0.9 },
          { id: 'chunk:one', score: 0.1 },
        ],
      });
    };
    const hits: ContextHit[] = [
      {
        ref: 'chunk:one',
        kind: 'architecture',
        title: 'One',
        excerpt: 'first',
        citation: 'one',
        contentHash: 'one',
      },
      {
        ref: 'chunk:two',
        kind: 'architecture',
        title: 'Two',
        excerpt: 'second',
        citation: 'two',
        contentHash: 'two',
      },
    ];
    const reranker = new HttpCrossEncoderReranker(
      'http://retrieval.local:8080',
      'cross-encoder/ms-marco-MiniLM-L-6-v2',
      'reranker-secret',
    );

    await expect(reranker.rerank('query', hits)).resolves.toEqual([
      hits[1],
      hits[0],
    ]);
  });
});
