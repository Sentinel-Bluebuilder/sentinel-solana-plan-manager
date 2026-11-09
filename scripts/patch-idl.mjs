#!/usr/bin/env node
// ─── patch-idl ───────────────────────────────────────────────────────────────
// Derives chain/idl/dvpn.devnet.json from chain/idl/dvpn.source.json.
//
// dvpn.source.json is vendored verbatim from upstream sentinel-official/sentinel-solana
// `sentinel-programs/idl/dvpn.json` at cb33092e (public main 26de5240 = same code).
// On 2026-11-02 upstream upgraded the devnet program to that code, so devnet now
// holds the SOURCE layout: every live account matched cb33 sizes when checked on
// 2026-11-07 (3,628 accounts, 11 types, 0 strays). The old layout patches
// (voucher_signer insert, OperatorMandate counters, Voucher signer_index) are gone.
//
// The only edit left: `address` -> the devnet program id.
// Deterministic: running twice yields byte-identical output.
//
// Run: node scripts/patch-idl.mjs   (also runs on postinstall)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'chain', 'idl', 'dvpn.source.json');
const OUT = join(here, '..', 'chain', 'idl', 'dvpn.devnet.json');
const DEVNET_PROGRAM_ID = 'J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs';
const UPSTREAM_REF = 'cb33092e';

const idl = JSON.parse(readFileSync(SRC, 'utf8'));

// Fail loudly if someone vendors a pre-cb33 IDL by mistake.
if (!idl.accounts.some((a) => a.name === 'Grant') || idl.accounts.some((a) => a.name === 'OperatorMandate')) {
  throw new Error('patch-idl: dvpn.source.json is not the cb33 layout (expected Grant, no OperatorMandate)');
}

idl.address = DEVNET_PROGRAM_ID;
idl.metadata = { ...idl.metadata, derived_from: 'dvpn.source.json', upstream_ref: UPSTREAM_REF };

writeFileSync(OUT, JSON.stringify(idl, null, 2) + '\n', 'utf8');
console.log(`patch-idl: wrote ${OUT}`);
