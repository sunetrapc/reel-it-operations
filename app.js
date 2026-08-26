import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, collection, query, where, orderBy, limit, onSnapshot, updateDoc, setDoc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app-check.js";
import { firebaseConfig, functionsRegion, recaptchaSiteKey } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
if (recaptchaSiteKey) initializeAppCheck(app, { provider: new ReCaptchaV3Provider(recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app), db = getFirestore(app), functions = getFunctions(app, functionsRegion);

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const timestamp = (value) => value?.toDate ? value.toDate().toLocaleString() : "Not recorded";
const toast = (text) => { $("toast").textContent = text; $("toast").classList.add("show"); setTimeout(() => $("toast").classList.remove("show"), 2800); };

const tabs = [
  ["operations","Operations","⌂"],["bookings","Bookings","▤"],["support","Support","◉"],
  ["profiles","Reelos","◎"],["sos","SOS","!"],["content-disputes","Content","▣"],
  ["refunds","Refunds","₹"],["reports","Reports","⚑"],["feedback","Feedback","★"],
  ["accounts","Accounts","◇"],["payouts","Payouts","↗"],["audit","Audit Log","≡"]
];
let activeTab = "operations", liveUnsub = null, modalUnsub = null;

$("nav").innerHTML = tabs.map(([id,label,icon]) => `<button class="nav-button" data-tab="${id}"><span class="nav-icon">${icon}</span>${label}</button>`).join("");
$("nav").addEventListener("click", e => { const button = e.target.closest("[data-tab]"); if (button) loadTab(button.dataset.tab); });
$("close-modal").onclick = () => $("modal").close();
$("modal").addEventListener("close",()=>{if(modalUnsub){modalUnsub();modalUnsub=null;}});
$("modal").addEventListener("click", e => { if (e.target === $("modal")) $("modal").close(); });
$("sign-out").onclick = () => signOut(auth);
$("search-button").onclick = runGlobalSearch;
$("global-search").addEventListener("keydown",e=>{if(e.key==="Enter")runGlobalSearch();});

$("login-form").onsubmit = async e => {
  e.preventDefault(); setAuthMessage("Signing in…", false);
  try { await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value); }
  catch (error) { setAuthMessage(friendly(error)); }
};
$("forgot-password").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) return setAuthMessage("Enter your admin email first.");
  try { await sendPasswordResetEmail(auth, email); setAuthMessage("Password reset email sent.", false); }
  catch (error) { setAuthMessage(friendly(error)); }
};
function setAuthMessage(text, error = true) { $("auth-message").textContent = text; $("auth-message").style.color = error ? "#e14d5a" : "#15855f"; }
function friendly(error) { const code = error?.code || ""; if (code.includes("invalid-credential")) return "Incorrect email or password."; if (code.includes("email-already")) return "That account already exists. Use Forgot password if needed."; return error?.message?.replace(/^Firebase:\s*/i, "") || "This action could not be completed."; }

onAuthStateChanged(auth, async user => {
  if (!user) return showAuth();
  try {
    const admin = await getDoc(doc(db,"admins",user.uid));
    if (!admin.exists() || admin.data().active !== true) {
      await signOut(auth); return setAuthMessage("This account is not an active Reel It administrator. Add its UID to Firestore → admins with active: true.");
    }
    $("auth-view").classList.add("hidden"); $("app-view").classList.remove("hidden"); $("admin-email").textContent = user.email || "Owner";
    await refreshMetrics(); await loadTab(activeTab);
  } catch (error) { await signOut(auth); setAuthMessage(friendly(error)); }
});
function showAuth(){ $("app-view").classList.add("hidden"); $("auth-view").classList.remove("hidden"); }

