import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createManifest, buildRelayAppDescriptor, MARKETPLACE_MANIFEST_FIELDS } from '../src/manifest';
import pkg from '../package.json';
import { serveApp } from '@privos_ai/app-server';
import { lintManifest, SUPPORTED_MANIFEST_SCHEMA_VERSIONS } from '@privos_ai/app-server/manifest-tools';

export const PREFLIGHT_RULESET = 'marketplace-validation-mirror/2026-08-02';
const failures: string[] = [];
const fail = (message: string, fix: string) => failures.push(`${message}\n  Fix: ${fix}`);

/** Permission call sites can live in either the backend policy layer or the host-bridge UI. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

async function main() {
console.log(`PrivOS MCP app preflight (${PREFLIGHT_RULESET})`);
console.log('NOTICE: these checks mirror the portal rules until the shared marketplace validation module is published.');

const manifest = createManifest();
if (JSON.stringify(Object.keys(manifest)) !== JSON.stringify(MARKETPLACE_MANIFEST_FIELDS)) {
  fail('Manifest contains unsupported or missing fields.', 'Keep privos-app.json aligned with MARKETPLACE_MANIFEST_FIELDS.');
}
for (const field of ['name', 'version', 'title', 'description'] as const) {
  if (manifest[field] !== pkg[field]) {
    fail(`Manifest field "${field}" differs from package.json.`, 'Keep package identity fields synchronized with privos-app.json.');
  }
}
if (!SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(manifest.schemaVersion) || manifest.kind !== 'mcp-app') {
  fail(
    'privos-app.json is not a supported MCP app manifest.',
    `Set schemaVersion to one of ${SUPPORTED_MANIFEST_SCHEMA_VERSIONS.join(', ')} and kind to mcp-app.`,
  );
}
if (manifest.repository !== pkg.repository.url) {
  fail('Manifest repository differs from package.json.', 'Use the canonical GitHub repository URL in both files.');
}

// The marketplace build runs `npm ci` against the committed lockfile, so a lock that
// disagrees with the app is a broken publication waiting to happen. It happened: the lock
// sat at 2.5.0 through four releases and still linked two locally checked-out SDKs, and
// nothing noticed until the marketplace's own AI review read it at submission time.
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')) as {
  version?: string;
  packages?: Record<string, { version?: string }>;
};
const lockRootVersions = [lock.version, lock.packages?.['']?.version];
if (lockRootVersions.some((version) => version !== pkg.version)) {
  fail(
    `package-lock.json declares ${lockRootVersions.join(' / ')} but the app is ${pkg.version}.`,
    'Run `npm install --package-lock-only` after every version bump and commit the lockfile.',
  );
}
const localLinks = Object.keys(lock.packages ?? {}).filter((entry) => entry.startsWith('../'));
if (localLinks.length) {
  fail(
    `package-lock.json links local checkouts: ${localLinks.join(', ')}.`,
    'Depend on published package versions; a clean build cannot resolve a path outside the archive.',
  );
}

// This repo's own rule, stated at the top of CHANGELOG.md: the listing version, both package
// files and the release notes move in one commit. 2.9.0 shipped without an entry.
const changelog = fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : '';
if (!changelog.includes(`## [${pkg.version}]`)) {
  fail(
    `CHANGELOG.md has no entry for ${pkg.version}.`,
    'Add a `## [version] - date` section describing the release in the same commit as the bump.',
  );
}

if (!pkg.dockerfilePath || !fs.existsSync(path.resolve(pkg.dockerfilePath))) {
  fail(`Dockerfile is missing at "${pkg.dockerfilePath || '<unset>'}".`, 'Set dockerfilePath and commit that file inside the source archive.');
}

const scopeDocs = fs.existsSync('SCOPES.md') ? fs.readFileSync('SCOPES.md', 'utf8') : '';
const sourceFiles = collectSourceFiles(path.resolve('src'))
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const lint = lintManifest(manifest);
console.log(`canonicalManifestHash=${lint.canonicalManifestHash}`);
console.log(`publisherPermissionDeclarationHash=${lint.publisherPermissionDeclarationHash || '<unavailable>'}`);
for (const error of lint.errors) fail(`Manifest: ${error}.`, 'Run npm run manifest:lint and correct the reported contract.');
for (const permission of manifest.permissions) {
  const scope = permission.scope;
  if (!scopeDocs.includes(`\`${scope}\``) || !sourceFiles.includes(scope)) {
    fail(`Scope "${scope}" lacks a justification or annotated call site.`, 'Document it in SCOPES.md and reference it beside the real API call, or remove it.');
  }
}

for (const required of ['scripts/package-source.sh', '.dockerignore']) {
  if (!fs.existsSync(required)) fail(`${required} is missing.`, 'Restore the safe packaging files from the reference app.');
}

const packaged = spawnSync('bash', ['scripts/package-source.sh', '--allow-dirty'], { encoding: 'utf8' });
if (packaged.status !== 0) {
  fail('Safe source packaging failed.', `Resolve the reported unsafe file or archive error:\n${packaged.stderr.trim()}`);
} else {
  const safeName = pkg.name.replaceAll('/', '-');
  const archive = `dist-source/${safeName}-${pkg.version}.zip`;
  const listing = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
  if (listing.status !== 0 || !listing.stdout.split('\n').includes(pkg.dockerfilePath)) {
    fail('The declared Dockerfile is not contained in the packaged ZIP.', 'Commit Dockerfile and ensure package-source.sh includes it.');
  }
  if (!listing.stdout.split('\n').includes('privos-app.json')) {
    fail('privos-app.json is not at the ZIP root.', 'Commit the canonical manifest at the repository root.');
  }
  if (fs.statSync(archive).size > 200 * 1024 * 1024) {
    fail('The packaged archive exceeds 200 MiB.', 'Remove generated assets or dependencies from the source archive.');
  }
}

const handle = await serveApp({
  descriptor: buildRelayAppDescriptor(),
  createHandler: () => async () => ({}),
  port: 0,
  host: '0.0.0.0',
  installSignalHandlers: false,
  resolveManifest: () => createManifest(),
  configure: (app) => {
    app.get('/.well-known/mcp/manifest.json', (_req, res) => res.json(createManifest()));
  },
});
const address = handle.server.address();
if (!address || typeof address === 'string') {
  fail('Direct server did not bind a TCP port.', 'Ensure serveApp binds an HTTP surface on 0.0.0.0.');
} else {
  const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/mcp/manifest.json`);
  if (!response.ok || JSON.stringify(await response.json()) !== JSON.stringify(manifest)) {
    fail('The running app did not serve the authoritative manifest.', 'Route GET /.well-known/mcp/manifest.json to createManifest() via serveApp configure.');
  }
}
await handle.close();

if (failures.length) {
  console.error(`\nPreflight failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Preflight passed.');
}

main().catch((error) => {
  console.error(`Preflight crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
