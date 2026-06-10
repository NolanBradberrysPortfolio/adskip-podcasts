import { expect, test } from '@playwright/test';

const pageBaseUrl = process.env.SKIPCAST_TEST_URL || 'https://nolanbradberrysportfolio.github.io/adskip-podcasts/';
const nprFeedUrl = 'https://feeds.npr.org/510318/podcast.xml';
const sampleOpml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>SkipCast import test</title></head>
  <body>
    <outline text="Up First" title="Up First" type="rss" xmlUrl="${nprFeedUrl}" />
    <outline text="Unsafe local" title="Unsafe local" type="rss" xmlUrl="http://localhost:4300/feed.xml" />
  </body>
</opml>`;

for (const width of [390, 430]) {
  test.describe(`phone import ${width}px`, () => {
    test.use({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });

    test('imports pasted Apple/OPML subscriptions', async ({ page }) => {
      await page.goto(`${pageBaseUrl}?importPhone=${width}-opml-${Date.now()}`, { waitUntil: 'networkidle' });
      await expect(page.getByText('RSS ready')).toBeVisible();

      await page.getByRole('button', { name: 'Import' }).click();
      await expect(page.getByRole('dialog', { name: 'Import Podcasts' })).toBeVisible();
      await page.getByLabel('OPML document').fill(sampleOpml);
      await page.getByRole('button', { name: 'Import OPML' }).click();

      await expect(page.getByText(/Showing 1-12 of \d+ episodes/)).toBeVisible({ timeout: 45000 });
      await expect(page.getByText('Up First from NPR')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test('matches Spotify saved shows to public RSS and imports selected matches', async ({ page }) => {
      await page.goto(`${pageBaseUrl}?importPhone=${width}-spotify-${Date.now()}`, { waitUntil: 'networkidle' });
      await expect(page.getByText('RSS ready')).toBeVisible();

      await page.getByRole('button', { name: 'Import' }).click();
      await page.getByRole('button', { name: 'Spotify' }).click();
      await page.getByLabel('Spotify saved shows').fill('Up First | NPR');
      await page.getByRole('button', { name: 'Match Spotify shows' }).click();

      await expect(page.getByRole('checkbox', { name: /Up First/i })).toBeVisible({ timeout: 45000 });
      await page.getByRole('button', { name: 'Import selected Spotify matches' }).click();

      await expect(page.getByText(/Showing 1-12 of \d+ episodes/)).toBeVisible({ timeout: 45000 });
      await expect(page.getByText('Up First from NPR')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  });
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(horizontalOverflow).toBe(false);
}
