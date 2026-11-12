/**
 * The Remind me island script (served as a hashed file; public pages allow no inline script).
 *
 * The form ships `hidden` with a no-JavaScript fallback beside it (calendar file, sign in), so
 * the page is complete without this file. With it:
 * 1. the form is shown; Turnstile's script loads only when the visitor first focuses the form
 *    (`GET /api/v1/turnstile?action=remind-me` says whether it is on and gives the site key);
 * 2. the age screen runs on the device first: under 16, nothing is sent at all and the typed
 *    address is cleared (the server repeats the check and stores nothing for under-16s);
 * 3. `POST /api/v1/remind-me` with the address, the cycle id, the token, the birth month and,
 *    for status- or identity-defined programs, the explicit opt-in. Every answer that is not
 *    202 resets the widget, because a token works once.
 * 4. one content-free `remind_me_submit` event (outcome code only) is sent alone, without a
 *    session id or cookies, only when the birth month says 18 or older and the browser does not
 *    send Global Privacy Control. Under 16 sends nothing; 16-17 is minor mode, where analytics
 *    need consent this page cannot ask for, so no event either (plan 9.10.2, 10 "minors").
 *    `under_age` is never an event outcome, and the server's allowlist refuses it. A crash in
 *    this script sends one content-free error report.
 *
 * Nothing is written to cookies or Web Storage. The birth month is never sent anywhere but the
 * Remind me request, and is never stored by the server (it keeps only minor mode, 16-17).
 *
 * REMIND_CORE_JS holds the pure helpers as one object expression so tests can evaluate it in
 * Node without a DOM; REMIND_JS wraps it with the DOM wiring.
 */

export const MIN_AGE_YEARS = 16;
/** Minor mode ends here; below it the island sends no analytics at all. */
export const ADULT_AGE_YEARS = 18;

export const REMIND_CORE_JS = String.raw`{
  MIN_AGE: ${MIN_AGE_YEARS},
  ADULT_AGE: ${ADULT_AGE_YEARS},
  /** Whether a remind_me_submit event may be sent: adults only, never the under_age outcome. */
  mayTrack: function(age, outcome){
    return typeof age === "number" && age >= ${ADULT_AGE_YEARS} && outcome !== "under_age";
  },
  /** Whole years, reading a birth month as its last day (never over-ages anyone); UTC, like the server. */
  ageInYears: function(year, month, nowMs){
    var d = new Date(nowMs);
    var age = d.getUTCFullYear() - year;
    if (d.getUTCMonth() + 1 <= month) age -= 1;
    return age;
  },
  /** YYYY-MM, or "" when either part is missing or out of range. */
  yearMonth: function(year, month){
    var y = Number(year), m = Number(month);
    if (!(y >= 1900 && y <= 2100) || !(m >= 1 && m <= 12) || Math.floor(y) !== y || Math.floor(m) !== m) return "";
    return y + "-" + (m < 10 ? "0" + m : String(m));
  },
  validEmail: function(s){
    return typeof s === "string" && s.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  },
  /** The visitor-facing message and telemetry outcome for a response. */
  outcomeFor: function(status, code){
    if (status === 202) return { outcome: "accepted", text: "" };
    if (status === 400 && code === "bad_request") return { outcome: "under_age", text: "Email reminders are for students 16 and older. You can still add this program's dates to your calendar." };
    if (status === 400) return { outcome: "failed", text: "Check your email address and birth month, then try again." };
    if (status === 403) return { outcome: "verification_failed", text: "The security check didn't go through. Try again." };
    if (status === 404) return { outcome: "failed", text: "This program's dates are no longer listed. Reload the page." };
    if (status === 409) return { outcome: "consent_required", text: "This program needs your opt-in before Novus can save a reminder. Tick the box above, or add the dates to your calendar instead." };
    if (status === 429) return { outcome: "rate_limited", text: "Too many requests from this network. Try again in an hour." };
    if (status === 503) return { outcome: "unavailable", text: "Email reminders aren't available right now. Add the dates to your calendar instead." };
    if (status === 0) return { outcome: "failed", text: "Couldn't reach Novus. Check your connection and try again." };
    return { outcome: "failed", text: "Something went wrong. Try again in a few minutes." };
  },
  /** 22 url-safe characters from 22 random bytes (64 divides 256, so no bias); never stored. */
  randomId: function(cryptoObj){
    var bytes = new Uint8Array(22);
    cryptoObj.getRandomValues(bytes);
    var abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += abc[bytes[i] & 63];
    return out;
  },
  /** The error class only: a constructor name, never a message. */
  errorClass: function(err){
    var n = err && typeof err.name === "string" ? err.name : "Error";
    return /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(n) ? n : "Error";
  },
  browserFamily: function(ua){
    ua = ua || "";
    if (/FBAN|FBAV|Instagram|Line\/|Snapchat|TikTok|musical_ly|GSA\//.test(ua)) return "in_app";
    if (/SamsungBrowser/.test(ua)) return "samsung";
    if (/Edg\//.test(ua)) return "edge";
    if (/Firefox\/|FxiOS/.test(ua)) return "firefox";
    if (/Chrome\/|CriOS/.test(ua)) return "chrome";
    if (/Safari\//.test(ua)) return "safari";
    return "other";
  }
}`;

