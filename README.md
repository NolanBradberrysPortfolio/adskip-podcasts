# SkipCast

Cross-platform podcast player MVP for web, iOS, and Android. It subscribes to normal podcast RSS feeds, plays enclosure audio, stores local subscriptions, imports pasted OPML, and auto-skips detected ad segments during playback.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Web runs from Expo, and the API runs on `http://localhost:4300`.

For iOS or Android on a physical device during development, set `EXPO_PUBLIC_API_URL` to your computer's LAN URL, for example:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.25:4300 npm run android
```

On Windows PowerShell:

```powershell
$env:EXPO_PUBLIC_API_URL="http://192.168.1.25:4300"; npm run android
```

## Scripts

- `npm run dev` starts the API and web app together.
- `npm run web` starts only the web app.
- `npm run ios` starts Expo for the iOS simulator on macOS. On Windows, use Expo Go QR scanning or an EAS development build on a physical iPhone.
- `npm run android` starts Expo for Android.
- `npm run server:start` starts only the RSS/analyzer API.
- `npm run test:phone-pages` checks the live phone web playback flow.
- `npm run test:import-phone-pages` checks live phone web OPML and Spotify-matching import flows.

## Importing Podcasts

Use the `Import` button to bring subscriptions into SkipCast.

- Apple Podcasts: export or share an OPML subscription file, then choose the file or paste OPML.
- OPML: paste or upload OPML from podcast apps that support subscription export.
- Spotify: the backend can match Spotify saved shows to public RSS feeds. Without Spotify credentials, use the show-list matcher with lines like `Up First | NPR`.

Real Spotify sign-in requires `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REDIRECT_URI` on the API server. Spotify does not expose RSS URLs for every show, so the app uses public podcast search matches and asks the user to review lower-confidence results.

## Phone Web Demo

The public web app is deployed to GitHub Pages:

```text
https://nolanbradberrysportfolio.github.io/adskip-podcasts/
```

GitHub Pages is static, so RSS features need the local API exposed through HTTPS. For a temporary phone demo, keep this computer awake and run:

```powershell
$env:CORS_ORIGINS="https://nolanbradberrysportfolio.github.io"
$env:OPENAI_API_KEY=""
npm run server:start
```

In another PowerShell window:

```powershell
.\tools\cloudflared-386.exe tunnel --url http://localhost:4300 --no-autoupdate
```

Copy the printed `https://...trycloudflare.com` URL, then redeploy Pages with:

```powershell
gh workflow run pages.yml --repo NolanBradberrysPortfolio/adskip-podcasts --ref main --field api_url="https://YOUR-TUNNEL.trycloudflare.com"
```

This tunnel setup is for testing. If the tunnel restarts, the backend URL changes and Pages must be redeployed.

## AI Analysis

If `OPENAI_API_KEY` is set, `/api/analyze` downloads audio files under `MAX_TRANSCRIPTION_AUDIO_MB`, transcribes them with `OPENAI_TRANSCRIBE_MODEL`, and creates skip segments from timestamped transcript cues.

If no key is set or the episode audio is too large, the API returns `unavailable` with no skip segments. The app does not auto-skip fake timestamps.

The app stores timestamp metadata and seeks over ranges during foreground playback. It does not redistribute edited copies of podcast audio.

Production builds should set `EXPO_PUBLIC_API_URL` to a deployed HTTPS API. The default `localhost` URL is for local web development only.

For a deployed API, set `CORS_ORIGINS` to the exact app origins allowed to call the server and tune `RATE_LIMIT_MAX_REQUESTS`, `ANALYZE_RATE_LIMIT_MAX_REQUESTS`, `ANALYZE_MAX_CONCURRENT`, `MAX_EPISODES_PER_FEED`, `OPML_MAX_CHARS`, `OPML_MAX_NODES`, `OPML_MAX_DEPTH`, and `OPML_VALIDATE_CONCURRENCY` for your hosting/cost limits. In `NODE_ENV=production`, or whenever `OPENAI_API_KEY` is enabled without `ALLOW_ANY_CORS_ORIGIN=true`, the API refuses to start if `CORS_ORIGINS` is empty.

For shared/private deployments, set `ANALYZE_API_TOKEN` on the API and the matching `EXPO_PUBLIC_ANALYZE_API_TOKEN` in the client build environment to reduce casual transcription spend abuse. The API now requires `ANALYZE_API_TOKEN` whenever `OPENAI_API_KEY` is set, unless `ALLOW_UNAUTHENTICATED_ANALYZE=true` is set for local development only.

Do not treat `EXPO_PUBLIC_ANALYZE_API_TOKEN` as public-app authentication. Web, APK, and IPA users can extract bundled public values. A public release needs real user auth, per-user quotas, billing controls, and abuse monitoring around `/api/analyze`.
