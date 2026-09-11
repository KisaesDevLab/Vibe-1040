/**
 * HTTP surface (P0, P5, P11, P12).
 *
 * Every route that touches taxpayer data audits (§11). Routes that read a page raster or a
 * source file audit specifically, because those are the two places actual document images
 * leave the appliance toward a browser.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { verifyPassword, generateTotpSecret, totpUri, verifyTotp } from '../auth/credentials.ts';
import {
  SESSION_COOKIE,
  issueSession,
  revokeSession,
  satisfyMfa,
  sessionCookieOptions,
} from '../auth/session.ts';
import { db } from '../db/client.ts';
import {
  bundleTaxpayers,
  bundles,
  checkResults,
  dispositions,
  documents,
  extractedFields,
  fieldCorrections,
  layoutSpans,
  pages,
  routerJobs,
  sourceFiles,
  taxpayers,
  users,
  worksheets,
} from '../db/schema.ts';
import { correctField, resolveDocumentFields } from '../extract/resolve.ts';
import { confirmIdentity } from '../identity/resolve.ts';
import { ingestBundle, ingestBundlesPerFile, type IncomingFile, type IngestResult } from '../ingest/upload.ts';
import { pipelineQueue, rasterQueue } from '../queue/queues.ts';
import { queueExtractionForDocuments, startExtraction } from '../queue/pipeline.ts';
import { blockingFailures } from '../reconcile/gate.ts';
import { isRouterReachable } from '../router/client.ts';
import { blobs } from '../storage/index.ts';
import { buildModelForBundle, generateWorksheet } from '../worksheet/generate.ts';
import { IdentityNotConfirmedError, WorksheetBlockedError } from '../reconcile/gate.ts';
import { auditAccess, requireRole, requireUser } from './middleware.ts';

/** Queue every source file of a freshly ingested bundle for rasterisation. */
async function queueRasterisation(result: IngestResult, userId: string): Promise<void> {
  const fileRows = await db.select().from(sourceFiles).where(eq(sourceFiles.bundleId, result.bundleId));
  for (const file of fileRows) {
    await rasterQueue.add('raster', {
      bundleId: result.bundleId,
      sourceFileId: file.id,
      storageKey: file.storageKey,
      mediaType: file.mediaType,
      userId,
    });
  }
  await db.update(bundles).set({ status: 'triaging' }).where(eq(bundles.id, result.bundleId));
}

