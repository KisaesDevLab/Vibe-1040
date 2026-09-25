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
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(BIN, args, {
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

async function engineVersion() {
  const { stdout } = await run(['version'], tmpdir());
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

async function inspectNode(nodeType) {
  if (!/^[a-z0-9_]+$/i.test(nodeType)) {
    return { implemented: false, reason: 'not a valid node type name' };
  }
  const { stdout, code } = await run(['node', 'inspect', '--node_type', nodeType, '--json'], tmpdir());
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

async function catalog(nodeTypes) {
  const nodes = {};
  const queue = [...nodeTypes];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      nodes[next] = await inspectNode(next);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CATALOG_CONCURRENCY, queue.length) }, () => worker()),
  );
  return { engineVersion: await engineVersion(), nodes };
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

  if (req.method !== 'POST' || path !== '/draft') {
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
    draft(parsed)
      .then(({ status, body }) => send(status, body))
      .catch((err) => send(500, { error: 'wrapper failure', detail: String(err?.message ?? err) }));
  });
});

server.listen(PORT, () => {
  console.log(`opentax wrapper listening on ${PORT}, engine at ${BIN}`);
});
