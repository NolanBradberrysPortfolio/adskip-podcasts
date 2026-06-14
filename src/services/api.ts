import type { AnalysisResult, ImportFeedCandidate, PodcastEpisode, PodcastFeed, SpotifyImportShow } from '../types';

const DEFAULT_API_URL = 'http://localhost:4300';
const isProduction = process.env.NODE_ENV === 'production';
const ANALYSIS_SESSION_STORAGE_KEY = 'skipcast.analysisSession';
const ANALYSIS_SESSION_REFRESH_SKEW_MS = 30_000;

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || (isProduction ? '' : DEFAULT_API_URL);

export type ApiHealth = {
  ok: boolean;
  openai: boolean;
  localWhisper?: boolean;
  analysisEngines?: {
    openai?: boolean;
    localWhisper?: boolean;
  };
  transcribeModel?: string;
  adDetectionModel?: string;
  maxTranscriptionAudioMb: number;
  localWhisperMaxAudioMb?: number;
  localWhisperMaxSeconds?: number;
  analysisSessions?: {
    enabled: boolean;
    maxRequests: number;
    ttlMinutes: number;
  };
};

type BrowserStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type AnalysisSessionResponse = {
  token: string;
  expiresAt: string;
  remaining: number;
};

type CachedAnalysisSession = {
  token: string;
  expiresAtMs: number;
};

class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

let cachedAnalysisSession: CachedAnalysisSession | null = readCachedAnalysisSession();

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error('Set EXPO_PUBLIC_API_URL to your deployed HTTPS API.');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiRequestError(payload?.error || payload?.message || `Request failed with ${response.status}`, response.status);
  }

  return payload as T;
}

function getBrowserStorage(): BrowserStorage | undefined {
  try {
    if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
      return undefined;
    }

    return (globalThis as unknown as { localStorage?: BrowserStorage }).localStorage;
  } catch {
    return undefined;
  }
}

function readCachedAnalysisSession(): CachedAnalysisSession | null {
  const storage = getBrowserStorage();

  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(ANALYSIS_SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedAnalysisSession>;
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAtMs !== 'number') {
      storage.removeItem(ANALYSIS_SESSION_STORAGE_KEY);
      return null;
    }

    return parsed as CachedAnalysisSession;
  } catch {
    storage.removeItem(ANALYSIS_SESSION_STORAGE_KEY);
    return null;
  }
}

function writeCachedAnalysisSession(session: CachedAnalysisSession): void {
  cachedAnalysisSession = session;

  try {
    getBrowserStorage()?.setItem(ANALYSIS_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Browser privacy settings can deny storage. The in-memory session still works for the current tab.
  }
}

function clearCachedAnalysisSession(): void {
  cachedAnalysisSession = null;

  try {
    getBrowserStorage()?.removeItem(ANALYSIS_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

function hasFreshAnalysisSession(session: CachedAnalysisSession | null): session is CachedAnalysisSession {
  return Boolean(session && session.expiresAtMs - ANALYSIS_SESSION_REFRESH_SKEW_MS > Date.now());
}

async function fetchAnalysisSession(): Promise<CachedAnalysisSession> {
  const session = await requestJson<AnalysisSessionResponse>('/api/analyze/session', {
    method: 'POST',
  });
  const cachedSession = {
    token: session.token,
    expiresAtMs: Date.parse(session.expiresAt),
  };

  writeCachedAnalysisSession(cachedSession);
  return cachedSession;
}

async function getAnalysisSession(forceRefresh = false): Promise<CachedAnalysisSession> {
  if (!forceRefresh && hasFreshAnalysisSession(cachedAnalysisSession)) {
    return cachedAnalysisSession;
  }

  return fetchAnalysisSession();
}

function canFallbackWithoutAnalysisSession(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 503);
}

function shouldRefreshAnalysisSession(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

export function fetchPodcastFeed(feedUrl: string): Promise<PodcastFeed> {
  return requestJson<PodcastFeed>(`/api/feed?url=${encodeURIComponent(feedUrl)}`);
}

export function fetchApiHealth(): Promise<ApiHealth> {
  return requestJson<ApiHealth>('/api/health');
}

export type OpmlImportResult = {
  feeds: string[];
  rejected?: number;
  capped?: number;
  total?: number;
};

export function importOpml(opml: string): Promise<OpmlImportResult> {
  return requestJson<OpmlImportResult>('/api/opml', {
    method: 'POST',
    body: JSON.stringify({ opml }),
  });
}

export function fetchSpotifyImportStatus(): Promise<{ configured: boolean }> {
  return requestJson<{ configured: boolean }>('/api/import/spotify/status');
}

export function matchPodcastShows(shows: SpotifyImportShow[]): Promise<{ matches: ImportFeedCandidate[]; total: number }> {
  return requestJson<{ matches: ImportFeedCandidate[]; total: number }>('/api/import/spotify/match', {
    method: 'POST',
    body: JSON.stringify({ shows }),
  });
}

export function fetchSpotifyImportResult(token: string): Promise<{ matches: ImportFeedCandidate[]; total: number }> {
  return requestJson<{ matches: ImportFeedCandidate[]; total: number }>(`/api/import/spotify/result/${encodeURIComponent(token)}`);
}

export function spotifyConnectUrl(returnTo: string): string {
  if (!API_BASE_URL) {
    throw new Error('Set EXPO_PUBLIC_API_URL to your deployed HTTPS API.');
  }

  return `${API_BASE_URL}/api/import/spotify/start?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function analyzeEpisode(episode: PodcastEpisode, knownDuration?: number): Promise<AnalysisResult> {
  const body = JSON.stringify({
    episodeId: episode.id,
    title: episode.title,
    podcastTitle: episode.podcastTitle,
    audioUrl: episode.audioUrl,
    audioType: episode.audioType,
    audioLength: episode.audioLength,
    duration: knownDuration || episode.duration,
  });

  const requestAnalysis = (session?: CachedAnalysisSession) => requestJson<AnalysisResult>('/api/analyze', {
    method: 'POST',
    headers: session ? { 'x-skipcast-session': session.token } : undefined,
    body,
  });

  let session: CachedAnalysisSession | undefined;

  try {
    session = await getAnalysisSession();
  } catch (error) {
    if (!canFallbackWithoutAnalysisSession(error)) {
      throw error;
    }
  }

  try {
    return await requestAnalysis(session);
  } catch (error) {
    if (session && shouldRefreshAnalysisSession(error)) {
      clearCachedAnalysisSession();
      return requestAnalysis(await getAnalysisSession(true));
    }

    throw error;
  }
}
