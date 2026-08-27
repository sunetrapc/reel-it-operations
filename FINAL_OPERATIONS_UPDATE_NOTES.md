# Operations Dashboard Practical Update

## Implemented

- Preserved the existing white + blue dashboard visual language.
- Support is now a real-time inbox rather than a one-time Firestore fetch.
- Global unread Support badge continues updating while the owner is on other dashboard pages.
- New incoming support messages generate an in-dashboard toast.
- Support filters: All, Customers, Reelos, Unread.
- Search supports booking/customer/Reelo references and existing identifiers.
- Multiple conversations can remain open as tabs.
- Two-way support messages stream live; Enter sends and Shift+Enter makes a new line.
- Booking context appears beside the conversation with booking, Customer, Reelo, capture device, session, delivery, and location information.
- Booking drawer shows human-readable references.
- Owner Override / Force Status is available from booking context and the booking drawer.
- Status override calls the owner-only Cloud Function and creates an audit record.

## Deployment

Deploy/copy this dashboard using the same hosting method you currently use for the Operations site. The dashboard expects the updated Cloud Functions and Firebase rules from the paired app package to be deployed first.