async function refreshMetrics(){
  const specs = [
    ["Profiles",collection(db,"reelo_profile_reviews"),"status",["pending_manual_review"]],
    ["Human support",collection(db,"support_threads"),"humanRequested",[true]],
    ["Content disputes",collection(db,"bookings"),"deliveryDisputed",[true]],
    ["SOS alerts",collection(db,"sos_alerts"),"status",["active","acknowledged","escalated"]]
  ];
  const counts = await Promise.all(specs.map(async ([label,ref,field,values]) => {
    const q = values.length === 1 ? query(ref,where(field,"==",values[0])) : query(ref,where(field,"in",values));
    return [label,(await getDocs(q)).size];
  }));
  $("metrics").innerHTML = counts.map(([label,count]) => `<div class="metric"><span>${esc(label)}</span><strong>${count}</strong></div>`).join("");
}

async function loadTab(id){
  if (liveUnsub) { liveUnsub(); liveUnsub = null; }
  activeTab = id; document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active",b.dataset.tab===id));
  $("page-title").textContent = tabs.find(t=>t[0]===id)?.[1] || "Operations"; $("content").innerHTML = '<div class="loading">Loading live data…</div>';
  try {
    const loaders = {operations:loadOperations,bookings:loadBookings,profiles:loadProfiles,sos:loadSOS,support:loadSupport,feedback:loadFeedback,"content-disputes":loadContentDisputes,refunds:loadRefunds,payouts:loadPayouts,reports:loadReports,accounts:loadAccounts,audit:loadAudit};
    await loaders[id]();
  } catch(error){ $("content").innerHTML = `<div class="empty"><strong>Could not load this queue.</strong><p>${esc(friendly(error))}</p><button class="primary" id="retry">Try again</button></div>`; $("retry").onclick=()=>loadTab(id); }
}
function shell(title,subtitle,cards){ $("content").innerHTML=`<div class="section-head"><div><h3>${esc(title)}</h3><p>${esc(subtitle)}</p></div><button class="refresh" id="refresh">Refresh</button></div>${cards.length?`<div class="grid">${cards.join("")}</div>`:'<div class="empty">Nothing needs attention.</div>'}`; $("refresh").onclick=()=>loadTab(activeTab); }
function card(id,title,subtitle,status,urgent=false,actions=""){ return `<article class="card" data-id="${esc(id)}"><div class="card-top"><div><h4>${esc(title)}</h4><p>${subtitle}</p></div><span class="badge ${urgent?'red':''}">${esc(status)}</span></div>${actions?`<div class="actions">${actions}</div>`:""}</article>`; }
function action(name,label,kind="secondary"){return `<button class="${kind}" data-action="${name}">${esc(label)}</button>`;}
function bind(actionName,handler){ document.querySelectorAll(`[data-action="${actionName}"]`).forEach(b=>b.onclick=()=>handler(b.closest("[data-id]").dataset.id)); }
async function docsFor(name,field,values){ const ref=collection(db,name); const q=values.length===1?query(ref,where(field,"==",values[0])):query(ref,where(field,"in",values)); return (await getDocs(q)).docs; }

