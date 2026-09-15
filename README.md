# financial_sector_forecast_fetch

Fetch Google search titles/URLs and Google AI Overview text/sources for a daily
industry report. The command gathers research material; it does not read linked
articles or generate its own analysis.

## Install on the Mac running your Python job

Install Node.js 20 or newer and Google Chrome, then copy this project to that Mac.
From the project folder:

```sh
npm ci
npm install --global .
financial_sector_forecast_fetch --help
```

The command uses installed Chrome with a separate temporary browser context.
It does not use your personal Chrome profile. No separate Chromium download is
needed. You can also run `node /absolute/path/to/t2.js` without global installation.

## Usage

```sh
# No input: five searches, Google, global industries, JSON, headless Chrome.
financial_sector_forecast_fetch

# Optional scope or a single custom query.
financial_sector_forecast_fetch --sector "半導體" --market "美國"
financial_sector_forecast_fetch --query "NVDA earnings outlook"

# Readable output and visible Chrome for interactive use.
financial_sector_forecast_fetch --format text --headed

# Optional engine and horizon overrides.
financial_sector_forecast_fetch --engine both --horizon "2027-2030"
```

Without `--horizon`, the local year at invocation determines the inclusive
forecast window: `2026-2028` during 2026, `2027-2029` during 2027, etc.
Default scope is `整體產業板塊` and `全球市場`. The five searches cover policy,
capital flows, technology, industry research, and downside risks.
Google uses its Hong Kong Chinese homepage; the preset queries mix Chinese and
English. The horizon is a search term, not a filter on article publication dates.

`--help` lists limits and timing options. The default work timeout is six minutes,
followed by up to five seconds for browser cleanup. `--ai-wait 0` disables AI
Overview extraction. Headless is the default; `HEADLESS=false` enables visible
Chrome unless `--headless` is explicitly supplied.

## JSON contract and failures

JSON output is one document on stdout; progress and diagnostics go to stderr.
`--help` always prints usage text. Invalid arguments emit a JSON error document.

| Exit code | `status` | Meaning |
| --- | --- | --- |
| 0 | `success` | All requested searches completed |
| 2 | `partial` | Some results survived a search, timeout, or cleanup failure |
| 1 | `failed` | No searches completed, or arguments were invalid |

Normal reports contain `schemaVersion: 1`, UTC `startedAt` and `completedAt`,
resolved `options`, `status`, `searches`, and run-level `errors`.
Each search contains:

- `engine`, `category`, and the actual `query`.
- `status`: `success` or `failed`.
- `results`: objects with `title` and `url`.
- `aiOverview`: `{ "text": "...", "sources": [{ "title": "...", "url": "..." }] }`, or `null`.
- `aiOverviewStatus`: `available`, `unavailable`, `disabled`, or `not_applicable`.
- `error`: `{ "code": "...", "message": "..." }`, or `null`.

When `aiOverview` is present, it also includes `extractionStatus`:

- `settled`: no recognized collapsed control, clipping, or loading indicator
  remained, and the passage stopped changing during the observation period.
- `possibly_incomplete`: the wait expired before those checks passed.
  `incompleteReason` identifies `expansion_pending`, `content_loading`,
  `content_clipped`, or `timeout`. The text obtained so far is still returned.

The extractor recognizes `顯示全部` and other expansion labels, checks for added
text or increased passage height after clicking, and excludes interface controls
from the text. Paragraph breaks are preserved. `settled` is a DOM observation,
not a guarantee that Google supplied its entire response; extraction still
depends on recognizing the page structure.

An unavailable AI Overview does not fail an otherwise successful search.
`unavailable` means no overview was obtained; it may not have appeared, loaded
in time, or matched the extraction logic. Google verification in headless mode
produces `GOOGLE_CHALLENGE` and skips remaining Google queries. Other engines,
if requested, continue. Completed results survive the overall timeout.
Search-page changes and verification can prevent a daily fetch from succeeding.

## Python integration at 6 a.m.

See [examples/fetch_forecast.py](examples/fetch_forecast.py). Import its helper
into your existing job:

```python
from fetch_forecast import fetch_forecast

report = fetch_forecast()  # No query or year required.
usable_searches = [s for s in report["searches"] if s["status"] == "success"]
# Feed usable_searches into the daily report. Record report["errors"] and any
# per-search errors when status is partial or failed.
```

The example forces JSON, headless mode, and a six-minute CLI timeout. Its outer
Python timeout is 380 seconds. It returns structured errors for launch failures
or invalid output so the rest of your report can continue.

On the target Mac, run `command -v financial_sector_forecast_fetch` and
`command -v node`. Set `FINANCIAL_FORECAST_CLI` to the absolute command path and
ensure the scheduled job's `PATH` includes the directory containing Node.js.
An absolute CLI path still needs Node on `PATH` because its shebang uses `env`.
Keep your existing 6 a.m. scheduling; this CLI runs once per invocation.

## Development

```sh
npm test
```

Tests use a fake browser to check defaults, year rollover, partial failures,
verification handling, timeouts, cleanup, and the CLI output contract.
AI Overview regression tests also launch installed Chrome with local HTML
fixtures to check expansion, streaming, clipping, and incomplete-result reporting.
They do not contact Google. Chrome must be installed to run the full test suite.
