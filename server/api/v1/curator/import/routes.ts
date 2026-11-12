import { Hono, type Context } from "hono";
import { decide } from "@server/auth";
import type { AppEnv } from "@server/env";
import { problemFor } from "@server/lib/problem";
import { actorFor } from "../audit";
import { consoleSurface, curatorOf, requireCuratorIdentity, requireCuratorRole } from "../guard";
import type { CuratorDeps } from "../ports";
import { runImport } from "./service";

/**
 * POST /api/v1/curator/import  (mounted under /api/v1; not in the route map yet)
 *
 * Uploads one candidates file (JSON or CSV) and creates unverified draft Programs with
 * ReviewTasks. Nothing is published: a draft stays `is_published = 0` until a Curator publishes
 * it. Accepts either
 *
 *   - multipart/form-data with a `file` field (and optional `dryRun`, `sample` fields), or
 *   - the file itself as the body, `Content-Type: application/json` or `text/csv`, with
 *     `?dryRun=1`, `?sample=1` and `?filename=` in the query.
 *
 * `dryRun` returns the full report without writing. `sample` marks every row `is_sample = 1`
 * (invented development data) and is refused in production.
 *
 * Access is the Curator console's: requireRole("curator", "admin") with TOTP, the `curate.`
 * surface in staging and production, an active Curator handle (it signs the audit rows and the
 * task payload), and the matrix row `review_tasks.work`.
 *
 * One upload holds at most MAX_ROUTE_ROWS rows: each created row is one D1 batch of about eight
 * statements, and a Worker invocation may run 1000 D1 queries. Bigger files go through the CLI
 * locally, or are split.
 */

export const MAX_ROUTE_ROWS = 100;
/**
 * Upload size for the route (the CLI takes up to 2 MB). Note: the app-wide /api/v1 body limit
 * (API_BODY_LIMIT_BYTES, 128 KB) applies first until the integration pass gives this path its own
 * limit; see docs/registry-import.md "Registration".
 */
export const ROUTE_MAX_BYTES = 512 * 1024;
const TOO_LARGE = "The file is larger than 512 KB (about 100 candidates). Split it.";
export const IMPORT_PATH = "/curator/import";

type Ctx = Context<AppEnv>;

const truthy = (v: unknown) => typeof v === "string" && ["1", "true", "yes", "on"].includes(v.toLowerCase());

async function readUpload(c: Ctx): Promise<{ ok: true; text: string; hint: string | null; dryRun: boolean; sample: boolean } | { ok: false; res: Response }> {
  const declared = Number(c.req.header("content-length") ?? "0");
  // Multipart framing adds a little; allow 64 KB over the file limit.
  if (Number.isFinite(declared) && declared > ROUTE_MAX_BYTES + 64 * 1024) return { ok: false, res: problemFor(c, "payload_too_large", { detail: TOO_LARGE }) };
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  const q = new URL(c.req.url).searchParams;
  if (type.startsWith("multipart/form-data")) {
    let body: Record<string, string | File | (string | File)[]>;
    try {
      body = await c.req.parseBody({ all: false });
    } catch {
      return { ok: false, res: problemFor(c, "bad_request", { detail: "The form could not be read." }) };
    }
    const file = body.file;
    if (!(file instanceof File)) return { ok: false, res: problemFor(c, "validation_failed", { errors: [{ path: "file", message: "Attach the candidates file in a `file` field" }] }) };
    if (file.size > ROUTE_MAX_BYTES) return { ok: false, res: problemFor(c, "payload_too_large", { detail: TOO_LARGE }) };
    return { ok: true, text: await file.text(), hint: file.name || file.type || null, dryRun: truthy(body.dryRun) || truthy(q.get("dryRun")), sample: truthy(body.sample) || truthy(q.get("sample")) };
  }
  if (!type.includes("json") && !type.includes("csv") && !type.startsWith("text/plain")) {
    return { ok: false, res: problemFor(c, "bad_request", { detail: "Send multipart/form-data with a `file` field, or the file as application/json or text/csv." }) };
  }
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > ROUTE_MAX_BYTES) return { ok: false, res: problemFor(c, "payload_too_large", { detail: TOO_LARGE }) };
  return { ok: true, text, hint: q.get("filename") ?? type, dryRun: truthy(q.get("dryRun")), sample: truthy(q.get("sample")) };
}

export function createCuratorImportRoutes(deps: CuratorDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post(IMPORT_PATH, requireCuratorRole, consoleSurface(deps), requireCuratorIdentity(deps), async (c) => {
    if (!decide(deps.user(c), "review_tasks.work").allowed) return problemFor(c, "forbidden");
    const upload = await readUpload(c);
    if (!upload.ok) return upload.res;
    if (upload.sample && deps.environment(c) === "production") {
      return problemFor(c, "validation_failed", { errors: [{ path: "sample", message: "Sample imports are not allowed in production" }] });
    }
    const who = curatorOf(c);
    const result = await runImport(deps.db(c), upload.text, {
      hint: upload.hint,
      maxRows: MAX_ROUTE_ROWS,
      actor: actorFor(who.handle, who.isAdmin),
      now: deps.now(),
      dryRun: upload.dryRun,
      sample: upload.sample,
    });
    if (!result.ok) return problemFor(c, "validation_failed", { detail: result.error });
    const { summary } = result.report;
    // Counts only: no program names, URLs or file content in logs.
    deps.log("info", "curator.import", {
      batchId: result.report.batchId,
      dryRun: upload.dryRun,
      format: result.report.format,
      rows: summary.rows,
      created: summary.created,
      duplicates: summary.duplicates,
      alreadyImported: summary.alreadyImported,
      invalid: summary.invalid,
      rejected: summary.rejected,
      failed: summary.failed,
      reviewTasks: summary.reviewTasks,
    });
    return c.json(result.report, 200, { "cache-control": "no-store" });
  });

  return app;
}
