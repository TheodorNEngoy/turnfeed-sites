// Sites loads historical receipts for the authenticated actor from D1. Rebuilding
// every retained author's receipts would defeat scoped reads and cross the old
// shared admission limit. Legacy backfill happens once in storage, before edits.
export * from '../vendor/turnfeed/lib/public-write-receipts.mjs';
import { normalizeWriteReceipts as normalize } from '../vendor/turnfeed/lib/public-write-receipts.mjs';
export const normalizeWriteReceipts = (value, options = {}) => normalize(value, { ...options, posts: [] });
