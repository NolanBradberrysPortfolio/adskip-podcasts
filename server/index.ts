import 'dotenv/config';
import express from 'express';
import Parser from 'rss-parser';
import OpenAI from 'openai';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { LookupOptions } from 'node:dns';
import dns from 'node:dns/promises';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import type { AdSegment, AnalysisResult, ImportFeedCandidate, PodcastEpisode, PodcastFeed, SegmentCategory, SpotifyImportShow } from '../src/types';

const PORT = readPositiveInteger('PORT', 4300);
const MAX_AUDIO_BYTES = readPositiveInteger('MAX_TRANSCRIPTION_AUDIO_MB', 24) * 1024 * 1024;
const MAX_FEED_BYTES = readPositiveInteger('MAX_FEED_XML_MB', 3) * 1024 * 1024;
const MAX_EPISODES_PER_FEED = readPositiveInteger('MAX_EPISODES_PER_FEED', 150);
const FETCH_TIMEOUT_MS = readPositiveInteger('FETCH_TIMEOUT_MS', 15000);
const MAX_REDIRECTS = 4;
const RATE_LIMIT_WINDOW_MS = readPositiveInteger('RATE_LIMIT_WINDOW_MS', 60_000);
const RATE_LIMIT_MAX_REQUESTS = readPositiveInteger('RATE_LIMIT_MAX_REQUESTS', 80);
const ANALYZE_RATE_LIMIT_WINDOW_MS = readPositiveInteger('ANALYZE_RATE_LIMIT_WINDOW_MS', 60 * 60_000);
const ANALYZE_RATE_LIMIT_MAX_REQUESTS = readPositiveInteger('ANALYZE_RATE_LIMIT_MAX_REQUESTS', 6);
const ANALYZE_MAX_CONCURRENT = readPositiveInteger('ANALYZE_MAX_CONCURRENT', 2);
const OPML_MAX_CHARS = readPositiveInteger('OPML_MAX_CHARS', 200_000);
const OPML_MAX_NODES = readPositiveInteger('OPML_MAX_NODES', 2_000);
const OPML_MAX_DEPTH = readPositiveInteger('OPML_MAX_DEPTH', 24);
const OPML_VALIDATE_CONCURRENCY = readPositiveInteger('OPML_VALIDATE_CONCURRENCY', 8);
const ANALYZE_API_TOKEN = process.env.ANALYZE_API_TOKEN?.trim();
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOW_UNAUTHENTICATED_ANALYZE = process.env.ALLOW_UNAUTHENTICATED_ANALYZE === 'true';
const ALLOW_ANY_CORS_ORIGIN = process.env.ALLOW_ANY_CORS_ORIGIN === 'true';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID?.trim();
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET?.trim();
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI?.trim();
const SPOTIFY_IMPORT_MAX_SHOWS = readPositiveInteger('SPOTIFY_IMPORT_MAX_SHOWS', 100);
const SPOTIFY_MATCH_RATE_LIMIT_WINDOW_MS = readPositiveInteger('SPOTIFY_MATCH_RATE_LIMIT_WINDOW_MS', 60_000);
const SPOTIFY_MATCH_RATE_LIMIT_MAX_REQUESTS = readPositiveInteger('SPOTIFY_MATCH_RATE_LIMIT_MAX_REQUESTS', 12);
const SPOTIFY_SESSION_MAX_ENTRIES = readPositiveInteger('SPOTIFY_SESSION_MAX_ENTRIES', 500);
const PODCAST_SEARCH_CACHE_MAX_ENTRIES = readPositiveInteger('PODCAST_SEARCH_CACHE_MAX_ENTRIES', 500);
const PODCAST_SEARCH_CACHE_TTL_MS = readPositiveInteger('PODCAST_SEARCH_CACHE_TTL_MS', 10 * 60_000);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin: string) => origin.trim())
  .filter(Boolean);
const GITHUB_PAGES_ORIGIN = 'https://nolanbradberrysportfolio.github.io';
const HAS_EXPLICIT_CORS = CORS_ORIGINS.length > 0;
const LOCAL_DEV_ORIGINS = (process.env.ALLOW_LOCAL_DEV_CORS === 'true' || (!IS_PRODUCTION && !HAS_EXPLICIT_CORS))
  ? ['http://localhost:8081', 'http://127.0.0.1:8081']
  : [];
const ALLOW_PERMISSIVE_CORS = !HAS_EXPLICIT_CORS && ALLOW_ANY_CORS_ORIGIN;
const ALLOWED_CORS_ORIGINS = [...CORS_ORIGINS, GITHUB_PAGES_ORIGIN, ...LOCAL_DEV_ORIGINS];
const SPOTIFY_IMPORT_CONFIGURED = Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && SPOTIFY_REDIRECT_URI);
const GITHUB_PAGES_APP_URL = `${GITHUB_PAGES_ORIGIN}/adskip-podcasts/`;

if (IS_PRODUCTION && !HAS_EXPLICIT_CORS) {
  throw new Error('CORS_ORIGINS must be set in production.');
}

if (IS_PRODUCTION && ALLOW_UNAUTHENTICATED_ANALYZE) {
  throw new Error('ALLOW_UNAUTHENTICATED_ANALYZE cannot be enabled in production.');
}

if (IS_PRODUCTION && ALLOW_ANY_CORS_ORIGIN) {
  throw new Error('ALLOW_ANY_CORS_ORIGIN cannot be enabled in production.');
}

if (HAS_OPENAI_KEY && !HAS_EXPLICIT_CORS && !ALLOW_ANY_CORS_ORIGIN) {
  throw new Error('CORS_ORIGINS must be set when OPENAI_API_KEY is enabled. Set ALLOW_ANY_CORS_ORIGIN=true only for local development.');
}

