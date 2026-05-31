# QC Scheduler

Static Firebase web app for managing QC schedules, products, protocols, personnel, and calendar exports.

## Publish On GitHub Pages

1. In Firebase Console, enable Email/Password authentication.
2. In Firebase Console, create or confirm a Web App and copy its Firebase config.
3. Add these GitHub repository secrets from your Firebase Web App config:
   - `FIREBASE_API_KEY`
   - `FIREBASE_AUTH_DOMAIN`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_STORAGE_BUCKET`
   - `FIREBASE_MESSAGING_SENDER_ID`
   - `FIREBASE_APP_ID`
4. In GitHub, set Pages source to GitHub Actions.
5. Push to `master`; the included workflow publishes the static app and writes `firebase-config.js` during deployment.

For local preview only, create `frontend/public/firebase-config.js` from `frontend/public/firebase-config.example.js` and paste your Firebase Web App config there.

Do not commit service account keys, admin SDK credentials, or SMTP passwords. This app uses Firebase client SDK authentication and Firestore access from the browser, so access control belongs in Firestore security rules.

## Firestore Collections

- `schedules`
- `products`
- `protocols`
- `personnel`

The app expects signed-in users to read and write these collections.

`firestore.rules` contains a starter rule set that allows only signed-in users to access the app collections. Tighten these rules further if different roles need different access.
