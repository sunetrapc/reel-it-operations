# Reel It Operations V4 — Practical usability correction

This patch was made directly on the user-supplied `Reel_It_Operations_V4_PRACTICAL_PATCH(1).zip`. It does not replace the Firebase/chat architecture.

## Corrected in this build
- Dashboard is people-first: customer/Reelo names and avatars are primary; booking IDs are secondary.
- Dashboard has actionable Needs Attention, Live / Active Sessions, and Support Waiting panels.
- `Revenue (Today)` renamed to `Customer payments today` to avoid confusing customer collections with platform revenue.
- Global Filters button now works and filters by date, booking status, package, delivery, payment issue, and Needs Attention.
- Booking search now covers names, phones, customer/Reelo refs, booking refs, email, payment IDs, payout IDs, location and raw booking ID.
- Booking rows now show occasion first, then RLT-BK reference, plus customer/Reelo people cards.
- Customer Chats and Reelo Chats now show person name, contact/context, latest issue/message, related booking people, booking status/delivery/payment context, and Open Case.
- Existing booking-control drawer, live support chat streams, internal notes, force-status callable, Reelo approval flow, payments, delivery controls, and Firebase collection paths were preserved.
- Booking reference fallback changed from `RIT-...` to `RLT-BK-...`.

## Validation
- `node --check app.js` passed.
- ZIP integrity checked after packaging.

## Still requires live Firebase testing
Static validation cannot confirm Firestore permissions, App Check, production callable deployment, provider payment state, or real support-thread data. Test with a real Customer Chat and Reelo Chat before launch.
