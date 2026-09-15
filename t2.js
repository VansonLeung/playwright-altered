#!/usr/bin/env node
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

const COMMAND = 'financial_sector_forecast_fetch';

function showHelp() {
  console.log(`
Usage:
  ${COMMAND}
  ${COMMAND} --query "search terms" --format text --headed
  ${COMMAND} --sector "半導體" --market "全球市場"
  node t2.js [options]

Options:
  --engine       google, yahoo, or both (default: google)
  --query        One custom search instead of the five industry searches
  --sector       Industry or theme (default: 整體產業板塊)
  --market       Market (default: 全球市場)
  --horizon      Forecast period (default: local current year through year + 2)
  --format       json or text (default: json)
  --headless     Hide Chrome (default)
  --headed       Show Chrome; allows manual Google verification
  --max-results  Results per query and engine, 1–20 (default: 5)
  --ai-wait      Google AI Overview wait, 0–120000 ms (default: 45000)
  --delay        Delay between searches, 0–60000 ms (default: 1500)
  --timeout      Overall work timeout, 1–3600000 ms (default: 360000)
  --help, -h     Show this help

Requires Node.js >=20 and installed Google Chrome.
JSON goes to stdout; progress goes to stderr. Cleanup may take up to 5 seconds.
Exit codes: 0 success, 2 partial results, 1 total failure or invalid arguments.
HEADLESS=true|false is supported; explicit browser flags take precedence.
`);
}

