# Operations Data & Audit Map

| Operations feature | Existing Firebase source / action |
|---|---|
| Customer/Reelo support queue | `support_threads` |
| Live support messages | `support_threads/{threadId}/messages` |
| Booking Control | `bookings/{bookingId}` |
| Reelo identity / availability | `reelo_profiles/{reeloId}` |
| Phone/contact fallback | `users/{uid}` |
| Reelo live-selfie approval | `reelo_profile_reviews/{reeloId}` |
| Delivered media | `booking_media` filtered by `bookingId` |
| Internal notes | `operations_notes` via `addOperationsNote` for support notes |
| Privileged admin audit | `audit_logs` |
| Force booking state | `adminForceBookingStatus` callable |
| Reelo activation approval/denial | `adminReviewReelo` callable |
| Delivery +12/+24 hours | `extendDeliveryDeadline` callable |
| Existing operational booking repairs | `adminBookingAction` callable |

## Money model shown to Operations

The dashboard intentionally keeps four concepts separate: **Customer charge**, **Reelo earning**, **Payout**, and **Refund**. It reads the corresponding booking fields when present rather than treating a single `paymentStatus` as the complete financial state.

## Documentation rule

State-changing booking actions, Reelo activation decisions, delivery deadline extensions, and support internal notes use backend/audit paths where available. Operations reasons should describe what was observed and what action was taken without storing passwords, OTPs, UPI PINs, full card details, or other authentication secrets.
