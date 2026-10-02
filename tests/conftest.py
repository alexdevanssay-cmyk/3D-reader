"""Shared pytest set-up: the cross-engine fixture files that some tests read."""

from pathlib import Path

import pytest

GENERATED = Path(__file__).resolve().parent / "fixtures" / "generated"


@pytest.fixture(scope="session", autouse=True)
def generated_fixtures():
    """Write tests/fixtures/generated/ (tests/make_fixtures.py) when it is missing."""
    if not (GENERATED / "expected.json").exists():
        from make_fixtures import main

        main(GENERATED)
    return GENERATED
