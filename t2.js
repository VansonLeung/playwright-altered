const { chromium } = require('patchright');

const ENGINES = {
  google: {
    label: 'Google',
    home: 'https://www.google.com/?hl=zh-HK',
    searchBox: 'textarea[name="q"], input[name="q"]',
    resultLinks: '#search a:has(h3)',
  },
  yahoo: {
    label: 'Yahoo 香港',
    home: 'https://hk.yahoo.com/',
    searchBox: 'input[name="p"]',
    resultLinks: '#web h3 a, #web a:has(h3)',
  },
};

function showHelp() {
  console.log(`
Usage:
  node t2.js --query "search terms" [--engine google|yahoo|both]
  node t2.js --sector "半導體" --market "全球市場" --horizon "2026-2028"

Options:
  --engine       google, yahoo, or both (default: both)
  --query        Run one ordinary/custom search instead of the financial query set
  --sector       Industry or theme to investigate (default: 整體產業板塊)
  --market       Market to investigate (default: 全球市場)
  --horizon      Forecast period (default: 2026-2028)
  --max-results  Results retained per query and engine (default: 5)
  --ai-wait      Max milliseconds to wait for a Google AI Overview (default: 45000)
  --delay        Delay between searches in milliseconds (default: 1500)
  --help         Show this help

The browser is visible by default. Set HEADLESS=true to hide it.
`);
}

