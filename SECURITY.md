# Security notes

- Keep the repository private even though Firebase rules remain the real data boundary.
- Require multi-factor authentication for the GitHub account and Firebase owners.
- Restrict the `admins` collection to trusted owner UIDs only.
- Do not weaken Firestore rules to fix UI errors.
- Keep Firebase App Check enabled for callable Cloud Functions.
- Review admin access regularly and set `active: false` before removing former operators.
- Treat downloaded profile images, support messages, reports, SOS data, and payout information as confidential.
- Never request or store customer passwords, OTPs, UPI PINs, CVVs, or full banking/card credentials.