if (HAS_OPENAI_KEY && !ANALYZE_API_TOKEN && !ALLOW_UNAUTHENTICATED_ANALYZE) {
  throw new Error('ANALYZE_API_TOKEN must be set when OPENAI_API_KEY is enabled. Set ALLOW_UNAUTHENTICATED_ANALYZE=true only for local development.');
}
const BLOCKED_IPV4_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map((range) => ipaddr.IPv4.parseCIDR(range));

const BLOCKED_IPV6_RANGES = [
  '::/128',
  '::1/128',
  '::/96',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
].map((range) => ipaddr.IPv6.parseCIDR(range));
const COMPATIBLE_TRANSCRIBE_MODELS = new Set(['whisper-1']);

type RssFeed = {
  title?: string;
  description?: string;
  link?: string;
  image?: { url?: string } | string;
  itunes?: { image?: string; author?: string };
  itunesImage?: unknown;
  items?: RssItem[];
};

type RssItem = {
  title?: string;
  content?: string;
  contentSnippet?: string;
  contentEncoded?: string;
  guid?: string;
  id?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  enclosure?: {
    url?: string;
    length?: string;
    type?: string;
  };
  itunes?: {
    duration?: string;
    image?: string;
  };
  itunesDuration?: string;
  itunesImage?: unknown;
};

type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

type SafeHttpResponse = {
  body: IncomingMessage;
  headers: IncomingHttpHeaders;
  statusCode: number;
};

const feedParser = new Parser<RssFeed, RssItem>({
  timeout: 15000,
  customFields: {
    feed: [['itunes:image', 'itunesImage']],
    item: [
      ['itunes:duration', 'itunesDuration'],
      ['itunes:image', 'itunesImage'],
      ['content:encoded', 'contentEncoded'],
    ],
  } as never,
});

const analyzeSchema = z.object({
  episodeId: z.string(),
  title: z.string(),
  podcastTitle: z.string(),
  audioUrl: z.string().url(),
  audioType: z.string().optional(),
  audioLength: z.number().optional(),
  duration: z.number().optional(),
});

const opmlSchema = z.object({
  opml: z.string().min(1),
});

const spotifyShowSchema = z.object({
  title: z.string().min(1).max(180),
  publisher: z.string().max(180).optional(),
  spotifyUrl: z.string().url().optional(),
  imageUrl: z.string().url().optional(),
});

const spotifyMatchSchema = z.object({
  shows: z.array(spotifyShowSchema).min(1).max(SPOTIFY_IMPORT_MAX_SHOWS),
});

type SpotifyImportSession = {
  codeVerifier: string;
  expiresAt: number;
  returnTo: string;
};

type SpotifyImportResult = {
  expiresAt: number;
  matches: ImportFeedCandidate[];
  total: number;
};

type ItunesSearchResult = {
  collectionName?: string;
  artistName?: string;
  feedUrl?: string;
  artworkUrl100?: string;
  collectionViewUrl?: string;
};

type ItunesSearchResponse = {
  results?: ItunesSearchResult[];
};

const spotifyImportSessions = new Map<string, SpotifyImportSession>();
const spotifyImportResults = new Map<string, SpotifyImportResult>();
const podcastSearchCache = new Map<string, { expiresAt: number; result?: ItunesSearchResult }>();
const spotifyMatchRateBuckets = new Map<string, RateBucket>();
let nextSpotifyMatchRateLimitPruneAt = Date.now() + SPOTIFY_MATCH_RATE_LIMIT_WINDOW_MS;

const app = express();
app.use(applyCors);
app.use(rateLimit);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    openai: HAS_OPENAI_KEY,
    maxTranscriptionAudioMb: Math.round(MAX_AUDIO_BYTES / 1024 / 1024),
  });
});

app.get('/api/feed', async (request, response) => {
  const feedUrl = String(request.query.url || '').trim();

  if (!feedUrl) {
    response.status(400).json({ error: 'Missing feed URL' });
    return;
  }

  try {
    const finalFeedUrl = await validatePublicHttpUrl(feedUrl);
    const xml = await safeFetchText(finalFeedUrl, MAX_FEED_BYTES);
    const parsed = await feedParser.parseString(xml);
    response.json(await normalizeFeed(finalFeedUrl, parsed));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Feed could not be parsed' });
  }
});

app.post('/api/opml', async (request, response) => {
  const parsed = opmlSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid OPML payload' });
    return;
  }

  try {
    const extracted = extractOpmlFeeds(parsed.data.opml);
    const candidates = extracted.feeds.slice(0, 100);
    const outcomes = await mapWithConcurrency(candidates, OPML_VALIDATE_CONCURRENCY, async (url) => ({
        url,
        safeUrl: await validatePublicHttpUrl(url).catch(() => undefined),
      }));
    const validFeeds = outcomes.map((outcome) => outcome.safeUrl).filter((url): url is string => Boolean(url));
    const feeds = validFeeds.slice(0, 50);
    const rejected = outcomes.length - validFeeds.length;
    const capped = Math.max(0, extracted.feeds.length - candidates.length) + Math.max(0, validFeeds.length - feeds.length);
    response.json({ feeds, rejected, capped, total: extracted.feeds.length });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'OPML could not be parsed' });
  }
});

app.get('/api/import/spotify/status', (_request, response) => {
  response.json({ configured: SPOTIFY_IMPORT_CONFIGURED });
});

