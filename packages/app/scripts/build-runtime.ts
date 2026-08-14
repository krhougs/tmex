import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bundleGatewayArtifacts } from '../src/lib/gateway-artifacts';

const packageRoot = resolve(import.meta.dir, '..');
const sourceManifestPath = process.env.TMEX_GATEWAY_ARTIFACTS_MANIFEST;

if (!sourceManifestPath) {
  console.error(
    '[build:runtime] TMEX_GATEWAY_ARTIFACTS_MANIFEST is required; it must point to the release-produced Rust target manifest'
  );
  process.exit(1);
}

const packageVersion = (
  JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown }
).version;
if (typeof packageVersion !== 'string') {
  console.error('[build:runtime] tmex-cli package version is missing');
  process.exit(1);
}

const manifest = await bundleGatewayArtifacts(
  sourceManifestPath,
  join(packageRoot, 'resources', 'gateway-artifacts'),
  packageVersion
);
console.log(`[build:runtime] bundled ${manifest.artifacts.length} Rust Gateway targets`);
