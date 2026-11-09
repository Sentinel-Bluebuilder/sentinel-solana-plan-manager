#!/usr/bin/env node
// ─── doctor: is this install able to run? ────────────────────────────────────
// Checks env, IDL, RPC pool, program/config on chain, provider daemons, test key.
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { bad++; console.log(`  ✗ ${m}`); };

console.log('doctor');
for (const f of ['chain/idl/dvpn.source.json', 'chain/idl/dvpn.devnet.json', 'proto/daemon.proto', 'public/vendor/solana-web3.mjs', 'public/vendor/privy-sdk.mjs']) {
  existsSync(join(here, '..', f)) ? ok(f) : no(`${f} missing — run npm run patch-idl / npm run build:vendor`);
}
try {
  const { NETWORK, PROGRAM_ID, MINT } = await import('../lib/solana/idl.js');
  ok(`network ${NETWORK} · program ${PROGRAM_ID.toBase58()} · mint ${MINT.toBase58()}`);
  const { getRpcState } = await import('../lib/solana/rpc.js');
  const s = await getRpcState();
  s.slot ? ok(`rpc ${s.serving} slot ${s.slot} (${s.latencyMs} ms)`) : no(`rpc pool unreachable: ${JSON.stringify(s.benched)}`);
  const { fetchConfig } = await import('../lib/solana/program.js');
  const c = await fetchConfig();
  ok(`config on chain: feeBps ${c.feeBps}, minProviderBond ${c.minProviderBond}, pausedMask ${c.pausedMask}`);
  const { daemonsHealth, daemonTargets } = await import('../lib/daemon.js');
  if (!daemonTargets().size) console.log('  - no provider daemon configured (DVPND_PROVIDER_SOCKETS) — roster/link routes will return 503');
  for (const d of await daemonsHealth()) d.ok ? ok(`daemon ${d.providerPda} @ ${d.target} (${d.version?.version?.tag})`) : no(`daemon ${d.providerPda} @ ${d.target}: ${d.error}`);
} catch (e) { no(`chain layer: ${e.message}`); }
if (process.env.TEST_KEYFILE) {
  try { const { keypairFromInput } = await import('../lib/session.js'); ok(`TEST_KEYFILE → ${keypairFromInput(readFileSync(process.env.TEST_KEYFILE, 'utf8')).publicKey.toBase58()}`); } catch (e) { no(`TEST_KEYFILE: ${e.message}`); }
} else console.log('  - TEST_KEYFILE not set (needed by the e2e suites only)');
console.log(bad ? `\n${bad} problem(s)` : '\nall good');
process.exit(bad ? 1 : 0);
