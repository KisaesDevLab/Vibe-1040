/**
 * A thin HTTP wrapper around the OpenTax CLI.
 *
 * Why this exists: the engine is a stateful CLI (`return create` → `form add` × n →
 * `return get`), not a library and not a server. This wrapper turns that sequence into one
 * request so the app can treat the engine as a process boundary with a JSON contract, exactly
 * as the queue is the boundary to the Python sidecar.
 *
 * Two properties are deliberate and must survive any edit:
 *
 *  - **The engine binary is never modified and never linked.** It is invoked as a subprocess.
 *    This wrapper is Vibe 1040's own code; OpenTax stays an unmodified AGPL work beside it.
 *    See CLAUDE.md §13 and QUESTIONS.md Q22 — moving the engine in-process is what this
 *    arrangement exists to avoid.
 *  - **Every request gets its own state directory, and it is deleted afterwards.** The CLI
 *    stores returns on disk under a base directory it derives from HOME and cwd. Returns hold
 *    taxpayer amounts, so nothing may outlive the request that computed it (§11: rasterized
 *    derivatives and anything like them purge on schedule, and this never needs to persist at
 *    all).
 *
 * No dependencies: `node:http` and `node:child_process` only, so the image stays a binary, a
 * Node runtime and this file.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8230);
const BIN = process.env.OPENTAX_BIN ?? '/usr/local/bin/opentax';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Per-invocation ceiling. A wedged child must not hold a request open forever. */
const CHILD_TIMEOUT_MS = Number(process.env.OPENTAX_CHILD_TIMEOUT_MS ?? 60_000);

/**
 * Run the CLI once.
 *
 * Arguments are always a fixed literal list plus values from the request body, passed as argv
 * entries rather than through a shell — no `shell: true` anywhere, so a payload cannot become
 * a command. Taxpayer JSON reaches the CLI as a single argv element.
 */
function run(args, cwd, bin = BIN) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, HOME: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message ?? err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -1 : code, stdout, stderr: timedOut ? 'timed out' : stderr });
    });
  });
}

function parseJson(text) {
  // The CLI prints human-readable preamble before its JSON in some commands, so take the
  // outermost object rather than assuming the whole of stdout parses.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function engineVersion(bin = BIN) {
  const { stdout } = await run(['version'], tmpdir(), bin);
  // Capture the prerelease and build metadata too. Truncating `0.1.0-rc.1` to `0.1.0` would
  // make the app's OPENTAX_VERSION check pass on a binary that is not the pinned release,
  // which is the one thing that check exists to catch.
  const match = stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/);
  return match ? match[0] : stdout.trim().split('\n')[0] || 'unknown';
}

/**
 * Parse one field line of `node inspect`'s schema listing.
 *
 * The lines look like these, and all four shapes occur in 2.0.4:
 *
 *     box1_wages  number  ≥0  — Wages, tips, other compensation
 *     payer_tin  string  (optional)
 *     employer_ein  string  — Employer identification number  (optional)
 *     filing_status  enum  single | mfs | mfj | hoh | qss
 *
 * So `(optional)` can follow the description rather than the type, which is why requiredness
 * is read off the end of the whole line before anything is stripped.
 */
function parseFieldLine(line) {
  const indent = line.length - line.trimStart().length;
  const required = !/\(optional\)\s*$/.test(line);
  let rest = line.trim().replace(/\(optional\)\s*$/, '');
  // Drop the description, which is free text and may itself contain two spaces.
  const dash = rest.indexOf('—');
  if (dash >= 0) rest = rest.slice(0, dash);
  const parts = rest.trim().split(/\s{2,}/);
  const name = parts[0] ?? '';
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  // The type token carries its constraints, and inconsistently: `array (min 1)` on one node,
  // `array  (min 1)` on another, `enum  a | b | c` elsewhere. Only the bare type is wanted,
  // and reading it as the whole token made every array header parse as a plain field.
  const type = (parts[1] ?? 'unknown').trim().split(/\s+/)[0];
  return { indent, name, type, required };
}

