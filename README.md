# Reel It Operations v2.0 — White Control Room

This folder is a complete replacement for the current GitHub Pages Operations frontend.

## What it does

- White, compact operations dashboard (no giant inbox cards)
- Overview KPIs: today's bookings, revenue, online Reelos, pending uploads, pending actions
- Searchable/filterable booking table
- Booking filters: Needs attention, Pending Upload, Pending Approval, Payment Issues, Cancellations
- Right-side Booking Control Room
- Separate Customer Chat and Reelo Chat tabs for support threads linked to the booking
- Files tab reading `booking_media`
- Timeline tab
- Lifecycle recovery actions:
  - Force End Session → Pending Upload
  - Repair → Pending Upload
  - Mark Reelo Online
  - Request Upload
  - Return to Matching
  - Payment review / unpaid cancellation when applicable
- Internal Operations notes
- Reelos, Content, Payments, Refunds, SOS, Reports, Accounts and Audit views
- Human-friendly Reel It booking references like `RLT-BK-XXXXXX`, while Firestore document IDs remain internal

## Backend expectation

The site uses the existing Firebase project and your current callable `adminBookingAction` backend. For Force End and Repair to work, the deployed version of `adminBookingAction` must support:

- `force_end_session`
- `move_to_pending_delivery`

The current Reel It v15.5 Lifecycle Recovery backend contains those actions.

`Mark Reelo Online` is an admin-only Firestore update and writes an `audit_logs` record.

## Replace the existing GitHub Pages site

Copy these files to the root of the `reel-it-operations` GitHub repository:

- `index.html`
- `app.js`
- `styles.css`
- `firebase-config.js`
- `.nojekyll`

Commit and push. GitHub Pages will serve the new dashboard from the existing URL.

## Important

Do not put Razorpay secrets, Firebase service-account files, passwords, or private keys in this repository. Firebase web configuration and reCAPTCHA site keys are public client configuration; backend secrets remain in Cloud Secret Manager.

## V4 practical patch

`V4_PRACTICAL_OPERATIONS_PATCH_NOTES.md` documents the controlled V4 upgrade. The patch keeps the existing live support-chat architecture rather than replacing it.
