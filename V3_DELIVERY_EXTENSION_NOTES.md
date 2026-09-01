# Reel It Operations — V3 Delivery Deadline Control

- Booking drawer shows the active delivery target when present.
- For active pending delivery, Operations can approve +12h or +24h.
- A reason is required and the action calls the V3 `extendDeliveryDeadline` backend function.
- The customer and Reelo are notified by the backend; the internal reason stays private.
