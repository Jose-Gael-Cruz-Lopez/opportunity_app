/** @jsxImportSource hono/jsx */
import { islandAssetPath } from "./assets";
import { MIN_AGE_YEARS } from "./remind-me-js";

/**
 * Program page "Remind me" (s01 F-08, plan 6.7.1): an email reminder without an account.
 *
 * Server-rendered and cache-safe: the markup is the same for every visitor (no cookie, no
 * personal data). Without JavaScript, the visitor sees the fallback (calendar file, sign in to
 * track); the form ships `hidden` and the island script shows and wires it. The script and the
 * stylesheet are linked from here, so the Program page only renders this component and sends
 * REMIND_PAGE_CSP (Turnstile's origin) instead of the base policy.
 *
 * Copy rules: no promise the server cannot keep. Reminders start only after the emailed link is
 * clicked; the birth month is used for the age screen and never stored; status- and
 * identity-defined programs ask for an explicit opt-in, and their emails leave the name out.
 */

export interface RemindMeIslandProps {
  readonly cycleId: string;
  readonly programSlug: string;
  /** `sensitive_audience` or a non-empty identity audience: the request needs `sensitiveOptIn`. */
  readonly restricted: boolean;
  /** Render time (epoch ms), for the birth-year list. */
  readonly now: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Birth years offered: from 10 years ago (so under-16s can answer truthfully) back 70 years. */
export function birthYears(now: number): number[] {
  const year = new Date(now).getUTCFullYear();
  return Array.from({ length: 71 }, (_, i) => year - 10 - i);
}

export function RemindMeIsland(props: RemindMeIslandProps) {
  const ids = { email: "rm-email", month: "rm-month", year: "rm-year", hint: "rm-birth-hint", heading: "remind-h" };
  return (
    <section class="section rm" id="remind" aria-labelledby={ids.heading} data-island="remind-me" data-cycle={props.cycleId} data-consent={props.restricted ? "1" : "0"}>
      <link rel="stylesheet" href={islandAssetPath("islands.css")} />
      <h2 id={ids.heading}>Remind me</h2>
      <p class="note">An email 2 days before each deadline, and one if a date changes. No account needed.</p>
      <p class="note rm-nojs" data-rm="nojs">
        Email reminders need JavaScript. You can{" "}
        <a class="linkish" href={`/cal/p/${props.programSlug}.ics`}>
          add the dates to your calendar
        </a>{" "}
        or{" "}
        <a class="linkish" href={`/app/programs/${props.programSlug}?track=1`}>
          sign in to track this program
        </a>
        .
      </p>
      <form class="rm-form" data-rm="form" method="post" action="/api/v1/remind-me" novalidate hidden>
        <div class="rm-field">
          <label for={ids.email}>Email</label>
          <input
            id={ids.email}
            class="rm-input"
            type="email"
            name="email"
            autocomplete="email"
            inputmode="email"
            autocapitalize="off"
            spellcheck={false}
            maxlength={320}
            required
          />
        </div>
        <fieldset class="rm-field" aria-describedby={ids.hint}>
          <legend>Birth month and year</legend>
          <p class="rm-hint" id={ids.hint}>
            Email reminders are for students {MIN_AGE_YEARS} and older. Novus uses this only for that check and doesn't keep it.
          </p>
          <div class="rm-row">
            <select id={ids.month} class="rm-select" name="month" aria-label="Birth month" required>
              <option value="">Month</option>
              {MONTHS.map((m, i) => (
                <option value={String(i + 1)}>{m}</option>
              ))}
            </select>
            <select id={ids.year} class="rm-select" name="year" aria-label="Birth year" required>
              <option value="">Year</option>
              {birthYears(props.now).map((y) => (
                <option value={String(y)}>{y}</option>
              ))}
            </select>
          </div>
        </fieldset>
        {props.restricted ? (
          <label class="rm-check">
            <input type="checkbox" name="optIn" data-rm="optin" />
            <span>
              Save this reminder for my address. This program is for students with a particular status or identity, so Novus asks first.
              Emails won't name the program.
            </span>
          </label>
        ) : null}
        <div class="rm-ts" data-rm="turnstile" />
        <button class="pill solid rm-submit" type="submit" data-rm="submit">
          Email me reminders
        </button>
        <p class="rm-status" data-rm="status" role="status" aria-live="polite" />
        <p class="note rm-fine">
          We send one email to confirm. Nothing starts until you click its link, and every email has a one-click unsubscribe.
        </p>
      </form>
      <div class="callout rm-done" data-rm="done" tabindex={-1} hidden>
        <strong>Check your inbox.</strong> We sent a link to confirm. Reminders start only after you click it. If nothing arrives in a few
        minutes, check your spam folder.
      </div>
      <script src={islandAssetPath("remind-me.js")} defer />
    </section>
  );
}
