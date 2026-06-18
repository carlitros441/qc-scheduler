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
- `stabilityProtocols`
- `stabilityPrograms`
- `personnel`
- `mailRequests`
- `auditTrail`

The app expects signed-in users to read and write these collections. All authorized accounts connect to the same Firebase project and the same shared Firestore database.

`firestore.rules` contains a starter rule set that allows only signed-in users to access the app collections. With these rules, account creation stays under your control in Firebase Auth while every signed-in user has access to the same database. Audit entries can be created and read by signed-in users, but cannot be edited or deleted through the app rules.

## Automatic Email Invites

Email invites are sent by Google Apps Script, not GitHub Actions or Firebase Cloud Functions. This avoids the Firebase Blaze/pay-as-you-go requirement and keeps the worker on Google's scheduler.

How it works:

1. New schedules are saved with `email_status: pending`.
2. Users can click Resend Invite, which creates a `mailRequests` document.
3. A Google Apps Script time trigger runs `processPendingEmailInvites` every minute.
4. The script reads pending Firestore records, sends `.ics` calendar invites through Gmail, and marks records as `sent` or `failed`.
5. A second weekly trigger can run `sendWeeklyStabilityReminder` every Monday at 8 AM and email upcoming incomplete QC Stability tests to the Personnel record named `Stability Admin`.

Setup:

1. Create a Google Apps Script project at https://script.google.com/.
2. Copy `google-apps-script/Code.gs` into the Apps Script editor.
3. Open Project Settings > Script Properties and add:
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY`
   - `MAIL_FROM_EMAIL`
   - `MAIL_FROM_NAME`
4. Use the Firebase Admin service account JSON for the Firebase values. Paste `private_key` into `FIREBASE_PRIVATE_KEY`; keep the `\n` line breaks exactly as shown in the JSON.
5. Run `installEmailTrigger` once from Apps Script and approve permissions.
6. Run `processPendingEmailInvites` once to test.
7. Create an active Personnel record named `Stability Admin` with the email address for weekly stability reminders.
8. Run `installStabilityReminderTrigger` once from Apps Script.
9. Run `sendWeeklyStabilityReminder` once to test the reminder digest.

Do not commit service account JSON files, private keys, or SMTP passwords.
