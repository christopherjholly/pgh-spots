/* Pittsburgh Spots: randomizer, polls and availability for a small crew.
   Data: spots come from venues.js. Polls, votes, availability and people live in Firebase
   (Firestore) under crews/<crew code>/..., or in this browser only when config.js is not filled in. */

const CATS = {
  coffee:{label:"Coffee", board:"Coffee run"},
  food:{label:"Restaurants", board:"Dinner"},
  cigar:{label:"Cigar lounges", board:"Cigar lounge"},
  bar:{label:"Bars", board:"Drinks"}
};
const BLOCKS = [
  {k:"am", label:"Morning", hint:"8a–12p"},
  {k:"pm", label:"Afternoon", hint:"12–5p"},
  {k:"eve", label:"Evening", hint:"5–9p"},
  {k:"late", label:"Late", hint:"9p+"}
];
const COLORS = ["#E0A100","#3F8FD2","#D2553F","#3FA66B","#9B5DE5","#E07A1F","#2BA8A8","#C2477F"];

const S = {venues:[], byId:{}, polls:[], votes:{}, avail:{}, people:{}, me:null,
  cat:"all", current:null, recent:[], tray:[], mySlots:new Set(), slotsDirty:false};
let store = null, crew = "";

const $ = s=>document.querySelector(s);
const el = (t,a={},...kids)=>{const e=document.createElement(t);for(const[k,v] of Object.entries(a)){if(k==="class")e.className=v;else if(k==="text")e.textContent=v;else if(k.startsWith("on"))e.addEventListener(k.slice(2),v);else if(v!==false&&v!=null)e.setAttribute(k,v===true?"":v)}for(const c of kids)if(c!=null)e.append(c);return e};
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ls = {get(k){try{return localStorage.getItem(k)}catch{return null}}, set(k,v){try{localStorage.setItem(k,v)}catch{}}, del(k){try{localStorage.removeItem(k)}catch{}}};
function toast(msg){const t=$("#toast");t.textContent=msg;t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,2600)}

/* ---------- data layer ---------- */
const CFG = window.FIREBASE_CONFIG || {};
const LIVE = !!(CFG.apiKey && !String(CFG.apiKey).startsWith("PASTE"));
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";

async function firebaseStore(code){
  const [{initializeApp},{getAuth,signInAnonymously},fs] = await Promise.all([
    import(SDK+"firebase-app.js"), import(SDK+"firebase-auth.js"), import(SDK+"firebase-firestore.js")]);
  const app = initializeApp(CFG);
  await signInAnonymously(getAuth(app));
  const db = fs.getFirestore(app);
  const col = c=>fs.collection(db,"crews",code,c);
  const ref = (c,id)=>fs.doc(db,"crews",code,c,id);
  // Probe once so a wrong crew code fails here, not silently later.
  await fs.getDocs(fs.query(col("people"),fs.limit(1)));
  return {
    watch:(c,cb,onErr)=>fs.onSnapshot(col(c),snap=>cb(snap.docs.map(d=>({id:d.id,...d.data()}))),onErr||(()=>{})),
    set:(c,id,data)=>fs.setDoc(ref(c,id),data),
    add:(c,data)=>fs.addDoc(col(c),data),
    update:(c,id,data)=>fs.updateDoc(ref(c,id),data),
    remove:(c,id)=>fs.deleteDoc(ref(c,id))
  };
}
function localStore(){
  const key="pgh.preview";let data={};try{data=JSON.parse(ls.get(key)||"{}")}catch{}
  const subs={};const save=()=>ls.set(key,JSON.stringify(data));
  const emit=c=>{const list=Object.entries(data[c]||{}).map(([id,v])=>({id,...v}));(subs[c]||[]).forEach(cb=>cb(list))};
  const put=(c,id,v)=>{(data[c] ||= {})[id]=v;save();emit(c)};
  return {
    watch:(c,cb)=>{(subs[c] ||= []).push(cb);setTimeout(()=>emit(c),0);return()=>{}},
    set:async(c,id,v)=>put(c,id,JSON.parse(JSON.stringify(v))),
    add:async(c,v)=>put(c,Math.random().toString(36).slice(2,10),JSON.parse(JSON.stringify(v))),
    update:async(c,id,v)=>put(c,id,{...(data[c]?.[id]||{}),...v}),
    remove:async(c,id)=>{if(data[c])delete data[c][id];save();emit(c)}
  };
}
const writeQ={};
function queued(path,fn){writeQ[path]=(writeQ[path]||Promise.resolve()).then(fn,fn);return writeQ[path]}