export function registerRoutes(app: FastifyInstance): void {
  // ── health ─────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    ok: true,
    service: 'vibe-1040',
    // Degraded but serving: existing bundles remain readable when the router is down (§3).
    router: isRouterReachable() ? 'reachable' : 'unreachable',
  }));

  // ── auth ───────────────────────────────────────────────────────────────────
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);

    const ok = user && !user.disabledAt && (await verifyPassword(body.password, user.passwordHash));
    if (!ok || !user) {
      await auditAccess(req, 'auth.login_failed', { detail: { email: body.email } });
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    const token = await issueSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    void reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions);

    // MFA is mandatory (§11). A user without an enrolled factor must enroll before the
    // session becomes usable — there is no "skip for now". What varies is only WHICH
    // factor: authenticator, emailed code, or texted code.
    return {
      mfaRequired: true,
      method: user.mfaMethod,
      enrolled: user.totpConfirmedAt !== null || user.mfaEnrolledAt !== null,
      needsTotpEnrolment: user.mfaMethod === 'totp' && user.totpConfirmedAt === null,
    };
  });

  app.post('/api/auth/mfa/enroll', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });
    const [user] = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (user.totpConfirmedAt) return reply.code(409).send({ error: 'already enrolled' });

    // See the twin in admin-routes.ts: re-enrolment reuses an unconfirmed secret so a
    // second click cannot invalidate the one the user has already scanned.
    const secret = user.totpSecret ?? generateTotpSecret();
    if (secret !== user.totpSecret) {
      await db.update(users).set({ totpSecret: secret, updatedAt: new Date() }).where(eq(users.id, user.id));
    }
    return { secret, uri: totpUri(secret, user.email), account: user.email, issuer: 'Vibe 1040' };
  });

  app.post('/api/auth/mfa/verify', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });
    const body = z.object({ token: z.string() }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
    if (!user?.totpSecret) return reply.code(400).send({ error: 'not enrolled' });

    if (!verifyTotp(user.totpSecret, body.token)) {
      await auditAccess(req, 'auth.login_failed', { detail: { stage: 'mfa' } });
      return reply.code(401).send({ error: 'invalid code' });
    }

    if (!user.totpConfirmedAt) {
      await db.update(users).set({ totpConfirmedAt: new Date() }).where(eq(users.id, user.id));
      await auditAccess(req, 'auth.mfa_enrolled');
    }
    await satisfyMfa(req.user.sessionId);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await auditAccess(req, 'auth.login');
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.user) {
      await revokeSession(req.user.sessionId);
      await auditAccess(req, 'auth.logout');
    }
    void reply.clearCookie(SESSION_COOKIE, sessionCookieOptions);
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
  });

  // ── bundles ────────────────────────────────────────────────────────────────
  app.post('/api/bundles', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const files: IncomingFile[] = [];
    let label = `Bundle ${new Date().toISOString().slice(0, 10)}`;

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        files.push({
          filename: part.filename,
          mediaType: part.mimetype,
          bytes: await part.toBuffer(),
        });
      } else if (part.fieldname === 'label' && typeof part.value === 'string') {
        label = part.value;
      }
    }

    if (!files.length) return reply.code(400).send({ error: 'no files uploaded' });

    const result = await ingestBundle(label, files, user.id);
    await auditAccess(req, 'bundle.upload', {
      bundleId: result.bundleId,
      entityType: 'bundle',
      entityId: result.bundleId,
      detail: { fileCount: result.fileCount, duplicateOf: result.duplicateOfBundleId },
    });

    // Rasterization is the sidecar's job; the queue is the boundary (§12).
    await queueRasterisation(result, user.id);

    return reply.code(201).send(result);
  });

  /**
   * Bulk upload: one bundle per file (P1, P5).
   *
   * The unit a firm drops here is a client packet, so five packets are five bundles. Each
   * is named from its own filename and renamed to the primary taxpayer once identity is
   * proposed, because nobody is typing forty labels.
   *
   * Partial success is the normal outcome and is reported as 207: a folder with one
   * unsupported file ingests the rest and names the one it refused. Returning 400 for the
   * whole batch would make the caller work out which file was the problem by bisection.
   */
  app.post('/api/bundles/bulk', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const files: IncomingFile[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        files.push({ filename: part.filename, mediaType: part.mimetype, bytes: await part.toBuffer() });
      }
    }
    if (!files.length) return reply.code(400).send({ error: 'no files uploaded' });

    const { ingested, rejected } = await ingestBundlesPerFile(files, user.id);

    for (const result of ingested) {
      await auditAccess(req, 'bundle.upload', {
        bundleId: result.bundleId,
        entityType: 'bundle',
        entityId: result.bundleId,
        detail: { fileCount: result.fileCount, duplicateOf: result.duplicateOfBundleId, bulk: true },
      });
      await queueRasterisation(result, user.id);
    }

    if (!ingested.length) return reply.code(400).send({ error: 'no files could be ingested', rejected });
    return reply.code(rejected.length ? 207 : 201).send({ bundles: ingested, rejected });
  });

  /**
   * Rename a bundle. Clears `labelAuto`, so identity resolution stops proposing a name for
   * it — the reviewer has said what it is called.
   */
  app.patch('/api/bundles/:id/label', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { label } = z.object({ label: z.string().trim().min(1).max(200) }).parse(req.body);

    await db.update(bundles).set({ label, labelAuto: false, updatedAt: new Date() }).where(eq(bundles.id, id));
    await auditAccess(req, 'bundle.upload', {
      bundleId: id,
      entityType: 'bundle',
      entityId: id,
      detail: { renamedTo: label },
    });
    return { ok: true, label };
  });

  /**
   * Reprocess a bundle (P5, P9).
   *
   * Three depths, because they cost very differently and destroy very differently:
   *
   *   reconcile — re-run the arithmetic gate only. No inference at all. This is what you
   *               want after changing the firm's tolerance, or to pick up corrections.
   *   extract   — re-bind fields from the layout spans already stored. No vision calls, so
   *               cheap. This is what you want after a form schema changes.
   *   classify  — start again from the stored page images: reclassify, re-run layout, re-bind.
   *               This is what you want after registering a form type that a bundle's pages
   *               were rejected for, and it is the only one that costs a full inference pass.
   *
   * What survives, and what does not:
   *
   *   - Source files and page images are never touched. Reprocessing re-reads them.
   *   - Field corrections survive `reconcile` and `extract`, because extraction upserts on
   *     (document, field key) and a correction hangs off the field row. They do NOT survive
   *     `classify`, which regroups pages into new documents.
   *   - Dispositions carry forward wherever the finding is materially unchanged.
   *   - Identity confirmation is left alone. Re-confirming a client whose documents did not
   *     change is busywork, and §7's gate is about the human having looked once.
   *
   * `classify` therefore asks for an explicit acknowledgement rather than trusting a button
   * press, because it is the one that can discard a reviewer's typing.
   */
  app.post('/api/bundles/:id/reprocess', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin', 'partner']);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = z
      .object({
        from: z.enum(['reconcile', 'extract', 'classify']),
        acknowledgeDiscardsCorrections: z.boolean().optional(),
      })
      .parse(req.body ?? {});

    const [bundle] = await db.select().from(bundles).where(eq(bundles.id, id)).limit(1);
    if (!bundle) return reply.code(404).send({ error: 'not found' });

    if (body.from === 'classify' && !body.acknowledgeDiscardsCorrections) {
      const [{ count } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(fieldCorrections)
        .innerJoin(extractedFields, eq(extractedFields.id, fieldCorrections.fieldId))
        .innerJoin(documents, eq(documents.id, extractedFields.documentId))
        .where(and(eq(documents.bundleId, id), isNull(fieldCorrections.supersededAt)));
      if (count > 0) {
        return reply.code(409).send({
          error: 'would_discard_corrections',
          message:
            `Reclassifying regroups pages into new documents, which discards ${count} ` +
            'correction(s) made by a reviewer. Re-send with acknowledgeDiscardsCorrections ' +
            'to proceed, or reprocess from extract instead.',
          corrections: count,
        });
      }
    }

    await auditAccess(req, 'bundle.reprocess', {
      bundleId: id,
      entityType: 'bundle',
      entityId: id,
      detail: { from: body.from, acknowledged: body.acknowledgeDiscardsCorrections ?? false },
    });

    if (body.from === 'reconcile') {
      await pipelineQueue.add('reconcile_bundle', { kind: 'reconcile_bundle', bundleId: id, userId: user.id });
      await db.update(bundles).set({ status: 'reconciling', updatedAt: new Date() }).where(eq(bundles.id, id));
      return { ok: true, from: body.from, queued: 1 };
    }

    if (body.from === 'extract') {
      const queued = await queueExtractionForDocuments(id, user.id);
      await db.update(bundles).set({ status: 'extracting', updatedAt: new Date() }).where(eq(bundles.id, id));
      return { ok: true, from: body.from, queued };
    }

    await pipelineQueue.add('classify_bundle', { kind: 'classify_bundle', bundleId: id, userId: user.id });
    await db.update(bundles).set({ status: 'classifying', updatedAt: new Date() }).where(eq(bundles.id, id));
    return { ok: true, from: body.from, queued: 1 };
  });

  app.get('/api/bundles', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return db.select().from(bundles).orderBy(desc(bundles.createdAt)).limit(200);
  });

  app.get('/api/bundles/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const [bundle] = await db.select().from(bundles).where(eq(bundles.id, id)).limit(1);
    if (!bundle) return reply.code(404).send({ error: 'not found' });

    await auditAccess(req, 'bundle.view', { bundleId: id, entityType: 'bundle', entityId: id });

    const docs = await db.select().from(documents).where(eq(documents.bundleId, id));
    const checks = await db.select().from(checkResults).where(eq(checkResults.bundleId, id));
    const parked = await db
      .select()
      .from(routerJobs)
      .where(and(eq(routerJobs.bundleId, id), eq(routerJobs.state, 'parked')));
    const people = await db
      .select({
        taxpayerId: taxpayers.id,
        displayName: taxpayers.displayName,
        tinLast4: taxpayers.tinLast4,
        role: bundleTaxpayers.role,
        proposed: bundleTaxpayers.proposed,
      })
      .from(bundleTaxpayers)
      .innerJoin(taxpayers, eq(taxpayers.id, bundleTaxpayers.taxpayerId))
      .where(eq(bundleTaxpayers.bundleId, id));

    return {
      bundle,
      documents: docs,
      checks,
      taxpayers: people,
      // The UI says "the Router is down" rather than "extraction failed" (§3).
      routerDown: parked.length > 0 || !isRouterReachable(),
      parkedJobs: parked.length,
      blocking: await blockingFailures(id),
    };
  });

  // ── identity confirmation gate (§7) ────────────────────────────────────────
  app.post('/api/bundles/:id/identity/confirm', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        taxYear: z.number().int(),
        taxpayers: z.array(z.object({ taxpayerId: z.string().uuid(), role: z.string() })),
      })
      .parse(req.body);

    await confirmIdentity(id, user.id, body.taxpayers, body.taxYear);
    await auditAccess(req, 'bundle.identity_confirmed', {
      bundleId: id,
      entityType: 'bundle',
      entityId: id,
      detail: { taxYear: body.taxYear, taxpayerCount: body.taxpayers.length },
    });

    const queued = await startExtraction(id, user.id);
    return { ok: true, pagesQueued: queued };
  });

  app.post('/api/bundles/:id/classify', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await pipelineQueue.add('classify_bundle', { kind: 'classify_bundle', bundleId: id, userId: user.id });
    return { ok: true };
  });

  // ── documents, fields, spans ───────────────────────────────────────────────
  app.get('/api/documents/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    if (!doc) return reply.code(404).send({ error: 'not found' });

    await auditAccess(req, 'document.view', {
      bundleId: doc.bundleId,
      entityType: 'document',
      entityId: id,
    });

    const resolved = await resolveDocumentFields(id);
    const docPages = await db.select().from(pages).where(eq(pages.documentId, id));
    const spans = docPages.length
      ? await db
          .select()
          .from(layoutSpans)
          .where(eq(layoutSpans.pageId, docPages[0]!.id))
      : [];

    return {
      document: doc,
      pages: docPages.map((p) => ({
        id: p.id,
        pageNumber: p.pageNumber,
        widthPx: p.widthPx,
        heightPx: p.heightPx,
        rasterAvailable: p.rasterStorageKey !== null,
      })),
      fields: [...resolved.fields.values()],
      spans,
    };
  });

  /** Page raster for the review overlay. Audited: this is a document image leaving the box. */
  app.get('/api/pages/:id/image', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const [page] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
    if (!page?.rasterStorageKey) {
      // A purged raster is a normal state, not an error — say so plainly (P13).
      return reply.code(410).send({
        error: 'raster_purged',
        message: 'This page image has passed its retention window and was purged.',
      });
    }

    await auditAccess(req, 'page.raster_view', {
      bundleId: page.bundleId,
      entityType: 'page',
      entityId: id,
    });

    const bytes = await blobs.get(page.rasterStorageKey);
    return reply.type('image/jpeg').header('Cache-Control', 'private, no-store').send(bytes);
  });

  app.post('/api/fields/:id/correct', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        cents: z.number().int().nullable().optional(),
        text: z.string().nullable().optional(),
        bool: z.boolean().nullable().optional(),
        setToNull: z.boolean().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);

    const [field] = await db.select().from(extractedFields).where(eq(extractedFields.id, id)).limit(1);
    if (!field) return reply.code(404).send({ error: 'not found' });
    const [doc] = await db.select().from(documents).where(eq(documents.id, field.documentId)).limit(1);

    const { correctionId, before } = await correctField(id, user.id, body, body.note);

    // Before and after, with user and timestamp (P11).
    await auditAccess(req, 'field.correct', {
      bundleId: doc?.bundleId,
      entityType: 'extracted_field',
      entityId: id,
      detail: {
        correctionId,
        fieldKey: field.fieldKey,
        before,
        after: body.setToNull ? null : { cents: body.cents, text: body.text, bool: body.bool },
        note: body.note,
      },
    });

    return { ok: true, correctionId };
  });

  // ── the gate ───────────────────────────────────────────────────────────────
  app.post('/api/checks/:id/disposition', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        kind: z.enum(['accepted_as_is', 'corrected', 'document_excluded']),
        note: z.string().min(1, 'a disposition must say why'),
      })
      .parse(req.body);

    const [check] = await db.select().from(checkResults).where(eq(checkResults.id, id)).limit(1);
    if (!check) return reply.code(404).send({ error: 'not found' });

    await db
      .insert(dispositions)
      .values({ checkResultId: id, kind: body.kind, note: body.note, dispositionedBy: user.id })
      .onConflictDoUpdate({
        target: dispositions.checkResultId,
        set: { kind: body.kind, note: body.note, dispositionedBy: user.id, updatedAt: new Date() },
      });

    await auditAccess(req, 'check.disposition', {
      bundleId: check.bundleId,
      entityType: 'check_result',
      entityId: id,
      detail: { checkKey: check.checkKey, kind: body.kind, note: body.note },
    });

    const remaining = await blockingFailures(check.bundleId);
    if (remaining.length === 0) {
      await db.update(bundles).set({ status: 'in_review' }).where(eq(bundles.id, check.bundleId));
    }
    return { ok: true, remainingBlocking: remaining.length };
  });

  // ── worksheet ──────────────────────────────────────────────────────────────
  app.get('/api/bundles/:id/worksheet/preview', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    // The live preview deliberately does NOT go through the gate — it is the reviewer's
    // working view, and it shows what is blocking rather than refusing to render.
    const { model, ctx } = await buildModelForBundle(id);
    return {
      model,
      documentLabels: Object.fromEntries(ctx.documentLabels),
      softAnnotations: ctx.softAnnotations,
      blocking: await blockingFailures(id),
    };
  });

  app.post('/api/bundles/:id/worksheet', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    try {
      const result = await generateWorksheet(id, { id: user.id, displayName: user.displayName });
      return { worksheetId: result.worksheetId, lines: result.model.lines.length };
    } catch (err) {
      if (err instanceof IdentityNotConfirmedError) {
        return reply.code(409).send({
          error: 'identity_not_confirmed',
          message:
            'Confirm which client this bundle belongs to before generating a worksheet. A ' +
            'worksheet is a statement about a named return.',
        });
      }
      if (err instanceof WorksheetBlockedError) {
        return reply.code(409).send({
          error: 'blocked',
          message: 'Hard reconciliation failures must be dispositioned before a worksheet is produced.',
          blocking: err.blocking,
        });
      }
      throw err;
    }
  });

  app.get('/api/worksheets/:id/:format', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id, format } = z
      .object({ id: z.string().uuid(), format: z.enum(['xlsx', 'pdf']) })
      .parse(req.params);

    const [worksheet] = await db.select().from(worksheets).where(eq(worksheets.id, id)).limit(1);
    if (!worksheet) return reply.code(404).send({ error: 'not found' });

    const key = format === 'xlsx' ? worksheet.xlsxStorageKey : worksheet.pdfStorageKey;
    if (!key) return reply.code(404).send({ error: 'artifact not generated' });

    await auditAccess(req, 'worksheet.download', {
      bundleId: worksheet.bundleId,
      entityType: 'worksheet',
      entityId: id,
      detail: { format },
    });

    const bytes = await blobs.get(key);
    const mime =
      format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf';
    return reply
      .type(mime)
      .header('Content-Disposition', `attachment; filename="worksheet-${id}.${format}"`)
      .header('Cache-Control', 'private, no-store')
      .send(bytes);
  });

}
