/**
 * Advisor workspace (/app/advisor): program lists students can follow, campus deadlines sent for
 * Curator confirmation, aggregate progress for the listed programs and monthly reports, with CSV
 * exports. The screen never names or counts an individual student: every number comes from the
 * server already banded, and groups under 5 are withheld (plan 10.4.2, 9.6).
 *
 * Forms, tables and reports sit on solid surfaces (`data-solid-surfaces`), as the design direction
 * for workspace consoles asks; glass stays on the app's navigation chrome.
 */
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { ProgramList } from "@shared/contracts/advisor";
import { describeApiError } from "@/lib/api";
import { ErrorBanner, Glass, Icon, LookToggle, NvPage, SampleBanner, Skeleton, StatTile } from "@/components/readiness/primitives";
import {
  exportUrls,
  useCampus,
  useCreateList,
  useDeleteList,
  useLists,
  useProgress,
  useReport,
  useSubmitCampusDeadline,
  useUpdateList,
  useWorkspaces,
} from "./data";
import {
  CAMPUS_KINDS,
  STAGE_LABELS,
  campusBody,
  campusFormErrors,
  emptyCampusForm,
  parseSlugs,
  periodOptions,
  shareUrl,
  suppressionText,
  tableRows,
  type CampusForm,
  type ReleasedTableView,
} from "./model";

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
}

function todayIn(timeZone: string, now = Date.now()): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function origin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

// ---------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------

function Section({ title, part, children, labelId }: { title: string; part?: string; children: ReactNode; labelId: string }) {
  return (
    <Glass className="nv-panel" aria-labelledby={labelId} style={{ gap: 14 }}>
      <div className="nv-panel-head">
        <h2 id={labelId} className="nv-h2">
          {title}
        </h2>
        {part ? <span className="nv-label nv-part">{part}</span> : null}
      </div>
      {children}
    </Glass>
  );
}

