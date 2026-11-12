/**
 * The small island shared by Program, Explore and Deadlines pages. Cached HTML cannot know the
 * viewer's time zone (public pages read no cookies), so this script, on the viewer's own clock:
 * - adds "your time" next to deadlines published in another zone (`[data-instant]`);
 * - recomputes day counts (`[data-countdown-at]`, epoch ms) so a five-minute-old page never
 *   shows yesterday's count;
 * - resolves "11:59 PM your time zone" deadlines (`[data-applicant-date]`) on the viewer's clock.
 * It reads and stores nothing else, and the page is complete without it.
 */
export const PAGE_JS = String.raw`(function(){
  "use strict";
  var DAY=864e5;
  var viewerZone="";
  try{viewerZone=Intl.DateTimeFormat().resolvedOptions().timeZone||""}catch(e){}
  var fmt;
  try{fmt=new Intl.DateTimeFormat(undefined,{weekday:"short",day:"numeric",month:"short",hour:"numeric",minute:"2-digit"})}catch(e){fmt=null}

  Array.prototype.forEach.call(document.querySelectorAll("[data-instant]"),function(el){
    var ms=Date.parse(el.getAttribute("data-instant")||"");
    var out=el.querySelector(".js-local");
    if(!out||isNaN(ms)||!fmt)return;
    var zone=el.getAttribute("data-zone")||"";
    out.textContent=zone&&zone===viewerZone?"That is your time zone.":"Your time: "+fmt.format(new Date(ms));
    out.hidden=false;
  });

  function setDays(el,at){
    var days=Math.max(0,Math.ceil((at-Date.now())/DAY));
    Array.prototype.forEach.call(el.querySelectorAll(".js-days"),function(n){n.textContent=String(days)});
    Array.prototype.forEach.call(el.querySelectorAll(".js-days-text"),function(n){n.textContent=days===0?"Due today":days===1?"1 day left":days+" days left"});
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-countdown-at]"),function(el){
    var at=Number(el.getAttribute("data-countdown-at"));
    if(isFinite(at)&&at>0)setDays(el,at);
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-applicant-date]"),function(el){
    var p=(el.getAttribute("data-applicant-date")||"").split("-").map(Number);
    var t=(el.getAttribute("data-applicant-time")||"").split(":").map(Number);
    if(p.length!==3||p.some(isNaN))return;
    var hasTime=t.length===2&&!t.some(isNaN);
    // Date-only rows count to the start of the stated day; exact rows to the stated minute.
    var at=new Date(p[0],p[1]-1,p[2],hasTime?t[0]:0,hasTime?t[1]:0).getTime();
    setDays(el,at);
  });
})();
`;
