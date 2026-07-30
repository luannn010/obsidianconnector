export const projectVersion = '0.1.0';

export type ContentHash = string;

export interface AffectedFile {
  vault: string;
  path: string;
  contentHash: ContentHash;
}

export interface ToolErrorShape {
  code: string;
  message: string;
}
