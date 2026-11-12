/**
 * novus-backup: a Worker with NO routes. Its only job is the weekly encrypted D1 export.
 *
 * Why a separate Worker: a D1 export needs an API token with D1 Write permission, which could run
 * any SQL on every database in the account. Keeping that token here, in a Worker nobody can reach
 * over HTTP, keeps it away from the app Worker and from every pipeline key.
 *
 * Cron (Sunday 08:00 UTC) -> Workflow instance `backup-YYYY-MM-DD` (the id makes reruns no-ops)
 *   for each database: start export -> poll until complete -> stream the dump through
 *   AES-256-GCM (infra/backup/crypto.ts) -> multipart upload to R2 `full/{date}/{name}.sql.nvbk1`.
 * Only ciphertext reaches R2. The private key never touches Cloudflare.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { encryptStream, importWrappingKey, streamToIterable } from "./crypto";
import { backupKey, fixedParts, parseDatabases, PART_SIZE, type DatabaseRef } from "./worker-helpers";

export interface BackupEnv {
  BACKUPS: R2Bucket;
  BACKUP_WORKFLOW: Workflow<BackupParams>;
  /** Cloudflare account id (not secret). */
  CF_ACCOUNT_ID: string;
  /** JSON array of { name, id } for the databases to export (not secret). */
  BACKUP_DATABASES: string;
  /** RSA-OAEP-3072 public key as a JWK JSON string (public by design). */
  BACKUP_PUBLIC_KEY_JWK: string;
  BACKUP_KEY_ID: string;
  /** Secret: API token with D1 export permission, expiring, rotated quarterly. */
  D1_EXPORT_TOKEN: string;
}

export interface BackupParams {
  date: string;
}

interface ExportPoll {
  status: "active" | "complete" | "error";
  bookmark: string | null;
  signedUrl: string | null;
  error: string | null;
}

const MAX_POLLS = 60;

async function pollExport(env: BackupEnv, db: DatabaseRef, bookmark: string | null): Promise<ExportPoll> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${db.id}/export`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.D1_EXPORT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(bookmark ? { output_format: "polling", current_bookmark: bookmark } : { output_format: "polling" }),
  });
  const body = (await res.json()) as {
    success?: boolean;
    result?: { status?: string; at_bookmark?: string; result?: { signed_url?: string }; error?: string };
  };
  if (!res.ok || !body.success || !body.result) {
    // Never echo the response body: it could quote the request, including headers.
    throw new Error(`d1 export request failed with HTTP ${res.status}`);
  }
  const r = body.result;
  const status = r.status === "complete" || r.status === "error" ? r.status : "active";
  return {
    status,
    bookmark: r.at_bookmark ?? bookmark,
    signedUrl: r.result?.signed_url ?? null,
    error: r.error ?? null,
  };
}

async function encryptAndStore(env: BackupEnv, key: string, signedUrl: string): Promise<number> {
  const dump = await fetch(signedUrl);
  if (!dump.ok || !dump.body) throw new Error(`export download failed with HTTP ${dump.status}`);
  const wrappingKey = await importWrappingKey(JSON.parse(env.BACKUP_PUBLIC_KEY_JWK) as JsonWebKey);
  const upload = await env.BACKUPS.createMultipartUpload(key, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { format: "nvbk1", keyId: env.BACKUP_KEY_ID },
  });
  try {
    const parts: R2UploadedPart[] = [];
    let bytes = 0;
    const frames = encryptStream(streamToIterable(dump.body), wrappingKey, env.BACKUP_KEY_ID);
    for await (const part of fixedParts(frames, PART_SIZE)) {
      parts.push(await upload.uploadPart(parts.length + 1, part));
      bytes += part.length;
    }
    await upload.complete(parts);
    return bytes;
  } catch (err) {
    await upload.abort();
    throw err;
  }
}

export class BackupWorkflow extends WorkflowEntrypoint<BackupEnv, BackupParams> {
  async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep): Promise<Record<string, number>> {
    const { date } = event.payload;
    const written: Record<string, number> = {};
    for (const db of parseDatabases(this.env.BACKUP_DATABASES)) {
      const key = backupKey(date, db.name);
      // A retried instance skips databases whose ciphertext is already stored.
      const exists = await step.do(`exists ${db.name}`, async () => (await this.env.BACKUPS.head(key)) !== null);
      if (exists) continue;

      let poll = await step.do(`start ${db.name}`, () => pollExport(this.env, db, null));
      for (let i = 0; poll.status === "active" && i < MAX_POLLS; i++) {
        await step.sleep(`wait ${db.name} ${i}`, "10 seconds");
        const bookmark = poll.bookmark;
        poll = await step.do(`poll ${db.name} ${i}`, () => pollExport(this.env, db, bookmark));
      }
      if (poll.status !== "complete" || !poll.signedUrl) {
        throw new Error(`export of ${db.name} did not complete (${poll.status})`);
      }
      const signedUrl = poll.signedUrl;
      written[db.name] = await step.do(
        `store ${db.name}`,
        { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
        () => encryptAndStore(this.env, key, signedUrl),
      );
    }
    return written;
  }
}

export default {
  async scheduled(controller: ScheduledController, env: BackupEnv): Promise<void> {
    const date = new Date(controller.scheduledTime).toISOString().slice(0, 10);
    try {
      await env.BACKUP_WORKFLOW.create({ id: `backup-${date}`, params: { date } });
    } catch (err) {
      // A duplicate cron delivery finds the instance already created; that is the idempotency we want.
      if (!String(err).includes("already")) throw err;
    }
  },
  // No routes are configured; answer anything that still arrives with 404.
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<BackupEnv>;
