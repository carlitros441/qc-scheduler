# QC Scheduler

Static Firebase web app for managing QC schedules, products, protocols, personnel, and calendar exports.

## Publish On GitHub Pages

1. In Firebase Console, enable Email/Password authentication.
2. Create user accounts yourself in Firebase Console under Authentication > Users. The public app does not allow self-registration.
3. In Firebase Console, create or confirm a Web App and copy its Firebase config.
4. Add these GitHub repository secrets from your Firebase Web App config:
   - `FIREBASE_API_KEY`
   - `FIREBASE_AUTH_DOMAIN`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_STORAGE_BUCKET`
   - `FIREBASE_MESSAGING_SENDER_ID`
   - `FIREBASE_APP_ID`
5. In GitHub, set Pages source to GitHub Actions.
6. Push to `master`; the included workflow publishes the static app and writes `firebase-config.js` during deployment.

For local preview only, create `frontend/public/firebase-config.js` from `frontend/public/firebase-config.example.js` and paste your Firebase Web App config there.

Do not commit service account keys, admin SDK credentials, or SMTP passwords. This app uses Firebase client SDK authentication and Firestore access from the browser, so access control belongs in Firestore security rules.

## Firestore Collections

- `schedules`
- `products`
- `protocols`
- `personnel`
- `mailRequests`

The app expects signed-in users to read and write these collections. All authorized accounts connect to the same Firebase project and the same shared Firestore database.

`firestore.rules` contains a starter rule set that allows only signed-in users to access the app collections. With these rules, account creation stays under your control in Firebase Auth while every signed-in user has access to the same database.

## Automatic Email Invites

Email invites are sent by a GitHub Actions worker, not Firebase Cloud Functions. This avoids the Firebase Blaze/pay-as-you-go requirement.

How it works:

1. New schedules are saved with `email_status: pending`.
2. Users can click Resend Invite, which creates a `mailRequests` document.
3. `.github/workflows/send-emails.yml` runs every 5 minutes and can also be run manually.
4. The worker reads pending Firestore records, sends `.ics` calendar invites through SMTP, and marks records as `sent` or `failed`.

Add these GitHub repository secrets:

- `FIREBASE_SERVICE_ACCOUNT_JSON`, a Firebase Admin service account JSON for this project
- `SMTP_HOST`, for example `smtp.gmail.com`
- `SMTP_PORT`, usually `587`
- `SMTP_USER`, the sending mailbox
- `SMTP_PASSWORD`, an app password or SMTP password
- `MAIL_FROM`, the sender shown on the email, for example `"QC Scheduler" <sender@example.com>`

For Gmail, create an app password in your Google Account security settings and use that as `SMTP_PASSWORD`. Do not commit service account JSON files or SMTP passwords.
