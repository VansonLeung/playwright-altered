// patchright here!
const { chromium } = require('patchright');

(async () => {
  const query = process.argv.slice(2).join(' ') || 'Playwright browser automation';
  const headless = process.env.HEADLESS === 'true';
  // Google is more likely to challenge automated, headless traffic. The browser
  // is visible by default; set HEADLESS=true if you do not need to see it.
  const browser = await chromium.launch({ headless });

  try {
    const page = await browser.newPage();
    await page.goto('https://www.google.com/?hl=en', {
      waitUntil: 'domcontentloaded',
    });

    const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
    await searchBox.fill(query);
    await searchBox.press('Enter');
    await page.waitForLoadState('domcontentloaded');

    if (new URL(page.url()).pathname.startsWith('/sorry/')) {
      if (headless) {
        throw new Error(
          'Google showed an unusual-traffic challenge. Run without HEADLESS=true and complete the challenge.'
        );
      }

      console.log('Google showed a challenge. Complete it in the browser window...');
      await page.waitForURL(
        (url) => !url.pathname.startsWith('/sorry/'),
        { timeout: 120_000 }
      );
    }

    await page.locator('#search h3').first().waitFor({ timeout: 15_000 });

    const results = await page.locator('#search a:has(h3)').evaluateAll((links) =>
      links.slice(0, 10).map((link) => ({
        title: link.querySelector('h3')?.textContent?.trim(),
        url: link.href,
      }))
    );

    console.log(`Google results for: ${query}\n`);
    results.forEach(({ title, url }, index) => {
      console.log(`${index + 1}. ${title}\n   ${url}`);
    });
  } catch (error) {
    console.error(`Search failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
