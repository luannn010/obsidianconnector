import { z } from 'zod';

export const DailyNotesConfigSchema = z
  .object({
    directory: z.string().trim().min(1).default('Daily'),
    dateFormat: z.string().trim().min(1).default('YYYY-MM-DD'),
  })
  .default({});

export const VaultConfigSchema = z.object({
  path: z.string().trim().min(1),
  readOnly: z.boolean().default(false),
  dailyNotes: DailyNotesConfigSchema,
});

export const VaultsFileSchema = z.object({
  vaults: z.record(z.string().trim().min(1), VaultConfigSchema).default({}),
});

export type DailyNotesConfig = z.infer<typeof DailyNotesConfigSchema>;
export type VaultConfig = z.infer<typeof VaultConfigSchema>;
export type VaultsFile = z.infer<typeof VaultsFileSchema>;
