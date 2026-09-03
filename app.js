import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, collection, query, where, orderBy, limit, onSnapshot, updateDoc, setDoc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app-check.js";
import { firebaseConfig, functionsRegion, recaptchaSiteKey } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
if (recaptchaSiteKey) initializeAppCheck(app, { provider: new ReCaptchaV3Provider(recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, functionsRegion);

const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const money = v => `₹${Number(v || 0).toLocaleString("en-IN")}`;
const toDate = v => v?.toDate ? v.toDate() : null;
const dateText = v => toDate(v)?.toLocaleString("en-IN", { day:"numeric", month:"short", year:"numeric", hour:"numeric", minute:"2-digit" }) || "—";
const timeAgo = v => { const d=toDate(v); if(!d)return "—"; const m=Math.max(0,Math.floor((Date.now()-d.getTime())/60000)); return m<60?`${m}m ago`:m<1440?`${Math.floor(m/60)}h ago`:`${Math.floor(m/1440)}d ago`; };
const bookingRef = id => { const raw=String(id||""); if(raw.toUpperCase().startsWith("RLT-BK-")) return raw.toUpperCase(); return `RLT-BK-${raw.slice(-6).toUpperCase()}`; };
const toast = text => { $("toast").textContent=text; $("toast").classList.add("show"); setTimeout(()=>$("toast").classList.remove("show"),2800); };
const friendly = e => { const c=e?.code||""; if(c.includes("permission-denied"))return "This owner account does not have permission for that action."; if(c.includes("failed-precondition"))return e.message?.replace(/^FirebaseError:\s*/i,"")||"This action is not allowed in the current booking state."; if(c.includes("invalid-credential"))return "Incorrect email or password."; return e?.message?.replace(/^Firebase:\s*/i,"").replace(/^FirebaseError:\s*/i,"") || "This action could not be completed."; };

const NAV = [
  ["overview","Dashboard","⌂"],
  ["bookings","Bookings","▤"],
  ["controlrooms","Live / Control","▣"],
  ["customerchats","Customer Support","◎"],
  ["reelochats","Reelo Support","◎"],
  ["reeloapprovals","Live Verification","✓"],
  ["editingapprovals","Editing Approval","✦"],
  ["reelos","Reelo Accounts","◉"],
  ["customeraccounts","Customer Accounts","◇"],
  ["content","Deliveries","□"],
  ["payments","Money","₹"],
  ["sos","Safety / SOS","△"],
  ["reports","Reports","⚑"],
  ["accounts","Deletion Requests","⌫"],
  ["settings","Audit","⚙"]
];
let activePage="overview", bookingCache=[], activeBookingId=null, drawerUnsubs=[], pageUnsub=null;
let supportCaseUnsubs=[], activeSupportCaseId=null, supportView="open", supportSoundEnabled=true, supportAudioReady=false, supportSeenUpdates=new Map();
let opsFilters={status:"all",delivery:"all",payment:"all",package:"all",attention:false,date:"all"};

$("nav").innerHTML=NAV.map(([id,label,icon])=>`<button class="nav-button" data-page="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`).join("");
$("nav").onclick=e=>{const b=e.target.closest("[data-page]");if(b)loadPage(b.dataset.page);};
$("sign-out").onclick=()=>signOut(auth);
$("forgot-password").onclick=async()=>{const email=$("email").value.trim();if(!email)return setAuth("Enter your admin email first.");try{await sendPasswordResetEmail(auth,email);setAuth("Password reset email sent.",false);}catch(e){setAuth(friendly(e));}};
$("login-form").onsubmit=async e=>{e.preventDefault();setAuth("Signing in…",false);try{await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value);}catch(err){setAuth(friendly(err));}};
$("close-drawer").onclick=closeDrawer;
$("close-modal").onclick=()=>$("modal").close();
$("modal").onclick=e=>{if(e.target===$("modal"))$("modal").close();};
$("search-button").onclick=runGlobalSearch;
$("global-search").addEventListener("keydown",e=>{if(e.key==="Enter")runGlobalSearch();});
$("refresh-all").onclick=()=>loadPage(activePage);
$("open-filters").onclick=openFilters;
function openFilters(){
  modal("Filters",`<div class="filter-modal-grid">
    <label class="field">Date<select id="f-date"><option value="all">Any date</option><option value="today">Today</option><option value="7d">Last 7 days</option></select></label>
    <label class="field">Booking status<select id="f-status"><option value="all">Any status</option><option value="searching">Searching</option><option value="accepted">Accepted</option><option value="arrived">Arrived</option><option value="in_progress">Live / in progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label>
    <label class="field">Package<select id="f-package"><option value="all">Any package</option><option value="originals">Originals</option><option value="edited">Edited & Reel-ready</option></select></label>
    <label class="field">Delivery<select id="f-delivery"><option value="all">Any delivery state</option><option value="pending_upload">Pending upload</option><option value="uploading">Uploading</option><option value="approval">Pending approval</option></select></label>
    <label class="field">Payment<select id="f-payment"><option value="all">Any payment state</option><option value="paid">Paid / captured</option><option value="issue">Payment issue</option></select></label>
    <label class="filter-check"><input id="f-attention" type="checkbox"> <span>Needs attention only</span></label>
  </div><div class="modal-actions"><button class="btn secondary" id="reset-filters">Reset</button><button class="btn primary" id="apply-filters">Apply filters</button></div>`);
  $("f-date").value=opsFilters.date;$("f-status").value=opsFilters.status;$("f-package").value=opsFilters.package;$("f-delivery").value=opsFilters.delivery;$("f-payment").value=opsFilters.payment;$("f-attention").checked=opsFilters.attention;
  $("reset-filters").onclick=()=>{opsFilters={status:"all",delivery:"all",payment:"all",package:"all",attention:false,date:"all"};$("modal").close();updateFilterBadge();loadPage(activePage);};
  $("apply-filters").onclick=()=>{opsFilters={date:$("f-date").value,status:$("f-status").value,package:$("f-package").value,delivery:$("f-delivery").value,payment:$("f-payment").value,attention:$("f-attention").checked};$("modal").close();updateFilterBadge();loadPage(activePage);};
}
function updateFilterBadge(){const n=Object.entries(opsFilters).filter(([k,v])=>k==="attention"?v:v!=="all").length;const el=$("filter-count");if(el)el.textContent=n?`(${n})`:"";}
if($("today-chip")) $("today-chip").textContent=new Date().toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});
function setAuth(text,error=true){$("auth-message").textContent=text;$("auth-message").style.color=error?"#d73a49":"#12885f";}

onAuthStateChanged(auth,async user=>{
  if(!user){$("app-view").classList.add("hidden");$("auth-view").classList.remove("hidden");return;}
  try{
    const admin=await getDoc(doc(db,"admins",user.uid));
    if(!admin.exists()||admin.data().active!==true){await signOut(auth);return setAuth("This account is not an active Reel It administrator.");}
    $("auth-view").classList.add("hidden");$("app-view").classList.remove("hidden");$("admin-email").textContent=user.email||"Owner";
    await loadPage(activePage);
  }catch(e){await signOut(auth);setAuth(friendly(e));}
});