function bookingIssue(x){
  const now=Date.now(), age=(field)=>x[field]?.toDate ? now-x[field].toDate().getTime() : 0;
  if(x.paymentStatus==="failed" || x.refundStatus==="manual_review_required") return ["Payment needs review","critical"];
  if(x.operationalAttention===true) return [x.operationalAttentionType?.replaceAll("_"," ")||"Owner review","critical"];
  if(x.status==="searching" && x.requestExpiresAt?.toDate && x.requestExpiresAt.toDate().getTime()<now) return ["Matching expired","critical"];
  if(x.status==="accepted" && age("acceptedAt")>15*60*1000 && !x.travelStatus) return ["Reelo has not shared ETA","urgent"];
  if(x.status==="arrived" && age("arrivedAt")>10*60*1000) return ["Arrival verification stuck","urgent"];
  if(x.status==="in_progress" && age("startedAt")>((Number(x.durationMinutes)||30)+30)*60*1000) return ["Session running long","urgent"];
  if(x.status==="completed" && !["pending_upload","uploading","delivered","customer_confirmed"].includes(x.deliveryStatus)) return ["Delivery state missing — repair to Pending upload","urgent"];
  if(x.status==="completed" && !["delivered","customer_confirmed"].includes(x.deliveryStatus) && age("completedAt")>24*60*60*1000) return ["Content overdue","review"];
  if(x.deliveryDisputed===true) return ["Content dispute","review"];
  return ["On track","ok"];
}
function bookingRef(id){return `RIT-${String(id||"").slice(-6).toUpperCase()}`;}
function bookingLabel(x,id){return `${bookingRef(id)} · ${x.occasion||"Booking"}`;}
function bookingSummary(x){return `Customer: ${esc(x.customerName||x.customerEmail||x.customerId||"Unknown")}<br>Reelo: ${esc(x.reeloName||x.reeloEmail||"Not assigned")}<br>₹${esc(x.customerPrice||x.price||0)} · ${esc(x.durationMinutes||0)} min · ${esc(x.status||"unknown")}`;}

async function loadOperations(){
  const [bookings,support,profiles,sos]=await Promise.all([
    getDocs(query(collection(db,"bookings"),orderBy("updatedAt","desc"),limit(100))),
    getDocs(query(collection(db,"support_threads"),where("humanRequested","==",true))),
    getDocs(query(collection(db,"reelo_profile_reviews"),where("status","==","pending_manual_review"))),
    getDocs(query(collection(db,"sos_alerts"),where("status","in",["active","acknowledged","escalated"])))
  ]);
  const issues=bookings.docs.map(d=>({id:d.id,data:d.data(),issue:bookingIssue(d.data())})).filter(x=>x.issue[1]!=="ok");
  const cards=[];
  sos.docs.forEach(d=>{const x=d.data();cards.push(card(d.id,`ACTIVE SOS · ${x.raisedByName||x.raisedByEmail||"User"}`,`Booking: ${esc(x.bookingId||"Missing")}<br>${esc(x.note||"Immediate review required")}`,"CRITICAL",true,action("open-sos","Open SOS","primary")));});
  support.docs.forEach(d=>{const x=d.data();cards.push(card(d.id,`Support · ${x.userEmail||x.userId||"Customer"}`,`${esc(x.lastMessage||"Human assistance requested")}<br>Waiting since ${esc(timestamp(x.humanRequestedAt||x.updatedAt))}`,"URGENT",true,action("open-support-inbox","Reply","primary")));});
  issues.forEach(item=>cards.push(card(item.id,bookingLabel(item.data,item.id),`${bookingSummary(item.data)}<br><strong>${esc(item.issue[0])}</strong>`,item.issue[1].toUpperCase(),item.issue[1]==="critical",action("open-booking","Open control room","primary"))));
  profiles.docs.slice(0,5).forEach(d=>{const x=d.data();cards.push(card(d.id,`Reelo application · ${x.displayName||x.legalName||d.id}`,`Submitted: ${esc(timestamp(x.submittedAt))}`,"REVIEW",false,action("open-reelo","Review")));});
  shell("Operations Inbox",cards.length ? `${cards.length} items need your attention now.` : "No operational exceptions. Live bookings continue to be monitored.",cards);
  bind("open-booking",openBooking);bind("open-support-inbox",openSupport);bind("open-reelo",openProfile);bind("open-sos",async id=>{await loadTab("sos");document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({behavior:"smooth"});});
}

