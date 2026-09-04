const { initializeApp } = require("firebase-admin/app");
    const { getAuth } = require("firebase-admin/auth");
    const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
    const { getMessaging } = require("firebase-admin/messaging");
    const { getStorage } = require("firebase-admin/storage");
    const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
    const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
    const { onSchedule } = require("firebase-functions/v2/scheduler");
    const { defineSecret } = require("firebase-functions/params");
    const { setGlobalOptions } = require("firebase-functions/v2");
    const crypto = require("crypto");

    initializeApp();
    const db = getFirestore();
    const messaging = getMessaging();
    const razorpayKeyId = defineSecret("RAZORPAY_KEY_ID");
    const razorpayKeySecret = defineSecret("RAZORPAY_KEY_SECRET");
    const razorpayWebhookSecret = defineSecret("RAZORPAY_WEBHOOK_SECRET");
    // // const razorpayXKeyId = defineSecret("RAZORPAYX_KEY_ID");
    // // const razorpayXKeySecret = defineSecret("RAZORPAYX_KEY_SECRET");
    // // const razorpayXAccountNumber = defineSecret("RAZORPAYX_ACCOUNT_NUMBER");
    setGlobalOptions({ region: "asia-south1", maxInstances: 10 });

    const PRICES = Object.freeze({
      originals: Object.freeze({ 60: 399, 90: 699, 180: 1499 }),
      edited: Object.freeze({ 60: 1099, 90: 1599, 180: 3099 }),
    });
    const EXTENDED_HOUR_PRICE = 299;
    const CONTENT_PACKAGES = Object.freeze({
      originals: Object.freeze({ 30:{photos:10,reels:1},60:{photos:20,reels:1},90:{photos:35,reels:2},120:{photos:50,reels:2},180:{photos:75,reels:3} }),
      edited: Object.freeze({ 30:{photos:8,reels:1},60:{photos:15,reels:1},90:{photos:25,reels:2},120:{photos:35,reels:2},180:{photos:50,reels:3} }),
    });
    const CONTENT_AVAILABILITY_MS = 72 * 60 * 60 * 1000;
    const WELCOME_DISCOUNT_PERCENT = 15;
    const WELCOME_RESERVATION_MS = 30 * 60 * 1000;
    const PAYOUT_OK = new Set(["queued", "pending", "processing", "processed"]);
    const PAYOUT_FAILED = new Set(["failed", "rejected", "cancelled", "reversed"]);
    const REPORT_REASONS = new Set([
      "safety",
      "harassment",
      "fraud",
      "privacy",
      "inappropriate_content",
      "other",
    ]);

    function clean(value, max = 500) {
      return String(value || "").trim().slice(0, max);
    }

    function basicAuth(keyId, secret) {
      return `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`;
    }

    function bookingPrice(booking) {
      const type = clean(booking.deliveryType || 'originals', 20);
      const price = PRICES[type] && PRICES[type][Number(booking.durationMinutes)];
      if (!price) throw new HttpsError("failed-precondition", "This booking duration cannot be purchased.");
      return price;
    }

    function reeloEarning(booking) {
      const price = bookingPrice(booking);
      return price - Math.round(price * 0.2);
    }

    function extensionPrice(booking, minutes) {
      const type = clean(booking.deliveryType || 'originals', 20);
      const baseMinutes = Number(booking.durationMinutes || 0) + Number(booking.totalExtensionMinutes || 0);
      const requested = Number(minutes);
      if (baseMinutes <= 60 && requested === 30) return PRICES[type][90] - PRICES[type][60];
      if (baseMinutes <= 90 && requested === 90) return PRICES[type][180] - PRICES[type][90];
      if (baseMinutes >= 180 && requested === 60) return EXTENDED_HOUR_PRICE;
      throw new HttpsError('invalid-argument', 'Choose the upgrade offered for this session.');
    }

    function extensionReeloEarning(price) {
      return price - Math.round(price * 0.2);
    }

    function reeloEligibleForEdited(profile) {
      return Boolean(profile && profile.canEditReels === true && profile.editingApprovalStatus === 'approved');
    }

    function welcomeDiscount(price) {
      return Math.round(price * WELCOME_DISCOUNT_PERCENT / 100);
    }

    function bookingChargePrice(booking) {
      const listPrice = bookingPrice(booking);
      const charged = Number(booking.customerPrice);
      return Number.isInteger(charged) && charged > 0 && charged <= listPrice
        ? charged
        : listPrice;
    }

    async function hasCapturedBooking(uid, exceptBookingId = "") {
      const snapshot = await db.collection("bookings").where("customerId", "==", uid).get();
      return snapshot.docs.some((doc) =>
        doc.id !== exceptBookingId && ["captured", "paid"].includes(clean(doc.get("paymentStatus"), 40))
      );
    }

    function providerError(payload, fallback) {
      return clean(payload && payload.error && (payload.error.description || payload.error.reason), 240) || fallback;
    }

    function chatSafetyIssue(input) {
      const text = clean(input, 2000).toLowerCase();
      const prohibited = [
        /\b(otp|one[ -]?time password|upi[ -]?pin|cvv|card[ -]?number|bank[ -]?password|login[ -]?password)\b/,
        /\b(i('| a)?m going to|i will|i'll) (kill|rape|hurt) you\b/,
        /\b(send|share) (a |your )?(nude|nudes|naked photo)\b/,
      ];
      if (prohibited.some((pattern) => pattern.test(text))) {
        return "This message appears to contain unsafe, abusive, or highly sensitive information.";
      }
      return "";
    }

    function blockRef(blockerId, blockedId) {
      return db.collection("users").doc(blockerId).collection("blocked_users").doc(blockedId);
    }

    function publicReference(prefix, seed) {
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const digest = crypto.createHash("sha256").update(String(seed || "")).digest();
      let code = "";
      for (let i = 0; i < 6; i += 1) code += alphabet[digest[i] % alphabet.length];
      return `RLT-${prefix}-${code}`;
    }

    function publicBookingRef(bookingId) { return publicReference("BK", bookingId); }
    function publicCustomerRef(customerId) { return publicReference("CU", customerId); }
    function publicReeloRef(reeloId) { return publicReference("RL", reeloId); }

    async function requireAdmin(request) {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in as an owner.");
      const admin = await db.collection("admins").doc(request.auth.uid).get();
      if (!admin.exists || admin.get("active") !== true) {
        throw new HttpsError("permission-denied", "Only an active Reel It owner can do this.");
      }
    }

    async function deleteDocuments(documents) {
      for (let offset = 0; offset < documents.length; offset += 400) {
        const batch = db.batch();
        documents.slice(offset, offset + 400).forEach((document) => batch.delete(document.ref));
        await batch.commit();
      }
    }

    async function deleteSubcollection(reference, name) {
      while (true) {
        const snapshot = await reference.collection(name).limit(400).get();
        if (snapshot.empty) return;
        await deleteDocuments(snapshot.docs);
      }
    }

    async function razorpay(path, {
      method = "GET",
      body,
      idempotencyKey,
      keyId = razorpayKeyId.value(),
      keySecret = razorpayKeySecret.value(),
    } = {}) {
      if (!String(keyId || "").startsWith("rzp_test_")) {
        throw new Error("Razorpay live keys are disabled in this v15 test build.");
      }
      const headers = {
        Authorization: basicAuth(keyId, keySecret),
        "Content-Type": "application/json",
      };
      if (idempotencyKey) headers["X-Payout-Idempotency"] = idempotencyKey;
      const response = await fetch(`https://api.razorpay.com${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(providerError(payload, "The provider rejected the request."));
      return payload;
    }

    async function sendToUser(uid, { title, body, data }) {
      if (!uid) return;
      const user = await db.collection("users").doc(uid).get();
      if (!user.exists) return;
      const tokens = user.get("fcmTokens");
      if (!Array.isArray(tokens) || !tokens.length) return;
      const isBookingRequest = data && data.type === "new_booking_request";
      const result = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: Object.fromEntries(Object.entries({ ...(data || {}), recipientUserId: uid }).map(([key, value]) => [key, String(value)])),
        android: {
          priority: "high",
          notification: {
            channelId: isBookingRequest ? "booking_requests" : "reel_it_updates",
            sound: "default",
          },
        },
        apns: {
          headers: { "apns-priority": "10" },
          payload: { aps: { sound: "default" } },
        },
      });
      const dead = [];
      result.responses.forEach((item, index) => {
        const code = item.error && item.error.code;
        if (!item.success && (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered")) dead.push(tokens[index]);
      });
      if (dead.length) await user.ref.update({ fcmTokens: FieldValue.arrayRemove(...dead) });
    }

    async function createNotification(uid, { title, body, type, bookingId = "", notificationId = "" }) {
      if (!uid) return;
      const reference = notificationId
        ? db.collection("notifications").doc(notificationId)
        : db.collection("notifications").doc();
      await reference.set({
        userId: uid,
        title,
        body,
        type,
        bookingId,
        read: false,
        source: "backend",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    function bookingOfferId(bookingId, reeloId) {
      return `${bookingId}_${reeloId}`;
    }

    async function closeBookingOffers(bookingId, acceptedReeloId = "") {
      await db.collection("bookings").doc(bookingId).set({
        offeredReeloIds: acceptedReeloId ? [acceptedReeloId] : [],
        offersClosedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      const offers = await db.collection("booking_offers").where("bookingId", "==", bookingId).get();
      if (offers.empty) return;
      const batch = db.batch();
      offers.docs.forEach((offer) => {
        const reeloId = clean(offer.get("reeloId"), 128);
        batch.set(offer.ref, {
          status: acceptedReeloId && reeloId === acceptedReeloId ? "accepted" : acceptedReeloId ? "taken" : "closed",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      await batch.commit();
      if (acceptedReeloId) {
        await Promise.all(offers.docs
          .filter((offer) => {
            const reeloId = clean(offer.get("reeloId"), 128);
            const customerId = clean(offer.get("customerId"), 128);
            return reeloId !== acceptedReeloId && reeloId !== customerId;
          })
          .map((offer) => createNotification(clean(offer.get("reeloId"), 128), {
            title: "Booking no longer available",
            body: "Another Reelo accepted this request.",
            type: "booking_taken",
            bookingId,
            notificationId: `taken_${bookingOfferId(bookingId, clean(offer.get("reeloId"), 128))}`,
          })));
      }
    }

    async function notifyAdmins({ title, body, data }) {
      const admins = await db.collection("admins").where("active", "==", true).get();
      await Promise.all(admins.docs.map((doc) => sendToUser(doc.id, { title, body, data })));
    }

    function distanceKm(lat1, lon1, lat2, lon2) {
      const radians = (value) => value * Math.PI / 180;
      const dLat = radians(lat2 - lat1);
      const dLon = radians(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    exports.onNotificationCreated = onDocumentCreated("notifications/{notificationId}", async (event) => {
      if (!event.data) return;
      const value = event.data.data();
      await sendToUser(value.userId, {
        title: value.title || "Reel It",
        body: value.body || "",
        data: { type: value.type || "", bookingId: value.bookingId || "", notificationId: event.params.notificationId },
      });
    });

    exports.onBookingWritten = onDocumentWritten("bookings/{bookingId}", async (event) => {
      const before = event.data.before.exists ? event.data.before.data() : null;
      const after = event.data.after.exists ? event.data.after.data() : null;
      if (!after) return;
      const bookingId = event.params.bookingId;
      const previousStatus = before && before.status;
      const status = after.status;

      const referencePatch = {};
      if (!after.bookingRef) referencePatch.bookingRef = publicBookingRef(bookingId);
      if (after.customerId && !after.customerRef) referencePatch.customerRef = publicCustomerRef(after.customerId);
      if (after.reeloId && !after.reeloRef) referencePatch.reeloRef = publicReeloRef(after.reeloId);
      if (Object.keys(referencePatch).length) {
        await event.data.after.ref.set(referencePatch, { merge: true });
        if (after.customerId) await db.collection("users").doc(after.customerId).set({ customerRef: publicCustomerRef(after.customerId) }, { merge: true });
        if (after.reeloId) await db.collection("reelo_profiles").doc(after.reeloId).set({ reeloRef: publicReeloRef(after.reeloId) }, { merge: true });
      }

      if (status === "searching" && previousStatus !== "searching") {
        await createNotification(after.customerId, { title: "Payment confirmed", body: "We are looking for an available Reelo near you.", type: "booking_searching", bookingId });
        const [profiles, customerProfile] = await Promise.all([
          db.collection("reelo_profiles").where("verified", "==", true).get(),
          db.collection("users").doc(clean(after.customerId, 128)).get(),
        ]);
        let preference = clean(after.reeloPreference || "no_preference");
        if (preference === "female" && (!customerProfile.exists || clean(customerProfile.get("gender"), 30) !== "female")) {
          // Female-only matching is a customer safety option and is only valid
          // for customers whose profile is explicitly recorded as female.
          preference = "no_preference";
          await event.data.after.ref.set({ reeloPreference: "no_preference", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
        const bookingLat = Number(after.latitude);
        const bookingLng = Number(after.longitude);
        const eligible = [];
        profiles.docs.forEach((doc) => {
          if (doc.id === after.customerId) return;
          const profile = doc.data();
          if (profile.onboardingComplete !== true || profile.trainingComplete !== true || profile.availability !== "Online") return;
          if (after.deliveryType === 'edited' && !reeloEligibleForEdited(profile)) return;
          if (preference !== "no_preference" && clean(profile.gender) !== preference) return;
          const lat = Number(profile.primaryLatitude);
          const lng = Number(profile.primaryLongitude);
          const radius = Number(profile.travelRadiusKm || 10);
          const hasCoordinates = [bookingLat, bookingLng, lat, lng].every(Number.isFinite);
          const distance = hasCoordinates
            ? distanceKm(bookingLat, bookingLng, lat, lng)
            : null;
          // Older Reelo profiles can be fully verified but predate stored coordinates.
          // Do not silently exclude those accounts from matching; keep them as a
          // fallback after distance-ranked profiles. Once coordinates are present,
          // the configured travel radius is enforced normally.
          if (hasCoordinates && (!Number.isFinite(radius) || radius <= 0 || distance > radius)) return;
          eligible.push({ reeloId: doc.id, distance });
        });
        eligible.sort((a, b) => (a.distance ?? Number.MAX_SAFE_INTEGER) - (b.distance ?? Number.MAX_SAFE_INTEGER));
        await event.data.after.ref.set({
          offeredReeloIds: eligible.map((item) => item.reeloId),
          offersCreatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await Promise.all(eligible.map(async ({ reeloId, distance }) => {
          const offerId = bookingOfferId(bookingId, reeloId);
          await db.collection("booking_offers").doc(offerId).set({
            bookingId,
            reeloId,
            customerId: after.customerId,
            status: "available",
            deliveryType: after.deliveryType || 'originals',
            deliveryWindowHours: after.deliveryType === 'edited' ? 48 : 24,
            distanceKm: distance === null ? null : Number(distance.toFixed(2)),
            expiresAt: after.requestExpiresAt || after.scheduledDateTime || null,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          const isScheduled = clean(after.timingType, 20) === "later" && after.scheduledDateTime;
          const scheduledLabel = isScheduled
            ? after.scheduledDateTime.toDate().toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : "";
          await createNotification(reeloId, {
            title: isScheduled ? "Scheduled booking available" : "New booking nearby",
            body: isScheduled
              ? `${clean(after.occasion, 60) || "A session"} is scheduled for ${scheduledLabel} in ${clean(after.location, 80) || "your area"}.`
              : `${clean(after.occasion, 60) || "A session"} is available in ${clean(after.location, 80) || "your area"}. First eligible Reelo to accept gets it.`,
            type: "new_booking_request",
            bookingId,
            notificationId: `offer_${offerId}`,
          });
        }));
      }
      if (status === "accepted" && previousStatus !== "accepted") {
        await createNotification(after.customerId, { title: "Reelo confirmed", body: `${clean(after.reeloName, 60) || "Your Reelo"} accepted. You have 10 minutes to review the profile.`, type: "booking_accepted", bookingId });
        await closeBookingOffers(bookingId, clean(after.reeloId, 128));
      }
      if (before && before.travelStatus !== after.travelStatus && ["on_the_way", "arriving_soon"].includes(after.travelStatus)) {
        await createNotification(after.customerId, { title: after.travelStatus === "arriving_soon" ? "Your Reelo is almost there" : "Your Reelo is on the way", body: Number(after.etaMinutes) > 0 ? `Estimated arrival: ${after.etaMinutes} minutes.` : "Open the booking for the latest ETA.", type: "reelo_travel_update", bookingId });
      }
      if (status === "arrived" && previousStatus !== "arrived") {
        await createNotification(after.customerId, { title: "Your Reelo has arrived", body: "Open the booking and share the private code only after you see the correct person.", type: "booking_arrived", bookingId });
      }
      if (status === "in_progress" && previousStatus !== "in_progress") {
        await createNotification(after.customerId, { title: "Session started", body: "Your Reel It session is now in progress.", type: "session_started", bookingId });
      }
      if (status === "completed" && previousStatus !== "completed") {
        if (after.reeloId) {
          const bookingRef = db.collection("bookings").doc(bookingId);
          await db.runTransaction(async (transaction) => {
            const current = await transaction.get(bookingRef);
            if (!current.exists) return;

            const alreadyCounted = Boolean(current.get("completionCountedAt"));
            if (!alreadyCounted) {
              transaction.update(bookingRef, {
                completionCountedAt: FieldValue.serverTimestamp(),
              });
              transaction.set(db.collection("users").doc(after.reeloId), {
                completedBookings: FieldValue.increment(1),
                updatedAt: FieldValue.serverTimestamp(),
              }, { merge: true });
            }

            // Completing the physical session must always release the Reelo
            // for new work. Pending content delivery remains on the booking and
            // payout eligibility is still gated by delivery/customer approval.
            transaction.set(db.collection("reelo_profiles").doc(after.reeloId), {
              ...(alreadyCounted ? {} : { completedBookings: FieldValue.increment(1) }),
              availability: "Online",
              availableSince: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          });
        }
        await createNotification(after.customerId, { title: "Session completed", body: after.deliveryStatus === "customer_device_completed" ? "The session was captured on your phone, so no Reel It upload is required." : after.deliveryStatus === "awaiting_customer_upload" ? "Upload the raw footage from your phone to start the 48-hour editing target." : "Confirm your footage after delivery, then rate your Reelo.", type: "session_completed", bookingId });
      }
      if (status === "cancelled" && previousStatus !== "cancelled") {
        await closeBookingOffers(bookingId);
        await Promise.all([
          createNotification(after.customerId, { title: "Booking cancelled", body: "Your booking has been cancelled.", type: "booking_cancelled", bookingId }),
          createNotification(after.reeloId, { title: "Booking cancelled", body: "Do not travel to the meeting point.", type: "booking_cancelled", bookingId }),
        ]);
        if (after.promotionCode === "WELCOME15" && after.customerId) {
          const userRef = db.collection("users").doc(after.customerId);
          const user = await userRef.get();
          if (user.exists && user.get("welcomeDiscountReservationBookingId") === bookingId && !user.get("welcomeDiscountRedeemedAt")) {
            await userRef.set({
              welcomeDiscountReservationBookingId: FieldValue.delete(),
              welcomeDiscountReservationExpiresAt: FieldValue.delete(),
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          }
        }
      }
      if (before && before.deliveryStatus !== after.deliveryStatus && after.deliveryStatus === "delivered") {
        await createNotification(after.customerId, { title: "Your footage is ready", body: "Confirm only after you can access the delivered files.", type: "content_delivered", bookingId });
      }
    });

    exports.onReeloEditingPreferenceWritten = onDocumentWritten("reelo_profiles/{reeloId}", async (event) => {
      if (!event.data.after.exists) return;
      const before = event.data.before.exists ? event.data.before.data() : {};
      const after = event.data.after.data();
      const wasEligible = reeloEligibleForEdited(before);
      const isEligible = reeloEligibleForEdited(after);
      if (wasEligible === isEligible || isEligible) return;
      const offers = await db.collection("booking_offers").where("reeloId", "==", event.params.reeloId).get();
      const stale = offers.docs.filter((doc) => doc.get("status") === "available" && clean(doc.get("deliveryType"), 20) === "edited");
      for (const doc of stale) {
        await doc.ref.set({
          status: "withdrawn",
          withdrawnReason: "editing_preference_or_approval_inactive",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });

    exports.onSosAlertCreated = onDocumentCreated("sos_alerts/{alertId}", async (event) => {
      if (!event.data) return;
      const alert = event.data.data();
      const bookingRef = db.collection("bookings").doc(clean(alert.bookingId, 120));
      const booking = await bookingRef.get();
      if (!booking.exists || ![booking.get("customerId"), booking.get("reeloId")].includes(alert.raisedBy)) return;
      await bookingRef.set({ lastSosAlertId: event.params.alertId, lastSosAlertAt: FieldValue.serverTimestamp() }, { merge: true });
      const body = alert.note ? `${clean(alert.raisedByName, 80) || "A user"}: ${clean(alert.note, 180)}` : `${clean(alert.raisedByName, 80) || "A user"} raised an SOS.`;
      await notifyAdmins({ title: "🚨 Priority SOS alert", body, data: { type: "sos_alert", alertId: event.params.alertId, bookingId: alert.bookingId || "" } });
    });

    exports.onProfileReviewWritten = onDocumentWritten("reelo_profile_reviews/{reeloId}", async (event) => {
      if (!event.data.after.exists) return;
      const beforeStatus = event.data.before.exists ? event.data.before.get("status") : "";
      const afterStatus = event.data.after.get("status");
      if (afterStatus === beforeStatus) return;
      if (afterStatus === "approved") {
        await createNotification(event.params.reeloId, {
          title: "Profile review approved",
          body: "Your Reelo profile is approved. Complete any remaining profile and training steps to go Online.",
          type: "profile_review_update",
        });
      }
      if (afterStatus === "resubmission_required") {
        await createNotification(event.params.reeloId, {
          title: "New profile selfie needed",
          body: clean(event.data.after.get("reviewNote"), 140) || "Open Profile review to take a new live selfie.",
          type: "profile_review_update",
        });
      }
    });

    exports.onUserReportWritten = onDocumentWritten("user_reports/{reportId}", async (event) => {
      if (!event.data.after.exists || !event.data.before.exists) return;
      const beforeStatus = event.data.before.get("status");
      const after = event.data.after.data();
      if (after.status === beforeStatus || !["investigating", "resolved", "escalated"].includes(after.status)) return;
      const body = after.status === "resolved"
        ? "Reel It Support completed its review. Contact Support if you have new information."
        : after.status === "escalated"
          ? "Your report has been escalated for additional review."
          : "Reel It Support is investigating your report.";
      await createNotification(after.reporterId, {
        title: "Safety report update",
        body,
        type: "safety_report_update",
        bookingId: clean(after.bookingId, 120),
      });
    });

    exports.refreshMyBookingOffers = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to refresh booking requests.");
      const uid = request.auth.uid;
      const profileSnap = await db.collection("reelo_profiles").doc(uid).get();
      if (!profileSnap.exists) return { refreshed: true, offers: 0 };
      const profile = profileSnap.data();
      if (profile.verified !== true || profile.onboardingComplete !== true || profile.trainingComplete !== true || profile.availability !== "Online") {
        return { refreshed: true, offers: 0 };
      }

      const searching = await db.collection("bookings").where("status", "==", "searching").get();
      let offers = 0;
      for (const bookingDoc of searching.docs) {
        const booking = bookingDoc.data();
        if (clean(booking.customerId, 128) === uid || booking.reeloId) continue;
        const expiresAt = booking.requestExpiresAt;
        if (expiresAt && typeof expiresAt.toMillis === "function" && expiresAt.toMillis() <= Date.now()) continue;
        if (clean(booking.deliveryType, 20) === "edited" && !reeloEligibleForEdited(profile)) continue;

        let preference = clean(booking.reeloPreference || "no_preference", 30);
        if (preference === "female") {
          const customer = await db.collection("users").doc(clean(booking.customerId, 128)).get();
          if (!customer.exists || clean(customer.get("gender"), 30) !== "female") preference = "no_preference";
        }
        if (preference !== "no_preference" && clean(profile.gender, 30) !== preference) continue;

        const bookingLat = Number(booking.latitude);
        const bookingLng = Number(booking.longitude);
        const reeloLat = Number(profile.primaryLatitude);
        const reeloLng = Number(profile.primaryLongitude);
        const radius = Number(profile.travelRadiusKm || 10);
        const hasCoordinates = [bookingLat, bookingLng, reeloLat, reeloLng].every(Number.isFinite);
        const distance = hasCoordinates ? distanceKm(bookingLat, bookingLng, reeloLat, reeloLng) : null;
        if (hasCoordinates && (!Number.isFinite(radius) || radius <= 0 || distance > radius)) continue;

        const offerId = bookingOfferId(bookingDoc.id, uid);
        const offerRef = db.collection("booking_offers").doc(offerId);
        const existingOffer = await offerRef.get();
        if (existingOffer.exists && clean(existingOffer.get("status"), 30) === "declined") continue;
        const currentBooking = await bookingDoc.ref.get();
        if (!currentBooking.exists || currentBooking.get("status") !== "searching" || currentBooking.get("reeloId")) continue;
        await offerRef.set({
          bookingId: bookingDoc.id,
          reeloId: uid,
          customerId: booking.customerId,
          status: "available",
          deliveryType: booking.deliveryType || "originals",
          deliveryWindowHours: booking.deliveryType === "edited" ? 48 : 24,
          distanceKm: distance === null ? null : Number(distance.toFixed(2)),
          expiresAt: booking.requestExpiresAt || booking.scheduledDateTime || null,
          repairedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await bookingDoc.ref.set({
          offeredReeloIds: FieldValue.arrayUnion(uid),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        offers += 1;
      }
      return { refreshed: true, offers };
    });

    exports.acceptBookingOffer = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before accepting a booking.");
      const uid = request.auth.uid;
      const bookingId = clean(request.data && request.data.bookingId, 120);
      if (!bookingId) throw new HttpsError("invalid-argument", "A valid booking is required.");
      const bookingRef = db.collection("bookings").doc(bookingId);
      const profileRef = db.collection("reelo_profiles").doc(uid);
      const userRef = db.collection("users").doc(uid);
      const offerRef = db.collection("booking_offers").doc(bookingOfferId(bookingId, uid));

      await db.runTransaction(async (transaction) => {
        const bookingSnapshot = await transaction.get(bookingRef);
        const profileSnapshot = await transaction.get(profileRef);
        const userSnapshot = await transaction.get(userRef);
        const offerSnapshot = await transaction.get(offerRef);
        if (!bookingSnapshot.exists) throw new HttpsError("not-found", "This booking no longer exists.");
        const booking = bookingSnapshot.data();
        if (booking.status !== "searching" || booking.reeloId) {
          throw new HttpsError("already-exists", "Another Reelo accepted this request.");
        }
        if (booking.customerId === uid) {
          throw new HttpsError("permission-denied", "You cannot accept your own booking.");
        }
        if (!offerSnapshot.exists || offerSnapshot.get("status") !== "available") {
          throw new HttpsError("failed-precondition", "This booking is no longer available to you.");
        }
        const expiresAt = booking.requestExpiresAt;
        if (expiresAt && expiresAt.toMillis() <= Date.now()) {
          throw new HttpsError("deadline-exceeded", "This booking request has expired.");
        }
        const profile = profileSnapshot.exists ? profileSnapshot.data() : {};
        if (profile.verified !== true || profile.onboardingComplete !== true || profile.trainingComplete !== true || profile.availability !== "Online") {
          throw new HttpsError("failed-precondition", "You must be verified and Online to accept bookings.");
        }
        if (booking.deliveryType === 'edited' && !reeloEligibleForEdited(profile)) {
          throw new HttpsError('failed-precondition', 'Edited requests are available only when Editing jobs is turned on and Reel It editing approval is active.');
        }
        const user = userSnapshot.exists ? userSnapshot.data() : {};
        transaction.update(bookingRef, {
          status: "accepted",
          reeloId: uid,
          offeredReeloIds: [uid],
          reeloEmail: clean(user.email || profile.email, 120),
          reeloName: clean(user.name || profile.name, 80) || "Your Reelo",
          reeloPhotoUrl: clean(profile.photoUrl || user.photoUrl, 500),
          acceptedAt: FieldValue.serverTimestamp(),
          profileReviewEndsAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.set(profileRef, {
          availability: "Busy",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(offerRef, {
          status: "accepted",
          acceptedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      return { accepted: true };
    });

    exports.sendBookingMessage = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to send a message.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const text = clean(request.data && request.data.text, 2000);
      if (!bookingId || !text) throw new HttpsError("invalid-argument", "Write a message first.");
      if (text.length > 1000) throw new HttpsError("invalid-argument", "Messages must be shorter than 1,000 characters.");
      const issue = chatSafetyIssue(text);
      if (issue) {
        throw new HttpsError(
          "invalid-argument",
          `${issue} Never share OTPs, UPI PINs, passwords, or full payment details in chat.`,
        );
      }

      const booking = await db.collection("bookings").doc(bookingId).get();
      if (!booking.exists) throw new HttpsError("not-found", "Booking not found.");
      const customerId = clean(booking.get("customerId"), 128);
      const reeloId = clean(booking.get("reeloId"), 128);
      const senderId = request.auth.uid;
      if (!reeloId || ![customerId, reeloId].includes(senderId)) {
        throw new HttpsError("permission-denied", "Only the assigned booking parties can chat.");
      }
      const bookingStatus = clean(booking.get("status"), 40);
      const deliveryStatus = clean(booking.get("deliveryStatus"), 40);
      const chatOpen = ["accepted", "arrived", "in_progress"].includes(bookingStatus) ||
        (bookingStatus === "completed" && ["pending_upload", "uploading", "delivered"].includes(deliveryStatus) && booking.get("contentExpired") !== true);
      if (!chatOpen) {
        throw new HttpsError("failed-precondition", "Direct Customer–Reelo chat is closed for this booking. Contact Reel It Support if you still need help.");
      }
      const otherId = senderId === customerId ? reeloId : customerId;
      const [senderBlockedOther, otherBlockedSender] = await db.getAll(
        blockRef(senderId, otherId),
        blockRef(otherId, senderId),
      );
      if (senderBlockedOther.exists || otherBlockedSender.exists) {
        throw new HttpsError("permission-denied", "Messaging is unavailable because one of these accounts is blocked.");
      }

      const sender = await db.collection("users").doc(senderId).get();
      await booking.ref.collection("messages").add({
        senderId,
        senderName: clean(sender.exists && (sender.get("name") || sender.get("displayName")), 80),
        text,
        moderation: "passed_basic_safety_filter",
        createdAt: FieldValue.serverTimestamp(),
      });
      return { sent: true };
    });

    exports.setCaptureDeviceChoice = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before confirming the capture device.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const choice = clean(request.data && request.data.choice, 40);
      if (!["customer_device", "reelo_equipment"].includes(choice)) throw new HttpsError("invalid-argument", "Choose the customer phone or Reelo device.");
      const ref = db.collection("bookings").doc(bookingId);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
        const b = snap.data();
        if (b.status !== "arrived" || b.arrivalCodeVerified !== true) throw new HttpsError("failed-precondition", "Verify the arrival code before confirming the capture device.");
        const role = request.auth.uid === b.customerId ? "customer" : request.auth.uid === b.reeloId ? "reelo" : "";
        if (!role) throw new HttpsError("permission-denied", "Only this booking's customer and Reelo can confirm the device.");
        const customerChoice = role === "customer" ? choice : clean(b.captureDeviceCustomerChoice, 40);
        const reeloChoice = role === "reelo" ? choice : clean(b.captureDeviceReeloChoice, 40);
        const resolved = customerChoice && reeloChoice && customerChoice === reeloChoice ? customerChoice : null;
        const conflict = customerChoice && reeloChoice && customerChoice !== reeloChoice;
        const patch = {
          ...(role === "customer" ? { captureDeviceCustomerChoice: choice, captureDeviceCustomerConfirmedAt: FieldValue.serverTimestamp() } : { captureDeviceReeloChoice: choice, captureDeviceReeloConfirmedAt: FieldValue.serverTimestamp() }),
          captureDeviceStatus: resolved ? "confirmed" : conflict ? "conflict" : "awaiting_both",
          captureDeviceResolved: resolved,
          captureDeviceConfirmedAt: resolved ? FieldValue.serverTimestamp() : null,
          ...(resolved ? { status: "in_progress", startedAt: FieldValue.serverTimestamp(), sessionStartedAutomatically: true } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        };
        tx.set(ref, patch, { merge: true });
        return { role, resolved, conflict };
      });
      return result;
    });

    exports.startBookingSession = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before starting the session.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const ref = db.collection("bookings").doc(bookingId);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
        const b = snap.data();
        if (b.reeloId !== request.auth.uid && b.customerId !== request.auth.uid) throw new HttpsError("permission-denied", "Only this booking’s customer or assigned Reelo can access this session.");
        if (b.status === "in_progress") return;
        if (b.status !== "arrived" || b.arrivalCodeVerified !== true) throw new HttpsError("failed-precondition", "Verify the customer's arrival code first.");
        const captureDevice = clean(b.captureDeviceResolved, 40);
        if (!["customer_device", "reelo_equipment"].includes(captureDevice)) throw new HttpsError("failed-precondition", "Both people must confirm the same recording device first.");
        tx.update(ref, {
          status: "in_progress",
          startedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      return { started: true };
    });

    exports.completeBookingSession = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before completing the session.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const ref = db.collection("bookings").doc(bookingId);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
        const b = snap.data();
        if (b.reeloId !== request.auth.uid) throw new HttpsError("permission-denied", "Only the assigned Reelo can complete this booking.");
        if (b.status !== "in_progress") throw new HttpsError("failed-precondition", "Only an active session can be completed.");
        const startedAt = b.startedAt;
        const totalMinutes = Number(b.durationMinutes || 0) + Number(b.totalExtensionMinutes || 0);
        if (!startedAt || totalMinutes <= 0 || Date.now() < startedAt.toMillis() + totalMinutes * 60 * 1000) {
          throw new HttpsError("failed-precondition", "The paid session window has not ended yet.");
        }
        const captureDevice = clean(b.captureDeviceResolved, 40);
        if (!["customer_device", "reelo_equipment"].includes(captureDevice)) throw new HttpsError("failed-precondition", "Both people must confirm the same capture device before the session can be completed.");
        const customerDevice = captureDevice === "customer_device";
        const deliveryType = clean(b.deliveryType || "originals", 20);
        const edited = deliveryType === "edited";
        const hours = edited ? 48 : 24;
        let deliveryStatus;
        let deliveryDueAt = null;
        let earningsEligibleAt = null;
        let deliveryConfirmedAt = null;
        let payoutStatus = b.payoutStatus === "review_required" ? "review_required" : "pending_delivery";

        if (customerDevice && !edited) {
          deliveryStatus = "customer_device_completed";
          earningsEligibleAt = Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000);
          deliveryConfirmedAt = FieldValue.serverTimestamp();
          payoutStatus = b.payoutStatus === "review_required" ? "review_required" : "available";
        } else if (customerDevice && edited) {
          deliveryStatus = "awaiting_customer_upload";
        } else {
          deliveryStatus = "pending_upload";
          deliveryDueAt = Timestamp.fromMillis(Date.now() + hours * 60 * 60 * 1000);
        }

        const patch = {
          status: "completed",
          deliveryStatus,
          deliveryDueAt,
          completedAt: FieldValue.serverTimestamp(),
          footageTransferConfirmed: customerDevice && !edited,
          localDeletionConfirmed: customerDevice && !edited,
          contentExpiresAt: null,
          contentExpired: false,
          payoutStatus,
          earningsEligibleAt,
          deliveryConfirmedAt,
          updatedAt: FieldValue.serverTimestamp(),
        };
        tx.update(ref, patch);
        tx.set(db.collection("reelo_profiles").doc(request.auth.uid), { availability: "Online", availableSince: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { captureDevice, deliveryStatus: patch.deliveryStatus };
      });
      return result;
    });

    exports.submitSafetyReport = onCall({ invoker: "public", enforceAppCheck: true }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to report an account.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const reportedUserId = clean(request.data && request.data.reportedUserId, 128);
      const reason = clean(request.data && request.data.reason, 40);
      const note = clean(request.data && request.data.note, 1000);
      const shouldBlock = request.data && request.data.block === true;
      if (!bookingId || !reportedUserId || !REPORT_REASONS.has(reason)) {
        throw new HttpsError("invalid-argument", "Choose a valid safety-report reason.");
      }

      const booking = await db.collection("bookings").doc(bookingId).get();
      if (!booking.exists) throw new HttpsError("not-found", "Booking not found.");
      const reporterId = request.auth.uid;
      const customerId = clean(booking.get("customerId"), 128);
      const reeloId = clean(booking.get("reeloId"), 128);
      if (!reeloId || ![customerId, reeloId].includes(reporterId)) {
        throw new HttpsError("permission-denied", "Only a booking party can file this report.");
      }
      const expectedReportedId = reporterId === customerId ? reeloId : customerId;
      if (reportedUserId !== expectedReportedId) {
        throw new HttpsError("permission-denied", "The reported account is not the other booking party.");
      }

      const reportId = crypto
        .createHash("sha256")
        .update(`${bookingId}|${reporterId}|${reportedUserId}`)
        .digest("hex");
      const reportRef = db.collection("user_reports").doc(reportId);
      const batch = db.batch();
      batch.set(reportRef, {
        reporterId,
        reporterEmail: clean(request.auth.token.email, 120),
        reportedUserId,
        reportedUserName: reporterId === customerId
          ? clean(booking.get("reeloName"), 80)
          : clean(booking.get("customerName"), 80),
        bookingId,
        reason,
        note,
        status: "open",
        blockRequested: shouldBlock,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (shouldBlock) {
        batch.set(blockRef(reporterId, reportedUserId), {
          blockerId: reporterId,
          blockedUserId: reportedUserId,
          blockedUserName: reporterId === customerId
            ? clean(booking.get("reeloName"), 80)
            : clean(booking.get("customerName"), 80),
          bookingId,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
      await notifyAdmins({
        title: reason === "safety" ? "Priority safety report" : "New user report",
        body: `${clean(request.auth.token.email, 100) || "A user"} reported another booking party.`,
        data: { type: "user_report", reportId, bookingId },
      });
      return { reportId, blocked: shouldBlock };
    });

    exports.onChatMessageCreated = onDocumentCreated("bookings/{bookingId}/messages/{messageId}", async (event) => {
      const message = event.data && event.data.data();
      if (!message) return;
      const booking = await db.collection("bookings").doc(event.params.bookingId).get();
      if (!booking.exists) return;
      const recipientId = message.senderId === booking.get("customerId") ? booking.get("reeloId") : booking.get("customerId");
      if (!recipientId) return;
      const recipient = await db.collection("users").doc(recipientId).get();
      if (recipient.exists && (recipient.data().notificationPreferences || {}).chat === false) return;
      await sendToUser(recipientId, { title: `New message from ${clean(message.senderName, 60) || "your booking"}`, body: clean(message.text, 120) || "New message", data: { type: "chat_message", bookingId: event.params.bookingId } });
    });

    function timestampMillis(value) {
      return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
    }

    function formatMoney(value) {
      return `₹${Math.max(0, Math.round(Number(value) || 0)).toLocaleString("en-IN")}`;
    }

    function remainingTime(timestamp) {
      const ms = timestampMillis(timestamp) - Date.now();
      if (ms <= 0) return "overdue";
      const hours = Math.floor(ms / (60 * 60 * 1000));
      const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
      if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h remaining`;
      return `${hours}h ${minutes}m remaining`;
    }

    function readableBookingStatus(booking) {
      const status = clean(booking && booking.status, 40);
      const delivery = clean(booking && booking.deliveryStatus, 40);
      if (status === "completed" && ["pending_upload", "uploading"].includes(delivery)) return "Session complete · Pending upload";
      if (status === "completed" && delivery === "delivered") return "Session complete · Waiting for customer review";
      if (status === "completed" && delivery === "customer_confirmed") return "Completed · Delivery accepted";
      const labels = {
        payment_pending: "Awaiting payment",
        searching: "Searching for a Reelo",
        accepted: "Accepted",
        arrived: "Reelo arrived",
        in_progress: "Session in progress",
        completed: "Session complete",
        cancelled: "Cancelled",
        expired: "Expired",
      };
      return labels[status] || status || "Unknown";
    }

    async function latestBookingFor(uid, role) {
      const field = role === "reelo" ? "reeloId" : "customerId";
      const snap = await db.collection("bookings").where(field, "==", uid).get();
      if (snap.empty) return null;
      const docs = [...snap.docs].sort((a, b) => {
        const av = timestampMillis(a.get("updatedAt")) || timestampMillis(a.get("createdAt"));
        const bv = timestampMillis(b.get("updatedAt")) || timestampMillis(b.get("createdAt"));
        return bv - av;
      });
      return { id: docs[0].id, ...docs[0].data() };
    }

    async function supportBooking(thread) {
      const bookingId = clean(thread.get("bookingId"), 120);
      if (bookingId) {
        const snap = await db.collection("bookings").doc(bookingId).get();
        return snap.exists ? { id: snap.id, ...snap.data() } : null;
      }
      return latestBookingFor(clean(thread.get("userId"), 128), clean(thread.get("userRole"), 20) || "customer");
    }

    async function reeloEarningsSummary(uid) {
      const snap = await db.collection("bookings").where("reeloId", "==", uid).get();
      let available = 0;
      let pending = 0;
      const reasons = [];
      snap.docs.forEach((doc) => {
        const booking = doc.data();
        if (!['captured', 'paid'].includes(clean(booking.paymentStatus, 40))) return;
        const amount = Number(booking.reeloEarnings) > 0 ? Number(booking.reeloEarnings) : reeloEarning(booking);
        if (clean(booking.payoutStatus, 40) === 'paid') return;
        const eligible = booking.status === 'completed' &&
          ['customer_confirmed','customer_device_completed'].includes(booking.deliveryStatus) &&
          booking.deliveryDisputed !== true &&
          booking.earningsEligibleAt &&
          timestampMillis(booking.earningsEligibleAt) <= Date.now() &&
          !['creating','queued','pending','processing','processed','review_required'].includes(clean(booking.payoutStatus, 40));
        if (eligible) {
          available += amount;
        } else if (booking.status === 'completed') {
          pending += amount;
          if (booking.deliveryStatus === 'pending_upload' || booking.deliveryStatus === 'uploading') reasons.push(`${doc.id}: content still needs delivery`);
          else if (booking.deliveryStatus === 'delivered') reasons.push(`${doc.id}: waiting for customer review`);
          else if (booking.deliveryDisputed === true) reasons.push(`${doc.id}: delivery is under review`);
          else if (['customer_confirmed','customer_device_completed'].includes(booking.deliveryStatus) && booking.earningsEligibleAt) reasons.push(`${doc.id}: release window ${remainingTime(booking.earningsEligibleAt)}`);
        }
      });
      return { available, pending, reasons: reasons.slice(0, 3) };
    }

    async function pendingDeliveriesSummary(uid) {
      const snap = await db.collection("bookings").where("reeloId", "==", uid).get();
      return snap.docs
        .filter((doc) => doc.get("status") === "completed" && ["pending_upload", "uploading"].includes(clean(doc.get("deliveryStatus"), 40)))
        .sort((a, b) => timestampMillis(a.get("deliveryDueAt")) - timestampMillis(b.get("deliveryDueAt")))
        .slice(0, 5)
        .map((doc) => ({
          id: doc.id,
          occasion: clean(doc.get("occasion"), 50) || "Booking",
          deliveryType: clean(doc.get("deliveryType"), 20) || "originals",
          due: doc.get("deliveryDueAt"),
        }));
    }

    async function buildSupportAnswer(thread, input) {
      const text = clean(input, 1000).toLowerCase();
      const uid = clean(thread.get("userId"), 128);
      const role = clean(thread.get("userRole"), 20) || "customer";
      const booking = await supportBooking(thread);

      if (/\b(unsafe|danger|threat|assault|attack|emergency|sos)\b/.test(text)) {
        return { intent: "safety", text: "If anyone is in immediate danger, call 112 first. Use Reel It SOS for an active booking, and tap Talk to a person so Operations can review the booking. Do not share passwords, OTPs, UPI PINs, or full banking/card details here." };
      }

      if (role === "reelo" && /\b(balance|earn|earning|money|paid|payment due|payout)\b/.test(text)) {
        const summary = await reeloEarningsSummary(uid);
        const details = summary.reasons.length ? ` Pending reasons: ${summary.reasons.join("; ")}.` : "";
        return { intent: "reelo_earnings", text: `Your eligible Reel It earnings are ${formatMoney(summary.available)}. Pending earnings are ${formatMoney(summary.pending)}.${details} Finishing a shoot alone does not unlock earnings; required content must be delivered and accepted.` };
      }

      if (role === "reelo" && /\b(upload|content|photo|photos|reel|reels|deliver|delivery|pending)\b/.test(text)) {
        const items = await pendingDeliveriesSummary(uid);
        if (!items.length) return { intent: "pending_delivery", text: "You do not currently have any bookings waiting for an upload." };
        const lines = items.map((item) => `${item.occasion} (${item.id}) · ${item.deliveryType === 'edited' ? 'Edited' : 'Originals'} · ${remainingTime(item.due)}`);
        return { intent: "pending_delivery", text: `You have ${items.length} pending ${items.length === 1 ? 'delivery' : 'deliveries'}: ${lines.join(" | ")}. You can stay Online and accept new work while these uploads are pending, but the related earnings remain locked until delivery is accepted.` };
      }

      if (role === "reelo" && /\b(offline|online|busy|available|availability|booking requests|not getting)\b/.test(text)) {
        const profile = await db.collection("reelo_profiles").doc(uid).get();
        const availability = profile.exists ? clean(profile.get("availability"), 30) : "Unknown";
        let answer = `Your current Reelo availability is ${availability}.`;
        if (availability === "Busy") answer += " Busy should only apply while a physical session is active. Once the session ends, you should return Online even if content is still pending.";
        if (availability === "Offline") answer += " Switch Online from Reelo Hub when you are ready to receive work.";
        if (availability === "Online") answer += " You are eligible to receive matching requests, subject to verification, location/radius and job qualifications.";
        return { intent: "reelo_availability", text: answer };
      }

      if (role === "reelo" && /\b(edit|edited|editing|portfolio)\b/.test(text)) {
        const profile = await db.collection("reelo_profiles").doc(uid).get();
        const status = profile.exists ? clean(profile.get("editingApprovalStatus"), 40) || "not requested" : "not requested";
        return { intent: "editing_approval", text: `Your editing approval status is ${status}. Only Editing Approved Reelos receive Edited jobs. Editing approval requires portfolio work and Operations review.` };
      }

      if (booking && /\b(where.*reelo|eta|on the way|arriv|late|no show)\b/.test(text)) {
        const travel = clean(booking.travelStatus, 40);
        const eta = Number(booking.etaMinutes);
        if (booking.status === "arrived") return { intent: "arrival", text: "Your Reelo has marked themselves arrived. Share the private arrival code only after you physically see the correct Reelo." };
        if (travel === "arriving_soon") return { intent: "arrival", text: `Your Reelo is arriving soon${eta > 0 ? `; the latest ETA is about ${eta} minutes` : ""}.` };
        if (travel === "on_the_way") return { intent: "arrival", text: `Your Reelo is on the way${eta > 0 ? `; the latest ETA is about ${eta} minutes` : ""}.` };
        if (booking.status === "accepted") return { intent: "arrival", text: "Your Reelo has accepted the booking but has not marked themselves on the way yet. If the booking time has passed, tap Talk to a person." };
        return { intent: "arrival", text: `The current booking status is ${readableBookingStatus(booking)}. If the expected arrival time has passed, tap Talk to a person and Operations will receive this booking automatically.` };
      }

      if (booking && /\b(photo|photos|reel|reels|content|upload|delivery|files)\b/.test(text)) {
        const delivery = clean(booking.deliveryStatus, 40);
        const type = clean(booking.deliveryType, 20) === "edited" ? "Edited" : "Originals";
        if (["pending_upload", "uploading"].includes(delivery)) return { intent: "customer_content", text: `Your ${type} booking is waiting for content delivery. ${booking.deliveryDueAt ? `The delivery window is ${remainingTime(booking.deliveryDueAt)}.` : ""} The Reelo is not payout-eligible for this booking until the required content is delivered and accepted.` };
        if (delivery === "delivered") return { intent: "customer_content", text: "Your content has been delivered and is waiting for your review. Check that the files belong to your booking before accepting delivery. If the files are wrong or incomplete, do not accept them—tap Talk to a person." };
        if (delivery === "customer_confirmed") return { intent: "customer_content", text: "You accepted this delivery. Save the files you want to keep before the download window expires." };
        return { intent: "customer_content", text: `This booking is currently ${readableBookingStatus(booking)}. Content delivery begins after the physical session is completed.` };
      }

      if (booking && /\b(payment|paid|charged|charge|price|cost|refund|cancel)\b/.test(text)) {
        const paid = clean(booking.paymentStatus, 40);
        const refund = clean(booking.refundStatus, 60);
        const amount = Number(booking.customerPrice || booking.price || booking.listPrice || 0);
        if (text.includes("refund") || text.includes("cancel")) {
          if (refund && refund !== "not_required") return { intent: "refund", text: `This booking's refund status is ${refund}. ${amount > 0 ? `The recorded booking amount is ${formatMoney(amount)}.` : ""} If you need a decision or the status looks wrong, tap Talk to a person.` };
          return { intent: "refund", text: `This booking is ${readableBookingStatus(booking)}. Refund eligibility depends on the booking state and whether the Reelo has started travelling or the session has begun. Tap Talk to a person for a human refund decision.` };
        }
        return { intent: "payment", text: `The recorded payment status is ${paid || "not confirmed"}${amount > 0 ? ` for ${formatMoney(amount)}` : ""}. If you believe you were charged twice or this status does not match your bank/payment app, do not pay again—tap Talk to a person.` };
      }

      if (booking && /\b(booking|status|job|session|what.*happening)\b/.test(text)) {
        return { intent: "booking_status", text: `Booking ${booking.id} is currently: ${readableBookingStatus(booking)}.${booking.deliveryDueAt && booking.status === 'completed' ? ` Delivery is ${remainingTime(booking.deliveryDueAt)}.` : ""}` };
      }

      if (/\b(delete account|delete my account|close account)\b/.test(text)) {
        return { intent: "account_deletion", text: "You can request account deletion from Reel It account/settings. For security, you may be asked to sign in again before submitting the request." };
      }

      if (/\b(coupon|discount|first booking|15%)\b/.test(text)) {
        return { intent: "promotion", text: "Reel It discounts are provided through active coupon codes. Enter a valid coupon at checkout to apply an eligible campaign discount." };
      }

      if (booking) {
        const ref = publicBookingRef(booking.id);
        const payment = clean(booking.paymentStatus, 40) || "not confirmed";
        const delivery = clean(booking.deliveryStatus, 40);
        const due = booking.deliveryDueAt && booking.status === "completed"
          ? ` Delivery is ${remainingTime(booking.deliveryDueAt)}.`
          : "";
        if (role === "reelo") {
          const profile = await db.collection("reelo_profiles").doc(uid).get();
          const availability = profile.exists ? clean(profile.get("availability"), 30) || "Unknown" : "Unknown";
          return { intent: "general_booking", text: `${ref}: ${readableBookingStatus(booking)}. Your availability is ${availability}.${delivery ? ` Delivery status: ${delivery}.` : ""}${due} Ask about earnings, uploads, availability, editing approval, or tap Talk to a person.` };
        }
        return { intent: "general_booking", text: `${ref}: ${readableBookingStatus(booking)}. Payment: ${payment}.${delivery ? ` Delivery status: ${delivery}.` : ""}${due} Ask about your Reelo, arrival, photos, payment/refund, or tap Talk to a person.` };
      }
      return { intent: "general", text: role === "reelo"
        ? "I can check your availability, pending uploads, editing approval and Reel It earnings. If you need a human decision, tap Talk to a person."
        : "I can check your latest booking, content delivery, payment and refund information. If you need a human decision, tap Talk to a person." };
    }

    exports.openSupportThread = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to contact Reel It Support.");
      const uid = request.auth.uid;
      const requestedBookingId = clean(request.data && request.data.bookingId, 120);
      const forceNew = request.data && request.data.startNew === true;
      let bookingId = "";
      let userRole = "customer";
      let bookingOccasion = "";

      if (requestedBookingId) {
        const booking = await db.collection("bookings").doc(requestedBookingId).get();
        if (!booking.exists) throw new HttpsError("not-found", "This booking no longer exists.");
        const customerId = clean(booking.get("customerId"), 128);
        const reeloId = clean(booking.get("reeloId"), 128);
        if (uid === customerId) userRole = "customer";
        else if (uid === reeloId) userRole = "reelo";
        else throw new HttpsError("permission-denied", "This booking is not connected to your account.");
        bookingId = booking.id;
        bookingOccasion = clean(booking.get("occasion"), 80);
      } else {
        const reeloProfile = await db.collection("reelo_profiles").doc(uid).get();
        userRole = reeloProfile.exists ? "reelo" : "customer";
      }

      if (!forceNew) {
        const recent = await db.collection("support_threads").where("userId", "==", uid).limit(20).get();
        const active = recent.docs.find((d) => {
          const x = d.data();
          const sameBooking = clean(x.bookingId, 120) === bookingId;
          return sameBooking && ["waiting", "active", "needs_human", "open"].includes(clean(x.status, 30));
        });
        if (active) return { threadId: active.id, userRole, bookingId, existing: true };
      }

      const threadId = `support_${uid.slice(0, 12)}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      const threadRef = db.collection("support_threads").doc(threadId);
      const [userSnap, reeloSnap] = await Promise.all([
        db.collection("users").doc(uid).get(),
        userRole === "reelo" ? db.collection("reelo_profiles").doc(uid).get() : Promise.resolve(null),
      ]);
      const userData = userSnap.exists ? userSnap.data() : {};
      const reeloData = reeloSnap && reeloSnap.exists ? reeloSnap.data() : {};
      await threadRef.set({
        userId: uid,
        userEmail: clean((userData && userData.email) || (reeloData && reeloData.email) || (request.auth.token && request.auth.token.email), 160),
        userName: clean((userData && (userData.name || userData.displayName)) || (reeloData && reeloData.name), 100),
        userPhone: clean((userData && (userData.phone || userData.phoneNumber)) || (reeloData && (reeloData.phone || reeloData.phoneNumber)), 40),
        userPhotoUrl: clean((reeloData && reeloData.photoUrl) || (userData && userData.photoUrl), 500),
        userRole,
        bookingId: bookingId || null,
        bookingOccasion,
        status: "waiting",
        humanRequested: true,
        unreadBySupport: true,
        unreadByUser: false,
        createdAt: FieldValue.serverTimestamp(),
        humanRequestedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await threadRef.collection("messages").add({
        senderId: "system",
        senderType: "system",
        text: "Thanks — your message will go directly to Reel It Support. Someone from our team will join this chat shortly. You can keep sending details while you wait.",
        createdAt: FieldValue.serverTimestamp(),
      });
      await notifyAdmins({
        title: `${userRole === "reelo" ? "Reelo" : "Customer"} waiting for support`,
        body: bookingId ? `New support chat for ${publicBookingRef(bookingId)}.` : "A new support chat is waiting.",
        data: { type: "support_thread", threadId, bookingId, userRole },
      });
      return { threadId, userRole, bookingId, existing: false };
    });

    exports.onSupportMessageCreated = onDocumentCreated("support_threads/{threadId}/messages/{messageId}", async (event) => {
      const message = event.data && event.data.data();
      if (!message) return;
      const threadRef = db.collection("support_threads").doc(event.params.threadId);
      const thread = await threadRef.get();
      if (!thread.exists) return;
      const senderType = clean(message.senderType, 20);
      if (!["user", "support"].includes(senderType)) return;
      let shouldProcess = false;
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(event.data.ref);
        if (!current.exists || current.get("supportTriggerProcessedAt")) return;
        transaction.update(event.data.ref, { supportTriggerProcessedAt: FieldValue.serverTimestamp() });
        shouldProcess = true;
      });
      if (!shouldProcess) return;

      if (senderType === "user") {
        await threadRef.set({
          lastMessage: clean(message.text, 240),
          lastMessageBy: "user",
          humanRequested: true,
          status: "waiting",
          unreadBySupport: true,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await notifyAdmins({
          title: `${clean(thread.get("userRole"), 20) === "reelo" ? "Reelo" : "Customer"} support message waiting`,
          body: clean(message.text, 140) || "A user needs help.",
          data: { type: "support_thread", threadId: event.params.threadId, bookingId: clean(thread.get("bookingId"), 120), userRole: clean(thread.get("userRole"), 20) },
        });
        return;
      }

      if (senderType === "support") {
        await threadRef.set({
          lastMessage: clean(message.text, 240),
          lastMessageBy: "support",
          unreadBySupport: false,
          unreadByUser: true,
          status: "active",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        const userId = clean(thread.get("userId"), 128);
        await createNotification(userId, {
          title: "Reel It Support replied",
          body: clean(message.text, 140),
          type: "support_reply",
          bookingId: clean(thread.get("bookingId"), 120),
        });
      }
    });

    exports.onSupportThreadWritten = onDocumentWritten("support_threads/{threadId}", async (event) => {
      if (!event.data.after.exists || !event.data.before.exists) return;
      const before = event.data.before.data();
      const after = event.data.after.data();
      if (before.status === after.status || after.status !== "resolved") return;
      const threadRef = event.data.after.ref;
      await threadRef.collection("messages").add({
        senderId: "system",
        senderType: "system",
        text: "Thank you for contacting Reel It Support. This conversation is resolved. Please rate your experience or share additional feedback below. Start a new chat if you need help with something else.",
        createdAt: FieldValue.serverTimestamp(),
      });
      await createNotification(after.userId, {
        title: "Your support request is resolved",
        body: "Thank you for contacting us. Open the conversation to leave a rating or additional feedback.",
        type: "support_resolved",
        bookingId: clean(after.bookingId, 120),
      });
    });

    exports.requestHumanSupport = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to contact Support.");
      const threadId = clean(request.data && request.data.threadId, 180);
      const threadRef = db.collection("support_threads").doc(threadId);
      const thread = await threadRef.get();
      if (!thread.exists || thread.get("userId") !== request.auth.uid) {
        throw new HttpsError("permission-denied", "This support conversation is not yours.");
      }
      if (thread.get("humanRequested") === true && ["waiting", "active", "needs_human"].includes(clean(thread.get("status"), 30))) {
        return { requested: true };
      }

      const booking = await supportBooking(thread);
      const role = clean(thread.get("userRole"), 20) || "customer";
      const summary = booking
        ? `${role === "reelo" ? "Reelo" : "Customer"} requested human help for booking ${booking.id}. Current state: ${readableBookingStatus(booking)}. Last topic: ${clean(thread.get("lastIntent"), 60) || "general"}.`
        : `${role === "reelo" ? "Reelo" : "Customer"} requested general human support. Last topic: ${clean(thread.get("lastIntent"), 60) || "general"}.`;

      await threadRef.set({
        humanRequested: true,
        status: "waiting",
        unreadBySupport: true,
        assistantSummary: summary,
        ...(booking && !clean(thread.get("bookingId"), 120) ? { bookingId: booking.id, bookingOccasion: clean(booking.occasion, 80) } : {}),
        humanRequestedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await threadRef.collection("messages").add({
        senderId: "system",
        senderType: "system",
        text: booking
          ? `A human support case is now open and linked to booking ${publicBookingRef(booking.id)}. Reel It Operations will reply in this conversation.`
          : "A human support case is now open. Reel It Operations will reply in this conversation.",
        createdAt: FieldValue.serverTimestamp(),
      });
      await notifyAdmins({
        title: `${role === "reelo" ? "Reelo" : "Customer"} human support requested`,
        body: booking ? `${clean(thread.get("userEmail"), 100) || "A user"} · ${publicBookingRef(booking.id)} · ${readableBookingStatus(booking)}` : clean(thread.get("userEmail"), 100) || "A user needs help.",
        data: {
          type: "support_thread",
          threadId,
          bookingId: booking ? booking.id : "",
          userRole: role,
        },
      });
      return { requested: true };
    });

    exports.onReviewWritten = onDocumentWritten("reviews/{reviewId}", async (event) => {
      const source = event.data.after.exists ? event.data.after.data() : event.data.before.data();
      const reeloId = clean(source && source.reeloId, 128);
      if (!reeloId) return;
      const deletion = await db.collection("account_deletion_requests").doc(reeloId).get();
      if (deletion.exists && ["processing", "completed"].includes(deletion.get("status"))) return;
      const reviews = await db.collection("reviews").where("reeloId", "==", reeloId).get();
      let total = 0;
      reviews.docs.forEach((doc) => { total += Number(doc.get("rating")) || 0; });
      const aggregate = { rating: reviews.size ? Number((total / reviews.size).toFixed(2)) : 0, totalReviews: reviews.size, ratingUpdatedAt: FieldValue.serverTimestamp() };
      await Promise.all([
        db.collection("reelo_profiles").doc(reeloId).set(aggregate, { merge: true }),
        db.collection("users").doc(reeloId).set(aggregate, { merge: true }),
      ]);
    });

    exports.validateCoupon = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to apply a coupon.");
      const code = clean(request.data && request.data.code, 40).toUpperCase();
      const durationMinutes = Number(request.data && request.data.durationMinutes);
      const deliveryType = clean(request.data && request.data.deliveryType || 'originals', 20);
      const price = PRICES[deliveryType] && PRICES[deliveryType][durationMinutes];
      if (!code) throw new HttpsError("invalid-argument", "Enter a coupon code.");
      if (!price) throw new HttpsError("invalid-argument", "Choose a supported booking duration.");
      const couponSnap = await db.collection("coupons").doc(code).get();
      if (!couponSnap.exists) throw new HttpsError("not-found", "This coupon code is not valid.");
      const c = couponSnap.data();
      if (c.active !== true) throw new HttpsError("failed-precondition", "This coupon is not active.");
      const now = Date.now();
      if (c.startsAt && c.startsAt.toMillis() > now) throw new HttpsError("failed-precondition", "This coupon is not active yet.");
      if (c.endsAt && c.endsAt.toMillis() < now) throw new HttpsError("failed-precondition", "This coupon has expired.");
      const maxRedemptions = Number(c.maxRedemptions || 0), redemptionCount = Number(c.redemptionCount || 0);
      if (maxRedemptions > 0 && redemptionCount >= maxRedemptions) throw new HttpsError("resource-exhausted", "This coupon has reached its redemption limit.");
      const eligibleTypes = Array.isArray(c.deliveryTypes) ? c.deliveryTypes : [];
      const eligibleDurations = Array.isArray(c.durationMinutes) ? c.durationMinutes.map(Number) : [];
      if (eligibleTypes.length && !eligibleTypes.includes(deliveryType)) throw new HttpsError("failed-precondition", "This coupon does not apply to this service.");
      if (eligibleDurations.length && !eligibleDurations.includes(durationMinutes)) throw new HttpsError("failed-precondition", "This coupon does not apply to this booking duration.");
      const redemption = await couponSnap.ref.collection("redemptions").doc(request.auth.uid).get();
      const perCustomer = Math.max(1, Number(c.maxUsesPerCustomer || 1));
      if (redemption.exists && Number(redemption.get("count") || 0) >= perCustomer) throw new HttpsError("failed-precondition", "You have already used this coupon.");
      let discountAmount = clean(c.discountType, 20) === "percent" ? Math.round(price * Math.min(100, Math.max(0, Number(c.discountValue || 0))) / 100) : clean(c.discountType, 20) === "flat" ? Math.round(Math.max(0, Number(c.discountValue || 0))) : 0;
      discountAmount = Math.min(price - 1, discountAmount);
      if (discountAmount <= 0) throw new HttpsError("failed-precondition", "This coupon has no valid discount.");
      return { code, listPrice: price, discountAmount, customerPrice: price - discountAmount };
    });

    exports.createRazorpayOrder = onCall({ secrets: [razorpayKeyId, razorpayKeySecret], invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before paying.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const ref = db.collection("bookings").doc(bookingId);
      const snapshot = await ref.get();
      if (!snapshot.exists) throw new HttpsError("not-found", "Booking not found.");
      let booking = snapshot.data();
      if (booking.customerId !== request.auth.uid) throw new HttpsError("permission-denied", "Only the customer can pay.");
      if (booking.status !== "payment_pending") throw new HttpsError("failed-precondition", "This booking is not awaiting payment.");
      const price = bookingPrice(booking);
      if (booking.razorpayOrderId && booking.paymentStatus === "order_created") {
        return {
          orderId: booking.razorpayOrderId,
          amount: Number(booking.razorpayOrderAmount) || bookingChargePrice(booking) * 100,
          currency: "INR",
          keyId: razorpayKeyId.value(),
          discountApplied: Number(booking.discountAmount || 0) > 0,
          discountAmount: Number(booking.discountAmount) || 0,
        };
      }

      const couponCode = clean(booking.promotionCode, 40).toUpperCase();
      let chargePrice = price;
      let discountAmount = 0;
      if (couponCode) {
        const couponRef = db.collection("coupons").doc(couponCode);
        const redemptionRef = couponRef.collection("redemptions").doc(request.auth.uid);
        await db.runTransaction(async (transaction) => {
          const freshBooking = await transaction.get(ref), coupon = await transaction.get(couponRef), redemption = await transaction.get(redemptionRef);
          if (!freshBooking.exists || freshBooking.get("status") !== "payment_pending") throw new HttpsError("failed-precondition", "This booking is not awaiting payment.");
          if (!coupon.exists) throw new HttpsError("not-found", "This coupon code is not valid.");
          const c = coupon.data(), now = Date.now();
          if (c.active !== true || (c.startsAt && c.startsAt.toMillis() > now) || (c.endsAt && c.endsAt.toMillis() < now)) throw new HttpsError("failed-precondition", "This coupon is not currently active.");
          const maxRedemptions = Number(c.maxRedemptions || 0), redemptionCount = Number(c.redemptionCount || 0);
          if (maxRedemptions > 0 && redemptionCount >= maxRedemptions) throw new HttpsError("resource-exhausted", "This coupon has reached its redemption limit.");
          const perCustomer = Math.max(1, Number(c.maxUsesPerCustomer || 1));
          if (redemption.exists && Number(redemption.get("count") || 0) >= perCustomer) throw new HttpsError("failed-precondition", "You have already used this coupon.");
          const eligibleTypes = Array.isArray(c.deliveryTypes) ? c.deliveryTypes : [], eligibleDurations = Array.isArray(c.durationMinutes) ? c.durationMinutes.map(Number) : [];
          if (eligibleTypes.length && !eligibleTypes.includes(clean(freshBooking.get("deliveryType") || "originals", 20))) throw new HttpsError("failed-precondition", "This coupon does not apply to this service.");
          if (eligibleDurations.length && !eligibleDurations.includes(Number(freshBooking.get("durationMinutes")))) throw new HttpsError("failed-precondition", "This coupon does not apply to this booking duration.");
          discountAmount = clean(c.discountType, 20) === "percent" ? Math.round(price * Math.min(100, Math.max(0, Number(c.discountValue || 0))) / 100) : clean(c.discountType, 20) === "flat" ? Math.round(Math.max(0, Number(c.discountValue || 0))) : 0;
          discountAmount = Math.min(price - 1, discountAmount);
          if (discountAmount <= 0) throw new HttpsError("failed-precondition", "This coupon has no valid discount.");
          chargePrice = price - discountAmount;
          const earnings = reeloEarning(freshBooking.data());
          transaction.update(ref, { listPrice: price, customerPrice: chargePrice, price: chargePrice, discountAmount, promotionCode: couponCode, promotionStatus: "reserved", platformFee: chargePrice - earnings, reeloEarnings: earnings, promotionUpdatedAt: FieldValue.serverTimestamp() });
        });
        booking = (await ref.get()).data();
      }
      let order;
      try {
        order = await razorpay("/v1/orders", { method: "POST", body: { amount: chargePrice * 100, currency: "INR", receipt: bookingId.slice(0, 40), notes: { bookingId, customerId: request.auth.uid, promotionCode: discountAmount > 0 ? couponCode : "" } } });
      } catch (error) {
        console.error("createRazorpayOrder", error.message);
        throw new HttpsError("internal", "Could not create the payment order. Please try again.");
      }
      const earnings = reeloEarning(booking);
      await ref.update({ listPrice: price, customerPrice: chargePrice, price: chargePrice, discountAmount, platformFee: chargePrice - earnings, reeloEarnings: earnings, razorpayOrderId: order.id, razorpayOrderAmount: order.amount, paymentStatus: "order_created", paymentUpdatedAt: FieldValue.serverTimestamp() });
      return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: razorpayKeyId.value(), discountApplied: discountAmount > 0, discountAmount };
    });

    exports.verifyRazorpayPayment = onCall({ secrets: [razorpayKeyId, razorpayKeySecret], invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before verifying payment.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const orderId = clean(request.data && request.data.orderId, 120);
      const paymentId = clean(request.data && request.data.paymentId, 120);
      const signature = clean(request.data && request.data.signature, 256);
      const snapshot = await db.collection("bookings").doc(bookingId).get();
      if (!snapshot.exists || snapshot.get("customerId") !== request.auth.uid || snapshot.get("razorpayOrderId") !== orderId) throw new HttpsError("permission-denied", "Payment does not match this booking.");
      const expected = crypto.createHmac("sha256", razorpayKeySecret.value()).update(`${orderId}|${paymentId}`).digest("hex");
      if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new HttpsError("permission-denied", "Payment signature is invalid.");
      if (snapshot.get("status") !== "payment_pending") {
        if (snapshot.get("paymentStatus") === "captured" && snapshot.get("paymentReference") === paymentId) {
          return { verified: true };
        }
        throw new HttpsError("failed-precondition", "This booking is no longer awaiting payment.");
      }
      let payment;
      try {
        payment = await razorpay(`/v1/payments/${encodeURIComponent(paymentId)}`);
        if (payment.status === "authorized") {
          payment = await razorpay(`/v1/payments/${encodeURIComponent(paymentId)}/capture`, {
            method: "POST",
            body: { amount: bookingChargePrice(snapshot.data()) * 100, currency: "INR" },
          });
        }
      } catch (error) {
        console.error("verifyRazorpayPayment", error.message);
        throw new HttpsError("failed-precondition", "Payment could not be confirmed by the provider.");
      }
      const expectedAmount = bookingChargePrice(snapshot.data()) * 100;
      if (payment.order_id !== orderId || Number(payment.amount) !== expectedAmount || payment.currency !== "INR" || payment.status !== "captured") {
        throw new HttpsError("failed-precondition", "Payment is not captured yet. No booking was started.");
      }
      const updates = { paymentStatus: "captured", paymentReference: paymentId, paymentVerifiedAt: FieldValue.serverTimestamp(), paymentCapturedAt: FieldValue.serverTimestamp(), paymentUpdatedAt: FieldValue.serverTimestamp(), status: "searching", updatedAt: FieldValue.serverTimestamp() };
      if (snapshot.get("timingType") === "now") updates.requestExpiresAt = Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(snapshot.ref);
        if (!fresh.exists || fresh.get("customerId") !== request.auth.uid) {
          throw new HttpsError("permission-denied", "Payment does not match this booking.");
        }
        if (fresh.get("status") !== "payment_pending") {
          if (fresh.get("paymentStatus") === "captured" && fresh.get("paymentReference") === paymentId) return;
          throw new HttpsError("failed-precondition", "This booking is no longer awaiting payment.");
        }
        transaction.update(snapshot.ref, updates);
        const promotionCode = clean(fresh.get("promotionCode"), 40).toUpperCase();
        if (promotionCode && Number(fresh.get("discountAmount") || 0) > 0) {
          const couponRef = db.collection("coupons").doc(promotionCode), redemptionRef = couponRef.collection("redemptions").doc(request.auth.uid);
          const coupon = await transaction.get(couponRef), redemption = await transaction.get(redemptionRef);
          if (coupon.exists) {
            transaction.set(redemptionRef, { customerId: request.auth.uid, count: Number(redemption.exists ? redemption.get("count") : 0) + 1, lastBookingId: bookingId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
            transaction.update(couponRef, { redemptionCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
          }
          transaction.update(snapshot.ref, { promotionStatus: "redeemed", promotionRedeemedAt: FieldValue.serverTimestamp() });
        }
      });
      return { verified: true };
    });

    exports.requestSessionExtension = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before requesting extra time.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const minutes = Number(request.data && request.data.minutes);
      if (![30, 60, 90].includes(minutes)) throw new HttpsError("invalid-argument", "Choose the upgrade offered for this session.");
      const ref = db.collection("bookings").doc(bookingId);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
        const booking = snap.data();
        if (booking.customerId !== request.auth.uid) throw new HttpsError("permission-denied", "Only the customer can request extra session time.");
        if (booking.status !== "in_progress" || !booking.reeloId) throw new HttpsError("failed-precondition", "Extra time can only be requested during an active session.");
        if (["requested", "accepted_awaiting_payment", "order_created"].includes(clean(booking.extensionStatus, 40))) {
          throw new HttpsError("failed-precondition", "Finish the current extension request first.");
        }
        const price = extensionPrice(booking, minutes);
        tx.update(ref, {
          extensionStatus: "requested",
          extensionMinutes: minutes,
          extensionPrice: price,
          extensionRequestedAt: FieldValue.serverTimestamp(),
          extensionRequestedBy: request.auth.uid,
          extensionRazorpayOrderId: FieldValue.delete(),
          extensionPaymentReference: FieldValue.delete(),
          extensionPaymentSignature: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { reeloId: booking.reeloId, price };
      });
      await createNotification(result.reeloId, {
        title: "Extra time requested",
        body: `The customer requested a paid session upgrade (+${minutes} minutes). Accept only if you can stay longer.`,
        type: "session_extension_requested",
        bookingId,
      });
      return { requested: true, minutes, price: result.price };
    });

    exports.respondSessionExtension = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before responding to extra time.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const accept = request.data && request.data.accept === true;
      const ref = db.collection("bookings").doc(bookingId);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
        const booking = snap.data();
        if (booking.reeloId !== request.auth.uid) throw new HttpsError("permission-denied", "Only the assigned Reelo can respond.");
        if (booking.status !== "in_progress" || booking.extensionStatus !== "requested") {
          throw new HttpsError("failed-precondition", "This extension request is no longer waiting for your response.");
        }
        tx.update(ref, {
          extensionStatus: accept ? "accepted_awaiting_payment" : "declined",
          extensionRespondedAt: FieldValue.serverTimestamp(),
          extensionRespondedBy: request.auth.uid,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { customerId: booking.customerId, minutes: Number(booking.extensionMinutes) || 0, price: Number(booking.extensionPrice) || 0 };
      });
      await createNotification(result.customerId, {
        title: accept ? "Extra time approved" : "Extra time unavailable",
        body: accept ? `Your Reelo can stay +${result.minutes} minutes. Complete the ₹${result.price} in-app payment to activate it.` : "Your Reelo cannot extend this session right now.",
        type: accept ? "session_extension_accepted" : "session_extension_declined",
        bookingId,
      });
      return { accepted: accept };
    });

    exports.createSessionExtensionOrder = onCall({ secrets: [razorpayKeyId, razorpayKeySecret], invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before paying for extra time.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const ref = db.collection("bookings").doc(bookingId);
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
      const booking = snap.data();
      if (booking.customerId !== request.auth.uid) throw new HttpsError("permission-denied", "Only the customer can pay for extra time.");
      if (booking.status !== "in_progress" || !["accepted_awaiting_payment", "order_created"].includes(clean(booking.extensionStatus, 40))) {
        throw new HttpsError("failed-precondition", "Your Reelo must accept the extension before payment.");
      }
      const minutes = Number(booking.extensionMinutes);
      const price = extensionPrice(booking, minutes);
      if (booking.extensionRazorpayOrderId && booking.extensionStatus === "order_created") {
        return { orderId: booking.extensionRazorpayOrderId, amount: Number(booking.extensionRazorpayOrderAmount) || price * 100, currency: "INR", keyId: razorpayKeyId.value() };
      }
      let order;
      try {
        order = await razorpay("/v1/orders", {
          method: "POST",
          body: {
            amount: price * 100,
            currency: "INR",
            receipt: `ext_${bookingId}`.slice(0, 40),
            notes: { bookingId, customerId: request.auth.uid, purpose: "session_extension", minutes: String(minutes) },
          },
        });
      } catch (error) {
        console.error("createSessionExtensionOrder", error.message);
        throw new HttpsError("internal", "Could not create the extension payment order. Please try again.");
      }
      await ref.update({
        extensionStatus: "order_created",
        extensionRazorpayOrderId: order.id,
        extensionRazorpayOrderAmount: order.amount,
        extensionPaymentUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: razorpayKeyId.value() };
    });

    exports.verifySessionExtensionPayment = onCall({ secrets: [razorpayKeyId, razorpayKeySecret], invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before verifying extra-time payment.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const orderId = clean(request.data && request.data.orderId, 120);
      const paymentId = clean(request.data && request.data.paymentId, 120);
      const signature = clean(request.data && request.data.signature, 256);
      const ref = db.collection("bookings").doc(bookingId);
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
      const booking = snap.data();
      if (booking.customerId !== request.auth.uid || clean(booking.extensionRazorpayOrderId, 120) !== orderId) {
        throw new HttpsError("permission-denied", "This extension payment does not match the booking.");
      }
      if (booking.extensionStatus === "paid" && clean(booking.extensionPaymentReference, 120) === paymentId) return { verified: true };
      if (booking.status !== "in_progress" || booking.extensionStatus !== "order_created") {
        throw new HttpsError("failed-precondition", "This extension is no longer awaiting payment.");
      }
      const expected = crypto.createHmac("sha256", razorpayKeySecret.value()).update(`${orderId}|${paymentId}`).digest("hex");
      if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        throw new HttpsError("permission-denied", "Payment signature is invalid.");
      }
      const minutes = Number(booking.extensionMinutes);
      const price = extensionPrice(booking, minutes);
      let payment;
      try {
        payment = await razorpay(`/v1/payments/${encodeURIComponent(paymentId)}`);
        if (payment.status === "authorized") {
          payment = await razorpay(`/v1/payments/${encodeURIComponent(paymentId)}/capture`, { method: "POST", body: { amount: price * 100, currency: "INR" } });
        }
      } catch (error) {
        console.error("verifySessionExtensionPayment", error.message);
        throw new HttpsError("failed-precondition", "The extra-time payment could not be confirmed by the provider.");
      }
      if (payment.order_id !== orderId || Number(payment.amount) !== price * 100 || payment.currency !== "INR" || payment.status !== "captured") {
        throw new HttpsError("failed-precondition", "Extra-time payment is not captured yet.");
      }
      const earning = extensionReeloEarning(price);
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists || fresh.get("customerId") !== request.auth.uid) throw new HttpsError("permission-denied", "Booking changed during payment.");
        if (fresh.get("extensionStatus") === "paid" && clean(fresh.get("extensionPaymentReference"), 120) === paymentId) return;
        if (fresh.get("status") !== "in_progress" || fresh.get("extensionStatus") !== "order_created" || clean(fresh.get("extensionRazorpayOrderId"), 120) !== orderId) {
          throw new HttpsError("failed-precondition", "This extension is no longer awaiting payment.");
        }
        tx.update(ref, {
          extensionStatus: "paid",
          extensionPaymentReference: paymentId,
          extensionPaymentSignature: signature,
          extensionPaidAt: FieldValue.serverTimestamp(),
          totalExtensionMinutes: FieldValue.increment(minutes),
          extensionTotalPaid: FieldValue.increment(price),
          extensionTotalReeloEarnings: FieldValue.increment(earning),
          reeloEarnings: FieldValue.increment(earning),
          platformFee: FieldValue.increment(price - earning),
          sessionFiveMinuteWarningSent: false,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      await createNotification(booking.reeloId, { title: "Session extended", body: `Payment confirmed. The booking is extended by ${minutes} minutes.`, type: "session_extended", bookingId });
      await createNotification(booking.customerId, { title: "Session extended", body: `Your +${minutes} minute extension is active.`, type: "session_extended", bookingId });
      return { verified: true, minutes, price, reeloEarning: earning };
    });

    exports.warnSessionsEndingSoon = onSchedule({ schedule: "every 5 minutes" }, async () => {
      const active = await db.collection("bookings").where("status", "==", "in_progress").limit(200).get();
      const now = Date.now();
      for (const doc of active.docs) {
        const booking = doc.data();
        const startedAt = booking.startedAt;
        if (!startedAt || booking.sessionFiveMinuteWarningSent === true) continue;
        const totalMinutes = Number(booking.durationMinutes || 0) + Number(booking.totalExtensionMinutes || 0);
        if (totalMinutes <= 0) continue;
        const remaining = startedAt.toMillis() + totalMinutes * 60 * 1000 - now;
        if (remaining <= 10 * 60 * 1000 && remaining > 0) {
          await doc.ref.set({ sessionFiveMinuteWarningSent: true, sessionFiveMinuteWarningSentAt: FieldValue.serverTimestamp() }, { merge: true });
          await Promise.all([
            createNotification(booking.customerId, { title: "Session ending soon", body: "Need more time? Request the available session upgrade before the booking ends.", type: "session_five_minute_warning", bookingId: doc.id }),
            createNotification(booking.reeloId, { title: "Session ending soon", body: "The customer can request the available paid upgrade. Accept only if you can stay longer.", type: "session_five_minute_warning", bookingId: doc.id }),
          ]);
        }
      }
    });

    exports.endExpiredSessions = onSchedule({ schedule: "every 1 minutes" }, async () => {
      const active = await db.collection("bookings").where("status", "==", "in_progress").limit(200).get();
      for (const doc of active.docs) {
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists) return;
          const b = fresh.data();
          if (b.status !== "in_progress" || !b.startedAt) return;
          const totalMinutes = Number(b.durationMinutes || 0) + Number(b.totalExtensionMinutes || 0);
          const now = Date.now();
          if (totalMinutes <= 0 || now < b.startedAt.toMillis() + totalMinutes * 60 * 1000) return;
          const captureDevice = clean(b.captureDeviceResolved, 40);
          if (!["customer_device", "reelo_equipment"].includes(captureDevice)) return;
          const customerDevice = captureDevice === "customer_device";
          const edited = clean(b.deliveryType || "originals", 20) === "edited";
          const hours = edited ? 48 : 24;
          let deliveryStatus;
          let deliveryDueAt = null;
          let earningsEligibleAt = null;
          let deliveryConfirmedAt = null;
          let payoutStatus = b.payoutStatus === "review_required" ? "review_required" : "pending_delivery";
          if (customerDevice && !edited) {
            deliveryStatus = "customer_device_completed";
            earningsEligibleAt = Timestamp.fromMillis(now + 48 * 60 * 60 * 1000);
            deliveryConfirmedAt = FieldValue.serverTimestamp();
            payoutStatus = b.payoutStatus === "review_required" ? "review_required" : "available";
          } else if (customerDevice && edited) {
            deliveryStatus = "awaiting_customer_upload";
          } else {
            deliveryStatus = "pending_upload";
            deliveryDueAt = Timestamp.fromMillis(now + hours * 60 * 60 * 1000);
          }
          tx.update(doc.ref, {
            status: "completed", deliveryStatus, deliveryDueAt,
            completedAt: FieldValue.serverTimestamp(), sessionEndedAutomatically: true,
            footageTransferConfirmed: customerDevice && !edited, localDeletionConfirmed: customerDevice && !edited,
            contentExpiresAt: null, contentExpired: false, payoutStatus, earningsEligibleAt, deliveryConfirmedAt,
            updatedAt: FieldValue.serverTimestamp(),
          });
          if (b.reeloId) tx.set(db.collection("reelo_profiles").doc(b.reeloId), { availability: "Online", availableSince: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        });
      }
    });

    exports.cancelBooking = onCall({ secrets: [razorpayKeyId, razorpayKeySecret], invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before cancelling.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const ref = db.collection("bookings").doc(bookingId);
      let booking;
      let alreadyCancelled = false;
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new HttpsError("not-found", "Booking not found.");
        booking = snapshot.data();
        if (booking.customerId !== request.auth.uid) throw new HttpsError("permission-denied", "Only the customer can cancel.");
        if (booking.status === "cancelled") {
          alreadyCancelled = true;
          return;
        }
        if (booking.status === "cancellation_processing") {
          throw new HttpsError("aborted", "Cancellation is already processing.");
        }
        if (["completed", "in_progress"].includes(booking.status)) throw new HttpsError("failed-precondition", "An active or completed session cannot be cancelled here.");
        if (["on_the_way", "arriving_soon", "arrived"].includes(booking.travelStatus) || booking.status === "arrived") throw new HttpsError("failed-precondition", "Free cancellation ended because the Reelo is travelling. Contact Safety Support.");
        if (booking.status === "accepted" && booking.profileReviewEndsAt && booking.profileReviewEndsAt.toMillis() < Date.now()) throw new HttpsError("failed-precondition", "The 10-minute review window ended. Contact Support.");
        transaction.update(ref, {
          status: "cancellation_processing",
          cancellationLockedAt: FieldValue.serverTimestamp(),
          refundStatus: booking.paymentReference ? "starting" : "not_required",
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      if (alreadyCancelled) {
        return { cancelled: true, refundStatus: booking.refundStatus || "not_required" };
      }

      let refundStatus = "not_required";
      let refundReference = null;
      let refundFailureReason = null;
      const paymentReference = clean(booking.paymentReference, 120);
      if (paymentReference && ["signature_verified", "captured", "paid"].includes(booking.paymentStatus)) {
        try {
          const refund = await razorpay(`/v1/payments/${encodeURIComponent(paymentReference)}/refund`, { method: "POST", body: { amount: bookingChargePrice(booking) * 100, speed: "normal", notes: { bookingId, reason: "eligible_customer_cancellation" } } });
          refundStatus = refund.status || "processing";
          refundReference = refund.id || null;
        } catch (error) {
          refundStatus = "manual_review_required";
          refundFailureReason = clean(error.message, 240);
          await notifyAdmins({ title: "Refund needs review", body: `Booking ${bookingId}: ${refundFailureReason}`, data: { type: "refund_review", bookingId } });
        }
      }
      await ref.update({ status: "cancelled", cancelledBy: "customer", cancelledAt: FieldValue.serverTimestamp(), refundStatus, refundAmount: bookingChargePrice(booking), ...(refundReference ? { refundReference } : {}), ...(refundFailureReason ? { refundFailureReason } : {}), updatedAt: FieldValue.serverTimestamp() });
      if (booking.reeloId) await db.collection("reelo_profiles").doc(booking.reeloId).set({ availability: "Online", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { cancelled: true, refundStatus, refundReference };
    });

    exports.finalizeCustomerRawUpload = onCall({ invoker: "public", enforceAppCheck: true, timeoutSeconds: 120 }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before uploading footage.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const ref = db.collection("bookings").doc(bookingId);
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
      const booking = snap.data();
      if (booking.customerId !== request.auth.uid) throw new HttpsError("permission-denied", "Only the customer can upload this raw footage.");
      if (booking.status !== "completed" || clean(booking.deliveryType, 20) !== "edited" || clean(booking.captureDeviceResolved, 40) !== "customer_device") {
        throw new HttpsError("failed-precondition", "Customer footage upload is only used for an Edited booking captured on the customer phone.");
      }
      if (booking.deliveryStatus === "pending_upload" && booking.customerRawUploadedAt) return { finalized: true };
      if (booking.deliveryStatus !== "awaiting_customer_upload") {
        throw new HttpsError("failed-precondition", "This booking is not waiting for customer footage.");
      }
      const media = await db.collection("booking_media").where("bookingId", "==", bookingId).get();
      const raw = media.docs.filter((doc) => doc.get("status") === "active" && doc.get("uploaderId") === request.auth.uid && doc.get("purpose") === "customer_raw");
      if (!raw.length) throw new HttpsError("failed-precondition", "Upload at least one raw photo or video first.");
      const bucket = getStorage().bucket();
      let verified = 0;
      for (const document of raw) {
        const path = clean(document.get("storagePath"), 500);
        if (!path.startsWith(`bookings/${bookingId}/uploads/${request.auth.uid}/`)) throw new HttpsError("failed-precondition", "An uploaded file has an invalid secure path.");
        const [exists] = await bucket.file(path).exists();
        if (!exists) throw new HttpsError("failed-precondition", "An uploaded file is missing. Upload it again.");
        verified += 1;
      }
      const dueAt = Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000);
      await ref.update({
        deliveryStatus: "pending_upload",
        deliveryDueAt: dueAt,
        customerRawUploadedAt: FieldValue.serverTimestamp(),
        customerRawFileCount: verified,
        payoutStatus: booking.payoutStatus === "review_required" ? "review_required" : "pending_delivery",
        updatedAt: FieldValue.serverTimestamp(),
      });
      await Promise.all([
        createNotification(booking.reeloId, { title: "Customer footage ready", body: "The raw footage is uploaded. Your 48-hour editing target starts now.", type: "customer_raw_uploaded", bookingId }),
        createNotification(booking.customerId, { title: "Footage uploaded", body: "Your Reelo can now begin editing. The 48-hour editing target has started.", type: "customer_raw_uploaded", bookingId }),
      ]);
      return { finalized: true, files: verified, deliveryDueAt: dueAt.toMillis() };
    });

    exports.confirmContentDelivery = onCall({ invoker: "public", enforceAppCheck: true }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before confirming delivery.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const ref = db.collection("bookings").doc(bookingId);
      const snapshot = await ref.get();
      if (!snapshot.exists) throw new HttpsError("not-found", "Booking not found.");
      const booking = snapshot.data();
      if (booking.customerId !== request.auth.uid) {
        throw new HttpsError("permission-denied", "Only the customer can confirm delivery.");
      }
      if (booking.deliveryStatus === "customer_confirmed") {
        return { confirmed: true };
      }
      if (booking.deliveryDisputed === true) {
        throw new HttpsError("failed-precondition", "This delivery has an open content dispute. Reel It Support must review it first.");
      }
      if (booking.status !== "completed" || booking.deliveryStatus !== "delivered" || booking.paymentStatus !== "captured") {
        throw new HttpsError("failed-precondition", "The Reelo must deliver the files first.");
      }
      await ref.update({
        deliveryStatus: "customer_confirmed",
        deliveryConfirmedAt: FieldValue.serverTimestamp(),
        earningsEligibleAt: Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { confirmed: true };
    });

    exports.openContentDispute = onCall({ invoker: "public", enforceAppCheck: true }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before reporting a delivery problem.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const ref = db.collection("bookings").doc(bookingId);
      const snapshot = await ref.get();
      if (!snapshot.exists || snapshot.get("customerId") !== request.auth.uid) {
        throw new HttpsError("permission-denied", "Only the customer can report this delivery.");
      }
      if (!["delivered", "customer_confirmed"].includes(snapshot.get("deliveryStatus"))) {
        throw new HttpsError("failed-precondition", "Content has not been delivered yet.");
      }
      await ref.set({ deliveryDisputed: true, deliveryDisputedAt: FieldValue.serverTimestamp(), payoutStatus: "review_required", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await notifyAdmins({ title: "Content delivery dispute", body: `Customer reported missing or incorrect content for booking ${bookingId}.`, data: { type: "content_dispute", bookingId } });
      return { disputed: true };
    });

    exports.resolveContentDispute = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      await requireAdmin(request);
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const action = clean(request.data && request.data.action, 40);
      if (!["request_reupload", "close_resolved"].includes(action)) throw new HttpsError("invalid-argument", "Choose a valid dispute resolution.");
      const ref = db.collection("bookings").doc(bookingId);
      const snapshot = await ref.get();
      if (!snapshot.exists || snapshot.get("deliveryDisputed") !== true) throw new HttpsError("failed-precondition", "This booking has no open content dispute.");
      const booking = snapshot.data();
      if (action === "request_reupload") {
        await ref.set({ deliveryDisputed: false, deliveryStatus: "uploading", contentExpiresAt: null, contentExpired: false, payoutStatus: "available", earningsEligibleAt: null, disputeResolution: "reupload_requested", disputeResolvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await createNotification(booking.reeloId, { title: "Content re-upload requested", body: "Reel It Support reviewed the delivery. Open the booking and complete the required package.", type: "content_reupload", bookingId });
        await createNotification(booking.customerId, { title: "Re-upload requested", body: "Reel It Support asked your Reelo to correct the delivery. Payout remains paused.", type: "content_dispute_update", bookingId });
      } else {
        await ref.set({ deliveryDisputed: false, payoutStatus: "available", disputeResolution: "resolved_by_owner", disputeResolvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await createNotification(booking.customerId, { title: "Content dispute resolved", body: "Reel It Support completed its review. Contact Support if you have new information.", type: "content_dispute_update", bookingId });
      }
      return { resolved: true, action };
    });

    async function writeAdminAudit({ request, action, targetType, targetId, reason = "", before = null, after = null }) {
      await db.collection("audit_logs").add({
        adminId: request.auth.uid,
        adminEmail: clean(request.auth.token && request.auth.token.email, 160),
        action,
        targetType,
        targetId,
        reason: clean(reason, 1000),
        before,
        after,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    exports.adminBookingAction = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      await requireAdmin(request);
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const action = clean(request.data && request.data.action, 60);
      const reason = clean(request.data && request.data.reason, 1000);
      const allowed = new Set(["notify_customer", "notify_reelo", "regenerate_arrival_code", "return_to_search", "force_end_session", "move_to_pending_delivery", "request_content_reupload", "flag_payment_review", "cancel_unpaid"]);
      if (!allowed.has(action)) throw new HttpsError("invalid-argument", "Choose a valid owner action.");
      if (["return_to_search", "force_end_session", "move_to_pending_delivery", "request_content_reupload", "flag_payment_review", "cancel_unpaid"].includes(action) && reason.length < 5) {
        throw new HttpsError("invalid-argument", "Add a short internal reason for this action.");
      }
      const ref = db.collection("bookings").doc(bookingId);
      const snapshot = await ref.get();
      if (!snapshot.exists) throw new HttpsError("not-found", "Booking not found.");
      const booking = snapshot.data();
      let after = {};
      if (action === "notify_customer") {
        await createNotification(booking.customerId, { title: "Reel It booking update", body: reason || "Open your booking for the latest status.", type: "owner_booking_update", bookingId });
      } else if (action === "notify_reelo") {
        if (!booking.reeloId) throw new HttpsError("failed-precondition", "No Reelo is assigned to this booking.");
        await createNotification(booking.reeloId, { title: "Action needed on your booking", body: reason || "Open the booking and update your status.", type: "owner_booking_update", bookingId });
      } else if (action === "regenerate_arrival_code") {
        if (!["accepted", "arrived"].includes(booking.status) || !booking.reeloId) throw new HttpsError("failed-precondition", "Arrival verification is not available in this booking state.");
        const code = String(crypto.randomInt(1000, 10000));
        await db.collection("booking_arrival_codes").doc(bookingId).set({ bookingId, customerId: booking.customerId, reeloId: booking.reeloId, code, createdAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000) });
        await createNotification(booking.customerId, { title: "New arrival code ready", body: "Open your booking to view the replacement 4-digit code. Share it only after meeting the correct Reelo.", type: "arrival_code_reset", bookingId });
      } else if (action === "return_to_search") {
        if (!["accepted", "arrived"].includes(booking.status)) throw new HttpsError("failed-precondition", "Only an accepted booking that has not started can return to matching.");
        after = { status: "searching", reeloId: null, reeloEmail: null, reeloName: null, reeloPhotoUrl: null, acceptedAt: null, arrivedAt: null, travelStatus: null, etaMinutes: null, requestExpiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000), operationalAttention: false, updatedAt: FieldValue.serverTimestamp() };
        await ref.update(after);
        if (booking.reeloId) await db.collection("reelo_profiles").doc(booking.reeloId).set({ availability: "Online", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await createNotification(booking.customerId, { title: "Finding another Reelo", body: "Reel It Support returned your booking to matching. Open the app for updates.", type: "booking_rematching", bookingId });
      } else if (action === "force_end_session" || action === "move_to_pending_delivery") {
        if (!["accepted", "arrived", "in_progress", "completed"].includes(booking.status) || !booking.reeloId) {
          throw new HttpsError("failed-precondition", "This booking cannot be moved to pending delivery from its current state.");
        }
        const deliveryType = clean(booking.deliveryType || "originals", 20);
        const hours = deliveryType === "edited" ? 48 : 24;
        const dueAt = booking.deliveryDueAt || Timestamp.fromMillis(Date.now() + hours * 60 * 60 * 1000);
        after = {
          status: "completed",
          deliveryStatus: booking.captureDeviceResolved === "customer_device"
            ? (deliveryType === "edited" ? "awaiting_customer_upload" : "customer_device_completed")
            : (["delivered", "customer_confirmed"].includes(booking.deliveryStatus) ? booking.deliveryStatus : "pending_upload"),
          deliveryDueAt: booking.captureDeviceResolved === "customer_device" ? null : dueAt,
          completedAt: booking.completedAt || FieldValue.serverTimestamp(),
          operationalAttention: false,
          operationalAttentionType: FieldValue.delete(),
          operationalAttentionReason: FieldValue.delete(),
          payoutStatus: booking.payoutStatus === "review_required" ? "review_required" : (booking.payoutStatus || "available"),
          earningsEligibleAt: booking.deliveryStatus === "customer_confirmed" ? booking.earningsEligibleAt : null,
          updatedAt: FieldValue.serverTimestamp(),
        };
        await ref.update(after);
        await db.collection("reelo_profiles").doc(booking.reeloId).set({
          availability: "Online",
          availableSince: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await createNotification(booking.customerId, {
          title: "Session complete",
          body: "Your Reelo has finished the session. Your content is now pending delivery.",
          type: "session_completed",
          bookingId,
        });
        await createNotification(booking.reeloId, {
          title: "Content delivery pending",
          body: `Upload the ${deliveryType === "edited" ? "edited" : "original"} package within ${hours} hours. You can continue accepting new jobs while delivery is pending.`,
          type: "content_pending",
          bookingId,
        });
      } else if (action === "request_content_reupload") {
        if (booking.status !== "completed") throw new HttpsError("failed-precondition", "The session must be completed before requesting content again.");
        after = { deliveryDisputed: false, deliveryStatus: "uploading", contentExpiresAt: null, contentExpired: false, payoutStatus: "review_required", earningsEligibleAt: null, disputeResolution: "owner_reupload_requested", disputeResolvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
        await ref.update(after);
        await createNotification(booking.reeloId, { title: "Content re-upload required", body: reason || "Reel It Support asked you to correct the delivery package.", type: "content_reupload", bookingId });
        await createNotification(booking.customerId, { title: "Content correction requested", body: "Payout remains paused while your Reelo corrects the delivery.", type: "content_dispute_update", bookingId });
      } else if (action === "flag_payment_review") {
        after = { operationalAttention: true, operationalAttentionType: "payment_review", operationalAttentionReason: reason, operationalAttentionAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
        await ref.update(after);
        await notifyAdmins({ title: "Payment review flagged", body: `Booking ${bookingId}: ${reason}`, data: { type: "payment_review", bookingId } });
      } else if (action === "cancel_unpaid") {
        if (!["pending", "failed", "order_created"].includes(booking.paymentStatus) || ["in_progress", "completed"].includes(booking.status)) throw new HttpsError("failed-precondition", "Only an unpaid booking that has not started can be cancelled here.");
        after = { status: "cancelled", cancelledBy: "owner", cancellationReason: reason, cancelledAt: FieldValue.serverTimestamp(), refundStatus: "not_required", updatedAt: FieldValue.serverTimestamp() };
        await ref.update(after);
      }
      await writeAdminAudit({ request, action: `BOOKING_${action.toUpperCase()}`, targetType: "booking", targetId: bookingId, reason, before: { status: booking.status, paymentStatus: booking.paymentStatus, deliveryStatus: booking.deliveryStatus }, after });
      return { completed: true, action };
    });

    exports.extendDeliveryDeadline = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      await requireAdmin(request);
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const hours = Number(request.data && request.data.hours);
      const reason = clean(request.data && request.data.reason, 1000);
      if (![12, 24].includes(hours)) throw new HttpsError("invalid-argument", "Choose a 12 or 24 hour delivery extension.");
      if (reason.length < 5) throw new HttpsError("invalid-argument", "Add a short internal reason for the extension.");
      const ref = db.collection("bookings").doc(bookingId);
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
      const booking = snap.data();
      if (booking.status !== "completed" || !booking.deliveryDueAt || ["delivered", "customer_confirmed", "customer_device_completed"].includes(clean(booking.deliveryStatus, 40))) {
        throw new HttpsError("failed-precondition", "This booking does not have an active delivery deadline.");
      }
      const oldDue = booking.deliveryDueAt;
      const newDue = Timestamp.fromMillis(oldDue.toMillis() + hours * 60 * 60 * 1000);
      const patch = {
        originalDeliveryDueAt: booking.originalDeliveryDueAt || oldDue,
        deliveryDueAt: newDue,
        deliveryDeadlineExtensionHours: FieldValue.increment(hours),
        deliveryDeadlineLastExtensionHours: hours,
        deliveryDeadlineExtendedAt: FieldValue.serverTimestamp(),
        deliveryDeadlineExtendedBy: request.auth.uid,
        deliveryDeadlineExtensionReason: reason,
        updatedAt: FieldValue.serverTimestamp(),
      };
      await ref.set(patch, { merge: true });
      const dueLabel = newDue.toDate().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
      await Promise.all([
        createNotification(booking.customerId, { title: "Delivery timeline updated", body: `Your Reelo needed some additional time to complete your content. Your updated delivery target is ${dueLabel}.`, type: "delivery_deadline_extended", bookingId }),
        createNotification(booking.reeloId, { title: `Delivery extended by ${hours} hours`, body: `Your updated delivery target is ${dueLabel}.`, type: "delivery_deadline_extended", bookingId }),
      ]);
      await writeAdminAudit({ request, action: "DELIVERY_DEADLINE_EXTENDED", targetType: "booking", targetId: bookingId, reason, before: { deliveryDueAt: oldDue }, after: { deliveryDueAt: newDue, hours } });
      return { extended: true, hours, deliveryDueAt: newDue.toMillis() };
    });

    exports.adminForceBookingStatus = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      await requireAdmin(request);
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const targetStatus = clean(request.data && request.data.targetStatus, 40);
      const reason = clean(request.data && request.data.reason, 1000);
      const allowed = new Set(["payment_pending", "searching", "accepted", "arrived", "in_progress", "completed", "cancelled"]);
      if (!allowed.has(targetStatus)) throw new HttpsError("invalid-argument", "Choose a valid booking status.");
      if (reason.length < 5) throw new HttpsError("invalid-argument", "Add a short reason for the override.");
      const ref = db.collection("bookings").doc(bookingId);
      const snap = await ref.get();
      if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
      const b = snap.data();
      if (["accepted", "arrived", "in_progress", "completed"].includes(targetStatus) && !b.reeloId) throw new HttpsError("failed-precondition", "Assign a Reelo before forcing this status.");
      const patch = { status: targetStatus, operationalAttention: false, updatedAt: FieldValue.serverTimestamp() };
      if (targetStatus === "searching") Object.assign(patch, { reeloId: null, reeloEmail: null, reeloName: null, reeloPhotoUrl: null, acceptedAt: null, arrivedAt: null, startedAt: null, travelStatus: null, etaMinutes: null, requestExpiresAt: Timestamp.fromMillis(Date.now()+10*60*1000) });
      if (targetStatus === "accepted") patch.acceptedAt = b.acceptedAt || FieldValue.serverTimestamp();
      if (targetStatus === "arrived") patch.arrivedAt = b.arrivedAt || FieldValue.serverTimestamp();
      if (targetStatus === "in_progress") Object.assign(patch, { startedAt: b.startedAt || FieldValue.serverTimestamp(), captureDeviceStatus: b.captureDeviceResolved ? "confirmed" : "awaiting_both" });
      if (targetStatus === "completed") {
        const customerDevice = b.captureDeviceResolved === "customer_device";
        const hours = clean(b.deliveryType,20)==="edited"?48:24;
        Object.assign(patch, { completedAt: b.completedAt || FieldValue.serverTimestamp(), deliveryStatus: customerDevice ? "customer_device_completed" : (["delivered","customer_confirmed"].includes(b.deliveryStatus)?b.deliveryStatus:"pending_upload"), deliveryDueAt: customerDevice ? null : (b.deliveryDueAt || Timestamp.fromMillis(Date.now()+hours*60*60*1000)) });
      }
      if (targetStatus === "cancelled") Object.assign(patch, { cancelledAt: FieldValue.serverTimestamp(), cancelledBy: "owner", cancellationReason: reason });
      await ref.set(patch,{merge:true});
      if (b.reeloId) {
        const busy = ["accepted","arrived","in_progress"].includes(targetStatus);
        await db.collection("reelo_profiles").doc(b.reeloId).set({ availability: busy ? "Busy" : "Online", updatedAt: FieldValue.serverTimestamp() }, { merge:true });
      }
      await writeAdminAudit({ request, action:"BOOKING_FORCE_STATUS", targetType:"booking", targetId:bookingId, reason, before:{status:b.status,deliveryStatus:b.deliveryStatus}, after:patch });
      return { completed:true, targetStatus };
    });

    exports.adminReviewReelo = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      await requireAdmin(request);
      const reeloId = clean(request.data && request.data.reeloId, 128);
      const decision = clean(request.data && request.data.decision, 40);
      const reason = clean(request.data && request.data.reason, 1000);
      if (!["approved", "resubmission_required"].includes(decision) || reason.length < 3) throw new HttpsError("invalid-argument", "Choose a decision and add a review note.");
      const reviewRef = db.collection("reelo_profile_reviews").doc(reeloId);
      const [review, profile] = await Promise.all([reviewRef.get(), db.collection("reelo_profiles").doc(reeloId).get()]);
      if (!review.exists) throw new HttpsError("not-found", "Reelo application not found.");
      if (decision === "approved" && (!profile.exists || profile.get("onboardingComplete") !== true || profile.get("trainingComplete") !== true || profile.get("phoneVerified") !== true)) throw new HttpsError("failed-precondition", "Onboarding, phone verification and training must be complete before approval.");
      const photoUrl = clean(review.get("profilePhotoUrl"), 1000);
      const batch = db.batch();
      batch.set(reviewRef, { status: decision, reviewNote: reason, reviewedBy: request.auth.uid, reviewedAt: FieldValue.serverTimestamp() }, { merge: true });
      batch.set(db.collection("reelo_profiles").doc(reeloId), { verified: decision === "approved", verificationStatus: decision, ...(decision === "approved" && photoUrl ? { photoUrl } : {}), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      batch.set(db.collection("users").doc(reeloId), { reeloProfileReviewStatus: decision, ...(decision === "approved" && photoUrl ? { photoUrl } : {}), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await batch.commit();
      await writeAdminAudit({ request, action: `REELO_${decision.toUpperCase()}`, targetType: "reelo", targetId: reeloId, reason });
      return { reviewed: true, decision };
    });

    exports.addOperationsNote = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      await requireAdmin(request);
      const targetType = clean(request.data && request.data.targetType, 40);
      const targetId = clean(request.data && request.data.targetId, 160);
      const note = clean(request.data && request.data.note, 2000);
      if (!new Set(["booking", "support", "reelo", "report"]).has(targetType) || !targetId || note.length < 2) throw new HttpsError("invalid-argument", "A valid target and internal note are required.");
      await db.collection("operations_notes").add({ targetType, targetId, note, adminId: request.auth.uid, adminEmail: clean(request.auth.token && request.auth.token.email, 160), createdAt: FieldValue.serverTimestamp() });
      await writeAdminAudit({ request, action: "INTERNAL_NOTE_ADDED", targetType, targetId, reason: note });
      return { saved: true };
    });

    exports.finalizeContentDelivery = onCall({ invoker: "public", enforceAppCheck: true, timeoutSeconds: 120 }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before delivering content.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      if (!bookingId) throw new HttpsError("invalid-argument", "A booking ID is required.");
      const ref = db.collection("bookings").doc(bookingId);
      const snapshot = await ref.get();
      if (!snapshot.exists) throw new HttpsError("not-found", "Booking not found.");
      const booking = snapshot.data();
      if (booking.reeloId !== request.auth.uid) throw new HttpsError("permission-denied", "Only the assigned Reelo can deliver these files.");
      if (booking.status !== "completed") throw new HttpsError("failed-precondition", "Complete the session before delivering content.");
      if (!["captured", "paid", "signature_verified"].includes(clean(booking.paymentStatus, 40))) {
        throw new HttpsError("failed-precondition", "The booking payment is not secured.");
      }
      const deliveryType = clean(booking.deliveryType || 'originals', 20);
      const required = CONTENT_PACKAGES[deliveryType] && CONTENT_PACKAGES[deliveryType][Number(booking.durationMinutes)];
      if (!required) throw new HttpsError("failed-precondition", "This booking does not have a valid content package.");
      const media = await db.collection("booking_media").where("bookingId", "==", bookingId).get();
      const active = media.docs.filter((doc) => doc.get("status") === "active" && doc.get("uploaderId") === request.auth.uid && doc.get("purpose") !== "customer_raw");
      let photos = 0;
      let reels = 0;
      const bucket = getStorage().bucket();
      const verifiedPaths = new Set();
      for (const document of active) {
        const path = clean(document.get("storagePath"), 500);
        if (!path.startsWith(`bookings/${bookingId}/uploads/${request.auth.uid}/`)) {
          throw new HttpsError("failed-precondition", "An uploaded file has an invalid secure path.");
        }
        if (verifiedPaths.has(path)) continue;
        verifiedPaths.add(path);
        const file = bucket.file(path);
        const [exists] = await file.exists();
        if (!exists) throw new HttpsError("failed-precondition", "An uploaded file is missing. Upload it again.");
        const [metadata] = await file.getMetadata();
        const contentType = clean(metadata.contentType, 100);
        if (document.get("type") === "photo" && contentType.startsWith("image/")) photos += 1;
        if (document.get("type") === "reel" && contentType.startsWith("video/")) reels += 1;
      }
      if (photos < required.photos || reels < required.reels) {
        throw new HttpsError("failed-precondition", `This package requires at least ${required.photos} photos and ${required.reels} reel${required.reels === 1 ? "" : "s"}.`);
      }
      const expiresAt = Timestamp.fromMillis(Date.now() + CONTENT_AVAILABILITY_MS);
      await ref.update({
        deliveryStatus: "delivered",
        rawFileCount: photos + reels,
        editedFileCount: photos,
        deliveredPhotoCount: photos,
        deliveredReelCount: reels,
        deliveredAt: FieldValue.serverTimestamp(),
        contentExpiresAt: expiresAt,
        contentExpired: false,
        contentExpiryReminder24Sent: false,
        contentExpiryReminder6Sent: false,
        footageTransferConfirmed: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      await db.collection("reelo_profiles").doc(request.auth.uid).set({
        availability: "Online",
        availableSince: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { delivered: true, photos, reels, contentExpiresAt: expiresAt.toMillis() };
    });

    exports.manageDeliveredContent = onSchedule({ schedule: "every 60 minutes", timeoutSeconds: 540 }, async () => {
      const now = Date.now();
      const upcoming = await db.collection("bookings")
        .where("contentExpiresAt", "<=", Timestamp.fromMillis(now + 25 * 60 * 60 * 1000))
        .limit(200).get();
      for (const document of upcoming.docs) {
        const booking = document.data();
        const expiresAt = booking.contentExpiresAt;
        if (!expiresAt || booking.contentExpired === true) continue;
        const remaining = expiresAt.toMillis() - now;
        if (remaining <= 0) {
          await getStorage().bucket().deleteFiles({ prefix: `bookings/${document.id}/uploads/`, force: true });
          const media = await db.collection("booking_media").where("bookingId", "==", document.id).get();
          const batch = db.batch();
          media.docs.forEach((item) => batch.set(item.ref, { status: "expired", deletedAt: FieldValue.serverTimestamp() }, { merge: true }));
          batch.set(document.ref, { contentExpired: true, contentExpiredAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          await batch.commit();
          await createNotification(booking.customerId, { title: "Content securely removed", body: "Your 72-hour Reel It download window ended and the uploaded files were deleted.", type: "content_expired", bookingId: document.id });
        } else if (remaining <= 6 * 60 * 60 * 1000 && booking.contentExpiryReminder6Sent !== true) {
          await document.ref.set({ contentExpiryReminder6Sent: true }, { merge: true });
          await createNotification(booking.customerId, { title: "6 hours left to download", body: "Save your Reel It photos and reels before the secure window closes.", type: "content_expiry_reminder", bookingId: document.id });
        } else if (remaining <= 24 * 60 * 60 * 1000 && booking.contentExpiryReminder24Sent !== true) {
          await document.ref.set({ contentExpiryReminder24Sent: true }, { merge: true });
          await createNotification(booking.customerId, { title: "24 hours left to download", body: "Your Reel It content will be securely deleted when the download window ends.", type: "content_expiry_reminder", bookingId: document.id });
        }
      }
    });

    exports.expireInstantBookings = onSchedule({
      schedule: "every 5 minutes",
      secrets: [razorpayKeyId, razorpayKeySecret],
    }, async () => {
      const searching = await db.collection("bookings")
        .where("status", "==", "searching")
        .limit(100)
        .get();
      const due = searching.docs.filter((doc) => {
        const expiresAt = doc.get("requestExpiresAt");
        return expiresAt && expiresAt.toMillis() <= Date.now();
      });
      for (const document of due) {
        let booking;
        let locked = false;
        await db.runTransaction(async (transaction) => {
          const current = await transaction.get(document.ref);
          if (!current.exists || current.get("status") !== "searching") return;
          const expiresAt = current.get("requestExpiresAt");
          if (!expiresAt || expiresAt.toMillis() > Date.now()) return;
          booking = current.data();
          locked = true;
          transaction.update(document.ref, {
            status: "cancellation_processing",
            cancellationLockedAt: FieldValue.serverTimestamp(),
            refundStatus: "starting",
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
        if (!locked) continue;
        let refundStatus = "not_required";
        let refundReference = null;
        let failureReason = null;
        if (booking.paymentStatus === "captured" && booking.paymentReference) {
          try {
            const refund = await razorpay(`/v1/payments/${encodeURIComponent(booking.paymentReference)}/refund`, {
              method: "POST",
              body: {
                amount: bookingChargePrice(booking) * 100,
                speed: "normal",
                notes: { bookingId: document.id, reason: "instant_request_expired" },
              },
            });
            refundStatus = refund.status || "processing";
            refundReference = refund.id || null;
          } catch (error) {
            refundStatus = "manual_review_required";
            failureReason = clean(error.message, 240);
            await notifyAdmins({
              title: "Expired booking refund needs review",
              body: `Booking ${document.id}: ${failureReason}`,
              data: { type: "refund_review", bookingId: document.id },
            });
          }
        }
        await document.ref.update({
          status: "cancelled",
          cancelledBy: "system_timeout",
          cancellationReason: "No Reelo accepted before the request expired.",
          cancelledAt: FieldValue.serverTimestamp(),
          refundStatus,
          refundAmount: bookingChargePrice(booking),
          ...(refundReference ? { refundReference } : {}),
          ...(failureReason ? { refundFailureReason: failureReason } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });

    exports.markReeloArrived = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before updating arrival.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      if (!bookingId) throw new HttpsError("invalid-argument", "A valid booking is required.");
      const bookingRef = db.collection("bookings").doc(bookingId);
      const codeRef = db.collection("booking_arrival_codes").doc(bookingId);
      const now = Date.now();
      const code = String(crypto.randomInt(1000, 10000));

      await db.runTransaction(async (transaction) => {
        const [snapshot, existingCodeSnapshot] = await Promise.all([
          transaction.get(bookingRef),
          transaction.get(codeRef),
        ]);
        if (!snapshot.exists) throw new HttpsError("not-found", "Booking not found.");
        const booking = snapshot.data();
        if (booking.reeloId !== request.auth.uid) {
          throw new HttpsError("permission-denied", "Only the assigned Reelo can mark arrival.");
        }
        if (!["accepted", "arrived"].includes(booking.status)) {
          throw new HttpsError("failed-precondition", "This booking cannot be marked arrived now.");
        }

        // Safe retry: if the first tap succeeded but the response was lost, keep the
        // existing valid code instead of failing or silently replacing the customer's code.
        if (booking.status === "arrived" && existingCodeSnapshot.exists) {
          const existing = existingCodeSnapshot.data();
          const expiresAt = existing.expiresAt;
          if (!expiresAt || expiresAt.toMillis() > now) return;
        }

        if (booking.status === "accepted") {
          transaction.update(bookingRef, {
            status: "arrived",
            travelStatus: "arrived",
            etaMinutes: 0,
            arrivalCodeVerified: false,
            arrivedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        transaction.set(codeRef, {
          bookingId,
          customerId: booking.customerId,
          reeloId: booking.reeloId,
          code,
          failedAttempts: 0,
          lockedUntil: null,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(now + 60 * 60 * 1000),
        });
      });
      return { arrived: true };
    });

    exports.verifyArrivalCode = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before starting a session.");
      const bookingId = clean(request.data && request.data.bookingId, 120);
      const code = clean(request.data && request.data.code, 4);
      if (!/^\d{4}$/.test(code)) throw new HttpsError("invalid-argument", "Enter the 4-digit customer code.");
      const bookingRef = db.collection("bookings").doc(bookingId);
      const codeRef = db.collection("booking_arrival_codes").doc(bookingId);
      const now = Date.now();

      const result = await db.runTransaction(async (transaction) => {
        const [bookingSnapshot, codeSnapshot] = await Promise.all([
          transaction.get(bookingRef),
          transaction.get(codeRef),
        ]);
        if (!bookingSnapshot.exists || !codeSnapshot.exists) {
          throw new HttpsError("failed-precondition", "The arrival code is unavailable. Ask the customer to refresh the booking.");
        }
        const booking = bookingSnapshot.data();
        const privateCode = codeSnapshot.data();
        if (booking.reeloId !== request.auth.uid || booking.status !== "arrived") {
          throw new HttpsError("permission-denied", "Only the arrived Reelo can verify this code.");
        }
        if (privateCode.expiresAt && privateCode.expiresAt.toMillis() < now) {
          throw new HttpsError("deadline-exceeded", "The arrival code expired. Tap I have arrived again to generate a new code.");
        }
        const lockedUntil = privateCode.lockedUntil;
        if (lockedUntil && lockedUntil.toMillis() > now) {
          return { status: "locked", retryAt: lockedUntil.toMillis() };
        }

        if (privateCode.code !== code) {
          const attempts = Math.max(0, Number(privateCode.failedAttempts) || 0) + 1;
          const lock = attempts >= 5;
          transaction.set(codeRef, {
            failedAttempts: lock ? 0 : attempts,
            lockedUntil: lock ? Timestamp.fromMillis(now + 10 * 60 * 1000) : null,
            lastFailedAttemptAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          return { status: lock ? "locked" : "incorrect", attemptsRemaining: lock ? 0 : 5 - attempts };
        }

        transaction.update(bookingRef, {
          status: "arrived",
          arrivalCodeVerified: true,
          arrivalCodeVerifiedAt: FieldValue.serverTimestamp(),
          captureDeviceStatus: "awaiting_both",
          captureDeviceCustomerChoice: null,
          captureDeviceReeloChoice: null,
          captureDeviceResolved: null,
          captureDeviceConfirmedAt: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.delete(codeRef);
        return { status: "verified" };
      });

      if (result.status === "locked") {
        throw new HttpsError("resource-exhausted", "Too many incorrect codes. Try again in 10 minutes.");
      }
      if (result.status === "incorrect") {
        throw new HttpsError("permission-denied", `That code is incorrect. ${result.attemptsRemaining} attempts remaining.`);
      }
      return { verified: true };
    });

    async function ensureContact(uid) {
      const payoutRef = db.collection("reelo_payout_profiles").doc(uid);
      const current = await payoutRef.get();
      const existing = current.exists ? clean(current.get("razorpayContactId"), 120) : "";
      if (existing) return { contactId: existing, payoutRef };
      const user = (await db.collection("users").doc(uid).get()).data() || {};
      const profile = (await db.collection("reelo_profiles").doc(uid).get()).data() || {};
      if (profile.onboardingComplete !== true || profile.trainingComplete !== true) throw new HttpsError("failed-precondition", "Complete Reelo onboarding first.");
      const name = clean(profile.name || user.name, 100);
      const email = clean(user.email || profile.email, 100);
      const phone = clean(user.phone || profile.phone, 20);
      if (!name || !phone) throw new HttpsError("failed-precondition", "A verified name and phone number are required.");
      let contact;
      try {
        contact = await razorpay("/v1/contacts", {
          method: "POST",
          keyId: razorpayXKeyId.value(),
          keySecret: razorpayXKeySecret.value(),
          body: { name, email, contact: phone, type: "vendor", reference_id: `reelo_${uid}`.slice(0, 40), notes: { reeloId: uid } },
        });
      } catch (error) {
        console.error("ensureContact", error.message);
        throw new HttpsError("failed-precondition", "Automatic payouts are not activated yet. Contact Reel It support.");
      }
      await payoutRef.set({ reeloId: uid, razorpayContactId: contact.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { contactId: contact.id, payoutRef };
    }

    function maskVpa(vpa) {
      const [name, handle] = vpa.split("@");
      const visible = name.slice(0, Math.min(2, name.length));
      return `${visible}${"•".repeat(Math.max(3, name.length - visible.length))}@${handle}`;
    }

    // ============================================================
    // RAZORPAYX PAYOUTS
    // Disabled for the current Reel It test build.
    // Customer payments continue to use normal Razorpay Test Mode.
    // ============================================================

    function payoutEligible(booking, uid, now) {
      return booking.reeloId === uid &&
        booking.status === "completed" &&
        ["customer_confirmed","customer_device_completed"].includes(booking.deliveryStatus) &&
        booking.deliveryDisputed !== true &&
        booking.paymentStatus === "captured" &&
        booking.earningsEligibleAt &&
        booking.earningsEligibleAt.toMillis() <= now &&
        ![
          "creating",
          "queued",
          "pending",
          "processing",
          "processed",
          "paid",
          "review_required",
        ].includes(booking.payoutStatus);
    }

    // RazorpayX payout functions intentionally not exported yet.
    // They will be restored when live payouts are enabled.

    exports.requestAccountDeletion = onCall({ invoker: "public", enforceAppCheck: true }, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before requesting deletion.");
      const authTime = Number(request.auth.token.auth_time || 0) * 1000;
      if (!authTime || Date.now() - authTime > 10 * 60 * 1000) throw new HttpsError("unauthenticated", "Sign out, sign back in, then request deletion again.");
      const uid = request.auth.uid;
      await db.collection("account_deletion_requests").doc(uid).set({ userId: uid, email: clean(request.auth.token.email, 120), status: "requested", requestedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await db.collection("users").doc(uid).set({ deletionRequested: true, deletionRequestedAt: FieldValue.serverTimestamp(), fcmTokens: [] }, { merge: true });
      await getAuth().updateUser(uid, { disabled: true });
      await getAuth().revokeRefreshTokens(uid);
      return { requested: true };
    });

    exports.completeAccountDeletion = onCall({ invoker: "public", enforceAppCheck: true }, async (request) => {
      await requireAdmin(request);
      const uid = clean(request.data && request.data.userId, 128);
      if (!uid) throw new HttpsError("invalid-argument", "Choose an account deletion request.");
      const requestRef = db.collection("account_deletion_requests").doc(uid);
      const deletionRequest = await requestRef.get();
      if (!deletionRequest.exists || !["requested", "failed"].includes(deletionRequest.get("status"))) {
        throw new HttpsError("failed-precondition", "This deletion request is not ready to complete.");
      }

      const [customerBookings, reeloBookings, payoutRequests] = await Promise.all([
        db.collection("bookings").where("customerId", "==", uid).get(),
        db.collection("bookings").where("reeloId", "==", uid).get(),
        db.collection("payout_requests").where("reeloId", "==", uid).get(),
      ]);
      const terminalBookingStates = new Set(["completed", "cancelled", "expired"]);
      const activeBooking = [...customerBookings.docs, ...reeloBookings.docs]
        .some((document) => !terminalBookingStates.has(document.get("status")));
      const activePayout = payoutRequests.docs.some((document) =>
        ["creating", "queued", "pending", "processing"].includes(document.get("status")));
      if (activeBooking || activePayout) {
        throw new HttpsError(
          "failed-precondition",
          "Resolve active bookings and payouts before completing deletion.",
        );
      }

      await requestRef.set({
        status: "processing",
        processingBy: request.auth.uid,
        processingAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      try {
        const anonymizedId = `deleted_${crypto.createHash("sha256").update(uid).digest("hex").slice(0, 20)}`;
        const uniqueBookingDocs = new Map();
        [...customerBookings.docs, ...reeloBookings.docs].forEach((document) => uniqueBookingDocs.set(document.id, document));
        for (const booking of uniqueBookingDocs.values()) {
          await deleteSubcollection(booking.ref, "messages");
          const updates = {
            accountDeletionAppliedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          };
          if (booking.get("customerId") === uid) {
            Object.assign(updates, {
              customerId: anonymizedId,
              customerName: "Deleted customer",
              customerEmail: FieldValue.delete(),
              customerPhotoUrl: FieldValue.delete(),
              customerPhone: FieldValue.delete(),
            });
          }
          if (booking.get("reeloId") === uid) {
            Object.assign(updates, {
              reeloId: anonymizedId,
              offeredReeloIds: [],
              reeloName: "Deleted Reelo",
              reeloEmail: FieldValue.delete(),
              reeloPhotoUrl: FieldValue.delete(),
              reeloPhone: FieldValue.delete(),
            });
          }
          await booking.ref.update(updates);
        }

        for (const payout of payoutRequests.docs) {
          await payout.ref.set({
            reeloId: anonymizedId,
            destinationLabel: "Deleted payout destination",
            accountDeletionAppliedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        const [customerReviews, reeloReviews, notifications, alerts, supportThreads, reportsBy, reportsAbout, profileAccessLogs, legacyAccessLogs, offersForReelo, offersForCustomer] = await Promise.all([
          db.collection("reviews").where("customerId", "==", uid).get(),
          db.collection("reviews").where("reeloId", "==", uid).get(),
          db.collection("notifications").where("userId", "==", uid).get(),
          db.collection("sos_alerts").where("raisedBy", "==", uid).get(),
          db.collection("support_threads").where("userId", "==", uid).get(),
          db.collection("user_reports").where("reporterId", "==", uid).get(),
          db.collection("user_reports").where("reportedUserId", "==", uid).get(),
          db.collection("profile_review_access_logs").where("submissionId", "==", uid).get(),
          db.collection("kyc_access_logs").where("submissionId", "==", uid).get(),
          db.collection("booking_offers").where("reeloId", "==", uid).get(),
          db.collection("booking_offers").where("customerId", "==", uid).get(),
        ]);
        const deletions = new Map();
        [customerReviews, reeloReviews, notifications, alerts, reportsBy, profileAccessLogs, legacyAccessLogs, offersForReelo, offersForCustomer]
          .forEach((snapshot) => snapshot.docs.forEach((document) => deletions.set(document.ref.path, document)));
        await deleteDocuments([...deletions.values()]);
        for (const thread of supportThreads.docs) {
          await deleteSubcollection(thread.ref, "messages");
          await thread.ref.delete();
        }
        for (const report of reportsAbout.docs) {
          await report.ref.set({
            reportedUserId: anonymizedId,
            reportedUserName: "Deleted account",
            accountDeletionAppliedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        const userRef = db.collection("users").doc(uid);
        await deleteSubcollection(userRef, "blocked_users");
        const blockingReferences = await db.collectionGroup("blocked_users")
          .where("blockedUserId", "==", uid)
          .get();
        await deleteDocuments(blockingReferences.docs);
        await getStorage().bucket().deleteFiles({ prefix: `users/${uid}/`, force: true });
        await getStorage().bucket().deleteFiles({ prefix: `reelo_profile_reviews/${uid}/`, force: true });
        await Promise.all([
          userRef.delete(),
          db.collection("reelo_profiles").doc(uid).delete(),
          db.collection("reelo_profile_reviews").doc(uid).delete(),
          db.collection("reelo_verifications").doc(uid).delete(),
          db.collection("reelo_payout_profiles").doc(uid).delete(),
        ]);
        await getAuth().deleteUser(uid).catch((error) => {
          if (error.code !== "auth/user-not-found") throw error;
        });
        await db.collection("deletion_audit").doc(anonymizedId).set({
          anonymizedAccountId: anonymizedId,
          completedBy: request.auth.uid,
          completedAt: FieldValue.serverTimestamp(),
          retainedRecords: "Anonymized terminal booking and financial ledgers only",
        });
        await requestRef.delete();
        return { deleted: true, anonymizedAccountId: anonymizedId };
      } catch (error) {
        console.error("completeAccountDeletion", uid, error.message);
        await requestRef.set({
          status: "failed",
          failureReason: clean(error.message, 240),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        throw new HttpsError("internal", "Deletion could not be completed. The case remains in the owner queue.");
      }
    });

    exports.razorpayWebhook = onRequest({
      secrets: [razorpayWebhookSecret, razorpayKeyId, razorpayKeySecret],
      invoker: "public",
    }, async (request, response) => {
      const received = String(request.get("x-razorpay-signature") || "");
      const expected = crypto.createHmac("sha256", razorpayWebhookSecret.value()).update(request.rawBody).digest("hex");
      if (!received || received.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
        response.status(401).send("Invalid signature");
        return;
      }
      const eventId = String(request.get("x-razorpay-event-id") || crypto.createHash("sha256").update(request.rawBody).digest("hex"));
      const eventRef = db.collection("razorpay_events").doc(eventId);
      const previous = await eventRef.get();
      if (previous.exists && previous.get("status") === "processed") {
        response.status(200).send("Duplicate ignored");
        return;
      }
      const event = request.body || {};
      const eventType = clean(event.event, 80) || "unknown";
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      const refund = event.payload && event.payload.refund && event.payload.refund.entity;
      const payout = event.payload && event.payload.payout && event.payload.payout.entity;
      const bookingId = clean((payment && payment.notes && payment.notes.bookingId) || (refund && refund.notes && refund.notes.bookingId), 120);
      await eventRef.set({ type: eventType, status: "processing", receivedAt: FieldValue.serverTimestamp() }, { merge: true });
      try {
        if (bookingId) {
          const updates = { paymentUpdatedAt: FieldValue.serverTimestamp() };
          let capturedBooking = null;
          if (eventType === "payment.captured") {
            const bookingRef = db.collection("bookings").doc(bookingId);
            const booking = await bookingRef.get();
            const validPayment = booking.exists &&
              booking.get("razorpayOrderId") === payment.order_id &&
              Number(payment.amount) === bookingChargePrice(booking.data()) * 100 &&
              payment.currency === "INR";
            if (!validPayment) throw new Error("Captured payment does not match the booking order.");
            const bookingStatus = booking.get("status");
            Object.assign(updates, {
              paymentStatus: "captured",
              paymentCapturedAt: FieldValue.serverTimestamp(),
              paymentReference: payment.id,
              updatedAt: FieldValue.serverTimestamp(),
            });
            if (bookingStatus === "payment_pending") {
              capturedBooking = booking;
              Object.assign(updates, {
                status: "searching",
                ...(booking.get("timingType") === "now" ? {
                  requestExpiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
                } : {}),
              });
            } else if (["cancelled", "cancellation_processing"].includes(bookingStatus)) {
              const providerRefund = await razorpay(`/v1/payments/${encodeURIComponent(payment.id)}/refund`, {
                method: "POST",
                body: {
                  amount: bookingChargePrice(booking.data()) * 100,
                  speed: "normal",
                  notes: { bookingId, reason: "captured_after_customer_cancelled" },
                },
              });
              Object.assign(updates, {
                status: "cancelled",
                refundStatus: providerRefund.status || "processing",
                refundReference: providerRefund.id || null,
                refundAmount: bookingChargePrice(booking.data()),
              });
            }
          }
          if (eventType === "payment.failed") Object.assign(updates, { paymentStatus: "failed", paymentFailureReason: payment.error_description || "Payment failed" });
          if (eventType === "refund.processed") Object.assign(updates, { refundStatus: "processed", refundReference: refund && refund.id, refundedAt: FieldValue.serverTimestamp() });
          if (eventType === "refund.failed") Object.assign(updates, { refundStatus: "manual_review_required", refundFailureReason: "Refund failed" });
          await db.collection("bookings").doc(bookingId).set(updates, { merge: true });
          if (capturedBooking && capturedBooking.get("promotionCode") === "WELCOME15") {
            await Promise.all([
              capturedBooking.ref.set({
                promotionStatus: "redeemed",
                promotionRedeemedAt: FieldValue.serverTimestamp(),
              }, { merge: true }),
              db.collection("users").doc(capturedBooking.get("customerId")).set({
                welcomeDiscountRedeemedAt: FieldValue.serverTimestamp(),
                welcomeDiscountRedeemedBookingId: bookingId,
                welcomeDiscountReservationBookingId: FieldValue.delete(),
                welcomeDiscountReservationExpiresAt: FieldValue.delete(),
                updatedAt: FieldValue.serverTimestamp(),
              }, { merge: true }),
            ]);
          }
        }
        if (payout) {
          const payoutRequestId = clean(payout.notes && payout.notes.payoutRequestId, 120);
          if (payoutRequestId) {
            const payoutRef = db.collection("payout_requests").doc(payoutRequestId);
            const payoutSnapshot = await payoutRef.get();
            if (payoutSnapshot.exists) {
              const status = clean(payout.status, 40) || clean(eventType.split(".").pop(), 40);
              const batch = db.batch();
              batch.set(payoutRef, { status, providerStatus: status, providerPayoutId: payout.id, utr: payout.utr || null, failureReason: payout.status_details && payout.status_details.description || null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
              const bookingIds = payoutSnapshot.get("bookingIds") || [];
              bookingIds.forEach((id) => batch.set(db.collection("bookings").doc(id), { payoutStatus: PAYOUT_FAILED.has(status) ? "available" : status, payoutReference: payout.id, ...(status === "processed" ? { paidOutAt: FieldValue.serverTimestamp() } : {}) }, { merge: true }));
              await batch.commit();
            }
          }
        }
        await eventRef.set({ status: "processed", processedAt: FieldValue.serverTimestamp(), error: FieldValue.delete() }, { merge: true });
        response.status(200).send("ok");
      } catch (error) {
        console.error("razorpayWebhook", eventType, error.message);
        await eventRef.set({ status: "failed", error: clean(error.message, 240), failedAt: FieldValue.serverTimestamp() }, { merge: true });
        response.status(500).send("Retry");
      }
    });
// Operations V7: portfolio-link Editing approval. Keeps the app's two-gate rule:
// canEditReels === true AND editingApprovalStatus === 'approved'.
exports.adminReviewEditingApplication = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
  await requireAdmin(request);
  const reeloId = clean(request.data && request.data.reeloId, 160);
  const decision = clean(request.data && request.data.decision, 40);
  const reason = clean(request.data && request.data.reason, 500);
  if (!reeloId || !new Set(["approved", "denied", "resubmission_required"]).has(decision)) {
    throw new HttpsError("invalid-argument", "A valid Reelo and editing decision are required.");
  }
  if (reason.length < 3) throw new HttpsError("invalid-argument", "A review note is required.");
  const profileRef = db.collection("reelo_profiles").doc(reeloId);
  const applicationRef = db.collection("editing_applications").doc(reeloId);
  const [profileSnap, applicationSnap] = await Promise.all([profileRef.get(), applicationRef.get()]);
  if (!profileSnap.exists) throw new HttpsError("not-found", "Reelo profile not found.");
  const profile = profileSnap.data() || {};
  const application = applicationSnap.exists ? applicationSnap.data() || {} : {};
  const portfolioUrl = clean(application.portfolioUrl || profile.instagramUrl || profile.portfolioUrl, 1000);
  if (decision === "approved") {
    if (profile.verified !== true) throw new HttpsError("failed-precondition", "Live verification must be approved first.");
    let parsed;
    try { parsed = new URL(portfolioUrl); } catch (_) { parsed = null; }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      throw new HttpsError("failed-precondition", "A valid portfolio or work link is required.");
    }
  }
  const batch = db.batch();
  batch.set(profileRef, {
    editingApprovalStatus: decision,
    editingReviewedAt: FieldValue.serverTimestamp(),
    editingReviewedBy: request.auth.uid,
    editingReviewNote: reason,
    ...(portfolioUrl ? { instagramUrl: portfolioUrl } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (applicationSnap.exists) batch.delete(applicationRef);
  await batch.commit();
  await writeAdminAudit({ request, action: `EDITING_${decision.toUpperCase()}`, targetType: "reelo", targetId: reeloId, reason, after: { editingApprovalStatus: decision, portfolioUrl } });
  return { reviewed: true, decision };
});

// Operations V7: controlled account metadata editing, including Reelo portfolio link.
exports.adminUpdateAccountProfile = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
  await requireAdmin(request);
  const uid = clean(request.data && request.data.uid, 160);
  const role = clean(request.data && request.data.role, 20);
  const name = clean(request.data && request.data.name, 120);
  const phone = clean(request.data && request.data.phone, 60);
  const area = clean(request.data && request.data.area, 160);
  const portfolioUrl = clean(request.data && request.data.portfolioUrl, 1000);
  if (!uid || !new Set(["reelo", "customer"]).has(role)) throw new HttpsError("invalid-argument", "A valid account is required.");
  if (role === "reelo" && portfolioUrl) {
    let parsed;
    try { parsed = new URL(portfolioUrl); } catch (_) { parsed = null; }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) throw new HttpsError("invalid-argument", "Enter a valid http/https portfolio link.");
  }
  const update = { name, phone, updatedAt: FieldValue.serverTimestamp() };
  if (role === "reelo") {
    update.area = area;
    update.instagramUrl = portfolioUrl;
    await db.collection("reelo_profiles").doc(uid).set(update, { merge: true });
  } else {
    await db.collection("users").doc(uid).set(update, { merge: true });
  }
  await writeAdminAudit({ request, action: "ACCOUNT_PROFILE_UPDATED", targetType: role, targetId: uid, reason: `Operations updated ${role} profile metadata.` });
  return { updated: true };
});

// Operations V7: authoritative Firebase Auth enable/disable control.
exports.adminSetAccountDisabled = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
  await requireAdmin(request);
  const uid = clean(request.data && request.data.uid, 160);
  const disabled = request.data && request.data.disabled === true;
  const reason = clean(request.data && request.data.reason, 500);
  if (!uid) throw new HttpsError("invalid-argument", "A user ID is required.");
  if (reason.length < 5) throw new HttpsError("invalid-argument", "A reason of at least 5 characters is required.");
  const target = await getAuth().getUser(uid).catch(() => null);
  if (!target) throw new HttpsError("not-found", "The account could not be found.");
  await getAuth().updateUser(uid, { disabled });
  await writeAdminAudit({ request, action: disabled ? "ACCOUNT_SIGN_IN_DISABLED" : "ACCOUNT_SIGN_IN_ENABLED", targetType: "account", targetId: uid, reason });
  return { ok: true, uid, disabled };
});

function operationsTimestampFromInput(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new HttpsError("invalid-argument", `${label} is not a valid date/time.`);
  return Timestamp.fromDate(date);
}

// Operations V7: create/update campaigns used by the app's authoritative validateCoupon/createRazorpayOrder flow.
exports.adminUpsertCoupon = onCall({ invoker: "public", enforceAppCheck: false }, async (request) => {
  await requireAdmin(request);
  const code = clean(request.data && request.data.code, 40).toUpperCase();
  const discountType = clean(request.data && request.data.discountType, 20);
  const discountValue = Math.round(Number(request.data && request.data.discountValue));
  const maxRedemptions = Math.max(0, Math.floor(Number(request.data && request.data.maxRedemptions) || 0));
  const maxUsesPerCustomer = Math.max(1, Math.floor(Number(request.data && request.data.maxUsesPerCustomer) || 1));
  const deliveryTypes = Array.isArray(request.data && request.data.deliveryTypes) ? [...new Set(request.data.deliveryTypes.map(v => clean(v, 20)).filter(v => ["originals", "edited"].includes(v)))] : [];
  const durationMinutes = Array.isArray(request.data && request.data.durationMinutes) ? [...new Set(request.data.durationMinutes.map(Number).filter(v => [60, 90, 180].includes(v)))] : [];
  const active = request.data && request.data.active === true;
  const reason = clean(request.data && request.data.reason, 500);
  const startsAt = operationsTimestampFromInput(request.data && request.data.startsAt, "Start time");
  const endsAt = operationsTimestampFromInput(request.data && request.data.endsAt, "End time");
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new HttpsError("invalid-argument", "Coupon code must be 3–40 characters using letters, numbers, _ or -.");
  if (!["percent", "flat"].includes(discountType)) throw new HttpsError("invalid-argument", "Choose percentage or flat discount.");
  if (!Number.isFinite(discountValue) || discountValue <= 0) throw new HttpsError("invalid-argument", "Discount value must be greater than zero.");
  if (discountType === "percent" && discountValue > 100) throw new HttpsError("invalid-argument", "Percentage discount cannot exceed 100%.");
  if (!deliveryTypes.length || !durationMinutes.length) throw new HttpsError("invalid-argument", "Choose at least one service and duration.");
  if (startsAt && endsAt && startsAt.toMillis() >= endsAt.toMillis()) throw new HttpsError("invalid-argument", "Coupon end time must be after its start time.");
  if (reason.length < 3) throw new HttpsError("invalid-argument", "Add a short campaign note.");
  const ref = db.collection("coupons").doc(code);
  const beforeSnap = await ref.get();
  const before = beforeSnap.exists ? beforeSnap.data() : null;
  const patch = {
    code, discountType, discountValue, maxRedemptions, maxUsesPerCustomer,
    deliveryTypes, durationMinutes, active,
    startsAt: startsAt || null, endsAt: endsAt || null,
    campaignNote: reason,
    updatedAt: FieldValue.serverTimestamp(), updatedBy: request.auth.uid,
    ...(beforeSnap.exists ? {} : { redemptionCount: 0, createdAt: FieldValue.serverTimestamp(), createdBy: request.auth.uid }),
  };
  await ref.set(patch, { merge: true });
  await writeAdminAudit({ request, action: beforeSnap.exists ? "COUPON_UPDATED" : "COUPON_CREATED", targetType: "coupon", targetId: code, reason, before, after: { ...patch, startsAt: request.data && request.data.startsAt || null, endsAt: request.data && request.data.endsAt || null } });
  return { saved: true, code };
});

// Operations V7: tightly scoped manual booking money controls.
// Full refund calls Razorpay. Manual payout recording NEVER sends money; it records an external payout already made.
exports.adminMoneyAction = onCall({ secrets: [razorpayKeyId, razorpayKeySecret], invoker: "public", enforceAppCheck: false }, async (request) => {
  await requireAdmin(request);
  const bookingId = clean(request.data && request.data.bookingId, 120);
  const action = clean(request.data && request.data.action, 60);
  const reason = clean(request.data && request.data.reason, 500);
  const reference = clean(request.data && request.data.reference, 160);
  const allowed = new Set(["flag_payment_review", "clear_payment_review", "full_refund", "hold_payout", "release_payout", "record_manual_payout"]);
  if (!bookingId || !allowed.has(action)) throw new HttpsError("invalid-argument", "Choose a valid money action.");
  if (reason.length < 5) throw new HttpsError("invalid-argument", "A reason of at least 5 characters is required.");
  const ref = db.collection("bookings").doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = snap.data();
  const before = { paymentStatus: booking.paymentStatus || null, refundStatus: booking.refundStatus || null, payoutStatus: booking.payoutStatus || null, payoutReference: booking.payoutReference || null, operationalAttentionType: booking.operationalAttentionType || null };
  let patch = {};
  if (action === "flag_payment_review") {
    patch = { operationalAttention: true, operationalAttentionType: "payment_review", operationalAttentionReason: reason, operationalAttentionAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    await ref.set(patch, { merge: true });
  } else if (action === "clear_payment_review") {
    if (booking.operationalAttentionType !== "payment_review") throw new HttpsError("failed-precondition", "This booking is not currently flagged for payment review.");
    patch = { operationalAttention: false, operationalAttentionType: FieldValue.delete(), operationalAttentionReason: FieldValue.delete(), operationalAttentionAt: FieldValue.delete(), paymentReviewClearedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    await ref.set(patch, { merge: true });
  } else if (action === "full_refund") {
    if (!["captured", "paid", "signature_verified"].includes(clean(booking.paymentStatus, 40)) || !booking.paymentReference) throw new HttpsError("failed-precondition", "A captured Razorpay payment is required for a refund.");
    if (["processed", "completed"].includes(clean(booking.refundStatus, 40))) throw new HttpsError("failed-precondition", "This booking is already refunded.");
    const amount = bookingChargePrice(booking);
    if (!amount || amount <= 0) throw new HttpsError("failed-precondition", "The refundable booking amount is invalid.");
    await ref.set({ refundStatus: "starting", refundAmount: amount, refundRequestedBy: request.auth.uid, refundRequestedAt: FieldValue.serverTimestamp(), refundReason: reason, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    try {
      const refund = await razorpay(`/v1/payments/${encodeURIComponent(clean(booking.paymentReference, 120))}/refund`, { method: "POST", body: { amount: amount * 100, speed: "normal", notes: { bookingId, reason: "operations_manual_full_refund" } } });
      patch = { refundStatus: refund.status || "processing", refundReference: refund.id || null, refundAmount: amount, refundedAt: refund.status === "processed" ? FieldValue.serverTimestamp() : null, updatedAt: FieldValue.serverTimestamp() };
      await ref.set(patch, { merge: true });
      if (booking.customerId) await createNotification(booking.customerId, { title: "Refund initiated", body: "Reel It Support initiated a full refund for your booking.", type: "refund_update", bookingId });
    } catch (error) {
      patch = { refundStatus: "manual_review_required", refundFailureReason: clean(error.message, 240), updatedAt: FieldValue.serverTimestamp() };
      await ref.set(patch, { merge: true });
      await writeAdminAudit({ request, action: "MONEY_FULL_REFUND_FAILED", targetType: "booking", targetId: bookingId, reason, before, after: { refundStatus: "manual_review_required" } });
      throw new HttpsError("internal", "Razorpay could not start the refund. The booking is marked for manual review.");
    }
  } else if (action === "hold_payout") {
    if (["paid", "processed"].includes(clean(booking.payoutStatus, 40))) throw new HttpsError("failed-precondition", "This booking is already paid out.");
    patch = { payoutStatus: "review_required", payoutHoldReason: reason, payoutHeldAt: FieldValue.serverTimestamp(), payoutHeldBy: request.auth.uid, updatedAt: FieldValue.serverTimestamp() };
    await ref.set(patch, { merge: true });
  } else if (action === "release_payout") {
    if (["paid", "processed"].includes(clean(booking.payoutStatus, 40))) throw new HttpsError("failed-precondition", "This booking is already paid out.");
    const nextStatus = booking.earningsEligibleAt ? "available" : "pending_delivery";
    patch = { payoutStatus: nextStatus, payoutHoldReason: FieldValue.delete(), payoutHeldAt: FieldValue.delete(), payoutHeldBy: FieldValue.delete(), payoutReleasedAt: FieldValue.serverTimestamp(), payoutReleasedBy: request.auth.uid, updatedAt: FieldValue.serverTimestamp() };
    await ref.set(patch, { merge: true });
  } else if (action === "record_manual_payout") {
    if (reference.length < 3) throw new HttpsError("invalid-argument", "A payout reference is required.");
    if (["paid", "processed"].includes(clean(booking.payoutStatus, 40))) throw new HttpsError("failed-precondition", "This booking is already recorded as paid out.");
    patch = { payoutStatus: "paid", payoutReference: reference, paidOutAt: FieldValue.serverTimestamp(), manualPayoutRecordedAt: FieldValue.serverTimestamp(), manualPayoutRecordedBy: request.auth.uid, manualPayoutReason: reason, updatedAt: FieldValue.serverTimestamp() };
    await ref.set(patch, { merge: true });
  }
  await writeAdminAudit({ request, action: `MONEY_${action.toUpperCase()}`, targetType: "booking", targetId: bookingId, reason, before, after: { action, reference: reference || null } });
  return { completed: true, action };
});