/* ---------- dates ---------- */
function ymd(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
function days(){const out=[],b=new Date();b.setHours(12,0,0,0);for(let i=0;i<14;i++){const d=new Date(b);d.setDate(b.getDate()+i);out.push(d)}return out}
function slotLabel(key){const [ds,bk]=key.split("_");const [y,m,d]=ds.split("-").map(Number);const dt=new Date(y,m-1,d);const b=BLOCKS.find(x=>x.k===bk);
  return dt.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})+" · "+(b?b.label:bk)}
function validSlotKeys(){const s=new Set();for(const d of days())for(const b of BLOCKS)s.add(ymd(d)+"_"+b.k);return s}

/* ---------- people ---------- */
function person(id){return S.people[id]||{name:"Someone",color:"#888"}}
function avatar(id){const p=person(id);return el("span",{class:"av",title:p.name,style:"background:"+p.color},(p.name||"?").trim().charAt(0).toUpperCase())}
function slug(s){return s.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40)||"me"}
function renderMe(){
  const b=$("#meBtn");b.textContent="";
  if(!S.me){b.hidden=true;return}
  b.hidden=false;b.append(avatar(S.me),el("span",{text:person(S.me).name}));
}
function openJoin(){
  const ov=$("#join");ov.hidden=false;
  const box=$("#joinPeople");box.textContent="";
  const ids=Object.keys(S.people).sort((a,b)=>person(a).name.localeCompare(person(b).name));
  $("#joinPick").hidden=!ids.length;
  for(const id of ids)box.append(el("button",{class:"chip",type:"button",onclick:()=>pickMe(id)},avatar(id),person(id).name));
  setTimeout(()=>$("#joinName").focus(),50);
}
function pickMe(id){S.me=id;ls.set("pgh.me."+crew,id);$("#join").hidden=true;renderMe();
  S.mySlots=new Set(S.avail[id]?.slots||[]);renderAll()}
async function joinNew(e){
  e.preventDefault();const name=$("#joinName").value.trim();if(!name)return;
  let id=slug(name);while(S.people[id]&&person(id).name.toLowerCase()!==name.toLowerCase())id+="-2";
  if(!S.people[id]){
    const used=new Set(Object.values(S.people).map(p=>p.color));
    const color=COLORS.find(c=>!used.has(c))||COLORS[Object.keys(S.people).length%COLORS.length];
    try{await store.set("people",id,{name,color,joinedAt:Date.now()});S.people[id]={name,color}}
    catch{return toast("Couldn't add you. Check the crew code in your link.")}
  }
  $("#joinName").value="";pickMe(id);
}
function needMe(){if(!S.me){openJoin();return true}return false}

/* ---------- categories ---------- */
function renderCats(){
  const box=$("#cats");box.textContent="";
  const opts=[["all","All",S.venues.length],...Object.entries(CATS).map(([k,c])=>[k,c.label,S.venues.filter(v=>v.cat===k).length])];
  for(const [k,label,n] of opts){
    box.append(el("button",{class:"chip",role:"tab","aria-pressed":S.cat===k?"true":"false","aria-selected":S.cat===k?"true":"false",onclick:()=>{
      if(S.cat===k)return;S.cat=k;S.recent=[];renderCats();renderSpots();if(!spinning&&!S.current)idleBoard()}},label,el("span",{class:"n",text:String(n)})));
  }
}
function pool(){return S.cat==="all"?S.venues:S.venues.filter(v=>v.cat===S.cat)}