function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
      <label htmlFor={htmlFor} className="nv-label">
        {label}
      </label>
      {children}
      {hint && !error ? <span className="nv-meta">{hint}</span> : null}
      {error ? (
        <span className="nv-meta" role="alert" style={{ color: "var(--nv-bad)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A disclosure-controlled table: rows with banded values, or the reason it is withheld. */
function ReleasedTable({ table, names, caption, minGroup }: { table: ReleasedTableView; names: Record<string, string>; caption: string; minGroup: number }) {
  if (table.suppressed) {
    return (
      <p className="nv-body" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <Icon name="lock" />
        <span>
          <strong>{caption}:</strong> {suppressionText(table.reason, minGroup)}
        </span>
      </p>
    );
  }
  const rows = tableRows(table, names);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
      <caption className="nv-label" style={{ textAlign: "left", paddingBottom: 6 }}>
        {caption} · total {table.total}
      </caption>
      <thead className="nv-sr">
        <tr>
          <th scope="col">Group</th>
          <th scope="col">Students</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} style={{ borderTop: "1px solid var(--nv-line)" }}>
            <th scope="row" style={{ textAlign: "left", fontWeight: 500, padding: "8px 0" }}>
              {r.label}
            </th>
            <td style={{ textAlign: "right", padding: "8px 0", color: r.protectedValue ? "var(--nv-ink-2)" : undefined }}>
              {r.value}
              {r.protectedValue ? <span className="nv-sr"> (hidden to protect small groups)</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

function ListRow({ list, workspaceId, onNotice }: { list: ProgramList; workspaceId: string; onNotice: (text: string) => void }) {
  const editId = useId();
  const [editing, setEditing] = useState(false);
  const [slugs, setSlugs] = useState(list.items.map((i) => i.programSlug).join("\n"));
  const update = useUpdateList(workspaceId);
  const remove = useDeleteList(workspaceId);
  const link = shareUrl(list, origin());

  const save = (e: FormEvent) => {
    e.preventDefault();
    const notes = new Map(list.items.map((i) => [i.programSlug, i]));
    const items = parseSlugs(slugs).map((programSlug) => ({ programSlug, cycleKey: notes.get(programSlug)?.cycleKey ?? null, note: notes.get(programSlug)?.note ?? null }));
    update.mutate(
      { listId: list.id, patch: { items } },
      {
        onSuccess: () => {
          setEditing(false);
          onNotice(`Saved ${list.title}.`);
        },
        onError: (err) => onNotice(describeApiError(err)),
      },
    );
  };

  return (
    <li className="nv-row" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 18 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 16 }}>{list.title}</strong>
        <span className="nv-tag" data-ghost="">
          {list.visibility === "public" ? "Public" : "Unlisted"}
        </span>
        {list.restricted ? (
          <span className="nv-tag" data-ghost="" title="Includes a program for a specific identity or status. Views count by day only.">
            Restricted
          </span>
        ) : null}
        <span className="nv-meta">
          {list.items.length} {list.items.length === 1 ? "program" : "programs"}
        </span>
      </div>
      {list.description ? <p className="nv-body">{list.description}</p> : null}
      {list.items.length > 0 ? (
        <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
          {list.items.map((i) => (
            <li key={i.programSlug} className="nv-body">
              <a href={`/programs/${i.programSlug}`}>{i.programSlug}</a>
              {i.note ? <span className="nv-meta"> · {i.note}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {link ? (
          <button
            type="button"
            className="nv-mini"
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(
                () => onNotice("Share link copied."),
                () => onNotice(`Share link: ${link}`),
              );
            }}
          >
            <Icon name="out" /> Copy student link
          </button>
        ) : null}
        <a className="nv-mini" href={exportUrls(workspaceId).list(list.id)} download>
          <Icon name="doc" /> CSV
        </a>
        <button type="button" className="nv-mini" aria-expanded={editing} aria-controls={editId} onClick={() => setEditing((v) => !v)}>
          Edit programs
        </button>
        <button
          type="button"
          className="nv-mini"
          aria-label={`Delete ${list.title}`}
          onClick={() => {
            if (typeof window !== "undefined" && !window.confirm(`Delete "${list.title}"? Students with the link will no longer see it.`)) return;
            remove.mutate(list.id, { onSuccess: () => onNotice(`Deleted ${list.title}.`), onError: (err) => onNotice(describeApiError(err)) });
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
      {editing ? (
        <form id={editId} onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Field label="Program slugs, one per line" htmlFor={`${editId}-slugs`} hint="The last part of a program's address, such as sample-early-insight-week.">
            <textarea id={`${editId}-slugs`} className="nv-input" rows={4} value={slugs} onChange={(e) => setSlugs(e.currentTarget.value)} style={{ padding: 10 }} />
          </Field>
          <div>
            <button type="submit" className="nv-btn-go" disabled={update.isPending}>
              {update.isPending ? "Saving" : "Save list"}
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

function CreateListForm({ workspaceId, onNotice }: { workspaceId: string; onNotice: (text: string) => void }) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "unlisted">("unlisted");
  const [slugs, setSlugs] = useState("");
  const [error, setError] = useState<string | undefined>();
  const create = useCreateList(workspaceId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError("Give the list a title.");
    setError(undefined);
    create.mutate(
      { title: title.trim(), description: description.trim() || null, visibility, items: parseSlugs(slugs).map((programSlug) => ({ programSlug, cycleKey: null, note: null })) },
      {
        onSuccess: (list) => {
          setTitle("");
          setDescription("");
          setSlugs("");
          onNotice(`Created ${list.title}.`);
        },
        onError: (err) => setError(describeApiError(err)),
      },
    );
  };

  return (
    <details>
      <summary className="nv-btn" style={{ display: "inline-flex", cursor: "pointer" }}>
        <Icon name="plus" /> New list
      </summary>
      <form onSubmit={submit} style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <Field label="Title" htmlFor={`${id}-title`} error={error}>
          <input id={`${id}-title`} className="nv-input" maxLength={120} value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        </Field>
        <Field label="Description (optional)" htmlFor={`${id}-desc`}>
          <input id={`${id}-desc`} className="nv-input" maxLength={1000} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        </Field>
        <Field label="Who can open it" htmlFor={`${id}-vis`} hint={visibility === "public" ? "Anyone, and search engines, can find a public list." : "Only people with the link can open an unlisted list."}>
          <select id={`${id}-vis`} className="nv-select" value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as "public" | "unlisted")}>
            <option value="unlisted">Unlisted (link only)</option>
            <option value="public">Public</option>
          </select>
        </Field>
        <Field label="Program slugs, one per line" htmlFor={`${id}-slugs`}>
          <textarea id={`${id}-slugs`} className="nv-input" rows={4} value={slugs} onChange={(e) => setSlugs(e.currentTarget.value)} style={{ padding: 10 }} />
        </Field>
        <div>
          <button type="submit" className="nv-btn-go" disabled={create.isPending}>
            {create.isPending ? "Creating" : "Create list"}
          </button>
        </div>
      </form>
    </details>
  );
}

// ---------------------------------------------------------------------------------------------
// Campus deadlines
// ---------------------------------------------------------------------------------------------

function CampusPanel({ workspaceId, programs, onNotice }: { workspaceId: string; programs: readonly { slug: string; cycleKey: string | null }[]; onNotice: (text: string) => void }) {
  const id = useId();
  const labelId = useId();
  const campus = useCampus(workspaceId);
  const submit = useSubmitCampusDeadline(workspaceId);
  const zone = useMemo(browserZone, []);
  const [form, setForm] = useState<CampusForm>(() => emptyCampusForm(zone));
  const [touched, setTouched] = useState(false);
  const errors = campusFormErrors(form, todayIn(form.timeZone));
  const set = <K extends keyof CampusForm>(key: K, value: CampusForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const send = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    submit.mutate(campusBody(form), {
      onSuccess: () => {
        setForm(emptyCampusForm(zone));
        setTouched(false);
        onNotice("Sent. A Curator confirms campus deadlines with your office before students see them.");
      },
      onError: (err) => onNotice(describeApiError(err)),
    });
  };
  const err = (k: keyof CampusForm) => (touched ? errors[k] : undefined);
  const view = campus.data?.data;

  return (
    <Section title="Campus deadlines" part="Curator-confirmed" labelId={labelId}>
      <p className="nv-body">
        Campus nomination dates usually come weeks before national ones. Send one here; a Curator confirms it through your office's published contact, and only then do your
        institution's students see "Confirmed by your campus".
      </p>
      {campus.isLoading ? <Skeleton height={80} label="Loading campus deadlines" /> : null}
      {view ? (
        <>
          {!view.institutionLinked ? (
            <p className="nv-banner" role="note">
              <Icon name="info" /> This workspace is not linked to an institution yet, so campus deadlines cannot be added. Ask the Novus team to link it.
            </p>
          ) : null}
          <p className="nv-meta">
            {view.pending === 0 ? "Nothing waiting for review." : `${view.pending} ${view.pending === 1 ? "submission is" : "submissions are"} waiting for a Curator.`}
          </p>
          {view.approved.length > 0 ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {view.approved.map((d) => (
                <li key={`${d.programSlug}-${d.cycleKey}-${d.kind}`} className="nv-body">
                  <strong>{d.programName}</strong> · {d.localDate ?? "date to be set"}
                  {d.localTime ? ` ${d.localTime}` : ""} {d.timeZone ?? ""} <span className="nv-meta">· confirmed {d.confirmedOn}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {view?.institutionLinked !== false ? (
        <form onSubmit={send} noValidate style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <Field label="Program" htmlFor={`${id}-p`} error={err("programSlug")}>
            <select
              id={`${id}-p`}
              className="nv-select"
              value={form.programSlug}
              onChange={(e) => {
                const slug = e.currentTarget.value;
                const cycle = programs.find((p) => p.slug === slug)?.cycleKey;
                setForm((f) => ({ ...f, programSlug: slug, cycleKey: cycle ?? f.cycleKey }));
              }}
            >
              <option value="">Choose a listed program</option>
              {programs.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.slug}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cycle" htmlFor={`${id}-c`} error={err("cycleKey")} hint="Such as summer-2027">
            <input id={`${id}-c`} className="nv-input" value={form.cycleKey} onChange={(e) => set("cycleKey", e.currentTarget.value.trim())} />
          </Field>
          <Field label="Kind" htmlFor={`${id}-k`}>
            <select id={`${id}-k`} className="nv-select" value={form.kind} onChange={(e) => set("kind", e.currentTarget.value as CampusForm["kind"])}>
              {CAMPUS_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date" htmlFor={`${id}-d`} error={err("localDate")}>
            <input id={`${id}-d`} type="date" className="nv-input" value={form.localDate} onChange={(e) => set("localDate", e.currentTarget.value)} />
          </Field>
          <Field label="Time (optional)" htmlFor={`${id}-t`} error={err("localTime")}>
            <input id={`${id}-t`} type="time" className="nv-input" value={form.localTime} onChange={(e) => set("localTime", e.currentTarget.value)} />
          </Field>
          <Field label="Time zone" htmlFor={`${id}-z`}>
            <input id={`${id}-z`} className="nv-input" value={form.timeZone} onChange={(e) => set("timeZone", e.currentTarget.value.trim())} />
          </Field>
          <Field label="Office page (optional)" htmlFor={`${id}-u`} error={err("sourceUrl")}>
            <input id={`${id}-u`} type="url" className="nv-input" placeholder="https://" value={form.sourceUrl} onChange={(e) => set("sourceUrl", e.currentTarget.value.trim())} />
          </Field>
          <Field label="Note for the Curator (optional)" htmlFor={`${id}-n`} error={err("note")}>
            <input id={`${id}-n`} className="nv-input" maxLength={500} value={form.note} onChange={(e) => set("note", e.currentTarget.value)} />
          </Field>
          <div style={{ alignSelf: "end" }}>
            <button type="submit" className="nv-btn-go" disabled={submit.isPending}>
              {submit.isPending ? "Sending" : "Send for confirmation"}
            </button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Progress and reports
// ---------------------------------------------------------------------------------------------

function ProgressPanel({ workspaceId, period }: { workspaceId: string; period: string }) {
  const labelId = useId();
  const progress = useProgress(workspaceId, period);
  const view = progress.data?.data;
  const names = useMemo(() => Object.fromEntries((view?.programs ?? []).map((p) => [p.slug, p.name])), [view]);

  return (
    <Section title="Progress on your lists" part="Counts only" labelId={labelId}>
      <p className="nv-body">
        How many Novus students saved, started or submitted the programs on your lists. No student is named. Groups smaller than {view?.minGroupSize ?? 5} are hidden, and one more
        number is hidden when a small one could be worked out from the total.
      </p>
      {progress.isLoading ? <Skeleton height={140} label="Loading progress" /> : null}
      {progress.isError ? <ErrorBanner title="Progress could not load." detail={describeApiError(progress.error)} onRetry={() => void progress.refetch()} /> : null}
      {view ? (
        <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <ReleasedTable table={view.byProgram} names={names} caption="By program" minGroup={view.minGroupSize} />
          <ReleasedTable table={view.byStage} names={STAGE_LABELS} caption="By stage" minGroup={view.minGroupSize} />
        </div>
      ) : null}
      {view && view.excluded.length > 0 ? (
        <p className="nv-meta">
          Not counted: {view.excluded.map((p) => p.name).join(", ")}. Programs for a specific identity or status are never counted for advisors.
        </p>
      ) : null}
    </Section>
  );
}

function ReportPanel({ workspaceId, now }: { workspaceId: string; now: number }) {
  const labelId = useId();
  const selectId = useId();
  const options = useMemo(() => periodOptions(now), [now]);
  const [period, setPeriod] = useState(options[0]?.value ?? "");
  const report = useReport(workspaceId, period);
  const r = report.data?.data;

  return (
    <Section title="Monthly report" part="Banded counts" labelId={labelId}>
      <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
        <Field label="Period" htmlFor={selectId}>
          <select id={selectId} className="nv-select" value={period} onChange={(e) => setPeriod(e.currentTarget.value)} style={{ minWidth: 200 }}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <a className="nv-btn" href={exportUrls(workspaceId).report(period)} download>
          <Icon name="doc" /> Download CSV
        </a>
      </div>
      {report.isLoading ? <Skeleton height={100} label="Loading report" /> : null}
      {report.isError ? <ErrorBanner title="The report could not load." detail={describeApiError(report.error)} onRetry={() => void report.refetch()} /> : null}
      {r ? (
        <>
          <div className="grid grid-cols-2 gap-2" style={{ maxWidth: 520 }}>
            <StatTile label="List page views" value={r.listViews} spoken={`List page views: ${r.listViews}`} />
            <StatTile label="Trackers on listed programs" value={r.trackedPrograms} spoken={`Trackers on listed programs: ${r.trackedPrograms}`} />
          </div>
          {r.rows.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <caption className="nv-label" style={{ textAlign: "left", paddingBottom: 6 }}>
                Trackers by program (all Novus students)
              </caption>
              <tbody>
                {r.rows.map((row) => (
                  <tr key={row.programSlug} style={{ borderTop: "1px solid var(--nv-line)" }}>
                    <th scope="row" style={{ textAlign: "left", fontWeight: 500, padding: "8px 0" }}>
                      {row.programSlug}
                    </th>
                    <td style={{ textAlign: "right" }}>{row.trackers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="nv-meta">Add programs to a list to see them here.</p>
          )}
        </>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

export default function AdvisorPage() {
  const headingId = useId();
  const listsLabel = useId();
  const [now] = useState(() => Date.now());
  const [notice, setNotice] = useState("");
  const workspaces = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const items = workspaces.data?.data ?? [];

  useEffect(() => {
    if (!workspaceId && items[0]) setWorkspaceId(items[0].id);
  }, [items, workspaceId]);

  const workspace = items.find((w) => w.id === workspaceId) ?? null;
  const lists = useLists(workspaceId);
  const listed = useMemo(() => {
    const seen = new Map<string, string | null>();
    for (const l of lists.data?.data ?? []) for (const i of l.items) if (!seen.has(i.programSlug)) seen.set(i.programSlug, i.cycleKey);
    return [...seen].map(([slug, cycleKey]) => ({ slug, cycleKey }));
  }, [lists.data]);

  const status = (workspaces.error as { status?: number } | null)?.status;
  const sample = workspaces.data?.source === "sample" || workspace?.isSample === true;

  return (
    <div data-solid-surfaces="">
      <NvPage labelledBy={headingId}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
          <div>
            <h1 id={headingId} className="nv-h1">
              Advisor workspace
            </h1>
            <p className="nv-meta" style={{ marginTop: 6 }}>
              Lists your students can follow, campus deadlines and counts that never name a student.
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {items.length > 1 ? (
              <select className="nv-select" aria-label="Workspace" value={workspaceId ?? ""} onChange={(e) => setWorkspaceId(e.currentTarget.value)} style={{ minWidth: 220 }}>
                {items.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            ) : workspace ? (
              <span className="nv-tag" data-ghost="">
                {workspace.name}
              </span>
            ) : null}
            <LookToggle />
          </div>
        </div>

        <SampleBanner show={sample} />

        {workspaces.isLoading ? <Skeleton height={300} label="Loading your workspace" /> : null}
        {status === 401 ? <ErrorBanner title="Sign in to open your advisor workspace." /> : null}
        {status === 403 ? (
          <ErrorBanner title="This account is not an advisor account." detail="Advisor access is set up by the Novus team after they confirm your office through its published contact." />
        ) : null}
        {workspaces.isError && status !== 401 && status !== 403 ? (
          <ErrorBanner title="Your workspace could not load." detail={describeApiError(workspaces.error)} onRetry={() => void workspaces.refetch()} />
        ) : null}
        {workspaces.data && items.length === 0 ? (
          <Glass className="nv-panel">
            <h2 className="nv-h2">No workspace yet</h2>
            <p className="nv-body">The Novus team creates pilot workspaces. Once yours is set up, it appears here.</p>
          </Glass>
        ) : null}

        {workspaceId ? (
          <div style={{ display: "grid", gap: 16 }}>
            <Section title="Program lists" part="Students follow these" labelId={listsLabel}>
              {lists.isLoading ? <Skeleton height={120} label="Loading lists" /> : null}
              {lists.isError ? <ErrorBanner title="Lists could not load." detail={describeApiError(lists.error)} onRetry={() => void lists.refetch()} /> : null}
              {lists.data ? (
                lists.data.data.length === 0 ? (
                  <p className="nv-body">No lists yet. Create one and share its link with your students.</p>
                ) : (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                    {lists.data.data.map((l) => (
                      <ListRow key={l.id} list={l} workspaceId={workspaceId} onNotice={setNotice} />
                    ))}
                  </ul>
                )
              ) : null}
              <CreateListForm workspaceId={workspaceId} onNotice={setNotice} />
            </Section>

            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))" }}>
              <ProgressPanel workspaceId={workspaceId} period={periodOptions(now)[0]?.value ?? ""} />
              <ReportPanel workspaceId={workspaceId} now={now} />
            </div>

            <CampusPanel workspaceId={workspaceId} programs={listed} onNotice={setNotice} />
          </div>
        ) : null}

        {notice ? (
          <p className="nv-meta" style={{ marginTop: 12 }}>
            {notice}
          </p>
        ) : null}
        <p className="nv-sr" role="status" aria-live="polite">
          {notice}
        </p>
      </NvPage>
    </div>
  );
}
