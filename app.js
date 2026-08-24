import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, collection, query, where, orderBy, updateDoc, setDoc, addDoc, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
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
  ["profiles","Profiles","◎"],["sos","SOS","!"],["support","Support","◉"],
  ["feedback","Feedback","★"],["content-disputes","Content","▣"],["refunds","Refunds","₹"],
  ["payouts","Payouts","↗"],["reports","Reports","⚑"],["accounts","Accounts","◇"]
];
let activeTab = "profiles";

$("nav").innerHTML = tabs.map(([id,label,icon]) => `<button class="nav-button" data-tab="${id}"><span class="nav-icon">${icon}</span>${label}</button>`).join("");
$("nav").addEventListener("click", e => { const button = e.target.closest("[data-tab]"); if (button) loadTab(button.dataset.tab); });
$("close-modal").onclick = () => $("modal").close();
$("modal").addEventListener("click", e => { if (e.target === $("modal")) $("modal").close(); });
$("sign-out").onclick = () => signOut(auth);

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
$("create-account").onclick = async () => {
  const email = $("email").value.trim(), password = $("password").value;
  if (!email || password.length < 6) return setAuthMessage("Enter an email and a password of at least 6 characters.");
  try { await createUserWithEmailAndPassword(auth, email, password); setAuthMessage("Account created. Add its UID to the Firebase admins collection with active: true, then sign in.", false); }
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
  activeTab = id; document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active",b.dataset.tab===id));
  $("page-title").textContent = tabs.find(t=>t[0]===id)?.[1] || "Operations"; $("content").innerHTML = '<div class="loading">Loading live data…</div>';
  try {
    const loaders = {profiles:loadProfiles,sos:loadSOS,support:loadSupport,feedback:loadFeedback,"content-disputes":loadContentDisputes,refunds:loadRefunds,payouts:loadPayouts,reports:loadReports,accounts:loadAccounts};
    await loaders[id]();
  } catch(error){ $("content").innerHTML = `<div class="empty"><strong>Could not load this queue.</strong><p>${esc(friendly(error))}</p><button class="primary" id="retry">Try again</button></div>`; $("retry").onclick=()=>loadTab(id); }
}
function shell(title,subtitle,cards){ $("content").innerHTML=`<div class="section-head"><div><h3>${esc(title)}</h3><p>${esc(subtitle)}</p></div><button class="refresh" id="refresh">Refresh</button></div>${cards.length?`<div class="grid">${cards.join("")}</div>`:'<div class="empty">Nothing needs attention.</div>'}`; $("refresh").onclick=()=>loadTab(activeTab); }
function card(id,title,subtitle,status,urgent=false,actions=""){ return `<article class="card" data-id="${esc(id)}"><div class="card-top"><div><h4>${esc(title)}</h4><p>${subtitle}</p></div><span class="badge ${urgent?'red':''}">${esc(status)}</span></div>${actions?`<div class="actions">${actions}</div>`:""}</article>`; }
function action(name,label,kind="secondary"){return `<button class="${kind}" data-action="${name}">${esc(label)}</button>`;}
function bind(actionName,handler){ document.querySelectorAll(`[data-action="${actionName}"]`).forEach(b=>b.onclick=()=>handler(b.closest("[data-id]").dataset.id)); }
async function docsFor(name,field,values){ const ref=collection(db,name); const q=values.length===1?query(ref,where(field,"==",values[0])):query(ref,where(field,"in",values)); return (await getDocs(q)).docs; }

async function loadProfiles(){ const docs=await docsFor("reelo_profile_reviews","status",["pending_manual_review"]); shell("Pending Reelo profiles","Review live selfie submissions before a Reelo can go online.",docs.map(d=>{const x=d.data();return card(d.id,x.displayName||x.legalName||d.id,`Email: ${esc(x.email||"Not provided")}<br>Submitted: ${esc(timestamp(x.submittedAt))}`,x.status,false,action("profile-open","Review profile","primary"));})); bind("profile-open",openProfile); }
async function openProfile(id){ const snap=await getDoc(doc(db,"reelo_profile_reviews",id)),x=snap.data()||{}; modal("Reelo profile",details(x)+`<label>Review note<textarea id="review-note" rows="3"></textarea></label><div class="actions">${action("approve","Approve","primary")}${action("resubmit","Request new selfie","danger")}</div>`); document.querySelector('[data-action="approve"]').onclick=()=>reviewProfile(id,x,true); document.querySelector('[data-action="resubmit"]').onclick=()=>reviewProfile(id,x,false); }
async function reviewProfile(id,data,approved){ const profile=await getDoc(doc(db,"reelo_profiles",id)); if(approved){const p=profile.data()||{};if(p.onboardingComplete!==true||p.trainingComplete!==true||p.phoneVerified!==true)return toast("Onboarding, phone verification and training must be complete.");} const status=approved?"approved":"resubmission_required",note=$("review-note").value.trim(),batch=writeBatch(db),photo=data.profilePhotoUrl||""; batch.update(doc(db,"reelo_profile_reviews",id),{status,reviewNote:note,reviewedBy:auth.currentUser.uid,reviewedAt:serverTimestamp()}); batch.set(doc(db,"reelo_profiles",id),{verified:approved,verificationStatus:status,...(approved?{photoUrl:photo}:{}),updatedAt:serverTimestamp()},{merge:true}); batch.set(doc(db,"users",id),{reeloProfileReviewStatus:status,...(approved?{photoUrl:photo}:{}),updatedAt:serverTimestamp()},{merge:true}); await batch.commit(); closeAndRefresh("Profile updated."); }

