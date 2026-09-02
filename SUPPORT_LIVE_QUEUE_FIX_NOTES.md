# Support live queue fix

This patch fixes Operations support pages that remained blank while the mobile app had an active Reel It Support conversation.

## Changes
- Customer Chats and Reelo Chats now use a live Firestore listener on `support_threads` instead of a one-time read coupled to booking loading.
- A booking lookup failure no longer prevents support conversations from appearing.
- Older support thread variants are kept visible when they have `humanRequested`, `unreadBySupport`, a `lastMessage`, or an actionable support status.
- The page shows a small Firebase connection/thread count so a true read/permission problem is visible instead of looking like an empty queue.
- General support conversations with no booking link now open the full live `support_threads/{threadId}/messages` conversation and Operations can reply.
- Booking-linked support still opens Booking Control and uses the same support thread/messages schema.
- Firebase project and Functions region are unchanged: `reel-it-df4ff`, `asia-south1`.
