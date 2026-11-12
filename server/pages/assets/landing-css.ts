import { tokensCss } from "./tokens";

/**
 * Landing page stylesheet: the "Dusk to Day" layout. One lit tile opens the page on near-black,
 * its light warms the ground to taupe, paper carries the reading, and night returns for the close.
 *
 * Accessibility rules kept from the design:
 * - Content is visible at rest; reveals only add a short rise when a block enters.
 * - Without WebGL (or without JavaScript) a CSS gradient tile stands in for the shader.
 * - prefers-reduced-motion stops every animation; a "Pause motion" button does the same on demand.
 * - prefers-reduced-transparency and forced-colors get solid fills.
 * - No inline styles: the CSP has no 'unsafe-inline'.
 */
const LANDING = String.raw`
:root{
  color-scheme:dark;
  --ivory-2:rgba(240,235,226,.78);
  --muted:#A59F93;
  --hair:rgba(240,235,226,.12);
  --f-sans:"Geist","DM Sans",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --f-serif:"Instrument Serif","Iowan Old Style","Palatino Linotype",Georgia,serif;
  --f-mark:"Outfit","Geist",system-ui,sans-serif;
  --f-mono:"Geist Mono","DM Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --f-dot:"Doto","Geist Mono",ui-monospace,monospace;
  --ease:cubic-bezier(.16,1,.3,1);
  --ease-2:cubic-bezier(.22,1,.36,1);
}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--black);scroll-behavior:smooth;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--black);color:var(--ivory);font:400 17px/1.6 var(--f-sans);-webkit-font-smoothing:antialiased;overflow-x:clip}
a{color:inherit;text-decoration:none}
h1,h2,h3,p,ol,ul{margin:0}
h1,h2,h3{font-weight:300;text-wrap:balance}
em{font-family:var(--f-serif);font-style:italic;font-weight:400;letter-spacing:-.005em}
:focus-visible{outline:2px solid var(--focus-dark);outline-offset:4px;border-radius:6px}
.day :focus-visible{outline-color:var(--focus-light)}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.skip{position:absolute;left:16px;top:-60px;z-index:100;padding:10px 16px;border-radius:999px;background:var(--ivory);color:var(--soil)}
.skip:focus{top:12px}
.ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.sprite{position:absolute;width:0;height:0;overflow:hidden}
.wrap{width:100%;max-width:1320px;margin-inline:auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
@media (min-width:640px){.wrap{padding-left:max(24px,env(safe-area-inset-left,0px));padding-right:max(24px,env(safe-area-inset-right,0px))}}
.label{font:400 12px/1.4 var(--f-mono);letter-spacing:.1em;text-transform:uppercase}

/* the light: one fixed canvas draws ground, tile and spill */
#sky{position:fixed;inset:0;z-index:0;width:100%;height:100%;display:none;pointer-events:none}
.gl #sky{display:block}
.mark{position:fixed;left:0;top:0;z-index:1;font:500 30px/1 var(--f-mark);letter-spacing:-.01em;color:#fff;pointer-events:none;white-space:nowrap;opacity:0;transform-origin:0 0;will-change:transform,opacity;display:none}
.gl .mark{display:block}
main{position:relative;z-index:2}
.slot{position:relative;aspect-ratio:4/5}
.trace{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;display:none}
.gl .trace{display:block}
.trace rect{fill:none;stroke:#E3A25E;stroke-width:1;vector-effect:non-scaling-stroke;stroke-dasharray:1;stroke-dashoffset:1;animation:trace 1.4s .3s var(--ease-2) forwards,traceOut .9s 2.1s ease forwards}
@keyframes trace{to{stroke-dashoffset:0}}
@keyframes traceOut{to{opacity:0}}

/* CSS tile: shown until WebGL takes over, and kept wherever WebGL is missing */
.css-tile{display:block;position:absolute;inset:0;border-radius:37%/30%;overflow:hidden;box-shadow:inset 0 0 0 1px rgb(0 0 0 / .08),inset 0 0 14px rgb(40 16 6 / .18);background:radial-gradient(56% 38% at 36% 16%,rgb(17 5 5 / 1) 0%,rgb(17 5 5 / .94) 30%,rgb(24 7 5 / .7) 52%,rgb(32 9 5 / .38) 70%,rgb(40 12 5 / .12) 86%,rgb(40 12 5 / 0) 100%),radial-gradient(20% 32% at 0% 41%,rgb(214 122 52 / .95) 0%,rgb(205 112 50 / .6) 45%,rgb(197 106 48 / .22) 75%,rgb(197 106 48 / 0) 100%),radial-gradient(46% 52% at 100% 6%,rgb(198 199 186 / 1) 0%,rgb(140 160 162 / .85) 35%,rgb(112 137 145 / .4) 65%,rgb(112 137 145 / 0) 100%),radial-gradient(40% 30% at 100% 56%,rgb(240 218 196 / .75),rgb(240 218 196 / 0) 100%),linear-gradient(180deg,#2a0d04 0%,#3a1206 22%,#8a3a17 36%,#d98f3d 46%,#f2c98d 57%,#f8dda8 70%,#f7deb2 100%)}
.css-tile span{position:absolute;left:50%;top:50.5%;transform:translate(-50%,-50%);font:500 clamp(14px,2.6vw,28px)/1 var(--f-mark);color:#fff}
.gl .css-tile{display:none}

/* corners */
.corners{position:fixed;z-index:30;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:calc(14px + env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) 0 max(16px,env(safe-area-inset-left,0px));color:var(--ivory);mix-blend-mode:difference;pointer-events:none}
@media (min-width:640px){.corners{padding-left:max(24px,env(safe-area-inset-left,0px));padding-right:max(24px,env(safe-area-inset-right,0px))}}
.corners a{pointer-events:auto;min-height:44px;display:inline-flex;align-items:center}
.corners .word{font:500 19px/1 var(--f-mark);letter-spacing:-.01em}
.corners nav{display:flex;gap:18px}
@media (min-width:960px){.corners nav{gap:26px}}
/* phones keep Explore and Sign in; the footer and page carry the rest */
@media (max-width:640px){.corners nav .opt{display:none}}
.corners nav a{opacity:.92;transition:opacity .3s}
.corners nav a:hover{opacity:1;text-decoration:underline;text-underline-offset:5px}

/* hero */
.hero{position:relative;height:100svh;min-height:600px}
.hero #slotA{position:absolute;left:50%;top:36%;width:min(29svh,34vw);transform:translate(-50%,-50%)}
.hero h1{position:absolute;left:0;right:0;top:calc(36% + min(29svh,34vw) * .625 + clamp(32px,6svh,72px));text-align:center;font-size:clamp(34px,4.6vw,72px);line-height:1.02;letter-spacing:-.045em;padding-inline:20px}
.hero-foot{position:absolute;left:0;right:0;bottom:calc(22px + env(safe-area-inset-bottom,0px));display:grid;grid-template-columns:minmax(0,1fr);justify-items:center;text-align:center;gap:12px}
.hero-foot .label{color:var(--muted)}
.hero-foot .l{display:none}
@media (min-width:641px){.hero-foot{grid-template-columns:1fr auto 1fr;justify-items:stretch;text-align:left;gap:16px}.hero-foot .l{display:block}.hero-foot .r{text-align:right}}
.pill{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:48px;padding:0 24px;border-radius:999px;font-size:15px;font-weight:400;white-space:nowrap;color:var(--ivory);background:rgba(240,235,226,.08);border:1px solid rgba(240,235,226,.28);-webkit-backdrop-filter:blur(18px) saturate(1.2);backdrop-filter:blur(18px) saturate(1.2);transition:background .4s var(--ease),transform .5s var(--ease)}
.pill:hover{background:rgba(240,235,226,.16)}
.pill.solid{background:var(--ivory);color:#16100C;border-color:var(--ivory)}
.pill.solid:hover{background:#fff}
.intro{animation:intro 1.4s var(--ease) both}
.d1{animation-delay:.15s}.d2{animation-delay:.35s}.d3{animation-delay:.5s}
@keyframes intro{from{opacity:0;transform:translateY(16px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}

/* line reveals: visible at rest, rise when they enter */
.ln{display:block;overflow:hidden;padding-bottom:.08em;margin-bottom:-.08em}
.ln>span{display:inline-block}
.rv.in .ln>span{animation:line 1.5s var(--ease) both}
.rv.in .ln:nth-child(2)>span{animation-delay:.09s}
.rv.in .ln:nth-child(3)>span{animation-delay:.18s}
@keyframes line{from{transform:translateY(105%)}to{transform:none}}
.fade.in{animation:intro 1.3s var(--ease) both}

/* statement */
.statement{min-height:100svh;display:flex;align-items:center;padding-block:16svh}
.statement h2{font-size:clamp(42px,7.2vw,120px);line-height:.98;letter-spacing:-.05em;max-width:14ch}
.statement p{margin-top:36px;max-width:46ch;color:var(--ivory-2);font-size:clamp(17px,1.4vw,20px)}
.kick{display:block;margin-bottom:24px;color:var(--muted)}

/* five doors, on taupe */
.doors{padding-block:12svh 10svh}
.doors .wrap{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}
.doors-art{position:static;display:flex;flex-direction:column;align-items:center;gap:22px;padding-bottom:12px}
#slotB{width:min(150px,38vw)}
.door-cap{color:rgba(255,246,236,.78);min-height:1.4em;text-align:center}
.doors-copy h2{font-size:clamp(32px,3.6vw,56px);line-height:1.04;letter-spacing:-.04em;margin-bottom:40px}
@media (min-width:961px){
  .doors .wrap{grid-template-columns:repeat(12,minmax(0,1fr))}
  .doors-art{grid-column:1/6;position:sticky;top:max(96px,calc(50svh - min(22vw,34svh) * .625 - 20px));padding-bottom:0}
  #slotB{width:min(22vw,34svh)}
  .doors-copy{grid-column:7/13}
}
.door-list{list-style:none;padding:0}
.door{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:6px 18px;align-items:baseline;padding:26px 0 30px;border-top:1px solid rgba(255,246,236,.18);transition:opacity .6s var(--ease)}
.door:last-child{border-bottom:1px solid rgba(255,246,236,.18)}
.door .n{font:400 12px var(--f-mono);letter-spacing:.1em;color:rgba(255,246,236,.7)}
.door h3{font-size:clamp(28px,3vw,46px);letter-spacing:-.035em;line-height:1}
.door h3 a:hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:6px}
.door .c{font:400 12px var(--f-mono);letter-spacing:.08em;color:rgba(255,246,236,.78);text-transform:uppercase}
.door p{grid-column:2/4;color:rgba(255,246,236,.84);max-width:44ch;font-size:16px}
.door-list:has(.door.on) .door:not(.on){opacity:.5}
.also{margin-top:28px;color:rgba(255,246,236,.78);font-size:15px}

/* inside, on taupe */
.inside{padding-block:12svh 16svh}
.head{display:grid;grid-template-columns:minmax(0,1fr);gap:16px 24px;align-items:end;margin-bottom:clamp(40px,6vw,80px)}
.head h2{font-size:clamp(32px,4.4vw,68px);line-height:1.02;letter-spacing:-.045em}
@media (min-width:961px){.head{grid-template-columns:repeat(12,minmax(0,1fr))}.head .kick{grid-column:1/4;align-self:start;margin:12px 0 0}.head h2{grid-column:4/13}}
.head.spaced{margin-top:clamp(96px,11vw,150px)}
.inside .kick{color:rgba(255,246,236,.74)}
.dim{color:rgba(255,246,236,.66)}
.cards{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;align-items:start;max-width:520px;margin-inline:auto}
@media (min-width:961px){.cards{grid-template-columns:1.05fr 1fr 1fr;max-width:none}.card:nth-child(2){margin-top:56px}.card:nth-child(3){margin-top:112px}}
.card{position:relative;padding:26px;border-radius:34px;background:linear-gradient(160deg,rgba(255,236,214,.1),rgba(255,236,214,.02) 50%,rgba(255,200,150,.06)),rgba(26,16,11,.62);border:1px solid rgba(255,236,214,.14);-webkit-backdrop-filter:blur(26px) saturate(1.15);backdrop-filter:blur(26px) saturate(1.15);box-shadow:inset 1px 1px 0 rgba(255,236,214,.2),inset -18px -22px 40px -26px rgba(255,170,110,.35),0 40px 80px -40px rgba(20,10,5,.75)}
.card .tagS{position:absolute;top:22px;right:24px;font:400 10px/1 var(--f-mono);letter-spacing:.14em;text-transform:uppercase;color:rgba(255,246,236,.7)}
.count{display:flex;flex-direction:column;align-items:center;text-align:center;min-height:430px}
.count .eyebrow{font-size:15px;color:rgba(255,246,236,.84);margin-top:4px;padding-inline:44px}
.count .num{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
.dot{font-family:var(--f-dot);font-weight:800;line-height:.82}
.count .dot{font-size:clamp(84px,9vw,110px);color:#FFF4E4}
.count .sub{font-size:14px;color:rgba(255,246,236,.74)}
.count .dot small{display:block;margin-top:12px;font:400 11px var(--f-mono);letter-spacing:.14em;color:rgba(255,246,236,.7)}
.js-local:not([hidden]){display:block;margin-top:4px}
.ruler{width:100%;height:38px;color:rgba(255,246,234,.4)}
.ruler .mj{color:rgba(255,246,234,.62)}
.ruler .now{color:#FFF4E4}
.ends{display:flex;justify-content:space-between;width:100%;margin-top:9px;font:400 11px var(--f-mono);color:rgba(255,246,236,.7)}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:12px}
.stat{display:flex;flex-direction:column;justify-content:space-between;gap:24px;min-height:164px;padding:16px;border-radius:26px;background:rgba(255,236,214,.07);border:1px solid rgba(255,236,214,.09)}
.stat.deep{background:rgba(10,6,4,.4)}
.st-top{display:flex;align-items:center;gap:12px;font-size:14.5px;line-height:1.12}
.ring{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;flex:none;border:1px solid rgba(255,255,255,.3)}
.ring .ic{stroke-width:1.25}
.st-bot{display:flex;align-items:flex-end;justify-content:space-between;gap:8px}
.st-num{font:300 42px/1 var(--f-sans);letter-spacing:-.03em}
.st-num small{font-size:15px;color:rgba(255,246,236,.7);margin-left:3px}
.mc{width:58px;height:24px;flex:none;fill:none;stroke:rgba(255,246,236,.82);stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}
.mc circle{fill:#FFF4E4;stroke:none}
.dg{display:grid;grid-template-columns:repeat(8,4px);gap:4px 5px;padding-bottom:4px}
.dg i{width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.26)}
.dg i.on{background:#FFF4E4}
.prog .tags{display:flex;gap:8px;flex-wrap:wrap;padding-right:64px}
.tag{display:inline-flex;align-items:center;gap:7px;min-height:26px;padding:0 11px;border-radius:999px;font:400 10.5px/1 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:rgba(255,246,236,.88)}
.tag .led{width:6px;height:6px;border-radius:50%;background:var(--good-dark)}
.tag.warn .led{background:var(--warn-dark)}
.prog h3{font-size:27px;line-height:1.08;letter-spacing:-.025em;margin:18px 0 8px}
.prog h3 a:hover{text-decoration:underline;text-underline-offset:4px;text-decoration-thickness:1px}
.prog .ver{display:flex;align-items:center;gap:8px;font:400 12px var(--f-mono);color:rgba(255,246,236,.74)}
.prog .ver .ic{width:15px;height:15px;color:var(--good-dark);stroke-width:2}
.rules{list-style:none;padding:0;margin-top:20px;display:flex;flex-direction:column;gap:8px}
.rules li{display:grid;grid-template-columns:28px minmax(0,1fr);gap:12px;align-items:center;padding:10px 12px;border-radius:18px;background:rgba(255,255,255,.06);font-size:14.5px}
.mk{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:rgba(207,227,176,.15);color:var(--good-dark);font:500 14px var(--f-sans)}
.mk .ic{width:14px;height:14px;stroke-width:2.2}
.mk.q{background:rgba(237,163,90,.18);color:var(--warn-dark)}
.mini{display:inline-flex;align-items:center;gap:6px;min-height:30px;margin-top:6px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.24);font-size:12.5px;color:rgba(255,246,236,.9);white-space:nowrap}
.mini .ic{width:13px;height:13px}
.prog .apply{display:flex;align-items:center;justify-content:space-between;margin-top:22px;padding-top:18px;border-top:1px solid rgba(255,246,236,.16);font-size:14px;color:rgba(255,246,236,.88)}
.prog .apply:hover span{text-decoration:underline;text-underline-offset:4px}

/* day: warm paper for reading */
.day{background:var(--paper);color:var(--espresso);border-radius:36px;padding-block:clamp(80px,12vw,170px);margin-inline:max(6px,env(safe-area-inset-left,0px));position:relative;color-scheme:light}
@media (min-width:641px){.day{border-radius:56px;margin-inline:max(8px,env(safe-area-inset-left,0px))}}
.day .kick{color:var(--ink-muted)}
.day .head h2 em{color:var(--clay)}
.steps{list-style:none;padding:0;display:grid;grid-template-columns:minmax(0,1fr);gap:28px}
@media (min-width:961px){.steps{grid-template-columns:repeat(3,minmax(0,1fr))}}
.steps li{display:flex;flex-direction:column;gap:16px;padding-top:26px;border-top:1px solid rgba(46,37,33,.16)}
.steps .n{font:400 12px var(--f-mono);letter-spacing:.12em;color:var(--ink-muted)}
.mini-tile{position:relative;width:52px;aspect-ratio:4/5;border-radius:37%/30%;overflow:hidden;display:grid;place-items:center;box-shadow:0 14px 30px -14px rgba(60,30,10,.55);background:var(--tile)}
.mini-tile .ic{position:relative;width:20px;height:20px;color:#fff;stroke-width:1.6;filter:drop-shadow(0 1px 5px rgba(60,25,8,.45))}
.t-ember{--tile:radial-gradient(56% 38% at 36% 16%,#110505 0%,rgba(17,5,5,0) 90%),radial-gradient(20% 32% at 0% 41%,rgba(214,122,52,.95),rgba(214,122,52,0)),radial-gradient(46% 52% at 100% 6%,#c6c7ba,rgba(112,137,145,0) 90%),linear-gradient(180deg,#2a0d04,#8a3a17 36%,#d98f3d 46%,#f2c98d 57%,#f7deb2)}
.t-sky{--tile:radial-gradient(56% 38% at 36% 16%,#0b1214 0%,rgba(11,18,20,0) 90%),radial-gradient(46% 52% at 100% 6%,#e3ece8,rgba(160,190,196,0) 90%),linear-gradient(180deg,#14262b,#3d6a73 38%,#9fbcc0 55%,#dfe8e4)}
.t-honey{--tile:radial-gradient(56% 38% at 36% 16%,#1a1004 0%,rgba(26,16,4,0) 90%),radial-gradient(46% 52% at 100% 6%,#d8d3bf,rgba(150,150,140,0) 90%),linear-gradient(180deg,#2e1d05,#9a6a12 36%,#e5b54a 48%,#f6dc95 60%,#faeccb)}
.steps h3{font-size:30px;letter-spacing:-.035em;color:var(--soil)}
.steps p{color:#4E433D;max-width:34ch;font-size:16px}
.soon-list{list-style:none;padding:0;border-top:1px solid rgba(46,37,33,.16)}
.soon-list li{display:grid;grid-template-columns:84px minmax(0,1fr);row-gap:8px;column-gap:20px;align-items:center;padding:24px 0;border-bottom:1px solid rgba(46,37,33,.16)}
@media (min-width:961px){.soon-list li{grid-template-columns:120px minmax(0,1.4fr) minmax(0,1fr) auto}}
.soon-list .dot{font-size:42px;color:var(--soil)}
@media (min-width:961px){.soon-list .dot{font-size:52px}}
.soon-list .dot small{display:block;font:400 11px var(--f-mono);letter-spacing:.14em;color:var(--ink-muted);margin-top:8px}
.soon-list li.urgent .dot{color:var(--clay)}
.soon-list b{display:block;font-weight:400;font-size:22px;letter-spacing:-.02em;color:var(--soil)}
.soon-list b a:hover{text-decoration:underline;text-underline-offset:4px;text-decoration-thickness:1px}
.soon-list .org{font-size:14px;color:var(--ink-muted)}
.soon-list .when{font:400 13px var(--f-mono);color:#4E433D}
.soon-list .ty{font:400 11px var(--f-mono);letter-spacing:.1em;text-transform:uppercase;padding:7px 12px;border-radius:999px;border:1px solid rgba(46,37,33,.24);color:#4E433D;white-space:nowrap;justify-self:start}
@media (max-width:960px){.soon-list .when,.soon-list .ty{grid-column:2}}
.sample-note{margin-top:18px;font:400 12px var(--f-mono);color:var(--ink-muted)}
.more{display:inline-flex;margin-top:28px;min-height:44px;align-items:center;gap:8px;color:var(--soil);text-decoration:underline;text-underline-offset:4px}

/* night: the tile returns */
.night{padding-top:clamp(110px,14vw,190px);text-align:center}
#slotC{width:min(26svh,30vw);margin:0 auto}
.night h2{margin-top:clamp(40px,6svh,64px);font-size:clamp(40px,5.6vw,92px);line-height:1;letter-spacing:-.05em}
.night .ctas{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:40px}
.night .note{margin-top:18px;font:400 12px var(--f-mono);color:var(--muted)}
.night .note a{text-decoration:underline;text-underline-offset:3px}
.foot{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-top:clamp(90px,12vw,150px);padding-block:30px calc(30px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--hair);color:var(--muted)}
.foot nav{display:flex;gap:6px 22px;flex-wrap:wrap}
.foot a{min-height:44px;display:inline-flex;align-items:center}
.foot a:hover,.foot button:hover{color:var(--ivory)}
.foot button{background:none;border:1px solid rgba(240,235,226,.3);border-radius:999px;color:inherit;font:inherit;min-height:44px;padding:0 16px;cursor:pointer}
.foot button[hidden]{display:none}

.still *,.still *::before,.still *::after{animation-play-state:paused!important}
.stale-banner,.novus-stale-banner{position:relative;z-index:50;padding:12px 16px;background:var(--ivory);color:var(--soil);font-size:14.5px;text-align:center}

@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{animation:none!important;transition:none!important}
  .trace{display:none!important}
}
@media (prefers-reduced-transparency:reduce){
  .card,.pill{background:#2A1C15;-webkit-backdrop-filter:none;backdrop-filter:none}
  .pill.solid{background:var(--ivory)}
}
@media (forced-colors:active){
  .corners{mix-blend-mode:normal}
  .card,.pill,.tag{border:1px solid CanvasText;-webkit-backdrop-filter:none;backdrop-filter:none}
}
`;

export const LANDING_CSS = `${tokensCss()}${LANDING}`;