const PAGE_META={
  overview:["Command Center","Bookings, support, delivery, money and safety at a glance"],bookings:["Bookings","All bookings and lifecycle states"],controlrooms:["Control Rooms","Bookings that need direct operational intervention"],customerchats:["Customer Chats","Human support conversations from customers, linked to bookings"],reelochats:["Reelo Chats","Human support conversations from Reelos, linked to bookings"],
  reeloapprovals:["Live Verification","Review live profile selfies and activate Reelos"],editingapprovals:["Editing Approval","Review Reelo portfolios before Edited jobs are unlocked"],reelos:["Reelo Accounts","Search, review and operate Reelo accounts"],customeraccounts:["Customer Accounts","Search, review and operate customer accounts"],earnings:["Earnings","Reelo earnings and payout readiness"],content:["Deliveries","Pending uploads, delivery reviews and disputes"],payments:["Money","Customer charges, Reelo earnings and payout exceptions"],refunds:["Refunds","Refund requests and provider exceptions"],
  sos:["SOS Alerts","Safety alerts requiring immediate attention"],reports:["Reports","User reports and trust & safety cases"],feedback:["Feedback","Customer and Reelo feedback"],accounts:["Accounts","Deletion requests and account operations"],settings:["Settings","Admin audit and system controls"]
};
async function loadPage(id){
  if(pageUnsub){pageUnsub();pageUnsub=null;} clearSupportCaseStreams(); closeDrawer(false);activePage=id;document.querySelectorAll("[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===id));
  const [title,sub]=PAGE_META[id]||["Operations",""];$("page-title").textContent=title;$("page-subtitle").textContent=sub;$("content").innerHTML='<div class="loading">Loading live operations…</div>';
  try{if(id==="overview")await loadOverview();else if(id==="bookings"||id==="controlrooms")await loadBookings();else if(id==="customerchats")await loadSupport("customer");else if(id==="reelochats")await loadSupport("reelo");else if(id==="reeloapprovals")await loadReeloApprovals();else if(id==="editingapprovals")await loadEditingApprovals();else if(id==="reelos")await loadReelos();else if(id==="customeraccounts")await loadCustomerAccounts();else if(id==="content")await loadContent();else if(id==="payments"||id==="earnings")await loadPayments();else if(id==="refunds")await loadRefunds();else if(id==="sos")await loadSOS();else if(id==="reports"||id==="feedback")await loadReports();else if(id==="accounts")await loadAccounts();else if(id==="settings")await loadAudit();}
  catch(e){$("content").innerHTML=`<div class="panel"><div class="empty"><strong>Could not load this section.</strong><br><span class="sub">${esc(friendly(e))}</span><br><br><button class="btn secondary" id="retry">Try again</button></div></div>`;$("retry").onclick=()=>loadPage(id);}
}

function deliveryState(x){
  if(x.deliveryDisputed===true)return {key:"dispute",label:"Disputed",tone:"red",detail:"Payout paused"};
  if(x.deliveryStatus==="customer_confirmed")return {key:"confirmed",label:"Accepted",tone:"green",detail:"Customer confirmed"};
  if(x.deliveryStatus==="delivered")return {key:"approval",label:"Pending approval",tone:"blue",detail:"Waiting for customer"};
  if(x.deliveryStatus==="uploading")return {key:"uploading",label:"Uploading",tone:"orange",detail:"Reelo uploading"};
  if(x.status==="completed" || x.deliveryStatus==="pending_upload")return {key:"pending_upload",label:"Pending upload",tone:"orange",detail:deadlineText(x)};
  return {key:"none",label:"Not started",tone:"",detail:"—"};
}
function deadlineText(x){const d=toDate(x.deliveryDueAt||x.deliveryDeadline);if(!d)return x.deliveryType==="edited"?"48h delivery":"24h delivery";const diff=d.getTime()-Date.now();if(diff<0){const h=Math.ceil(Math.abs(diff)/3600000);return `${h}h overdue`;}const h=Math.floor(diff/3600000),m=Math.floor((diff%3600000)/60000);return `Due in ${h}h ${m}m`;}
function sessionState(x){const map={searching:["Searching","blue"],accepted:["Accepted","blue"],arrived:["Arrived","orange"],in_progress:["In progress","orange"],completed:["Completed","green"],cancelled:["Cancelled","red"],payment_pending:["Payment pending","orange"]};const [label,tone]=map[x.status]||[String(x.status||"Unknown").replaceAll("_"," "),""];return {label,tone};}
function paymentState(x){if(["captured","paid"].includes(x.paymentStatus))return {label:"Paid",tone:"green"};if(["failed","manual_review_required"].includes(x.paymentStatus)||x.operationalAttentionType==="payment_review")return {label:"Review",tone:"red"};return {label:String(x.paymentStatus||"Pending").replaceAll("_"," "),tone:"orange"};}
function needsAttention(x){const del=deliveryState(x);if(x.deliveryDisputed===true)return true;if(del.key==="pending_upload"&&del.detail.includes("overdue"))return true;if(x.paymentStatus==="failed"||x.refundStatus==="manual_review_required"||x.operationalAttention===true)return true;if(x.status==="searching"&&toDate(x.requestExpiresAt)?.getTime()<Date.now())return true;if(x.status==="completed"&&!x.deliveryStatus)return true;return false;}
function statusHtml(label,tone=""){return `<span class="status ${tone}"><i class="dot"></i>${esc(label)}</span>`;}
function bookingSearchText(id,x){return [id,bookingRef(id),x.bookingRef,x.bookingReference,x.occasion,x.customerName,x.customerEmail,x.customerPhone,x.customerRef,x.customerId,x.reeloName,x.reeloEmail,x.reeloPhone,x.reeloRef,x.reeloId,x.paymentReference,x.razorpayOrderId,x.razorpayPaymentId,x.payoutReference,x.location,x.address].filter(Boolean).join(" ").toLowerCase();}
function initials(name){return String(name||"?").trim().split(/\s+/).slice(0,2).map(x=>x[0]?.toUpperCase()||"").join("")||"?";}
function avatarHtml(name,url="",cls=""){return `<span class="person-avatar ${cls}">${url?`<img src="${esc(url)}" alt="">`:esc(initials(name))}</span>`;}
function applyOpsFilters(rows){const now=new Date();return rows.filter(x=>{if(opsFilters.status!=="all"&&String(x.status||"")!==opsFilters.status)return false;const d=deliveryState(x);if(opsFilters.delivery!=="all"&&d.key!==opsFilters.delivery)return false;const p=paymentState(x);if(opsFilters.payment==="paid"&&p.tone!=="green")return false;if(opsFilters.payment==="issue"&&p.tone!=="red")return false;if(opsFilters.package!=="all"&&String(x.deliveryType||"originals")!==opsFilters.package)return false;if(opsFilters.attention&&!needsAttention(x))return false;if(opsFilters.date!=="all"){const dt=toDate(x.scheduledDateTime||x.createdAt);if(!dt)return false;const start=new Date(now);start.setHours(0,0,0,0);if(opsFilters.date==="today"&&dt<start)return false;if(opsFilters.date==="7d"&&dt<new Date(now.getTime()-7*86400000))return false;}return true;});}

async function fetchBookings(){const snap=await getDocs(query(collection(db,"bookings"),orderBy("updatedAt","desc"),limit(250)));bookingCache=snap.docs.map(d=>({id:d.id,...d.data()}));return bookingCache;}
async function loadOverview(){
  const [bookings,supportSnap,profilesSnap,sosSnap]=await Promise.all([fetchBookings(),getDocs(collection(db,"support_threads")),getDocs(collection(db,"reelo_profiles")),getDocs(query(collection(db,"sos_alerts"),where("status","in",["active","acknowledged","escalated"]))) ]);
  const today=new Date();today.setHours(0,0,0,0);
  const filtered=applyOpsFilters(bookings);
  const todayBookings=bookings.filter(x=>toDate(x.createdAt)?.getTime()>=today.getTime());
  const paymentsToday=todayBookings.filter(x=>["captured","paid"].includes(x.paymentStatus)).reduce((sum,x)=>sum+Number(x.customerPrice||x.price||0),0);
  const online=profilesSnap.docs.filter(d=>d.data().availability==="Online").length;
  const pending=bookings.filter(x=>deliveryState(x).key==="pending_upload").length;
  const overdue=bookings.filter(x=>deliveryState(x).detail.includes("overdue")).length;
  const attentionRows=bookings.filter(needsAttention).slice(0,6);
  const supportRows=supportSnap.docs.map(d=>({id:d.id,...d.data()})).filter(t=>t.humanRequested===true||["waiting","active","needs_human","open"].includes(t.status)).sort((a,b)=>(b.updatedAt?.seconds||0)-(a.updatedAt?.seconds||0));
  const supportTop=supportRows.slice(0,5);
  const liveRows=bookings.filter(x=>["accepted","arrived","in_progress"].includes(x.status)).slice(0,5);
  const attentionTotal=attentionRows.length+supportRows.length+sosSnap.size;
  const issueCards=[...attentionRows.map(x=>({kind:"booking",bookingId:x.id,title:deliveryState(x).detail.includes("overdue")?"Delivery overdue":paymentState(x).tone==="red"?"Payment needs review":"Booking needs attention",person:x.reeloName||x.customerName||"Booking",role:x.reeloName?"Reelo":"Customer",detail:`${x.customerName||"Customer"} ↔ ${x.reeloName||"Not assigned"} · ${x.occasion||"Booking"}`,time:dateText(x.scheduledDateTime||x.updatedAt||x.createdAt),tone:"red",photo:x.reeloPhotoUrl||x.customerPhotoUrl||""})),...supportTop.map(t=>{const b=bookings.find(x=>x.id===t.bookingId);const isReelo=(t.userRole||"customer")==="reelo";return {kind:"support",threadId:t.id,bookingId:t.bookingId,title:t.lastIntent||"Support message",person:isReelo?(b?.reeloName||t.userName||t.userEmail||"Reelo"):(b?.customerName||t.userName||t.userEmail||"Customer"),role:isReelo?"Reelo":"Customer",detail:t.lastMessage||"Human help requested",time:timeAgo(t.updatedAt),tone:t.unreadBySupport?"orange":"blue",photo:isReelo?(b?.reeloPhotoUrl||""):(b?.customerPhotoUrl||"")};})].slice(0,7);
  $("content").innerHTML=`${metricsHtml([{label:"Today's bookings",value:todayBookings.length,icon:"▣",sub:"Created today"},{label:"Customer payments today",value:money(paymentsToday),icon:"₹",sub:"Captured customer payments",good:true},{label:"Reelos online",value:online,icon:"◎",sub:"Available now",good:true},{label:"Pending upload",value:pending,icon:"⇧",sub:"Content still owed",warn:pending>0},{label:"Overdue deliveries",value:overdue,icon:"!",sub:"Past target",warn:overdue>0},{label:"Needs attention",value:attentionTotal,icon:"!",sub:"Bookings + support + safety",warn:attentionTotal>0}])}
  <div class="ops-home-grid">
    <section class="panel attention-panel"><div class="panel-head"><div><h3>Needs your attention</h3><p>People and problems first — IDs stay secondary.</p></div><button class="text-link" data-go="bookings">View all</button></div><div class="attention-list">${issueCards.length?issueCards.map(i=>`<article class="attention-item">${avatarHtml(i.person,i.photo,i.role==='Reelo'?'reelo':'customer')}<div class="attention-copy"><span class="issue-label ${i.tone}">${esc(i.title)}</span><strong>${esc(i.person)}</strong><small>${esc(i.role)} · ${esc(i.detail)}</small><small>${esc(i.time)}</small></div><button class="btn secondary" ${i.bookingId?`data-booking="${esc(i.bookingId)}"`:i.threadId?`data-support="${esc(i.threadId)}"`:''}>Open</button></article>`).join(""):'<div class="empty">Nothing urgent right now.</div>'}</div></section>
    <div class="home-stack">
      <section class="panel"><div class="panel-head"><div><h3>Live / active sessions</h3><p>Who is currently assigned or shooting.</p></div><button class="text-link" data-go="controlrooms">View all</button></div><div class="live-list">${liveRows.length?liveRows.map(x=>`<article class="live-item"><div class="pair-avatars">${avatarHtml(x.customerName||"Customer",x.customerPhotoUrl||"","customer")}${avatarHtml(x.reeloName||"Reelo",x.reeloPhotoUrl||"","reelo")}</div><div><strong>${esc(x.customerName||"Customer")} <span>↔</span> ${esc(x.reeloName||"Not assigned")}</strong><small>${esc(x.occasion||"Booking")} · ${esc(x.durationMinutes||0)} min · ${esc(sessionState(x).label)}</small><small>${esc(bookingRef(x.id))}</small></div><button class="btn secondary" data-booking="${esc(x.id)}">Open</button></article>`).join(""):'<div class="empty compact">No active sessions.</div>'}</div></section>
      <section class="panel"><div class="panel-head"><div><h3>Support waiting</h3><p>Customer and Reelo chats needing a human.</p></div><div class="split-links"><button class="text-link" data-go="customerchats">Customers</button><button class="text-link" data-go="reelochats">Reelos</button></div></div><div class="support-mini">${supportTop.length?supportTop.map(t=>{const b=bookings.find(x=>x.id===t.bookingId);const reelo=(t.userRole||"customer")==="reelo";const name=reelo?(b?.reeloName||t.userName||t.userEmail||"Reelo"):(b?.customerName||t.userName||t.userEmail||"Customer");return `<button class="support-mini-row" data-support="${esc(t.id)}"><span>${avatarHtml(name,reelo?b?.reeloPhotoUrl:b?.customerPhotoUrl,reelo?'reelo':'customer')}</span><span><strong>${esc(name)}</strong><small>${esc(t.lastMessage||"Human help requested")}</small></span><em>${esc(timeAgo(t.updatedAt))}</em></button>`;}).join(""):'<div class="empty compact">No support chats waiting.</div>'}</div></section>
    </div>
  </div>
  <div class="section-title-inline"><div><h2>Bookings</h2><p>Search and filter by person, phone, booking, package, delivery or payment.</p></div></div><div id="booking-panel"></div>`;
  renderBookingPanel(filtered,"all");
  document.querySelectorAll("[data-go]").forEach(a=>a.onclick=()=>loadPage(a.dataset.go));
  document.querySelectorAll("[data-booking]").forEach(b=>b.onclick=()=>openBooking(b.dataset.booking));
  document.querySelectorAll("[data-support]").forEach(b=>b.onclick=()=>openSupportThread(b.dataset.support));
}
function metricsHtml(items){return `<div class="metrics">${items.map(i=>`<div class="metric"><div class="metric-head"><span class="metric-icon">${i.icon}</span>${esc(i.label)}</div><strong>${esc(i.value)}</strong><small class="${i.good?'good':i.warn?'warn':''}">${esc(i.sub)}</small></div>`).join("")}</div>`;}
function renderBookingPanel(bookings,initial="all"){
  bookings=applyOpsFilters(bookings);
  const counts={all:bookings.length,pending_upload:bookings.filter(x=>deliveryState(x).key==="pending_upload").length,approval:bookings.filter(x=>deliveryState(x).key==="approval").length,payment:bookings.filter(x=>paymentState(x).tone==="red").length,cancelled:bookings.filter(x=>x.status==="cancelled").length,attention:bookings.filter(needsAttention).length};
  $("booking-panel").innerHTML=`<section class="panel"><div class="filter-tabs">${[["all","All"],["pending_upload","Pending Upload"],["approval","Pending Approval"],["payment","Payment Issues"],["cancelled","Cancellations"],["attention","Needs Attention"]].map(([k,l])=>`<button class="filter-tab ${k===initial?'active':''}" data-filter="${k}">${l}<b>${counts[k]||0}</b></button>`).join("")}</div><div class="table-tools"><div class="mini-search"><span>⌕</span><input id="booking-search" placeholder="Search booking ID, customer, Reelo, email, payment ID…"></div><button class="btn secondary" id="table-refresh">▥ Columns</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Booking</th><th>Customer</th><th>Reelo</th><th>Session</th><th>Delivery</th><th>Payment</th><th>Status</th><th>Actions</th></tr></thead><tbody id="booking-rows"></tbody></table></div><div class="table-footer"><span id="table-count">Showing bookings</span><div class="pager"><span>‹</span><span class="active">1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>›</span></div><span>10 / page ⌄</span></div></section>`;
  let filter=initial,term="";const apply=()=>{let rows=bookings;if(filter==="pending_upload")rows=rows.filter(x=>deliveryState(x).key==="pending_upload");else if(filter==="approval")rows=rows.filter(x=>deliveryState(x).key==="approval");else if(filter==="payment")rows=rows.filter(x=>paymentState(x).tone==="red");else if(filter==="cancelled")rows=rows.filter(x=>x.status==="cancelled");else if(filter==="attention")rows=rows.filter(needsAttention);if(term)rows=rows.filter(x=>bookingSearchText(x.id,x).includes(term));const shown=rows.slice(0,100);renderBookingRows(shown);if($("table-count"))$("table-count").textContent=`Showing 1 to ${Math.min(shown.length,10)} of ${rows.length} bookings`;};
  document.querySelectorAll("[data-filter]").forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll("[data-filter]").forEach(x=>x.classList.toggle("active",x===b));apply();});$("booking-search").oninput=e=>{term=e.target.value.trim().toLowerCase();apply();};$("table-refresh").onclick=()=>toast("Column controls are coming next; all operational columns are visible now.");apply();
}
function renderBookingRows(rows){
  const body=$("booking-rows");if(!rows.length){body.innerHTML='<tr><td colspan="8"><div class="empty">No bookings match this view.</div></td></tr>';return;}
  body.innerHTML=rows.map(x=>{const del=deliveryState(x),ses=sessionState(x),pay=paymentState(x),att=needsAttention(x);const customer=x.customerName||x.customerEmail||"Customer";const reelo=x.reeloName||x.reeloEmail||"Not assigned";return `<tr>
    <td><button class="booking-link booking-primary" data-booking="${esc(x.id)}">${esc(x.occasion||"Booking")}</button><span class="sub">${esc(bookingRef(x.id))}</span></td>
    <td><div class="table-person">${avatarHtml(customer,x.customerPhotoUrl||"","customer")}<span><strong>${esc(customer)}</strong><small>${esc(x.customerPhone||x.customerEmail||x.customerRef||"")}</small></span></div></td>
    <td><div class="table-person">${avatarHtml(reelo,x.reeloPhotoUrl||"","reelo")}<span><strong>${esc(reelo)}</strong><small>${esc(x.reeloPhone||x.reeloEmail||x.reeloRef||"")}</small></span></div></td>
    <td><strong>${esc(dateText(x.scheduledDateTime||x.createdAt))}</strong><span class="sub">${esc(x.durationMinutes||0)} min · ${esc(x.deliveryType==='edited'?'Edited':'Originals')}</span></td>
    <td>${statusHtml(del.label,del.tone)}<span class="sub">${esc(del.detail)}</span></td>
    <td><span class="amount">${money(x.customerPrice||x.price)}</span><span class="sub ${pay.tone==='green'?'good':''}">${esc(pay.label)}</span></td>
    <td>${att?statusHtml("Needs attention","red"):statusHtml(ses.label,ses.tone)}</td>
    <td><div class="actions-cell"><button class="btn secondary" data-booking="${esc(x.id)}">Open</button><button class="icon-btn" data-booking="${esc(x.id)}">⋮</button></div></td></tr>`;}).join("");
  body.querySelectorAll("[data-booking]").forEach(b=>b.onclick=()=>openBooking(b.dataset.booking));
}

