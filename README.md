# JARVIS Android app

Front-end only chat app (Vite + Capacitor). Talks to your JARVIS backend with automatic failover
between a primary URL (Render) and a backup URL (Vercel).

## Build the APK with GitHub Actions (no Android Studio needed)
1. Create a new GitHub repo and push this folder to it.
2. Open the repo's **Actions** tab, open the latest "Build APK" run.
3. Download the `jarvis-debug-apk` artifact, unzip it, and install `app-debug.apk` on your phone
   (allow "Install unknown apps" when asked).

## Build locally
```
npm install
npm run build
npx cap add android
npx cap sync
cd android && ./gradlew assembleDebug
```
APK: `android/app/build/outputs/apk/debug/app-debug.apk`

## First launch: Settings
- **Backend URL (primary):** `https://jarvis-ukcy.onrender.com`  (pre-filled)
- **Backup URL:** `https://jarviss-eight.vercel.app`  (pre-filled)
- **App token:** the token your backend expects in the `X-API-Token` header
- Tap **Test connection** (checks both URLs), then **Save**.

## How failover works
- On open (and after 10 min idle) the app calls `/health` on both servers at once; whichever answers first is used.
- If neither answers, it shows "Waking up the server..." and retries every 5 s for up to 90 s.
- If a request fails mid-chat (network error or 5xx), it is retried once on the other server.
- 400 / 401 / 413 errors are shown as-is and do NOT trigger failover.

## Databases
The MongoDB connection strings do NOT go in this app. Put them only in the backend's environment
variables (Render: Environment tab; Vercel: Project Settings > Environment Variables), e.g. `MONGODB_URI`.
Both deployments use the same database so history is shared whichever server answers.
Atlas must allow connections from the hosts (Network Access: 0.0.0.0/0 for serverless hosts).