async function loadBookings(){
  $("content").innerHTML='<div class="loading">Connecting to live bookings…</div>';
  const q=query(collection(db,"bookings"),orderBy("updatedAt","desc"),limit(100));
  liveUnsub=onSnapshot(q,snapshot=>renderBookings(snapshot.docs),error=>{$("content").innerHTML=`<div class="empty">${esc(friendly(error))}</div>`;});
}
function renderBookings(docs){
  const cards=docs.map(d=>{const x=d.data(),issue=bookingIssue(x);return card(d.id,bookingLabel(x,d.id),`${bookingSummary(x)}<br>${issue[1]!=="ok"?`<strong>${esc(issue[0])}</strong>`:""}`,issue[1]==="ok"?(x.status||"LIVE").toUpperCase():issue[1].toUpperCase(),issue[1]==="critical",action("booking-control","Open control room","primary"));});
  shell("Live bookings","Newest updates appear automatically. Exceptions are labelled by urgency.",cards);bind("booking-control",openBooking);
}
async function openBooking(id){
  const snap=await getDoc(doc(db,"bookings",id));if(!snap.exists())return toast("Booking not found.");const x=snap.data(),issue=bookingIssue(x);
  const notes=(await getDocs(query(collection(db,"operations_notes"),where("targetId","==",id),limit(30)))).docs.filter(d=>d.data().targetType==="booking").sort((a,b)=>(b.data().createdAt?.seconds||0)-(a.data().createdAt?.seconds||0));
  const timeline=[["Created",x.createdAt],["Payment captured",x.paymentCapturedAt],["Accepted",x.acceptedAt],["Reelo left",x.leftAt],["Arrived",x.arrivedAt],["Session started",x.startedAt],["Completed",x.completedAt],["Content delivered",x.deliveredAt],["Customer confirmed",x.deliveryConfirmedAt]].filter(([,v])=>v);
  modal(`Booking control room · ${bookingRef(id)}`,`<div class="control-alert ${issue[1]}"><strong>${esc(issue[0])}</strong><span>Status: ${esc(x.status||"unknown")}</span></div><div class="control-columns"><div><h4>People & booking</h4>${details({customer:x.customerName||x.customerEmail||x.customerId,reelo:x.reeloName||x.reeloEmail||"Not assigned",occasion:x.occasion,location:x.location,durationMinutes:x.durationMinutes,price:`₹${x.customerPrice||x.price||0}`,status:x.status,travelStatus:x.travelStatus||"Not started",etaMinutes:x.etaMinutes,paymentStatus:x.paymentStatus,deliveryStatus:x.deliveryStatus,refundStatus:x.refundStatus||"none"})}</div><div><h4>Lifecycle</h4><div class="timeline">${timeline.map(([label,value])=>`<div><span></span><strong>${esc(label)}</strong><small>${esc(timestamp(value))}</small></div>`).join("")||"No timeline recorded."}</div></div></div><h4>Safe owner actions</h4><label>Reason or message<textarea id="booking-reason" rows="2" placeholder="Required for state-changing actions"></textarea></label><div class="actions">${action("notify-customer","Message customer")}${x.reeloId?action("notify-reelo","Message Reelo"):""}${["accepted","arrived"].includes(x.status)?action("new-code","Replace arrival code"):""}${["accepted","arrived"].includes(x.status)?action("rematch","Return to matching","danger"):""}${["accepted","arrived","in_progress"].includes(x.status)?action("force-end","Force end → Pending upload","danger"):""}${x.status==="completed" && !["delivered","customer_confirmed"].includes(x.deliveryStatus)?action("pending-delivery","Repair → Pending upload","danger"):""}${x.status==="completed"?action("content-again","Request content re-upload","danger"):""}${action("payment-review","Flag payment review","danger")}${["pending","failed","order_created"].includes(x.paymentStatus)?action("cancel-unpaid","Cancel unpaid booking","danger"):""}</div><h4>Internal notes</h4><div class="notes">${notes.map(n=>`<p><strong>${esc(n.data().adminEmail||"Owner")}</strong> · ${esc(timestamp(n.data().createdAt))}<br>${esc(n.data().note)}</p>`).join("")||"<p>No internal notes.</p>"}</div><div class="reply-box"><textarea id="internal-note" rows="2" placeholder="Only Reel It operators can see this"></textarea><button id="save-note" class="primary">Add note</button></div>`);
  const run=(name,backendAction)=>{const b=document.querySelector(`[data-action="${name}"]`);if(b)b.onclick=()=>bookingAction(id,backendAction,$("booking-reason").value.trim());};run("notify-customer","notify_customer");run("notify-reelo","notify_reelo");run("new-code","regenerate_arrival_code");run("rematch","return_to_search");run("force-end","force_end_session");run("pending-delivery","move_to_pending_delivery");run("content-again","request_content_reupload");run("payment-review","flag_payment_review");run("cancel-unpaid","cancel_unpaid");$("save-note").onclick=()=>addNote("booking",id,$("internal-note").value.trim(),()=>openBooking(id));
}
async function bookingAction(bookingId,actionName,reason){if(["return_to_search","force_end_session","move_to_pending_delivery","request_content_reupload","flag_payment_review","cancel_unpaid"].includes(actionName)&&reason.length<5)return toast("Add a short reason first.");if(["return_to_search","force_end_session","move_to_pending_delivery","cancel_unpaid"].includes(actionName)&&!confirm("This changes the booking state. Continue?"))return;try{await httpsCallable(functions,"adminBookingAction")({bookingId,action:actionName,reason});closeAndRefresh("Booking action completed.");}catch(e){toast(friendly(e));}}
async function addNote(targetType,targetId,note,done){if(note.length<2)return toast("Write an internal note first.");try{await httpsCallable(functions,"addOperationsNote")({targetType,targetId,note});toast("Internal note saved.");if(done)done();}catch(e){toast(friendly(e));}}