async function loadBookings(){const bookings=applyOpsFilters(await fetchBookings());$("content").innerHTML='<div id="booking-panel"></div>';renderBookingPanel(bookings,"all");}

async function openBooking(id,tab="overview"){
  clearDrawerStreams();activeBookingId=id;const snap=await getDoc(doc(db,"bookings",id));if(!snap.exists())return toast("Booking not found.");const x={id,...snap.data()};
  $("drawer-title").textContent=`${bookingRef(id)} · ${x.occasion||"Booking"}`;$("drawer").classList.add("open");$("drawer").setAttribute("aria-hidden","false");
  await renderDrawer(x,tab);
}
function closeDrawer(clear=true){$("drawer").classList.remove("open");$("drawer").setAttribute("aria-hidden","true");clearDrawerStreams();if(clear)activeBookingId=null;}
function clearDrawerStreams(){drawerUnsubs.forEach(fn=>{try{fn();}catch{}});drawerUnsubs=[];}
async function renderDrawer(x,tab){
  const [profileSnap,customerUserSnap,reeloUserSnap,threadsSnap]=await Promise.all([
    x.reeloId?getDoc(doc(db,"reelo_profiles",x.reeloId)):Promise.resolve(null),
    x.customerId?getDoc(doc(db,"users",x.customerId)):Promise.resolve(null),
    x.reeloId?getDoc(doc(db,"users",x.reeloId)):Promise.resolve(null),
    getDocs(query(collection(db,"support_threads"),where("bookingId","==",x.id)))
  ]);
  const profile=profileSnap?.exists()?profileSnap.data():{};
  const customerUser=customerUserSnap?.exists()?customerUserSnap.data():{};
  const reeloUser=reeloUserSnap?.exists()?reeloUserSnap.data():{};
  const threads=threadsSnap.docs.map(d=>({id:d.id,...d.data()}));
  const customerThread=threads.find(t=>t.userRole==="customer"||t.userId===x.customerId)||null;
  const reeloThread=threads.find(t=>t.userRole==="reelo"||t.userId===x.reeloId)||null;
  const tabs=[['overview','Booking Control'],['bookingchat','Booking Chat'],['customer','Customer Support'],['reelo','Reelo Support'],['files','Files'],['timeline','Timeline']];
  const ses=sessionState(x);
  $("drawer-body").innerHTML=`<div class="drawer-booking-summary"><div><strong>${bookingRef(x.id)}</strong> ${statusHtml(ses.label,ses.tone)}<span>${esc(x.occasion||"Booking")} · ${dateText(x.scheduledDateTime||x.createdAt)}</span></div><button class="copy-ref" id="copy-booking-ref">Copy ID</button></div><div class="drawer-tabs">${tabs.map(([k,l])=>`<button class="drawer-tab ${tab===k?'active':''}" data-dtab="${k}">${l}${k==='customer'&&customerThread?.unreadBySupport?' •':''}${k==='reelo'&&reeloThread?.unreadBySupport?' •':''}</button>`).join("")}</div><div id="drawer-tab-content"></div>`;
  $("copy-booking-ref").onclick=async()=>{try{await navigator.clipboard.writeText(x.id);toast("Booking ID copied.");}catch{toast(x.id);}};
  document.querySelectorAll("[data-dtab]").forEach(b=>b.onclick=()=>renderDrawer(x,b.dataset.dtab));
  const people={profile,customerUser,reeloUser};
  if(tab==="overview")renderOverviewTab(x,people);else if(tab==="bookingchat")await renderBookingChatTab(x,people);else if(tab==="timeline")renderTimelineTab(x);else if(tab==="files")await renderFilesTab(x);else if(tab==="customer")await renderChatTab(x,customerThread,"customer",people);else if(tab==="reelo")await renderChatTab(x,reeloThread,"reelo",people);
}
function renderOverviewTab(x,people){
  const {profile={},customerUser={},reeloUser={}}=people||{};
  const del=deliveryState(x),ses=sessionState(x),pay=paymentState(x),availability=profile.availability||"Unknown";
  const deliveryPending=del.key==="pending_upload"||del.key==="uploading";
  const customerPhone=customerUser.phone||x.customerPhone||"—";
  const reeloPhone=profile.phone||reeloUser.phone||x.reeloPhone||"—";
  const reeloEarn=x.reeloEarnings??x.earnings??0;
  const payoutStatus=x.payoutStatus||x.reeloPayoutStatus||(x.earningsEligibleAt?"Eligible / awaiting payout":"Not eligible yet");
  const providerRef=x.paymentReference||x.razorpayPaymentId||x.razorpayOrderId||"—";
  const forceStatuses=["searching","accepted","arrived","in_progress","completed","cancelled"];
  $("drawer-tab-content").innerHTML=`
  <section class="drawer-section control-identity"><div class="section-title-row"><h3>People</h3><span class="micro">Private Operations data</span></div><div class="people-grid"><div class="person-card"><span class="role-pill customer">Customer</span><strong>${esc(x.customerName||customerUser.name||customerUser.displayName||x.customerEmail||"Customer")}</strong><span>${esc(x.customerEmail||customerUser.email||"—")}</span><span>${esc(customerPhone)}</span><small>${esc(x.customerRef||x.customerId||"—")}</small></div><div class="person-card"><span class="role-pill reelo">Reelo</span><strong>${esc(x.reeloName||profile.name||reeloUser.name||x.reeloEmail||"Not assigned")}</strong><span>${esc(x.reeloEmail||profile.email||reeloUser.email||"—")}</span><span>${esc(reeloPhone)}</span><small>${esc(x.reeloRef||profile.reeloRef||x.reeloId||"—")}</small></div></div></section>
  <section class="drawer-section"><div class="section-title-row"><h3>Booking</h3><strong class="mono">${esc(x.id)}</strong></div><div class="kv-list">${kv("Session",dateText(x.scheduledDateTime||x.createdAt)+` · ${x.durationMinutes||0} min`)}${kv("Location",x.location||x.address||"—")}${kv("Package",`${x.deliveryType==='edited'?'Edited & Reel-ready':'Originals'} · ${x.occasion||'Booking'}`)}${kv("Recording device",String(x.captureDeviceResolved||x.captureDeviceStatus||"Not confirmed").replaceAll("_"," "))}${kv("Customer total",money(x.customerPrice||x.price))}${kv("Reelo earning",money(reeloEarn))}</div></section>
  <section class="drawer-section money-card"><div class="section-title-row"><h3>Money trail</h3>${statusHtml(pay.label,pay.tone)}</div><div class="money-grid"><div><span>Customer charge</span><strong>${money(x.customerPrice||x.price)}</strong><small>${esc(x.paymentStatus||"pending")}</small></div><div><span>Reelo earning</span><strong>${money(reeloEarn)}</strong><small>${x.earningsEligibleAt?'Eligible':'Pending fulfillment / hold'}</small></div><div><span>Payout</span><strong>${esc(payoutStatus)}</strong><small>${x.payoutReference?esc(x.payoutReference):'No payout reference yet'}</small></div></div><div class="provider-ref"><span>Payment reference</span><code>${esc(providerRef)}</code></div>${x.refundStatus?`<div class="provider-ref"><span>Refund</span><strong>${esc(x.refundStatus)} ${x.refundAmount?`· ${money(x.refundAmount)}`:''}</strong></div>`:''}</section>
  <section class="drawer-section"><h3>Status & actions</h3><div class="state-stack"><div class="state-row"><span>Session status</span>${statusHtml(ses.label,ses.tone)}</div><div class="state-row"><span>Delivery status</span><span>${statusHtml(del.label,del.tone)} <small>${esc(del.detail)}</small></span></div><div class="state-row"><span>Reelo availability</span>${statusHtml(availability,availability==="Online"?"green":availability==="Busy"?"orange":"")}</div><div class="state-row"><span>Earnings</span>${x.earningsEligibleAt?statusHtml("Eligible","green"):statusHtml("Pending","orange")}</div>${x.deliveryDueAt?`<div class="state-row"><span>Delivery target</span><strong>${esc(dateText(x.deliveryDueAt))}</strong></div>`:""}</div>
  <div class="force-control"><label>Force booking status<select id="force-status"><option value="">Choose permitted status…</option>${forceStatuses.map(v=>`<option value="${v}">${v.replaceAll('_',' ')}</option>`).join('')}</select></label><p>This is an emergency Operations override. Every change requires a reason and is written to the admin audit log.</p></div>
  <div class="reason-box"><textarea id="owner-reason" placeholder="Reason required for state-changing actions"></textarea></div><div class="action-stack"><button class="btn danger" id="force-status-button">Apply forced status</button>${x.deliveryDueAt&&!['delivered','customer_confirmed','customer_device_completed'].includes(x.deliveryStatus)?actionBtn("extend12","Extend delivery +12h","Support-approved delivery extension. Customer is notified.","secondary")+actionBtn("extend24","Extend delivery +24h","Support-approved delivery extension. Customer is notified.","secondary"):""}${["accepted","arrived","in_progress"].includes(x.status)?actionBtn("force_end_session","Force End Session → Pending Upload","Use if the physical session is stuck. Reelo goes Online.","primary"):""}${x.status==="completed"&&!['delivered','customer_confirmed'].includes(x.deliveryStatus)?actionBtn("move_to_pending_delivery","Repair → Pending Upload","Use if the session ended but delivery state is wrong.","warning"):""}${x.reeloId?actionBtn("mark_online","Mark Reelo Online","Emergency availability recovery only.","success"):""}${x.reeloId&&deliveryPending?actionBtn("notify_upload","Request Upload","Send the Reelo a content reminder.","secondary"):""}${["accepted","arrived"].includes(x.status)?actionBtn("return_to_search","Return to Matching","Release current Reelo and search again.","warning"):""}${paymentState(x).tone==="red"?actionBtn("flag_payment_review","Flag Payment Review","Keep payment under Operations review.","warning"):""}${["pending","failed","order_created"].includes(x.paymentStatus)?actionBtn("cancel_unpaid","Cancel Unpaid Booking","Only for a booking that has not started.","danger"):""}</div></section>
  <section class="drawer-section"><h3>Operations note</h3><div class="chat-compose"><textarea id="ops-note" placeholder="Internal note — customers and Reelos cannot see this"></textarea><button class="btn primary" id="save-note">Add</button></div></section>`;
  document.querySelectorAll("[data-owner-action]").forEach(b=>b.onclick=()=>ownerAction(x,b.dataset.ownerAction));
  $("force-status-button").onclick=()=>forceBookingStatus(x);
  $("save-note").onclick=()=>saveNote(x.id);
}
async function forceBookingStatus(x){
  const targetStatus=$("force-status")?.value||"";
  const reason=$("owner-reason")?.value.trim()||"";
  if(!targetStatus)return toast("Choose a status first.");
  if(reason.length<5)return toast("Add a short reason first.");
  if(!confirm(`Force ${bookingRef(x.id)} from ${x.status||'unknown'} to ${targetStatus}?`))return;
  try{await httpsCallable(functions,"adminForceBookingStatus")({bookingId:x.id,targetStatus,reason});toast("Booking status updated and audited.");await openBooking(x.id,"overview");if(["overview","bookings","controlrooms","content","payments"].includes(activePage))setTimeout(()=>loadPage(activePage),300);}catch(e){toast(friendly(e));}
}
function kv(label,value){return `<div class="kv"><span>${esc(label)}</span><strong>${esc(value??"—")}</strong></div>`;}
function actionBtn(action,title,desc,kind){return `<button class="btn ${kind}" data-owner-action="${action}">${esc(title)}<small>${esc(desc)}</small></button>`;}
async function ownerAction(x,action){const reason=$("owner-reason")?.value.trim()||"";const stateChanging=["force_end_session","move_to_pending_delivery","return_to_search","cancel_unpaid","mark_online","extend12","extend24"];if(stateChanging.includes(action)&&reason.length<5)return toast("Add a short reason first.");if(stateChanging.includes(action)&&!confirm("This changes the booking or Reelo state. Continue?"))return;try{
    if(action==="mark_online"){
      if(!x.reeloId)throw new Error("No Reelo is assigned.");await updateDoc(doc(db,"reelo_profiles",x.reeloId),{availability:"Online",updatedAt:serverTimestamp()});await addDoc(collection(db,"audit_logs"),{adminId:auth.currentUser.uid,adminEmail:auth.currentUser.email||"",action:"REELO_MARKED_ONLINE",targetType:"booking",targetId:x.id,reeloId:x.reeloId,reason,createdAt:serverTimestamp()});
    }else if(action==="notify_upload"){
      await httpsCallable(functions,"adminBookingAction")({bookingId:x.id,action:"notify_reelo",reason:reason||"Your session is complete. Please upload the required customer content before the delivery deadline. Earnings remain pending until delivery is accepted."});
    }else if(action==="extend12"||action==="extend24"){
      await httpsCallable(functions,"extendDeliveryDeadline")({bookingId:x.id,hours:action==="extend12"?12:24,reason});
    }else await httpsCallable(functions,"adminBookingAction")({bookingId:x.id,action,reason});
    toast("Operations action completed.");await openBooking(x.id,"overview");if(activePage==="overview"||activePage==="bookings"||activePage==="content")setTimeout(()=>loadPage(activePage),300);
  }catch(e){toast(friendly(e));}
}
async function saveNote(bookingId){const note=$("ops-note").value.trim();if(!note)return toast("Write an internal note first.");await addDoc(collection(db,"operations_notes"),{targetType:"booking",targetId:bookingId,note,adminId:auth.currentUser.uid,adminEmail:auth.currentUser.email||"",createdAt:serverTimestamp()});$("ops-note").value="";toast("Internal note saved.");}
async function renderBookingChatTab(x,people){
  const {profile={},customerUser={},reeloUser={}}=people||{};
  const customerName=x.customerName||customerUser.name||customerUser.displayName||x.customerEmail||"Customer";
  const reeloName=x.reeloName||profile.name||reeloUser.name||x.reeloEmail||"Reelo";
  $("drawer-tab-content").innerHTML=`<section class="drawer-section"><div class="section-title-row"><div><h3>Customer ↔ Reelo booking chat</h3><p class="muted">Read-only Operations view. Support replies stay in Customer Support / Reelo Support so Operations never impersonates either booking party.</p></div><strong>${esc(bookingRef(x.id))}</strong></div><div id="booking-party-chat" class="chat-box"><div class="loading">Loading booking conversation…</div></div></section>`;
  const q=query(collection(db,"bookings",x.id,"messages"),orderBy("createdAt"));
  const unsub=onSnapshot(q,snap=>{
    const box=$("booking-party-chat");if(!box)return;
    box.innerHTML=snap.docs.map(d=>{
      const m=d.data();
      const sender=m.senderId===x.customerId?customerName:m.senderId===x.reeloId?reeloName:(m.senderName||"Booking participant");
      const role=m.senderId===x.customerId?"Customer":m.senderId===x.reeloId?"Reelo":"Message";
      return `<div class="bubble booking-message"><strong>${esc(sender)} <small>· ${esc(role)}</small></strong><span>${esc(m.text||"")}</span><small>${esc(dateText(m.createdAt))}</small></div>`;
    }).join("")||'<div class="empty">No direct customer ↔ Reelo messages have been sent for this booking.</div>';
    box.scrollTop=box.scrollHeight;
  },e=>{const box=$("booking-party-chat");if(box)box.innerHTML=`<div class="empty">Could not load booking chat: ${esc(friendly(e))}</div>`;});
  drawerUnsubs.push(unsub);
}