/**
 * Turn `node inspect --node_type X --json`'s `schema` lines into field descriptors.
 *
 * `fields` is what a `form add` payload for this node may carry, and which lines those are
 * depends on the node's shape:
 *
 *  - **Array-shaped** (`w2`, `f1099int`, most of them). The first line is the collection
 *    header — `w2s  array (min 1)` — followed by `items:` and the per-form fields. A payload
 *    is one *item*, so the item fields are the payload's fields.
 *  - **Flat** (`general`). The first line is an ordinary field and the payload is the
 *    top-level object itself.
 *
 * The distinction has to be drawn on the *first* line rather than on "does an `items:` block
 * exist anywhere", because a flat node can contain an array of its own: `general` embeds
 * `dependents`, and treating that as the payload shape picks a dependent's `first_name` over
 * the taxpayer's `filing_status` — the opposite of the truth.
 *
 * Anything not in `fields` — a flat node's nested collections, or the top-level fields some
 * array nodes carry after the array — goes in `otherFields` by name only. A rename check needs
 * to know the name exists somewhere on the node; their requiredness means something different
 * and is deliberately not reported.
 */
function parseSchema(lines) {
  const fields = {};
  const otherFields = new Set();
  const first = parseFieldLine(lines[0] ?? '');
  const isArrayNode = first !== null && first.indent === 0 && first.type === 'array';

  if (!isArrayNode) {
    for (const line of lines) {
      const f = parseFieldLine(line);
      if (!f) continue;
      if (f.indent === 0 && f.type !== 'array') fields[f.name] = { type: f.type, required: f.required };
      else if (f.name) otherFields.add(f.name);
    }
    for (const name of Object.keys(fields)) otherFields.delete(name);
    return { collection: null, fields, otherFields: [...otherFields] };
  }

  const collection = first.name;
  // Direct children of the node's own `items:`, which is the one on the second line.
  const itemsAt = lines.findIndex((l) => l.trim() === 'items:');
  const itemIndent = itemsAt < 0 ? -1 : lines[itemsAt].length - lines[itemsAt].trimStart().length;
  for (let i = 0; i < lines.length; i += 1) {
    if (i === itemsAt) continue;
    const f = parseFieldLine(lines[i]);
    if (!f) continue;
    if (itemsAt >= 0 && i > itemsAt && f.indent === itemIndent + 2) {
      fields[f.name] = { type: f.type, required: f.required };
    } else if (f.name !== collection) {
      otherFields.add(f.name);
    }
  }
  for (const name of Object.keys(fields)) otherFields.delete(name);
  return { collection, fields, otherFields: [...otherFields] };
}

/**
 * The engine's own input-node catalogue, for the node types the app maps.
 *
 * This exists because of a silent failure mode the app cannot otherwise see. An engine field
 * renamed between releases is fatal only when the field is *required* — then `form add` refuses
 * the node and the app reports it. A renamed **optional** field is accepted and ignored: the
 * amount never reaches the return, the line comes back absent, and absent is exactly what "the
 * documents reported nothing here" looks like. Verified against 2.0.4 — a 1099-INT box 1 sent
 * as `box1_interest` rather than `box1` leaves `line2b_taxable_interest` simply missing, with
 * no diagnostic anywhere.
 *
 * So the app checks the names it intends to send against the names the engine actually has,
 * and a rename becomes an error at upgrade time instead of a number that quietly disappears.
 */
/**
 * How many `node inspect` children run at once.
 *
 * Sequentially this takes about nine seconds for the fifteen node types the app maps, which is
 * too long to sit in front of a first draft. Unbounded is worse: the engine is a 134 MB
 * `deno compile` binary and fifteen at once is a memory spike an appliance should not take for
 * a diagnostic. Four keeps it near two seconds at a bounded cost.
 */
const CATALOG_CONCURRENCY = Number(process.env.OPENTAX_CATALOG_CONCURRENCY ?? 4);

async function inspectNode(nodeType, bin = BIN) {
  if (!/^[a-z0-9_]+$/i.test(nodeType)) {
    return { implemented: false, reason: 'not a valid node type name' };
  }
  const { stdout, code } = await run(['node', 'inspect', '--node_type', nodeType, '--json'], tmpdir(), bin);
  // An unknown node type prints `Error: Unknown node type: x` rather than JSON, so the absence
  // of a parseable schema is what decides, not the exit code alone.
  const parsed = parseJson(stdout);
  if (code !== 0 || parsed === null || !Array.isArray(parsed.schema)) {
    return {
      implemented: false,
      reason: (stdout || '').trim().slice(0, 200) || `node inspect exited ${code}`,
    };
  }
  return { implemented: parsed.implemented !== false, ...parseSchema(parsed.schema) };
}

