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
const bookingRef = (id, data={}) => data.bookingRef || data.reference || `RLT-BK-${String(id || "").slice(-6).toUpperCase()}`;
const toast = text => { $("toast").textContent=text; $("toast").classList.add("show"); setTimeout(()=>$("toast").classList.remove("show"),2800); };
const friendly = e => { const c=e?.code||""; if(c.includes("permission-denied"))return "This owner account does not have permission for that action."; if(c.includes("failed-precondition"))return e.message?.replace(/^FirebaseError:\s*/i,"")||"This action is not allowed in the current booking state."; if(c.includes("invalid-credential"))return "Incorrect email or password."; return e?.message?.replace(/^Firebase:\s*/i,"").replace(/^FirebaseError:\s*/i,"") || "This action could not be completed."; };

const NAV = [
  ["overview","Command Center","⌂"],["bookings","Bookings","▤"],["controlrooms","Control Rooms","▣"],["customerchats","Customer Chats","◎"],["reelochats","Reelo Chats","◎"],
  ["reeloapprovals","Reelo Approvals","✓"],["reelos","Reelos","◉"],["earnings","Earnings","₹"],["content","Deliveries","□"],["payments","Payments","▧"],["refunds","Refunds","↩"],["sos","SOS Alerts","△"],
  ["reports","Reports","⚑"],["feedback","Feedback","☆"],["accounts","Accounts","◇"],["settings","Settings","⚙"]
];
let activePage="overview", bookingCache=[], activeBookingId=null, drawerUnsubs=[], pageUnsub=null;
let peopleCache={users:new Map(),reelos:new Map()}, activeBookingFilters={date:"all",status:"all",package:"all",delivery:"all",payment:"all",assignment:"all",attention:false};
const initials = name => String(name||"?").trim().split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase() || "?";
const photoOf = (...items) => items.find(v=>typeof v==="string" && /^https?:\/\//i.test(v)) || "";
function avatarHtml(name, photo, size="md") { const src=photoOf(photo); return `<span class="avatar ${size}">${src?`<img src="${esc(src)}" alt="">`:`<b>${esc(initials(name))}</b>`}</span>`; }
function pickName(role,booking,user={},profile={}){ return role==="customer"?(booking.customerName||user.name||user.displayName||booking.customerEmail||"Customer"):(booking.reeloName||profile.name||user.name||user.displayName||booking.reeloEmail||"Not assigned"); }
function pickPhone(role,booking,user={},profile={}){ return role==="customer"?(booking.customerPhone||user.phone||user.phoneNumber||"—"):(booking.reeloPhone||profile.phone||user.phone||user.phoneNumber||"—"); }
function pickPhoto(role,booking,user={},profile={}){ return role==="customer"?photoOf(booking.customerPhotoUrl,user.profilePhotoUrl,user.photoUrl,user.photoURL):photoOf(booking.reeloPhotoUrl,profile.profilePhotoUrl,profile.photoUrl,user.profilePhotoUrl,user.photoUrl,user.photoURL); }
async function hydratePeople(bookings){
  const userIds=[...new Set(bookings.flatMap(x=>[x.customerId,x.reeloId]).filter(Boolean))];
  const reeloIds=[...new Set(bookings.map(x=>x.reeloId).filter(Boolean))];
  await Promise.all(userIds.map(async id=>{if(peopleCache.users.has(id))return;try{const d=await getDoc(doc(db,"users",id));peopleCache.users.set(id,d.exists()?d.data():{});}catch{peopleCache.users.set(id,{})}}));
  await Promise.all(reeloIds.map(async id=>{if(peopleCache.reelos.has(id))return;try{const d=await getDoc(doc(db,"reelo_profiles",id));peopleCache.reelos.set(id,d.exists()?d.data():{});}catch{peopleCache.reelos.set(id,{})}}));
}
function bookingPeople(x){const cu=peopleCache.users.get(x.customerId)||{};const ru=peopleCache.users.get(x.reeloId)||{};const rp=peopleCache.reelos.get(x.reeloId)||{};return {customer:{name:pickName("customer",x,cu,rp),phone:pickPhone("customer",x,cu,rp),email:x.customerEmail||cu.email||"",photo:pickPhoto("customer",x,cu,rp)},reelo:{name:pickName("reelo",x,ru,rp),phone:pickPhone("reelo",x,ru,rp),email:x.reeloEmail||rp.email||ru.email||"",photo:pickPhoto("reelo",x,ru,rp),availability:rp.availability||""}};}
function packageLabel(x){return x.deliveryType==="edited"?"Edited & Reel-ready":"Originals";}
function sessionElapsedText(x){const d=toDate(x.startedAt);if(!d)return "Live";const m=Math.max(0,Math.floor((Date.now()-d.getTime())/60000));const h=Math.floor(m/60),r=m%60;return h?`${h}h ${r}m`:`${m}m`;}
function issueReason(x){const d=deliveryState(x);if(x.deliveryDisputed)return "Delivery dispute";if(d.key==="pending_upload"&&d.detail.includes("overdue"))return "Delivery overdue";if(x.paymentStatus==="failed")return "Payment failed";if(x.refundStatus==="manual_review_required")return "Refund needs review";if(x.operationalAttentionType)return String(x.operationalAttentionType).replaceAll("_"," ");if(x.operationalAttention)return "Booking needs review";if(x.status==="searching"&&toDate(x.requestExpiresAt)?.getTime()<Date.now())return "Matching expired";if(x.status==="completed"&&!x.deliveryStatus)return "Delivery state missing";return "Needs attention";}


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
$("open-filters").onclick=()=>openBookingFilters();
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
  reeloapprovals:["Reelo Approvals","Review live profile selfies and activate Reelos"],reelos:["Reelos","Availability, verification and editing eligibility"],earnings:["Earnings","Reelo earnings and payout readiness"],content:["Deliveries","Pending uploads, delivery reviews and disputes"],payments:["Payments","Customer charges, Reelo earnings and payout exceptions"],refunds:["Refunds","Refund requests and provider exceptions"],
  sos:["SOS Alerts","Safety alerts requiring immediate attention"],reports:["Reports","User reports and trust & safety cases"],feedback:["Feedback","Customer and Reelo feedback"],accounts:["Accounts","Deletion requests and account operations"],settings:["Settings","Admin audit and system controls"]
};
async function loadPage(id){
  if(pageUnsub){pageUnsub();pageUnsub=null;} closeDrawer(false);activePage=id;document.querySelectorAll("[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===id));
  const [title,sub]=PAGE_META[id]||["Operations",""];$("page-title").textContent=title;$("page-subtitle").textContent=sub;$("content").innerHTML='<div class="loading">Loading live operations…</div>';
  try{if(id==="overview")await loadOverview();else if(id==="bookings"||id==="controlrooms")await loadBookings();else if(id==="customerchats")await loadSupport("customer");else if(id==="reelochats")await loadSupport("reelo");else if(id==="reeloapprovals")await loadReeloApprovals();else if(id==="reelos")await loadReelos();else if(id==="content")await loadContent();else if(id==="payments"||id==="earnings")await loadPayments();else if(id==="refunds")await loadRefunds();else if(id==="sos")await loadSOS();else if(id==="reports"||id==="feedback")await loadReports();else if(id==="accounts")await loadAccounts();else if(id==="settings")await loadAudit();}
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
function bookingSearchText(id,x){return [id,bookingRef(id),x.occasion,x.customerName,x.customerEmail,x.customerId,x.reeloName,x.reeloEmail,x.reeloId,x.paymentReference,x.razorpayOrderId,x.location].filter(Boolean).join(" ").toLowerCase();}

async function fetchBookings(){const snap=await getDocs(query(collection(db,"bookings"),orderBy("updatedAt","desc"),limit(250)));bookingCache=snap.docs.map(d=>({id:d.id,...d.data()}));return bookingCache;}
async function loadOverview(){
  const [bookings,supportSnap,profilesSnap,sosSnap]=await Promise.all([
    fetchBookings(),
    getDocs(query(collection(db,"support_threads"),where("humanRequested","==",true))),
    getDocs(collection(db,"reelo_profiles")),
    getDocs(query(collection(db,"sos_alerts"),where("status","in",["active","acknowledged","escalated"])))
  ]);
  await hydratePeople(bookings.slice(0,120));
  const today=new Date();today.setHours(0,0,0,0);
  const todayBookings=bookings.filter(x=>toDate(x.createdAt)?.getTime()>=today.getTime());
  const payments=todayBookings.filter(x=>["captured","paid"].includes(x.paymentStatus)).reduce((s,x)=>s+Number(x.customerPrice||x.price||0),0);
  const online=profilesSnap.docs.filter(d=>d.data().availability==="Online").length;
  const pending=bookings.filter(x=>deliveryState(x).key==="pending_upload").length;
  const overdue=bookings.filter(x=>deliveryState(x).key==="pending_upload"&&deliveryState(x).detail.includes("overdue")).length;
  const attention=bookings.filter(needsAttention).slice(0,6);
  const live=bookings.filter(x=>x.status==="in_progress").slice(0,5);
  const recent=bookings.slice(0,7);
  const waitingChats=supportSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.unreadBySupport!==false);
  const pendingActions=attention.length+waitingChats.length+sosSnap.size;
  const card=(x,kind="attention")=>{const p=bookingPeople(x);const d=deliveryState(x);const s=sessionState(x);const title=kind==="live"?`${p.customer.name} ↔ ${p.reelo.name}`:issueReason(x);return `<article class="ops-item ${kind}">
    <div class="ops-avatar-wrap">${avatarHtml(kind==="live"?p.customer.name:(p.reelo.name!=="Not assigned"?p.reelo.name:p.customer.name),kind==="live"?p.customer.photo:(p.reelo.photo||p.customer.photo),"lg")}</div>
    <div class="ops-item-main"><div class="ops-item-top"><strong>${esc(title)}</strong><span>${esc(kind==="live"?sessionElapsedText(x):timeAgo(x.updatedAt||x.createdAt))}</span></div>
    <div class="ops-people-line">${esc(p.customer.name)}${p.reelo.name!=="Not assigned"?` <b>→</b> ${esc(p.reelo.name)}`:" · Reelo not assigned"}</div>
    <div class="ops-meta">${esc(x.occasion||"Booking")} · ${esc(packageLabel(x))} · ${esc(x.durationMinutes||0)} min</div>
    ${kind==="live"?`<div class="ops-statusline">${statusHtml(s.label,s.tone)} <span>${esc(x.captureDeviceResolved?String(x.captureDeviceResolved).replaceAll("_"," "):"Device not confirmed")}</span></div>`:`<div class="ops-statusline">${statusHtml(d.label,d.tone)} <span>${esc(d.detail)}</span></div>`}
    </div><button class="btn secondary" data-dashboard-booking="${esc(x.id)}">Open booking</button></article>`};
  $("content").innerHTML=`${metricsHtml([
    {label:"Today's bookings",value:todayBookings.length,icon:"▣",sub:"Created today"},
    {label:"Customer payments today",value:money(payments),icon:"₹",sub:`${todayBookings.filter(x=>["captured","paid"].includes(x.paymentStatus)).length} captured`,good:true},
    {label:"Reelos online",value:online,icon:"◎",sub:"Available now",good:true},
    {label:"Pending uploads",value:pending,icon:"⇧",sub:"Content still owed",warn:pending>0},
    {label:"Overdue deliveries",value:overdue,icon:"!",sub:"Past target",warn:overdue>0},
    {label:"Needs attention",value:pendingActions,icon:"!",sub:`${waitingChats.length} support waiting`,warn:pendingActions>0}
  ])}
  <div class="command-grid">
    <section class="panel attention-panel"><div class="panel-head"><div><h3>Needs your attention</h3><p>Problems first — people, booking context and the next action.</p></div><button class="text-link" data-go="bookings">View all</button></div><div class="ops-list">${attention.length?attention.map(x=>card(x)).join(""):'<div class="empty compact">No booking problems need attention right now.</div>'}${waitingChats.slice(0,3).map(t=>`<article class="ops-item support"><div class="ops-avatar-wrap">${avatarHtml(t.userName||t.userEmail||"Support",t.userPhotoUrl,"lg")}</div><div class="ops-item-main"><div class="ops-item-top"><strong>${esc(t.lastIntent||"Support message")}</strong><span>${esc(timeAgo(t.updatedAt))}</span></div><div class="ops-people-line">${esc(t.userName||t.userEmail||"User")}</div><div class="ops-meta">${esc(t.lastMessage||"Human help requested")}</div></div><button class="btn secondary" data-dashboard-support="${esc(t.id)}">Open chat</button></article>`).join("")}</div></section>
    <div class="command-stack">
      <section class="panel"><div class="panel-head"><div><h3>Live sessions</h3><p>Who is shooting right now.</p></div><button class="text-link" data-go="bookings">View all</button></div><div class="ops-list small">${live.length?live.map(x=>card(x,"live")).join(""):'<div class="empty compact">No sessions are live right now.</div>'}</div></section>
      <section class="panel"><div class="panel-head"><div><h3>Recent bookings</h3><p>Names first; booking ID remains available when needed.</p></div><button class="text-link" data-go="bookings">View all</button></div><div class="recent-list">${recent.map(x=>{const p=bookingPeople(x),st=sessionState(x);return `<button class="recent-row" data-dashboard-booking="${esc(x.id)}"><span>${avatarHtml(p.customer.name,p.customer.photo)}</span><span><strong>${esc(p.customer.name)}</strong><small>${esc(x.occasion||"Booking")} · ${esc(packageLabel(x))}</small></span><span>${p.reelo.name!=="Not assigned"?esc(p.reelo.name):"Unassigned"}</span><span>${money(x.customerPrice||x.price)}</span><span>${statusHtml(st.label,st.tone)}</span></button>`}).join("")}</div></section>
    </div>
  </div>`;
  document.querySelectorAll("[data-go]").forEach(a=>a.onclick=()=>loadPage(a.dataset.go));
  document.querySelectorAll("[data-dashboard-booking]").forEach(b=>b.onclick=()=>openBooking(b.dataset.dashboardBooking));
  document.querySelectorAll("[data-dashboard-support]").forEach(b=>b.onclick=()=>openSupportThread(b.dataset.dashboardSupport));
}
function metricsHtml(items){return `<div class="metrics ${items.length===6?'six':''}">${items.map(i=>`<button class="metric" type="button"><div class="metric-head"><span class="metric-icon">${i.icon}</span>${esc(i.label)}</div><strong>${esc(i.value)}</strong><small class="${i.good?'good':i.warn?'warn':''}">${esc(i.sub)}</small></button>`).join("")}</div>`;}
function applyBookingFilters(rows,filters=activeBookingFilters){
  const now=new Date(); const start=new Date(); start.setHours(0,0,0,0);
  return rows.filter(x=>{
    const d=toDate(x.scheduledDateTime||x.createdAt);
    if(filters.date==="today"&&(!d||d<start))return false;
    if(filters.date==="7d"&&(!d||d.getTime()<now.getTime()-7*86400000))return false;
    if(filters.status!=="all"&&x.status!==filters.status)return false;
    if(filters.package!=="all"&&x.deliveryType!==filters.package)return false;
    const del=deliveryState(x);
    if(filters.delivery!=="all"){
      if(filters.delivery==="overdue"&&!(del.key==="pending_upload"&&del.detail.includes("overdue")))return false;
      if(filters.delivery!=="overdue"&&del.key!==filters.delivery)return false;
    }
    const pay=paymentState(x);
    if(filters.payment==="paid"&&pay.label!=="Paid")return false;
    if(filters.payment==="issue"&&pay.tone!=="red")return false;
    if(filters.payment==="pending"&&(pay.label==="Paid"||pay.tone==="red"))return false;
    if(filters.assignment==="assigned"&&!x.reeloId)return false;
    if(filters.assignment==="unassigned"&&x.reeloId)return false;
    if(filters.attention&&!needsAttention(x))return false;
    return true;
  });
}
function openBookingFilters(){
  modal("Filter bookings",`<div class="filter-sheet"><div class="filter-grid">
    <label>Date<select id="f-date"><option value="all">Any date</option><option value="today">Today</option><option value="7d">Last 7 days</option></select></label>
    <label>Session status<select id="f-status"><option value="all">Any status</option>${["searching","accepted","arrived","in_progress","completed","cancelled","payment_pending"].map(v=>`<option value="${v}">${v.replaceAll("_"," ")}</option>`).join("")}</select></label>
    <label>Content package<select id="f-package"><option value="all">Any package</option><option value="originals">Originals</option><option value="edited">Edited & Reel-ready</option></select></label>
    <label>Delivery<select id="f-delivery"><option value="all">Any delivery state</option><option value="pending_upload">Pending upload</option><option value="uploading">Uploading</option><option value="approval">Pending approval</option><option value="overdue">Overdue</option><option value="dispute">Disputed</option></select></label>
    <label>Payment<select id="f-payment"><option value="all">Any payment</option><option value="paid">Paid</option><option value="pending">Pending</option><option value="issue">Payment issue</option></select></label>
    <label>Reelo assignment<select id="f-assignment"><option value="all">Assigned or unassigned</option><option value="assigned">Assigned</option><option value="unassigned">Unassigned</option></select></label>
  </div><label class="check-line"><input id="f-attention" type="checkbox"> Needs attention only</label><div class="filter-actions"><button class="btn secondary" id="clear-filters">Reset</button><button class="btn primary" id="apply-filters">Apply filters</button></div></div>`);
  for(const [id,key] of [["f-date","date"],["f-status","status"],["f-package","package"],["f-delivery","delivery"],["f-payment","payment"],["f-assignment","assignment"]]) $(id).value=activeBookingFilters[key];
  $("f-attention").checked=activeBookingFilters.attention;
  $("clear-filters").onclick=()=>{activeBookingFilters={date:"all",status:"all",package:"all",delivery:"all",payment:"all",assignment:"all",attention:false};$("modal").close();loadPage("bookings");};
  $("apply-filters").onclick=()=>{activeBookingFilters={date:$("f-date").value,status:$("f-status").value,package:$("f-package").value,delivery:$("f-delivery").value,payment:$("f-payment").value,assignment:$("f-assignment").value,attention:$("f-attention").checked};$("modal").close();loadPage("bookings");};
}
function renderBookingPanel(bookings,initial="all"){
  const filteredBase=applyBookingFilters(bookings);
  const counts={all:filteredBase.length,pending_upload:filteredBase.filter(x=>deliveryState(x).key==="pending_upload").length,overdue:filteredBase.filter(x=>deliveryState(x).key==="pending_upload"&&deliveryState(x).detail.includes("overdue")).length,payment:filteredBase.filter(x=>paymentState(x).tone==="red").length,cancelled:filteredBase.filter(x=>x.status==="cancelled").length,attention:filteredBase.filter(needsAttention).length};
  $("booking-panel").innerHTML=`<section class="panel"><div class="filter-tabs">${[["all","All"],["pending_upload","Pending Upload"],["overdue","Overdue Delivery"],["payment","Payment Issues"],["cancelled","Cancellations"],["attention","Needs Attention"]].map(([k,l])=>`<button class="filter-tab ${k===initial?'active':''}" data-filter="${k}">${l}<b>${counts[k]||0}</b></button>`).join("")}</div><div class="table-tools"><div class="mini-search"><span>⌕</span><input id="booking-search" placeholder="Search name, phone, occasion, booking or payment…"></div><div class="table-action-row"><button class="btn secondary" id="panel-filter">☷ Filters</button><button class="btn secondary" id="table-refresh">Refresh</button></div></div><div id="active-filter-summary"></div><div class="table-wrap"><table class="data-table practical-table"><thead><tr><th>Customer</th><th>Reelo</th><th>Booking</th><th>Session</th><th>Delivery</th><th>Customer payment</th><th>Status</th><th></th></tr></thead><tbody id="booking-rows"></tbody></table></div><div class="table-footer"><span id="table-count">Showing bookings</span><span class="subtle-note">Click a name/booking row to open Booking Control</span></div></section>`;
  let filter=initial,term="";
  const apply=()=>{let rows=applyBookingFilters(bookings);if(filter==="pending_upload")rows=rows.filter(x=>deliveryState(x).key==="pending_upload");else if(filter==="overdue")rows=rows.filter(x=>deliveryState(x).key==="pending_upload"&&deliveryState(x).detail.includes("overdue"));else if(filter==="payment")rows=rows.filter(x=>paymentState(x).tone==="red");else if(filter==="cancelled")rows=rows.filter(x=>x.status==="cancelled");else if(filter==="attention")rows=rows.filter(needsAttention);if(term)rows=rows.filter(x=>bookingSearchText(x.id,x).includes(term)||Object.values(bookingPeople(x)).some(p=>[p.name,p.phone,p.email].join(" ").toLowerCase().includes(term)));renderBookingRows(rows.slice(0,150));$("table-count").textContent=`${rows.length} booking${rows.length===1?'':'s'} shown`;const active=Object.entries(activeBookingFilters).filter(([k,v])=>v!=="all"&&v!==false);$("active-filter-summary").innerHTML=active.length?`<div class="active-filters"><strong>Filters:</strong>${active.map(([k,v])=>`<span>${esc(k)}: ${esc(v===true?'yes':String(v).replaceAll('_',' '))}</span>`).join('')}<button id="clear-inline-filters">Clear</button></div>`:"";$("clear-inline-filters")?.addEventListener("click",()=>{activeBookingFilters={date:"all",status:"all",package:"all",delivery:"all",payment:"all",assignment:"all",attention:false};renderBookingPanel(bookings,filter);});};
  document.querySelectorAll("[data-filter]").forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll("[data-filter]").forEach(x=>x.classList.toggle("active",x===b));apply();});
  $("booking-search").oninput=e=>{term=e.target.value.trim().toLowerCase();apply();};$("panel-filter").onclick=openBookingFilters;$("table-refresh").onclick=()=>loadPage(activePage);apply();
}
function renderBookingRows(rows){const body=$("booking-rows");if(!rows.length){body.innerHTML='<tr><td colspan="8"><div class="empty">No bookings match this view.</div></td></tr>';return;}body.innerHTML=rows.map(x=>{const del=deliveryState(x),ses=sessionState(x),pay=paymentState(x),att=needsAttention(x),p=bookingPeople(x);return `<tr class="clickable-row" data-row-booking="${esc(x.id)}"><td><div class="identity-cell">${avatarHtml(p.customer.name,p.customer.photo)}<div><strong>${esc(p.customer.name)}</strong><span>${esc(p.customer.phone!=="—"?p.customer.phone:p.customer.email||"Customer")}</span></div></div></td><td><div class="identity-cell">${avatarHtml(p.reelo.name,p.reelo.photo)}<div><strong>${esc(p.reelo.name)}</strong><span>${esc(p.reelo.phone!=="—"?p.reelo.phone:p.reelo.email||"")}</span></div></div></td><td><strong>${esc(x.occasion||"Booking")}</strong><span class="sub">${esc(packageLabel(x))} · ${esc(x.durationMinutes||0)} min</span><button class="booking-link subtle" data-booking="${esc(x.id)}">${esc(bookingRef(x.id,x))}</button></td><td><strong>${esc(dateText(x.scheduledDateTime||x.createdAt))}</strong><span class="sub">${esc(x.location||x.address||"")}</span></td><td>${statusHtml(del.label,del.tone)}<span class="sub">${esc(del.detail)}</span></td><td><span class="amount">${money(x.customerPrice||x.price)}</span><span class="sub ${pay.tone==='green'?'good':''}">${esc(pay.label)}</span></td><td>${att?statusHtml(issueReason(x),"red"):statusHtml(ses.label,ses.tone)}</td><td><button class="btn secondary" data-booking="${esc(x.id)}">Open</button></td></tr>`;}).join("");body.querySelectorAll("[data-booking]").forEach(b=>b.onclick=e=>{e.stopPropagation();openBooking(b.dataset.booking)});body.querySelectorAll("[data-row-booking]").forEach(r=>r.onclick=()=>openBooking(r.dataset.rowBooking));}

