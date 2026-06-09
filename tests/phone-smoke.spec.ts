import { expect, test } from '@playwright/test';

const pageUrl = `https://nolanbradberrysportfolio.github.io/adskip-podcasts/?phoneSmoke=${Date.now()}`;
const feedUrl = 'https://feeds.npr.org/510318/podcast.xml';

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});

test('GitHub Pages phone web flow can add RSS and reach the player', async ({ page }) => {
  await page.goto(pageUrl, { waitUntil: 'networkidle' });
  await expect(page.getByText('RSS ready')).toBeVisible();
  await expect(page.getByText('API unavailable')).toHaveCount(0);

  await page.getByLabel('Podcast RSS feed URL').fill(feedUrl);
  await page.getByRole('button', { name: 'Add feed' }).click();

  await expect(page.getByText(/Showing 1-12 of \d+ episodes/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Analysis off').first()).toBeVisible();
  await expect(page.getByText('Skip segments')).toHaveCount(0);

  await page.getByRole('button', { name: /no skip segments/i }).first().click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const playButton = document.querySelector('[aria-label="Play"]')?.getBoundingClientRect();
    return {
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      playTop: playButton?.top ?? null,
      playBottom: playButton?.bottom ?? null,
      viewportHeight: window.innerHeight,
    };
  });

  expect(metrics.horizontalOverflow).toBe(false);
  expect(metrics.playTop).not.toBeNull();
  expect(metrics.playBottom).not.toBeNull();
  expect(metrics.playTop!).toBeGreaterThanOrEqual(0);
  expect(metrics.playBottom!).toBeLessThanOrEqual(metrics.viewportHeight);
});
