import { sourceHash } from './hash.js';

export const EMBEDDING_TEXT_LIMIT = 1500;

export const EMBEDDABLE_CHUNK_KINDS = [
  'documentation',
  'api_endpoint',
  'database_table',
  'file_summary',
] as const;

export interface EmbeddingModelKeyInput {
  name: string;
  revision: string;
  dimensions: number;
}

export function normalizeEmbeddingText(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function embeddingText(content: string): string {
  const normalized = normalizeEmbeddingText(content);
  if (normalized.length <= EMBEDDING_TEXT_LIMIT) return normalized;
  const newline = normalized.lastIndexOf('\n', EMBEDDING_TEXT_LIMIT);
  const space = normalized.lastIndexOf(' ', EMBEDDING_TEXT_LIMIT);
  const boundary = Math.max(newline, space);
  return normalized.slice(0, boundary > 0 ? boundary : EMBEDDING_TEXT_LIMIT);
}

export function embeddingHash(text: string): string {
  return sourceHash(embeddingText(text));
}

export function embeddingModelKey(model: EmbeddingModelKeyInput): string {
  return `${model.name}@${model.revision}:${model.dimensions}`;
}

export function queryEmbeddingText(query: string): string {
  return `Represent this sentence for searching relevant passages: ${normalizeEmbeddingText(query)}`;
}
