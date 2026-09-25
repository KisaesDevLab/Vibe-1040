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

  if (req.method === 'GET' && req.url === '/health') {
    engineVersion()
      .then((version) => send(200, { ok: true, version }))
      .catch((err) => send(503, { ok: false, version: null, reason: String(err?.message ?? err) }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/draft') {
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