async function loadSOS(){ const docs=await docsFor("sos_alerts","status",["active","acknowledged","escalated"]); shell("SOS alerts","Call the user first. For immediate danger, advise them to call 112.",docs.map(d=>{const x=d.data();return card(d.id,x.raisedByName||x.raisedByEmail||"User",`Role: ${esc(x.raisedByRole||"Unknown")}<br>Booking: ${esc(x.bookingId||"Missing")}<br>${esc(x.note||"")}`,x.status,true,action("sos-ack","Acknowledge","primary")+action("sos-resolve","Resolve"));})); bind("sos-ack",id=>setStatus("sos_alerts",id,"status","acknowledged")); bind("sos-resolve",id=>setStatus("sos_alerts",id,"status","resolved")); }

async function loadSupport(){ const docs=await docsFor("support_threads","humanRequested",[true]); docs.sort((a,b)=>(b.data().updatedAt?.seconds||0)-(a.data().updatedAt?.seconds||0)); shell("Human support","Reply inside the same secure conversation customers use in the app.",docs.map(d=>{const x=d.data();return card(d.id,x.userEmail||x.userId||"Customer",`${esc(x.lastMessage||"Human help requested")}<br>${x.bookingId?`Booking: ${esc(x.bookingId)}`:""}`,x.unreadBySupport?"NEW":x.status,x.status==="needs_human",action("support-open","Open conversation","primary"));})); bind("support-open",openSupport); }
async function openSupport(id){ const thread=doc(db,"support_threads",id); await setDoc(thread,{unreadBySupport:false,openedBySupportAt:serverTimestamp()},{merge:true}); const messages=await getDocs(query(collection(thread,"messages"),orderBy("createdAt"))); const bubbles=messages.docs.map(d=>{const x=d.data();return `<div class="bubble ${x.senderType==="support"?"support":""}">${esc(x.text||"")}</div>`}).join(""); modal("Support conversation",`<div class="messages">${bubbles||"No messages yet."}</div><div class="quick-replies"><button data-quick="I am reviewing this now. Please keep this chat open while I check the booking.">Reviewing now</button><button data-quick="If anyone is in immediate danger, call 112 now. Tell me whether you are in a safe place.">Safety reply</button><button data-quick="Please send the booking ID and a short description of what happened. Do not share private financial information.">Ask for details</button></div><div class="reply-box"><textarea id="reply" rows="2" placeholder="Reply as Reel It Support"></textarea><button class="primary" id="send-reply">Send</button></div><div class="actions"><button class="secondary" id="resolve-thread">Resolve conversation</button></div>`); document.querySelectorAll("[data-quick]").forEach(b=>b.onclick=()=>$("reply").value=b.dataset.quick); $("send-reply").onclick=async()=>{const text=$("reply").value.trim();if(!text)return;await addDoc(collection(thread,"messages"),{senderId:auth.currentUser.uid,senderType:"support",text,createdAt:serverTimestamp()});toast("Reply sent.");await openSupport(id);}; $("resolve-thread").onclick=async()=>{await setDoc(thread,{status:"resolved",humanRequested:false,unreadBySupport:false,resolvedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});closeAndRefresh("Conversation resolved.");}; }

async function loadFeedback(){ const docs=await docsFor("support_threads","feedbackRating",[1,2,3,4,5]); docs.sort((a,b)=>(b.data().feedbackSubmittedAt?.seconds||0)-(a.data().feedbackSubmittedAt?.seconds||0)); shell("Customer feedback","Ratings and additional comments left after Support resolves a conversation.",docs.map(d=>{const x=d.data(),r=Number(x.feedbackRating)||0;return card(d.id,x.userEmail||x.userId||"Customer",`<span class="stars">${"★".repeat(r)}${"☆".repeat(5-r)}</span><br>${esc(x.feedbackText||"No additional comment")}<br>${x.bookingId?`Booking: ${esc(x.bookingId)}`:""}`,`${r}/5`);})); }

