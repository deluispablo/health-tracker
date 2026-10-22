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
SQL = "\n".join(f'CREATE TABLE "{name}" (id INTEGER);' for name in export.REQUIRED_TABLES)
SQL += '\nCREATE TABLE "extra" (value TEXT); INSERT INTO extra VALUES (\'hello\');'
BASE = "health-tracker-2026-10-21"
WRANGLER_URL = "https://example.r2.cloudflarestorage.com/db.sql?X-Amz-Signature=abc"


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
            (directory / f"health-tracker-2026-09-{number:02}.{suffix}").write_text("old")


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
        "tables": {**{name: 0 for name in export.REQUIRED_TABLES}, "extra": 1},
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