/* ---------- split-flap ---------- */
const GLYPHS="ABCDEFGHIJKLMNOPQRSTUVWXYZ&0123456789";
function flapTo(text){
  const box=$("#flap");box.textContent="";
  const words=text.toUpperCase().split(/\s+/).filter(Boolean);
  const cells=[];
  for(const w of words){const we=el("span",{class:"word"});for(const ch of w){const c=el("span",{class:"fc",text:reduce?ch:" "});c.dataset.t=ch;we.append(c);cells.push(c)}box.append(we)}
  if(reduce)return Promise.resolve();
  return Promise.all(cells.map((c,i)=>new Promise(res=>{
    let n=5+Math.min(i,16)+Math.floor(Math.random()*4);
    const tick=()=>{if(n--<=0){c.textContent=c.dataset.t;c.classList.remove("go");void c.offsetWidth;c.classList.add("go");return res()}
      c.textContent=GLYPHS[Math.floor(Math.random()*GLYPHS.length)];c.classList.remove("go");void c.offsetWidth;c.classList.add("go");setTimeout(tick,48)};
    setTimeout(tick,i*18);
  })));
}
function idleBoard(){flapTo("Ready");$("#boardMeta").textContent="";
  $("#boardBlurb").textContent="Hit Spin to pick from "+(S.cat==="all"?"all "+S.venues.length+" spots":pool().length+" "+CATS[S.cat].label.toLowerCase())+"."}

function pickRandom(list,exclude){const c=list.filter(v=>!exclude.includes(v.id));const src=c.length?c:list;return src[Math.floor(Math.random()*src.length)]}
let spinning=false;
async function spin(){
  const p=pool();if(!p.length)return toast("No spots in that category");
  if(spinning)return;spinning=true;$("#spinBtn").disabled=true;
  const v=pickRandom(p,S.recent);S.recent=[v.id,...S.recent].slice(0,Math.min(5,p.length-1));S.current=v;
  $("#boardCat").textContent=CATS[v.cat].board;$("#boardHood").textContent=v.hood||"PGH";
  $("#boardMeta").textContent="";$("#boardBlurb").textContent="";$("#mapBtn").hidden=true;$("#addBtn").disabled=true;
  await flapTo(v.name);
  showCurrent();spinning=false;$("#spinBtn").disabled=false;
}
function showCurrent(){
  const v=S.current;if(!v)return;
  const m=$("#boardMeta");m.textContent="";
  m.append(el("span",{class:"gold",text:"★ "+v.rating.toFixed(1)}),el("span",{text:v.reviews.toLocaleString()+" reviews"}));
  if(v.price)m.append(el("span",{text:v.price}));
  if(v.hours)m.append(el("span",{text:v.hours}));
  $("#boardBlurb").textContent=v.blurb||"";
  const mb=$("#mapBtn");if(v.url){mb.href=v.url;mb.hidden=false}
  $("#addBtn").disabled=S.tray.includes(v.id);
}
function addToTray(id){if(S.tray.includes(id))return;if(S.tray.length>=6)return toast("Six options max per poll");S.tray.push(id);renderTray();showCurrent()}
async function quick3(){
  const p=pool();if(p.length<3)return toast("Need at least 3 spots in that category");
  const picks=[];while(picks.length<3){const v=pickRandom(p,picks);if(!picks.includes(v.id))picks.push(v.id)}
  S.tray=picks;renderTray();
  S.current=null;$("#boardCat").textContent="3-way poll";$("#boardHood").textContent="Vote below";
  await flapTo(picks.map(id=>S.byId[id].name.split(" ")[0]).join(" / "));
  $("#boardMeta").textContent="";$("#boardBlurb").textContent="Three picks dropped into the poll builder. Name it and start it.";
  $("#mapBtn").hidden=true;$("#addBtn").disabled=true;
  $("#tray").scrollIntoView({behavior:reduce?"auto":"smooth",block:"nearest"});
}

