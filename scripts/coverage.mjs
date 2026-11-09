#!/usr/bin/env node
// ─── coverage: every API route ↔ CLI command ↔ e2e step ↔ handler sweep ──────
// Generated from the source files, so it cannot drift from them:
//   routes/*.js                    r.get/r.post('/api/…')
//   cli.js                         <group>.<cmd>: () => get|post('/api/…')
//   scripts/cli-e2e.mjs            cli(['group', 'cmd', …]) inside step('…')
//   scripts/test-all-handlers.mjs  check('…', 'GET'|'POST', '/api/…')
//   scripts/test-wallet-relay.mjs  call('POST', '/api/…')
// Writes docs/COVERAGE.md; exits 1 when a route has neither a CLI command nor
// a test, or a CLI command has no e2e step (browser-only routes allow-listed).
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const ID = ':id';
const norm = (p) => p
  .replace(/\$\{q\(.*$/, '') // trailing query-string helper `${q({...})}`
  .replace(/\$\{[^}]*\}/g, ID) // path-segment interpolation → :id
  .replace(/:[a-zA-Z]+/g, ID)
  .replace(/\?.*$/, '')
  .replace(/\/$/, '');

// Routes a terminal cannot drive, and routes that are plumbing or placeholders.
const BROWSER_ONLY = {
  'POST /api/wallet/challenge': 'browser-wallet login — proven by the relay harness',
  'POST /api/wallet/login': 'browser-wallet login — proven by the relay harness',
  'POST /api/wallet/privy-login': 'Privy email/OTP runs in the browser',
  'POST /api/tx/broadcast-signed': 'wallet-extension relay — proven by the relay harness',
  'POST /api/_clientlog': 'client error sink',
  'GET /api/feegrant/grant-subscribers-stream': 'fee grants: work in progress (501)',
  'POST /api/feegrant/grant': 'fee grants: work in progress (501)',
  'POST /api/feegrant/grant-subscribers': 'fee grants: work in progress (501)',
  'POST /api/feegrant/revoke': 'fee grants: work in progress (501)',
  'POST /api/feegrant/revoke-list': 'fee grants: work in progress (501)',
  'POST /api/feegrant/revoke-all': 'fee grants: work in progress (501)',
  'POST /api/feegrant/auto-grant': 'fee grants: work in progress (501)',
  'GET /api/feegrant/gas-costs': 'fee grants: work in progress',
  'GET /api/feegrant/auto-grant': 'fee grants: work in progress',
};
// CLI commands whose only sensible e2e is a negative path already in the sweep.
const CLI_NO_E2E_OK = new Set();

// 1. routes
const routes = [];
for (const f of readdirSync(join(root, 'routes')).filter((x) => x.endsWith('.js')).sort()) {
  const src = read(`routes/${f}`);
  const re = /r\.(get|post)\(\s*(?:`|')([^'`]+)(?:`|')/g;
  let m;
  while ((m = re.exec(src))) routes.push({ method: m[1].toUpperCase(), path: m[2], file: `routes/${f}` });
  const loop = src.match(/for \(const p of \[([^\]]+)\]\) \{\s*r\.post\(`\/api\/feegrant\/\$\{p\}`/);
  if (loop) {
    routes.splice(routes.findIndex((r) => r.path.includes('${p}')), 1);
    for (const p of loop[1].split(',').map((s) => s.trim().replace(/['"]/g, ''))) routes.push({ method: 'POST', path: `/api/feegrant/${p}`, file: `routes/${f}` });
  }
}
const routeKey = (r) => `${r.method} ${norm(r.path)}`;

// 2. cli commands → every path they can hit
const cli = [];
{
  let group = null;
  // A multi-line command body (e.g. wallet.import) is folded onto its opening line so its paths are seen.
  const folded = [];
  let buf = null;
  for (const line of read('cli.js').split('\n')) {
    if (buf !== null) { buf += ' ' + line.trim(); if (/^\s*\},?\s*$/.test(line)) { folded.push(buf); buf = null; } continue; }
    if (/^\s+'?[a-z-]+'?: (?:async )?\(\) => \{\s*$/.test(line)) { buf = line; continue; }
    folded.push(line);
  }
  for (const line of folded) {
    const g = line.match(/^  ([a-z]+): \{/);
    if (g) group = g[1];
    if (!group) continue;
    const c = line.match(/^\s+'?([a-z-]+)'?: (?:async )?\(\) =>/);
    const cmd = c ? c[1] : (line.match(/^\s+'?([a-z-]+)'?: \{ ([a-z-]+): \(\) =>/) ? null : null);
    const inline = line.match(/^  ([a-z]+): \{ ([a-z-]+): \(\) =>/);
    const name = inline ? inline[2] : cmd;
    const grp = inline ? inline[1] : group;
    if (!name) continue;
    const pathRe = /(get|post)\((?:`([^`]+)`|'([^']+)')/g;
    let m; const paths = [];
    while ((m = pathRe.exec(line))) paths.push({ method: m[1].toUpperCase(), path: m[2] || m[3] });
    if (paths.length) cli.push({ group: grp, cmd: name, paths });
    if (line.match(/^  \},?$/)) group = null;
  }
}
const cliFor = (r) => cli.filter((c) => c.paths.some((p) => p.method === r.method && norm(p.path) === norm(r.path))).map((c) => `plans ${c.group} ${c.cmd}`);

