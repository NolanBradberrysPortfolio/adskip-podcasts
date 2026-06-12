import type { AnalysisResult, ImportFeedCandidate, PodcastEpisode, PodcastFeed, SpotifyImportShow } from '../types';

const DEFAULT_API_URL = 'http://localhost:4300';
const isProduction = process.env.NODE_ENV === 'production';
const ANALYZE_API_TOKEN = process.env.EXPO_PUBLIC_ANALYZE_API_TOKEN;

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || (isProduction ? '' : DEFAULT_API_URL);

export type ApiHealth = {
  ok: boolean;
  openai: boolean;
  transcribeModel?: string;
  adDetectionModel?: string;
  maxTranscriptionAudioMb: number;
};

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
    throw new Error(payload?.error || payload?.message || `Request failed with ${response.status}`);
  }

  return payload as T;
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

export function analyzeEpisode(episode: PodcastEpisode, knownDuration?: number): Promise<AnalysisResult> {
  return requestJson<AnalysisResult>('/api/analyze', {
    method: 'POST',
    headers: ANALYZE_API_TOKEN ? { 'x-skipcast-token': ANALYZE_API_TOKEN } : undefined,
    body: JSON.stringify({
      episodeId: episode.id,
      title: episode.title,
      podcastTitle: episode.podcastTitle,
      audioUrl: episode.audioUrl,
      audioType: episode.audioType,
      audioLength: episode.audioLength,
      duration: knownDuration || episode.duration,
    }),
  });
}
