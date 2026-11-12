# Runbook: restore a D1 database

Use one procedure for every restore, Time Travel included. A restore rolls data back, so anything deleted after the restore point (accounts, consents) would come back unless the deletion ledger is replayed.

Inputs: the restore point (UTC timestamp), the database (`novus-main` or `novus-events`) and the environment. Rehearse on staging first.

## 1. Freeze

1. Set the flags `site.read_only = on` and `alerts.fanout = off` (console, or the internal flags route). Writes now return 503 with `Retry-After`; reminders stop being queued.
2. Note the current Time Travel bookmark so the restore itself can be undone:

   ```bash
   npx wrangler d1 time-travel info novus-main --config infra/wrangler/wrangler.toml --env production
   ```

## 2. Restore

Time Travel (any minute in the last 30 days):

```bash
npx wrangler d1 time-travel restore novus-main --timestamp=<UTC ISO timestamp> \
  --config infra/wrangler/wrangler.toml --env production
```

From the weekly encrypted export (older than 30 days, or after account loss):

```bash
# On the offline machine that holds the private key:
npx wrangler r2 object get novus-backups/full/<date>/novus-main.sql.nvbk1 --remote --file novus-main.sql.nvbk1
node --experimental-strip-types infra/scripts/backup-keys.ts decrypt \
  --key /offline/private.jwk.json --in novus-main.sql.nvbk1 --out novus-main.sql
# Import into a NEW database, verify it, then repoint the binding id and deploy.
npx wrangler d1 create novus-main-restore
npx wrangler d1 execute novus-main-restore --remote --file novus-main.sql
```

Delete the plaintext `.sql` file as soon as the import is verified.

## 3. Replay deletions

Replay every deletion ledger entry (`ledger/deletions/{yyyy-mm-dd}/*.json` in `novus-store`) requested at or after the restore point minus one hour. Entries hold internal ids only; replaying one is idempotent.

## 4. Reconcile notifications

`novus-events.email_send_ledger` is a separate database and is not rolled back. Mark every Notification as sent if the ledger shows it was sent after the restore point, so no student gets the same email twice.

## 5. Unfreeze and record

1. Run the smoke checks: home page, one program page, one ICS feed, sign-in code.
2. Set `alerts.fanout = on`, then `site.read_only = off`.
3. Write the postmortem: restore point, rows replayed, notifications reconciled, time to recover.

The quarterly drill deletes a test account 10 minutes after the chosen restore point and proves it stays deleted after this runbook.
