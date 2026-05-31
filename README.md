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

Firebase Cloud Functions send calendar invites automatically when a schedule is created. The app also writes to `mailRequests` when a user clicks Resend Invite, and a second function sends that email.

Set these Firebase Function secrets before deploying:

- `SMTP_HOST`, for example `smtp.gmail.com`
- `SMTP_PORT`, usually `587`
- `SMTP_USER`, the sending mailbox
- `SMTP_PASSWORD`, an app password or SMTP password
- `MAIL_FROM`, the sender shown on the email, for example `"QC Scheduler" <carlitros4@gmail.com>`

Deploy functions and Firestore rules with:

```powershell
npx firebase-tools login
npx firebase-tools use <your-firebase-project-id>
npx firebase-tools functions:secrets:set SMTP_HOST
npx firebase-tools functions:secrets:set SMTP_PORT
npx firebase-tools functions:secrets:set SMTP_USER
npx firebase-tools functions:secrets:set SMTP_PASSWORD
npx firebase-tools functions:secrets:set MAIL_FROM
npx firebase-tools deploy --only functions,firestore:rules
```

For Gmail, create an app password in your Google Account security settings and use that as `SMTP_PASSWORD`.
