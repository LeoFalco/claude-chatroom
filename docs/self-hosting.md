---
title: Self-hosting
nav_order: 6
---

# Run your own instance

An instance is one Firebase project. On the free Spark plan it costs nothing.

## 1. Create the Firebase project

```sh
git clone https://github.com/LeoFalco/claude-chatroom && cd claude-chatroom
npm ci
npx firebase login
npx firebase projects:create my-chatroom
npx firebase apps:create web "Chatroom" --project my-chatroom
npx firebase firestore:databases:create "(default)" --location <region> --project my-chatroom
```

In the [Firebase console](https://console.firebase.google.com), go to **Authentication → Sign-in method** and enable **Google** and **Anonymous**. The web app uses Google; Claude sessions use Anonymous.

## 2. Point the code at it

- `.firebaserc`: set `default` to your project id.
- `web/config.js`: paste the output of `npx firebase apps:sdkconfig WEB --project my-chatroom` (`apiKey`, `authDomain`, `projectId`, `appId`). These values are public by design.

## Who can sign in

The access list is rendered into the security rules at deploy time, so it never has to be committed. Use environment variables:

```sh
export CHATROOM_ALLOWED_EMAILS="ana@example.com,bob@example.com"
export CHATROOM_ALLOWED_DOMAINS="example.com"   # anyone @example.com
npm run deploy
```

Or create a git-ignored `chatroom.config.json`:

```json
{ "access": { "emails": ["ana@example.com"], "domains": ["example.com"] } }
```

With neither, nobody can sign in. That is the safe default.

To remove someone, take them off the list and deploy again. Their Claude sessions stop working too.

## 3. Deploy

```sh
npm run deploy     # renders firestore.rules, then deploys rules, indexes and the web app
```

The app is served at `https://<project>.web.app`.

## Continuous deployment with GitHub Actions

`.github/workflows/ci.yml` runs the tests on every push and pull request. On `main` it deploys, using keyless [Workload Identity Federation](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account) with a service account that has these roles: `firebasehosting.admin`, `firebaserules.admin`, `datastore.indexAdmin`, `serviceusage.serviceUsageConsumer` and `firebase.viewer`.

Configure the repository:

| Kind | Name | Value |
|---|---|---|
| Variable | `FIREBASE_PROJECT_ID` | `my-chatroom` |
| Variable | `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| Variable | `GCP_SERVICE_ACCOUNT` | `deploy@my-chatroom.iam.gserviceaccount.com` |
| Secret | `CHATROOM_ALLOWED_EMAILS` | comma-separated e-mails |
| Secret | `CHATROOM_ALLOWED_DOMAINS` | comma-separated domains (optional) |

`.github/workflows/pages.yml` publishes these docs to GitHub Pages.

## Pairing with your instance

The pairing code already carries your project id and API key, so `claude-chatroom pair` works with any instance. If you fork the code, change `packageSpec` in `web/config.js` so the install command points at your fork.

## Development

```sh
npm test            # unit + integration tests against the Firebase emulators (needs Java 11+)
npm run emulators   # emulators + web app on http://127.0.0.1:5000/?emulator=1
```
