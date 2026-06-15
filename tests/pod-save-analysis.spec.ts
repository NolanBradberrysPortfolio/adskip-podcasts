import { expect, test } from '@playwright/test';

const apiBaseUrl = process.env.SKIPCAST_API_URL || process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:4300';
const podSaveFeedUrl = 'https://audioboom.com/channels/5166624.rss';

type FeedEpisode = {
  id: string;
  title: string;
  podcastTitle: string;
  audioUrl: string;
  audioType?: string;
  audioLength?: number;
  duration?: number;
};

type AnalysisResponse = {
  episodeId: string;
  engine: string;
  status: string;
  message: string;
  segments: Array<{ start: number; end: number; source: string }>;
} | {
  episodeId: string;
  jobId: string;
  pollAfterMs: number;
  status: 'queued' | 'running';
};

test('Pod Save America public transcripts return expected ad breaks', async () => {
  test.setTimeout(180000);

  const feed = await fetchPodcastFeed();
  const cageMatch = findEpisode(feed.episodes, 'Cage Match Inside the White House');
  const sedaris = findEpisode(feed.episodes, 'David Sedaris is Mostly Bark, Some Bite');

  await expectAnalysisRanges(cageMatch, [
    [0, 74],
    [1106, 1262.5],
    [2482, 2623.5],
    [4065, 4100.9],
  ]);
  await expectAnalysisRanges(sedaris, [
    [950, 1116.8],
    [2089.5, 2188.2],
    [2920.4, 3022.5],
  ]);
});

async function expectAnalysisRanges(episode: FeedEpisode, expectedRanges: Array<[number, number]>): Promise<void> {
  const analysis = await analyzeEpisode(episode);

  expect(analysis.engine).toBe('public-transcript');
  expect(analysis.segments).toHaveLength(expectedRanges.length);

  expectedRanges.forEach(([expectedStart, expectedEnd], index) => {
    const segment = analysis.segments[index];
    expect(segment.source).toBe('public-transcript');
    expect(segment.start).toBeGreaterThanOrEqual(expectedStart - 3);
    expect(segment.start).toBeLessThanOrEqual(expectedStart + 3);
    expect(segment.end).toBeGreaterThanOrEqual(expectedEnd - 3);
    expect(segment.end).toBeLessThanOrEqual(expectedEnd + 3);
  });
}

async function fetchPodcastFeed(): Promise<{ episodes: FeedEpisode[] }> {
  const response = await fetch(`${apiBaseUrl}/api/feed?url=${encodeURIComponent(podSaveFeedUrl)}`);
  expect(response.ok).toBeTruthy();
  return await response.json() as { episodes: FeedEpisode[] };
}

async function analyzeEpisode(episode: FeedEpisode): Promise<Extract<AnalysisResponse, { segments: unknown[] }>> {
  const sessionResponse = await fetch(`${apiBaseUrl}/api/analyze/session`, { method: 'POST' });
  expect(sessionResponse.ok).toBeTruthy();
  const session = await sessionResponse.json() as { token: string };

  let responsePayload = await requestAnalysis(episode, session.token);
  const startedAt = Date.now();

  while ('jobId' in responsePayload) {
    expect(Date.now() - startedAt).toBeLessThan(150000);
    const pollAfterMs = responsePayload.pollAfterMs || 1000;
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(5000, Math.max(1000, pollAfterMs)));
    });

    const jobResponse = await fetch(`${apiBaseUrl}/api/analyze/jobs/${encodeURIComponent(responsePayload.jobId)}`);
    expect(jobResponse.ok || jobResponse.status === 202).toBeTruthy();
    responsePayload = await jobResponse.json() as AnalysisResponse;
  }

  return responsePayload;
}

async function requestAnalysis(episode: FeedEpisode, sessionToken: string): Promise<AnalysisResponse> {
  const response = await fetch(`${apiBaseUrl}/api/analyze`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-skipcast-session': sessionToken,
    },
    body: JSON.stringify({
      episodeId: episode.id,
      title: episode.title,
      podcastTitle: episode.podcastTitle,
      audioUrl: episode.audioUrl,
      audioType: episode.audioType,
      audioLength: episode.audioLength,
      duration: episode.duration,
    }),
  });

  expect(response.ok || response.status === 202).toBeTruthy();
  return await response.json() as AnalysisResponse;
}

function findEpisode(episodes: FeedEpisode[], title: string): FeedEpisode {
  const episode = episodes.find((candidate) => candidate.title === title);
  expect(episode, `episode "${title}"`).toBeTruthy();
  return episode!;
}
