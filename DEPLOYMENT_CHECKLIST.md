# Reel It Owner Desk deployment checklist

## 1. Update the GitHub Pages repository

Replace the files in `sunetrapc/reel-it-operations` with the contents of this folder and commit them to `main`.

The dashboard intentionally has no public account-creation flow. An operator must already exist in Firebase Authentication and must have an active `admins/{uid}` Firestore document.

## 2. Remove the old custom domain

In GitHub, open **Settings → Pages** and clear the custom-domain field. Delete any existing `CNAME` file from the repository. At the DNS provider, remove the `operations` CNAME record if `operations.thereelit.com` must stop resolving.

Use the normal GitHub Pages address for this private dashboard.

## 3. Configure Firebase App Check

Create a reCAPTCHA v3 site key for the GitHub Pages hostname and paste its public site key into `recaptchaSiteKey` in `firebase-config.js`.

Do not place service-account credentials, private keys, or admin SDK secrets in this repository.

## 4. Deploy the matching Firebase backend

From the companion Reel It v15 project, authenticate Firebase CLI and run:

```bash
firebase deploy --only functions,firestore:rules,firestore:indexes,storage
```

The owner actions will not work until these callable functions and rules are deployed.

## 5. Create an owner account safely

1. Create the user in Firebase Authentication.
2. Copy that user's Firebase UID.
3. Create `admins/{uid}` in Firestore with `active: true`.
4. Sign in through the Owner Desk.

Do not add a public sign-up page. Creating a normal Reel It app account must never grant owner access.

## 6. Smoke test

1. Sign in with an approved admin and reject a normal app user.
2. Open Operations and confirm exceptions load.
3. Open a support thread and send a test reply to the app.
4. Open the linked booking control room.
5. Add an internal note and confirm it appears in Audit Log.
6. Review a test Reelo application.
7. Test a harmless customer notification before testing state-changing actions.
