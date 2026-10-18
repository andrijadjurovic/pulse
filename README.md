# Pulse — Uptime Monitoring Platform

Pulse is an uptime-monitoring prototype. The browser uses Firebase Authentication for sign-in. The Node.js server verifies Firebase ID tokens with Firebase Authentication, stores accounts/monitors/check history in Cloud Firestore, and runs scheduled endpoint checks. Custom JavaScript checks run in a separate restricted Docker container.

## Requirements

- Node.js 22+
- A Firebase project with Email/Password Authentication and Cloud Firestore enabled
- Google Cloud Application Default Credentials for the Node server
- Docker, only if you want custom JavaScript monitors

## Connect your Firebase project

1. Create a project at [Firebase Console](https://console.firebase.google.com/).
2. In **Authentication → Sign-in method**, enable **Email/Password**.
3. Create the **Cloud Firestore** database. Choose its region carefully; Firestore's database region cannot be changed later.
4. In **Project settings → General**, register a Web app and copy its Web API key, Auth domain, Project ID, and App ID.
5. In the repository, copy `.env.example` to `.env` and set `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, and `FIREBASE_APP_ID`.
6. Give the Node server Google credentials. For local development, either sign in with Google Cloud Application Default Credentials (`gcloud auth application-default login`) using an account with access to the project, or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON file stored **outside** this repository. Hosts without Google Cloud Application Default Credentials (such as Vercel) must set `FIREBASE_SERVICE_ACCOUNT_JSON` to the complete service-account JSON as a protected environment variable. Grant the service account the `Cloud Datastore User` role. Never expose or commit the credentials. On managed Google Cloud, prefer the runtime's attached service account/workload identity.
7. Deploy `firestore.rules`. These rules deliberately deny direct browser reads and writes; the trusted Node server uses the Firebase Admin SDK after verifying each user's Firebase ID token:

   ```sh
   npx firebase-tools login
   npx firebase-tools use --add
   npx firebase-tools deploy --only firestore:rules
   ```

   Select your Firebase project when prompted.
8. Install dependencies and run the app:

   ```sh
   npm install
   npm start
   ```

   Visit [http://localhost:3000](http://localhost:3000). Firebase's Web API key is client configuration, not a service-account secret; the server uses Firebase Authentication's `accounts:lookup` endpoint to validate ID tokens, while Firestore access is protected by Admin SDK ownership checks and the deny-all client rules.

`npm start` bundles the Firebase browser SDK and then starts the Node server. The server reads `.env` at startup. If Firebase is not configured, the app displays a setup message instead of silently using local storage. The app no longer reads or writes the previous local JSON datastore.

## Test locally with Firebase emulators

The Firebase emulators allow development without creating a cloud project or using a service-account key. Java and the Firebase CLI are required.

1. In `.env`, use a demo project ID and dummy web-app configuration:

   ```dotenv
   FIREBASE_API_KEY=demo-api-key
   FIREBASE_AUTH_DOMAIN=demo-pulse.firebaseapp.com
   FIREBASE_PROJECT_ID=demo-pulse
   FIREBASE_APP_ID=1:1234567890:web:demo
   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
   ```

2. In one terminal, start the emulators:

   ```sh
   npx firebase-tools emulators:start --project demo-pulse --only auth,firestore
   ```

3. In a second terminal, start Pulse with `npm start`, then create an account and add monitors. Emulator data is local and is not sent to a production Firebase project.

## How it works

- **Authentication:** Email/password accounts are managed by Firebase Authentication. The browser sends Firebase ID tokens to the Node API; the server verifies each token using Firebase Authentication's `accounts:lookup` endpoint before serving a user's data.
- **Firestore:** user profiles are in `users/{uid}`, monitors in `monitors/{monitorId}`, and check results in `monitors/{monitorId}/checks/{checkId}`. The Admin SDK bypasses Firestore Security Rules, so API routes explicitly check monitor ownership.
- **Scheduling:** the Node server loads monitors from Firestore at startup and schedules checks in-process. It runs one scheduler process; keep that process alive. This is not a distributed job queue or a multi-region monitoring service.
- **History and statistics:** up to 500 checks per monitor are retained. The dashboard's uptime and average response time use the latest 30 checks; the detail view can fetch up to 500.
- **Supported checks:** Status Code; Text Contains; Response Time; TCP Port Availability.
- **Custom JavaScript:** the script must synchronously return `true` or `false`. It receives response status, status text, an allowlist of headers, a response body capped at 128 KiB, and response time. Script size is limited to 8 KiB.

## Enable custom JavaScript checks

Install/start Docker on the same machine as Pulse and build the isolated runner image once:

```sh
docker build -t pulse-custom-check:local ./sandbox
```

The runner uses no network, a read-only container filesystem, no Linux capabilities, a non-root user, a 96 MiB memory limit, a half-core CPU limit, a 16-process limit, a 5-second JavaScript execution timeout, and a 15-second outer deadline. At most two custom checks run concurrently. If Docker or the image is missing, the check is recorded as DOWN; the server never executes user code as a fallback.

## Prototype limitations

This is an educational prototype, not a production monitoring service. The scheduler runs in one Node process; deploy exactly one checker instance or add a distributed queue/lease before scaling horizontally. Checks originate from this server's network location. Configure outbound network restrictions before accepting untrusted monitor URLs. There is no alert delivery, billing, multi-region probing, or operational SLA. Do not commit `.env` or service-account credentials.