async function catalog(nodeTypes, bin = BIN) {
  const nodes = {};
  const queue = [...nodeTypes];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      nodes[next] = await inspectNode(next, bin);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CATALOG_CONCURRENCY, queue.length) }, () => worker()),
  );
  return { engineVersion: await engineVersion(bin), nodes };
}

/**
 * Split the engine's diagnostics into blocking and advisory.
 *
 * Its own report separates hard failures from softer warnings; the shapes it uses have moved
 * once already, so read defensively and treat anything unrecognised as hard. Under-reporting a
 * blocking diagnostic is the worse error.
 */
function splitDiagnostics(report) {
  const hard = [];
  const soft = [];
  const items = Array.isArray(report?.diagnostics)
    ? report.diagnostics
    : Array.isArray(report?.errors)
      ? report.errors
      : Array.isArray(report)
        ? report
        : [];
  for (const item of items) {
    const entry = {
      code: String(item?.code ?? item?.ruleId ?? item?.rule ?? 'unknown'),
      message: String(item?.message ?? item?.description ?? JSON.stringify(item)),
    };
    const severity = String(item?.severity ?? item?.level ?? '').toLowerCase();
    if (severity === 'warning' || severity === 'warn' || severity === 'info') soft.push(entry);
    else hard.push(entry);
  }
  if (Array.isArray(report?.warnings)) {
    for (const w of report.warnings) soft.push({ code: 'warning', message: String(w) });
  }
  return { hard, soft };
}

