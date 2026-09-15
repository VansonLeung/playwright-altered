const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { parseArgs, buildFinancialQueries, runForecast } = require('../t2');

function fakeBrowser() {
  const state = { closed: 0, launchOptions: null };
  return {
    state,
    chromium: {
      async launch(options) {
        state.launchOptions = options;
        return {
          async newPage() {
            return { async close() {}, async waitForTimeout() {} };
          },
          async close() { state.closed += 1; },
        };
      },
    },
    log() {},
  };
}

test('default scope and horizon roll over with the local year', () => {
  const options = parseArgs([], new Date(2029, 11, 31));
  assert.equal(options.engine, 'google');
  assert.equal(options.format, 'json');
  assert.equal(options.horizon, '2029-2031');
  assert.equal(parseArgs([], new Date(2030, 0, 1)).horizon, '2030-2032');
  assert.equal(buildFinancialQueries(options).length, 5);
  assert.ok(buildFinancialQueries(options).every(({ query }) => query.includes('2029-2031')));
});

test('overrides and strict argument validation', () => {
  const options = parseArgs(['--horizon', '2031-2035', '--headed', '--headless']);
  assert.equal(options.horizon, '2031-2035');
  assert.equal(options.headless, true);
  for (const args of [
    ['--max-results', '5junk'], ['--delay', '1.5'], ['--timeout', '0'],
    ['--engine', 'bing'], ['--format', 'csv'], ['--query'], ['--sector', ' '], ['--unknown'],
  ]) assert.throws(() => parseArgs(args));
});

test('default batch uses installed Chrome and accepts an absent AI Overview', async () => {
  const fake = fakeBrowser();
  const calls = [];
  const report = await runForecast(parseArgs(['--headless', '--delay', '0']), {
    ...fake,
    async search(page, engine, query) {
      calls.push({ engine, query });
      return { results: [{ title: '來源', url: 'https://example.com' }], aiOverview: null };
    },
  });
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ engine }) => engine === 'google'));
  assert.equal(fake.state.launchOptions.channel, 'chrome');
  assert.equal(fake.state.launchOptions.headless, true);
  assert.equal(fake.state.closed, 1);
  assert.equal(report.status, 'success');
  assert.equal(report.searches[0].aiOverviewStatus, 'unavailable');
});

test('partial failures retain successful results and available AI sources', async () => {
  let count = 0;
  const report = await runForecast(parseArgs(['--delay', '0']), {
    ...fakeBrowser(),
    async search() {
      if (++count === 2) throw new Error('Navigation failed');
      return { results: [], aiOverview: { text: '摘要', sources: [{ url: 'https://example.com' }] } };
    },
  });
  assert.equal(report.status, 'partial');
  assert.equal(report.searches.filter((entry) => entry.status === 'success').length, 4);
  assert.equal(report.searches[1].error.code, 'SEARCH_FAILED');
  assert.equal(report.searches[0].aiOverviewStatus, 'available');
  assert.equal(report.searches[0].aiOverview.sources.length, 1);
});

test('challenge skips remaining Google searches and continues Yahoo', async () => {
  const calls = [];
  const report = await runForecast(parseArgs(['--engine', 'both', '--delay', '0']), {
    ...fakeBrowser(),
    async search(page, engine) {
      calls.push(engine);
      if (engine === 'google') throw Object.assign(new Error('Verification required'), { code: 'GOOGLE_CHALLENGE' });
      return { results: [], aiOverview: null };
    },
  });
  assert.deepEqual(calls, ['google', 'yahoo', 'yahoo', 'yahoo', 'yahoo', 'yahoo']);
  assert.equal(report.status, 'partial');
  assert.ok(report.searches.slice(0, 5).every((entry) => entry.error.code === 'GOOGLE_CHALLENGE'));
});

test('launch failure returns a structured total failure', async () => {
  const report = await runForecast(parseArgs([]), {
    log() {}, chromium: { async launch() { throw new Error('Chrome missing'); } },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.errors[0].message, 'Chrome missing');
  assert.ok(report.searches.every((entry) => entry.status === 'failed'));
});

test('overall timeout preserves completed searches and closes the browser', async () => {
  const fake = fakeBrowser();
  let count = 0;
  const report = await runForecast(parseArgs(['--timeout', '30', '--delay', '0']), {
    ...fake,
    async search() {
      if (++count > 1) return new Promise(() => {});
      return { results: [{ title: 'Saved', url: 'https://example.com' }], aiOverview: null };
    },
  });
  assert.equal(report.status, 'partial');
  assert.equal(report.errors[0].code, 'TIMEOUT');
  assert.equal(report.searches[0].results[0].title, 'Saved');
  assert.ok(report.searches.slice(1).every((entry) => entry.error.code === 'TIMEOUT'));
  assert.equal(fake.state.closed, 1);
});

test('CLI help works and invalid arguments emit JSON separately from diagnostics', () => {
  const script = path.resolve(__dirname, '../t2.js');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /financial_sector_forecast_fetch/);
  const failure = spawnSync(process.execPath, [script, '--max-results', '5oops'], { encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.equal(JSON.parse(failure.stdout).errors[0].code, 'INVALID_ARGUMENT');
  assert.match(failure.stderr, /Argument error/);
});
