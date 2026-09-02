# Reel It Operations V5 — Workable People-First Patch

This patch upgrades the existing Operations dashboard instead of replacing the Firebase/chat architecture.

## Practical changes

- People-first Command Center: customer/Reelo names, profile photos when available, occasion/package/duration, issue reason and direct Booking Control action.
- Separate Customer Chats and Reelo Chats remain connected to the existing `support_threads/{thread}/messages` structure.
- Support queues now display the person, phone/email when available, linked booking context, latest message, priority and direct action.
- Support case metadata can be saved on the existing support thread as `caseCategory`, `casePriority`, assigned admin and timestamps. This is additive and does not change the mobile chat schema.
- Global search now searches booking details plus customer/Reelo names, phone, email, booking references, payment/payout references, profiles and support conversations when the current admin rules permit those reads.
- Real booking filters: date, session status, content package, delivery state, payment state, Reelo assignment and Needs Attention.
- Booking list is people-first. Firestore IDs are supporting data rather than the primary label.
- Human booking references use `RLT-BK-...` fallback formatting; an existing stored booking reference is preferred when supplied to the renderer.
- Booking Control drawer widened and continues to expose customer/Reelo identity, booking, session, delivery, money, chat, files, timeline, controlled overrides and Operations notes.
- Customer payment, Reelo earning, payout and refund stay separate in the Money ledger.
- Reelo activation approval keeps the existing live-selfie/manual review path.
- Existing V3 +12h/+24h delivery extension controls remain in Booking Control.

## Preserved wiring

The patch keeps the current Firebase project, `support_threads`, `bookings`, `users`, `reelo_profiles`, `booking_media`, `operations_notes`, `audit_logs` and existing callable-function integration. No replacement chat database was created.

## Required backend/functions already referenced by the dashboard

The currently deployed backend must provide the callable functions already used by the Operations frontend, including `adminBookingAction`, `adminForceBookingStatus`, `adminReviewReelo`, `addOperationsNote`, and `extendDeliveryDeadline` where those controls are enabled.

## Before launch

1. Put the correct public reCAPTCHA v3 App Check site key in `firebase-config.js` if your deployed callable functions require web App Check.
2. Sign in with the actual active owner/admin account.
3. Test one Customer Chat reply and one Reelo Chat reply.
4. Open a booking from a chat and confirm customer/Reelo identity, money, delivery and timeline all load.
5. Test filters/search with a real name, phone, `RLT-BK-...` reference and payment reference.
6. Test one Reelo activation approval with a non-production/test account before approving real applicants.
7. Test every privileged action with a test booking before using it on a real live booking.
