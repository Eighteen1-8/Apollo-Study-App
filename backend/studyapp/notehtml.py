"""Notes and cheat sheets are written by Apollo as HTML built from a small set of components that the app styles
(see DESIGN below and `.nb` in the UI's styles). This module holds that design brief and makes the model's output
safe to store: fences and page-level tags removed, unbalanced tags repaired, stray Markdown converted.

Maths ($...$), inline SVG, plot blocks and [[...]] tags are protected while the HTML is repaired, because an HTML
parser would mangle them (`$a<b$` looks like a tag; SVG attribute case matters)."""
import logging
import re

from lxml import etree, html as lxml_html

from . import llm

log = logging.getLogger(__name__)

DESIGN = """FORMAT: reply with ONE HTML fragment only. No <html>, <head>, <body>, <style> or <script>; no CSS; no Markdown
(#, **, ```); no code fences. Start directly with <h2>.

CITATIONS (required): every definition, formula, key idea and paragraph ends with its source in double square
brackets, exactly the filename and unit label from the material headers, e.g.
<div class="def"><span class="term">Refraction</span> the bending of light at a boundary [[Wave Behaviours and Light Phenomena.pptx · Slide 14]]</div>
The app turns these into links to the page. Never write a source any other way."""

DESIGN += """

Build the page ONLY from these components (the app styles them):
<h2>Heading</h2> <h3>Sub-heading</h3> <p>…</p> <ul>/<ol> with <li>, <table> with <thead>/<th>
<div class="def"><span class="term">Term</span> its definition</div>               ← every definition
<div class="formula">$$LaTeX$$<div class="where">where $V$ = potential difference (V), …</div></div>   ← every formula, with each symbol's meaning and unit
<div class="callout key"><div class="callout-title">Key idea</div><p>…</p></div>   ← the most important ideas
<div class="callout tip"><div class="callout-title">Exam tip</div>…</div>   and   <div class="callout warn"><div class="callout-title">Common mistake</div>…</div>
<details class="example"><summary>Worked example: …</summary><ol class="steps"><li>…</li></ol></details>   ← worked examples
<div class="grid2"><div class="card"><h4>A</h4>…</div><div class="card"><h4>B</h4>…</div></div>   ← compare two things side by side
<span class="tag blue">label</span> (tag colours: blue, green, amber, red, violet) · <mark>key phrase</mark> · <b>bold</b>
Colour sparingly and consistently: <span class="c-blue">…</span> (also c-green, c-amber, c-red, c-violet)

PICTURES AND GRAPHICS (use them where they help understanding):
- A figure from the student's material, on its own line:  [[figure: filename · unit label | what the figure shows]]
  Only for figures that a [Visual content] description in the material shows exist; use that unit's exact label
  (e.g. "Page 13" or "Slide 9 · Reflection: regular and diffuse"). At most 3 per reply.
- A graph of a relationship:  <pre class="plot">{"title": "…", "x": [0, 10], "xlabel": "…", "ylabel": "…",
  "functions": [{"expr": "2*x^2 + 1", "label": "…"}], "points": [{"x": 2, "y": 9, "label": "…"}]}</pre>
  (valid JSON; expr may use x, numbers, + - * / ^, ( ), sin cos tan sqrt exp ln log abs, pi, e)
  The student can hover a graph to read values. To let them explore how a quantity changes the curve, add sliders:
  "params": [{"name": "k", "label": "spring constant (N/m)", "min": 1, "max": 50, "step": 1, "value": 10}] and use the
  names in expr, e.g. "0.5*k*x^2". Use sliders when changing a value is the point (constants, amplitudes, resistances).
- A simple labelled diagram you draw: <svg viewBox="0 0 400 220" class="diagram">…</svg> using <line>, <rect>,
  <circle>, <polygon>, <path>, <text font-size="13">, stroke="currentColor", fill="none" (colour only to highlight).

Cite every fact right after it as [[filename · label]]. Write all maths in LaTeX: $…$ inline, $$…$$ on its own."""

_KEEP = re.compile(r"\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|<svg[\s\S]*?</svg>|<pre class=\"plot\">[\s\S]*?</pre>|\[\[[^\]]+\]\]", re.I)


def _markdownish(s: str) -> str:
    s = re.sub(r"^#{3,}\s*(.+)$", r"<h3>\1</h3>", s, flags=re.M)
    s = re.sub(r"^#{1,2}\s*(.+)$", r"<h2>\1</h2>", s, flags=re.M)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    return s


_ACTIVE_TAGS = r"script|foreignObject|iframe|object|embed|form|base|meta|link"
_ACTIVE = re.compile(rf"<({_ACTIVE_TAGS})\b[^>]*>[\s\S]*?</\1\s*>|</?({_ACTIVE_TAGS})\b[^>]*>", re.I)
_EVENT = re.compile(r"""\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", re.I)
_JS_URL = re.compile(r"""(href|src|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text)""", re.I)


def scrub(s: str) -> str:
    """Remove anything that could run: script-like elements, on* handlers and javascript: URLs. The UI sanitises too
    (Markdown.tsx); this keeps stored notes clean for anything else that reads them (exports, study packs)."""
    s = _ACTIVE.sub("", s)
    s = _EVENT.sub("", s)
    return _JS_URL.sub(r"\1=\2#blocked:", s)


def _plain(s: str) -> str:
    return " ".join(re.sub(r"<[^>]+>|\[\[[^\]]*\]\]", " ", s).replace("&amp;", "&").split())


def outline(content: str) -> list[str]:
    """What a written page covers, for telling the model about earlier pages: its headings (with the terms they
    define) as short lines. Works on HTML and on the Markdown fallback."""
    lines: list[str] = []
    for m in re.finditer(r"<h([2-4])[^>]*>([\s\S]*?)</h\1>|<span class=\"term\">([\s\S]*?)</span>|^#{1,4}\s*(.+)$",
                         content, re.I | re.M):
        if m.group(3):
            term = _plain(m.group(3))
            if term and lines:
                lines[-1] += ("; defines " if " defines " not in lines[-1] else ", ") + term
            continue
        text = _plain(m.group(2) or m.group(4) or "")
        if text:
            lines.append(("  " if (m.group(1) or "2") != "2" else "") + text)
    return lines


def clean(raw: str) -> tuple[str, bool]:
    """(content, is_html). Falls back to Markdown when the reply has no HTML structure at all."""
    s = llm.strip_think(raw)
    m = re.search(r"```(?:html)?\s*([\s\S]*?)```", s)
    if m and "<" in m.group(1):
        s = m.group(1).strip()
    s = re.sub(r"<!DOCTYPE[^>]*>|</?(html|body)[^>]*>|<head[\s\S]*?</head>|<style[\s\S]*?</style>|<script[\s\S]*?</script>", "", s, flags=re.I)
    if not re.search(r"<(h[1-4]|p|div|ul|ol|table|details)\b", s, re.I):
        return scrub(s), False
    held: list[str] = []

    def hold(m):
        held.append(m.group(0))
        return f"@@K{len(held) - 1}@@"
    body = _markdownish(_KEEP.sub(hold, s))
    try:
        parts = lxml_html.fragments_fromstring(body)
        body = "".join(p if isinstance(p, str) else etree.tostring(p, method="html", encoding="unicode") for p in parts)
    except Exception:  # unparseable: keep as written (scrubbed below, and the UI sanitises it)
        log.info("notes HTML couldn't be repaired; kept as written", exc_info=True)
    return scrub(re.sub(r"@@K(\d+)@@", lambda m: held[int(m.group(1))], body)), True