app.get('/api/import/spotify/start', (request, response) => {
  if (!SPOTIFY_IMPORT_CONFIGURED) {
    response.status(503).json({ error: 'Spotify import is not configured on this API server' });
    return;
  }

  if (!reserveSpotifyImportSessionSlot(response)) {
    return;
  }

  const returnTo = String(request.query.returnTo || '');
  const safeReturnTo = validateSpotifyReturnTo(returnTo);
  if (!safeReturnTo) {
    response.status(400).json({ error: 'Invalid Spotify return URL' });
    return;
  }

  const state = randomUUID();
  const codeVerifier = base64Url(randomUUID() + randomUUID());
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  spotifyImportSessions.set(state, {
    codeVerifier,
    expiresAt: Date.now() + 10 * 60_000,
    returnTo: safeReturnTo,
  });

  const authorizeUrl = new URL('https://accounts.spotify.com/authorize');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', SPOTIFY_CLIENT_ID!);
  authorizeUrl.searchParams.set('scope', 'user-library-read');
  authorizeUrl.searchParams.set('redirect_uri', SPOTIFY_REDIRECT_URI!);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  response.redirect(authorizeUrl.toString());
});

app.get('/api/import/spotify/callback', async (request, response) => {
  const state = String(request.query.state || '');
  const code = String(request.query.code || '');
  const spotifyError = String(request.query.error || '');
  const session = spotifyImportSessions.get(state);
  spotifyImportSessions.delete(state);

  if (!SPOTIFY_IMPORT_CONFIGURED) {
    redirectSpotifyImportError(response, undefined, 'Spotify import is not configured on this API server');
    return;
  }

  if (!session || session.expiresAt < Date.now()) {
    redirectSpotifyImportError(response, undefined, 'Spotify import session expired or is invalid');
    return;
  }

  if (spotifyError) {
    redirectSpotifyImportError(response, session.returnTo, `Spotify authorization failed: ${spotifyError}`);
    return;
  }

  if (!code) {
    redirectSpotifyImportError(response, session.returnTo, 'Spotify did not return an authorization code');
    return;
  }

  try {
    const accessToken = await exchangeSpotifyCode(code, session.codeVerifier);
    const shows = await fetchSpotifySavedShows(accessToken);
    const matches = await matchShowsToFeedCandidates(shows);
    if (!hasSpotifyImportResultSlot()) {
      redirectSpotifyImportError(response, session.returnTo, 'Too many Spotify import results pending');
      return;
    }

    const token = randomUUID();
    spotifyImportResults.set(token, {
      expiresAt: Date.now() + 10 * 60_000,
      matches,
      total: shows.length,
    });

    response.redirect(spotifyImportReturnUrl(session.returnTo, { spotifyImportToken: token }));
  } catch (error) {
    redirectSpotifyImportError(response, session.returnTo, error instanceof Error ? error.message : 'Spotify import failed');
  }
});

app.get('/api/import/spotify/result/:token', (request, response) => {
  const token = String(request.params.token || '');
  const result = spotifyImportResults.get(token);

  if (!result || result.expiresAt < Date.now()) {
    spotifyImportResults.delete(token);
    response.status(404).json({ error: 'Spotify import result expired' });
    return;
  }

  spotifyImportResults.delete(token);
  response.json({ matches: result.matches, total: result.total });
});

app.post('/api/import/spotify/match', async (request, response) => {
  if (!takeSpotifyMatchRateLimit(request, response)) {
    return;
  }

  const parsed = spotifyMatchSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid Spotify show list' });
    return;
  }

  try {
    const matches = await matchShowsToFeedCandidates(parsed.data.shows);
    response.json({ matches, total: parsed.data.shows.length });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : 'Spotify matching failed' });
  }
});

app.post('/api/analyze', async (request, response) => {
  if (ANALYZE_API_TOKEN && request.header('x-skipcast-token') !== ANALYZE_API_TOKEN) {
    response.status(401).json({ error: 'Analysis token required' });
    return;
  }

  const parsed = analyzeSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid analysis payload' });
    return;
  }

  const episode = parsed.data;
  const takesAnalysisBudget = HAS_OPENAI_KEY;

  if (takesAnalysisBudget) {
    if (!takeAnalyzeRateLimit(request, response)) {
      return;
    }

    if (activeAnalyses >= ANALYZE_MAX_CONCURRENT) {
      response.status(429).json({ error: 'Too many analyses in progress' });
      return;
    }

    activeAnalyses += 1;
  }

  try {
    const result = await analyzePodcastEpisode(episode);
    response.json(result);
  } catch (error) {
    const result = unavailableAnalysis(episode, error instanceof Error ? error.message : 'Analysis failed');
    response.status(502).json(result);
  } finally {
    if (takesAnalysisBudget) {
      activeAnalyses = Math.max(0, activeAnalyses - 1);
    }
  }
});

const server = app.listen(PORT, () => {
  console.log(`SkipCast API listening on http://localhost:${PORT}`);
});

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

type RateBucket = {
  count: number;
  resetAt: number;
};

const rateBuckets = new Map<string, RateBucket>();
const analyzeRateBuckets = new Map<string, RateBucket>();
let nextRateLimitPruneAt = Date.now() + RATE_LIMIT_WINDOW_MS;
let nextAnalyzeRateLimitPruneAt = Date.now() + ANALYZE_RATE_LIMIT_WINDOW_MS;
let activeAnalyses = 0;

function applyCors(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const origin = request.header('origin');

  if (origin && (ALLOWED_CORS_ORIGINS.includes(origin) || ALLOW_PERMISSIVE_CORS)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-skipcast-token');
    response.setHeader('Vary', 'Origin');
  }

  if (request.method === 'OPTIONS') {
    response.sendStatus(origin && !response.hasHeader('Access-Control-Allow-Origin') ? 403 : 204);
    return;
  }

  next();
}

function rateLimit(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const now = Date.now();
  if (now >= nextRateLimitPruneAt) {
    pruneRateBuckets(rateBuckets, now);
    nextRateLimitPruneAt = now + RATE_LIMIT_WINDOW_MS;
  }

  if (takeRateLimitSlot(rateBuckets, rateLimitKey(request), now, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS)) {
    next();
    return;
  }

  response.status(429).json({ error: 'Rate limit exceeded' });
}

