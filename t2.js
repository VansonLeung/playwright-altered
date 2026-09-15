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
  const scope = `${sector} ${market} ${horizon}`;

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

// Runs in the page. Keep scope, expansion controls, and text extraction together
// so an unrelated source-card button cannot mark the passage as expanded.
function inspectGoogleOverview(expectedLabels) {
  const normalize = (value) => value?.replace(/\s+/g, ' ').trim() || '';
  const isLabel = (text) => expectedLabels.some((label) =>
    text === label || (text.startsWith(`${label} `) && text.length < label.length + 40)
  );
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      element.getClientRects().length > 0;
  };
  const label = Array.from(document.querySelectorAll(
    'h1, h2, h3, [role="heading"], div, span'
  )).find((element) => visible(element) && isLabel(normalize(element.textContent)));
  if (!label) return null;

  // Include siblings of the initial preview, but stop before ordinary results.
  let root = null;
  for (let parent = label.parentElement, level = 0;
    parent && level < 12; parent = parent.parentElement, level += 1) {
    if (['search', 'rso'].includes(parent.id) || ['BODY', 'HTML', 'MAIN'].includes(parent.tagName)) break;
    const organic = Array.from(parent.querySelectorAll('a h3, h3 a'))
      .some((heading) => !isLabel(normalize(heading.textContent)));
    if (organic) break;
    if (visible(parent) && normalize(parent.innerText).length > normalize(label.innerText).length) root = parent;
    if (root && parent.matches('section, article, [role="region"]')) break;
  }
  if (!root) return null;

  // The live Google layout separates generated prose (main-col) from source
  // cards (rhs-col). Reading their shared ancestor mixes both into the answer.
  const passage = Array.from(root.querySelectorAll('[data-container-id="main-col"]'))
    .find(visible) || root;
  const sourceRoot = passage.closest('[data-subtree="aimc"]') || root;

  const controlSelector = 'button, [role="button"], a[aria-expanded], [tabindex][aria-expanded]';
  const allControls = Array.from(document.querySelectorAll(controlSelector));
  const explicitExpand = /^(show (?:more|all)|read more|expand|顯示(?:更多|全部|所有內容)|显示(?:更多|全部|所有内容)|展開(?:全部|更多)?|展开(?:全部|更多)?)(?:\s+(?:more|更多))?$/i;
  const sourceArea = (element) => {
    for (let parent = element; parent && parent !== root; parent = parent.parentElement) {
      if (parent.matches('aside, nav, [role="complementary"], [data-container-id="rhs-col"], [data-src-id]') ||
          /sources|citations|引用來源|資料來源|参考资料/i.test(parent.getAttribute('aria-label') || '')) return true;
    }
    return false;
  };
  const expandButton = allControls.find((element) => {
    if (!root.contains(element) || !visible(element) || sourceArea(element) ||
        element.getAttribute('aria-expanded') === 'true') return false;
    const names = [normalize(element.getAttribute('aria-label')), normalize(element.innerText)];
    if (names.some((name) => explicitExpand.test(name))) return true;
    // A bare "更多" is often a source/menu button. Only accept it when it
    // explicitly controls a passage inside this overview.
    const targets = (element.getAttribute('aria-controls') || '').split(/\s+/)
      .map((id) => document.getElementById(id)).filter(Boolean);
    return names.some((name) => /^(more|更多)$/i.test(name)) &&
      element.getAttribute('aria-expanded') === 'false' &&
      targets.some((target) => root.contains(target) && !sourceArea(target) &&
        target.querySelector('p, li') && normalize(target.textContent).length >= 80);
  });

  let clipped = false;
  const textParts = [];
  const visit = (element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' ||
        element.getAttribute('aria-hidden') === 'true' ||
        element.matches(`script, style, noscript, nav, aside, ${controlSelector}`) ||
        element === label || sourceArea(element)) return;
    if (visible(element) && element.clientHeight > 0 &&
        element.scrollHeight > element.clientHeight + 2 &&
        (['hidden', 'clip'].includes(style.overflowY) || Number(style.webkitLineClamp) > 0)) clipped = true;
    const block = !['inline', 'contents'].includes(style.display);
    if (block) textParts.push('\n');
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) textParts.push(child.textContent);
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') textParts.push('\n');
        else visit(child);
      }
    }
    if (block) textParts.push('\n');
  };
  visit(passage);
  const text = textParts.join('').split('\n').map(normalize).filter(Boolean).join('\n');
  return {
    text,
    sources: Array.from(sourceRoot.querySelectorAll('a[href]')).map((link) => ({
      title: normalize(link.getAttribute('aria-label')) || normalize(link.innerText),
      url: link.href,
    })),
    expandIndex: expandButton ? allControls.indexOf(expandButton) : -1,
    height: passage.getBoundingClientRect().height,
    clipped,
    busy: passage.getAttribute('aria-busy') === 'true' ||
      Array.from(passage.querySelectorAll('[aria-busy="true"], [role="progressbar"]')).some(visible) ||
      passage.closest('[data-scope-id="turn"]')?.getAttribute('data-complete') === 'false',
  };
}