async function draft(body) {
  const nodes = Array.isArray(body?.nodes) ? body.nodes : null;
  // `Number(null)` is 0 and `Number.isInteger(0)` is true, so a missing or null taxYear would
  // otherwise reach the engine as year 0. Require a year that could be a tax year: rejecting
  // nonsense at the boundary beats a 500 from `return create`, or a draft labelled year 0.
  const taxYear = typeof body?.taxYear === 'number' ? body.taxYear : Number.NaN;
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100 || nodes === null) {
    return {
      status: 400,
      body: { error: 'taxYear (an integer between 2000 and 2100) and nodes (an array) are required' },
    };
  }

  const dir = await mkdtemp(join(tmpdir(), 'opentax-'));
  try {
    const created = await run(['return', 'create', '--year', String(taxYear)], dir);
    const createdJson = parseJson(created.stdout);
    const returnId = createdJson?.returnId;
    if (created.code !== 0 || typeof returnId !== 'string') {
      return {
        status: 500,
        body: { error: 'return create failed', detail: (created.stderr || created.stdout).slice(0, 2000) },
      };
    }

    // A node the engine will not accept is reported, not fatal: the rest of the draft is still
    // worth computing, and the app marks the result partial and names what was dropped.
    const rejected = [];
    for (const node of nodes) {
      const nodeType = String(node?.nodeType ?? '');
      const payload = JSON.stringify(node?.payload ?? {});
      const added = await run(
        ['form', 'add', '--returnId', returnId, '--node_type', nodeType, payload],
        dir,
      );
      if (added.code !== 0) {
        rejected.push({
          nodeType,
          documentId: node?.documentId ?? null,
          message: (added.stderr || added.stdout).slice(0, 600).trim(),
        });
      }
    }

    const got = await run(['return', 'get', '--returnId', returnId], dir);
    const result = parseJson(got.stdout);
    if (got.code !== 0 || result === null) {
      return {
        status: 500,
        body: { error: 'return get failed', detail: (got.stderr || got.stdout).slice(0, 2000), rejected },
      };
    }

    const validated = await run(
      ['return', 'validate', '--returnId', returnId, '--format', 'json'],
      dir,
    );
    const validation = splitDiagnostics(parseJson(validated.stdout) ?? {});

    return {
      status: 200,
      body: {
        returnId,
        year: result.year ?? taxYear,
        engineVersion: await engineVersion(),
        summary: result.summary ?? {},
        lines: result.lines ?? {},
        forms: result.forms ?? [],
        warnings: result.warnings ?? [],
        validation,
        rejected,
      },
    };
  } finally {
    // Taxpayer amounts were on disk here. They do not outlive the request.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Staged install (P17, QUESTIONS.md Q23).
 *
 * **Off unless `OPENTAX_STAGING_DIR` is set.** It needs a writable volume on a container that
 * ships `read_only: true`, and — for the download form — outbound access from the appliance to
 * the release host. Neither exists by default, and both belong in the WISP review Q21 opened,
 * so the feature is inert until an operator provides them. That is the right default.
 *
 * What it does **not** do is as important as what it does. There is no `latest`: a caller names
 * an exact version and an exact SHA-256, and a binary whose digest does not match is deleted
 * rather than kept. Nothing is ever served by a staged binary — `activate` is a separate call a
 * person makes after reading the report, and §14's rule that the pin lives in the image is
 * unchanged, because staging replaces one pinned artefact with another under an operator's hand.
 */
const STAGING_DIR = process.env.OPENTAX_STAGING_DIR ?? '';
const INSTALL_ALLOWED = STAGING_DIR !== '';
/**
 * A staged binary keeps the live one's **exact file name**, in a subdirectory of its own.
 *
 * Not `opentax.staged` beside it, which is the obvious first shape and is wrong: a runtime that
 * dispatches on the file name would treat the renamed copy differently from the thing it is a
 * copy of. That is not hypothetical — it is how this was caught, by a stand-in engine that ran
 * perfectly as `opentax-next` and failed to start as `opentax.staged`. Whatever an operator
 * activates should differ from what is running in one respect only: its contents.
 */
const STAGED_PATH = INSTALL_ALLOWED ? join(STAGING_DIR, 'staged', basename(BIN)) : '';
const PREVIOUS_PATH = INSTALL_ALLOWED ? join(STAGING_DIR, 'previous', basename(BIN)) : '';
/** A release binary is tens of megabytes; anything far larger is not one. */
const MAX_BINARY_BYTES = 512 * 1024 * 1024;

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const sha256Of = async (path) => {
  const { readFile } = await import('node:fs/promises');
  return createHash('sha256').update(await readFile(path)).digest('hex');
};

/**
 * Put a candidate binary at `STAGED_PATH`, or throw with a reason.
 *
 * Two sources, and the app only ever uses the first. `url` downloads; `file` takes a basename
 * an operator has already dropped into the staging directory, which is how an appliance with no
 * outbound access upgrades at all. `file` is a basename by construction — any path separator is
 * refused — so this cannot be pointed at an arbitrary file on the container.
 */
async function fetchCandidate({ url, file }) {
  if (file !== undefined) {
    if (file !== basename(file) || file.startsWith('.')) {
      throw new Error('file must be a plain name inside the staging directory');
    }
    const source = join(STAGING_DIR, file);
    if (!(await exists(source))) throw new Error(`no such file in the staging directory: ${file}`);
    const { size } = await stat(source);
    if (size > MAX_BINARY_BYTES) throw new Error('file is implausibly large for a release binary');
    await copyFile(source, STAGED_PATH);
    return { from: `file:${file}` };
  }

  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('url must be https, or pass a file already in the staging directory');
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength > MAX_BINARY_BYTES) throw new Error('download is implausibly large');
  await writeFile(STAGED_PATH, body);
  return { from: url };
}

/**
 * Stage, verify, and read the version back out of the candidate — in that order.
 *
 * The digest is checked **before** the binary is ever executed, and a mismatch deletes it. Then
 * it is run once, for `version` and nothing else, and a version that disagrees with what the
 * caller asked for is also a failure: a release re-tagged under the same name is exactly the
 * thing a checksum plus a version pin exists to catch.
 */