function renderTimelineTab(x){const items=[["Booking created",x.createdAt],["Payment captured",x.paymentCapturedAt],["Reelo accepted",x.acceptedAt],["Reelo on the way",x.leftAt],["Arrived",x.arrivedAt],["Session started",x.startedAt],["Session completed",x.completedAt],["Content delivered",x.deliveredAt],["Customer accepted",x.deliveryConfirmedAt]].filter(([,v])=>v);$("drawer-tab-content").innerHTML=`<section class="drawer-section"><h3>Booking timeline</h3><div class="timeline">${items.length?items.map(([l,v])=>`<div class="timeline-item"><strong>${esc(l)}</strong><span>${esc(dateText(v))}</span></div>`).join(""):'<div class="empty">No lifecycle timestamps have been recorded.</div>'}</div></section>`;}
async function renderFilesTab(x){$("drawer-tab-content").innerHTML='<section class="drawer-section"><div class="loading">Loading delivered files…</div></section>';const snap=await getDocs(query(collection(db,"booking_media"),where("bookingId","==",x.id)));const items=snap.docs.map(d=>d.data());$("drawer-tab-content").innerHTML=`<section class="drawer-section"><h3>Content delivery</h3><div class="state-stack"><div class="state-row"><span>Delivery</span>${statusHtml(deliveryState(x).label,deliveryState(x).tone)}</div><div class="state-row"><span>Required</span><strong>${esc(x.requiredPhotoCount||"—")} photos · ${esc(x.requiredReelCount||"—")} reels</strong></div><div class="state-row"><span>Uploaded</span><strong>${items.filter(i=>i.type==='photo').length} photos · ${items.filter(i=>i.type==='reel').length} reels</strong></div></div></section><section class="drawer-section"><h3>Uploaded files</h3><div class="file-list">${items.length?items.map(i=>`<div class="file-item"><strong>${esc(i.fileName||i.type||"File")}</strong><span>${esc(i.type||"")} · ${esc(i.status||"active")} · ${esc(dateText(i.uploadedAt))}</span></div>`).join(""):'<div class="empty">No content has been uploaded for this booking.</div>'}</div></section>`;}
async function renderChatTab(x,thread,role,people={}){
  const isCustomer=role==='customer';
  const person=isCustomer?people.customerUser:(people.profile||{});
  const displayName=isCustomer?(x.customerName||person.name||person.displayName||x.customerEmail||'Customer'):(x.reeloName||person.name||x.reeloEmail||'Reelo');
  const phone=person.phone||(isCustomer?x.customerPhone:x.reeloPhone)||'—';
  const email=isCustomer?(x.customerEmail||person.email):(x.reeloEmail||person.email);
  const identityRef=isCustomer?(x.customerRef||x.customerId):(x.reeloRef||people.profile?.reeloRef||x.reeloId);
  if(!thread){$("drawer-tab-content").innerHTML=`<section class="drawer-section"><div class="chat-context"><div><span class="role-pill ${isCustomer?'customer':'reelo'}">${isCustomer?'Customer':'Reelo'}</span><strong>${esc(displayName)}</strong><span>${esc(email||'—')} · ${esc(phone)}</span><small>${esc(identityRef||'—')}</small></div><button class="booking-context-button" data-dtab="overview">Open booking control</button></div><div class="empty">No human support conversation is linked to this booking for the ${role}.</div></section>`;document.querySelector('[data-dtab="overview"]')?.addEventListener('click',()=>renderDrawer(x,'overview'));return;}
  $("drawer-tab-content").innerHTML=`<section class="drawer-section"><div class="chat-context"><div><span class="role-pill ${isCustomer?'customer':'reelo'}">${isCustomer?'Customer':'Reelo'}</span><strong>${esc(displayName)}</strong><span>${esc(email||thread.userEmail||'—')} · ${esc(phone)}</span><small>${esc(identityRef||thread.userId||'—')}</small></div><button class="booking-context-button" id="open-booking-control">${bookingRef(x.id)} · Booking control</button></div><div class="state-row"><span>Support case</span>${statusHtml(thread.status||"open",thread.humanRequested?"orange":"blue")}</div><span class="sub">Thread ${esc(thread.id)} · ${esc(timeAgo(thread.updatedAt))}</span></section><section class="drawer-section"><div id="drawer-chat" class="chat-box"><div class="loading">Loading conversation…</div></div><div class="quick"><button data-quick="I am reviewing this booking now. Please keep this chat open while I check it.">Reviewing now</button><button data-quick="Please tell me exactly what happened. Do not share passwords, OTPs, UPI PINs or full payment details.">Ask for details</button><button data-quick="I am checking the payment and booking records linked to this booking now.">Checking payment</button><button data-quick="Your session is complete. The booking is waiting for content upload and the Reelo can continue accepting new jobs.">Pending upload</button></div><div class="chat-compose"><textarea id="chat-reply" rows="2" placeholder="Reply as Reel It Support"></textarea><button class="btn primary" id="send-chat">Send</button></div><div class="chat-compose internal"><textarea id="support-note" rows="2" placeholder="Internal case note — never sent to the user"></textarea><button class="btn secondary" id="save-support-note">Save note</button></div><div class="action-stack"><button class="btn secondary" id="resolve-chat">Resolve conversation</button></div></section>`;
  $("open-booking-control").onclick=()=>renderDrawer(x,'overview');
  const ref=doc(db,"support_threads",thread.id);const q=query(collection(ref,"messages"),orderBy("createdAt"));
  const unsub=onSnapshot(q,snap=>{const box=$("drawer-chat");if(!box)return;box.innerHTML=snap.docs.map(d=>{const m=d.data();const cls=m.senderType==="support"?"support":m.senderType==="system"||m.senderType==="assistant"?"system":"";return `<div class="bubble ${cls}"><span>${esc(m.text||"")}</span><small>${esc(dateText(m.createdAt))}</small></div>`;}).join("")||'<div class="empty">No messages.</div>';box.scrollTop=box.scrollHeight;});
  drawerUnsubs.push(unsub);
  document.querySelectorAll("[data-quick]").forEach(b=>b.onclick=()=>$("chat-reply").value=b.dataset.quick);
  $("send-chat").onclick=async()=>{const text=$("chat-reply").value.trim();if(!text)return;await addDoc(collection(ref,"messages"),{senderId:auth.currentUser.uid,senderType:"support",text,createdAt:serverTimestamp()});await setDoc(ref,{lastMessage:text,lastMessageBy:"support",lastMessageSender:"support",unreadBySupport:false,unreadByUser:true,status:"open",updatedAt:serverTimestamp()},{merge:true});$("chat-reply").value="";toast("Reply sent.");};
  $("save-support-note").onclick=async()=>{const note=$("support-note").value.trim();if(!note)return toast("Write an internal note first.");try{await httpsCallable(functions,"addOperationsNote")({targetType:"support",targetId:thread.id,note});$("support-note").value="";toast("Internal case note saved and audited.");}catch(e){toast(friendly(e));}};
  $("resolve-chat").onclick=async()=>{await setDoc(ref,{status:"resolved",humanRequested:false,unreadBySupport:false,resolvedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});toast("Conversation resolved.");await renderDrawer(x,role);};
}

function clearSupportCaseStreams(){supportCaseUnsubs.forEach(fn=>{try{fn();}catch{}});supportCaseUnsubs=[];}
function unlockSupportAudio(){if(supportAudioReady)return;try{const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return;const ctx=new Ctx();if(ctx.state==='suspended')ctx.resume();window.__reelitSupportAudio=ctx;supportAudioReady=true;}catch{}}
document.addEventListener('click',unlockSupportAudio,{passive:true});
function playSupportSound(){if(!supportSoundEnabled)return;try{unlockSupportAudio();const ctx=window.__reelitSupportAudio;if(!ctx)return;const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='sine';osc.frequency.setValueAtTime(760,ctx.currentTime);osc.frequency.exponentialRampToValueAtTime(980,ctx.currentTime+.12);gain.gain.setValueAtTime(.0001,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.12,ctx.currentTime+.02);gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.22);osc.connect(gain).connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+.24);}catch{}}
function maybeNotifySupport(rows){let fresh=false;for(const t of rows){const stamp=t.updatedAt?.seconds||t.humanRequestedAt?.seconds||t.createdAt?.seconds||0;const prev=supportSeenUpdates.get(t.id);if(prev!==undefined&&stamp>prev&&t.unreadBySupport===true)fresh=true;supportSeenUpdates.set(t.id,stamp);}if(fresh){playSupportSound();toast('New support message received.');document.title='● Reel It Operations';setTimeout(()=>{document.title='Reel It Operations';},5000);}}
async function resolveSupportCase(threadId,resolved=true){const ref=doc(db,'support_threads',threadId);const payload=resolved?{status:'resolved',humanRequested:false,unreadBySupport:false,resolvedAt:serverTimestamp(),resolvedBy:auth.currentUser?.uid||'',updatedAt:serverTimestamp()}:{status:'open',humanRequested:true,resolvedAt:null,reopenedAt:serverTimestamp(),updatedAt:serverTimestamp()};await setDoc(ref,payload,{merge:true});toast(resolved?'Case resolved.':'Case reopened.');}
async function supportIdentity(thread,booking={}){
  let user={},profile={};
  if(thread.userId){try{const u=await getDoc(doc(db,'users',thread.userId));if(u.exists())user=u.data();}catch{}
    if((thread.userRole||'customer')==='reelo'){try{const r=await getDoc(doc(db,'reelo_profiles',thread.userId));if(r.exists())profile=r.data();}catch{}}
  }
  const reelo=(thread.userRole||'customer')==='reelo';
  const name=reelo?(booking.reeloName||profile.name||profile.displayName||user.name||user.displayName||thread.userName||thread.displayName||thread.userEmail||'Reelo'):(booking.customerName||user.name||user.displayName||thread.userName||thread.displayName||thread.userEmail||'Customer');
  const phone=reelo?(booking.reeloPhone||profile.phone||user.phone||thread.userPhone||''):(booking.customerPhone||user.phone||thread.userPhone||'');
  const email=reelo?(booking.reeloEmail||profile.email||user.email||thread.userEmail||''):(booking.customerEmail||user.email||thread.userEmail||'');
  const ref=reelo?(booking.reeloRef||profile.reeloRef||thread.reeloRef||thread.userId||''):(booking.customerRef||thread.customerRef||thread.userId||'');
  const photo=reelo?(booking.reeloPhotoUrl||profile.photoUrl||user.photoUrl||thread.userPhotoUrl||''):(booking.customerPhotoUrl||user.photoUrl||thread.userPhotoUrl||'');
  return {name,phone,email,ref,photo};
}

