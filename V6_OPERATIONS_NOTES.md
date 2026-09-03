# Reel It Operations V6 — functional operations build

Built from the existing V5 Support Desk Workflow build. Existing booking controls, emergency force-status override, delivery extensions, support streams, live verification, money, safety, deletion requests and audit views are preserved.

## V6 additions
- Simplified navigation.
- Dedicated Editing Approval queue reading `editing_applications`.
- Portfolio review with Approve / Deny / Request resubmission.
- Editing approval updates authoritative `reelo_profiles.editingApprovalStatus`; it does not bypass the Reelo's `canEditReels` toggle.
- Reelo Accounts and Customer Accounts directories.
- Reelo profile + live-verification photo comparison.
- Booking and support history inside account workspace.
- Controlled profile metadata edits.
- Firebase Auth disable/enable action with required reason.
- Support chat styling upgraded to a proper left/right conversation UI.
- Existing Force Booking Status remains available in both full Booking Control and the Support booking-control tab.

## Required backend functions included
The ZIP includes `firebase_backend_patch/functions/index.js`, based on the current production functions source, with exactly three Operations V6 callables added:
1. `adminReviewEditingApplication`
2. `adminUpdateAccountProfile`
3. `adminSetAccountDisabled`

Those callables require an active admin and write privileged actions to the existing admin audit log.

## Important
Deploy the included backend functions patch before using the three new privileged V6 actions above. Existing V5 operations functions remain unchanged.
