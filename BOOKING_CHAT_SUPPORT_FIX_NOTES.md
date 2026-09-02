# Operations Booking Chat + Support Visibility Fix

Narrow patch on the corrected V4 Practical Operations dashboard.

- Customer Chats / Reelo Chats no longer disappear solely because an older support thread lacks `humanRequested == true`.
- Actionable statuses shown: waiting, active, needs_human, open, or explicitly human-requested.
- Booking Control has a **Booking Chat** tab showing `bookings/{bookingId}/messages` live.
- Booking Chat is read-only for Operations.
- Admin replies continue through Customer Support / Reelo Support threads.
- Firebase config remains `reel-it-df4ff`, web app `1:505436045173:web:2d59f7b6c045cc86669d3c`, functions region `asia-south1`.
- `app.js` Node syntax check passed.
