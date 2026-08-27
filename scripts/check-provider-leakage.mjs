#!/usr/bin/env node
/**
 * Provider-leakage check (P3).
 *
 * §3: "Never call a provider directly. A grep for provider hostnames in CI should return
 * nothing outside of documentation."
 *
 * This app holds no provider credentials and reaches no provider. Everything goes through
 * the router. The check also covers the GLM-OCR llama-server port, because `local_ocr` is a
 * router provider kind and not something this app calls — that distinction is easy to lose
 * once someone is debugging an extraction at 11pm in March.
 */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const ROOT = process.cwd();

/** Source only. Docs may name providers; that is the point of documentation. */
const SEARCH_DIRS = ['src', 'ui/src', 'sidecar', 'scripts'];
const SEARCH_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.py', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__pycache__']);

const PATTERNS = [
  { name: 'DigitalOcean inference host', re: /inference\.do-ai\.run/i },
  { name: 'DigitalOcean SDK', re: /\b(?:from|require)\s*\(?['"]@digitalocean\//i },
  { name: 'DigitalOcean Files API', re: /\bfiles\.do-ai\.run|digitalocean.*files\s*api/i },
  { name: 'Anthropic SDK', re: /['"]@anthropic-ai\/|api\.anthropic\.com/i },
  { name: 'OpenAI SDK', re: /['"]openai['"]|api\.openai\.com/i },
  { name: 'Ollama endpoint', re: /localhost:11434|\bollama\b.*(?:http|url)/i },
  { name: 'direct GLM-OCR llama-server', re: /:8090\b/ },
  { name: 'provider API key env var', re: /\b(?:OPENAI|ANTHROPIC|DIGITALOCEAN|DO)_API_KEY\b/ },
];

/** The router client is the one place allowed to name the router itself. */
const ALLOWLIST = [/^src[\\/]router[\\/]/, /^scripts[\\/]check-provider-leakage\.mjs$/];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SEARCH_EXT.has(extname(entry.name))) yield full;
  }
}

const findings = [];

for (const dir of SEARCH_DIRS) {
  for await (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file);
    if (ALLOWLIST.some((re) => re.test(rel))) continue;

    const content = await readFile(file, 'utf8');
    const lines = content.split('\n');

    for (const [index, line] of lines.entries()) {
      // A comment explaining what NOT to do is not a leak.
      const isComment = /^\s*(\/\/|#|\*|\/\*)/.test(line);
      for (const pattern of PATTERNS) {
        if (pattern.re.test(line) && !isComment) {
          findings.push({ file: rel, line: index + 1, name: pattern.name, text: line.trim().slice(0, 120) });
        }
      }
    }
  }
}

if (findings.length) {
  console.error('Provider leakage detected — this app must reach AI only through the router (§3):\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.name}]`);
    console.error(`    ${f.text}`);
  }
  console.error(`\n${findings.length} finding(s).`);
  process.exit(1);
}

console.log('provider-leakage check: clean');
