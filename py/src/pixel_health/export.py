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
    "metric_minute", "daily_summary", "sleep_session", "event", "tracker", "audit_log"
}
WORKER = Path(__file__).resolve().parents[3] / "worker"


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
    parser.add_argument("--out", type=Path, default=Path("~/pixel-health-backups"))
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
            ["npx", "wrangler", "d1", "export", "pixel-health-production", "--env",
             "production", "--remote", "--output", str(sql.resolve())],
            cwd=WORKER,
            check=True,
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
        os.replace(sql, directory / f"pixel-health-{day}.sql")
        os.replace(temporary[1], directory / f"pixel-health-{day}.json")
    except Exception as error:
        print(f"Export failed: {error}", file=sys.stderr)
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
            path for path in directory.glob("pixel-health-*.sql")
            if re.fullmatch(r"pixel-health-\d{4}-\d{2}-\d{2}\.sql", path.name)
            and path.is_file() and path.with_suffix(".json").is_file()
        )
    except OSError as error:
        print(f"Retention failed: {error}", file=sys.stderr)
        return 1
    status = 0
    for sql in pairs[:-8]:
        for path in (sql.with_suffix(".json"), sql):
            try:
                path.unlink()
            except OSError as error:
                print(f"Retention failed: {error}", file=sys.stderr)
                status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
