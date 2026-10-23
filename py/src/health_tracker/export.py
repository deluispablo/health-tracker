"""Export D1, rehearse a restore, and retain eight verified backup pairs."""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

REQUIRED_TABLES = {
    "metric_minute", "daily_summary", "sleep_session", "event",
    "tracker", "audit_log", "profile", "weight_log",
    "tracker_daily", "finding", "secret_blob", "sync_pending",
}
WORKER = Path(__file__).resolve().parents[3] / "worker"


def shrink(directory, day, counts):
    """Return why the export looks truncated against the newest previous manifest, or None."""
    for table in ("event", "metric_minute"):
        if not counts.get(table):
            return f"Rejected: {table} has 0 rows"
    names = sorted((
        path.name for path in directory.glob("health-tracker-*.json")
        if re.fullmatch(r"health-tracker-\d{4}-\d{2}-\d{2}\.json", path.name)
        and path.name != f"health-tracker-{day}.json"
    ), reverse=True)
    for name in names:
        try:
            tables = json.loads((directory / name).read_text(encoding="utf-8"))["tables"]
            event, minute = tables["event"], tables["metric_minute"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if not all(type(value) is int and value >= 0 for value in (event, minute)):
            continue
        if counts["event"] < event:
            return f"Rejected: event has {counts['event']} rows, {name} had {event}"
        # Google may delete small heart-rate ranges, so allow up to 1 % fewer minutes.
        if counts["metric_minute"] * 100 < minute * 99:
            return (f"Rejected: metric_minute has {counts['metric_minute']} rows, "
                    f"{name} had {minute} (more than 1 % fewer)")
        return None
    return None


def main(argv=None, *, run=subprocess.run, now=None):
    """Export and verify a backup, returning one on any operational failure.

    Args:
        argv: Optional command-line arguments.
        run: Subprocess runner, injectable for offline tests.
        now: Optional UTC datetime for naming the backup.

    Returns:
        Zero on success, otherwise one.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("~/health-tracker-backups"))
    directory = parser.parse_args(argv).out.expanduser()
    temporary = []
    status = 0
    try:
        directory.mkdir(parents=True, exist_ok=True)
        day = (now if now is not None else datetime.now(UTC)).date().isoformat()
        with tempfile.NamedTemporaryFile(dir=directory, suffix=".sql", delete=False) as file:
            sql = Path(file.name)
            temporary.append(sql)
        run(
            ["npx", "wrangler", "d1", "export", "DB", "--config",
             "wrangler.production.jsonc", "--remote", "--output", str(sql.resolve())],
            cwd=WORKER,
            check=True,
            capture_output=True,
            text=True,
        )
        contents = sql.read_bytes()
        with sqlite3.connect(":memory:") as database:
            database.executescript(contents.decode("utf-8"))
            tables = sorted(row[0] for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' "
                "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
            ))
            missing = REQUIRED_TABLES.difference(tables)
            if missing:
                raise ValueError(f"Missing required tables: {', '.join(sorted(missing))}")
            counts = {
                name: database.execute(
                    'SELECT count(*) FROM "' + name.replace('"', '""') + '"'
                ).fetchone()[0]
                for name in tables
            }
        reason = shrink(directory, day, counts)
        manifest = {
            "date": day, "sha256": hashlib.sha256(contents).hexdigest(),
            "bytes": len(contents), "tables": counts,
        }
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=directory, suffix=".json", delete=False
        ) as file:
            temporary.append(Path(file.name))
            json.dump(manifest, file)
            file.write("\n")
        base = f"health-tracker-{day}" + (".rejected" if reason else "")
        if not reason:
            # Invalidate the old pair before either replacement can fail or be interrupted.
            (directory / f"{base}.sql").unlink(missing_ok=True)
        os.replace(temporary[1], directory / f"{base}.json")
        os.replace(sql, directory / f"{base}.sql")
        if reason:
            raise ValueError(f"{reason}; kept as {base}.sql and {base}.json, nothing pruned")
    except Exception as error:
        message = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            message = re.sub(
                r"https?://\S+", "<url>",
                f"{message}\n{error.stderr or ''}\n{error.stdout or ''}",
            )
        print(f"Export failed: {message}", file=sys.stderr)
        status = 1
    finally:
        for path in temporary:
            try:
                path.unlink(missing_ok=True)
            except OSError as error:
                print(f"Temporary file cleanup failed: {error}", file=sys.stderr)
                status = 1

    if status:
        return status

    try:
        pairs = sorted(
            path for path in directory.glob("health-tracker-*.sql")
            if re.fullmatch(r"health-tracker-\d{4}-\d{2}-\d{2}\.sql", path.name)
            and path.is_file() and path.with_suffix(".json").is_file()
        )
    except OSError as error:
        print(f"Retention failed: {error}", file=sys.stderr)
        return 1
    status = 0
    for sql in pairs[:-8]:
        try:
            sql.unlink()
            sql.with_suffix(".json").unlink()
        except OSError as error:
            print(f"Retention failed: {error}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