/* ---------- tray / poll create ---------- */
function renderTray(){
  const box=$("#trayItems");box.textContent="";
  if(!S.tray.length)box.append(el("span",{class:"muted",text:"Spin and hit “Add to poll”, or use “Spin 3 for a poll”."}));
  for(const id of S.tray){const v=S.byId[id];if(!v)continue;
    box.append(el("span",{class:"pill"},v.name,el("button",{type:"button","aria-label":"Remove "+v.name,onclick:()=>{S.tray=S.tray.filter(x=>x!==id);renderTray();showCurrent()}},"×")))}
  $("#pollGo").disabled=S.tray.length<2;
}
function renderWhenSelect(){
  const sel=$("#pollWhen");const cur=sel.value;sel.textContent="";
  sel.append(el("option",{value:""},"Decide later"));
  for(const r of rankSlots().slice(0,8))sel.append(el("option",{value:r.key},slotLabel(r.key)+" ("+r.ids.length+" free)"));
  if([...sel.options].some(o=>o.value===cur))sel.value=cur;
}
async function createPoll(e){
  e.preventDefault();if(needMe())return;if(S.tray.length<2)return;
  const cats=[...new Set(S.tray.map(id=>S.byId[id]?.cat))];
  const title=$("#pollTitle").value.trim()||(cats.length===1?CATS[cats[0]].board:"Crew night")+" pick";
  const btn=$("#pollGo");btn.disabled=true;
  try{await store.add("polls",{title,options:[...S.tray],when:$("#pollWhen").value||null,createdBy:S.me,createdAt:Date.now(),closed:false});
    S.tray=[];$("#pollTitle").value="";renderTray();toast("Poll started");$("#vote").scrollIntoView({behavior:reduce?"auto":"smooth"})}
  catch{toast("Couldn't start the poll. Check your connection.");btn.disabled=false}
}

/* ---------- polls ---------- */
async function vote(poll,venueId){
  if(needMe())return;
  const mine={...(S.votes[S.me]?.picks||{})};
  if(mine[poll.id]===venueId)delete mine[poll.id];else mine[poll.id]=venueId;
  S.votes[S.me]={picks:mine};renderPolls();
  try{await queued("votes/"+S.me,()=>store.set("votes",S.me,{picks:mine,at:Date.now()}))}
  catch{toast("Vote didn't save. Check your connection.")}
}
async function setClosed(poll,closed){try{await store.update("polls",poll.id,{closed})}catch{toast("Couldn't update that poll")}}
async function delPoll(poll){try{await store.remove("polls",poll.id);toast("Poll deleted")}catch{toast("Couldn't delete that poll")}}

function renderPolls(){
  const box=$("#polls");box.textContent="";
  if(!S.polls.length){box.append(el("div",{class:"notice",text:"No polls yet. Up in Spin, add two or more spots and hit Start poll."}));return}
  const tallies={};
  for(const [uid,v] of Object.entries(S.votes))for(const [pid,vid] of Object.entries(v.picks||{})){((tallies[pid] ||= {})[vid] ||= []).push(uid)}
  const sorted=[...S.polls].sort((a,b)=>(a.closed-b.closed)||(b.createdAt-a.createdAt));
  const grid=el("div",{class:"polls"});
  for(const p of sorted.slice(0,12)){
    const t=tallies[p.id]||{};const total=Object.values(t).reduce((n,a)=>n+a.length,0);
    const max=Math.max(0,...p.options.map(o=>(t[o]||[]).length));
    const myPick=S.votes[S.me]?.picks?.[p.id];
    const card=el("article",{class:"poll"+(p.closed?" closed":"")});
    card.append(el("div",{class:"poll-head"},el("div",{},el("h3",{text:p.title||"Poll"}),p.when?el("div",{class:"poll-when",text:slotLabel(p.when)}):null),
      el("span",{class:"status "+(p.closed?"done":"open"),text:p.closed?"Closed":"Open"})));
    for(const o of p.options){
      const v=S.byId[o];const voters=t[o]||[];const pct=total?Math.round(voters.length/total*100):0;
      const win=p.closed&&max>0&&voters.length===max;
      const b=el("button",{class:"opt"+(myPick===o?" mine":"")+(win?" win":""),disabled:p.closed,onclick:()=>vote(p,o)},
        el("span",{class:"fill",style:"width:"+pct+"%"}),
        el("span",{class:"nm",text:(win?"🏆 ":"")+(v?v.name:"Spot no longer listed")}),
        el("span",{class:"ct",text:String(voters.length)}),
        el("span",{class:"sub",text:v?[CATS[v.cat]?.label,v.hood,"★ "+v.rating.toFixed(1)].filter(Boolean).join(" · "):""}));
      if(voters.length){const f=el("span",{class:"faces"});for(const id of voters.slice(0,8))f.append(avatar(id));b.append(f)}
      card.append(b);
    }
    const foot=el("div",{class:"poll-foot"},el("span",{text:total+(total===1?" vote":" votes")+(p.createdBy?" · started by "+person(p.createdBy).name:"")}));
    if(S.me&&p.createdBy===S.me){const acts=el("span",{style:"display:flex;gap:12px"});
      acts.append(el("button",{class:"linkbtn",onclick:()=>setClosed(p,!p.closed)},p.closed?"Reopen":"Close & pick winner"));
      const del=el("button",{class:"linkbtn",onclick:()=>{if(del.dataset.armed){delPoll(p)}else{del.dataset.armed="1";del.textContent="Tap again to delete";setTimeout(()=>{delete del.dataset.armed;del.textContent="Delete"},3000)}}},"Delete");
      acts.append(del);foot.append(acts)}
    card.append(foot);grid.append(card);
  }
  box.append(grid);
}

