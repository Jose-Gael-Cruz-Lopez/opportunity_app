/**
 * Styles for page islands, served as a hashed file (the page CSP has no 'unsafe-inline' for
 * styles). Colours come from the public-page tokens in site.css (`--espresso`, `--ink-muted`,
 * `--card`, `--late`, `--focus-light`), so the island follows any token change. Controls use
 * `--ink-muted` borders (about 6:1 on paper, above WCAG 1.4.11's 3:1) and 46 px touch targets.
 */
export const ISLANDS_CSS = String.raw`
.rm-form{display:grid;gap:16px;margin-top:16px}
.rm-form[hidden],.rm-done[hidden],.rm-nojs[hidden]{display:none}
.rm-field{display:grid;gap:6px;margin:0;padding:0;border:0;min-width:0}
.rm-field>label,.rm-field>legend{font-size:15px;font-weight:500;color:var(--espresso);padding:0}
.rm-hint{font-size:13.5px;color:var(--ink-muted);margin:0}
.rm-row{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:10px}
.rm-input,.rm-select{width:100%;min-height:46px;padding:0 14px;border-radius:14px;border:1px solid var(--ink-muted);background:var(--card);color:var(--espresso);font:inherit;font-size:16px}
.rm-select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--ink-muted) 50%),linear-gradient(135deg,var(--ink-muted) 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 15px) 50%;background-size:5px 5px;background-repeat:no-repeat;padding-right:34px}
.rm-input:focus-visible,.rm-select:focus-visible,.rm-check input:focus-visible{outline:2px solid var(--focus-light);outline-offset:2px}
.rm-check{display:grid;grid-template-columns:22px 1fr;gap:10px;align-items:start;font-size:14.5px;color:var(--espresso)}
.rm-check input{width:20px;height:20px;margin:2px 0 0;accent-color:var(--espresso)}
.rm-ts:empty{display:none}
.rm-ts{min-height:65px}
.rm-submit{justify-self:start}
.rm-submit[disabled]{opacity:.55;cursor:not-allowed}
.rm-status{min-height:1.4em;margin:0;font-size:14.5px;color:var(--espresso)}
.rm-status:empty{min-height:0}
.rm-error{color:var(--late)}
.rm-fine{margin:0}
.rm-done{margin-top:16px}
.rm-done:focus{outline:2px solid var(--focus-light);outline-offset:3px}
@media (max-width:380px){.rm-row{grid-template-columns:1fr}}
`;