async function loadProfiles(){ const docs=await docsFor("reelo_profile_reviews","status",["pending_manual_review"]); shell("Pending Reelo profiles","Review live selfie submissions before a Reelo can go online.",docs.map(d=>{const x=d.data();return card(d.id,x.displayName||x.legalName||d.id,`Email: ${esc(x.email||"Not provided")}<br>Submitted: ${esc(timestamp(x.submittedAt))}`,x.status,false,action("profile-open","Review profile","primary"));})); bind("profile-open",openProfile); }
async function openProfile(id){ const snap=await getDoc(doc(db,"reelo_profile_reviews",id)),x=snap.data()||{}; modal("Reelo profile",details(x)+`<label>Review note<textarea id="review-note" rows="3"></textarea></label><div class="actions">${action("approve","Approve","primary")}${action("resubmit","Request new selfie","danger")}</div>`); document.querySelector('[data-action="approve"]').onclick=()=>reviewProfile(id,x,true); document.querySelector('[data-action="resubmit"]').onclick=()=>reviewProfile(id,x,false); }
async function reviewProfile(id,data,approved){const reason=$("review-note").value.trim();if(reason.length<3)return toast("Add a review note first.");try{await httpsCallable(functions,"adminReviewReelo")({reeloId:id,decision:approved?"approved":"resubmission_required",reason});closeAndRefresh("Reelo application updated and audited.");}catch(e){toast(friendly(e));}}

async function loadSOS(){ const docs=await docsFor("sos_alerts","status",["active","acknowledged","escalated"]); shell("SOS alerts","Call the user first. For immediate danger, advise them to call 112.",docs.map(d=>{const x=d.data();return card(d.id,x.raisedByName||x.raisedByEmail||"User",`Role: ${esc(x.raisedByRole||"Unknown")}<br>Booking: ${esc(x.bookingId||"Missing")}<br>${esc(x.note||"")}`,x.status,true,action("sos-ack","Acknowledge","primary")+action("sos-resolve","Resolve"));})); bind("sos-ack",id=>setStatus("sos_alerts",id,"status","acknowledged")); bind("sos-resolve",id=>setStatus("sos_alerts",id,"status","resolved")); }

