"""Offline export and failure contract tests."""

import hashlib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from pixel_health import export

NOW = datetime(2026, 10, 21, tzinfo=UTC)
SQL = "\n".join(f'CREATE TABLE "{name}" (id INTEGER);' for name in export.REQUIRED_TABLES)
SQL += '\nCREATE TABLE "extra" (value TEXT); INSERT INTO extra VALUES (\'hello\');'
BASE = "pixel-health-2026-10-21"
WRANGLER_URL = "https://example.r2.cloudflarestorage.com/db.sql?X-Amz-Signature=abc"


def runner(contents=SQL, *, failure=False):
    def run(command, *, cwd, check, capture_output=False, text=False):
        assert command[:9] == [
            "npx", "wrangler", "d1", "export", "pixel-health-production", "--env",
            "production", "--remote", "--output",
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
            (directory / f"pixel-health-2026-09-{number:02}.{suffix}").write_text("old")


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
    assert replacements == [".sql", ".json", ".sql", ".json"]
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
def test_write_or_publication_failure_never_prunes(tmp_path, monkeypatch, capsys, stage):
    seed_pairs(tmp_path)
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
    assert invoke(tmp_path, run=runner()) == 1
    assert "refused" in capsys.readouterr().err
    assert len(list(tmp_path.glob("pixel-health-2026-09-*"))) == 20
    expected = 21 if stage == ".json" else 20
    assert len(list(tmp_path.iterdir())) == expected
    if stage == ".json":
        assert (tmp_path / f"{BASE}.sql").read_text() == SQL


def test_retention_keeps_eight_pairs_and_leaves_orphans(tmp_path, monkeypatch):
    seed_pairs(tmp_path)
    orphans = ["pixel-health-2020-01-01.sql", "pixel-health-2020-01-02.json", "notes.txt"]
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
        f"pixel-health-2026-09-{number:02}.{suffix}"
        for number in range(1, 4) for suffix in ("json", "sql")
    ]
    assert len(list(tmp_path.iterdir())) == 19
    for name in orphans:
        assert (tmp_path / name).read_text() == "untouched"
    for number in range(4, 11):
        assert (tmp_path / f"pixel-health-2026-09-{number:02}.sql").exists()
        assert (tmp_path / f"pixel-health-2026-09-{number:02}.json").exists()


def test_deletion_failure_continues_other_deletions(tmp_path, monkeypatch, capsys):
    seed_pairs(tmp_path)
    unlink = Path.unlink

    def fail_second_pair(path, *args, **kwargs):
        if path.name == "pixel-health-2026-09-02.sql":
            raise OSError("delete refused")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_second_pair)
    assert invoke(tmp_path, run=runner()) == 1
    assert "delete refused" in capsys.readouterr().err
    assert not (tmp_path / "pixel-health-2026-09-01.sql").exists()
    assert not (tmp_path / "pixel-health-2026-09-02.json").exists()
    assert not (tmp_path / "pixel-health-2026-09-03.sql").exists()
    assert not (tmp_path / "pixel-health-2026-09-03.json").exists()
    assert (tmp_path / "pixel-health-2026-09-02.sql").exists()
    assert (tmp_path / f"{BASE}.sql").exists()
    assert (tmp_path / f"{BASE}.json").exists()


def test_default_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert export.main([], run=runner(), now=NOW) == 0
    assert (tmp_path / "pixel-health-backups" / f"{BASE}.json").exists()


def test_standalone_startup_without_pythonpath():
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    result = subprocess.run(
        [sys.executable, "src/pixel_health/export.py", "--help"],
        cwd=Path(__file__).resolve().parents[1], env=environment, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "--out" in result.stdout
