"""Offline export and failure contract tests."""

import hashlib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from health_tracker import export

NOW = datetime(2026, 10, 21, tzinfo=UTC)
SCHEMA = "\n".join(f'CREATE TABLE "{name}" (id INTEGER);' for name in export.REQUIRED_TABLES)
SCHEMA += '\nCREATE TABLE "extra" (value TEXT); INSERT INTO extra VALUES (\'hello\');'
BASE = "health-tracker-2026-10-21"
WRANGLER_URL = "https://example.r2.cloudflarestorage.com/db.sql?X-Amz-Signature=abc"


def dump(event=1, minute=1):
    """Return the fixture SQL with the given row counts in the guarded tables."""
    return SCHEMA + "".join(
        f"\nWITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {count})"
        f" INSERT INTO {table} SELECT i FROM n;"
        for table, count in (("event", event), ("metric_minute", minute)) if count
    )


def manifest_text(event=1, minute=1):
    return json.dumps({"tables": {"event": event, "metric_minute": minute}})


SQL = dump()


def runner(contents=SQL, *, failure=False):
    def run(command, *, cwd, check, capture_output=False, text=False):
        assert command[:9] == [
            "npx", "wrangler", "d1", "export", "DB", "--config",
            "wrangler.production.jsonc", "--remote", "--output",
        ]
        assert cwd == Path(__file__).resolve().parents[2] / "worker"
        assert check is True
        output = Path(command[9])
        assert output.is_file()
        output.write_text(contents)
        if failure:
            raise subprocess.CalledProcessError(1, command)
    return run


def invoke(directory, **kwargs):
    return export.main(["--out", str(directory)], now=NOW, **kwargs)


def seed_pairs(directory, count=10):
    for number in range(1, count + 1):
        for suffix in ("sql", "json"):
            (directory / f"health-tracker-2026-09-{number:02}.{suffix}").write_text(
                manifest_text() if suffix == "json" else "old"
            )


def test_wrangler_captures_text_and_checks_exit_status(tmp_path):
    options = {}

    def run(command, **kwargs):
        options.update(kwargs)
        return runner()(command, **kwargs)

    assert invoke(tmp_path, run=run) == 0
    assert options["check"] is True
    assert options.get("capture_output") is True
    assert options.get("text") is True


def test_success_never_prints_wrangler_output(tmp_path, capsys):
    def run(command, *, cwd, check, capture_output=False, text=False):
        runner()(command, cwd=cwd, check=check)
        if not capture_output:
            print(WRANGLER_URL)
            print(WRANGLER_URL, file=sys.stderr)
        return subprocess.CompletedProcess(command, 0, stdout=WRANGLER_URL, stderr=WRANGLER_URL)

    assert invoke(tmp_path, run=run) == 0
    captured = capsys.readouterr()
    assert captured.out == captured.err == ""


def test_failed_wrangler_redacts_both_streams_without_publishing_or_pruning(tmp_path, capsys):
    seed_pairs(tmp_path)
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    stderr_url = WRANGLER_URL.replace("https://", "http://")

    def run(command, *, cwd, check, capture_output=False, text=False):
        raise subprocess.CalledProcessError(
            1, command, output=f"Download: {WRANGLER_URL}\n",
            stderr=f"D1 export failed: {stderr_url}\n",
        )

    assert invoke(tmp_path, run=run) == 1
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before
    captured = capsys.readouterr()
    assert "D1 export failed: <url>" in captured.err
    assert "Download: <url>" in captured.err
    for output in (captured.out, captured.err):
        assert "X-Amz-" not in output
        assert WRANGLER_URL not in output
        assert stderr_url not in output