async function loadBookings(){const bookings=await fetchBookings();await hydratePeople(bookings.slice(0,180));$("content").innerHTML='<div id="booking-panel"></div>';renderBookingPanel(bookings,"all");}

async function openBooking(id,tab="overview"){
  clearDrawerStreams();activeBookingId=id;const snap=await getDoc(doc(db,"bookings",id));if(!snap.exists())return toast("Booking not found.");const x={id,...snap.data()};
  $("drawer-title").textContent=`${x.customerName||"Customer"} ↔ ${x.reeloName||"Reelo"} · ${x.occasion||"Booking"}`;$("drawer").classList.add("open");$("drawer").setAttribute("aria-hidden","false");
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
  const tabs=[['overview','Booking Control'],['customer','Customer Chat'],['reelo','Reelo Chat'],['files','Files'],['timeline','Timeline']];
  const ses=sessionState(x);
  $("drawer-body").innerHTML=`<div class="drawer-booking-summary"><div><strong>${bookingRef(x.id,x)}</strong> ${statusHtml(ses.label,ses.tone)}<span>${esc(x.occasion||"Booking")} · ${dateText(x.scheduledDateTime||x.createdAt)}</span></div><button class="copy-ref" id="copy-booking-ref">Copy ID</button></div><div class="drawer-tabs">${tabs.map(([k,l])=>`<button class="drawer-tab ${tab===k?'active':''}" data-dtab="${k}">${l}${k==='customer'&&customerThread?.unreadBySupport?' •':''}${k==='reelo'&&reeloThread?.unreadBySupport?' •':''}</button>`).join("")}</div><div id="drawer-tab-content"></div>`;
  $("copy-booking-ref").onclick=async()=>{try{await navigator.clipboard.writeText(x.id);toast("Booking ID copied.");}catch{toast(x.id);}};
  document.querySelectorAll("[data-dtab]").forEach(b=>b.onclick=()=>renderDrawer(x,b.dataset.dtab));
  const people={profile,customerUser,reeloUser};
  if(tab==="overview")renderOverviewTab(x,people);else if(tab==="timeline")renderTimelineTab(x);else if(tab==="files")await renderFilesTab(x);else if(tab==="customer")await renderChatTab(x,customerThread,"customer",people);else if(tab==="reelo")await renderChatTab(x,reeloThread,"reelo",people);
}
function renderOverviewTab(x,people){
  const {profile={},customerUser={},reeloUser={}}=people||{};
  const del=deliveryState(x),ses=sessionState(x),pay=paymentState(x),availability=profile.availability||"Unknown";
  const deliveryPending=del.key==="pending_upload"||del.key==="uploading";
  const customerPhone=customerUser.phone||customerUser.phoneNumber||x.customerPhone||"—";
  const reeloPhone=profile.phone||reeloUser.phone||reeloUser.phoneNumber||x.reeloPhone||"—";
  const customerDisplay=x.customerName||customerUser.name||customerUser.displayName||x.customerEmail||"Customer";
  const reeloDisplay=x.reeloName||profile.name||reeloUser.name||reeloUser.displayName||x.reeloEmail||"Not assigned";
  const customerPhoto=pickPhoto("customer",x,customerUser,profile);
  const reeloPhoto=pickPhoto("reelo",x,reeloUser,profile);
  const reeloEarn=x.reeloEarnings??x.earnings??0;
  const payoutStatus=x.payoutStatus||x.reeloPayoutStatus||(x.earningsEligibleAt?"Eligible / awaiting payout":"Not eligible yet");
  const providerRef=x.paymentReference||x.razorpayPaymentId||x.razorpayOrderId||"—";
  const forceStatuses=["searching","accepted","arrived","in_progress","completed","cancelled"];
  $("drawer-tab-content").innerHTML=`
  <section class="drawer-section control-identity"><div class="section-title-row"><h3>People</h3><span class="micro">Private Operations data</span></div><div class="people-grid"><div class="person-card visual-person-card">${avatarHtml(customerDisplay,customerPhoto,"lg")}<div><span class="role-pill customer">Customer</span><strong>${esc(customerDisplay)}</strong><span>${esc(customerPhone)}</span><span>${esc(x.customerEmail||customerUser.email||"—")}</span><small>${esc(x.customerRef||x.customerId||"—")}</small></div></div><div class="person-card visual-person-card">${avatarHtml(reeloDisplay,reeloPhoto,"lg")}<div><span class="role-pill reelo">Reelo</span><strong>${esc(reeloDisplay)}</strong><span>${esc(reeloPhone)}</span><span>${esc(x.reeloEmail||profile.email||reeloUser.email||"—")}</span><small>${esc(x.reeloRef||profile.reeloRef||x.reeloId||"—")}</small></div></div></div></section>
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
  if(!confirm(`Force ${bookingRef(x.id,x)} from ${x.status||'unknown'} to ${targetStatus}?`))return;
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
function renderTimelineTab(x){const items=[["Booking created",x.createdAt],["Payment captured",x.paymentCapturedAt],["Reelo accepted",x.acceptedAt],["Reelo on the way",x.leftAt],["Arrived",x.arrivedAt],["Session started",x.startedAt],["Session completed",x.completedAt],["Content delivered",x.deliveredAt],["Customer accepted",x.deliveryConfirmedAt]].filter(([,v])=>v);$("drawer-tab-content").innerHTML=`<section class="drawer-section"><h3>Booking timeline</h3><div class="timeline">${items.length?items.map(([l,v])=>`<div class="timeline-item"><strong>${esc(l)}</strong><span>${esc(dateText(v))}</span></div>`).join(""):'<div class="empty">No lifecycle timestamps have been recorded.</div>'}</div></section>`;}
async function renderFilesTab(x){$("drawer-tab-content").innerHTML='<section class="drawer-section"><div class="loading">Loading delivered files…</div></section>';const snap=await getDocs(query(collection(db,"booking_media"),where("bookingId","==",x.id)));const items=snap.docs.map(d=>d.data());$("drawer-tab-content").innerHTML=`<section class="drawer-section"><h3>Content delivery</h3><div class="state-stack"><div class="state-row"><span>Delivery</span>${statusHtml(deliveryState(x).label,deliveryState(x).tone)}</div><div class="state-row"><span>Required</span><strong>${esc(x.requiredPhotoCount||"—")} photos · ${esc(x.requiredReelCount||"—")} reels</strong></div><div class="state-row"><span>Uploaded</span><strong>${items.filter(i=>i.type==='photo').length} photos · ${items.filter(i=>i.type==='reel').length} reels</strong></div></div></section><section class="drawer-section"><h3>Uploaded files</h3><div class="file-list">${items.length?items.map(i=>`<div class="file-item"><strong>${esc(i.fileName||i.type||"File")}</strong><span>${esc(i.type||"")} · ${esc(i.status||"active")} · ${esc(dateText(i.uploadedAt))}</span></div>`).join(""):'<div class="empty">No content has been uploaded for this booking.</div>'}</div></section>`;}
async function renderChatTab(x,thread,role,people={}){
  const isCustomer=role==="customer";
  const person=isCustomer?people.customerUser:(people.profile||{});
  const displayName=isCustomer?(x.customerName||person.name||person.displayName||x.customerEmail||"Customer"):(x.reeloName||person.name||x.reeloEmail||"Reelo");
  const phone=person.phone||person.phoneNumber||(isCustomer?x.customerPhone:x.reeloPhone)||"—";
  const email=isCustomer?(x.customerEmail||person.email):(x.reeloEmail||person.email);
  const identityRef=isCustomer?(x.customerRef||x.customerId):(x.reeloRef||people.profile?.reeloRef||x.reeloId);
  const personPhoto=isCustomer?pickPhoto("customer",x,people.customerUser||{},{}):pickPhoto("reelo",x,people.reeloUser||{},people.profile||{});
  if(!thread){$("drawer-tab-content").innerHTML=`<section class="drawer-section"><div class="chat-context"><div class="chat-person-head">${avatarHtml(displayName,personPhoto,"lg")}<div><span class="role-pill ${isCustomer?'customer':'reelo'}">${isCustomer?'Customer':'Reelo'}</span><strong>${esc(displayName)}</strong><span>${esc(email||"—")} · ${esc(phone)}</span><small>${esc(identityRef||"—")}</small></div></div><button class="booking-context-button" data-dtab="overview">Open booking control</button></div><div class="empty">No human support conversation is linked to this booking for the ${role}.</div></section>`;document.querySelector('[data-dtab="overview"]')?.addEventListener("click",()=>renderDrawer(x,"overview"));return;}
  const categories=isCustomer?["booking","reelo","session","content_delivery","payment_refund","safety","account","technical","other"]:["booking_request","customer","arrival_otp","session","upload","editing_delivery","earnings","payout","safety","account_approval","technical","other"];
  const priority=thread.casePriority||"normal",category=thread.caseCategory||"other";
  $("drawer-tab-content").innerHTML=`
  <section class="drawer-section"><div class="chat-context"><div class="chat-person-head">${avatarHtml(displayName,personPhoto,"lg")}<div><span class="role-pill ${isCustomer?'customer':'reelo'}">${isCustomer?'Customer':'Reelo'}</span><strong>${esc(displayName)}</strong><span>${esc(email||thread.userEmail||"—")} · ${esc(phone)}</span><small>${esc(identityRef||thread.userId||"—")}</small></div></div><button class="booking-context-button" id="open-booking-control">${esc(bookingRef(x.id,x))} · Booking control</button></div><div class="case-meta-grid"><label>Category<select id="case-category">${categories.map(v=>`<option value="${v}" ${v===category?'selected':''}>${v.replaceAll('_',' ')}</option>`).join('')}</select></label><label>Priority<select id="case-priority"><option value="low" ${priority==='low'?'selected':''}>Low</option><option value="normal" ${priority==='normal'?'selected':''}>Normal</option><option value="high" ${priority==='high'?'selected':''}>High</option><option value="urgent" ${priority==='urgent'?'selected':''}>Urgent</option></select></label><button class="btn secondary" id="save-case-meta">Save case</button></div><div class="case-status-line"><span>Support case</span>${statusHtml(thread.status||"open",thread.humanRequested?"orange":"blue")}<small>Thread ${esc(thread.id)} · ${esc(timeAgo(thread.updatedAt))}</small></div></section>
  <section class="drawer-section support-booking-strip"><div><strong>${esc(x.occasion||"Booking")}</strong><span>${esc(packageLabel(x))} · ${esc(x.durationMinutes||0)} min · ${esc(sessionState(x).label)}</span></div><div><span>Delivery</span><strong>${esc(deliveryState(x).label)} · ${esc(deliveryState(x).detail)}</strong></div><div><span>Customer paid</span><strong>${money(x.customerPrice||x.price)}</strong></div><div><span>Reelo earning</span><strong>${money(x.reeloEarnings??x.earnings??0)}</strong></div></section>
  <section class="drawer-section"><div id="drawer-chat" class="chat-box"><div class="loading">Loading conversation…</div></div><div class="quick"><button data-quick="I am reviewing this booking now. Please keep this chat open while I check it.">Reviewing now</button><button data-quick="Please tell me exactly what happened. Do not share passwords, OTPs, UPI PINs or full payment details.">Ask for details</button><button data-quick="I am checking the payment and booking records linked to this booking now.">Checking payment</button><button data-quick="I am checking the session and delivery timeline now.">Checking delivery</button></div><div class="chat-compose"><textarea id="chat-reply" rows="2" placeholder="Reply as Reel It Support"></textarea><button class="btn primary" id="send-chat">Send</button></div><div class="chat-compose internal"><textarea id="support-note" rows="2" placeholder="Internal case note — never sent to the user"></textarea><button class="btn secondary" id="save-support-note">Save note</button></div><div class="action-stack"><button class="btn secondary" id="resolve-chat">Resolve conversation</button></div></section>`;
  $("open-booking-control").onclick=()=>renderDrawer(x,"overview");
  const ref=doc(db,"support_threads",thread.id);const q=query(collection(ref,"messages"),orderBy("createdAt"));
  const unsub=onSnapshot(q,snap=>{const box=$("drawer-chat");if(!box)return;box.innerHTML=snap.docs.map(d=>{const m=d.data();const cls=m.senderType==="support"?"support":m.senderType==="system"||m.senderType==="assistant"?"system":"";return `<div class="bubble ${cls}"><span>${esc(m.text||"")}</span><small>${esc(dateText(m.createdAt))}</small></div>`;}).join("")||'<div class="empty">No messages.</div>';box.scrollTop=box.scrollHeight;});drawerUnsubs.push(unsub);
  document.querySelectorAll("[data-quick]").forEach(b=>b.onclick=()=>$("chat-reply").value=b.dataset.quick);
  $("save-case-meta").onclick=async()=>{try{await setDoc(ref,{caseCategory:$("case-category").value,casePriority:$("case-priority").value,assignedAdminId:auth.currentUser.uid,assignedAdminEmail:auth.currentUser.email||"",caseUpdatedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});toast("Case category and priority saved.");}catch(e){toast(friendly(e));}};
  $("send-chat").onclick=async()=>{const text=$("chat-reply").value.trim();if(!text)return;await addDoc(collection(ref,"messages"),{senderId:auth.currentUser.uid,senderType:"support",text,createdAt:serverTimestamp()});await setDoc(ref,{lastMessage:text,lastMessageBy:"support",lastMessageSender:"support",unreadBySupport:false,unreadByUser:true,status:"open",assignedAdminId:auth.currentUser.uid,assignedAdminEmail:auth.currentUser.email||"",updatedAt:serverTimestamp()},{merge:true});$("chat-reply").value="";toast("Reply sent.");};
  $("save-support-note").onclick=async()=>{const note=$("support-note").value.trim();if(!note)return toast("Write an internal note first.");try{await httpsCallable(functions,"addOperationsNote")({targetType:"support",targetId:thread.id,note});$("support-note").value="";toast("Internal case note saved and audited.");}catch(e){toast(friendly(e));}};
  $("resolve-chat").onclick=async()=>{if(!confirm("Resolve this support conversation?"))return;await setDoc(ref,{status:"resolved",humanRequested:false,unreadBySupport:false,resolvedAt:serverTimestamp(),resolvedByAdminId:auth.currentUser.uid,resolvedByAdminEmail:auth.currentUser.email||"",updatedAt:serverTimestamp()},{merge:true});toast("Conversation resolved.");await renderDrawer(x,role);};
}

async function loadSupport(role){
  const snap=await getDocs(query(collection(db,"support_threads"),where("humanRequested","==",true)));
  const base=snap.docs.map(d=>({id:d.id,...d.data()})).filter(t=>(t.userRole||"customer")===role).sort((a,b)=>(b.updatedAt?.seconds||0)-(a.updatedAt?.seconds||0));
  const rows=await Promise.all(base.map(async t=>{
    let user={},profile={},booking=null;
    try{if(t.userId){const u=await getDoc(doc(db,"users",t.userId));if(u.exists())user=u.data();}}catch{}
    try{if(role==="reelo"&&t.userId){const r=await getDoc(doc(db,"reelo_profiles",t.userId));if(r.exists())profile=r.data();}}catch{}
    try{if(t.bookingId){const b=await getDoc(doc(db,"bookings",t.bookingId));if(b.exists())booking={id:b.id,...b.data()};}}catch{}
    return {...t,user,profile,booking};
  }));
  const roleLabel=role==="reelo"?"Reelo":"Customer";
  const high=rows.filter(t=>["urgent","high"].includes(String(t.casePriority||"").toLowerCase())||t.unreadBySupport).length;
  $("content").innerHTML=`${metricsHtml([{label:"Open chats",value:rows.length,icon:"◎",sub:`${roleLabel} conversations`},{label:"Waiting for reply",value:rows.filter(x=>x.unreadBySupport).length,icon:"!",sub:"Needs your response",warn:true},{label:"High priority",value:high,icon:"!",sub:"Urgent / unread",warn:high>0}])}<section class="panel"><div class="panel-head"><div><h3>${roleLabel} Chats</h3><p>People first. Every booking-linked conversation carries booking, delivery and money context.</p></div><div class="table-action-row"><div class="mini-search support-search"><span>⌕</span><input id="support-search" placeholder="Search name, phone, booking or message…"></div><button class="btn secondary" id="support-refresh">Refresh</button></div></div><div class="chat-queue" id="chat-queue"></div></section>`;
  const render=(term="")=>{const q=term.toLowerCase();const filtered=rows.filter(t=>{const b=t.booking||{},u=t.user||{},p=t.profile||{};return !q||[t.userName,t.userEmail,t.userId,u.name,u.displayName,u.phone,u.phoneNumber,p.name,p.phone,t.lastMessage,t.lastIntent,t.caseCategory,b.occasion,b.bookingRef,t.bookingId].filter(Boolean).join(" ").toLowerCase().includes(q)});$("chat-queue").innerHTML=filtered.length?filtered.map(t=>{const b=t.booking||{},u=t.user||{},p=t.profile||{};const name=t.userName||p.name||u.name||u.displayName||t.userEmail||roleLabel;const phone=p.phone||u.phone||u.phoneNumber||"—";const photo=photoOf(t.userPhotoUrl,p.profilePhotoUrl,p.photoUrl,u.profilePhotoUrl,u.photoUrl,u.photoURL);const priority=String(t.casePriority||(t.unreadBySupport?"high":"normal")).toLowerCase();const prTone=priority==="urgent"||priority==="high"?"red":priority==="normal"?"blue":"";return `<article class="chat-case-card"><div class="chat-case-person">${avatarHtml(name,photo,"lg")}<div><div class="name-line"><strong>${esc(name)}</strong>${statusHtml(priority.toUpperCase(),prTone)}</div><span>${esc(phone)}${t.userEmail?` · ${esc(t.userEmail)}`:""}</span><small>${esc(roleLabel)}${t.caseCategory?` · ${esc(String(t.caseCategory).replaceAll("_"," "))}`:""}</small></div></div><div class="chat-case-booking">${t.bookingId?`<strong>${esc(b.occasion||t.bookingOccasion||"Booking")}</strong><span>${esc(packageLabel(b))} · ${esc(b.durationMinutes||"")} ${b.durationMinutes?"min":""}</span><button class="booking-link" data-support-booking="${esc(t.bookingId)}">${esc(bookingRef(t.bookingId,b))}</button>`:'<strong>General support</strong><span>No booking linked</span>'}</div><div class="chat-case-message"><strong>${esc(t.lastIntent||"Support")}</strong><span>${esc(t.lastMessage||"Human help requested")}</span><small>${esc(timeAgo(t.updatedAt))}</small></div><div class="chat-case-action">${t.unreadBySupport?statusHtml("Waiting for you","orange"):statusHtml(t.status||"Open","blue")}<button class="btn primary" data-support="${esc(t.id)}">Open case</button></div></article>`}).join(""):'<div class="empty">No matching support conversations.</div>';document.querySelectorAll("[data-support-booking]").forEach(b=>b.onclick=()=>b.dataset.supportBooking&&openBooking(b.dataset.supportBooking,role));document.querySelectorAll("[data-support]").forEach(b=>b.onclick=()=>openSupportThread(b.dataset.support));};
  $("support-search").oninput=e=>render(e.target.value.trim());$("support-refresh").onclick=()=>loadPage(role==="reelo"?"reelochats":"customerchats");render();
}

async function openSupportThread(id){const snap=await getDoc(doc(db,"support_threads",id));if(!snap.exists())return toast("Support thread not found.");const t={id,...snap.data()};if(t.bookingId)return openBooking(t.bookingId,t.userRole==="reelo"?"reelo":"customer");modal("Support conversation",`<p class="muted">This support case is not linked to a booking.</p><p><strong>${esc(t.userEmail||t.userId||'User')}</strong></p><p>${esc(t.lastMessage||'Human help requested')}</p>`);}

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

async function loadReelos(){const snap=await getDocs(collection(db,"reelo_profiles"));const rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.name||a.email||a.id).localeCompare(String(b.name||b.email||b.id)));$("content").innerHTML=`${metricsHtml([{label:"Total Reelos",value:rows.length,icon:"◎",sub:"Profiles"},{label:"Online",value:rows.filter(x=>x.availability==='Online').length,icon:"●",sub:"Available now",good:true},{label:"Busy",value:rows.filter(x=>x.availability==='Busy').length,icon:"●",sub:"Active session",warn:true},{label:"Editing Approved",value:rows.filter(x=>x.editingApprovalStatus==='approved').length,icon:"✦",sub:"Eligible for Edited"},{label:"Needs Review",value:rows.filter(x=>x.verificationStatus==='pending_manual_review'||x.editingApprovalStatus==='pending_review').length,icon:"!",sub:"Manual review",warn:true}])}<section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Reelo</th><th>Availability</th><th>Verified</th><th>Editing</th><th>Completed</th><th>Rating</th></tr></thead><tbody>${rows.map(x=>`<tr><td><span class="person">${esc(x.name||x.displayName||x.email||x.id)}</span><span class="sub">${esc(x.email||x.id)}</span></td><td>${statusHtml(x.availability||'Offline',x.availability==='Online'?'green':x.availability==='Busy'?'orange':'')}</td><td>${statusHtml(x.verified?'Approved':'Not approved',x.verified?'green':'orange')}</td><td>${statusHtml(x.editingApprovalStatus||'Not requested',x.editingApprovalStatus==='approved'?'violet':x.editingApprovalStatus==='pending_review'?'orange':'')}</td><td>${esc(x.completedBookings||0)}</td><td>${esc(x.rating||0)} ★</td></tr>`).join("")}</tbody></table></div></section>`;}

async function loadContent(){const bookings=await fetchBookings();await hydratePeople(bookings.slice(0,180));const rows=bookings.filter(x=>['pending_upload','uploading','approval','dispute'].includes(deliveryState(x).key));$("content").innerHTML='<div id="booking-panel"></div>';renderBookingPanel(rows,"all");}
async function loadPayments(){
  const bookings=await fetchBookings();await hydratePeople(bookings.slice(0,200));
  const rows=bookings.filter(x=>x.paymentStatus||x.razorpayOrderId||x.paymentReference||x.reeloEarnings||x.earnings||x.payoutStatus||x.refundStatus);
  const earningsView=activePage==="earnings";
  const issues=rows.filter(x=>paymentState(x).tone==="red"||["failed","manual_review_required"].includes(x.refundStatus)||String(x.payoutStatus||"").toLowerCase().includes("failed"));
  $("content").innerHTML=`${metricsHtml([{label:"Booking money records",value:rows.length,icon:"₹",sub:"Customer + Reelo ledger"},{label:"Payment issues",value:issues.filter(x=>paymentState(x).tone==="red").length,icon:"!",sub:"Customer-side review",warn:true},{label:"Payout issues",value:issues.filter(x=>String(x.payoutStatus||"").toLowerCase().includes("failed")).length,icon:"!",sub:"Reelo-side review",warn:true},{label:"Refund issues",value:issues.filter(x=>["failed","manual_review_required"].includes(x.refundStatus)).length,icon:"↩",sub:"Needs reconciliation",warn:true}])}<section class="panel"><div class="panel-head"><div><h3>${earningsView?'Reelo earnings & payout readiness':'Money & payment ledger'}</h3><p>Customer payment, Reelo earning, payout and refund stay separate so Support can see exactly where money is stuck.</p></div><div class="table-action-row"><div class="mini-search support-search"><span>⌕</span><input id="money-search" placeholder="Search customer, Reelo, booking, payment or payout…"></div><button class="btn secondary" id="money-refresh">Refresh</button></div></div><div class="table-wrap"><table class="data-table money-table practical-table"><thead><tr><th>People / booking</th><th>Customer charge</th><th>Payment</th><th>Reelo earning</th><th>Fulfillment / hold</th><th>Payout</th><th>Refund</th><th></th></tr></thead><tbody id="money-rows"></tbody></table></div></section>`;
  const render=(term="")=>{const q=term.toLowerCase();const filtered=rows.filter(x=>{const p=bookingPeople(x);return !q||[p.customer.name,p.customer.phone,p.reelo.name,p.reelo.phone,x.id,bookingRef(x.id,x),x.paymentReference,x.razorpayOrderId,x.payoutReference,x.occasion].filter(Boolean).join(" ").toLowerCase().includes(q)});$("money-rows").innerHTML=filtered.length?filtered.map(x=>{const pay=paymentState(x),earning=x.reeloEarnings??x.earnings??0,payout=x.payoutStatus||x.reeloPayoutStatus||(x.earningsEligibleAt?"Eligible":"Not eligible"),fulfill=x.earningsEligibleAt?"Fulfillment cleared":deliveryState(x).label,p=bookingPeople(x);return `<tr><td><div class="money-people"><div>${avatarHtml(p.customer.name,p.customer.photo)}<span><strong>${esc(p.customer.name)}</strong><small>Customer</small></span></div><div>${avatarHtml(p.reelo.name,p.reelo.photo)}<span><strong>${esc(p.reelo.name)}</strong><small>Reelo</small></span></div></div><button class="booking-link subtle" data-money-booking="${esc(x.id)}">${esc(x.occasion||"Booking")} · ${esc(bookingRef(x.id,x))}</button></td><td><strong>${money(x.customerPrice||x.price)}</strong><span class="sub">${esc(x.paymentReference||x.razorpayOrderId||"No provider ref")}</span></td><td>${statusHtml(pay.label,pay.tone)}</td><td><strong>${money(earning)}</strong><span class="sub">${esc(p.reelo.name)}</span></td><td>${statusHtml(fulfill,x.earningsEligibleAt?"green":"orange")}<span class="sub">${esc(deliveryState(x).detail)}</span></td><td>${statusHtml(payout,String(payout).toLowerCase().includes("paid")?"green":String(payout).toLowerCase().includes("failed")?"red":"orange")}<span class="sub">${esc(x.payoutReference||"")}</span></td><td>${x.refundStatus?statusHtml(String(x.refundStatus).replaceAll("_"," "),x.refundStatus==="completed"?"green":["failed","manual_review_required"].includes(x.refundStatus)?"red":"orange"):"—"}</td><td><button class="btn secondary" data-money-booking="${esc(x.id)}">Open</button></td></tr>`}).join(""):'<tr><td colspan="8"><div class="empty">No matching money records.</div></td></tr>';document.querySelectorAll("[data-money-booking]").forEach(b=>b.onclick=()=>openBooking(b.dataset.moneyBooking,"overview"));};
  $("money-search").oninput=e=>render(e.target.value.trim());$("money-refresh").onclick=()=>loadPage(activePage);render();
}
async function loadRefunds(){const bookings=await fetchBookings();const rows=bookings.filter(x=>x.refundStatus&&x.refundStatus!=="not_required");$("content").innerHTML='<div id="booking-panel"></div>';renderBookingPanel(rows,"all");}
async function loadSOS(){const snap=await getDocs(query(collection(db,"sos_alerts"),orderBy("createdAt","desc"),limit(100)));const rows=snap.docs.map(d=>({id:d.id,...d.data()}));$("content").innerHTML=`<section class="panel"><div class="queue-list"><div class="queue-row head"><div>Priority</div><div>User</div><div>Booking</div><div>Status</div><div>Note</div><div>Action</div></div>${rows.length?rows.map(x=>`<div class="queue-row"><div>${statusHtml('SOS','red')}</div><div><strong>${esc(x.raisedByName||x.raisedByEmail||x.raisedBy||'User')}</strong></div><div><button class="booking-link" data-sos-booking="${esc(x.bookingId||'')}">${x.bookingId?bookingRef(x.bookingId):'—'}</button></div><div>${statusHtml(x.status||'active',x.status==='resolved'?'green':'red')}</div><div><span class="sub">${esc(x.note||'No note')}</span></div><div>${x.status!=='resolved'?`<button class="btn primary" data-sos-resolve="${esc(x.id)}">Resolve</button>`:''}</div></div>`).join(""):'<div class="empty">No SOS alerts.</div>'}</div></section>`;document.querySelectorAll("[data-sos-booking]").forEach(b=>b.onclick=()=>b.dataset.sosBooking&&openBooking(b.dataset.sosBooking));document.querySelectorAll("[data-sos-resolve]").forEach(b=>b.onclick=async()=>{await updateDoc(doc(db,"sos_alerts",b.dataset.sosResolve),{status:"resolved",resolvedAt:serverTimestamp(),updatedAt:serverTimestamp()});loadPage("sos");});}
async function loadReports(){const snap=await getDocs(query(collection(db,"user_reports"),orderBy("createdAt","desc"),limit(100)));const rows=snap.docs.map(d=>({id:d.id,...d.data()}));renderSimpleTable("User reports",rows,[['reason','Reason'],['reporterEmail','Reporter'],['reportedUserName','Reported'],['status','Status'],['bookingId','Booking']],"user_reports");}
async function loadAccounts(){const snap=await getDocs(query(collection(db,"account_deletion_requests"),orderBy("requestedAt","desc"),limit(100)));const rows=snap.docs.map(d=>({id:d.id,...d.data()}));renderSimpleTable("Account deletion requests",rows,[['email','Account'],['status','Status'],['requestedAt','Requested'],['failureReason','Failure']],"account_deletion_requests");}
async function loadAudit(){const snap=await getDocs(query(collection(db,"audit_logs"),orderBy("createdAt","desc"),limit(150)));const rows=snap.docs.map(d=>({id:d.id,...d.data()}));renderSimpleTable("Privileged action audit log",rows,[['action','Action'],['adminEmail','Admin'],['targetId','Target'],['reason','Reason'],['createdAt','When']],"audit_logs");}
function renderSimpleTable(title,rows,cols){$("content").innerHTML=`<section class="panel"><div class="panel-head"><div><h3>${esc(title)}</h3><p>${rows.length} records</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr>${cols.map(([,l])=>`<th>${esc(l)}</th>`).join("")}</tr></thead><tbody>${rows.length?rows.map(x=>`<tr>${cols.map(([k])=>`<td>${k==='bookingId'&&x[k]?`<button class="booking-link" data-generic-booking="${esc(x[k])}">${bookingRef(x[k])}</button>`:esc(x[k]?.toDate?dateText(x[k]):x[k]??'—')}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${cols.length}"><div class="empty">Nothing to show.</div></td></tr>`}</tbody></table></div></section>`;document.querySelectorAll("[data-generic-booking]").forEach(b=>b.onclick=()=>openBooking(b.dataset.genericBooking));}

async function runGlobalSearch(){
  const term=$("global-search").value.trim();if(!term)return toast("Enter a name, phone, booking, Reelo/customer ID, email, payment or payout reference.");
  try{
    const qtext=term.toLowerCase();
    let all=bookingCache.length?bookingCache:await fetchBookings();await hydratePeople(all.slice(0,200));
    const direct=await getDoc(doc(db,"bookings",term)).catch(()=>null);if(direct?.exists())return openBooking(direct.id);
    const bookingHits=all.filter(x=>bookingSearchText(x.id,x).includes(qtext)||bookingRef(x.id,x).toLowerCase().includes(qtext)||Object.values(bookingPeople(x)).some(p=>[p.name,p.phone,p.email].join(" ").toLowerCase().includes(qtext)));
    let users=[],reelos=[],threads=[];
    try{const u=await getDocs(collection(db,"users"));users=u.docs.map(d=>({id:d.id,...d.data()})).filter(x=>[x.id,x.name,x.displayName,x.email,x.phone,x.phoneNumber,x.customerRef].filter(Boolean).join(" ").toLowerCase().includes(qtext)).slice(0,20);}catch{}
    try{const r=await getDocs(collection(db,"reelo_profiles"));reelos=r.docs.map(d=>({id:d.id,...d.data()})).filter(x=>[x.id,x.name,x.displayName,x.email,x.phone,x.reeloRef].filter(Boolean).join(" ").toLowerCase().includes(qtext)).slice(0,20);}catch{}
    try{const t=await getDocs(query(collection(db,"support_threads"),limit(150)));threads=t.docs.map(d=>({id:d.id,...d.data()})).filter(x=>[x.id,x.userName,x.userEmail,x.userId,x.bookingId,x.lastIntent,x.lastMessage,x.caseCategory].filter(Boolean).join(" ").toLowerCase().includes(qtext)).slice(0,20);}catch{}
    $("page-title").textContent="Search results";$("page-subtitle").textContent=`Results for “${term}”`;
    const personCard=(x,role)=>{const name=x.name||x.displayName||x.email||(role==="Reelo"?"Reelo":"Customer"),phone=x.phone||x.phoneNumber||"—",photo=photoOf(x.profilePhotoUrl,x.photoUrl,x.photoURL);return `<article class="search-person">${avatarHtml(name,photo,"lg")}<div><span class="role-pill ${role==='Reelo'?'reelo':'customer'}">${role}</span><strong>${esc(name)}</strong><span>${esc(phone)}${x.email?` · ${esc(x.email)}`:""}</span><small>${esc(x.reeloRef||x.customerRef||x.id)}</small></div><button class="btn secondary" data-person-bookings="${esc(x.id)}">Related bookings</button></article>`};
    $("content").innerHTML=`<div class="search-results-grid"><section class="panel"><div class="panel-head"><div><h3>Bookings</h3><p>${bookingHits.length} matches</p></div></div><div id="search-bookings"></div></section><section class="panel"><div class="panel-head"><div><h3>People</h3><p>${users.length+reelos.length} profile matches</p></div></div><div class="search-people-list">${reelos.map(x=>personCard(x,"Reelo")).join("")}${users.filter(u=>!reelos.some(r=>r.id===u.id)).map(x=>personCard(x,"Customer")).join("")}${users.length+reelos.length?"":'<div class="empty compact">No profile matches.</div>'}</div></section><section class="panel full-span"><div class="panel-head"><div><h3>Support conversations</h3><p>${threads.length} matches</p></div></div><div class="search-support-list">${threads.length?threads.map(t=>`<button class="search-support-row" data-search-support="${esc(t.id)}"><strong>${esc(t.userName||t.userEmail||t.userId||"User")}</strong><span>${esc(t.lastIntent||t.caseCategory||"Support")}</span><small>${esc(t.lastMessage||"")}</small></button>`).join(""):'<div class="empty compact">No support matches.</div>'}</div></section></div>`;
    const holder=document.createElement("div");holder.id="booking-panel";$("search-bookings").appendChild(holder);renderBookingPanel(bookingHits,"all");
    document.querySelectorAll("[data-person-bookings]").forEach(b=>b.onclick=()=>{const id=b.dataset.personBookings;const related=all.filter(x=>x.customerId===id||x.reeloId===id);$("page-title").textContent="Related bookings";$("page-subtitle").textContent=`${related.length} bookings for this person`;$("content").innerHTML='<div id="booking-panel"></div>';renderBookingPanel(related,"all");});
    document.querySelectorAll("[data-search-support]").forEach(b=>b.onclick=()=>openSupportThread(b.dataset.searchSupport));
  }catch(e){toast(friendly(e));}
}
function modal(title,html){$("modal-content").innerHTML=`<div class="modal-body"><h3>${esc(title)}</h3>${html}</div>`;$("modal").showModal();}
