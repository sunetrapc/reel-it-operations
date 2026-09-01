# Reel It Operations — V4 Practical Patch

This is a controlled patch of the existing V3 Operations dashboard. It deliberately preserves the existing Firebase project, authentication gate, `support_threads` live-chat collection, message listener, booking drawer, existing booking queries, and existing Cloud Functions. It does not replace chat with a new system.

## What changed

- Split Support into **Customer Chats** and **Reelo Chats** while reading the same existing `support_threads` records.
- Booking-linked chats open the existing booking drawer on the correct Customer/Reelo Chat tab.
- Chat context now shows the participant name, email, phone when stored, public/internal reference, support thread ID, and a one-click Booking Control link.
- Support replies continue to write to `support_threads/{threadId}/messages`; the existing backend notification trigger remains the delivery path to the app.
- Added private support-case notes through the existing `addOperationsNote` callable.
- Upgraded the booking drawer to **Booking Control** with Customer + Reelo identity, booking/session/device details, customer charge, Reelo earning, payment reference, payout/refund context, delivery status, and deadline.
- Added an emergency **Force booking status** control backed by the existing `adminForceBookingStatus` callable. A reason and confirmation are required; the backend writes the privileged audit record.
- Kept the V3 +12h/+24h delivery extension controls.
- Added a practical **Booking money ledger** separating Customer charge, Payment, Reelo earning, Fulfillment/hold, Payout, and Refund.
- Added **Reelo Approvals** using the existing `reelo_profile_reviews` + `reelo_profiles` records and the existing `adminReviewReelo` callable. The submitted live selfie is shown large, and Operations can Approve & activate or Deny/request a new selfie with a required note.
- Reelo approval cards show onboarding, phone verification, and training readiness before activation.

## Important compatibility

No mobile chat schema was changed. Existing customer/Reelo chat should keep working because the dashboard still uses the same `support_threads/{threadId}/messages` path and the same sender types (`user`, `support`, `system`).

The new Operations controls expect the Cloud Functions already present in the Reel It V3 app backend: `adminForceBookingStatus`, `adminReviewReelo`, `addOperationsNote`, `adminBookingAction`, and `extendDeliveryDeadline`.

## Validation performed

- `node --check app.js` passes.
- ZIP integrity checked after packaging.
- No Firebase project identifiers were changed.
- No mobile-app files are included in this dashboard patch.

## First live tests

1. Open one Customer support chat, reply from Operations, confirm the reply appears in the customer app.
2. Open one Reelo support chat, reply from Operations, confirm the reply appears in the Reelo app.
3. Click the booking reference from each chat and confirm Booking Control shows the correct participants and money fields.
4. Use a non-destructive forced-status test only on a disposable test booking and confirm an `audit_logs` record is created.
5. Submit a test Reelo live selfie, open Reelo Approvals, and confirm the image + profile readiness fields appear before using Approve/Deny.
