"""Golden tests for Office parsing (APP_ANALYSIS 3.3): what python-docx / python-pptx and omml.py make of known files.

- tests/fixtures/golden.{docx,pptx} (built by tests/fixtures/make_office.py) pin the exact units, labels, equation
  counts and LaTeX.
- The real samples in spike/samples (not in git: they're large and not ours to share) are checked against
  tests/golden/samples.json when present: unit count, equations and a hash of each unit's label and text (nothing
  from the files themselves is stored), so a parser change
  that alters real output is noticed. After an intended change, refresh it with `pytest --update-golden`."""
import hashlib
import json
from pathlib import Path

import pytest

from studyapp import parsers

HERE = Path(__file__).parent
SETTINGS = {"vision_min_images": 2, "vision_big_image_area": 0.4, "vision_low_text_words": 25}
SAMPLES = HERE.parent.parent / "spike" / "samples"
GOLDEN = HERE / "golden" / "samples.json"


def _parse(path, tmp_path):
    return parsers.parse(path, tmp_path / "assets", SETTINGS)


def test_docx_sections_equations_and_fallback(tmp_path):
    units, meta = _parse(HERE / "fixtures" / "golden.docx", tmp_path)
    assert meta == {"headings_detected": True}
    assert [(u["label"], u["equations"]) for u in units] == [("Kinematics", 2), ("Tables and roots", 3)]
    first, second = units[0]["text"], units[1]["text"]
    assert r"Average speed is $\frac{v}{t}$ over the whole trip." in first
    assert r"$E=m{c}^{2}$" in first
    assert "[table]\nQuantity | Unit\nForce | newton" in second
    assert r"$\sqrt{x}$" in second and r"$\begin{matrix}1 & 0 \\ 0 & 1\end{matrix}$" in second
    # Word's text-box copy: the Choice once, the Fallback never (text or equation)
    assert "Choice copy" in second and "Fallback copy" not in second
    assert second.count(r"\frac{v}{t}") == 1


def test_pptx_slides_notes_groups_tables(tmp_path):
    units, _ = _parse(HERE / "fixtures" / "golden.pptx", tmp_path)
    assert [(u["label"], u["equations"]) for u in units] == [("Slide 1 · Waves", 1), ("Slide 2 · Grouped shapes", 0)]
    assert units[0]["text"] == "Waves\nWave speed\nFrequency $\\frac{v}{t}$\n[speaker notes]\nMention the demo."
    assert "Inside a group" in units[1]["text"]  # text inside grouped shapes is found
    assert "[table]\nColour | Wavelength\nRed | 700 nm" in units[1]["text"]


def _summary(path, tmp_path) -> dict:
    units, meta = _parse(path, tmp_path)
    return {"units": len(units), "equations": sum(u["equations"] for u in units), "meta": meta,
            "labels": [hashlib.sha256(u["label"].encode()).hexdigest()[:12] for u in units],
            "text_sha": [hashlib.sha256(u["text"].encode()).hexdigest()[:16] for u in units]}


def _sample_files():
    return sorted(p for p in SAMPLES.rglob("*") if p.suffix.lower() in (".docx", ".pptx")) if SAMPLES.exists() else []


@pytest.mark.skipif(not _sample_files(), reason="the real samples (spike/samples) aren't on this computer")
def test_real_samples_match_golden(tmp_path, request):
    got = {str(p.relative_to(SAMPLES)).replace("\\", "/"): _summary(p, tmp_path) for p in _sample_files()}
    if request.config.getoption("--update-golden") or not GOLDEN.exists():
        GOLDEN.parent.mkdir(exist_ok=True)
        GOLDEN.write_text(json.dumps(got, indent=1, ensure_ascii=False), encoding="utf-8")
        pytest.skip("golden file written")
    want = json.loads(GOLDEN.read_text(encoding="utf-8"))
    for name, summary in got.items():
        if name not in want:
            continue  # a sample added since: refresh with --update-golden
        for key in ("units", "equations", "meta", "labels", "text_sha"):
            assert summary[key] == want[name][key], f"{name}: {key} changed"