/* ---------- schedule ---------- */
function rankSlots(){
  const valid=validSlotKeys();const map={};
  for(const [uid,a] of Object.entries(S.avail))for(const k of (a.slots||[]))if(valid.has(k))(map[k] ||= []).push(uid);
  return Object.entries(map).map(([key,ids])=>({key,ids})).sort((a,b)=>b.ids.length-a.ids.length||a.key.localeCompare(b.key));
}
function renderSchedule(){
  const ds=days();const ranked=rankSlots();const counts=Object.fromEntries(ranked.map(r=>[r.key,r.ids.length]));
  const crewSize=Math.max(Object.keys(S.people).length,1);
  const max=Math.max(1,...Object.values(counts));
  const best=$("#best");best.textContent="";
  if(!ranked.length)best.append(el("div",{class:"notice",style:"grid-column:1/-1",text:"No one's marked their availability yet. Tap the blocks below when you're free; the best overlaps show up here."}));
  ranked.slice(0,3).forEach((r,i)=>{
    best.append(el("div",{class:"best-card"},el("div",{class:"rank",text:i===0?"Best overlap":"Runner-up"}),el("div",{class:"when",text:slotLabel(r.key)}),
      el("div",{class:"who",text:r.ids.length+" of "+crewSize+" free: "+r.ids.map(id=>person(id).name).join(", ")})));
  });
  const tb=$("#sched");tb.textContent="";
  const hr=el("tr",{},el("th",{class:"rowh"}));
  for(const d of ds){const wk=d.getDay()===0||d.getDay()===5||d.getDay()===6;
    hr.append(el("th",{class:wk?"wk":""},d.toLocaleDateString(undefined,{weekday:"short"}),el("br"),d.toLocaleDateString(undefined,{month:"numeric",day:"numeric"})))}
  tb.append(el("thead",{},hr));
  const body=el("tbody");
  for(const b of BLOCKS){
    const tr=el("tr",{},el("th",{class:"rowh",scope:"row"},b.label,el("small",{text:b.hint})));
    for(const d of ds){const key=ymd(d)+"_"+b.k;const c=counts[key]||0;const mine=S.mySlots.has(key);
      const pct=c?Math.round(25+65*(c/max)):0;
      tr.append(el("td",{},el("button",{class:"cell"+(mine?" mine":""),"aria-pressed":mine?"true":"false","aria-label":slotLabel(key)+", "+c+" free",
        style:c?"background:color-mix(in srgb,var(--gold-fill) "+pct+"%,var(--sunk))":"",onclick:()=>toggleSlot(key)},c?String(c):"·")))}
    body.append(tr)}
  tb.append(body);
  renderWhenSelect();
}
let slotTimer=null;
function toggleSlot(key){
  if(needMe())return;
  S.mySlots.has(key)?S.mySlots.delete(key):S.mySlots.add(key);
  const valid=validSlotKeys();const slots=[...S.mySlots].filter(k=>valid.has(k)).sort();
  S.avail[S.me]={slots};S.slotsDirty=true;renderSchedule();
  const me=S.me;clearTimeout(slotTimer);slotTimer=setTimeout(async()=>{
    try{await queued("avail/"+me,()=>store.set("avail",me,{slots,at:Date.now()}));S.slotsDirty=false}
    catch{toast("Availability didn't save. Check your connection.")}
  },700);
}

