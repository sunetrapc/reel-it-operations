# Reel It Operations Dashboard

An owner-only GitHub Pages control room for Reel It. It connects to the existing Firebase project and turns app events into live operational decisions.

- Operations Inbox and live booking control room
- Reelo application approvals
- SOS alerts
- Human support conversations
- Resolved-support feedback
- Content delivery disputes
- Refund exceptions
- Payout operations
- Safety reports
- Account deletion requests

## Important security model

This is a private admin interface, although GitHub Pages serves the HTML publicly. No operational data becomes public: Firebase Authentication and the deployed Firestore/Storage rules determine who can read or change data.

An account is admitted only when this document exists:

```text
admins/{firebase-auth-uid}
active: true
```

Never place service-account JSON, Razorpay secrets, private keys, passwords, or Admin SDK credentials in this repository. The Firebase web configuration already included here is a public project identifier, not an administrator credential.

## Access policy

There is no public account-creation option. Owner accounts must be created deliberately in Firebase Authentication and activated through `admins/{uid}` with `active: true`.

## Before publishing

1. In Firebase Console, open **Authentication → Settings → Authorized domains**.
2. Add your GitHub Pages domain, such as `yourname.github.io`.
3. Authorize only the GitHub Pages hostname you use.
4. Open **App Check → Apps → Web app** and configure a reCAPTCHA v3 provider.
5. Put the public reCAPTCHA site key in `firebase-config.js` as `recaptchaSiteKey`.
6. Deploy the latest Reel It Cloud Functions and Firestore rules from the Android launch candidate. Callable owner actions enforce App Check.

## Publish on GitHub Pages

1. Create a new private GitHub repository.
2. Unzip this package and upload all contents, including `.github`.
3. Commit to the `main` branch.
4. Open **Settings → Pages**.
5. Under **Build and deployment**, select **GitHub Actions**.
6. The included workflow publishes the site automatically.

This release intentionally has no custom domain. Use the normal `YOUR-USERNAME.github.io/reel-it-operations/` address. Remove any custom domain from GitHub Pages settings and remove the obsolete `operations` DNS record.

## Edit the dashboard

- `index.html`: page structure and login screen
- `styles.css`: colors, spacing, cards, mobile layout
- `control-room.css`: live-search, booking timeline, support context, and responsive control-room layouts
- `app.js`: Firebase authentication, queries, queues, and owner actions
- `firebase-config.js`: Firebase web app and App Check configuration
- `.github/workflows/deploy-pages.yml`: automatic deployment

There is no build command or framework. Refresh the browser after editing locally, or commit to `main` and let GitHub Pages redeploy.

## Local preview

Because the dashboard uses JavaScript modules, do not open `index.html` directly as a file. Run a simple web server from the repository directory:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` and add `localhost` to Firebase Authorized domains for local testing.

## Admin account setup

Create owner accounts only in Firebase Authentication. In Firestore, manually create an `admins/{uid}` document with `active: true`. No visitor can create an account from this dashboard.
