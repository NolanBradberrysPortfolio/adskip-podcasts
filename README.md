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

GitHub Pages is static, so RSS and ad-scan features need the local API exposed through HTTPS. For a temporary phone demo with ad skipping, keep this computer awake and run the launcher:

```powershell
.\scripts\start-local-ai-backend.ps1
```

If `OPENAI_API_KEY` is set, the launcher uses the faster OpenAI transcription and ad-classification path. If no key is set, it enables local Whisper transcription through Transformers.js and uses transcript cues to find likely ad reads. The first local run downloads the Whisper model and local scans are CPU-heavy.

The launcher starts `npm run server:start`, starts Cloudflare Tunnel, waits for the `https://...trycloudflare.com` URL, and triggers the GitHub Pages workflow with that API URL. For this local demo it allows unauthenticated analysis but limits analysis to a small number of requests per hour; stop it when you are done:

```powershell
.\scripts\stop-local-ai-backend.ps1
```

To start the tunnel without redeploying Pages automatically:

```powershell
.\scripts\start-local-ai-backend.ps1 -NoDeploy
```

This tunnel setup is for testing. If the tunnel restarts, the backend URL changes and Pages must be redeployed.

`eas.json` points native development, preview, and production builds at the same temporary tunnel so the current builds can use RSS/import features. Replace `EXPO_PUBLIC_API_URL` there with a permanent HTTPS API before shipping a real iOS or Android release.

## AI Analysis

If `OPENAI_API_KEY` is set, `/api/analyze` downloads audio files under `MAX_TRANSCRIPTION_AUDIO_MB`, transcribes them with `OPENAI_TRANSCRIBE_MODEL`, then uses `OPENAI_AD_DETECTION_MODEL` to classify timestamped transcript windows into ad ranges. The default setup keeps `whisper-1` for timestamped transcription and uses `gpt-4o-mini` for the small ad-detection pass.

If no key is set, set `LOCAL_WHISPER_TRANSCRIBE=true` to run no-API-key local Whisper transcription on this computer:

```powershell
$env:LOCAL_WHISPER_TRANSCRIBE="true"
$env:LOCAL_WHISPER_MODEL="Xenova/whisper-tiny.en"
$env:LOCAL_WHISPER_MAX_AUDIO_MB="120"
$env:LOCAL_WHISPER_MAX_SECONDS="1200"
npm run server:start
```

Local Whisper scans only the first `LOCAL_WHISPER_MAX_SECONDS` of an episode, defaults to the small `Xenova/whisper-tiny.en` model, and uses transcript cue rules for likely sponsor segments. It is useful for a private local demo, not a production-scale analyzer.

If no analysis engine is enabled or the episode audio is too large, the API returns `unavailable` with no skip segments. The app does not auto-skip fake timestamps.

Use an OpenAI Platform API key on the private API server:

```powershell
$env:CORS_ORIGINS="https://nolanbradberrysportfolio.github.io"
$env:OPENAI_API_KEY="sk-..."
$env:ANALYZE_API_TOKEN="choose-a-private-random-token"
$env:OPENAI_TRANSCRIBE_MODEL="whisper-1"
$env:OPENAI_AD_DETECTION_MODEL="gpt-4o-mini"
npm run server:start
```

For GitHub Pages builds that should call a token-protected analyzer, also set `EXPO_PUBLIC_ANALYZE_API_TOKEN` in the Pages build environment to the same token. Do not commit real keys or tokens.

OpenClaw/Codex OAuth can use a signed-in ChatGPT/Codex subscription for chat/model turns, and Codex CLI can classify text. On this install, OpenClaw's batch audio transcription path still routes through the regular OpenAI audio transcription provider, not the Codex chat route. That is why SkipCast uses either a Platform API key for OpenAI transcription or the local Whisper path above for no-key transcription.

The app stores timestamp metadata and seeks over ranges during foreground playback. It does not redistribute edited copies of podcast audio.

Production builds should set `EXPO_PUBLIC_API_URL` to a deployed HTTPS API. The default `localhost` URL is for local web development only.

For a deployed API, set `CORS_ORIGINS` to the exact app origins allowed to call the server and tune `RATE_LIMIT_MAX_REQUESTS`, `ANALYZE_RATE_LIMIT_MAX_REQUESTS`, `ANALYZE_MAX_CONCURRENT`, `MAX_EPISODES_PER_FEED`, `OPML_MAX_CHARS`, `OPML_MAX_NODES`, `OPML_MAX_DEPTH`, and `OPML_VALIDATE_CONCURRENCY` for your hosting/cost limits. In `NODE_ENV=production`, or whenever `OPENAI_API_KEY` is enabled without `ALLOW_ANY_CORS_ORIGIN=true`, the API refuses to start if `CORS_ORIGINS` is empty.

For shared/private deployments, set `ANALYZE_API_TOKEN` on the API and the matching `EXPO_PUBLIC_ANALYZE_API_TOKEN` in the client build environment to reduce casual transcription spend abuse. The API now requires `ANALYZE_API_TOKEN` whenever `OPENAI_API_KEY` is set, unless `ALLOW_UNAUTHENTICATED_ANALYZE=true` is set for local development only.

Do not treat `EXPO_PUBLIC_ANALYZE_API_TOKEN` as public-app authentication. Web, APK, and IPA users can extract bundled public values. A public release needs real user auth, per-user quotas, billing controls, and abuse monitoring around `/api/analyze`.
