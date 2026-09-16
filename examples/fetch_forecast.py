"""Import fetch_forecast into the existing daily report job, or run this file."""

import json
import os
import subprocess


def fetch_forecast(*extra_args, executable=None):
    # Scheduled jobs often have a minimal PATH. Set this to an absolute path.
    command = executable or os.environ.get(
        "FINANCIAL_FORECAST_CLI", "financial_sector_forecast_fetch"
    )
    try:
        completed = subprocess.run(
            [command, *extra_args, "--format", "json", "--headed", "--timeout", "360000"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=380,
            check=False,  # Exit 2 still contains usable partial results.
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "schemaVersion": 1, "status": "failed", "searches": [],
            "errors": [{"code": "CLI_UNAVAILABLE", "message": str(error)}],
        }
    try:
        report = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {
            "schemaVersion": 1, "status": "failed", "searches": [],
            "errors": [{
                "code": "INVALID_OUTPUT",
                "message": completed.stderr.strip() or "CLI returned no valid JSON",
            }],
        }
    return report


if __name__ == "__main__":
    print(json.dumps(fetch_forecast(), ensure_ascii=False, indent=2))
