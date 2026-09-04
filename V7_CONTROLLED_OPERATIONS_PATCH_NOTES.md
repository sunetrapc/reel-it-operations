# Reel It Operations V7 — Controlled Patch

Base: `Reel_It_Operations_V6_FUNCTIONAL_BUILD.zip`.

This patch intentionally preserves the existing V6 Operations dashboard and changes only the agreed Operations surfaces.

## Added / changed

- **Feedbacks** navigation page
  - Reads support feedback already saved on `support_threads` by the controlled app patch.
  - Shows rating, optional comment, user context, booking context and submission time.
  - Search and one-click booking open where linked.

- **Editing Approval**
  - Reviews `portfolioUrl` / saved work link instead of uploaded portfolio images.
  - Approval still requires Live Verification approved.
  - Approval does not turn Editing Jobs on; app/backend still require both `canEditReels == true` and `editingApprovalStatus == approved`.

- **Reelo Accounts**
  - Editing tab displays the saved portfolio/work link.
  - Actions can update the portfolio/work link as controlled profile metadata.
  - New **Money** tab shows booking earnings and payout status.
  - Manual audited actions: place payout on hold, release payout hold, record an already-sent manual payout with reference.
  - Recording a manual payout does **not** send money.

- **Customer Accounts**
  - New **Money** tab shows charges, payment status, refund status and payment-review state by booking.
  - Manual audited actions: flag payment review, clear payment review, initiate a full Razorpay refund for an eligible captured payment.

- **Coupons** navigation page
  - Create and edit campaign codes.
  - Percentage or flat INR discount.
  - Start/end date and time.
  - Maximum campaign redemptions (`0` = unlimited).
  - Uses per customer.
  - Originals / Edited eligibility.
  - 60 / 90 / 180 minute eligibility.
  - Active/paused state and redemption count.
  - Uses the controlled app patch's authoritative backend coupon validation and Razorpay order pricing.

## Backend callables added/updated

- `adminReviewEditingApplication`
- `adminUpdateAccountProfile`
- `adminSetAccountDisabled`
- `adminUpsertCoupon`
- `adminMoneyAction`

The backend file in this package is merged forward from the **latest controlled app patch backend** rather than the older V6 backend, so deploying these Operations changes does not intentionally roll back the app-side Firebase fixes/coupon engine.

## Explicitly not changed

- Existing booking lifecycle / matching UI
- Force Booking Status / Force Action controls
- Live Verification photo behavior
- Support chat workflow
- Delivery extensions / repair / upload actions
- Safety / SOS
- deletion queue
- existing Money ledger
- public website

## Safety of manual money actions

All new state-changing money actions require an Operations reason and write an admin audit record.

`Initiate full Razorpay refund` calls Razorpay for an eligible captured payment. `Record manual payout` only records a payout that was already sent outside Reel It; it does not initiate a bank transfer.
