# client/src/console/metrics

The founders' metrics page in the Curator console (admin only; the server checks). It reads
`GET /api/v1/admin/metrics` (see `server/api/v1/admin/metrics/README.md` for every definition
and the small-cell rule) and shows four sections: activation funnel, retention by week, Tracker
and reminders, registry freshness.

- `api.ts`: typed client and the wire shapes (mirrors of the server schema; `metrics.test.ts`
  parses `fixtures.ts` with the server's zod schema so they cannot drift).
- `model.ts`: pure formatting. A hidden count reads "fewer than 5" with an icon, never a number.
- `MetricsPage.tsx`: `MetricsPage` (loads, handles auth errors like the other console pages) and
  `MetricsView` (pure, rendered in tests).
- `metrics.css`: solid surfaces, one accent for magnitude, tables for every chart.

`ConsoleApp.tsx` routes `/curate/metrics` to `MetricsPage` and shows the Metrics nav link to
viewers whose queue response says `admin` (and while the page is open). An admin without a
Curator handle gets 403 from the queue, so the link stays hidden for them; the URL still works and
the server's own `requireRole("admin")` decides.