async function loadSupport(role){
  const roleLabel=role==='reelo'?'Reelo':'Customer';
  activeSupportCaseId=null; supportView='open'; clearSupportCaseStreams();
  $("content").innerHTML=`<section class="panel support-workspace"><div class="panel-head"><div><h3>${roleLabel} support desk</h3><p>Work each case here — identity, conversation, booking context and actions stay together.</p></div><div class="panel-actions"><div class="mini-search support-search"><span>⌕</span><input id="support-search" placeholder="Search name, phone, booking or message"></div><button class="btn secondary" id="support-sound">🔔 Sound on</button><button class="btn secondary" id="support-refresh">Refresh</button></div></div><div class="support-view-tabs"><button class="support-view-tab active" data-support-view="open">Open cases <span id="open-case-count"></span></button><button class="support-view-tab" data-support-view="resolved">Resolved</button></div><div id="support-health" class="sub" style="padding:0 18px 10px">Connecting to support_threads…</div><div id="support-list" class="support-card-list"><div class="loading">Loading support conversations…</div></div></section><section id="support-case-workspace" class="panel support-case-workspace hidden"></section>`;

  let bookings=bookingCache;
  if(!bookings.length){try{bookings=await fetchBookings();}catch(e){bookings=[];console.warn('Booking enrichment unavailable for support queue',e);}}
  let latest=[];
  const render=async(term='')=>{
    const q=term.trim().toLowerCase();
    const roleRows=latest.filter(t=>((t.userRole||'customer')==='reelo'?'reelo':'customer')===role);
    const openRows=roleRows.filter(t=>String(t.status||'').toLowerCase()!=='resolved'&&(t.humanRequested===true||t.unreadBySupport===true||Boolean(t.lastMessage)||['waiting','active','needs_human','open','pending'].includes(String(t.status||'').toLowerCase())));
    const rows=(supportView==='resolved'?roleRows.filter(t=>String(t.status||'').toLowerCase()==='resolved'):openRows).sort((a,b)=>(b.updatedAt?.seconds||b.humanRequestedAt?.seconds||b.createdAt?.seconds||0)-(a.updatedAt?.seconds||a.humanRequestedAt?.seconds||a.createdAt?.seconds||0));
    const enriched=await Promise.all(rows.map(async t=>{const b=bookings.find(x=>x.id===t.bookingId)||{};const ident=await supportIdentity(t,b);return {...t,_booking:b,_name:ident.name,_phone:ident.phone,_email:ident.email,_ref:ident.ref,_photo:ident.photo};}));
    const visible=enriched.filter(t=>!q||[t._name,t._phone,t._email,t._ref,t.userId,t.bookingId,t.bookingOccasion,t.lastIntent,t.lastMessage,t.status].filter(Boolean).join(' ').toLowerCase().includes(q));
    $("open-case-count").textContent=openRows.length?`(${openRows.length})`:'';
    const health=$("support-health");if(health)health.textContent=`Firebase connected · ${latest.length} support threads total · ${openRows.length} open ${roleLabel.toLowerCase()} case${openRows.length===1?'':'s'}`;
    $("support-list").innerHTML=visible.length?visible.map(t=>{const b=t._booking||{};const hasBooking=Boolean(t.bookingId&&Object.keys(b).length);const del=hasBooking?deliveryState(b):null;const pay=hasBooking?paymentState(b):null;return `<article class="support-card ${t.unreadBySupport?'unread':''} ${activeSupportCaseId===t.id?'selected':''}"><div class="support-person">${avatarHtml(t._name,t._photo,role)}<div><span class="role-pill ${role}">${roleLabel}</span><strong>${esc(t._name)}</strong><small>${esc(t._phone||t._email||t._ref||t.userId||'Identity unavailable')}</small><small>${esc(t._ref||'')}</small></div></div><div class="support-issue"><span class="issue-label ${t.unreadBySupport?'orange':'blue'}">${t.unreadBySupport?'NEW · ':''}${esc(t.lastIntent||'Support')}</span><strong>${esc(t.lastMessage||'Human help requested')}</strong><small>${esc(timeAgo(t.updatedAt||t.humanRequestedAt||t.createdAt))}</small></div><div class="support-booking">${t.bookingId?`<strong>${esc((hasBooking&&b.occasion)||t.bookingOccasion||'Booking')}</strong><small>${hasBooking?`${esc(b.customerName||'Customer')} ↔ ${esc(b.reeloName||'Not assigned')}`:'Booking linked — details unavailable'}</small><span class="booking-ref-inline">${esc(bookingRef(t.bookingId))}</span>`:'<strong>General support</strong><small>No booking linked</small>'}</div><div class="support-status">${hasBooking?`${statusHtml(sessionState(b).label,sessionState(b).tone)} ${del?statusHtml(del.label,del.tone):''}<small>${pay?`Payment: ${esc(pay.label)}`:''}</small>`:statusHtml(t.status||'waiting',t.unreadBySupport?'orange':'blue')}</div><button class="btn ${t.unreadBySupport?'primary':'secondary'}" data-support="${esc(t.id)}">${activeSupportCaseId===t.id?'Case open':'Open case'}</button></article>`;}).join(''):'<div class="empty">No support conversations match this view.</div>';
    document.querySelectorAll('[data-support]').forEach(b=>b.onclick=()=>openSupportThread(b.dataset.support,bookings));
  };
  $("support-refresh").onclick=()=>loadPage(role==='reelo'?'reelochats':'customerchats');
  $("support-search").oninput=e=>render(e.target.value);
  $("support-sound").onclick=()=>{supportSoundEnabled=!supportSoundEnabled;$("support-sound").textContent=supportSoundEnabled?'🔔 Sound on':'🔕 Sound off';if(supportSoundEnabled){unlockSupportAudio();playSupportSound();}};
  document.querySelectorAll('[data-support-view]').forEach(b=>b.onclick=()=>{supportView=b.dataset.supportView;document.querySelectorAll('[data-support-view]').forEach(x=>x.classList.toggle('active',x===b));render($("support-search")?.value||'');});
  pageUnsub=onSnapshot(collection(db,'support_threads'),snap=>{latest=snap.docs.map(d=>({id:d.id,...d.data()}));maybeNotifySupport(latest.filter(t=>((t.userRole||'customer')==='reelo'?'reelo':'customer')===role));render($("support-search")?.value||'');},err=>{console.error('support_threads listener failed',err);const health=$("support-health");if(health)health.textContent=`Could not read support_threads: ${friendly(err)}`;$("support-list").innerHTML=`<div class="empty"><strong>Support messages could not be read.</strong><br><span class="sub">${esc(friendly(err))}</span></div>`;});
}

async function openSupportThread(id,bookings=bookingCache){
  clearSupportCaseStreams(); activeSupportCaseId=id;
  const snap=await getDoc(doc(db,'support_threads',id));if(!snap.exists())return toast('Support thread not found.');
  const t={id,...snap.data()}; const b=(bookings||[]).find(x=>x.id===t.bookingId)|| (t.bookingId?await getDoc(doc(db,'bookings',t.bookingId)).then(s=>s.exists()?{id:s.id,...s.data()}:{}).catch(()=>({})):{});
  const ident=await supportIdentity(t,b); const role=(t.userRole||'customer')==='reelo'?'reelo':'customer'; const roleLabel=role==='reelo'?'Reelo':'Customer';
  await setDoc(doc(db,'support_threads',id),{unreadBySupport:false,updatedAt:t.updatedAt||serverTimestamp()},{merge:true}).catch(()=>{});
  const ws=$("support-case-workspace");ws.classList.remove('hidden');
  ws.innerHTML=`<div class="case-header"><div class="case-person">${avatarHtml(ident.name,ident.photo,role)}<div><span class="role-pill ${role}">${roleLabel}</span><h2>${esc(ident.name)}</h2><p>${esc(ident.phone||'No phone')} · ${esc(ident.email||'No email')}</p><small>${esc(ident.ref||t.userId||'')}</small></div></div><div class="case-header-actions">${t.bookingId?`<span class="case-booking-chip">${esc(bookingRef(t.bookingId))}</span>`:'<span class="case-booking-chip neutral">General support</span>'}<button class="btn ${String(t.status||'').toLowerCase()==='resolved'?'secondary':'success'}" id="case-resolve">${String(t.status||'').toLowerCase()==='resolved'?'Reopen case':'✓ Resolve case'}</button></div></div><div class="case-summary-strip"><div><span>Latest issue</span><strong>${esc(t.lastIntent||t.lastMessage||'Support request')}</strong></div><div><span>Case status</span><strong>${esc(t.status||'waiting')}</strong></div><div><span>Last activity</span><strong>${esc(timeAgo(t.updatedAt||t.createdAt))}</strong></div>${t.bookingId?`<div><span>Booking</span><strong>${esc((b.occasion||'Booking')+' · '+bookingRef(t.bookingId))}</strong></div>`:''}</div><div class="case-tabs"><button class="case-tab active" data-case-tab="conversation">Conversation</button><button class="case-tab" data-case-tab="booking">Booking / Control</button><button class="case-tab" data-case-tab="notes">Case notes</button></div><div id="case-tab-body"></div>`;
  $("case-resolve").onclick=async()=>{const was=String(t.status||'').toLowerCase()==='resolved';try{await resolveSupportCase(id,!was);activeSupportCaseId=null;ws.classList.add('hidden');loadPage(role==='reelo'?'reelochats':'customerchats');}catch(e){toast(friendly(e));}};
  const show=async tab=>{document.querySelectorAll('[data-case-tab]').forEach(x=>x.classList.toggle('active',x.dataset.caseTab===tab));if(tab==='conversation')await renderInlineSupportConversation(t,ident);else if(tab==='booking')renderInlineSupportBooking(t,b);else renderInlineSupportNotes(t,b);};
  document.querySelectorAll('[data-case-tab]').forEach(x=>x.onclick=()=>show(x.dataset.caseTab)); await show('conversation'); ws.scrollIntoView({behavior:'smooth',block:'start'});
}

async function renderInlineSupportConversation(t,ident){
  const body=$("case-tab-body");body.innerHTML=`<div class="case-conversation-layout"><div><div id="inline-support-chat" class="chat-box inline-chat"><div class="loading">Loading conversation…</div></div><div class="quick"><button data-inline-quick="I am reviewing this now. Please keep this chat open while I check it.">Reviewing now</button><button data-inline-quick="Please tell me exactly what happened. Do not share passwords, OTPs, UPI PINs or full payment details.">Ask for details</button><button data-inline-quick="I am checking the booking and payment records now.">Checking records</button></div><div class="chat-compose inline-compose"><textarea id="inline-chat-reply" rows="2" placeholder="Reply as Reel It Support"></textarea><button class="btn primary" id="inline-send-chat">Send reply</button></div></div><aside class="case-side-card"><h3>Who am I speaking to?</h3>${kv('Name',ident.name)}${kv('Phone',ident.phone||'—')}${kv('Email',ident.email||'—')}${kv('Reference',ident.ref||t.userId||'—')}<p class="muted">You stay on this case while replying — no pop-up or separate window.</p></aside></div>`;
  const ref=doc(db,'support_threads',t.id);let lastCount=0;const unsub=onSnapshot(query(collection(ref,'messages'),orderBy('createdAt')),ms=>{const box=$("inline-support-chat");if(!box)return;if(lastCount&&ms.size>lastCount)playSupportSound();lastCount=ms.size;box.innerHTML=ms.docs.map(d=>{const m=d.data();const cls=m.senderType==='support'?'support':m.senderType==='system'||m.senderType==='assistant'?'system':'';const who=m.senderType==='support'?'Reel It Support':m.senderType==='system'||m.senderType==='assistant'?'System':ident.name;return `<div class="bubble ${cls}"><strong>${esc(who)}</strong><span>${esc(m.text||'')}</span><small>${esc(dateText(m.createdAt))}</small></div>`;}).join('')||'<div class="empty">No messages.</div>';box.scrollTop=box.scrollHeight;},e=>toast(friendly(e)));supportCaseUnsubs.push(unsub);
  document.querySelectorAll('[data-inline-quick]').forEach(b=>b.onclick=()=>$("inline-chat-reply").value=b.dataset.inlineQuick);
  $("inline-send-chat").onclick=async()=>{const text=$("inline-chat-reply").value.trim();if(!text)return;try{await addDoc(collection(ref,'messages'),{senderId:auth.currentUser.uid,senderType:'support',text,createdAt:serverTimestamp()});await setDoc(ref,{lastMessage:text,lastMessageBy:'support',lastMessageSender:'support',unreadBySupport:false,unreadByUser:true,status:'active',humanRequested:true,updatedAt:serverTimestamp()},{merge:true});$("inline-chat-reply").value='';toast('Reply sent.');}catch(e){toast(friendly(e));}};
}

