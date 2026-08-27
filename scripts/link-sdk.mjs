#!/usr/bin/env node
/**
 * Dev setup: satisfy `@kisaes/vibe-ai-client` from a local checkout.
 *
 * The SDK is a first-party package published to the suite's private registry, not to npm.
 * On an appliance it arrives with the image; in development it comes from a sibling
 * Vibe-AI-Router checkout. This copies its built `dist` into node_modules so `npm install`
 * does not need registry access.
 *
 *   node scripts/link-sdk.mjs [path-to-vibe-ai-router]
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const routerRoot = resolve(process.argv[2] ?? '../Vibe-AI-Router');
const sdkSrc = join(routerRoot, 'packages', 'sdk');

if (!existsSync(join(sdkSrc, 'package.json'))) {
  console.error(`No SDK at ${sdkSrc}.`);
  console.error('Pass the path to your Vibe-AI-Router checkout:');
  console.error('  node scripts/link-sdk.mjs ../Vibe-AI-Router');
  process.exit(1);
}

if (!existsSync(join(sdkSrc, 'dist', 'index.js'))) {
  console.error(`The SDK at ${sdkSrc} has no dist/. Build it there first: npm run build`);
  process.exit(1);
}

const dest = join(process.cwd(), 'node_modules', '@kisaes', 'vibe-ai-client');
await mkdir(dest, { recursive: true });
await cp(join(sdkSrc, 'dist'), join(dest, 'dist'), { recursive: true });

const pkg = JSON.parse(await readFile(join(sdkSrc, 'package.json'), 'utf8'));
await writeFile(join(dest, 'package.json'), JSON.stringify(pkg, null, 2));

console.log(`linked @kisaes/vibe-ai-client@${pkg.version} from ${sdkSrc}`);
