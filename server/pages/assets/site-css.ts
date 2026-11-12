import { tokensCss } from "./tokens";

/**
 * Stylesheet shared by every public page. Served as an external, content-hashed file because the
 * CSP has no 'unsafe-inline' for styles (no <style> blocks and no style attributes anywhere).
 *
 * Fonts: the stacks name Geist, Instrument Serif and Doto first so self-hosted subsets can drop in
 * later without a markup change; until then they resolve to system faces. No third-party font
 * request is ever made (plan s09 9.10.5).
 */
const BASE = String.raw`
:root{
  color-scheme:dark;
  --f-sans:"Geist","DM Sans",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --f-serif:"Instrument Serif","Iowan Old Style","Palatino Linotype",Georgia,serif;
  --f-mark:"Outfit","Geist",system-ui,sans-serif;
  --f-mono:"Geist Mono","DM Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --f-dot:"Doto","Geist Mono",ui-monospace,monospace;
  --ease:cubic-bezier(.16,1,.3,1);
  --hair:rgba(240,235,226,.14);
}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--black);-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--black);color:var(--ivory);font:400 16px/1.6 var(--f-sans);-webkit-font-smoothing:antialiased;overflow-x:clip}
a{color:inherit}
h1,h2,h3,h4,p,ol,ul,dl,dd,figure{margin:0}
h1,h2,h3{font-weight:400;text-wrap:balance;letter-spacing:-.02em}
em{font-family:var(--f-serif);font-style:italic;font-weight:400}
img,svg{display:block;max-width:100%}
:focus-visible{outline:2px solid var(--focus-dark);outline-offset:3px;border-radius:6px}
.day :focus-visible{outline-color:var(--focus-light)}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.skip{position:absolute;left:16px;top:-60px;z-index:100;padding:10px 16px;border-radius:999px;background:var(--ivory);color:var(--soil);text-decoration:none}
.skip:focus{top:12px}
.ic{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.wrap{width:100%;max-width:1200px;margin-inline:auto;padding-inline:max(16px,env(safe-area-inset-left,0px)) max(16px,env(safe-area-inset-right,0px))}
@media (min-width:640px){.wrap{padding-inline:24px}}
.label{font:500 12px/1.4 var(--f-mono);letter-spacing:.08em;text-transform:uppercase}
.muted{color:var(--ivory-muted)}
.day .muted{color:var(--ink-muted)}
.dot{font-family:var(--f-dot);font-weight:800;line-height:.85;letter-spacing:0}

/* header */
.site-head{position:relative;z-index:5}
.site-head .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:72px;flex-wrap:wrap}
.word{font:500 21px/1 var(--f-mark);letter-spacing:-.01em;text-decoration:none;color:var(--ivory);display:inline-flex;align-items:center;min-height:44px}
.site-nav{display:flex;align-items:center;gap:6px 18px;flex-wrap:wrap}
.site-nav a{text-decoration:none;color:var(--ivory-muted);padding:10px 2px;min-height:44px;display:inline-flex;align-items:center}
.site-nav a:hover,.site-nav a[aria-current="page"]{color:var(--ivory)}
.site-nav a[aria-current="page"]{text-decoration:underline;text-underline-offset:6px}
.site-nav .pill{color:var(--ivory)}

/* buttons */
.pill{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:44px;padding:0 20px;border-radius:999px;font:400 15px/1 var(--f-sans);white-space:nowrap;color:var(--ivory);background:rgba(240,235,226,.08);border:1px solid rgba(240,235,226,.28);text-decoration:none;cursor:pointer;transition:background .2s var(--ease)}
.pill:hover{background:rgba(240,235,226,.16)}
.pill.solid{background:var(--ivory);color:var(--soil);border-color:var(--ivory)}
.pill.solid:hover{background:#fff}
.day .pill{color:var(--espresso);background:transparent;border-color:rgba(46,37,33,.4)}
.day .pill:hover{background:rgba(46,37,33,.06)}
.day .pill.solid{background:var(--espresso);color:var(--paper);border-color:var(--espresso)}
.linkish{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}

/* chips: colour always comes with a word and a mark */
.chip{display:inline-flex;align-items:center;gap:7px;min-height:28px;padding:0 11px;border-radius:999px;font:500 11.5px/1 var(--f-mono);letter-spacing:.08em;text-transform:uppercase;border:1px solid rgba(240,235,226,.22);color:var(--ivory)}
.chip .led{width:7px;height:7px;border-radius:50%;background:currentColor}
.chip.good{color:var(--good-dark)}
.chip.warn{color:var(--warn-dark)}
.chip.late{color:var(--late-dark)}
.day .chip{border-color:rgba(46,37,33,.24);color:var(--espresso);background:var(--card)}
.day .chip.good{color:var(--good)}
.day .chip.warn{color:var(--warn)}
.day .chip.late{color:var(--late)}
.sample-tag{display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border-radius:999px;font:500 10.5px/1 var(--f-mono);letter-spacing:.12em;text-transform:uppercase;border:1px dashed currentColor;color:var(--warn-dark)}
.day .sample-tag{color:var(--warn)}

/* dusk band */
.dusk{position:relative;padding-block:32px 72px;background:radial-gradient(70% 90% at 85% 0%,rgba(217,119,42,.22),rgba(217,119,42,0) 60%),radial-gradient(60% 80% at 0% 100%,rgba(96,72,62,.55),rgba(96,72,62,0) 70%),var(--black)}
.dusk h1{font-size:clamp(34px,5.4vw,68px);line-height:1.02;letter-spacing:-.045em;max-width:20ch}
.dusk .lede{margin-top:18px;max-width:58ch;color:var(--ivory-muted);font-size:clamp(16px,1.3vw,18px)}
.kick{display:block;margin-bottom:18px;color:var(--ivory-muted)}
.crumbs{display:flex;flex-wrap:wrap;gap:6px 10px;margin-bottom:22px;color:var(--ivory-muted)}
.crumbs a{text-decoration:none}
.crumbs a:hover{text-decoration:underline}
.crumbs li{display:flex;gap:10px;align-items:center}
.crumbs li+li::before{content:"/";opacity:.6}
.crumbs ol{display:contents;list-style:none;padding:0}

/* day: warm paper for reading */
.day{background:var(--paper);color:var(--espresso);border-radius:32px;margin-inline:max(6px,env(safe-area-inset-left,0px));padding-block:clamp(40px,7vw,96px);position:relative;color-scheme:light}
@media (min-width:900px){.day{border-radius:48px}}
.day h2{font-size:clamp(26px,3vw,40px);line-height:1.08;letter-spacing:-.035em;color:var(--soil)}
.day h3{font-size:20px;letter-spacing:-.02em;color:var(--soil)}
.day .kick{color:var(--ink-muted)}
.day a{color:var(--soil)}
.section{padding-block:28px 36px;border-top:1px solid rgba(46,37,33,.16)}
.section:first-child{border-top:0;padding-top:0}
.section>h2{margin-bottom:18px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.note{font-size:14px;color:var(--ink-muted)}
.cols{display:grid;gap:clamp(24px,4vw,56px)}
@media (min-width:960px){.cols{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}}

/* program hero */
.prog-hero{display:grid;gap:20px;align-items:stretch}
@media (min-width:900px){.prog-hero{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)}}
.panel{position:relative;padding:clamp(20px,3vw,32px);border-radius:28px;background:var(--surface);border:1px solid var(--surface-line)}
.panel .tags{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.panel h1{margin-top:18px;font-size:clamp(30px,4.2vw,54px);line-height:1.04;letter-spacing:-.04em;max-width:22ch}
.panel .org{margin-top:10px;color:var(--ivory-muted);font-size:17px}
.panel .summary{margin-top:16px;max-width:60ch}
.ver{display:flex;align-items:flex-start;gap:9px;margin-top:18px;font:400 13px/1.5 var(--f-mono);color:var(--ivory-muted)}
.ver .ic{width:16px;height:16px;margin-top:1px}
.ver.good .ic{color:var(--good-dark)}
.ver.warn .ic{color:var(--warn-dark)}
.ver.late .ic{color:var(--late-dark)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
.countdown{display:flex;flex-direction:column;justify-content:space-between;gap:18px}
.countdown .eyebrow{color:var(--ivory-muted)}
.countdown .big{display:flex;align-items:flex-end;gap:12px}
.countdown .dot{font-size:clamp(72px,10vw,120px);color:#FFF4E4}
.countdown .unit{padding-bottom:10px}
.countdown .when{font-size:17px}
.countdown .local{color:var(--ivory-muted);font-size:15px}
.countdown .dot small{display:block;margin-top:10px;font:500 12px var(--f-mono);letter-spacing:.14em;color:var(--ivory-muted)}
.js-local:not([hidden]){display:block;margin-top:4px;color:var(--ivory-muted);font-size:15px}
.day .js-local:not([hidden]){color:var(--ink-muted);font-size:14px}
.countdown .advice{color:var(--warn-dark);font-size:14px}
.ruler{width:100%;height:38px;color:rgba(255,246,234,.4)}
.ruler .mj{color:rgba(255,246,234,.65)}
.ruler .now{color:#FFF4E4}
.ends{display:flex;justify-content:space-between;font:400 11.5px var(--f-mono);color:var(--ivory-muted)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:22px}
.fact{padding:12px 14px;border-radius:18px;background:rgba(240,235,226,.05);border:1px solid var(--surface-line)}
.fact dt{color:var(--ivory-muted)}
.fact dd{margin-top:4px;font-size:15px}

/* eligibility rules */
.rules{list-style:none;padding:0;display:flex;flex-direction:column;gap:8px}
.rules li{display:grid;grid-template-columns:30px minmax(0,1fr);gap:12px;align-items:start;padding:12px 14px;border-radius:18px;background:var(--card);border:1px solid var(--card-line)}
.mk{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font:600 14px/1 var(--f-sans);background:rgba(46,37,33,.08);color:var(--espresso)}
.mk.lock{background:rgba(122,78,0,.12);color:var(--warn)}
.mk .ic{width:15px;height:15px}
.rule-text{display:flex;flex-direction:column;gap:6px}
.rule-text .quote{font-size:13.5px;color:var(--ink-muted)}
.private{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;min-height:36px;padding:0 14px;border-radius:999px;border:1px solid rgba(46,37,33,.4);font-size:14px;text-decoration:none}
.private .ic{width:14px;height:14px}
.group-label{margin:16px 0 8px}
.callout{margin-top:14px;padding:14px 16px;border-radius:18px;background:var(--card);border:1px solid var(--card-line);font-size:15px}
.callout.warn{border-color:rgba(122,78,0,.45)}
.callout strong{font-weight:600}

/* requirements */
.reqs{list-style:none;padding:0;display:grid;gap:8px}
.reqs li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 14px;align-items:baseline;padding:14px 0;border-bottom:1px solid rgba(46,37,33,.14)}
.reqs .k{grid-column:1/-1;color:var(--ink-muted)}
.reqs .by{font:400 13px var(--f-mono);color:var(--clay);white-space:nowrap}

/* deadline table */
.dl{list-style:none;padding:0}
.dl li{display:grid;grid-template-columns:minmax(0,1fr);gap:4px;padding:14px 0;border-bottom:1px solid rgba(46,37,33,.14)}
@media (min-width:720px){.dl li{grid-template-columns:200px minmax(0,1fr)}}
.dl .k{font-weight:600}
.dl .local,.dl .basis{color:var(--ink-muted);font-size:14px}
.dl .advice{color:var(--warn);font-size:14px}
.dl .passed .k::after{content:" · passed";font-weight:400;color:var(--late)}

/* cycle history, sources */
.history,.sources{list-style:none;padding:0}
.history li,.sources li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid rgba(46,37,33,.14)}
.sources a{overflow-wrap:anywhere}
.cite{margin-top:20px;font:400 12.5px/1.6 var(--f-mono);color:var(--ink-muted)}

/* explore */
.filters{display:grid;gap:12px;margin-top:28px;padding:16px;border-radius:24px;background:var(--surface);border:1px solid var(--surface-line)}
@media (min-width:860px){.filters{grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) auto;align-items:end}}
.field{display:flex;flex-direction:column;gap:6px}
.field label,.field .lab{color:var(--ivory-muted)}
.input,.select{width:100%;min-height:46px;padding:0 14px;border-radius:14px;border:1px solid rgba(240,235,226,.35);background:var(--black);color:var(--ivory);font:inherit;font-size:16px}
.checks{display:flex;gap:16px;flex-wrap:wrap;align-items:center;min-height:46px}
.checks label{display:inline-flex;gap:8px;align-items:center;min-height:44px;cursor:pointer}
.checks input{width:20px;height:20px;accent-color:var(--ivory)}
.result-meta{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.grid{list-style:none;padding:0;display:grid;gap:16px}
@media (min-width:700px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:1080px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.pcard{position:relative;display:flex;flex-direction:column;gap:12px;height:100%;padding:20px;border-radius:24px;background:var(--card);border:1px solid var(--card-line)}
.pcard:hover{border-color:rgba(46,37,33,.45)}
.pcard .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.pcard .tags{display:flex;flex-wrap:wrap;gap:6px}
.pcard h3 a{text-decoration:none}
.pcard h3 a::after{content:"";position:absolute;inset:0;border-radius:24px}
.pcard h3 a:focus-visible{outline:none}
.pcard:focus-within{outline:2px solid var(--focus-light);outline-offset:3px}
.pcard .org{color:var(--ink-muted);font-size:14.5px}
.pcard .next{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:auto;padding-top:12px;border-top:1px solid rgba(46,37,33,.14)}
.pcard .next .dot{font-size:40px;color:var(--soil)}
.pcard .next .dot small{display:block;margin-top:6px;font:500 10.5px var(--f-mono);letter-spacing:.12em}
.pcard .next .when{font-size:14px;text-align:right}
.pcard .meta{font-size:13.5px;color:var(--ink-muted)}
.empty{padding:40px 0;font-size:18px}

/* deadlines list */
.soon{list-style:none;padding:0;border-top:1px solid rgba(46,37,33,.16)}
.soon li{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px 18px;align-items:center;padding:18px 0;border-bottom:1px solid rgba(46,37,33,.16)}
@media (min-width:860px){.soon li{grid-template-columns:110px minmax(0,1.4fr) minmax(0,1fr) auto}}
.soon .dot{font-size:40px;color:var(--soil)}
@media (min-width:860px){.soon .dot{font-size:50px}}
.soon .dot small{display:block;font:500 10.5px var(--f-mono);letter-spacing:.14em;color:var(--ink-muted);margin-top:6px}
.soon li.urgent .dot{color:var(--clay)}
.soon b{display:block;font-weight:500;font-size:19px;letter-spacing:-.015em;color:var(--soil)}
.soon b a{text-decoration:none}
.soon b a:hover{text-decoration:underline}
.soon .org{font-size:14px;color:var(--ink-muted)}
.soon .when{font:400 13px/1.5 var(--f-mono);color:var(--espresso)}
.soon .ty{justify-self:start}
@media (max-width:859px){.soon .when,.soon .ty{grid-column:2}}
.month{margin-top:36px;margin-bottom:8px}
.ranges{display:flex;gap:8px;flex-wrap:wrap;margin-top:24px}
.ranges a[aria-current="page"]{background:var(--ivory);color:var(--soil)}

/* prose (methods) */
.prose{max-width:70ch}
.prose h2{margin:44px 0 14px}
.prose h2:first-child{margin-top:0}
.prose p,.prose ul,.prose ol{margin-top:12px}
.prose li{margin-top:6px}
.toc{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}

/* collection pages: counted facts in Doto */
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:28px;max-width:860px}
@media (min-width:720px){.stats{grid-template-columns:repeat(4,minmax(0,1fr))}}
.stat{display:flex;flex-direction:column-reverse;justify-content:flex-end;gap:10px;padding:16px 18px;border-radius:22px;background:var(--surface);border:1px solid var(--surface-line)}
.stat dt{color:var(--ivory-muted)}
.stat dd{font-size:clamp(40px,5vw,56px);color:#FFF4E4}
.version{margin-top:18px;color:var(--ivory-muted)}
.dusk .actions{margin-top:22px}
.dusk .toc{margin-top:22px}
.advisor-note{position:relative;z-index:1;display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:16px;background:rgba(159,74,28,.07);border:1px solid rgba(159,74,28,.25);font-size:14.5px}
.advisor-note .label{display:block;margin-bottom:4px;color:var(--clay)}

/* numbered promises and steps (pledge, methods) */
.pledge,.steps{list-style:none;padding:0;display:grid;gap:0}
.pledge li,.steps li{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px 20px;padding:26px 0;border-top:1px solid rgba(46,37,33,.16)}
@media (min-width:720px){.pledge li{grid-template-columns:120px minmax(0,1fr)}}
.pledge li:first-child{border-top:0;padding-top:0}
.pledge .num{font-size:clamp(40px,6vw,72px);color:var(--clay)}
.steps .num{font-size:36px;color:var(--clay)}
.pledge h2{font-size:clamp(22px,2.6vw,32px);max-width:28ch}
.pledge p{margin-top:10px;max-width:64ch}
.pledge .how{font-size:14.5px}
.steps h3{margin:0}
.steps p{margin-top:6px}
.pledge-foot{margin-top:24px}
.pledge-foot p{max-width:70ch}
.callout+.section{border-top:0}
.pledge-foot p+p{margin-top:12px}
.prose .steps li{margin-top:0}

/* audit */
.prose.wide{max-width:960px}
.prose h3.sub{margin:22px 0 4px}
.grades{display:grid;gap:8px;margin-top:14px}
.grades div{display:grid;grid-template-columns:minmax(0,1fr);gap:4px;padding:12px 14px;border-radius:18px;background:var(--card);border:1px solid var(--card-line)}
@media (min-width:720px){.grades div{grid-template-columns:180px minmax(0,1fr)}}
.grades dt{font-weight:600;color:var(--soil)}
.timeline{list-style:none;padding:0;margin-top:14px;border-left:2px solid rgba(46,37,33,.2)}
.timeline li{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:4px;padding:10px 0 14px 20px}
@media (min-width:720px){.timeline li{grid-template-columns:200px minmax(0,1fr)}}
.timeline li::before{content:"";position:absolute;left:-7px;top:16px;width:12px;height:12px;border-radius:50%;background:var(--paper);border:2px solid var(--ink-muted)}
.timeline li.done::before{background:var(--good);border-color:var(--good)}
.timeline li.now::before{background:var(--clay);border-color:var(--clay)}
.timeline .when{color:var(--ink-muted)}
.timeline .note{display:block;margin-top:2px}
.timeline b{font-weight:600;color:var(--soil)}
.table-wrap{margin-top:16px;overflow-x:auto;border-radius:18px;border:1px solid var(--card-line);background:var(--card)}
.data{width:100%;border-collapse:collapse;font-size:14.5px}
.data caption{padding:12px 14px;text-align:left;color:var(--ink-muted);font-size:13.5px}
.data th,.data td{padding:10px 14px;text-align:left;vertical-align:top;border-top:1px solid var(--card-line)}
.data thead th{font:500 11.5px/1.4 var(--f-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-muted)}
.data tbody th{font-weight:600;color:var(--soil)}

/* footer */
.site-foot{padding-block:48px calc(36px + env(safe-area-inset-bottom,0px));color:var(--ivory-muted)}
.site-foot .wrap{display:flex;justify-content:space-between;gap:18px 28px;flex-wrap:wrap;align-items:center}
.site-foot nav{display:flex;gap:6px 20px;flex-wrap:wrap}
.site-foot a{text-decoration:none;min-height:44px;display:inline-flex;align-items:center}
.site-foot a:hover{color:var(--ivory)}

/* "as of" banner injected when serving a saved copy */
.stale-banner,.novus-stale-banner{position:relative;z-index:50;padding:12px 16px;background:var(--ivory);color:var(--soil);font-size:14.5px;text-align:center}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){.chip,.pill,.panel,.pcard,.rules li,.stat,.grades div{border:1px solid CanvasText}.chip .led{forced-color-adjust:none;background:CanvasText}}
@media print{.site-head,.site-foot,.actions,.filters{display:none}.stat{border:1px solid #000}.day{border-radius:0}body,html{background:#fff}}
`;

export const SITE_CSS = `${tokensCss()}${BASE}`;
