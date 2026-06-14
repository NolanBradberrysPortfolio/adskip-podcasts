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
      await expect(page.getByText(/AI ready|RSS ready, ads off/)).toBeVisible();

      await page.getByRole('button', { name: 'Import' }).click();
      await expect(page.getByRole('dialog', { name: 'Import Podcasts' })).toBeVisible();
      await page.getByLabel('OPML document').fill(sampleOpml);
      await page.getByRole('button', { name: 'Import OPML' }).click();

      await expect(page.getByText(/Showing 1-12 of \d+ episodes/)).toBeVisible({ timeout: 45000 });
      await expect(page.getByRole('button', { name: /Up First from NPR, 150 episodes/i })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test('keeps useful feedback for zero-feed and partial OPML imports', async ({ page }) => {
      await page.goto(`${pageBaseUrl}?importPhone=${width}-opml-feedback-${Date.now()}`, { waitUntil: 'networkidle' });
      await expect(page.getByText(/AI ready|RSS ready, ads off/)).toBeVisible();

      await page.getByRole('button', { name: 'Import' }).click();
      await page.getByLabel('OPML document').fill('<?xml version="1.0"?><opml version="2.0"><body></body></opml>');
      await page.getByRole('button', { name: 'Import OPML' }).click();
      await expect(page.getByText('No RSS subscriptions found in OPML')).toBeVisible();

      await page.getByLabel('OPML document').fill(sampleOpml);
      await page.getByRole('button', { name: 'Import OPML' }).click();
      await expect(page.getByText(/Apple Podcasts: Imported 1; 1 failed/)).toBeVisible({ timeout: 45000 });
      await expect(page.getByRole('button', { name: /Up First from NPR, 150 episodes/i })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test('starts from the top shortcut and saves dictated podcasts by name', async ({ page }) => {
      await installMockVoiceInput(page, 'Up First | NPR');
      await page.goto(`${pageBaseUrl}?importPhone=${width}-name-shortcut-${Date.now()}`, { waitUntil: 'networkidle' });
      await expect(page.getByText(/AI ready|RSS ready, ads off/)).toBeVisible();

      await page.getByRole('button', { name: 'Save podcasts you listen to' }).click();
      await expect(page.getByRole('dialog', { name: 'Import Podcasts' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Find by name' })).toBeVisible();
      await page.getByRole('button', { name: 'Start voice input' }).click();
      await expect(page.getByLabel('Podcast names')).toHaveValue('Up First | NPR');
      await page.getByRole('button', { name: 'Find RSS feeds' }).click();

      await expect(page.getByRole('checkbox', { name: /Up First/i })).toBeVisible({ timeout: 45000 });
      await page.getByRole('button', { name: 'Save selected podcasts' }).click();

      await expect(page.getByText(/Showing 1-12 of \d+ episodes/)).toBeVisible({ timeout: 45000 });
      await expect(page.getByRole('button', { name: /Up First from NPR, 150 episodes/i })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  });
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(horizontalOverflow).toBe(false);
}

async function installMockVoiceInput(page: import('@playwright/test').Page, transcript: string) {
  await page.addInitScript((spokenText: string) => {
    class FakeSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
      onstart: (() => void) | null = null;
      onresult: ((event: { resultIndex: number; results: unknown[] }) => void) | null = null;
      onerror: ((event: { error?: string; message?: string }) => void) | null = null;
      onend: (() => void) | null = null;

      start() {
        this.onstart?.();
        window.setTimeout(() => {
          const result = [{ transcript: spokenText }];
          (result as unknown as { isFinal: boolean }).isFinal = true;
          this.onresult?.({ resultIndex: 0, results: [result] });
          this.onend?.();
        }, 25);
      }

      stop() {
        this.onend?.();
      }

      abort() {
        this.onend?.();
      }
    }

    const speechWindow = window as Window & {
      SpeechRecognition?: typeof FakeSpeechRecognition;
      webkitSpeechRecognition?: typeof FakeSpeechRecognition;
    };
    speechWindow.SpeechRecognition = FakeSpeechRecognition;
    speechWindow.webkitSpeechRecognition = FakeSpeechRecognition;
  }, transcript);
}