function takeAnalyzeRateLimit(request: express.Request, response: express.Response): boolean {
  const now = Date.now();
  if (now >= nextAnalyzeRateLimitPruneAt) {
    pruneRateBuckets(analyzeRateBuckets, now);
    nextAnalyzeRateLimitPruneAt = now + ANALYZE_RATE_LIMIT_WINDOW_MS;
  }

  if (takeRateLimitSlot(analyzeRateBuckets, rateLimitKey(request), now, ANALYZE_RATE_LIMIT_WINDOW_MS, ANALYZE_RATE_LIMIT_MAX_REQUESTS)) {
    return true;
  }

  response.status(429).json({ error: 'Analyze rate limit exceeded' });
  return false;
}

function takeSpotifyMatchRateLimit(request: express.Request, response: express.Response): boolean {
  const now = Date.now();
  if (now >= nextSpotifyMatchRateLimitPruneAt) {
    pruneRateBuckets(spotifyMatchRateBuckets, now);
    nextSpotifyMatchRateLimitPruneAt = now + SPOTIFY_MATCH_RATE_LIMIT_WINDOW_MS;
  }

  if (takeRateLimitSlot(spotifyMatchRateBuckets, rateLimitKey(request), now, SPOTIFY_MATCH_RATE_LIMIT_WINDOW_MS, SPOTIFY_MATCH_RATE_LIMIT_MAX_REQUESTS)) {
    return true;
  }

  response.status(429).json({ error: 'Spotify import rate limit exceeded' });
  return false;
}

function reserveSpotifyImportSessionSlot(response: express.Response): boolean {
  pruneSpotifyImportState();
  if (spotifyImportSessions.size < SPOTIFY_SESSION_MAX_ENTRIES) {
    return true;
  }

  response.status(429).json({ error: 'Too many Spotify imports in progress' });
  return false;
}

function hasSpotifyImportResultSlot(): boolean {
  pruneSpotifyImportState();
  return spotifyImportResults.size < SPOTIFY_SESSION_MAX_ENTRIES;
}

function pruneSpotifyImportState(now = Date.now()): void {
  for (const [state, session] of spotifyImportSessions.entries()) {
    if (session.expiresAt <= now) {
      spotifyImportSessions.delete(state);
    }
  }

  for (const [token, result] of spotifyImportResults.entries()) {
    if (result.expiresAt <= now) {
      spotifyImportResults.delete(token);
    }
  }
}

function rateLimitKey(request: express.Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function takeRateLimitSlot(buckets: Map<string, RateBucket>, key: string, now: number, windowMs: number, maxRequests: number): boolean {
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= maxRequests;
}

function pruneRateBuckets(buckets: Map<string, RateBucket>, now: number): void {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

async function safeFetchText(inputUrl: string, byteLimit: number): Promise<string> {
  const response = await fetchWithSafeRedirects(inputUrl, 'application/rss+xml, application/xml, text/xml, */*');

  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.body.resume();
    throw new Error(`Feed fetch failed with ${response.statusCode}`);
  }

  assertContentLength(response.headers, byteLimit, 'Feed');

  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > byteLimit) {
      throw new Error(`Feed is larger than ${Math.round(byteLimit / 1024 / 1024)} MB`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function safeFetchToFile(inputUrl: string, targetPath: string, byteLimit: number): Promise<void> {
  const response = await fetchWithSafeRedirects(inputUrl, 'audio/*, application/octet-stream, */*');

  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.body.resume();
    throw new Error(`Audio download failed with ${response.statusCode}`);
  }

  assertContentLength(response.headers, byteLimit, 'Audio file');

  await pipeline(response.body, createByteLimitTransform(byteLimit, 'Audio file'), createWriteStream(targetPath));
}

function createByteLimitTransform(byteLimit: number, label: string): Transform {
  let bytes = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > byteLimit) {
        callback(new Error(`${label} is larger than ${Math.round(byteLimit / 1024 / 1024)} MB`));
        return;
      }

      callback(null, chunk);
    },
  });
}

async function fetchWithSafeRedirects(inputUrl: string, accept: string): Promise<SafeHttpResponse> {
  let currentUrl = await validatePublicHttpUrl(inputUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await safeRequestOnce(currentUrl, accept);

    if (![301, 302, 303, 307, 308].includes(response.statusCode)) {
      return response;
    }

    response.body.resume();
    const location = headerValue(response.headers.location);
    if (!location) {
      throw new Error('Redirect response did not include a Location header');
    }

    currentUrl = await validatePublicHttpUrl(new URL(location, currentUrl).toString());
  }

  throw new Error(`Too many redirects; limit is ${MAX_REDIRECTS}`);
}

