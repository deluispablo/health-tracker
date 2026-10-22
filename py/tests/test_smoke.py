"""Smoke test for the health_tracker package."""

import health_tracker


def test_package_imports() -> None:
    """The package imports and carries its module docstring."""
    assert health_tracker.__doc__ == "Offline tooling for Health Tracker."
