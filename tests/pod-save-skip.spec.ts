import { expect, test } from '@playwright/test';

const pageBaseUrl = process.env.SKIPCAST_TEST_URL || 'https://nolanbradberrysportfolio.github.io/adskip-podcasts/';
const apiBaseUrl = process.env.SKIPCAST_API_URL || process.env.EXPO_PUBLIC_API_URL || 'https://globe-header-entrance-friendly.trycloudflare.com';
const podSaveFeedUrl = 'https://audioboom.com/channels/5166624.rss';

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});

test('Pod Save America playback skips a detected opening ad segment', async ({ page }) => {
  test.setTimeout(120000);
  const feed = await fetchPodcastFeed();
  const episode = feed.episodes.find((candidate) => /Cage Match Inside the White House/i.test(candidate.title)) || feed.episodes[0];

  await page.goto(`${pageBaseUrl}?podSaveSkip=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ feed, episode }) => {
      localStorage.setItem('skipcast:feeds:v1', JSON.stringify([{ ...feed, episodes: [episode] }]));
      localStorage.setItem('skipcast:segments:v1', JSON.stringify({
        [episode.id]: [{
          id: `${episode.id}:verified-opening-ad`,
          start: 0,
          end: 30.5,
          category: 'host_read_ad',
          confidence: 0.97,
          label: 'Opening detected ad segment',
          source: 'codex-ad-model',
          reason: 'Verified Pod Save America opening sponsor read.',
        }],
      }));
    },
    { feed, episode },
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Opening detected ad segment')).toBeVisible();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 15000 });

  await expect
    .poll(async () => {
      return page.evaluate(() => Number((document.querySelector('input[aria-label="Playback position"]') as HTMLInputElement | null)?.value || 0));
    }, { timeout: 30000 })
    .toBeGreaterThan(30.5);

  const playbackPosition = await page.evaluate(() => Number((document.querySelector('input[aria-label="Playback position"]') as HTMLInputElement | null)?.value || 0));
  expect(playbackPosition).toBeLessThan(90);
});

async function fetchPodcastFeed() {
  const response = await fetch(`${apiBaseUrl}/api/feed?url=${encodeURIComponent(podSaveFeedUrl)}`);
  expect(response.ok).toBeTruthy();
  return await response.json() as {
    id: string;
    title: string;
    feedUrl: string;
    episodes: Array<{
      id: string;
      title: string;
      podcastTitle: string;
      audioUrl: string;
      audioType?: string;
      audioLength?: number;
      duration?: number;
      artworkUrl?: string;
    }>;
  };
}
