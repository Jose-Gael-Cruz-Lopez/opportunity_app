/**
 * Landing page script (served as an external, hashed file; the CSP forbids inline scripts).
 *
 * One fixed WebGL canvas draws the ground, the lit tile and its spill. The tile is born in the
 * hero, travels into the "doors" section as the page scrolls, takes the tint of the door nearest
 * the middle of the screen, and returns for the closing section. Everything degrades: without
 * WebGL the CSS tile stays and only the ground colour moves; with reduced motion the shader is
 * still and nothing animates; "Pause motion" freezes it on demand.
 *
 * The 9 x 11 colour mesh is sampled from the reference tile and upsampled with a B-spline in
 * the fragment shader, with fbm noise for a slow drift and film grain on top.
 */
export const LANDING_JS = String.raw`(function(){
  "use strict";
  var root=document.documentElement;
  var reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
  var paused=reduce;

  // live instrument label from the visitor's own clock
  var clock=document.getElementById("clock");
  function tick(){if(!clock)return;var d=new Date(),m=d.getMonth(),y=d.getFullYear();
    var season=m>=8&&m<=10?"Fall":(m===11||m<=1)?"Winter":m<=4?"Spring":"Summer";
    var t=new Date(Date.UTC(y,m,d.getDate()));var day=t.getUTCDay()||7;t.setUTCDate(t.getUTCDate()+4-day);
    var wk=Math.ceil(((t-new Date(Date.UTC(t.getUTCFullYear(),0,1)))/864e5+1)/7);
    clock.textContent=season+" "+y+" · Week "+wk+" · "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")}
  tick();setInterval(tick,30000);

  var EMBER=["#3c1306","#2a0d04","#230e06","#251813","#2c2321","#3f4449","#708991","#a5b6b2","#bbc2b8","#58200c","#3c1306","#120705","#130806","#1a100e","#302e2f","#6d868d","#bbc2b8","#c6c7ba","#a35222","#320e04","#110604","#120705","#190f0d","#332c2a","#61747b","#b8c0b8","#d1cbbe","#c16a32","#4c1507","#280a06","#230b06","#2c1510","#45362d","#677072","#b7bfb6","#d0cbbe","#d37834","#963b18","#782d16","#75311a","#7e3c20","#85593d","#96887b","#c8c2b5","#d4ccbe","#eca756","#e0983e","#d8943c","#ca9252","#cf9958","#cea167","#d9b68e","#e2cdb8","#e1d2c0","#f5cb90","#f5cf93","#f3ce8b","#f0cf8d","#f3d293","#f2d197","#f5d4a9","#f4d9bb","#f0dac4","#f6d7a7","#f9ddad","#f8dea8","#f7dca7","#f7dea8","#f7dca9","#f9ddb4","#f8e0be","#f5dcc3","#f7dbb0","#f8e0b3","#f8e0b2","#f7dfaf","#f9deaf","#f7deaf","#f8dfb6","#f9e1bf","#f5dcc1","#f7deb2","#f6deb1","#f8e0b4","#f8e0b4","#f8e0b2","#f8e0b2","#f8dfb7","#f6dcbb","#f7debc","#f6deb1","#f8dbb2","#f6dbb1","#f6dcb2","#f8deb5","#f7dbb2","#f6dab3","#f7dbb6","#f6dcbb"];
  // per-door tint: colour and strength (luminance kept)
  var TINTS=[[1,1,1,0],[.6,.78,.84,.6],[1,.5,.28,.34],[.76,.8,.44,.5],[1,.8,.4,.42]];

  var FRAG="precision highp float;"+
"uniform vec2 uRes;uniform float uTime;uniform vec4 uTile;uniform vec2 uLight;uniform vec3 uGround;uniform float uSpill;uniform float uVig;"+
"uniform sampler2D uMesh;uniform vec2 uMeshSize;uniform float uReveal;uniform float uDim;uniform vec3 uTintCol;uniform float uTintAmt;"+
"float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}"+
"float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x),f.y);}"+
"float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*vnoise(p);p=p*2.02+vec2(17.,31.);a*=.5;}return v;}"+
"float sdRoundBox(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}"+
"vec4 bspline(float v){vec4 n=vec4(1.,2.,3.,4.)-v,s=n*n*n;float x=s.x,y=s.y-4.*s.x,z=s.z-4.*s.y+6.*s.x;return vec4(x,y,z,6.-x-y-z)/6.;}"+
"vec3 mesh(vec2 uv){vec2 g=clamp(uv,0.,1.)*(uMeshSize-1.);vec2 f=fract(g);g-=f;vec4 xc=bspline(f.x),yc=bspline(f.y);vec4 s=vec4(xc.xz+xc.yw,yc.xz+yc.yw);"+
"vec4 o=(g.xxyy+vec2(-.5,1.5).xyxy+vec4(xc.yw,yc.yw)/s)/uMeshSize.xxyy;vec3 a=texture2D(uMesh,o.xz).rgb,b=texture2D(uMesh,o.yz).rgb,c=texture2D(uMesh,o.xw).rgb,d=texture2D(uMesh,o.yw).rgb;"+
"float sx=s.x/(s.x+s.y),sy=s.z/(s.z+s.w);return mix(mix(d,c,sx),mix(b,a,sx),sy);}"+
"vec3 tileColor(vec2 uv,float t){vec2 w=uv+.05*(vec2(fbm(uv*2.2+vec2(0.,t*.05)),fbm(uv*2.2+vec2(5.2,-t*.04)))-.5);w-=(uLight-.5)*.03;"+
"vec3 c=mesh(w);c=mix(c,c*c*(3.-2.*c),.35);"+
"float L=dot(c,vec3(.299,.587,.114));vec3 tc=L*uTintCol/max(dot(uTintCol,vec3(.299,.587,.114)),.001);c=mix(c,tc,uTintAmt);"+
"c+=vec3(1.,.97,.9)*.04*(1.-smoothstep(0.,.45,length(uv-uLight)));return c*(1.+.015*sin(t*.9))*uDim;}"+
"void main(){vec2 fc=gl_FragCoord.xy;vec2 q=fc/uRes-.5;vec3 col=uGround*(1.-uVig*smoothstep(.2,.5,dot(q,q)));float inside=0.;"+
"vec2 b=uTile.zw;"+
"if(uReveal>.001&&b.x>1.){vec2 p=fc-uTile.xy;float r=min(.37*2.*b.x,min(b.x,b.y));float d=sdRoundBox(p,b,r);float dn=max(d,0.)/(2.*b.y);"+
"if(uSpill>.001&&dn<.4){vec2 pe=clamp(p,-b*.96,b*.96);vec3 ec=tileColor(vec2(pe.x/(2.*b.x)+.5,.5-pe.y/(2.*b.y)),uTime);"+
"col+=uSpill*uReveal*(.16*exp(-dn/.03)+.05*exp(-dn/.08))*ec*vec3(1.,.85,.55);}"+
"if(d<2.){inside=(1.-smoothstep(-1.,1.,d))*uReveal;vec2 uv=vec2(p.x/(2.*b.x)+.5,.5-p.y/(2.*b.y));vec3 tc=tileColor(uv,uTime);tc*=1.-.14*smoothstep(-.02*2.*b.x,0.,d);col=mix(col,tc,inside);}"+
"}"+
"float g=h21(fc+fract(floor(uTime*24.)*.618)*vec2(173.,311.))-.5;col+=g*mix(.022,.03,inside);col+=(h21(fc*1.7+3.1)-.5)/255.;"+
"gl_FragColor=vec4(col,1.);}";

  var cv=document.getElementById("sky"),mark=document.getElementById("mark");
  var slotA=document.getElementById("slotA"),slotB=document.getElementById("slotB"),slotC=document.getElementById("slotC");
  var doors=document.getElementById("doors"),day=document.getElementById("how"),night=document.getElementById("join");
  if(!cv||!mark||!slotA||!slotB||!slotC||!doors||!day||!night)return;
  var gl=null,U={},scale=1;
  try{gl=cv.getContext("webgl",{antialias:false,alpha:false,powerPreference:"low-power"})}catch(e){gl=null}
  function setup(){
    function sh(t,s){var o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(o));return o}
    var pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,FRAG));
    gl.bindAttribLocation(pr,0,"p");gl.linkProgram(pr);if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error("link");gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    ["uRes","uTime","uTile","uLight","uGround","uSpill","uVig","uMesh","uMeshSize","uReveal","uDim","uTintCol","uTintAmt"].forEach(function(n){U[n]=gl.getUniformLocation(pr,n)});
    gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    var bytes=[];EMBER.forEach(function(h){bytes.push(parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16))});
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,9,11,0,gl.RGB,gl.UNSIGNED_BYTE,new Uint8Array(bytes));
    [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]].forEach(function(kv){gl.texParameteri(gl.TEXTURE_2D,kv[0],kv[1])});
    gl.uniform1i(U.uMesh,0);gl.uniform2f(U.uMeshSize,9,11);
  }
  try{if(!gl)throw 0;setup();root.classList.add("gl")}catch(e){gl=null}

  function resize(){if(!gl)return;var w=innerWidth,h=innerHeight;scale=Math.min(window.devicePixelRatio||1,1.5,Math.sqrt(2.5e6/(w*h)));cv.width=Math.round(w*scale);cv.height=Math.round(h*scale);gl.viewport(0,0,cv.width,cv.height);gl.uniform2f(U.uRes,cv.width,cv.height)}
  addEventListener("resize",resize);resize();

  function clamp(v,a,b){return Math.min(b,Math.max(a,v))}
  function ss(a,b,v){var t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t)}
  function mix(a,b,t){return a+(b-a)*t}
  var S={lx:.8,ly:.15,tx:.8,ty:.15,tint:[1,1,1,0],tintT:[1,1,1,0],t0:performance.now(),frozen:0};
  var lastR=null;
  addEventListener("pointermove",function(e){var r=lastR;if(!r)return;S.tx=(e.clientX-r.l)/r.w;S.ty=(e.clientY-r.t)/r.h},{passive:true});
  var BLACK=[9,10,12],TAUPE=[96,72,62];
  var revealStart=performance.now()+(reduce?-5000:1100);

  function frame(now){
    var vh=innerHeight,y=scrollY;
    var a=slotA.getBoundingClientRect(),b=slotB.getBoundingClientRect(),c=slotC.getBoundingClientRect();
    var dTop=doors.getBoundingClientRect().top,dayR=day.getBoundingClientRect(),nTop=night.getBoundingClientRect().top;
    // phase 1: the tile stays where it was born while the page moves; phase 2: it travels into the doors
    var R1={l:a.left,t:a.top+y,w:a.width,h:a.height};
    var p=ss(vh*.95,vh*.18,dTop);var e=p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;
    var R={l:mix(R1.l,b.left,e),t:mix(R1.t,b.top,e),w:mix(R1.w,b.width,e),h:mix(R1.h,b.height,e)};
    var dusk=1-ss(vh*.2,vh*1.35,dTop);
    var dim=1-.72*ss(vh*.12,vh*.6,y)*(1-e);
    if(nTop<vh*1.02){R={l:c.left,t:c.top,w:c.width,h:c.height};dusk=0;dim=1}
    lastR=R;
    for(var i=0;i<4;i++)S.tint[i]+=(S.tintT[i]-S.tint[i])*.06;
    S.lx+=(S.tx-S.lx)*.045;S.ly+=(S.ty-S.ly)*.045;
    var rv=reduce?1:ss(0,2000,now-revealStart);
    var covered=dayR.top<=0&&dayR.bottom>=vh;
    if(gl&&!covered){
      var T=paused?S.frozen:(S.frozen=(now-S.t0)/1000+8);
      var gr=BLACK.map(function(v,i){return mix(v,TAUPE[i],dusk)/255});
      gl.uniform1f(U.uTime,T);gl.uniform4f(U.uTile,(R.l+R.w/2)*scale,cv.height-(R.t+R.h/2)*scale,R.w/2*scale,R.h/2*scale);
      gl.uniform2f(U.uLight,S.lx,S.ly);gl.uniform3f(U.uGround,gr[0],gr[1],gr[2]);gl.uniform1f(U.uSpill,dusk);gl.uniform1f(U.uVig,.1*dusk);
      gl.uniform1f(U.uReveal,rv);gl.uniform1f(U.uDim,dim);gl.uniform3f(U.uTintCol,S.tint[0],S.tint[1],S.tint[2]);gl.uniform1f(U.uTintAmt,S.tint[3]);
      gl.drawArrays(gl.TRIANGLES,0,3);
      // the wordmark rides on the tile
      var k=R.w/260;mark.style.transform="translate("+(R.l+R.w/2-mark.offsetWidth*k/2).toFixed(1)+"px,"+(R.t+R.h*.505-mark.offsetHeight*k/2).toFixed(1)+"px) scale("+k.toFixed(4)+")";
      mark.style.opacity=(rv*rv*dim).toFixed(3);
    }
    if(!gl){var g2=BLACK.map(function(v,i){return Math.round(mix(v,TAUPE[i],dusk))});document.body.style.background="rgb("+g2.join(",")+")"}
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // doors: the row nearest the middle of the screen sets the tint
  var rows=Array.prototype.slice.call(document.querySelectorAll(".door")),cap=document.getElementById("doorCap");
  function setDoor(el){rows.forEach(function(r){r.classList.toggle("on",r===el)});S.tintT=(TINTS[+el.getAttribute("data-tint")]||TINTS[0]).slice();if(cap)cap.textContent=el.getAttribute("data-cap")||""}
  if("IntersectionObserver" in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting)setDoor(en.target)})},{rootMargin:"-45% 0px -45% 0px"});
    rows.forEach(function(r){io.observe(r);r.addEventListener("pointerenter",function(){setDoor(r)});r.addEventListener("focusin",function(){setDoor(r)})});
  }

  // reveals: content is visible at rest; entering blocks get a short rise
  if(!reduce&&"IntersectionObserver" in window){
    var ro=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){en.target.classList.add("in");ro.unobserve(en.target)}})},{rootMargin:"0px 0px -10% 0px"});
    Array.prototype.forEach.call(document.querySelectorAll(".rv"),function(el){ro.observe(el)});
  }

  // motion control (hidden without JavaScript, where nothing moves after the first second)
  var mb=document.getElementById("motionBtn");
  if(mb){
    mb.hidden=false;
    if(reduce){mb.textContent="Motion off (system setting)";mb.disabled=true}
    mb.addEventListener("click",function(){paused=!paused;root.classList.toggle("still",paused);mb.setAttribute("aria-pressed",String(paused));mb.textContent=paused?"Play motion":"Pause motion"});
  }
})();
`;