// 3. e2e steps per CLI command
const steps = [];
{
  const src = read('scripts/cli-e2e.mjs');
  // Step names may be quoted or template literals (with \' escapes); calls after the finally are cleanup.
  const stepRe = /await step\((['`])((?:\\.|[^\\])*?)\1/g; const positions = []; let s;
  while ((s = stepRe.exec(src))) positions.push({ name: s[2].replace(/\\'/g, "'").replace(/\$\{[^}]*\}/g, '…'), at: s.index });
  const cleanupAt = src.indexOf('} finally {');
  const callRe = /cli\(\['([a-z]+)', '([a-z-]+)'/g; let c;
  while ((c = callRe.exec(src))) {
    const owner = cleanupAt >= 0 && c.index > cleanupAt ? null : [...positions].reverse().find((p) => p.at < c.index);
    steps.push({ group: c[1], cmd: c[2], step: owner ? owner.name : '(setup/cleanup)' });
  }
}
const e2eFor = (cmds) => [...new Set(steps.filter((s) => cmds.includes(`plans ${s.group} ${s.cmd}`)).map((s) => s.step))];

// 4. sweep + relay harness
const sweepHits = new Set();
{
  const src = read('scripts/test-all-handlers.mjs') + read('scripts/test-wallet-relay.mjs');
  const re = /(?:check\('[^']*',\s*|call\()'(GET|POST)',\s*(?:`|')([^'`]+)/g; let m;
  while ((m = re.exec(src))) sweepHits.add(`${m[1]} ${norm(m[2])}`);
}

// 5. report
const esc = (s) => s.replace(/\|/g, '\\|');
const rows = []; const problems = [];
for (const r of routes.sort((a, b) => routeKey(a).localeCompare(routeKey(b)))) {
  const k = routeKey(r); const cmds = cliFor(r); const e2e = e2eFor(cmds); const sweep = sweepHits.has(k); const note = BROWSER_ONLY[`${r.method} ${r.path}`];
  if (!cmds.length && !sweep && note === undefined) problems.push(`route without CLI or test: ${k}`);
  if (cmds.length && !e2e.length && !cmds.some((c) => CLI_NO_E2E_OK.has(c))) problems.push(`CLI command without an e2e step: ${cmds.join(', ')}`);
  rows.push(`| \`${esc(k)}\` | ${cmds.map((c) => `\`${c}\``).join('<br>') || (note ? `— ${note}` : '**none**')} | ${e2e.length ? e2e.map(esc).join('<br>') : (cmds.length ? '**none**' : '')} | ${sweep ? '✓' : ''} | ${r.file} |`);
}
const cliOnly = cli.filter((c) => !c.paths.every((p) => routes.some((r) => r.method === p.method && norm(r.path) === norm(p.path))));
for (const c of cliOnly) problems.push(`CLI command with no matching route: plans ${c.group} ${c.cmd}`);

const md = `# Coverage — routes ↔ CLI ↔ tests

Generated by \`node scripts/coverage.mjs\` from \`routes/*.js\`, \`cli.js\`, \`scripts/cli-e2e.mjs\`, \`scripts/test-all-handlers.mjs\` and \`scripts/test-wallet-relay.mjs\`. Do not edit by hand.

- Routes: **${routes.length}** · CLI commands: **${cli.length}** · e2e steps: **${new Set(steps.map((s) => s.step)).size}** · problems: **${problems.length}**
- "Sweep" = exercised by the no-spend route sweep or the wallet-relay harness. "e2e" = \`scripts/cli-e2e.mjs\` step(s) on live devnet.

| Route | CLI command | e2e step(s) | Sweep | Source |
|---|---|---|---|---|
${rows.join('\n')}

## Problems
${problems.length ? problems.map((p) => `- ${p}`).join('\n') : '- none'}
`;
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs', 'COVERAGE.md'), md, 'utf8');
console.log(`coverage: ${routes.length} routes, ${cli.length} cli commands, ${problems.length} problems → docs/COVERAGE.md`);
for (const p of problems) console.log('  - ' + p);
process.exit(problems.length ? 1 : 0);
