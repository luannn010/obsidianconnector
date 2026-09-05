import { z } from 'zod';

export const DailyNotesConfigSchema = z
  .object({
    directory: z.string().trim().min(1).default('Daily'),
    dateFormat: z.string().trim().min(1).default('YYYY-MM-DD'),
  })
  .default({});

export const CodebaseIndexConfigSchema = z
  .object({
    manifest: z.string().trim().min(1).default('Codebase Index.md'),
    maxAgeDays: z.number().int().min(1).max(3650).default(30),
    roles: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .default({}),
  })
  .default({});

export const VaultConfigSchema = z.object({
  path: z.string().trim().min(1),
  readOnly: z.boolean().default(false),
  dailyNotes: DailyNotesConfigSchema,
  codebaseIndex: CodebaseIndexConfigSchema,
});

export const VaultsFileSchema = z.object({
  vaults: z.record(z.string().trim().min(1), VaultConfigSchema).default({}),
});

export type DailyNotesConfig = z.infer<typeof DailyNotesConfigSchema>;
export type CodebaseIndexConfig = z.infer<typeof CodebaseIndexConfigSchema>;
export type VaultConfig = z.infer<typeof VaultConfigSchema>;
export type VaultsFile = z.infer<typeof VaultsFileSchema>;
