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
  await seedPodSaveEpisode(page, feed, episode);

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
  expect(playbackPosition).toBeGreaterThan(90.5);
  expect(playbackPosition).toBeLessThan(130);
});

test('Pod Save America skip controls still jump over later ads and page remains scrollable after play', async ({ page }) => {
  test.setTimeout(120000);
  const feed = await fetchPodcastFeed();
  const episode = feed.episodes.find((candidate) => /Cage Match Inside the White House/i.test(candidate.title)) || feed.episodes[0];

  await page.goto(`${pageBaseUrl}?podSaveControls=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await seedPodSaveEpisode(page, feed, episode);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Second detected ad segment')).toBeVisible();

  await setPlaybackPosition(page, 1090);
  await page.getByRole('button', { name: 'Forward 30 seconds' }).click();
  await expect
    .poll(async () => playbackPosition(page), { timeout: 30000 })
    .toBeGreaterThan(1264.68);
  expect(await playbackPosition(page)).toBeLessThan(1305);

  await page.getByRole('button', { name: 'Back 15 seconds' }).click();
  await expect
    .poll(async () => playbackPosition(page), { timeout: 30000 })
    .toBeLessThan(1106);
  expect(await playbackPosition(page)).toBeGreaterThan(1095);

  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 15000 });

  const beforeScroll = await largestScrollTop(page);
  await page.mouse.move(200, 420);
  await page.mouse.wheel(0, 900);
  await expect
    .poll(async () => largestScrollTop(page), { timeout: 10000 })
    .toBeGreaterThan(beforeScroll + 20);
});

async function seedPodSaveEpisode(page: import('@playwright/test').Page, feed: Awaited<ReturnType<typeof fetchPodcastFeed>>, episode: Awaited<ReturnType<typeof fetchPodcastFeed>>['episodes'][number]) {
  await page.evaluate(
    ({ feed, episode }) => {
      const episodes = [episode, ...feed.episodes.filter((candidate) => candidate.id !== episode.id)];
      localStorage.setItem('skipcast:feeds:v1', JSON.stringify([{ ...feed, episodes }]));
      localStorage.setItem('skipcast:segments:v1', JSON.stringify({
        [episode.id]: [
          {
            id: `${episode.id}:verified-opening-ad`,
            start: 0,
            end: 90.56,
            category: 'host_read_ad',
            confidence: 0.97,
            label: 'Opening detected ad segment',
            source: 'public-transcript',
            reason: 'Verified Pod Save America opening sponsor read.',
          },
          {
            id: `${episode.id}:verified-second-ad`,
            start: 1106,
            end: 1264.68,
            category: 'host_read_ad',
            confidence: 0.97,
            label: 'Second detected ad segment',
            source: 'public-transcript',
            reason: 'Verified Pod Save America second sponsor break.',
          },
        ],
      }));
    },
    { feed, episode },
  );
}

async function setPlaybackPosition(page: import('@playwright/test').Page, seconds: number) {
  await page.locator('input[aria-label="Playback position"]').evaluate((input, value) => {
    const element = input as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);

  await expect.poll(async () => playbackPosition(page), { timeout: 15000 }).toBeGreaterThan(seconds - 1);
}

async function playbackPosition(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => Number((document.querySelector('input[aria-label="Playback position"]') as HTMLInputElement | null)?.value || 0));
}

async function largestScrollTop(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const candidates = [document.scrollingElement, ...Array.from(document.querySelectorAll('*'))]
      .filter((element): element is Element => Boolean(element))
      .filter((element) => element.scrollHeight > element.clientHeight + 40);
    return Math.max(0, ...candidates.map((element) => element.scrollTop));
  });
}

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