async function stageBinary({ version, sha256, url, file }) {
  if (!INSTALL_ALLOWED) throw new Error('staging is not configured on this deployment');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error('version is required, and must be an exact release version');
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('sha256 is required, and must be 64 lowercase hex characters');
  }

  await mkdir(dirname(STAGED_PATH), { recursive: true });
  await rm(STAGED_PATH, { force: true });
  const { from } = await fetchCandidate({ url, file });

  const digest = await sha256Of(STAGED_PATH);
  if (digest !== sha256) {
    await rm(STAGED_PATH, { force: true });
    throw new Error(`checksum mismatch: expected ${sha256}, got ${digest}`);
  }
  await chmod(STAGED_PATH, 0o755);

  const reported = await engineVersion(STAGED_PATH).catch((err) => {
    throw new Error(`the staged binary did not run: ${String(err?.message ?? err)}`);
  });
  if (reported !== version) {
    await rm(STAGED_PATH, { force: true });
    throw new Error(`the staged binary reports ${reported}, not the ${version} that was asked for`);
  }

  return { version: reported, sha256: digest, from, path: STAGED_PATH };
}

/** What is staged and what is live, for a page that has to show both before anybody acts. */
async function stagedState() {
  if (!INSTALL_ALLOWED) return { allowed: false, staged: null, live: null, previous: false };
  const live = await engineVersion().then((v) => ({ version: v, path: BIN })).catch(() => null);
  if (!(await exists(STAGED_PATH))) return { allowed: true, staged: null, live, previous: await exists(PREVIOUS_PATH) };
  const [version, sha256, info] = await Promise.all([
    engineVersion(STAGED_PATH).catch(() => null),
    sha256Of(STAGED_PATH),
    stat(STAGED_PATH),
  ]);
  return {
    allowed: true,
    staged: { version, sha256, stagedAt: info.mtime.toISOString(), path: STAGED_PATH },
    live,
    previous: await exists(PREVIOUS_PATH),
  };
}

/**
 * Make the staged binary the live one, keeping the outgoing one beside it.
 *
 * A rename, so there is no window in which `BIN` is absent or half-written, and every later
 * `spawn` picks up the new file with no restart. The previous binary is kept rather than
 * deleted: the fastest fix for an upgrade that turns out wrong is putting the old one back.
 */
async function activateStaged() {
  if (!INSTALL_ALLOWED) throw new Error('staging is not configured on this deployment');
  if (!(await exists(STAGED_PATH))) throw new Error('nothing is staged');
  const version = await engineVersion(STAGED_PATH);
  if (await exists(BIN)) {
    await mkdir(dirname(PREVIOUS_PATH), { recursive: true });
    await rm(PREVIOUS_PATH, { force: true });
    await copyFile(BIN, PREVIOUS_PATH);
    await chmod(PREVIOUS_PATH, 0o755);
  }
  // Copy into the live binary's **own directory** first, then rename within it.
  //
  // A direct `rename` from the staging volume would work in a test, where both paths sit on
  // /tmp, and fail with EXDEV on a real appliance, where the staging volume and
  // `/usr/local/bin` are different filesystems — the worst kind of bug, one that only appears
  // where it matters. A rename inside one directory is atomic, so there is no instant at which
  // `BIN` is missing or half-written while a draft is being computed.
  const incoming = `${BIN}.incoming`;
  await rm(incoming, { force: true });
  await copyFile(STAGED_PATH, incoming);
  await chmod(incoming, 0o755);
  await rename(incoming, BIN);
  await rm(STAGED_PATH, { force: true });
  return { version, path: BIN, previousKept: PREVIOUS_PATH };
}

/** Put the previous binary back, for an upgrade that went live and turned out wrong. */
async function rollbackStaged() {
  if (!INSTALL_ALLOWED) throw new Error('staging is not configured on this deployment');
  if (!(await exists(PREVIOUS_PATH))) throw new Error('there is no previous binary to roll back to');
  // Same shape as activation, for the same reason: never write `BIN` in place.
  const incoming = `${BIN}.incoming`;
  await rm(incoming, { force: true });
  await copyFile(PREVIOUS_PATH, incoming);
  await chmod(incoming, 0o755);
  await rename(incoming, BIN);
  await rm(PREVIOUS_PATH, { force: true });
  return { version: await engineVersion(), path: BIN };
}