function renderInlineSupportBooking(t,b){
  const body=$("case-tab-body"); if(!t.bookingId){body.innerHTML='<div class="empty roomy">This is general support and is not linked to a booking. You can still resolve the case or add internal notes.</div>';return;}
  if(!b||!b.id){body.innerHTML=`<div class="empty roomy"><strong>${esc(bookingRef(t.bookingId))}</strong><br>Booking context could not be loaded. <button class="btn secondary" id="try-open-booking">Open booking record</button></div>`;$("try-open-booking").onclick=()=>openBooking(t.bookingId);return;}
  const ses=sessionState(b),del=deliveryState(b),pay=paymentState(b);const forceStatuses=['searching','accepted','arrived','in_progress','completed','cancelled'];
  body.innerHTML=`<div class="inline-booking-grid"><section class="case-side-card"><h3>Booking at a glance</h3>${kv('Booking',bookingRef(b.id))}${kv('Occasion',b.occasion||'Booking')}${kv('Customer',b.customerName||b.customerEmail||'Customer')}${kv('Reelo',b.reeloName||b.reeloEmail||'Not assigned')}${kv('Session',ses.label)}${kv('Delivery',del.label+' · '+del.detail)}${kv('Payment',pay.label+' · '+money(b.customerPrice||b.price))}${kv('Scheduled',dateText(b.scheduledDateTime||b.createdAt))}<button class="btn primary wide" id="open-full-booking">Open full Booking Control</button></section><section class="case-control-card"><h3>Emergency status control</h3><p class="muted">Use only when the booking state is genuinely wrong. The backend audits the change.</p><label class="field">Force booking status<select id="inline-force-status"><option value="">Choose permitted status…</option>${forceStatuses.map(v=>`<option value="${v}">${v.replaceAll('_',' ')}</option>`).join('')}</select></label><label class="field">Reason<textarea id="inline-force-reason" rows="3" placeholder="Why are you changing this booking state?"></textarea></label><button class="btn danger" id="inline-force-apply">Apply forced status</button></section></div>`;
  $("open-full-booking").onclick=()=>openBooking(b.id,'overview');
  $("inline-force-apply").onclick=async()=>{const targetStatus=$("inline-force-status").value,reason=$("inline-force-reason").value.trim();if(!targetStatus)return toast('Choose a status first.');if(reason.length<5)return toast('Add a short reason first.');if(!confirm(`Force ${bookingRef(b.id)} from ${b.status||'unknown'} to ${targetStatus}?`))return;try{await httpsCallable(functions,'adminForceBookingStatus')({bookingId:b.id,targetStatus,reason});toast('Booking status updated and audited.');const fresh=await getDoc(doc(db,'bookings',b.id));renderInlineSupportBooking(t,fresh.exists()?{id:fresh.id,...fresh.data()}:b);}catch(e){toast(friendly(e));}};
}
function renderInlineSupportNotes(t,b){const body=$("case-tab-body");body.innerHTML=`<div class="notes-layout"><section class="case-side-card"><h3>Internal case note</h3><p class="muted">Never sent to the customer or Reelo.</p><textarea id="inline-support-note" rows="5" placeholder="What happened, what you checked, and what the next admin should know"></textarea><button class="btn primary" id="inline-save-note">Save internal note</button></section><section class="case-side-card"><h3>Case references</h3>${kv('Thread ID',t.id)}${kv('User ID',t.userId||'—')}${kv('Booking ID',t.bookingId?bookingRef(t.bookingId):'General support')}${kv('Booking status',b?.status||'—')}</section></div>`;$("inline-save-note").onclick=async()=>{const note=$("inline-support-note").value.trim();if(!note)return toast('Write an internal note first.');try{await httpsCallable(functions,'addOperationsNote')({targetType:'support',targetId:t.id,note});$("inline-support-note").value='';toast('Internal case note saved and audited.');}catch(e){toast(friendly(e));}};}

async function loadReeloApprovals(){
  const snap=await getDocs(query(collection(db,"reelo_profile_reviews"),where("status","==","pending_manual_review")));
  const base=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.submittedAt?.seconds||0)-(b.submittedAt?.seconds||0));
  const rows=await Promise.all(base.map(async r=>{
    const [profileSnap,userSnap]=await Promise.all([getDoc(doc(db,"reelo_profiles",r.id)),getDoc(doc(db,"users",r.id))]);
    return {...r,profile:profileSnap.exists()?profileSnap.data():{},user:userSnap.exists()?userSnap.data():{}};
  }));
  $("content").innerHTML=`${metricsHtml([{label:"Waiting Review",value:rows.length,icon:"◉",sub:"Live selfies"},{label:"Ready",value:rows.filter(x=>x.profile?.onboardingComplete===true&&x.profile?.trainingComplete===true&&x.profile?.phoneVerified===true).length,icon:"✓",sub:"Required steps complete",good:true},{label:"Incomplete",value:rows.filter(x=>!(x.profile?.onboardingComplete===true&&x.profile?.trainingComplete===true&&x.profile?.phoneVerified===true)).length,icon:"!",sub:"Cannot approve yet",warn:true}])}<section class="panel"><div class="panel-head"><div><h3>Reelo activation approvals</h3><p>Review the live public-profile selfie and onboarding evidence before activation. Approvals and denials are audited.</p></div><button class="btn secondary" id="approval-refresh">Refresh</button></div><div class="approval-grid">${rows.length?rows.map(r=>{const p=r.profile||{},u=r.user||{};const ready=p.onboardingComplete===true&&p.trainingComplete===true&&p.phoneVerified===true;return `<article class="approval-card"><div class="approval-photo">${r.profilePhotoUrl?`<img src="${esc(r.profilePhotoUrl)}" alt="Live selfie submitted by ${esc(r.displayName||p.name||'Reelo')}">`:'<div class="photo-missing">No selfie</div>'}</div><div class="approval-body"><span class="role-pill reelo">Reelo activation</span><h3>${esc(r.displayName||p.name||u.name||r.email||r.id)}</h3><p>${esc(r.email||p.email||u.email||'—')}<br>${esc(p.phone||u.phone||'—')}</p><div class="approval-checks">${statusHtml(p.phoneVerified?'Phone verified':'Phone incomplete',p.phoneVerified?'green':'red')}${statusHtml(p.trainingComplete?'Training complete':'Training incomplete',p.trainingComplete?'green':'red')}${statusHtml(p.onboardingComplete?'Onboarding complete':'Onboarding incomplete',p.onboardingComplete?'green':'red')}</div><small>${esc(r.id)} · submitted ${esc(timeAgo(r.submittedAt))}</small><button class="btn ${ready?'primary':'secondary'} wide" data-review-reelo="${esc(r.id)}">Review application</button></div></article>`;}).join(''):'<div class="empty">No live Reelo profile selfies are waiting for review.</div>'}</div></section>`;
  $("approval-refresh").onclick=()=>loadPage("reeloapprovals");
  document.querySelectorAll("[data-review-reelo]").forEach(b=>b.onclick=()=>openReeloApproval(rows.find(r=>r.id===b.dataset.reviewReelo)));
}
function openReeloApproval(r){
  if(!r)return;
  const p=r.profile||{},u=r.user||{};
  const ready=p.onboardingComplete===true&&p.trainingComplete===true&&p.phoneVerified===true;
  const photo=r.profilePhotoUrl||'';
  modal("Reelo activation review",`<div class="review-layout"><div class="review-photo">${photo?`<img src="${esc(photo)}" alt="Submitted live profile selfie">`:'<div class="photo-missing">Live selfie missing</div>'}</div><div class="review-info"><span class="role-pill reelo">Pending activation</span><h2>${esc(r.displayName||p.name||u.name||r.email||r.id)}</h2><div class="kv-list">${kv("Reelo ID",p.reeloRef||r.id)}${kv("Phone",p.phone||u.phone||'—')}${kv("Email",r.email||p.email||u.email||'—')}${kv("Service area",p.area||p.primaryLocation||'—')}${kv("Experience",p.experience||'—')}${kv("Training",p.trainingComplete?'Complete':'Incomplete')}${kv("Phone verification",p.phoneVerified?'Complete':'Incomplete')}${kv("Onboarding",p.onboardingComplete?'Complete':'Incomplete')}${kv("Editing jobs",p.canEditReels?'Wants Edited offers':'Off')}${kv("Editing approval",p.editingApprovalStatus||'not requested')}</div><label class="review-note">Review note<textarea id="reelo-review-note" rows="3" placeholder="Why are you approving or requesting a new selfie?"></textarea></label><div class="review-actions"><button class="btn danger" id="deny-reelo">Deny / request new selfie</button><button class="btn primary" id="approve-reelo" ${ready?'':'disabled'}>Approve & activate</button></div>${ready?'':'<p class="warning-copy">Approval is disabled because onboarding, phone verification, or training is incomplete.</p>'}</div></div>`);
  $("deny-reelo").onclick=()=>reviewReelo(r.id,"resubmission_required");
  if(ready)$("approve-reelo").onclick=()=>reviewReelo(r.id,"approved");
}
async function reviewReelo(reeloId,decision){
  const reason=$("reelo-review-note")?.value.trim()||"";
  if(reason.length<3)return toast("Add a review note first.");
  const verb=decision==='approved'?'approve and activate':'deny and request a new selfie from';
  if(!confirm(`Are you sure you want to ${verb} this Reelo?`))return;
  try{await httpsCallable(functions,"adminReviewReelo")({reeloId,decision,reason});$("modal").close();toast(decision==='approved'?"Reelo approved and activated.":"New selfie requested.");await loadPage("reeloapprovals");}catch(e){toast(friendly(e));}
}

async function loadEditingApprovals(){
  const [appsSnap,profilesSnap,usersSnap]=await Promise.all([
    getDocs(collection(db,"editing_applications")),
    getDocs(collection(db,"reelo_profiles")),
    getDocs(collection(db,"users"))
  ]);
  const profiles=new Map(profilesSnap.docs.map(d=>[d.id,{id:d.id,...d.data()}]));
  const users=new Map(usersSnap.docs.map(d=>[d.id,{id:d.id,...d.data()}]));
  const rows=appsSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>String(x.status||"pending_review")==="pending_review").sort((a,b)=>(a.submittedAt?.seconds||0)-(b.submittedAt?.seconds||0));
  $("content").innerHTML=`${metricsHtml([
    {label:"Pending review",value:rows.length,icon:"✦",sub:"Portfolio decisions",warn:rows.length>0},
    {label:"Editing approved",value:[...profiles.values()].filter(x=>x.editingApprovalStatus==="approved").length,icon:"✓",sub:"Eligible for Edited",good:true},
    {label:"Wants editing",value:[...profiles.values()].filter(x=>x.canEditReels===true).length,icon:"◎",sub:"Toggle enabled"}
  ])}<section class="panel">
    <div class="panel-head"><div><h3>Editing approval queue</h3><p>Portfolio review is separate from live verification. Approval unlocks Edited matching only when the Reelo also keeps Editing Jobs turned on.</p></div><button class="btn secondary" id="editing-refresh">Refresh</button></div>
    <div class="approval-grid">${rows.length?rows.map(a=>{
      const p=profiles.get(a.reeloId||a.id)||{}; const u=users.get(a.reeloId||a.id)||{};
      const imgs=Array.isArray(a.portfolioImages)&&a.portfolioImages.length?a.portfolioImages:(Array.isArray(p.portfolioImages)?p.portfolioImages:[]);
      const name=p.name||p.displayName||u.name||u.displayName||p.email||u.email||a.id;
      return `<article class="approval-card editing-card">
        <div class="approval-photo">${imgs[0]?`<img src="${esc(imgs[0])}" alt="Portfolio preview for ${esc(name)}">`:'<div class="photo-missing">No portfolio preview</div>'}</div>
        <div class="approval-body"><span class="role-pill reelo">Editing review</span><h3>${esc(name)}</h3>
          <p>${esc(imgs.length)} portfolio sample${imgs.length===1?'':'s'} · ${p.verified?'Live verified':'Verification not approved'}</p>
          <small>${esc(p.reeloRef||a.reeloId||a.id)} · ${esc(p.phone||u.phone||p.email||u.email||'No contact')}</small>
          <div class="approval-checks">${statusHtml(p.canEditReels?'Editing toggle on':'Editing toggle off',p.canEditReels?'violet':'')}${statusHtml(p.editingApprovalStatus||'pending_review','orange')}</div>
          <button class="btn primary wide" data-edit-review="${esc(a.id)}">Review portfolio</button>
        </div>
      </article>`;
    }).join(""):'<div class="empty roomy">No Editing applications are waiting for review.</div>'}</div>
  </section>`;
  $("editing-refresh").onclick=()=>loadPage("editingapprovals");
  document.querySelectorAll("[data-edit-review]").forEach(b=>b.onclick=()=>openEditingReview(b.dataset.editReview,rows,profiles,users));
}

