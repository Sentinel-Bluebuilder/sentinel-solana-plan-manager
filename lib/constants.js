// ─── Constants ───────────────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Where state files live (nodes-cache.json, privy-wallets.json, .session-key). */
export const DATA_DIR = process.env.DATA_DIR || PROJECT_ROOT;
export const PORT = Number(process.env.PORT) || 3003;
export const COINGECKO = 'https://api.coingecko.com/api/v3';
export const NODE_CACHE_TTL = 5 * 60 * 1000;
export const NODE_PROBE_TIMEOUT_MS = 5000;
/** Free-plan gifts per request: 10 txs of SUBSCRIPTIONS_PER_TX, 7 s apart (~70 s). */
export const MAX_BATCH_ADDRESSES = 60;
export const MAX_BATCH_NODES = 100;
/** Free-plan gifts per transaction (open_subscription ≈ 12 accounts each; v0 tx limit 1232 B). */
export const SUBSCRIPTIONS_PER_TX = 6;
export const SOL_DECIMALS = 9;
