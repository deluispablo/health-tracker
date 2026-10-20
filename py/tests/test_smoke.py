"""Smoke test for the pixel_health package."""

import pixel_health


def test_package_imports() -> None:
    """The package imports and carries its module docstring."""
    assert pixel_health.__doc__ == "Offline tooling for Pixel Health."