function openEditingReview(id,rows,profiles,users){
  const a=rows.find(x=>x.id===id); if(!a)return;
  const rid=a.reeloId||a.id, p=profiles.get(rid)||{},u=users.get(rid)||{};
  const imgs=Array.isArray(a.portfolioImages)&&a.portfolioImages.length?a.portfolioImages:(Array.isArray(p.portfolioImages)?p.portfolioImages:[]);
  const name=p.name||p.displayName||u.name||u.displayName||p.email||u.email||rid;
  modal("Editing approval",`<div class="editing-review-layout">
    <div><div class="portfolio-grid">${imgs.length?imgs.map((url,i)=>`<button class="portfolio-tile" type="button" data-portfolio-url="${esc(url)}"><img src="${esc(url)}" alt="Portfolio sample ${i+1}"></button>`).join(""):'<div class="photo-missing">No portfolio samples</div>'}</div><p class="muted">Review the submitted portfolio. A minimum of 3 samples is required by the Reelo application flow.</p></div>
    <div class="review-info"><span class="role-pill reelo">Editing application</span><h2>${esc(name)}</h2>
      <div class="kv-list">${kv("Reelo",p.reeloRef||rid)}${kv("Phone",p.phone||u.phone||'—')}${kv("Email",p.email||u.email||'—')}${kv("Live verification",p.verified?'Approved':'Not approved')}${kv("Editing toggle",p.canEditReels?'On':'Off')}${kv("Portfolio samples",imgs.length)}${kv("Current editing status",p.editingApprovalStatus||'not_requested')}</div>
      <label class="review-note">Decision note<textarea id="editing-review-note" rows="4" placeholder="Why are you approving, denying, or asking for a resubmission?"></textarea></label>
      <div class="review-actions three"><button class="btn danger" id="editing-deny">Deny</button><button class="btn secondary" id="editing-resubmit">Request resubmission</button><button class="btn primary" id="editing-approve" ${imgs.length<3||!p.verified?'disabled':''}>Approve Editing</button></div>
      ${!p.verified?'<p class="warning-copy">Editing approval is disabled until live verification is approved.</p>':''}
    </div>
  </div>`);
  document.querySelectorAll("[data-portfolio-url]").forEach(b=>b.onclick=()=>window.open(b.dataset.portfolioUrl,"_blank","noopener"));
  $("editing-deny").onclick=()=>reviewEditingApplication(a,"denied");
  $("editing-resubmit").onclick=()=>reviewEditingApplication(a,"resubmission_required");
  if(imgs.length>=3&&p.verified)$("editing-approve").onclick=()=>reviewEditingApplication(a,"approved");
}
async function reviewEditingApplication(a,decision){
  const reason=$("editing-review-note")?.value.trim()||"";
  if(reason.length<3)return toast("Add a decision note first.");
  const rid=a.reeloId||a.id;
  const label=decision==="approved"?"approve Editing":decision==="denied"?"deny Editing":"request a new portfolio submission";
  if(!confirm(`Are you sure you want to ${label} for this Reelo?`))return;
  try{
    await httpsCallable(functions,"adminReviewEditingApplication")({reeloId:rid,decision,reason});
    $("modal").close();toast(decision==="approved"?"Editing approved.":"Editing review saved.");await loadPage("editingapprovals");
  }catch(e){toast(friendly(e));}
}

async function loadReelos(){
  const [profilesSnap,usersSnap]=await Promise.all([getDocs(collection(db,"reelo_profiles")),getDocs(collection(db,"users"))]);
  const users=new Map(usersSnap.docs.map(d=>[d.id,{id:d.id,...d.data()}]));
  const rows=profilesSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.name||a.email||a.id).localeCompare(String(b.name||b.email||b.id)));
  $("content").innerHTML=`${metricsHtml([{label:"Total Reelos",value:rows.length,icon:"◎",sub:"Profiles"},{label:"Online",value:rows.filter(x=>x.availability==="Online").length,icon:"●",sub:"Available now",good:true},{label:"Live verified",value:rows.filter(x=>x.verified===true).length,icon:"✓",sub:"Approved"},{label:"Editing approved",value:rows.filter(x=>x.editingApprovalStatus==="approved").length,icon:"✦",sub:"Edited eligible"}])}<section class="panel"><div class="panel-head"><div><h3>Reelo accounts</h3><p>Open any Reelo for profile, verification, portfolio, bookings, support and controlled account actions.</p></div><div class="mini-search"><span>⌕</span><input id="reelo-account-search" placeholder="Search name, phone, email or Reelo ID"></div></div><div id="reelo-account-list" class="account-list">${renderReeloAccountRows(rows,users)}</div></section><section id="account-workspace" class="panel account-workspace hidden"></section>`;
  const search=$("reelo-account-search"); search.oninput=()=>{const q=search.value.trim().toLowerCase();$("reelo-account-list").innerHTML=renderReeloAccountRows(rows.filter(x=>[x.name,x.displayName,x.phone,x.email,x.reeloRef,x.id].filter(Boolean).join(" ").toLowerCase().includes(q)),users);wireReeloAccountRows(rows,users);};
  wireReeloAccountRows(rows,users);
}
function renderReeloAccountRows(rows,users){return rows.length?rows.map(x=>{const u=users.get(x.id)||{};return `<button class="account-row" type="button" data-reelo-account="${esc(x.id)}">${avatarHtml(x.name||x.displayName||u.name||"Reelo",x.photoUrl||x.profilePhotoUrl||"","reelo")}<span class="account-primary"><strong>${esc(x.name||x.displayName||u.name||x.email||u.email||x.id)}</strong><small>${esc(x.reeloRef||x.id)} · ${esc(x.phone||u.phone||x.email||u.email||"No contact")}</small></span><span>${statusHtml(x.verified?"Verified":"Verification needed",x.verified?"green":"orange")}</span><span>${statusHtml(x.editingApprovalStatus||"not requested",x.editingApprovalStatus==="approved"?"violet":x.editingApprovalStatus==="pending_review"?"orange":"")}</span><span>${statusHtml(x.availability||"Offline",x.availability==="Online"?"green":x.availability==="Busy"?"orange":"")}</span><span class="row-arrow">Open →</span></button>`;}).join(""):'<div class="empty">No Reelo accounts match.</div>';}
function wireReeloAccountRows(rows,users){document.querySelectorAll("[data-reelo-account]").forEach(b=>b.onclick=()=>openAccountWorkspace("reelo",rows.find(x=>x.id===b.dataset.reeloAccount),users.get(b.dataset.reeloAccount)||{}));}

async function loadCustomerAccounts(){
  const snap=await getDocs(collection(db,"users"));
  const rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>String(x.role||"customer").toLowerCase()!=="reelo").sort((a,b)=>String(a.name||a.displayName||a.email||a.id).localeCompare(String(b.name||b.displayName||b.email||b.id)));
  $("content").innerHTML=`${metricsHtml([{label:"Customers",value:rows.length,icon:"◇",sub:"Customer accounts"},{label:"Deletion requested",value:rows.filter(x=>x.deletionRequested===true).length,icon:"⌫",sub:"Needs review",warn:true}])}<section class="panel"><div class="panel-head"><div><h3>Customer accounts</h3><p>Search a customer and open their account, bookings, support history and account actions.</p></div><div class="mini-search"><span>⌕</span><input id="customer-account-search" placeholder="Search name, phone, email or Customer ID"></div></div><div id="customer-account-list" class="account-list">${renderCustomerAccountRows(rows)}</div></section><section id="account-workspace" class="panel account-workspace hidden"></section>`;
  const search=$("customer-account-search");search.oninput=()=>{const q=search.value.trim().toLowerCase();$("customer-account-list").innerHTML=renderCustomerAccountRows(rows.filter(x=>[x.name,x.displayName,x.phone,x.email,x.customerRef,x.id].filter(Boolean).join(" ").toLowerCase().includes(q)));wireCustomerAccountRows(rows);};wireCustomerAccountRows(rows);
}
function renderCustomerAccountRows(rows){return rows.length?rows.map(x=>`<button class="account-row customer" type="button" data-customer-account="${esc(x.id)}">${avatarHtml(x.name||x.displayName||"Customer",x.photoUrl||x.profilePhotoUrl||"","customer")}<span class="account-primary"><strong>${esc(x.name||x.displayName||x.email||x.phone||x.id)}</strong><small>${esc(x.customerRef||x.id)} · ${esc(x.phone||x.email||"No contact")}</small></span><span>${statusHtml(x.deletionRequested?"Deletion requested":"Active",x.deletionRequested?"orange":"green")}</span><span></span><span></span><span class="row-arrow">Open →</span></button>`).join(""):'<div class="empty">No customer accounts match.</div>';}
function wireCustomerAccountRows(rows){document.querySelectorAll("[data-customer-account]").forEach(b=>b.onclick=()=>openAccountWorkspace("customer",{},rows.find(x=>x.id===b.dataset.customerAccount)));}