/* ---------- spots ---------- */
function renderSpots(){
  const list=$("#spotList");list.textContent="";
  const vs=pool().slice().sort((a,b)=>b.rating-a.rating||b.reviews-a.reviews);
  $("#listTitle").textContent=(S.cat==="all"?"All spots":CATS[S.cat].label)+" · "+vs.length;
  for(const v of vs){
    list.append(el("article",{class:"spot"},
      S.cat==="all"?el("span",{class:"cat",text:CATS[v.cat].label}):null,
      el("div",{class:"spot-top"},el("h3",{text:v.name}),el("span",{class:"rate"},"★ "+v.rating.toFixed(1)+" ",el("small",{text:"("+v.reviews.toLocaleString()+")"}))),
      el("div",{class:"meta",text:[v.hood,v.price,v.hours].filter(Boolean).join(" · ")}),
      el("p",{text:v.blurb||""}),
      el("div",{class:"acts"},
        v.url?el("a",{href:v.url,target:"_blank",rel:"noopener"},"Maps ↗"):null,
        el("button",{class:"linkbtn",onclick:()=>{addToTray(v.id);toast(v.name+" added to the poll builder")}},"+ Add to poll"))));
  }
}
function renderStat(){
  const s=$("#stat");s.textContent="";
  s.append(el("b",{text:String(S.venues.length)})," spots");
  if(window.VENUES_UPDATED){const [y,m,d]=window.VENUES_UPDATED.split("-").map(Number);
    s.append(el("span",{class:"long",text:" · checked "+new Date(y,m-1,d).toLocaleDateString(undefined,{month:"short",day:"numeric"})}))}
}
function renderAll(){renderPolls();renderSchedule()}

/* ---------- boot ---------- */
const navLinks=[...document.querySelectorAll("nav.bar a")];
const io=new IntersectionObserver(es=>{for(const e of es)if(e.isIntersecting){navLinks.forEach(a=>a.classList.toggle("on",a.getAttribute("href")==="#"+e.target.id))}},{rootMargin:"-40% 0px -55% 0px"});
document.querySelectorAll("main section").forEach(s=>io.observe(s));

$("#spinBtn").addEventListener("click",spin);
$("#addBtn").addEventListener("click",()=>S.current&&addToTray(S.current.id));
$("#quickBtn").addEventListener("click",quick3);
$("#pollForm").addEventListener("submit",createPoll);
$("#joinForm").addEventListener("submit",joinNew);
$("#meBtn").addEventListener("click",openJoin);
$("#codeForm").addEventListener("submit",e=>{e.preventDefault();const c=$("#codeInput").value.trim();if(c){location.hash=c;location.reload()}});

S.venues=(window.VENUES||[]).filter(v=>CATS[v.cat]);
S.byId=Object.fromEntries(S.venues.map(v=>[v.id,v]));
renderCats();renderTray();idleBoard();renderSpots();renderStat();renderAll();

(async function boot(){
  const fromHash=decodeURIComponent(location.hash.slice(1)).trim();
  if(fromHash&&/^[A-Za-z0-9_-]{4,64}$/.test(fromHash)){crew=fromHash;ls.set("pgh.crew",crew)}
  else crew=ls.get("pgh.crew")||"";
  if(!LIVE){
    crew="preview";store=localStore();$("#mode").hidden=false;
  }else{
    if(!crew){$("#code").hidden=false;return}
    try{store=await firebaseStore(crew)}
    catch(err){
      console.error(err);ls.del("pgh.crew");
      $("#codeMsg").textContent=(err&&err.code==="permission-denied")?"That crew code didn't work. Check the link you were sent.":"Couldn't connect. Check your internet and reload.";
      $("#code").hidden=false;return;
    }
  }
  S.me=ls.get("pgh.me."+crew);
  let peopleLoaded=false;
  store.watch("people",list=>{
    S.people=Object.fromEntries(list.map(p=>[p.id,p]));
    if(!peopleLoaded){peopleLoaded=true;if(!S.me||!S.people[S.me]){S.me=null;openJoin()}}
    renderMe();renderAll();
  });
  store.watch("polls",list=>{S.polls=list;renderPolls()});
  store.watch("votes",list=>{S.votes=Object.fromEntries(list.map(d=>[d.id,d]));renderPolls()});
  store.watch("avail",list=>{
    S.avail=Object.fromEntries(list.map(d=>[d.id,d]));
    if(S.slotsDirty&&S.me)S.avail[S.me]={slots:[...S.mySlots]};
    else if(S.me)S.mySlots=new Set(S.avail[S.me]?.slots||[]);
    renderSchedule();
  });
})();