async function loadSupport(){ const docs=await docsFor("support_threads","humanRequested",[true]); docs.sort((a,b)=>(b.data().updatedAt?.seconds||0)-(a.data().updatedAt?.seconds||0)); shell("Human support","Reply inside the same secure conversation customers use in the app.",docs.map(d=>{const x=d.data();return card(d.id,x.userEmail||x.userId||"Customer",`${esc(x.lastMessage||"Human help requested")}<br>${x.bookingId?`Booking: ${esc(x.bookingId)}`:""}`,x.unreadBySupport?"NEW":x.status,x.status==="needs_human",action("support-open","Open conversation","primary"));})); bind("support-open",openSupport); }
async function openSupport(id){
  const thread=doc(db,"support_threads",id),threadSnap=await getDoc(thread),threadData=threadSnap.data()||{};
  const bookingId=threadData.bookingId||"",bookingSnap=bookingId?await getDoc(doc(db,"bookings",bookingId)):null,booking=bookingSnap?.exists()?bookingSnap.data():null;
  await setDoc(thread,{unreadBySupport:false,openedBySupportAt:serverTimestamp()},{merge:true});
  const context=booking?`<section class="support-context"><div><span>RELATED BOOKING</span><strong>${esc(bookingLabel(booking,bookingId))}</strong><small>${esc(booking.status||"unknown")} · payment ${esc(booking.paymentStatus||"unknown")}</small></div><div><span>CUSTOMER</span><strong>${esc(booking.customerName||booking.customerEmail||booking.customerId||"Unknown")}</strong><small>Delivery: ${esc(booking.deliveryStatus||"not started")}</small></div><div><span>REELO</span><strong>${esc(booking.reeloName||booking.reeloEmail||"Not assigned")}</strong><small>Travel: ${esc(booking.travelStatus||"not started")}</small></div><button id="support-booking" class="secondary">Open booking control room</button></section>`:`<section class="support-context"><div><span>CONVERSATION</span><strong>${esc(threadData.userEmail||threadData.userId||"App user")}</strong><small>No booking is linked to this thread.</small></div></section>`;
  modal("Live Support conversation",`${context}<div id="live-messages" class="messages"><div class="loading">Loading messages…</div></div><div class="quick-replies"><button data-quick="I am reviewing this now. Please keep this chat open while I check the booking.">Reviewing now</button><button data-quick="If anyone is in immediate danger, call 112 now. Tell me whether you are in a safe place.">Safety reply</button><button data-quick="Please send the booking ID and a short description of what happened. Do not share private financial information.">Ask for details</button></div><div class="reply-box"><textarea id="reply" rows="2" placeholder="Reply as Reel It Support"></textarea><button class="primary" id="send-reply">Send</button></div><div class="actions"><button class="secondary" id="add-support-note">Internal note</button><button class="secondary" id="resolve-thread">Resolve conversation</button></div>`);
  if(booking) $("support-booking").onclick=()=>openBooking(bookingId);
  modalUnsub=onSnapshot(query(collection(thread,"messages"),orderBy("createdAt")),snapshot=>{const box=$("live-messages");if(!box)return;box.innerHTML=snapshot.docs.map(d=>{const x=d.data();return `<div class="bubble ${x.senderType==="support"?"support":""}">${esc(x.text||"")}</div>`}).join("")||"No messages yet.";box.scrollTop=box.scrollHeight;});
  document.querySelectorAll("[data-quick]").forEach(b=>b.onclick=()=>$("reply").value=b.dataset.quick);
  $("send-reply").onclick=async()=>{const text=$("reply").value.trim();if(!text)return;await addDoc(collection(thread,"messages"),{senderId:auth.currentUser.uid,senderType:"support",text,createdAt:serverTimestamp()});await setDoc(thread,{lastMessage:text,lastMessageSender:"support",updatedAt:serverTimestamp()},{merge:true});$("reply").value="";toast("Reply sent to the Reel It app.");};
  $("add-support-note").onclick=()=>{const note=prompt("Internal note (customers cannot see this):");if(note)addNote("support",id,note);};
  $("resolve-thread").onclick=async()=>{await setDoc(thread,{status:"resolved",humanRequested:false,unreadBySupport:false,resolvedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});closeAndRefresh("Conversation resolved. The customer can leave feedback or reopen it.");};
}