async function openAccountWorkspace(role,profile,user){
  const uid=profile?.id||user?.id;if(!uid)return;
  const ws=$("account-workspace");if(!ws)return;
  ws.classList.remove("hidden");ws.innerHTML='<div class="loading">Loading account workspace…</div>';ws.scrollIntoView({behavior:"smooth",block:"start"});
  const [bookingSnap,supportSnap,reviewSnap]=await Promise.all([getDocs(collection(db,"bookings")),getDocs(collection(db,"support_threads")),role==="reelo"?getDoc(doc(db,"reelo_profile_reviews",uid)):Promise.resolve(null)]);
  const bookings=bookingSnap.docs.map(d=>({id:d.id,...d.data()})).filter(b=>role==="reelo"?b.reeloId===uid:b.customerId===uid).sort((a,b)=>(b.updatedAt?.seconds||0)-(a.updatedAt?.seconds||0));
  const supports=supportSnap.docs.map(d=>({id:d.id,...d.data()})).filter(t=>t.userId===uid).sort((a,b)=>(b.updatedAt?.seconds||0)-(a.updatedAt?.seconds||0));
  const review=reviewSnap?.exists?.()?{id:reviewSnap.id,...reviewSnap.data()}:null;
  const name=profile?.name||profile?.displayName||user?.name||user?.displayName||profile?.email||user?.email||uid;
  const photo=profile?.photoUrl||profile?.profilePhotoUrl||user?.photoUrl||user?.profilePhotoUrl||"";
  const livePhoto=review?.profilePhotoUrl||review?.liveSelfieUrl||"";
  ws.innerHTML=`<div class="account-head">${avatarHtml(name,photo,role)}<div><span class="role-pill ${role}">${role==="reelo"?"Reelo":"Customer"}</span><h2>${esc(name)}</h2><p>${esc((role==="reelo"?profile?.reeloRef:user?.customerRef)||uid)} · ${esc(profile?.phone||user?.phone||profile?.email||user?.email||"No contact")}</p></div><div class="account-head-actions"><button class="btn secondary" id="account-close">Close</button></div></div><div class="account-tabs"><button class="case-tab active" data-account-tab="profile">Profile</button>${role==="reelo"?'<button class="case-tab" data-account-tab="verification">Verification & photos</button><button class="case-tab" data-account-tab="editing">Editing</button>':''}<button class="case-tab" data-account-tab="bookings">Bookings</button><button class="case-tab" data-account-tab="support">Support</button><button class="case-tab" data-account-tab="actions">Actions</button></div><div id="account-tab-body"></div>`;
  $("account-close").onclick=()=>ws.classList.add("hidden");
  const data={role,uid,profile,user,review,name,photo,livePhoto,bookings,supports};
  document.querySelectorAll("[data-account-tab]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-account-tab]").forEach(x=>x.classList.toggle("active",x===b));renderAccountTab(data,b.dataset.accountTab);});
  renderAccountTab(data,"profile");
}
function renderAccountTab(d,tab){
  const body=$("account-tab-body"); if(!body)return;
  if(tab==="profile"){body.innerHTML=`<div class="account-detail-grid"><section class="case-side-card"><h3>Account information</h3>${kv("Name",d.name)}${kv("Phone",d.profile?.phone||d.user?.phone||"—")}${kv("Email",d.profile?.email||d.user?.email||"—")}${kv("User ID",d.uid)}${d.role==="reelo"?kv("Availability",d.profile?.availability||"Offline")+kv("Completed bookings",d.profile?.completedBookings||0)+kv("Rating",d.profile?.rating||0):kv("Completed bookings",d.user?.completedBookings||0)}</section><section class="case-side-card"><h3>Current state</h3>${d.role==="reelo"?kv("Live verification",d.profile?.verified?"Approved":d.profile?.verificationStatus||"Not approved")+kv("Editing approval",d.profile?.editingApprovalStatus||"not_requested")+kv("Editing toggle",d.profile?.canEditReels?"On":"Off"):""}${kv("Deletion requested",d.user?.deletionRequested?"Yes":"No")}</section></div>`;return;}
  if(tab==="verification"){body.innerHTML=`<div class="verification-compare"><section><h3>Current profile photo</h3>${d.photo?`<img src="${esc(d.photo)}" alt="Current Reelo profile photo">`:'<div class="photo-missing">No profile photo</div>'}</section><section><h3>Live verification submission</h3>${d.livePhoto?`<img src="${esc(d.livePhoto)}" alt="Live verification photo">`:'<div class="photo-missing">No live verification photo</div>'}</section></div><div class="account-inline-actions"><button class="btn warning" id="reset-live-verification">Request new live verification</button></div>`;$("reset-live-verification").onclick=async()=>{const reason=prompt("Reason for requesting a new live verification?")?.trim();if(!reason||reason.length<3)return;try{await httpsCallable(functions,"adminReviewReelo")({reeloId:d.uid,decision:"resubmission_required",reason});toast("New live verification requested.");loadPage("reelos");}catch(e){toast(friendly(e));}};return;}
  if(tab==="editing"){const imgs=Array.isArray(d.profile?.portfolioImages)?d.profile.portfolioImages:[];body.innerHTML=`<section class="case-side-card"><h3>Editing eligibility</h3>${kv("Editing Jobs toggle",d.profile?.canEditReels?"On":"Off")}${kv("Approval",d.profile?.editingApprovalStatus||"not_requested")}${kv("Portfolio samples",imgs.length)}<div class="portfolio-grid compact">${imgs.map((u,i)=>`<a class="portfolio-tile" href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Portfolio ${i+1}"></a>`).join("")||'<div class="empty">No portfolio samples.</div>'}</div></section>`;return;}
  if(tab==="bookings"){body.innerHTML=`<section class="case-side-card"><h3>${d.bookings.length} bookings</h3>${d.bookings.slice(0,20).map(b=>`<button class="account-booking-link" type="button" data-account-booking="${esc(b.id)}"><strong>${bookingRef(b.id)}</strong><span>${esc(b.occasion||"Booking")} · ${esc(b.status||"unknown")} · ${dateText(b.updatedAt||b.createdAt)}</span></button>`).join("")||'<div class="empty">No bookings.</div>'}</section>`;document.querySelectorAll("[data-account-booking]").forEach(b=>b.onclick=()=>openBooking(b.dataset.accountBooking));return;}
  if(tab==="support"){body.innerHTML=`<section class="case-side-card"><h3>${d.supports.length} support cases</h3>${d.supports.slice(0,20).map(t=>`<div class="account-support-row"><strong>${esc(t.lastIntent||"Support case")}</strong><span>${esc(t.lastMessage||"No message")} · ${timeAgo(t.updatedAt)}</span>${statusHtml(t.status||"open",String(t.status).toLowerCase()==="resolved"?"green":"orange")}</div>`).join("")||'<div class="empty">No support cases.</div>'}</section>`;return;}
  if(tab==="actions"){body.innerHTML=`<div class="account-detail-grid"><section class="case-side-card"><h3>Edit operational profile fields</h3><p class="muted">This updates Reel It profile data only; it does not silently rewrite Firebase Authentication credentials.</p><label class="field">Display name<input id="account-edit-name" value="${esc(d.profile?.name||d.user?.name||d.user?.displayName||"")}"></label><label class="field">Phone / contact field<input id="account-edit-phone" value="${esc(d.profile?.phone||d.user?.phone||"")}"></label>${d.role==="reelo"?`<label class="field">Service area<input id="account-edit-area" value="${esc(d.profile?.area||d.profile?.primaryLocation||"")}"></label>`:""}<button class="btn primary" id="save-account-profile">Save profile changes</button></section><section class="case-control-card"><h3>Account access</h3><p class="muted">Disable/enable affects Firebase Authentication and is audited by the backend.</p><label class="field">Reason<textarea id="account-access-reason" rows="4" placeholder="Reason required"></textarea></label><div class="action-stack"><button class="btn danger" id="disable-account">Disable sign-in</button><button class="btn success" id="enable-account">Enable sign-in</button></div></section></div>`;$("save-account-profile").onclick=()=>saveAccountProfile(d);$("disable-account").onclick=()=>setAccountDisabled(d,true);$("enable-account").onclick=()=>setAccountDisabled(d,false);return;}
}
async function saveAccountProfile(d){
  const name=$("account-edit-name").value.trim(),phone=$("account-edit-phone").value.trim();
  try{await httpsCallable(functions,"adminUpdateAccountProfile")({uid:d.uid,role:d.role,name,phone,area:d.role==="reelo"?$("account-edit-area").value.trim():""});toast("Profile changes saved and audited.");await loadPage(d.role==="reelo"?"reelos":"customeraccounts");}catch(e){toast(friendly(e));}
}
async function setAccountDisabled(d,disabled){
  const reason=$("account-access-reason").value.trim();if(reason.length<5)return toast("Add a short reason first.");
  if(!confirm(`${disabled?"Disable":"Enable"} sign-in for ${d.name}?`))return;
  try{await httpsCallable(functions,"adminSetAccountDisabled")({uid:d.uid,disabled,reason});toast(disabled?"Account sign-in disabled.":"Account sign-in enabled.");}catch(e){toast(friendly(e));}
}

async function loadContent(){const bookings=await fetchBookings();const rows=bookings.filter(x=>['pending_upload','uploading','approval','dispute'].includes(deliveryState(x).key));$("content").innerHTML='<div id="booking-panel"></div>';renderBookingPanel(rows,"all");}
async function loadPayments(){
  const bookings=await fetchBookings();
  const rows=bookings.filter(x=>x.paymentStatus||x.razorpayOrderId||x.paymentReference||x.reeloEarnings||x.earnings);
  const earningsView=activePage==='earnings';
  $("content").innerHTML=`<section class="panel"><div class="panel-head"><div><h3>${earningsView?'Reelo earnings & payout readiness':'Booking money ledger'}</h3><p>${earningsView?'Track what each Reelo earned, why it is pending, and whether payout is eligible.':'Keep customer charge, Reelo earning, payout and refund as separate records for each booking.'}</p></div><button class="btn secondary" id="money-refresh">Refresh</button></div><div class="table-wrap"><table class="data-table money-table"><thead><tr><th>Booking</th><th>Customer charge</th><th>Payment</th><th>Reelo earning</th><th>Fulfillment / hold</th><th>Payout</th><th>Refund</th><th>Action</th></tr></thead><tbody>${rows.length?rows.map(x=>{const pay=paymentState(x);const earning=x.reeloEarnings??x.earnings??0;const payout=x.payoutStatus||x.reeloPayoutStatus||(x.earningsEligibleAt?'Eligible':'Not eligible');const fulfill=x.earningsEligibleAt?'Fulfillment cleared':(deliveryState(x).label||'Pending');return `<tr><td><button class="booking-link" data-money-booking="${esc(x.id)}">${bookingRef(x.id)}</button><span class="sub">${esc(x.occasion||'Booking')}</span></td><td><strong>${money(x.customerPrice||x.price)}</strong><span class="sub">${esc(x.paymentReference||x.razorpayOrderId||'—')}</span></td><td>${statusHtml(pay.label,pay.tone)}</td><td><strong>${money(earning)}</strong><span class="sub">${esc(x.reeloName||x.reeloEmail||'Not assigned')}</span></td><td>${statusHtml(fulfill,x.earningsEligibleAt?'green':'orange')}</td><td>${statusHtml(payout,String(payout).toLowerCase().includes('paid')?'green':'orange')}<span class="sub">${esc(x.payoutReference||'')}</span></td><td>${x.refundStatus?statusHtml(x.refundStatus,x.refundStatus==='completed'?'green':'orange'):'—'}</td><td><button class="btn secondary" data-money-booking="${esc(x.id)}">Open control</button></td></tr>`;}).join(''):'<tr><td colspan="8"><div class="empty">No payment records yet.</div></td></tr>'}</tbody></table></div></section>`;
  $("money-refresh").onclick=()=>loadPage(activePage);
  document.querySelectorAll("[data-money-booking]").forEach(b=>b.onclick=()=>openBooking(b.dataset.moneyBooking,'overview'));
}
async function loadRefunds(){const bookings=await fetchBookings();const rows=bookings.filter(x=>x.refundStatus&&x.refundStatus!=="not_required");$("content").innerHTML='<div id="booking-panel"></div>';renderBookingPanel(rows,"all");}
async function loadSOS(){const snap=await getDocs(query(collection(db,"sos_alerts"),orderBy("createdAt","desc"),limit(100)));const rows=snap.docs.map(d=>({id:d.id,...d.data()}));$("content").innerHTML=`<section class="panel"><div class="queue-list"><div class="queue-row head"><div>Priority</div><div>User</div><div>Booking</div><div>Status</div><div>Note</div><div>Action</div></div>${rows.length?rows.map(x=>`<div class="queue-row"><div>${statusHtml('SOS','red')}</div><div><strong>${esc(x.raisedByName||x.raisedByEmail||x.raisedBy||'User')}</strong></div><div><button class="booking-link" data-sos-booking="${esc(x.bookingId||'')}">${x.bookingId?bookingRef(x.bookingId):'—'}</button></div><div>${statusHtml(x.status||'active',x.status==='resolved'?'green':'red')}</div><div><span class="sub">${esc(x.note||'No note')}</span></div><div>${x.status!=='resolved'?`<button class="btn primary" data-sos-resolve="${esc(x.id)}">Resolve</button>`:''}</div></div>`).join(""):'<div class="empty">No SOS alerts.</div>'}</div></section>`;document.querySelectorAll("[data-sos-booking]").forEach(b=>b.onclick=()=>b.dataset.sosBooking&&openBooking(b.dataset.sosBooking));document.querySelectorAll("[data-sos-resolve]").forEach(b=>b.onclick=async()=>{await updateDoc(doc(db,"sos_alerts",b.dataset.sosResolve),{status:"resolved",resolvedAt:serverTimestamp(),updatedAt:serverTimestamp()});loadPage("sos");});}
async function loadReports(){const snap=await getDocs(query(collection(db,"user_reports"),orderBy("createdAt","desc"),limit(100)));const rows=snap.docs.map(d=>({id:d.id,...d.data()}));renderSimpleTable("User reports",rows,[['reason','Reason'],['reporterEmail','Reporter'],['reportedUserName','Reported'],['status','Status'],['bookingId','Booking']],"user_reports");}
async function loadAccounts(){const snap=await getDocs(query(collection(db,"account_deletion_requests"),orderBy("requestedAt","desc"),limit(100)));const rows=snap.docs.map(d=>({id:d.id,...d.data()}));renderSimpleTable("Account deletion requests",rows,[['email','Account'],['status','Status'],['requestedAt','Requested'],['failureReason','Failure']],"account_deletion_requests");}
async function loadAudit(){const snap=await getDocs(query(collection(db,"audit_logs"),orderBy("createdAt","desc"),limit(150)));const rows=snap.docs.map(d=>({id:d.id,...d.data()}));renderSimpleTable("Privileged action audit log",rows,[['action','Action'],['adminEmail','Admin'],['targetId','Target'],['reason','Reason'],['createdAt','When']],"audit_logs");}
function renderSimpleTable(title,rows,cols){$("content").innerHTML=`<section class="panel"><div class="panel-head"><div><h3>${esc(title)}</h3><p>${rows.length} records</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr>${cols.map(([,l])=>`<th>${esc(l)}</th>`).join("")}</tr></thead><tbody>${rows.length?rows.map(x=>`<tr>${cols.map(([k])=>`<td>${k==='bookingId'&&x[k]?`<button class="booking-link" data-generic-booking="${esc(x[k])}">${bookingRef(x[k])}</button>`:esc(x[k]?.toDate?dateText(x[k]):x[k]??'—')}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${cols.length}"><div class="empty">Nothing to show.</div></td></tr>`}</tbody></table></div></section>`;document.querySelectorAll("[data-generic-booking]").forEach(b=>b.onclick=()=>openBooking(b.dataset.genericBooking));}

async function runGlobalSearch(){const term=$("global-search").value.trim();if(!term)return toast("Search a name, phone, booking ID, Reelo/customer reference, email, payment or payout ID.");try{if(term.toUpperCase().startsWith("RLT-BK-")){const all=bookingCache.length?bookingCache:await fetchBookings();const found=all.find(x=>bookingRef(x.id)===term.toUpperCase());if(found)return openBooking(found.id);}const direct=await getDoc(doc(db,"bookings",term));if(direct.exists())return openBooking(direct.id);const all=bookingCache.length?bookingCache:await fetchBookings();const q=term.toLowerCase();const hits=all.filter(x=>bookingSearchText(x.id,x).includes(q));if(hits.length===1)return openBooking(hits[0].id);$("page-title").textContent="Search results";$("page-subtitle").textContent=`${hits.length} matching bookings`;$("content").innerHTML='<div id="booking-panel"></div>';renderBookingPanel(hits,"all");}catch(e){toast(friendly(e));}}
function modal(title,html){$("modal-content").innerHTML=`<div class="modal-body"><h3>${esc(title)}</h3>${html}</div>`;$("modal").showModal();}