function parseArgs(argv) {
  const options = {
    engine: 'both',
    query: '',
    sector: '整體產業板塊',
    market: '全球市場',
    horizon: '2026-2028',
    maxResults: 5,
    aiWait: 45_000,
    delay: 1500,
  };

  const names = {
    '--engine': 'engine',
    '--query': 'query',
    '--sector': 'sector',
    '--market': 'market',
    '--horizon': 'horizon',
    '--max-results': 'maxResults',
    '--ai-wait': 'aiWait',
    '--delay': 'delay',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    const key = names[argument];
    if (!key) {
      throw new Error(`Unknown option: ${argument}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }

    options[key] = value;
    index += 1;
  }

  options.maxResults = Number.parseInt(options.maxResults, 10);
  options.aiWait = Number.parseInt(options.aiWait, 10);
  options.delay = Number.parseInt(options.delay, 10);

  if (!['google', 'yahoo', 'both'].includes(options.engine)) {
    throw new Error('--engine must be google, yahoo, or both');
  }
  if (!Number.isInteger(options.maxResults) || options.maxResults < 1 || options.maxResults > 20) {
    throw new Error('--max-results must be an integer from 1 to 20');
  }
  if (!Number.isInteger(options.aiWait) || options.aiWait < 0 || options.aiWait > 120_000) {
    throw new Error('--ai-wait must be an integer from 0 to 120000');
  }
  if (!Number.isInteger(options.delay) || options.delay < 0 || options.delay > 60_000) {
    throw new Error('--delay must be an integer from 0 to 60000');
  }

  return options;
}

function buildFinancialQueries({ sector, market, horizon }) {
  const scope = `"${sector}" "${market}" "${horizon}"`;

  return [
    {
      category: '政策與補貼（潛在優勢）',
      query: `${scope} (產業政策 OR 補貼 OR 扶持 OR 發展規劃 OR 法案 OR subsidies OR "sector winners")`,
    },
    {
      category: '資金流向（機構取態）',
      query: `${scope} (資金流向 OR 融資 OR "fund flows" OR "13F filing" OR "new positions" OR "capital expenditure")`,
    },
    {
      category: '技術與替代效應（增長或顛覆）',
      query: `${scope} (技術突破 OR 商業化 OR "technology adoption" OR disruption OR "AI replacement") (CAGR OR forecast OR 市場規模)`,
    },
    {
      category: '產業數據與專業研報',
      query: `${scope} ("industry outlook" OR 產業展望 OR 產業趨勢) (CAGR OR revenue OR margin OR 利潤率) filetype:pdf`,
    },
    {
      category: '下行風險（潛在劣勢）',
      query: `${scope} (overcapacity OR "declining margin" OR "job cuts" OR restructuring OR 產能過剩 OR 毛利率下滑 OR 裁員 OR 淘汰)`,
    },
  ];
}

function cleanResultUrl(url, engine) {
  if (engine === 'google') {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.endsWith('google.com') && parsed.pathname === '/url') {
        return parsed.searchParams.get('q') || parsed.searchParams.get('url') || url;
      }
    } catch {
      return url;
    }
    return url;
  }

  if (engine !== 'yahoo') return url;

  // Yahoo sometimes wraps the destination inside a tracking URL.
  const match = url.match(/\/RU=([^/]+)\/RK=/);
  if (!match) return url;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return url;
  }
}

async function extractGoogleAiOverview(page, maxWaitMs) {
  // Google does not publish a stable DOM API for AI Overviews. Locate the
  // feature by its visible heading so this works across changing CSS classes.
  const labels = [
    'AI Overview',
    'AI overview',
    'AI 摘要',
    'AI 概覽',
    'AI 生成的摘要',
    'AI 產生的摘要',
  ];

  if (maxWaitMs === 0) return null;

  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  const headingFound = await page.waitForFunction(
    (expectedLabels) => {
      const elements = document.querySelectorAll('h1, h2, h3, [role="heading"], div, span');
      return Array.from(elements).some((element) => {
        const text = element.textContent?.replace(/\s+/g, ' ').trim();
        return expectedLabels.some((label) =>
          text === label || (text?.startsWith(`${label} `) && text.length < label.length + 40)
        );
      });
    },
    labels,
    { timeout: maxWaitMs }
  ).catch(() => null);

  if (!headingFound) return null;

  const tryExpand = () => page.evaluate((expectedLabels) => {
    const normalize = (value) => value?.replace(/\s+/g, ' ').trim() || '';
    const isLabel = (text) => expectedLabels.some((label) =>
      text === label || (text.startsWith(`${label} `) && text.length < label.length + 40)
    );
    const labels = Array.from(
      document.querySelectorAll('h1, h2, h3, [role="heading"], div, span')
    );
    const label = labels.find((element) => isLabel(normalize(element.textContent)));
    if (!label) return false;

    let container = label;
    for (let level = 0; container && level < 8; level += 1) {
      const button = Array.from(container.querySelectorAll('button, [role="button"]')).find(
        (element) => /^(show more|more|顯示更多|更多)$/i.test(
          normalize(element.getAttribute('aria-label')) || normalize(element.innerText)
        )
      );
      if (button) {
        button.click();
        return true;
      }
      container = container.parentElement;
    }
    return false;
    }, labels);

  let expanded = await tryExpand();

  if (expanded) await page.waitForTimeout(1_000);

  const readOverview = () => page.evaluate((expectedLabels) => {
      const normalize = (value) => value?.replace(/\s+/g, ' ').trim() || '';
      const isLabel = (text) => expectedLabels.some((label) =>
        text === label || (text.startsWith(`${label} `) && text.length < label.length + 40)
      );
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.height > 0;
      };

      const elements = Array.from(
        document.querySelectorAll('h1, h2, h3, [role="heading"], div, span')
      );
      const label = elements.find((element) =>
        isVisible(element) && isLabel(normalize(element.textContent))
      );
      if (!label) return null;

      // Pick the smallest visible ancestor that contains a useful amount of
      // generated text. Avoid climbing as far as Google's complete result list.
      let container = label;
      let best = null;
      for (let level = 0; container && level < 10; level += 1) {
        const text = normalize(container.innerText);
        const organicHeadings = container.querySelectorAll('h3').length;
        if (
          isVisible(container) &&
          text.length >= 120 &&
          text.length <= 15_000 &&
          organicHeadings <= 3
        ) {
          best = container;
          if (container.querySelectorAll('a[href]').length > 0) break;
        }
        if (container.id === 'search') break;
        container = container.parentElement;
      }
      if (!best) return null;

      const sourceLinks = Array.from(best.querySelectorAll('a[href]')).map((link) => ({
        title: normalize(link.getAttribute('aria-label')) || normalize(link.innerText),
        url: link.href,
      }));

      return {
        text: normalize(best.innerText),
        sources: sourceLinks,
      };
    }, labels);

  // AI Overview text is streamed after the normal result page is ready. Keep
  // sampling until the text is unchanged for three reads (about two seconds).
  let overview = null;
  let previousText = '';
  let stableReads = 0;
  while (Date.now() < deadline) {
    const current = await readOverview();
    if (current) {
      if (!expanded) {
        expanded = await tryExpand();
        if (expanded) {
          previousText = '';
          stableReads = 0;
          await page.waitForTimeout(1_000);
          continue;
        }
      }

      overview = current;
      if (current.text === previousText) {
        stableReads += 1;
        if (stableReads >= 2) break;
      } else {
        previousText = current.text;
        stableReads = 0;
      }
    }
    await page.waitForTimeout(1_000);
  }

  if (!overview) return null;

  const seen = new Set();
  overview.sources = overview.sources
    .map((source) => ({
      title: source.title,
      url: cleanResultUrl(source.url, 'google'),
    }))
    .filter((source) => {
      try {
        const url = new URL(source.url);
        const isGoogleNavigation =
          url.hostname.endsWith('google.com') &&
          ['/search', '/preferences', '/setprefs'].includes(url.pathname);
        if (isGoogleNavigation || seen.has(source.url)) return false;
      } catch {
        return false;
      }
      seen.add(source.url);
      return true;
    })
    .map((source) => ({
      ...source,
      title: source.title || new URL(source.url).hostname,
    }));

  return overview;
}

async function handleGoogleChallenge(page, headless) {
  const isChallenge = new URL(page.url()).pathname.startsWith('/sorry/');
  if (!isChallenge) return;

  if (headless) {
    throw new Error('Google 顯示 unusual-traffic 驗證；請取消 HEADLESS=true 後重試');
  }

  console.log('  Google 要求驗證，請在瀏覽器視窗完成驗證（最多等候 2 分鐘）...');
  await page.waitForURL(
    (url) => !url.pathname.startsWith('/sorry/'),
    { timeout: 120_000 }
  );
}

async function search(page, engineName, query, maxResults, headless, aiWait) {
  const engine = ENGINES[engineName];
  await page.goto(engine.home, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  const searchBox = page.locator(engine.searchBox).first();
  await searchBox.waitFor({ state: 'visible', timeout: 15_000 });
  await searchBox.fill(query);

  const navigation = page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await searchBox.press('Enter');
  const response = await navigation;

  if (engineName === 'google') {
    await handleGoogleChallenge(page, headless);
  }

  if (response && response.status() >= 400) {
    throw new Error(`${engine.label} 回傳 HTTP ${response.status()}`);
  }

  const resultLinks = page.locator(engine.resultLinks);
  await resultLinks.first().waitFor({ state: 'attached', timeout: 20_000 });

  const rawResults = await resultLinks.evaluateAll((links, limit) =>
    links.slice(0, limit).map((link) => ({
      title: (link.querySelector('h3') || link).textContent?.trim(),
      url: link.href,
    })),
    maxResults
  );

  const seen = new Set();
  const results = rawResults
    .map((result) => ({
      title: result.title,
      url: cleanResultUrl(result.url, engineName),
    }))
    .filter((result) => {
      if (!result.title || !result.url || seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    });

  const aiOverview = engineName === 'google'
    ? await extractGoogleAiOverview(page, aiWait)
    : null;

  return { results, aiOverview };
}

function printResults(engineLabel, category, query, results, aiOverview) {
  console.log(`\n[${engineLabel}] ${category}`);
  console.log(`查詢：${query}`);

  if (engineLabel === ENGINES.google.label) {
    console.log('\n  Google AI Overview：');
    if (!aiOverview) {
      console.log('  此次搜尋沒有回傳 AI Overview');
    } else {
      console.log(`  ${aiOverview.text}`);
      if (aiOverview.sources.length > 0) {
        console.log('  AI Overview 引用來源：');
        aiOverview.sources.forEach(({ title, url }, index) => {
          console.log(`    ${index + 1}. ${title}`);
          console.log(`       ${url}`);
        });
      }
    }
  }

  console.log('\n  一般搜尋結果：');

  if (results.length === 0) {
    console.log('  沒有擷取到結果');
    return;
  }

  results.forEach(({ title, url }, index) => {
    console.log(`  ${index + 1}. ${title}`);
    console.log(`     ${url}`);
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`參數錯誤：${error.message}`);
    showHelp();
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    showHelp();
    return;
  }

  const queries = options.query
    ? [{ category: '自訂搜尋', query: options.query }]
    : buildFinancialQueries(options);
  const engineNames = options.engine === 'both'
    ? ['google', 'yahoo']
    : [options.engine];
  const headless = process.env.HEADLESS === 'true';
  const browser = await chromium.launch({ headless });
  let successfulSearches = 0;

  console.log('金融前景與風險搜尋');
  if (!options.query) {
    console.log(`市場：${options.market}｜板塊：${options.sector}｜期間：${options.horizon}`);
  }

  try {
    for (const engineName of engineNames) {
      const page = await browser.newPage();

      for (const item of queries) {
        try {
          const { results, aiOverview } = await search(
            page,
            engineName,
            item.query,
            options.maxResults,
            headless,
            options.aiWait
          );
          successfulSearches += 1;
          printResults(
            ENGINES[engineName].label,
            item.category,
            item.query,
            results,
            aiOverview
          );
        } catch (error) {
          console.error(`\n[${ENGINES[engineName].label}] ${item.category} 搜尋失敗：${error.message}`);
        }

        if (options.delay > 0) {
          await page.waitForTimeout(options.delay);
        }
      }

      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log('\n注意：搜尋結果是研究線索，不是投資建議。請核對發布日期、原始數據、估值及相反證據。');
  if (successfulSearches === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`程式失敗：${error.message}`);
  process.exitCode = 1;
});