def test_success_manifest_and_same_day_replacement(tmp_path, monkeypatch):
    directory = tmp_path / "backups"
    replacements = []
    replace = export.os.replace

    def record(source, target):
        assert source.parent == directory
        replacements.append(target.suffix)
        replace(source, target)
        sql = directory / f"{BASE}.sql"
        manifest = directory / f"{BASE}.json"
        if sql.exists() and manifest.exists():
            assert json.loads(manifest.read_text())["sha256"] == hashlib.sha256(
                sql.read_bytes()
            ).hexdigest()

    monkeypatch.setattr(export.os, "replace", record)
    assert invoke(directory, run=runner()) == 0
    manifest = json.loads((directory / f"{BASE}.json").read_text())
    assert manifest == {
        "date": "2026-10-21", "sha256": hashlib.sha256(SQL.encode()).hexdigest(),
        "bytes": len(SQL.encode()),
        "tables": {
            **{name: 0 for name in export.REQUIRED_TABLES}, "event": 1, "metric_minute": 1,
            "extra": 1,
        },
    }
    assert list(manifest["tables"]) == sorted(manifest["tables"])
    updated = SQL + "\nINSERT INTO extra VALUES ('second');"
    assert invoke(directory, run=runner(updated)) == 0
    assert (directory / f"{BASE}.sql").read_text() == updated
    assert json.loads((directory / f"{BASE}.json").read_text())["tables"]["extra"] == 2
    assert replacements == [".json", ".sql", ".json", ".sql"]
    assert len(list(directory.iterdir())) == 2


@pytest.mark.parametrize("contents,failure,reason", [
    ("not sql", False, "syntax"),
    ("CREATE TABLE extra (id);", False, "Missing required tables"),
    (SQL, True, "non-zero exit status"),
])
def test_failed_export_never_publishes_or_prunes(tmp_path, capsys, contents, failure, reason):
    seed_pairs(tmp_path)
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    assert invoke(tmp_path, run=runner(contents, failure=failure)) == 1
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before
    assert reason in capsys.readouterr().err


def test_corrupt_same_day_rerun_preserves_pair(tmp_path):
    assert invoke(tmp_path, run=runner()) == 0
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    assert invoke(tmp_path, run=runner("corrupt sql")) == 1
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before


@pytest.mark.parametrize("stage", ["manifest", ".sql", ".json"])
@pytest.mark.parametrize("same_day", [False, True])
def test_write_or_publication_failure_never_prunes(
    tmp_path, monkeypatch, capsys, stage, same_day,
):
    if same_day:
        assert invoke(tmp_path, run=runner()) == 0
    seed_pairs(tmp_path)
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    replace = export.os.replace

    def fail_replace(source, target):
        if target.suffix == stage:
            raise OSError("publication refused")
        replace(source, target)

    def fail_dump(*args):
        raise OSError("manifest refused")

    monkeypatch.setattr(export.os, "replace", fail_replace)
    if stage == "manifest":
        monkeypatch.setattr(export.json, "dump", fail_dump)
    updated = SQL + "\nINSERT INTO extra VALUES ('second');"
    assert invoke(tmp_path, run=runner(updated)) == 1
    assert "refused" in capsys.readouterr().err
    assert {
        path.name: path.read_bytes() for path in tmp_path.glob("health-tracker-2026-09-*")
    } == {name: contents for name, contents in before.items() if "2026-09-" in name}
    assert all(path.name.startswith("health-tracker-") for path in tmp_path.iterdir())
    if stage == "manifest":
        assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before
        return
    assert not (tmp_path / f"{BASE}.sql").exists()
    if stage == ".sql":
        assert json.loads((tmp_path / f"{BASE}.json").read_text())["sha256"] == hashlib.sha256(
            updated.encode()
        ).hexdigest()
    elif same_day:
        assert (tmp_path / f"{BASE}.json").read_bytes() == before[f"{BASE}.json"]
    else:
        assert not (tmp_path / f"{BASE}.json").exists()


def test_same_day_sql_removal_failure_preserves_pair_and_never_prunes(
    tmp_path, monkeypatch, capsys,
):
    assert invoke(tmp_path, run=runner()) == 0
    seed_pairs(tmp_path)
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    unlink = Path.unlink

    def fail_sql_removal(path, *args, **kwargs):
        if path.name == f"{BASE}.sql":
            raise OSError("removal refused")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_sql_removal)
    updated = SQL + "\nINSERT INTO extra VALUES ('second');"
    assert invoke(tmp_path, run=runner(updated)) == 1
    assert "removal refused" in capsys.readouterr().err
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before