const server = createServer((req, res) => {
  const send = (status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  };

  // Compared on the normalised path, so a query string does not defeat the match.
  const path = new URL(req.url ?? '/', 'http://local').pathname;

  if (req.method === 'GET' && path === '/health') {
    engineVersion()
      .then((version) => send(200, { ok: true, version }))
      .catch((err) => send(503, { ok: false, version: null, reason: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'GET' && path === '/catalog') {
    const raw = new URL(req.url ?? '/', 'http://local').searchParams.get('nodes') ?? '';
    const nodeTypes = [...new Set(raw.split(',').map((n) => n.trim()).filter(Boolean))];
    if (nodeTypes.length === 0) {
      send(400, { error: 'nodes is required: a comma-separated list of node types' });
      return;
    }
    // One child process per node type. Bounded because the app asks only for the node types
    // its map declares — about fifteen, not the engine's 187.
    if (nodeTypes.length > 60) {
      send(400, { error: 'too many node types in one request' });
      return;
    }
    catalog(nodeTypes)
      .then((body) => send(200, body))
      .catch((err) => send(500, { error: 'catalog failed', detail: String(err?.message ?? err) }));
    return;
  }

  // ── staged install (Q23) ───────────────────────────────────────────────────
  //
  // Read-only endpoints first. `GET /staged` answers even when staging is unconfigured, with
  // `allowed: false`, so the page can say why the buttons are absent instead of erroring.
  if (req.method === 'GET' && path === '/staged') {
    stagedState()
      .then((body) => send(200, body))
      .catch((err) => send(500, { error: 'staged state failed', detail: String(err?.message ?? err) }));
    return;
  }

  // The catalogue of the **staged** binary, which is how the app checks a candidate against the
  // node map before anybody activates it. Same parser, different binary.
  if (req.method === 'GET' && path === '/staged/catalog') {
    if (!INSTALL_ALLOWED) {
      send(409, { error: 'staging is not configured on this deployment' });
      return;
    }
    const raw = new URL(req.url ?? '/', 'http://local').searchParams.get('nodes') ?? '';
    const nodeTypes = [...new Set(raw.split(',').map((n) => n.trim()).filter(Boolean))];
    if (nodeTypes.length === 0 || nodeTypes.length > 60) {
      send(400, { error: 'nodes is required: a comma-separated list of at most 60 node types' });
      return;
    }
    exists(STAGED_PATH)
      .then((there) =>
        there
          ? catalog(nodeTypes, STAGED_PATH).then((body) => send(200, body))
          : send(409, { error: 'nothing is staged' }),
      )
      .catch((err) => send(500, { error: 'catalog failed', detail: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'DELETE' && path === '/staged') {
    if (!INSTALL_ALLOWED) {
      send(409, { error: 'staging is not configured on this deployment' });
      return;
    }
    rm(STAGED_PATH, { force: true })
      .then(() => send(200, { discarded: true }))
      .catch((err) => send(500, { error: 'discard failed', detail: String(err?.message ?? err) }));
    return;
  }

  // The two acts that change what serves. Both are deliberate calls the app makes only when a
  // person has pressed something, and both are audited on the app's side.
  if (req.method === 'POST' && (path === '/staged/activate' || path === '/staged/rollback')) {
    const act = path.endsWith('activate') ? activateStaged : rollbackStaged;
    act()
      .then((body) => send(200, body))
      .catch((err) => send(409, { error: 'not activated', detail: String(err?.message ?? err) }));
    return;
  }

  if (req.method !== 'POST' || (path !== '/draft' && path !== '/staged')) {
    send(404, { error: 'not found' });
    return;
  }

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      send(413, { error: 'body too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      send(400, { error: 'body is not JSON' });
      return;
    }
    if (path === '/staged') {
      if (!INSTALL_ALLOWED) {
        send(409, { error: 'staging is not configured on this deployment' });
        return;
      }
      // 409 rather than 500 on a refusal: a checksum mismatch or a version that disagrees is
      // the request being wrong about the world, not the wrapper failing.
      stageBinary(parsed)
        .then((body) => send(200, body))
        .catch((err) => send(409, { error: 'not staged', detail: String(err?.message ?? err) }));
      return;
    }
    draft(parsed)
      .then(({ status, body }) => send(status, body))
      .catch((err) => send(500, { error: 'wrapper failure', detail: String(err?.message ?? err) }));
  });
});

server.listen(PORT, () => {
  console.log(`opentax wrapper listening on ${PORT}, engine at ${BIN}`);
});