async function loadContentDisputes(){ const docs=await docsFor("bookings","deliveryDisputed",[true]); shell("Content delivery disputes","Payout is paused until the owner requests a corrected upload or closes the review.",docs.map(d=>{const x=d.data();return card(d.id,x.occasion||"Content delivery",`${esc(x.location||"")}<br>Customer: ${esc(x.customerEmail||x.customerId)}<br>Photos: ${esc(x.deliveredPhotoCount||0)} · Reels: ${esc(x.deliveredReelCount||0)}`,"PAYOUT PAUSED",true,action("reupload","Request re-upload","primary")+action("close-dispute","Close as resolved"));})); bind("reupload",id=>resolveDispute(id,"request_reupload")); bind("close-dispute",id=>resolveDispute(id,"close_resolved")); }
async function resolveDispute(bookingId,actionName){ try{await httpsCallable(functions,"resolveContentDispute")({bookingId,action:actionName});closeAndRefresh("Content dispute updated.");}catch(e){toast(friendly(e));} }

async function loadRefunds(){ const docs=await docsFor("bookings","refundStatus",["starting","manual_review_required","failed","processing"]); shell("Refund exceptions","Review refunds that require provider or owner attention.",docs.map(d=>{const x=d.data();return card(d.id,`Booking ${d.id}`,`Customer: ${esc(x.customerEmail||x.customerId)}<br>Amount: ₹${esc(x.refundAmount||x.customerPrice||0)}<br>${esc(x.refundFailureReason||"")}`,x.refundStatus,x.refundStatus==="failed"||x.refundStatus==="manual_review_required",action("details","View details"));})); bind("details",openGeneric.bind(null,"bookings")); }
async function loadPayouts(){ const docs=await docsFor("payout_requests","status",["creating","queued","pending","processing","failed","rejected","cancelled","reversed"]); shell("Payout operations","Monitor pending transfers and provider exceptions.",docs.map(d=>{const x=d.data();return card(d.id,`${x.destinationLabel||"Payout"} · ₹${x.amount||0}`,`Reelo: ${esc(x.reeloId||x.userId||"Unknown")}<br>${esc(x.failureReason||"")}`,x.status,["failed","rejected","reversed"].includes(x.status),action("payout-details","View details"));})); bind("payout-details",openGeneric.bind(null,"payout_requests")); }
async function loadReports(){ const docs=await docsFor("user_reports","status",["open","investigating","escalated"]); shell("Safety reports","Review reported conduct and preserve relevant records.",docs.map(d=>{const x=d.data();return card(d.id,`${x.reason||"Report"} · ${x.reportedUserName||x.reportedUserId||"Account"}`,`Reporter: ${esc(x.reporterEmail||x.reporterId)}<br>Booking: ${esc(x.bookingId||"Missing")}<br>${esc(x.note||"")}`,x.status,x.reason==="safety",action("investigate","Investigating")+action("escalate","Escalate","danger")+action("resolve-report","Resolve","primary"));})); bind("investigate",id=>setStatus("user_reports",id,"status","investigating"));bind("escalate",id=>setStatus("user_reports",id,"status","escalated"));bind("resolve-report",id=>setStatus("user_reports",id,"status","resolved")); }
async function loadAccounts(){ const docs=await docsFor("account_deletion_requests","status",["requested","processing","failed"]); shell("Account deletion","Permanent deletion is blocked while active bookings or payouts remain.",docs.map(d=>{const x=d.data();return card(d.id,x.email||x.userId||d.id,`${esc(x.failureReason||"Deletion requested by user.")}`,x.status,x.status==="failed",x.status==="processing"?"":action("delete-account","Permanently complete","danger"));})); bind("delete-account",completeDeletion); }
async function completeDeletion(userId){ if(!confirm("Permanently delete this account and anonymize retained financial records? This cannot be undone."))return;try{await httpsCallable(functions,"completeAccountDeletion")({userId});closeAndRefresh("Account deletion completed.");}catch(e){toast(friendly(e));} }

async function setStatus(collectionName,id,field,status){ await updateDoc(doc(db,collectionName,id),{[field]:status,reviewedBy:auth.currentUser.uid,reviewedAt:serverTimestamp(),updatedAt:serverTimestamp()}); closeAndRefresh("Status updated."); }
async function openGeneric(collectionName,id){const snap=await getDoc(doc(db,collectionName,id));modal(`${collectionName.replaceAll("_"," ")} details`,details(snap.data()||{}));}
function details(data){return Object.entries(data).filter(([,v])=>typeof v!=="object"||v===null||v?.toDate).map(([k,v])=>`<div class="kv"><span>${esc(k)}</span><strong>${esc(v?.toDate?timestamp(v):v)}</strong></div>`).join("");}
function modal(title,html){$("modal-content").innerHTML=`<div class="modal-body"><h3>${esc(title)}</h3>${html}</div>`;$("modal").showModal();}
function closeAndRefresh(message){$("modal").close();toast(message);refreshMetrics();loadTab(activeTab);}