def test_retention_keeps_eight_pairs_and_leaves_orphans(tmp_path, monkeypatch):
    seed_pairs(tmp_path)
    orphans = ["health-tracker-2020-01-01.sql", "health-tracker-2020-01-02.json", "notes.txt"]
    for name in orphans:
        (tmp_path / name).write_text("untouched")
    deletions = []
    unlink = Path.unlink

    def record(path, *args, **kwargs):
        if "2026-09" in path.name:
            deletions.append(path.name)
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", record)
    assert invoke(tmp_path, run=runner()) == 0
    assert deletions == [
        f"health-tracker-2026-09-{number:02}.{suffix}"
        for number in range(1, 4) for suffix in ("sql", "json")
    ]
    assert len(list(tmp_path.iterdir())) == 19
    for name in orphans:
        assert (tmp_path / name).read_text() == "untouched"
    for number in range(4, 11):
        assert (tmp_path / f"health-tracker-2026-09-{number:02}.sql").exists()
        assert (tmp_path / f"health-tracker-2026-09-{number:02}.json").exists()


@pytest.mark.parametrize("suffix", ["sql", "json"])
def test_deletion_failure_continues_other_deletions(tmp_path, monkeypatch, capsys, suffix):
    seed_pairs(tmp_path)
    unlink = Path.unlink

    def fail_second_pair(path, *args, **kwargs):
        if path.name == f"health-tracker-2026-09-02.{suffix}":
            raise OSError("delete refused")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_second_pair)
    assert invoke(tmp_path, run=runner()) == 1
    assert "delete refused" in capsys.readouterr().err
    assert not (tmp_path / "health-tracker-2026-09-01.sql").exists()
    assert (tmp_path / "health-tracker-2026-09-02.json").exists()
    assert not (tmp_path / "health-tracker-2026-09-03.sql").exists()
    assert not (tmp_path / "health-tracker-2026-09-03.json").exists()
    assert (tmp_path / "health-tracker-2026-09-02.sql").exists() == (suffix == "sql")
    assert (tmp_path / f"{BASE}.sql").exists()
    assert (tmp_path / f"{BASE}.json").exists()


def test_default_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert export.main([], run=runner(), now=NOW) == 0
    assert (tmp_path / "health-tracker-backups" / f"{BASE}.json").exists()


