import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

const app = readJson('app.json').expo;
const eas = readJson('eas.json');
const pkg = readJson('package.json');
const failures = [];
const warnings = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function warn(condition, message) {
  if (!condition) {
    warnings.push(message);
  }
}

function isReverseDomain(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(value);
}

function profile(name) {
  return eas.build?.[name] || {};
}

function apiUrlFor(name) {
  return profile(name).env?.EXPO_PUBLIC_API_URL || profile(profile(name).extends || '').env?.EXPO_PUBLIC_API_URL;
}

assert(app?.name === 'SkipCast', 'app.json must keep the SkipCast app name.');
assert(app?.scheme === 'skipcast', 'app.json must define the skipcast URL scheme for native OAuth redirects.');
assert(isReverseDomain(app?.ios?.bundleIdentifier), 'iOS bundleIdentifier must be a reverse-domain app ID.');
assert(isReverseDomain(app?.android?.package), 'Android package must be a reverse-domain app ID.');
assert(app?.ios?.bundleIdentifier === app?.android?.package, 'iOS and Android app IDs should match unless there is a release reason to diverge.');
assert(app?.ios?.infoPlist?.UIBackgroundModes?.includes('audio'), 'iOS must declare UIBackgroundModes audio for background playback.');
assert(app?.android?.permissions?.includes('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK'), 'Android must declare foreground media playback permission.');
assert(Boolean(pkg.dependencies?.['expo-dev-client']), 'expo-dev-client must be installed for EAS development/emulator builds.');
warn(Boolean(app?.extra?.eas?.projectId), 'EAS projectId is not linked yet. Run an authenticated EAS init/build once before non-interactive GitHub builds.');

for (const name of ['development', 'android-emulator', 'ios-simulator', 'preview', 'production']) {
  assert(Boolean(eas.build?.[name]), `eas.json must include a ${name} build profile.`);
}

assert(profile('android-emulator').android?.buildType === 'apk', 'android-emulator profile must build an APK.');
assert(profile('ios-simulator').ios?.simulator === true, 'ios-simulator profile must build a simulator app.');
assert(profile('preview').android?.buildType === 'apk', 'preview profile must build an Android APK.');
assert(profile('production').android?.buildType === 'app-bundle', 'production profile must build a Google Play AAB.');
assert(eas.submit?.production !== undefined, 'eas.json must include a production submit profile.');

for (const name of ['development', 'preview', 'production']) {
  const apiUrl = apiUrlFor(name);
  assert(typeof apiUrl === 'string' && apiUrl.startsWith('https://'), `${name} profile must set EXPO_PUBLIC_API_URL to HTTPS.`);
  warn(!/trycloudflare\.com/i.test(apiUrl || ''), `${name} profile uses a temporary Cloudflare tunnel. Replace it with a permanent HTTPS API before store release.`);
}

if (warnings.length) {
  console.warn('Native config warnings:');
  for (const message of warnings) {
    console.warn(`- ${message}`);
  }
}

if (failures.length) {
  console.error('Native config failures:');
  for (const message of failures) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

console.log('Native config looks ready for Expo Android/iOS builds.');