async function loadFeedback(){ const docs=await docsFor("support_threads","feedbackRating",[1,2,3,4,5]); docs.sort((a,b)=>(b.data().feedbackSubmittedAt?.seconds||0)-(a.data().feedbackSubmittedAt?.seconds||0)); shell("Customer feedback","Ratings and additional comments left after Support resolves a conversation.",docs.map(d=>{const x=d.data(),r=Number(x.feedbackRating)||0;return card(d.id,x.userEmail||x.userId||"Customer",`<span class="stars">${"★".repeat(r)}${"☆".repeat(5-r)}</span><br>${esc(x.feedbackText||"No additional comment")}<br>${x.bookingId?`Booking: ${esc(x.bookingId)}`:""}`,`${r}/5`);})); }

async function loadContentDisputes(){ const docs=await docsFor("bookings","deliveryDisputed",[true]); shell("Content delivery disputes","Payout is paused until the owner requests a corrected upload or closes the review.",docs.map(d=>{const x=d.data();return card(d.id,x.occasion||"Content delivery",`${esc(x.location||"")}<br>Customer: ${esc(x.customerEmail||x.customerId)}<br>Photos: ${esc(x.deliveredPhotoCount||0)} · Reels: ${esc(x.deliveredReelCount||0)}`,"PAYOUT PAUSED",true,action("reupload","Request re-upload","primary")+action("close-dispute","Close as resolved"));})); bind("reupload",id=>resolveDispute(id,"request_reupload")); bind("close-dispute",id=>resolveDispute(id,"close_resolved")); }
async function resolveDispute(bookingId,actionName){ try{await httpsCallable(functions,"resolveContentDispute")({bookingId,action:actionName});closeAndRefresh("Content dispute updated.");}catch(e){toast(friendly(e));} }

async function loadRefunds(){ const docs=await docsFor("bookings","refundStatus",["starting","manual_review_required","failed","processing"]); shell("Refund exceptions","Review refunds that require provider or owner attention.",docs.map(d=>{const x=d.data();return card(d.id,`Booking ${d.id}`,`Customer: ${esc(x.customerEmail||x.customerId)}<br>Amount: ₹${esc(x.refundAmount||x.customerPrice||0)}<br>${esc(x.refundFailureReason||"")}`,x.refundStatus,x.refundStatus==="failed"||x.refundStatus==="manual_review_required",action("details","View details"));})); bind("details",openGeneric.bind(null,"bookings")); }
async function loadPayouts(){ const docs=await docsFor("payout_requests","status",["creating","queued","pending","processing","failed","rejected","cancelled","reversed"]); shell("Payout operations","Monitor pending transfers and provider exceptions.",docs.map(d=>{const x=d.data();return card(d.id,`${x.destinationLabel||"Payout"} · ₹${x.amount||0}`,`Reelo: ${esc(x.reeloId||x.userId||"Unknown")}<br>${esc(x.failureReason||"")}`,x.status,["failed","rejected","reversed"].includes(x.status),action("payout-details","View details"));})); bind("payout-details",openGeneric.bind(null,"payout_requests")); }
async function loadReports(){ const docs=await docsFor("user_reports","status",["open","investigating","escalated"]); shell("Safety reports","Review reported conduct and preserve relevant records.",docs.map(d=>{const x=d.data();return card(d.id,`${x.reason||"Report"} · ${x.reportedUserName||x.reportedUserId||"Account"}`,`Reporter: ${esc(x.reporterEmail||x.reporterId)}<br>Booking: ${esc(x.bookingId||"Missing")}<br>${esc(x.note||"")}`,x.status,x.reason==="safety",action("investigate","Investigating")+action("escalate","Escalate","danger")+action("resolve-report","Resolve","primary"));})); bind("investigate",id=>setStatus("user_reports",id,"status","investigating"));bind("escalate",id=>setStatus("user_reports",id,"status","escalated"));bind("resolve-report",id=>setStatus("user_reports",id,"status","resolved")); }
async function loadAccounts(){ const docs=await docsFor("account_deletion_requests","status",["requested","processing","failed"]); shell("Account deletion","Permanent deletion is blocked while active bookings or payouts remain.",docs.map(d=>{const x=d.data();return card(d.id,x.email||x.userId||d.id,`${esc(x.failureReason||"Deletion requested by user.")}`,x.status,x.status==="failed",x.status==="processing"?"":action("delete-account","Permanently complete","danger"));})); bind("delete-account",completeDeletion); }
async function completeDeletion(userId){ if(!confirm("Permanently delete this account and anonymize retained financial records? This cannot be undone."))return;try{await httpsCallable(functions,"completeAccountDeletion")({userId});closeAndRefresh("Account deletion completed.");}catch(e){toast(friendly(e));} }

