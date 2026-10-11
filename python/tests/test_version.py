import re
from pathlib import Path

import yungle
from yungle._version import VERSION


def test_version_matches_pyproject():
    # A regex, not tomllib: CI still runs Python 3.9.
    text = (Path(__file__).parent.parent / "pyproject.toml").read_text()
    match = re.search(r'^version = "([^"]+)"', text, re.MULTILINE)
    assert match and VERSION == match.group(1)
    assert yungle.__version__ == VERSION
