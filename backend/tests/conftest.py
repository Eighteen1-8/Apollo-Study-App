"""Shared fixtures: every test session runs against a throwaway data dir, never the user's real data."""
import os

import pytest

from studyapp import config, db


def pytest_addoption(parser):
    parser.addoption("--online", action="store_true", help="also run live tests against OpenRouter (sends test text only)")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--online"):
        return
    skip = pytest.mark.skip(reason="live OpenRouter test; run with --online")
    for item in items:
        if "online" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session", autouse=True)
def data_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("data")
    os.environ["STUDY_DATA_DIR"] = str(d)
    config.set_data_dir(str(d))
    db.init()
    return d


@pytest.fixture
def settings():
    """Set settings for one test, restoring the previous values afterwards."""
    saved = db.get_settings()

    def put(**values):
        db.put_settings(values)

    yield put
    db.put_settings(saved)