def test_standalone_startup_without_pythonpath():
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    result = subprocess.run(
        [sys.executable, "src/health_tracker/export.py", "--help"],
        cwd=Path(__file__).resolve().parents[1], env=environment, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "--out" in result.stdout


def test_profile_tables_are_required():
    assert {"profile", "weight_log"} <= export.REQUIRED_TABLES


@pytest.mark.parametrize("table", ["tracker_daily", "finding", "secret_blob", "sync_pending"])
def test_export_rejects_missing_required_table(tmp_path, capsys, table):
    assert table in export.REQUIRED_TABLES
    contents = SQL.replace(f'CREATE TABLE "{table}" (id INTEGER);', "")
    assert invoke(tmp_path, run=runner(contents)) == 1
    assert f"Missing required tables: {table}" in capsys.readouterr().err
    assert list(tmp_path.iterdir()) == []


def snapshot(directory):
    return {path.name: path.read_bytes() for path in directory.iterdir()}


def previous(directory, date="2026-10-20", event=1, minute=1):
    (directory / f"health-tracker-{date}.sql").write_text("old")
    (directory / f"health-tracker-{date}.json").write_text(manifest_text(event, minute))


def assert_rejected(directory, before, contents, capsys, text):
    """The export exits 1, keeps its files as .rejected and leaves every other file alone."""
    assert invoke(directory, run=runner(contents)) == 1
    err = capsys.readouterr().err
    assert "Rejected" in err and text in err
    after = snapshot(directory)
    assert after.pop(f"{BASE}.rejected.sql") == contents.encode()
    rejected = json.loads(after.pop(f"{BASE}.rejected.json"))
    assert rejected["sha256"] == hashlib.sha256(contents.encode()).hexdigest()
    assert after == before


def test_event_shrink_rejects_without_pruning(tmp_path, capsys):
    seed_pairs(tmp_path)
    previous(tmp_path, event=5)
    assert_rejected(tmp_path, snapshot(tmp_path), dump(event=4), capsys, "event has 4 rows")


@pytest.mark.parametrize("event,minute,status", [
    (10, 995, 0),    # -0.5 %
    (10, 990, 0),    # exactly -1 %
    (10, 980, 1),    # -2 %
    (11, 1200, 0),   # growth
    (10, 1000, 0),   # unchanged
])
def test_metric_minute_tolerance(tmp_path, capsys, event, minute, status):
    previous(tmp_path, event=10, minute=1000)
    if status:
        assert_rejected(tmp_path, snapshot(tmp_path), dump(event, minute), capsys, "metric_minute")
    else:
        assert invoke(tmp_path, run=runner(dump(event, minute))) == 0
        assert (tmp_path / f"{BASE}.json").exists()
        assert not (tmp_path / f"{BASE}.rejected.json").exists()


@pytest.mark.parametrize("with_previous", [False, True])
def test_zero_metric_minute_rejected(tmp_path, capsys, with_previous):
    if with_previous:
        previous(tmp_path, event=0, minute=0)
    assert_rejected(tmp_path, snapshot(tmp_path), dump(5, 0), capsys, "metric_minute has 0")


@pytest.mark.parametrize("with_previous", [False, True])
def test_zero_events_allowed_without_earlier_events(tmp_path, with_previous):
    if with_previous:
        previous(tmp_path, event=0, minute=5)
    assert invoke(tmp_path, run=runner(dump(event=0, minute=5))) == 0
    assert json.loads((tmp_path / f"{BASE}.json").read_text())["tables"]["event"] == 0


def test_events_dropping_to_zero_rejected(tmp_path, capsys):
    previous(tmp_path, event=7, minute=5)
    assert_rejected(tmp_path, snapshot(tmp_path), dump(event=0, minute=5), capsys,
                    "event has 0 rows, health-tracker-2026-10-20.json had 7")


def test_first_run_succeeds(tmp_path):
    assert invoke(tmp_path, run=runner(dump(event=3, minute=7))) == 0
    assert sorted(snapshot(tmp_path)) == [f"{BASE}.json", f"{BASE}.sql"]


def test_newest_previous_by_filename_date_skipping_rejected_and_malformed(tmp_path, capsys):
    previous(tmp_path, "2026-10-10", event=50)
    (tmp_path / "health-tracker-2026-10-10.sql").unlink()  # orphan manifests still count
    previous(tmp_path, "2026-10-01", event=1)
    for date, text in [("2026-10-19", "not json"), ("2026-10-18", "{}"),
                       ("2026-10-17", '{"tables": {"event": "9"}}'),
                       ("2026-10-16", '{"tables": {"event": true, "metric_minute": 1}}')]:
        (tmp_path / f"health-tracker-{date}.json").write_text(text)
    (tmp_path / "health-tracker-2026-10-20.rejected.json").write_text(manifest_text(1))
    os.utime(tmp_path / "health-tracker-2026-10-01.json", (2e9, 2e9))  # mtime is ignored
    assert_rejected(tmp_path, snapshot(tmp_path), dump(event=40), capsys, "had 50")


def test_same_day_pair_is_not_the_baseline_and_survives_rejections(tmp_path, capsys):
    previous(tmp_path, "2026-10-20", event=5)
    assert invoke(tmp_path, run=runner(dump(event=9))) == 0
    before = snapshot(tmp_path)
    assert_rejected(tmp_path, before, dump(event=4), capsys, "event has 4")
    assert_rejected(tmp_path, before, dump(event=3), capsys, "event has 3")  # overwrites
    assert invoke(tmp_path, run=runner(dump(event=6))) == 0  # above 5, below today's 9
    assert json.loads((tmp_path / f"{BASE}.json").read_text())["tables"]["event"] == 6


def test_legacy_zero_baseline_allows_growth(tmp_path):
    previous(tmp_path, event=0, minute=0)
    assert invoke(tmp_path, run=runner(dump(event=1, minute=1))) == 0
