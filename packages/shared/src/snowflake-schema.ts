import { z } from 'zod';
// Extracted from index.ts so packages/shared/src/media.ts can import it
// without creating a circular dependency (index.ts -> media.ts via
// `export * from './media.js'`, media.ts -> index.ts for this schema).
export const snowflakeSchema = z.string().regex(/^\d{1,20}$/).refine(v => BigInt(v) <= 9223372036854775807n);
