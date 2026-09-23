#!/bin/sh
# Check the docs against the installed official artifacts and this demo.
# Runs offline after npm ci; no sibling checkout or upstream source paths needed.
set -eu
REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$REPO_DIR"
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
let cardano;
try { cardano = await import('@x402/cardano'); }
catch { throw new Error('Install the official dependencies with npm ci before verifying docs.'); }
const http = await import('@x402/core/http');
const root = json('package.json');
const lock = json('package-lock.json');
const reference = read('docs/x402/reference.agent.md');
const guide = read('docs/x402/guide.md');
const readme = read('README.md');
const documents = { reference, guide, readme };
const app = read('server/src/app.ts');
const flow = read('frontend/src/x402/flow.ts');
const facilitator = read('facilitator/src/facilitator.ts');
const version = json('node_modules/@x402/cardano/package.json').version;

// Keep a complete, exact public error inventory without baking in a count.
const exportedErrors = new Map(Object.entries(cardano).filter(([key]) => key.startsWith('ERR_')));
const documentedErrors = [...reference.matchAll(/^\| `(ERR_[A-Z_0-9]+)` \| `([^`]+)` \|/gm)];
assert(exportedErrors.size > 0, 'Cardano package exports no error constants');
assert.equal(documentedErrors.length, exportedErrors.size, 'Reference error inventory differs from the installed package');
assert.equal(new Set(documentedErrors.map(match => match[1])).size, documentedErrors.length, 'Duplicate reference error identifier');
for (const [, identifier, wire] of documentedErrors) {
  assert.equal(exportedErrors.get(identifier), wire, `Error changed or removed: ${identifier}`);
}
const wireErrors = new Set(exportedErrors.values());
for (const [name, content] of Object.entries(documents)) {
  for (const [, code] of content.matchAll(/`((?:invalid_exact_cardano|exact_cardano_)[a-z0-9_]*|network_mismatch|unsupported_scheme|duplicate_settlement|settlement_pending|payment_pending|masumi_terms_[a-z]+)`/g)) {
    assert(wireErrors.has(code), `${name} cites an unknown error: ${code}`);
  }
  assert(content.includes(version), `${name} does not identify installed release ${version}`);
  assert(!/submissionMode|submissionPolicy|settlementLayer|phase1\.ts|evidence\.ts|file:\.\.\/.*x402/.test(content), `${name} still describes removed demo protocol options or local artifacts`);
}

// Check the imports readers are directed to use, through public package exports.
for (const role of ['client', 'server', 'facilitator']) {
  const module = await import(`@x402/cardano/exact/${role}`);
  assert.equal(typeof module.ExactCardanoScheme, 'function', `Missing ${role} scheme export`);
}
for (const key of ['buildMasumiLock', 'toFacilitatorCardanoSigner', 'toMasumiSellerSigner']) {
  assert.equal(typeof cardano[key], 'function', `Missing public export ${key}`);
}
for (const [header, codec] of [['PAYMENT-REQUIRED', 'PaymentRequired'], ['PAYMENT-SIGNATURE', 'PaymentSignature'], ['PAYMENT-RESPONSE', 'PaymentResponse']]) {
  assert(reference.includes(header) && guide.includes(header) && app.includes(header), `Missing documented/served header ${header}`);
  const value = { check: header };
  assert.deepEqual(http[`decode${codec}Header`](http[`encode${codec}Header`](value)), value, `Codec contract changed: ${header}`);
}
assert(reference.includes(cardano.USDM_PREPROD_ASSET), 'Reference preprod native asset differs from the published constant');

// The route table must cover exactly the configured demo catalog and amounts.
const routes = [...app.matchAll(/path: "(\/api\/[^\"]+)", label: "[^\"]+", price: "[^\"]+", asset: (?:"lovelace"|token), amount: "(\d+)"/g)];
assert(routes.length > 0, 'Could not read the route catalog; update the verifier for the app structure');
const documentedRoutes = [...reference.matchAll(/^\| `GET (\/api\/[^`]+)` \| `(\d+)`/gm)];
assert.deepEqual(documentedRoutes.map(m => [m[1], m[2]]).sort(), routes.map(m => [m[1], m[2]]).sort(), 'Reference routes/prices differ from app catalog');
for (const [, path, amount] of routes) {
  for (const [name, content] of Object.entries(documents)) {
    const row = content.split('\n').find(line => line.startsWith('|') && line.includes(`GET ${path}\``));
    assert(row?.includes(amount), `${name} omits or misprices ${path}`);
  }
  assert(flow.includes(`"${path}"`), `Browser no longer supports documented route ${path}`);
}
assert.equal([...reference.matchAll(/^\| [1-9] \|/gm)].length, 9, 'Reference should retain all nine numbered verification checks');
assert(facilitator.includes('awaitConfirmation: false'), 'Documented provider wait behavior changed');
assert(facilitator.includes('75_000'), 'Documented facilitator wait default changed');

// Every workspace must consume pinned registry packages from the one lockfile.
for (const workspace of root.workspaces) {
  const manifest = json(`${workspace}/package.json`);
  for (const [name, requested] of Object.entries(manifest.dependencies ?? {})) {
    if (!name.startsWith('@x402/')) continue;
    const artifact = lock.packages[`node_modules/${name}`];
    assert.equal(requested, version, `${workspace} must use the documented pinned release of ${name}`);
    assert.equal(artifact?.version, version, `Lockfile version differs for ${name}`);
    assert(artifact.resolved?.startsWith('https://registry.npmjs.org/'), `${name} is not a registry artifact`);
    assert(artifact.integrity?.startsWith('sha512-'), `${name} has no registry integrity digest`);
  }
}
for (const script of ['dev', 'typecheck', 'build', 'test', 'test:browser', 'verify:docs']) {
  assert(root.scripts[script], `Documented root command missing: ${script}`);
}
for (const workspace of root.workspaces) {
  const example = read(`${workspace}/.env.example`);
  assert(!/SUBMISSION_POLICY|CARDANO_NETWORK|MASUMI_ESCROW_ADDRESS/.test(example), `${workspace} example includes removed options`);
  for (const [, variable] of example.matchAll(/^#?([A-Z][A-Z_0-9]*)=/gm)) {
    if (variable === 'PORT') continue;
    assert(reference.includes(`\`${variable}\``), `Undocumented example variable ${variable}`);
  }
}
console.log(`OK: ${version} official exports, ${exportedErrors.size} error codes, ${routes.length} routes, headers, registry dependencies and env documentation`);
NODE
