# Reel It Operations — Support Desk V5

Controlled patch based on `Reel_It_Operations_V4_SUPPORT_LIVE_QUEUE_FIXED.zip`.

## Changes
- Customer/Reelo support cases open inline below the queue instead of a separate modal.
- Open and Resolved tabs.
- Resolve/Reopen case action.
- Person identity enrichment from booking, users, and reelo_profiles where available.
- Selected case header shows name, phone/email/ref, latest issue, case status, last activity, and booking ref.
- Case tabs: Conversation, Booking / Control, Case notes.
- Booking / Control shows booking people/status/payment/delivery and provides audited emergency force-status control plus one-click full Booking Control.
- Browser notification tone for newly updated unread support cases/messages. Sound starts after the first dashboard click because browsers block autoplay audio before user interaction.
- Resolved cases are removed from the Open queue but remain available under Resolved.
- Existing Firestore support_threads/messages architecture is preserved.
