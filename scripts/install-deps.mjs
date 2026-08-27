#!/usr/bin/env node
/**
 * Install dependencies when `@kisaes/vibe-ai-client` is not on a public registry.
 *
 *   node scripts/install-deps.mjs [--omit=dev] [--sdk <path>]
 *
 * The SDK is a first-party package that lives in the Vibe-AI-Router repository and is not
 * published to npm. `npm install` therefore 404s on it and refuses to install *anything* —
 * the whole tree fails on one unreachable package.
 *
 * So: drop the dependency, install everything else, restore package.json exactly as it was,
 * and place the SDK's build output into node_modules by hand. The declared dependency stays
 * correct in the manifest, which is what a reader and a future registry publish both need.
 *
 * The SDK is located in this order:
 *   1. `--sdk <path>`
 *   2. `VIBE_AI_SDK_PATH`
 *   3. `./vendor/sdk`            (what the Docker build and CI populate)
 *   4. `../Vibe-AI-Router/packages/sdk`  (a sibling checkout, for local development)
 */
import { execFileSync } from 'node:child_process';

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SDK_NAME = '@kisaes/vibe-ai-client';

/**
 * On Windows npm is a `.cmd` shim that is not always resolvable by `execFileSync` directly,
 * so it has to go through a shell there. Every argument below is a fixed literal — nothing
 * user-supplied reaches the command line — which is what makes that safe.
 */
const NPM = 'npm';
const SPAWN = { stdio: 'inherit', ...(process.platform === 'win32' ? { shell: true } : {}) };
const args = process.argv.slice(2);

const sdkFlagIndex = args.indexOf('--sdk');
const sdkFlag = sdkFlagIndex >= 0 ? args[sdkFlagIndex + 1] : undefined;
const npmArgs = args.filter((a, i) => a !== '--sdk' && i !== sdkFlagIndex + 1);

const candidates = [
  sdkFlag,
  process.env['VIBE_AI_SDK_PATH'],
  'vendor/sdk',
  '../Vibe-AI-Router/packages/sdk',
].filter((c) => typeof c === 'string' && c.length > 0);

const sdkPath = candidates.map((c) => resolve(c)).find((c) => existsSync(join(c, 'package.json')));

if (!sdkPath) {
  console.error(`Cannot find ${SDK_NAME}. Looked in:`);
  for (const c of candidates) console.error(`  ${resolve(c)}`);
  console.error('\nPass --sdk <path>, set VIBE_AI_SDK_PATH, or check out Vibe-AI-Router alongside this repo.');
  process.exit(1);
}

if (!existsSync(join(sdkPath, 'dist', 'index.js'))) {
  console.log(`building the SDK at ${sdkPath}`);
  execFileSync(NPM, ['install', '--no-audit', '--no-fund'], { ...SPAWN, cwd: sdkPath });
  execFileSync(NPM, ['run', 'build'], { ...SPAWN, cwd: sdkPath });
}

const manifestPath = resolve('package.json');
const original = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(original);
const declared = manifest.dependencies?.[SDK_NAME];

if (!declared) {
  console.error(`${SDK_NAME} is not declared in package.json — nothing to work around.`);
  process.exit(1);
}

try {
  delete manifest.dependencies[SDK_NAME];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`npm install ${npmArgs.join(' ')} (without ${SDK_NAME})`);
  execFileSync(NPM, ['install', '--no-audit', '--no-fund', ...npmArgs], SPAWN);
} finally {
  // Always put the manifest back, even if npm failed.
  await writeFile(manifestPath, original);
}

const dest = resolve('node_modules', '@kisaes', 'vibe-ai-client');
await mkdir(dest, { recursive: true });
await cp(join(sdkPath, 'dist'), join(dest, 'dist'), { recursive: true });
await cp(join(sdkPath, 'package.json'), join(dest, 'package.json'));

const sdkVersion = JSON.parse(await readFile(join(sdkPath, 'package.json'), 'utf8')).version;
console.log(`linked ${SDK_NAME}@${sdkVersion} from ${sdkPath} (declared ${declared})`);
