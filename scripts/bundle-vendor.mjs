// Bundles browser-only dependencies into self-contained ESM files served from
// /vendor/. Replaces CDN imports so login and signing work even when a proxy or
// extension blocks deep transitive imports.
//
//   privy-sdk.mjs    @privy-io/js-sdk-core   (email-OTP / embedded-wallet login)
//   solana-web3.mjs  @solana/web3.js         (VersionedTransaction, PublicKey,
//                                             bs58 helpers for the wallet relay)
//
// Run: node scripts/bundle-vendor.mjs   (also runs on postinstall)
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'vendor');
await mkdir(outDir, { recursive: true });

// Empty shim for Node-only modules that browser builds of these libs probe for.
const shimDir = join(here, '..', 'node_modules', '.vendor-shims');
await mkdir(shimDir, { recursive: true });
const emptyShim = join(shimDir, 'empty.js');
await writeFile(emptyShim, 'module.exports = {};\n');

const targets = [
  { name: 'privy-sdk', entry: '@privy-io/js-sdk-core', alias: { crypto: emptyShim, stream: emptyShim, buffer: emptyShim, path: emptyShim } },
  { name: 'solana-web3', entry: '@solana/web3.js', alias: {} },
];

const failures = [];
for (const t of targets) {
  const outfile = join(outDir, `${t.name}.mjs`);
  try {
    await build({
      entryPoints: [t.entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      minify: true,
      sourcemap: false,
      legalComments: 'none',
      define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
      alias: t.alias,
      logLevel: 'silent',
    });
    console.log(`[vendor] ${t.name} -> public/vendor/${t.name}.mjs`);
  } catch (err) {
    failures.push(`${t.name}: ${err.message}`);
    console.error(`[vendor] ${t.name} FAILED: ${err.message}`);
  }
}

if (failures.length) {
  console.error(`[vendor] ${failures.length} bundle(s) failed`);
  process.exit(1);
}
