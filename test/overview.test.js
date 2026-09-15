const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('patchright');
const { extractGoogleAiOverview } = require('../t2');

// Real Chrome with local HTML: exercises visibility, clicks, and streamed DOM
// changes without relying on a live Google response or a verification challenge.
test('AI Overview browser regressions', { concurrency: true }, async (t) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const fixture = (body) => `<div id="search"><section>
    <h2>AI 摘要</h2>${body}
    </section><a href="https://organic.example"><h3>Organic result to exclude</h3></a></div>`;
  const run = async (html, setup, budget = 9000) => {
    const page = await browser.newPage();
    try {
      await page.setContent(fixture(html));
      if (setup) await setup(page);
      return await extractGoogleAiOverview(page, budget);
    } finally {
      await page.close();
    }
  };

  await Promise.all([
    t.test('expands 顯示全部 despite a different accessible label and a source 更多 button', async () => {
      const result = await run(`
        <p>First paragraph <a href="https://example.com/report">Research report</a>.</p>
        <aside aria-label="引用來源"><button onclick="window.wrongClick=true">更多</button></aside>
        <div id="rest" hidden><p>Full final paragraph, previously hidden.</p></div>
        <button aria-label="Expand AI response" onclick="document.querySelector('#rest').hidden=false;this.remove()">顯示全部 更多</button>
      `, async (page) => {
        await page.evaluate(() => { window.wrongClick = false; });
        // Any accidental source click would destroy the expected final passage.
        await page.locator('aside button').evaluate((button) => {
          button.onclick = () => document.querySelector('#rest').remove();
        });
      });
      assert.match(result.text, /Full final paragraph/);
      assert.doesNotMatch(result.text, /顯示全部|更多|AI 摘要|Organic result/);
      assert.ok(result.sources.some(({ url }) => url === 'https://example.com/report'));
      assert.equal(result.extractionStatus, 'settled');
    }),
    t.test('waits for delayed expansion and a later streamed paragraph', async () => {
      const result = await run(`
        <p>Initial preview.</p><div id="rest" hidden><p>Expanded paragraph.</p></div>
        <button onclick="this.disabled=true;setTimeout(() => {
          document.querySelector('#rest').hidden=false;this.remove();
          setTimeout(() => document.querySelector('#rest').innerHTML += '<p>Last streamed paragraph.</p>', 1800);
        }, 1800)">顯示全部</button>
      `);
      assert.match(result.text, /Last streamed paragraph/);
      assert.equal(result.extractionStatus, 'settled');
    }),
    t.test('a button that does nothing remains possibly incomplete', async () => {
      const result = await run('<p>Only the preview.</p><button>顯示全部</button>', null, 1800);
      assert.equal(result.extractionStatus, 'possibly_incomplete');
      assert.equal(result.incompleteReason, 'expansion_pending');
      assert.doesNotMatch(result.text, /顯示全部/);
    }),
    t.test('a disappearing button without more content is not confirmed as expanded', async () => {
      const result = await run('<p>Only the preview.</p><button onclick="this.remove()">Show more</button>', null, 1800);
      assert.equal(result.extractionStatus, 'possibly_incomplete');
      assert.equal(result.incompleteReason, 'expansion_pending');
    }),
    t.test('a late expansion control is observed before accepting the preview', async () => {
      const result = await run('<p>Preview before the control loads.</p><div id="rest" hidden><p>Late expanded text.</p></div>', async (page) => {
        await page.evaluate(() => {
          setTimeout(() => {
            const button = document.createElement('button');
            button.textContent = '顯示全部';
            button.onclick = () => {
              document.querySelector('#rest').hidden = false;
              button.remove();
            };
            document.querySelector('section').append(button);
          }, 2600);
        });
      });
      assert.match(result.text, /Late expanded text/);
      assert.equal(result.extractionStatus, 'settled');
    }),
    t.test('short already expanded passages and unrelated menu buttons are supported', async () => {
      const result = await run('<p>A short complete answer.</p><button onclick="document.querySelector(\'p\').remove()">更多</button>');
      assert.equal(result.text, 'A short complete answer.');
      assert.equal(result.extractionStatus, 'settled');
    }),
    t.test('live Google columns keep source-card expansion and clipping out of the passage', async () => {
      const result = await run(`
        <div data-subtree="aimc">
          <div data-container-id="main-col"><p>First paragraph.</p><p>Full final paragraph.</p></div>
          <div data-container-id="rhs-col" data-ignore-copy>
            <div data-src-id="2" style="height:20px;overflow:hidden">
              <a href="https://example.com/citation">Citation title</a>
              <p>Clipped source snippet that is not generated prose.</p>
            </div>
            <div role="button" aria-label="顯示所有相關結果" tabindex="0"
              onclick="document.querySelector('[data-container-id=main-col]').remove()"><span>顯示全部</span></div>
          </div>
        </div>
        <a href="https://policies.google.com/privacy">Privacy policy</a>
      `);
      assert.equal(result.text, 'First paragraph.\nFull final paragraph.');
      assert.equal(result.extractionStatus, 'settled');
      assert.deepEqual(result.sources, [{ title: 'Citation title', url: 'https://example.com/citation' }]);
    }),
    t.test('clipped text is expanded even when its DOM text was already present', async () => {
      const result = await run(`<div id="passage" style="height:20px;overflow:hidden">
        <p>First paragraph.</p><p>Second paragraph.</p><p>Third paragraph.</p></div>
        <button onclick="document.querySelector('#passage').style.height='auto';this.remove()">Show all</button>`);
      assert.match(result.text, /Third paragraph/);
      assert.equal(result.extractionStatus, 'settled');
    }),
    t.test('a busy overview is marked as loading at the deadline', async () => {
      const result = await run('<div aria-busy="true"><p>Still being generated.</p></div>', null, 1200);
      assert.equal(result.extractionStatus, 'possibly_incomplete');
      assert.equal(result.incompleteReason, 'content_loading');
    }),
    t.test('absent overview returns null', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<h1>Ordinary search results</h1>');
        assert.equal(await extractGoogleAiOverview(page, 150), null);
      } finally {
        await page.close();
      }
    }),
  ]);
});