export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export const REMIND_JS = String.raw`(function(){
  "use strict";
  var core = ${REMIND_CORE_JS};
  var TS_URL = ${JSON.stringify(TURNSTILE_SCRIPT_URL)};
  var tsPromise = null;
  var gpc = !!(navigator && navigator.globalPrivacyControl);

  function beacon(url, payload, alone){
    try {
      var body = JSON.stringify(payload);
      if (!alone && navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "text/plain;charset=UTF-8" }))) return;
      fetch(url, { method: "POST", body: body, headers: { "content-type": "text/plain;charset=UTF-8" }, credentials: "omit", keepalive: true }).catch(function(){});
    } catch (e) {}
  }

  function track(cycleId, outcome, age){
    if (!core.mayTrack(age, outcome)) return;
    if (gpc || !window.crypto || !window.crypto.getRandomValues) return;
    // Sent alone, without cookies, with a one-time id and the day only: never linkable, and the
    // server keeps only a day counter when the program is status- or identity-defined.
    var day = new Date(); day.setUTCHours(0, 0, 0, 0);
    var at = day.getTime();
    beacon("/api/v1/events", { events: [{ name: "remind_me_submit", deviceId: core.randomId(window.crypto), at: new Date(at).toISOString(), path: "/programs/:slug", props: { cycleId: cycleId, outcome: outcome } }] }, true);
  }

  function reportError(err){
    beacon("/api/v1/error-reports", { reports: [{ kind: "island", surface: "island", errorClass: core.errorClass(err), route: "/programs/:slug", release: "remind-me.v1", browser: core.browserFamily(navigator.userAgent), file: "remind-me.js", line: null, column: null }] }, false);
  }

  function loadTurnstile(){
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!tsPromise) tsPromise = new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = TS_URL; s.async = true; s.defer = true;
      s.onload = function(){ window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile_missing")); };
      s.onerror = function(){ tsPromise = null; reject(new Error("turnstile_load_failed")); };
      document.head.appendChild(s);
    });
    return tsPromise;
  }

  function q(root, name){ return root.querySelector('[data-rm="' + name + '"]'); }

  function init(root){
    var form = q(root, "form"), status = q(root, "status"), done = q(root, "done"), submit = q(root, "submit");
    var box = q(root, "turnstile"), nojs = q(root, "nojs"), optin = q(root, "optin");
    if (!form || !status || !done || !submit || !box) return;
    var cycleId = root.getAttribute("data-cycle") || "";
    var needsConsent = root.getAttribute("data-consent") === "1";
    var token = null, widget = null, ready = null, available = true, busy = false;


    function say(text, isError){
      status.textContent = text;
      status.className = "rm-status" + (isError ? " rm-error" : "");
    }

    function prepare(){
      if (ready) return ready;
      ready = fetch("/api/v1/turnstile?action=remind-me", { credentials: "same-origin", headers: { accept: "application/json" } })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(cfg){
          if (!cfg || !cfg.enabled || !cfg.siteKey) { available = false; submit.disabled = true; say(core.outcomeFor(503).text, true); return; }
          return loadTurnstile().then(function(api){
            widget = api.render(box, {
              sitekey: cfg.siteKey, action: "remind-me", theme: "light", size: "flexible",
              callback: function(t){ token = t; },
              "expired-callback": function(){ token = null; },
              "error-callback": function(){ token = null; }
            });
          });
        })
        .catch(function(){
          ready = null;
          say("The security check could not load. Check your connection or turn off content blockers for this page, then try again.", true);
        });
      return ready;
    }

    function resetWidget(){
      token = null;
      try { if (widget !== null && window.turnstile) window.turnstile.reset(widget); } catch (e) {}
    }

    form.addEventListener("focusin", function(){ prepare(); });

    form.addEventListener("submit", function(ev){
      ev.preventDefault();
      if (busy || !available) return;
      try {
        var email = String(form.elements.namedItem("email").value || "").trim();
        var ym = core.yearMonth(form.elements.namedItem("year").value, form.elements.namedItem("month").value);
        if (!core.validEmail(email)) { say("Enter the email address where you want reminders.", true); form.elements.namedItem("email").focus(); return; }
        if (!ym) { say("Choose your birth month and year.", true); form.elements.namedItem("month").focus(); return; }
        var parts = ym.split("-");
        var age = core.ageInYears(Number(parts[0]), Number(parts[1]), Date.now());
        if (age < core.MIN_AGE) {
          // Under 16: nothing leaves the device (no request, no event), and the address is cleared.
          form.elements.namedItem("email").value = "";
          say(core.outcomeFor(400, "bad_request").text, true);
          return;
        }
        if (needsConsent && !(optin && optin.checked)) { say(core.outcomeFor(409).text, true); if (optin) optin.focus(); return; }
        prepare().then(function(){
          if (!available) return;
          if (!token) { say("Complete the security check above, then send again.", true); return; }
          busy = true; submit.disabled = true; say("Sending…", false);
          var body = { email: email, programCycleId: cycleId, turnstileToken: token, sensitiveOptIn: needsConsent && !!(optin && optin.checked), birthYearMonth: ym };
          return fetch("/api/v1/remind-me", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })
            .then(function(r){
              if (r.status === 202) return { status: 202, code: "" };
              return r.json().then(function(p){ return { status: r.status, code: p && typeof p.code === "string" ? p.code : "" }; }, function(){ return { status: r.status, code: "" }; });
            }, function(){ return { status: 0, code: "" }; })
            .then(function(res){
              var o = core.outcomeFor(res.status, res.code);
              busy = false; submit.disabled = false;
              track(cycleId, o.outcome, age);
              if (res.status === 202) {
                form.reset(); form.hidden = true; say("", false);
                done.hidden = false; done.focus();
                return;
              }
              resetWidget();
              say(o.text, true);
            });
        });
      } catch (err) {
        busy = false; submit.disabled = false;
        say(core.outcomeFor(-1).text, true);
        reportError(err);
      }
    });

    // Shown only once every handler is attached, so the form can never submit natively.
    if (nojs) nojs.hidden = true;
    form.hidden = false;
  }

  try {
    Array.prototype.forEach.call(document.querySelectorAll('[data-island="remind-me"]'), init);
  } catch (err) {
    reportError(err);
  }
})();
`;