async function extractGoogleAiOverview(page, maxWaitMs) {
  const labels = ['AI Overview', 'AI overview', 'AI 摘要', 'AI 概覽', 'AI 生成的摘要', 'AI 產生的摘要'];
  if (maxWaitMs === 0) return null;
  const deadline = Date.now() + maxWaitMs;
  let overview = null;
  let previousText = '';
  let unchangedSince = Date.now();
  let firstSeen = null;
  let lastClick = 0;
  let clickAttempts = 0;
  let awaitingExpansion = null;
  let settled = false;
  let latest;
  while (Date.now() < deadline) {
    const current = await page.evaluate(inspectGoogleOverview, labels);
    latest = current;
    const now = Date.now();
    if (current) {
      firstSeen ??= now;
      if (current.text) overview = { text: current.text, sources: current.sources };
      if (current.text !== previousText) {
        previousText = current.text;
        unchangedSince = now;
      }
      if (awaitingExpansion && !current.clipped &&
          (current.text.length > awaitingExpansion.textLength ||
           current.height > awaitingExpansion.height + 2)) {
        awaitingExpansion = null;
      }
      if (current.expandIndex >= 0) {
        // Clicking is only an attempt. A remaining control prevents settling.
        unchangedSince = now;
        if (clickAttempts < 3 && now - lastClick >= 2000) {
          lastClick = now;
          clickAttempts += 1;
          awaitingExpansion ??= { textLength: current.text.length, height: current.height };
          await page.locator('button, [role="button"], a[aria-expanded], [tabindex][aria-expanded]')
            .nth(current.expandIndex).click({ timeout: Math.max(1, Math.min(1000, deadline - now)) })
            .catch(() => {}); // The next poll checks whether expansion actually happened.
        }
      } else if (current.busy || current.clipped || awaitingExpansion) {
        unchangedSince = now;
      } else if (current.text && now - unchangedSince >= 3000 && now - firstSeen >= 5000) {
        settled = true;
        break;
      }
    } else {
      unchangedSince = now;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await page.waitForTimeout(Math.min(500, remaining));
  }
  if (!overview) return null;
  overview.extractionStatus = settled ? 'settled' : 'possibly_incomplete';
  if (!settled) {
    overview.incompleteReason = latest?.expandIndex >= 0 || awaitingExpansion ? 'expansion_pending'
      : latest?.busy ? 'content_loading' : latest?.clipped ? 'content_clipped' : 'timeout';
  }

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
      if (aiOverview.extractionStatus === 'possibly_incomplete') {
        console.log(`  摘要可能不完整：${aiOverview.incompleteReason}`);
      }
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

module.exports = { parseArgs, buildFinancialQueries, runForecast, main, extractGoogleAiOverview };