async function safeRequestOnce(inputUrl: string, accept: string): Promise<SafeHttpResponse> {
  const url = new URL(inputUrl);
  const client = url.protocol === 'https:' ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const requestOptions: RequestOptions & { servername?: string } = {
    headers: {
      Accept: accept,
      'User-Agent': 'SkipCastMVP/1.0 (+https://localhost)',
    },
    hostname,
    lookup(
      hostnameToResolve: string,
      options: LookupOptions & { all?: boolean },
      callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
    ) {
      const family = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : undefined;
      resolvePublicHostname(hostnameToResolve, family)
        .then((records) => {
          if (options.all) {
            callback(null, records);
            return;
          }

          callback(null, records[0].address, records[0].family);
        })
        .catch((error) => callback(error instanceof Error ? error : new Error('DNS lookup failed'), '0.0.0.0', 4));
    },
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    port: url.port || undefined,
    protocol: url.protocol,
    servername: hostname,
    timeout: FETCH_TIMEOUT_MS,
  };

  return new Promise((resolve, reject) => {
    const request = client.request(requestOptions, (response) => {
      resolve({
        body: response,
        headers: response.headers,
        statusCode: response.statusCode || 0,
      });
    });

    request.on('timeout', () => request.destroy(new Error('Request timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function validatePublicHttpUrl(inputUrl: string): Promise<string> {
  let url: URL;

  try {
    url = new URL(inputUrl);
  } catch {
    throw new Error('URL is invalid');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported');
  }

  if (url.username || url.password) {
    throw new Error('Credentialed URLs are not supported');
  }

  if ((url.protocol === 'http:' && url.port && url.port !== '80') || (url.protocol === 'https:' && url.port && url.port !== '443')) {
    throw new Error('Podcast URLs must use standard HTTP or HTTPS ports');
  }

  await assertPublicHostname(url.hostname);
  return url.toString();
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  await resolvePublicHostname(hostname);
}

async function resolvePublicHostname(hostname: string, family?: number): Promise<Array<{ address: string; family: number }>> {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw new Error('Localhost URLs are not allowed');
  }

  const literalVersion = net.isIP(normalized);
  if (literalVersion) {
    assertPublicIp(normalized, literalVersion);
    return [{
      address: normalized,
      family: literalVersion,
    }];
  }

  const records = await dns.lookup(normalized, {
    all: true,
    family: family === 4 || family === 6 ? family : 0,
    verbatim: true,
  });
  if (!records.length) {
    throw new Error('URL hostname did not resolve');
  }

  records.forEach((record) => assertPublicIp(record.address, record.family));
  return records;
}

function assertPublicIp(address: string, family: number): void {
  const blocked = family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);

  if (blocked) {
    throw new Error('URL resolves to a private or reserved network');
  }
}

function isBlockedIpv4(address: string): boolean {
  let parsed: ipaddr.IPv4;

  try {
    parsed = ipaddr.IPv4.parse(address);
  } catch {
    return true;
  }

  return parsed.range() !== 'unicast' || BLOCKED_IPV4_RANGES.some((range) => parsed.match(range));
}

function isBlockedIpv6(address: string): boolean {
  let parsed: ipaddr.IPv6;

  try {
    parsed = ipaddr.IPv6.parse(address);
  } catch {
    return true;
  }

  return parsed.range() !== 'unicast' || BLOCKED_IPV6_RANGES.some((range) => parsed.match(range));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function assertContentLength(headers: IncomingHttpHeaders, byteLimit: number, label: string): void {
  const contentLength = Number(headerValue(headers['content-length']));
  if (Number.isFinite(contentLength) && contentLength > byteLimit) {
    throw new Error(`${label} is larger than ${Math.round(byteLimit / 1024 / 1024)} MB`);
  }
}

async function normalizeFeed(feedUrl: string, feed: RssFeed): Promise<PodcastFeed> {
  const title = cleanText(feed.title) || new URL(feedUrl).hostname;
  const artworkUrl = imageFrom(feed.image) || imageFrom(feed.itunesImage) || feed.itunes?.image;

  const episodes: PodcastEpisode[] = [];

  for (const item of (feed.items || []).slice(0, MAX_EPISODES_PER_FEED)) {
    const episode = await normalizeEpisode(feedUrl, title, artworkUrl, item);
    if (episode?.audioUrl) {
      episodes.push(episode);
    }
  }

  return {
    id: stableId(feedUrl),
    title,
    description: stripHtml(feed.description),
    feedUrl,
    siteUrl: feed.link,
    artworkUrl,
    episodes,
  };
}

async function normalizeEpisode(
  feedUrl: string,
  podcastTitle: string,
  feedArtworkUrl: string | undefined,
  item: RssItem,
): Promise<PodcastEpisode | null> {
  const audioUrl = item.enclosure?.url;
  if (!audioUrl) {
    return null;
  }

  const safeAudioUrl = await validatePublicHttpUrl(audioUrl).catch(() => undefined);
  if (!safeAudioUrl) {
    return null;
  }

  const guid = cleanText(item.guid || item.id || item.link || audioUrl);
  const title = cleanText(item.title) || 'Untitled episode';
  const description = stripHtml(item.contentEncoded || item.content || item.contentSnippet);
  const duration = parseDuration(item.itunes?.duration || item.itunesDuration);
  const artworkUrl = imageFrom(item.itunesImage) || item.itunes?.image || feedArtworkUrl;
  const audioLength = Number(item.enclosure?.length);

  return {
    id: stableId(`${feedUrl}:${guid}:${audioUrl}`),
    title,
    podcastTitle,
    description,
    pubDate: item.isoDate || item.pubDate,
    duration,
    audioUrl: safeAudioUrl,
    audioType: item.enclosure?.type,
    audioLength: Number.isFinite(audioLength) ? audioLength : undefined,
    artworkUrl,
    episodeUrl: item.link,
  };
}

async function analyzePodcastEpisode(episode: z.infer<typeof analyzeSchema>): Promise<AnalysisResult> {
  if (!HAS_OPENAI_KEY) {
    return unavailableAnalysis(episode, 'Analysis unavailable: set OPENAI_API_KEY for transcription-backed detection.');
  }

  if (episode.audioLength && episode.audioLength > MAX_AUDIO_BYTES) {
    return unavailableAnalysis(episode, `Analysis unavailable: audio file is above ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB.`);
  }

  const safeAudioUrl = await validatePublicHttpUrl(episode.audioUrl);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'skipcast-'));
  const extension = extensionFor(episode.audioType, episode.audioUrl);
  const tempPath = path.join(tempDir, `${randomUUID()}.${extension}`);

  try {
    await downloadAudio(safeAudioUrl, tempPath, MAX_AUDIO_BYTES);
    const transcript = await transcribeWithOpenAI(tempPath);
    const segments = detectAdsFromTranscript(episode.episodeId, transcript);

    return {
      episodeId: episode.episodeId,
      engine: 'openai-transcript',
      status: 'complete',
      message: segments.length ? `Found ${segments.length} likely ad segments` : 'No high-confidence ad segments found',
      segments,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadAudio(audioUrl: string, targetPath: string, byteLimit: number): Promise<void> {
  await safeFetchToFile(audioUrl, targetPath, byteLimit);
}

async function transcribeWithOpenAI(filePath: string): Promise<TranscriptSegment[]> {
  const client = new OpenAI();
  const model = OPENAI_TRANSCRIBE_MODEL;
  if (!COMPATIBLE_TRANSCRIBE_MODELS.has(model)) {
    throw new Error(`OPENAI_TRANSCRIBE_MODEL must support verbose_json segments. Supported: ${[...COMPATIBLE_TRANSCRIBE_MODELS].join(', ')}`);
  }

  const transcription = await client.audio.transcriptions.create({
    file: createReadStream(filePath) as never,
    model,
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  const segments = 'segments' in transcription ? transcription.segments : [];

  return (segments || [])
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: String(segment.text || ''),
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);
}

function detectAdsFromTranscript(episodeId: string, transcript: TranscriptSegment[]): AdSegment[] {
  const segments: AdSegment[] = [];
  let active: { start: number; end: number; hits: number; category: SegmentCategory } | null = null;
  let quietCount = 0;

  for (const line of transcript) {
    const score = adScore(line.text);
    const ending = isAdReturnCue(line.text);

    if (!active && score > 0) {
      active = {
        start: Math.max(0, line.start - 1.5),
        end: line.end,
        hits: score,
        category: classifyCategory(line.text),
      };
      quietCount = 0;
      continue;
    }

    if (!active) {
      continue;
    }

    active.end = line.end;
    active.hits += score;
    quietCount = score > 0 ? 0 : quietCount + 1;

    const elapsed = active.end - active.start;
    const shouldClose = (ending && elapsed >= 15) || elapsed >= 180 || quietCount >= 4;

    if (shouldClose) {
      if (elapsed >= 12) {
        segments.push(toAdSegment(episodeId, segments.length, active));
      }
      active = null;
      quietCount = 0;
    }
  }

  if (active && active.end - active.start >= 12) {
    segments.push(toAdSegment(episodeId, segments.length, active));
  }

  return mergeCloseSegments(segments);
}

function adScore(text: string): number {
  const normalized = text.toLowerCase();
  const patterns = [
    /sponsored by/,
    /brought to you by/,
    /support(ed)? by/,
    /use (promo )?code/,
    /promo code/,
    /visit .{0,45}(dot com|\.com)/,
    /go to .{0,45}(dot com|\.com)/,
    /try .{0,35} free/,
    /this episode is sponsored/,
    /ad break/,
    /commercial break/,
    /we'?ll be right back/,
    /after (this|the) break/,
    /thanks to .{0,35} for sponsoring/,
  ];

  return patterns.reduce((score, pattern) => score + (pattern.test(normalized) ? 1 : 0), 0);
}

function isAdReturnCue(text: string): boolean {
  return /back to (the )?(show|episode|conversation)|and we'?re back|now back to|let'?s get back/i.test(text);
}

function classifyCategory(text: string): SegmentCategory {
  if (/network|another podcast|new show/i.test(text)) {
    return 'network_promo';
  }

  if (/patreon|subscribe|premium|newsletter/i.test(text)) {
    return 'self_promo';
  }

  return /ad break|commercial/i.test(text) ? 'dynamic_ad' : 'host_read_ad';
}

function toAdSegment(
  episodeId: string,
  index: number,
  active: { start: number; end: number; hits: number; category: SegmentCategory },
): AdSegment {
  const duration = Math.max(1, active.end - active.start);
  const confidence = Math.min(0.95, 0.58 + active.hits * 0.08 + Math.min(duration, 120) / 1000);

  return {
    id: stableId(`${episodeId}:openai:${index}:${active.start}:${active.end}`),
    start: Number(active.start.toFixed(2)),
    end: Number(active.end.toFixed(2)),
    category: active.category,
    confidence,
    label: labelFor(active.category),
    source: 'openai-transcript',
    reason: 'Matched sponsor/ad-break transcript cues.',
  };
}

function mergeCloseSegments(segments: AdSegment[]): AdSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: AdSegment[] = [];

  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && segment.start - last.end <= 8 && segment.category === last.category) {
      last.end = Math.max(last.end, segment.end);
      last.confidence = Math.max(last.confidence, segment.confidence);
      continue;
    }

    merged.push({ ...segment });
  }

  return merged;
}

function unavailableAnalysis(episode: z.infer<typeof analyzeSchema>, reason: string): AnalysisResult {
  return {
    episodeId: episode.episodeId,
    engine: 'unavailable',
    status: 'unavailable',
    message: reason,
    segments: [],
  };
}

function spotifyImportReturnUrl(returnTo: string | undefined, params: Record<string, string>): string {
  const returnUrl = new URL(returnTo || GITHUB_PAGES_APP_URL);
  const hashParams = new URLSearchParams(returnUrl.hash.replace(/^#/, ''));
  Object.entries(params).forEach(([key, value]) => hashParams.set(key, value));
  returnUrl.hash = hashParams.toString();
  return returnUrl.toString();
}

function redirectSpotifyImportError(response: express.Response, returnTo: string | undefined, message: string): void {
  response.redirect(spotifyImportReturnUrl(returnTo, { spotifyImportError: message }));
}

function validateSpotifyReturnTo(returnTo: string): string | undefined {
  try {
    const url = new URL(returnTo);
    if (url.protocol === 'skipcast:' && url.hostname === 'spotify-import') {
      return url.toString();
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      return undefined;
    }

    const allowedOrigins = new Set(ALLOWED_CORS_ORIGINS);
    return allowedOrigins.has(url.origin) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function exchangeSpotifyCode(code: string, codeVerifier: string): Promise<string> {
  const body = new URLSearchParams({
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: SPOTIFY_REDIRECT_URI!,
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const payload = await response.json().catch(() => null) as { access_token?: string; error_description?: string } | null;

  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || 'Spotify token exchange failed');
  }

  return payload.access_token;
}

async function fetchSpotifySavedShows(accessToken: string): Promise<SpotifyImportShow[]> {
  const shows: SpotifyImportShow[] = [];
  let offset = 0;

  while (shows.length < SPOTIFY_IMPORT_MAX_SHOWS) {
    const url = new URL('https://api.spotify.com/v1/me/shows');
    url.searchParams.set('limit', String(Math.min(50, SPOTIFY_IMPORT_MAX_SHOWS - shows.length)));
    url.searchParams.set('offset', String(offset));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    const payload = await response.json().catch(() => null) as {
      items?: Array<{
        show?: {
          name?: string;
          publisher?: string;
          external_urls?: { spotify?: string };
          images?: Array<{ url?: string }>;
        };
      }>;
      next?: string | null;
      error?: { message?: string };
    } | null;

    if (!response.ok) {
      throw new Error(payload?.error?.message || `Spotify saved shows failed with ${response.status}`);
    }

    const items = payload?.items || [];
    shows.push(...items
      .map((item) => item.show)
      .filter((show): show is NonNullable<typeof show> => Boolean(show?.name))
      .map((show) => ({
        title: show.name!,
        publisher: show.publisher,
        spotifyUrl: show.external_urls?.spotify,
        imageUrl: show.images?.[0]?.url,
      })));

    if (!payload?.next || items.length === 0) {
      break;
    }

    offset += items.length;
  }

  return shows;
}

async function matchShowsToFeedCandidates(shows: SpotifyImportShow[]): Promise<ImportFeedCandidate[]> {
  const normalizedShows = dedupeSpotifyShows(shows
    .map((show) => ({
      ...show,
      title: cleanText(show.title),
      publisher: cleanText(show.publisher),
    }))
    .filter((show) => show.title)
    .slice(0, SPOTIFY_IMPORT_MAX_SHOWS));

  return mapWithConcurrency(normalizedShows, Math.min(4, OPML_VALIDATE_CONCURRENCY), async (show) => {
    let result: ItunesSearchResult | undefined;
    try {
      result = await searchPodcastDirectory(show);
    } catch {
      return {
        id: stableId(`spotify:${show.title}:${show.publisher || ''}:provider-failed`),
        source: 'spotify',
        status: 'unavailable',
        title: show.title,
        publisher: show.publisher,
        artworkUrl: show.imageUrl,
        confidence: 0,
        reason: 'Podcast directory unavailable; retry later',
        externalUrl: show.spotifyUrl,
      };
    }

    if (!result?.feedUrl) {
      return {
        id: stableId(`spotify:${show.title}:${show.publisher || ''}:unavailable`),
        source: 'spotify',
        status: 'unavailable',
        title: show.title,
        publisher: show.publisher,
        artworkUrl: show.imageUrl,
        confidence: 0,
        reason: 'No public RSS match found',
        externalUrl: show.spotifyUrl,
      };
    }

    const confidence = scorePodcastMatch(show, result);
    const safeFeedUrl = await validatePublicHttpUrl(result.feedUrl).catch(() => undefined);
    if (!safeFeedUrl) {
      return {
        id: stableId(`spotify:${show.title}:${show.publisher || ''}:unsafe`),
        source: 'spotify',
        status: 'unavailable',
        title: result.collectionName || show.title,
        publisher: result.artistName || show.publisher,
        artworkUrl: result.artworkUrl100 || show.imageUrl,
        confidence,
        reason: 'Matched feed URL could not be safely imported',
        externalUrl: result.collectionViewUrl || show.spotifyUrl,
      };
    }

    return {
      id: stableId(`spotify:${show.title}:${safeFeedUrl}`),
      source: 'spotify',
      status: confidence >= 0.76 ? 'matched' : 'needs_review',
      title: result.collectionName || show.title,
      publisher: result.artistName || show.publisher,
      feedUrl: safeFeedUrl,
      artworkUrl: result.artworkUrl100 || show.imageUrl,
      confidence,
      reason: confidence >= 0.76 ? 'Strong title and publisher match' : 'Review this public RSS match before importing',
      externalUrl: result.collectionViewUrl || show.spotifyUrl,
    };
  });
}

function dedupeSpotifyShows(shows: SpotifyImportShow[]): SpotifyImportShow[] {
  const seen = new Set<string>();
  const unique: SpotifyImportShow[] = [];

  for (const show of shows) {
    const key = `${normalizeMatchText(show.title)}:${normalizeMatchText(show.publisher)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(show);
  }

  return unique;
}

async function searchPodcastDirectory(show: SpotifyImportShow): Promise<ItunesSearchResult | undefined> {
  const term = [show.title, show.publisher].filter(Boolean).join(' ');
  const cacheKey = normalizeMatchText(term);
  const cached = podcastSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('media', 'podcast');
  url.searchParams.set('entity', 'podcast');
  url.searchParams.set('limit', '5');
  url.searchParams.set('term', term);

  const text = await safeFetchText(url.toString(), 512 * 1024);
  const payload = JSON.parse(text) as ItunesSearchResponse;
  const results = (payload.results || []).filter((result) => result.feedUrl);
  if (!results.length) {
    setPodcastSearchCache(cacheKey, undefined);
    return undefined;
  }

  const result = results
    .map((result) => ({ result, score: scorePodcastMatch(show, result) }))
    .sort((a, b) => b.score - a.score)[0]?.result;
  setPodcastSearchCache(cacheKey, result);
  return result;
}

function setPodcastSearchCache(cacheKey: string, result: ItunesSearchResult | undefined): void {
  const now = Date.now();
  for (const [key, entry] of podcastSearchCache.entries()) {
    if (entry.expiresAt <= now) {
      podcastSearchCache.delete(key);
    }
  }

  if (podcastSearchCache.size >= PODCAST_SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = podcastSearchCache.keys().next().value as string | undefined;
    if (oldestKey) {
      podcastSearchCache.delete(oldestKey);
    }
  }

  podcastSearchCache.set(cacheKey, {
    expiresAt: now + PODCAST_SEARCH_CACHE_TTL_MS,
    result,
  });
}

function scorePodcastMatch(show: SpotifyImportShow, result: ItunesSearchResult): number {
  const showTitle = normalizeMatchText(show.title);
  const resultTitle = normalizeMatchText(result.collectionName);
  const showPublisher = normalizeMatchText(show.publisher);
  const resultPublisher = normalizeMatchText(result.artistName);
  let score = 0;

  if (showTitle && resultTitle) {
    if (showTitle === resultTitle) {
      score += 0.72;
    } else if (showTitle.includes(resultTitle) || resultTitle.includes(showTitle)) {
      score += 0.58;
    } else {
      const overlap = tokenOverlap(showTitle, resultTitle);
      score += Math.min(0.48, overlap * 0.6);
    }
  }

  if (showPublisher && resultPublisher) {
    if (showPublisher === resultPublisher) {
      score += 0.22;
    } else if (showPublisher.includes(resultPublisher) || resultPublisher.includes(showPublisher)) {
      score += 0.16;
    } else {
      score += Math.min(0.12, tokenOverlap(showPublisher, resultPublisher) * 0.2);
    }
  }

  if (result.feedUrl) {
    score += 0.06;
  }

  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function normalizeMatchText(value?: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(left.split(' ').filter((token) => token.length > 2));
  const rightTokens = new Set(right.split(' ').filter((token) => token.length > 2));
  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }

  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function extractOpmlFeeds(opml: string): { feeds: string[] } {
  assertOpmlTextWithinLimits(opml);
  const validation = XMLValidator.validate(opml, {
    allowBooleanAttributes: true,
  });
  if (validation !== true) {
    throw new Error('OPML XML is not well formed');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
  });
  const document = parser.parse(opml);
  if (!document?.opml || typeof document.opml !== 'object' || !Object.prototype.hasOwnProperty.call(document.opml, 'body')) {
    throw new Error('Document is not a valid OPML subscription file');
  }

  const feeds = new Set<string>();
  let nodeCount = 0;

  const visit = (node: unknown, depth = 0) => {
    nodeCount += 1;
    if (nodeCount > OPML_MAX_NODES) {
      throw new Error(`OPML contains more than ${OPML_MAX_NODES} nodes`);
    }

    if (depth > OPML_MAX_DEPTH) {
      throw new Error(`OPML nesting is deeper than ${OPML_MAX_DEPTH} levels`);
    }

    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, depth + 1));
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    const record = node as Record<string, unknown>;
    const xmlUrl = typeof record.xmlUrl === 'string' ? record.xmlUrl : undefined;
    if (xmlUrl && /^https?:\/\//i.test(xmlUrl)) {
      feeds.add(xmlUrl);
    }

    Object.values(record).forEach((child) => visit(child, depth + 1));
  };

  visit(document.opml.body);

  return { feeds: [...feeds] };
}

function assertOpmlTextWithinLimits(opml: string): void {
  if (opml.length > OPML_MAX_CHARS) {
    throw new Error(`OPML is larger than ${OPML_MAX_CHARS} characters`);
  }

  let depth = 0;
  let nodeCount = 0;
  const tagPattern = /<\s*(\/?)([A-Za-z_][\w:.-]*)([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(opml)) !== null) {
    const isClosingTag = match[1] === '/';
    const fullTag = match[0];

    if (isClosingTag) {
      depth = Math.max(0, depth - 1);
      continue;
    }

    nodeCount += 1;
    if (nodeCount > OPML_MAX_NODES) {
      throw new Error(`OPML contains more than ${OPML_MAX_NODES} XML tags`);
    }

    if (/\/\s*>$/.test(fullTag)) {
      continue;
    }

    depth += 1;
    if (depth > OPML_MAX_DEPTH) {
      throw new Error(`OPML nesting is deeper than ${OPML_MAX_DEPTH} levels`);
    }
  }
}

function parseDuration(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    return Number(text);
  }

  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return undefined;
}

function stripHtml(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return cleanText(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

function cleanText(value?: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function imageFrom(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return stringValue(record.url) || stringValue(record.href) || stringValue(record['@_href']);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extensionFor(type: string | undefined, audioUrl: string): string {
  const pathname = new URL(audioUrl).pathname.toLowerCase();
  const ext = pathname.split('.').pop();
  if (ext && ['mp3', 'm4a', 'mp4', 'mpeg', 'mpga', 'wav', 'webm', 'ogg'].includes(ext)) {
    return ext;
  }

  if (type?.includes('mpeg')) {
    return 'mp3';
  }

  if (type?.includes('mp4')) {
    return 'm4a';
  }

  if (type?.includes('wav')) {
    return 'wav';
  }

  return 'mp3';
}

function labelFor(category: SegmentCategory): string {
  const labels: Record<SegmentCategory, string> = {
    host_read_ad: 'Host-read ad',
    dynamic_ad: 'Inserted ad',
    network_promo: 'Network promo',
    self_promo: 'Self promo',
    intro: 'Intro',
    outro: 'Outro',
  };

  return labels[category];
}

function stableId(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}