async function loadAudit(){const snapshot=await getDocs(query(collection(db,"audit_logs"),orderBy("createdAt","desc"),limit(100)));shell("Privileged action audit log","Every protected owner action records who acted, what changed, why, and when.",snapshot.docs.map(d=>{const x=d.data();return card(d.id,x.action||"OWNER ACTION",`Admin: ${esc(x.adminEmail||x.adminId)}<br>Target: ${esc(x.targetType)} · ${esc(x.targetId)}<br>Reason: ${esc(x.reason||"Not supplied")}<br>${esc(timestamp(x.createdAt))}`,"AUDITED");}));}

async function runGlobalSearch(){const term=$("global-search").value.trim();if(!term)return toast("Enter a booking ID, exact email, or payment ID.");try{const direct=await getDoc(doc(db,"bookings",term));if(direct.exists())return openBooking(direct.id);const fields=["customerEmail","reeloEmail","paymentReference","razorpayOrderId"];const groups=await Promise.all(fields.map(field=>getDocs(query(collection(db,"bookings"),where(field,"==",term),limit(20)))));const found=new Map();groups.flatMap(s=>s.docs).forEach(d=>found.set(d.id,d));if(found.size===1)return openBooking([...found.keys()][0]);const cards=[...found.values()].map(d=>{const x=d.data();return card(d.id,bookingLabel(x,d.id),bookingSummary(x),String(x.status||"booking").toUpperCase(),false,action("search-open","Open","primary"));});shell("Search results",found.size?`${found.size} matching bookings found.`:"No exact booking, email, payment, or Razorpay order match was found.",cards);bind("search-open",openBooking);}catch(e){toast(friendly(e));}}

async function setStatus(collectionName,id,field,status){ await updateDoc(doc(db,collectionName,id),{[field]:status,reviewedBy:auth.currentUser.uid,reviewedAt:serverTimestamp(),updatedAt:serverTimestamp()}); closeAndRefresh("Status updated."); }
async function openGeneric(collectionName,id){const snap=await getDoc(doc(db,collectionName,id));modal(`${collectionName.replaceAll("_"," ")} details`,details(snap.data()||{}));}
function details(data){return Object.entries(data).filter(([,v])=>typeof v!=="object"||v===null||v?.toDate).map(([k,v])=>`<div class="kv"><span>${esc(k)}</span><strong>${esc(v?.toDate?timestamp(v):v)}</strong></div>`).join("");}
function modal(title,html){$("modal-content").innerHTML=`<div class="modal-body"><h3>${esc(title)}</h3>${html}</div>`;$("modal").showModal();}
function closeAndRefresh(message){$("modal").close();toast(message);refreshMetrics();loadTab(activeTab);}