function parseArgs(argv, now = new Date()) {
  const year = now.getFullYear();
  const options = {
    engine: 'google',
    query: '',
    sector: '整體產業板塊',
    market: '全球市場',
    horizon: `${year}-${year + 2}`,
    format: 'json',
    headless: process.env.HEADLESS !== 'false',
    maxResults: 5,
    aiWait: 45_000,
    delay: 1500,
    timeout: 360_000,
  };
  if (argv.includes('--help') || argv.includes('-h')) return { ...options, help: true };

  const names = {
    '--engine': 'engine', '--query': 'query', '--sector': 'sector',
    '--market': 'market', '--horizon': 'horizon', '--format': 'format',
    '--max-results': 'maxResults', '--ai-wait': 'aiWait', '--delay': 'delay',
    '--timeout': 'timeout',
  };
  const numeric = {
    maxResults: [1, 20], aiWait: [0, 120_000], delay: [0, 60_000],
    timeout: [1, 3_600_000],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--headed' || argument === '--headless') {
      options.headless = argument === '--headless';
      continue;
    }
    const key = names[argument];
    if (!key) throw new Error(`Unknown option: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith('--') || !value.trim()) {
      throw new Error(`Missing value for ${argument}`);
    }
    if (numeric[key]) {
      const [min, max] = numeric[key];
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
          Number(value) < min || Number(value) > max) {
        throw new Error(`${argument} must be an integer from ${min} to ${max}`);
      }
      options[key] = Number(value);
    } else {
      options[key] = value;
    }
  }
  if (!['google', 'yahoo', 'both'].includes(options.engine)) {
    throw new Error('--engine must be google, yahoo, or both');
  }
  if (!['json', 'text'].includes(options.format)) {
    throw new Error('--format must be json or text');
  }
  return options;
}

function buildFinancialQueries({ sector, market, horizon }) {
  const scope = `"${sector}" "${market}" "${horizon}"`;

  return [
    {
      category: '政策與補貼（潛在優勢）',
      query: `請簡單說明： ${scope} (產業政策 OR 補貼 OR 扶持 OR 發展規劃 OR 法案 OR subsidies OR "sector winners")`,
    },
    {
      category: '資金流向（機構取態）',
      query: `請簡單說明： ${scope} (資金流向 OR 融資 OR "fund flows" OR "13F filing" OR "new positions" OR "capital expenditure")`,
    },
    {
      category: '技術與替代效應（增長或顛覆）',
      query: `請簡單說明： ${scope} (技術突破 OR 商業化 OR "technology adoption" OR disruption OR "AI replacement") (CAGR OR forecast OR 市場規模)`,
    },
    {
      category: '產業數據與專業研報',
      query: `請簡單說明： ${scope} ("industry outlook" OR 產業展望 OR 產業趨勢) (CAGR OR revenue OR margin OR 利潤率)`,
    },
    {
      category: '下行風險（潛在劣勢）',
      query: `請簡單說明： ${scope} (overcapacity OR "declining margin" OR "job cuts" OR restructuring OR 產能過剩 OR 毛利率下滑 OR 裁員 OR 淘汰)`,
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
    throw Object.assign(new Error('Google requires verification; retry interactively with --headed'), { code: 'GOOGLE_CHALLENGE' });
  }

  console.error('  Google 要求驗證，請在瀏覽器視窗完成驗證（最多等候 2 分鐘）...');
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

function errorInfo(error, fallback = 'SEARCH_FAILED') {
  return { code: error.code || fallback, message: error.message || String(error) };
}

async function runForecast(options, dependencies = {}) {
  const launcher = dependencies.chromium || chromium;
  const performSearch = dependencies.search || search;
  const log = dependencies.log || ((message) => console.error(message));
  const queries = options.query
    ? [{ category: '自訂搜尋', query: options.query }]
    : buildFinancialQueries(options);
  const engines = options.engine === 'both' ? ['google', 'yahoo'] : [options.engine];
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'failed',
    options: { ...options },
    searches: engines.flatMap((engine) => queries.map((item) => ({
      engine, ...item, status: 'pending', results: [], aiOverview: null,
      aiOverviewStatus: engine !== 'google' ? 'not_applicable'
        : options.aiWait === 0 ? 'disabled' : 'unavailable',
      error: null,
    }))),
    errors: [],
  };
  let browser;
  let stopped = false;
  let timer;
  let stopError;
  const work = async () => {
    browser = await launcher.launch({
      channel: 'chrome', headless: options.headless,
      timeout: Math.min(options.timeout, 30_000),
    });
    // A launch completing after the deadline must not leave Chrome running.
    if (stopped) {
      await browser.close();
      return;
    }
    for (const engine of engines) {
      const page = await browser.newPage();
      const entries = report.searches.filter((entry) => entry.engine === engine);
      for (let index = 0; index < entries.length; index += 1) {
        if (stopped) return;
        const entry = entries[index];
        log(`[${engine}] ${entry.category}: ${entry.query}`);
        try {
          const result = await performSearch(page, engine, entry.query,
            options.maxResults, options.headless, options.aiWait);
          if (stopped) return;
          Object.assign(entry, result, {
            status: 'success',
            aiOverviewStatus: result.aiOverview ? 'available' : entry.aiOverviewStatus,
          });
        } catch (error) {
          if (stopped) return;
          entry.status = 'failed';
          entry.error = errorInfo(error);
          log(`[${engine}] ${entry.error.message}`);
          // Repeated requests cannot resolve an unattended verification challenge.
          if (entry.error.code === 'GOOGLE_CHALLENGE') {
            for (const remaining of entries.slice(index + 1)) {
              remaining.status = 'failed';
              remaining.error = { ...entry.error };
            }
            break;
          }
        }
        if (options.delay > 0 && index < entries.length - 1) {
          await page.waitForTimeout(options.delay);
        }
      }
      await page.close();
    }
  };

  try {
    await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(
          new Error(`Overall timeout after ${options.timeout} ms`),
          { code: 'TIMEOUT' }
        )), options.timeout);
      }),
    ]);
  } catch (error) {
    stopError = errorInfo(error, 'RUN_FAILED');
    report.errors.push(stopError);
    log(stopError.message);
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (browser) {
      let cleanupTimer;
      try {
        await Promise.race([
          browser.close(),
          new Promise((_, reject) => {
            cleanupTimer = setTimeout(() => reject(Object.assign(
              new Error('Chrome cleanup exceeded 5000 ms'),
              { code: 'CLEANUP_FAILED' }
            )), 5000);
          }),
        ]);
      } catch (error) {
        report.errors.push(errorInfo(error, 'CLEANUP_FAILED'));
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
  }
  for (const entry of report.searches) {
    if (entry.status === 'pending') {
      entry.status = 'failed';
      entry.error = stopError || { code: 'NOT_RUN', message: 'Search did not run' };
    }
  }
  const successful = report.searches.filter((entry) => entry.status === 'success').length;
  report.status = successful === 0 ? 'failed'
    : successful === report.searches.length && report.errors.length === 0 ? 'success' : 'partial';
  report.completedAt = new Date().toISOString();
  return report;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`Argument error: ${error.message}. Use --help for usage.`);
    console.log(JSON.stringify({
      schemaVersion: 1, status: 'failed', searches: [],
      errors: [errorInfo(error, 'INVALID_ARGUMENT')],
    }));
    return 1;
  }
  if (options.help) {
    showHelp();
    return 0;
  }
  const report = await runForecast(options);
  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`金融前景與風險搜尋 (${report.options.horizon})`);
    for (const entry of report.searches) {
      if (entry.status === 'success') {
        printResults(ENGINES[entry.engine].label, entry.category, entry.query,
          entry.results, entry.aiOverview);
      } else {
        console.log(`\n[${entry.engine}] ${entry.category}: ${entry.error.message}`);
      }
    }
    for (const error of report.errors) console.log(`\n${error.code}: ${error.message}`);
    console.log(`\nStatus: ${report.status}`);
  }
  return { success: 0, partial: 2, failed: 1 }[report.status];
}

if (require.main === module) {
  main().then((code) => {
    // Flush piped output before exiting, including after a browser timeout.
    process.stdout.write('', () => {
      process.stderr.write('', () => process.exit(code));
    });
  }).catch((error) => {
    console.error(`Unexpected failure: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, buildFinancialQueries, runForecast, main };
