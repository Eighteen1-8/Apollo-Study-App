"""HTML (a note, generated notes / cheat sheet, or an exam, as built by the UI's exportDoc.ts) to a Word document.

Covers what the notes editor and the notes components produce: headings, paragraphs, lists (nested), tables, bold /
italic / underline / strikethrough, text and highlight colours, fonts and sizes, links, images from the app's assets,
code, and the notes components (definitions, formulas, callouts, worked examples) as shaded or indented paragraphs.
Maths arrives as LaTeX text ($...$) because Word can't take KaTeX's HTML; graphs and inline diagrams become a short
placeholder."""
import io
import logging
import re
from urllib.parse import unquote, urlparse

from docx import Document
from docx.enum.text import WD_COLOR_INDEX
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Cm
from lxml import html as lxml_html

from . import config

log = logging.getLogger(__name__)

BLOCKS = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "pre", "blockquote", "figure",
          "figcaption", "details", "summary", "section", "hr", "img"}

# Highlight colours Word can show (it has a fixed palette) for the editor's and the notes' highlight colours
HIGHLIGHTS = {"yellow": WD_COLOR_INDEX.YELLOW, "green": WD_COLOR_INDEX.BRIGHT_GREEN, "lime": WD_COLOR_INDEX.BRIGHT_GREEN,
              "blue": WD_COLOR_INDEX.TURQUOISE, "cyan": WD_COLOR_INDEX.TURQUOISE, "pink": WD_COLOR_INDEX.PINK,
              "red": WD_COLOR_INDEX.PINK, "orange": WD_COLOR_INDEX.YELLOW, "violet": WD_COLOR_INDEX.PINK,
              "purple": WD_COLOR_INDEX.PINK, "gray": WD_COLOR_INDEX.GRAY_25}
SHADE = {"def": "EEF3FF", "formula": "F2F2F2", "key": "E8F7EF", "tip": "EAF2FF", "warn": "FFF1E6", "example": "F7F7F7"}


def _style(el) -> dict:
    out = {}
    for part in (el.get("style") or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip().lower()] = v.strip()
    return out


def _rgb(value: str) -> RGBColor | None:
    v = value.strip().lower()
    m = re.fullmatch(r"#([0-9a-f]{6})", v) or re.fullmatch(r"#([0-9a-f]{3})", v)
    if m:
        h = m.group(1)
        h = "".join(c * 2 for c in h) if len(h) == 3 else h
        return RGBColor.from_string(h.upper())
    m = re.fullmatch(r"rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)", v)
    if m and (m.group(4) is None or float(m.group(4)) > 0.2):
        return RGBColor(*(int(m.group(i)) for i in (1, 2, 3)))
    return None


def _highlight(value: str):
    v = value.strip().lower()
    for name, idx in HIGHLIGHTS.items():
        if name in v:
            return idx
    rgb = _rgb(v)
    if rgb is None:
        return None
    r, g, b = rgb
    if r > 200 and g > 200 and b < 150:
        return WD_COLOR_INDEX.YELLOW
    if g > r and g > b:
        return WD_COLOR_INDEX.BRIGHT_GREEN
    if b > r and b > g:
        return WD_COLOR_INDEX.TURQUOISE
    if r > g and r > b:
        return WD_COLOR_INDEX.PINK
    return WD_COLOR_INDEX.YELLOW


def _shade(paragraph, hex_fill: str):
    pPr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    pPr.append(shd)


def _asset_path(src: str):
    """Images: only the app's own assets (figures, pasted images) are embedded."""
    try:
        path = unquote(urlparse(src).path)
    except ValueError:
        return None
    if "/assets/" not in path:
        return None
    root = config.assets_dir().resolve()
    p = (root / path.split("/assets/", 1)[1]).resolve()
    return p if root in p.parents and p.is_file() else None


class Writer:
    def __init__(self, doc):
        self.doc = doc
        self.para = None  # the paragraph inline content goes into
        self.list_stack: list[str] = []  # 'ul' | 'ol'

    # ------------------------------------------------------------ blocks
    def new_para(self, style=None):
        try:
            self.para = self.doc.add_paragraph(style=style)
        except KeyError:
            self.para = self.doc.add_paragraph()
        return self.para

    def ensure_para(self):
        return self.para or self.new_para()

    def block(self, el, fmt: dict, shade: str | None = None):
        tag = el.tag if isinstance(el.tag, str) else ""
        cls = set((el.get("class") or "").split())
        if tag in ("svg", "math") or "plot" in cls or "diagram" in cls:
            self.new_para().add_run("[Graph or diagram: see the app or the PDF export]").italic = True
            self.para = None
            return
        if tag == "img":
            self.image(el)
            return
        if tag == "hr":
            self.para = None
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = min(int(tag[1]), 4)
            self.para = self.doc.add_heading(level=level)
            self.inline_children(el, fmt)
            self.para = None
            return
        if tag == "ol" and el.get("type") in ("A", "a"):  # lettered (exam options): Word's lists only number
            items = [li for li in el if isinstance(li.tag, str) and li.tag == "li"]
            for i, li in enumerate(items):
                p = self.new_para()
                p.paragraph_format.left_indent = Cm(0.8)
                letter = chr((65 if el.get("type") == "A" else 97) + i)
                p.add_run(f"{letter}.  ")
                self.inline_children(li, fmt)
            self.para = None
            return
        if tag in ("ul", "ol"):
            self.list_stack.append(tag)
            for li in el:
                if isinstance(li.tag, str) and li.tag == "li":
                    self.list_item(li, fmt)
                elif isinstance(li.tag, str):
                    self.block(li, fmt)
            self.list_stack.pop()
            self.para = None
            return
        if tag == "table":
            self.table(el, fmt)
            return
        if tag == "pre":
            p = self.new_para()
            r = p.add_run(el.text_content())
            r.font.name = "Consolas"
            r.font.size = Pt(9.5)
            self.para = None
            return
        if "callout-title" in cls or tag == "summary":
            p = self.new_para()
            self.inline_children(el, {**fmt, "bold": True})
            if shade:
                _shade(p, shade)
            self.para = None
            return
        kind = next((k for k in SHADE if k in cls), None)
        if tag == "details":
            kind = "example"
        if kind or tag == "blockquote":
            self.container(el, fmt, SHADE.get(kind or "", "F5F5F5"))
            return
        if tag == "figcaption":
            p = self.new_para()
            self.inline_children(el, {**fmt, "italic": True})
            self.para = None
            return
        # p / div / li-less containers / section / figure
        if any(isinstance(c.tag, str) and c.tag in BLOCKS for c in el):
            self.container(el, fmt, shade)
        else:
            p = self.new_para()
            if shade:
                _shade(p, shade)
            self.align(p, el)
            self.inline_children(el, fmt)
            self.para = None

    def container(self, el, fmt, shade):
        """A block holding a mix of text and blocks: loose text gathers into paragraphs between the blocks."""
        if el.text and el.text.strip():
            p = self.new_para()
            if shade:
                _shade(p, shade)
            self.text(el.text, fmt)
        else:
            self.para = None
        for c in el:
            if not isinstance(c.tag, str):
                continue
            if c.tag in BLOCKS:
                self.block(c, fmt, shade)
                self.para = None
            else:
                if self.para is None:
                    p = self.new_para()
                    if shade:
                        _shade(p, shade)
                self.inline(c, fmt)
            if c.tail and (c.tail.strip() or self.para is not None):
                if self.para is None:
                    p = self.new_para()
                    if shade:
                        _shade(p, shade)
                self.text(c.tail, fmt)
        self.para = None

    def list_item(self, li, fmt):
        kind = self.list_stack[-1]
        depth = len(self.list_stack)
        style = ("List Number" if kind == "ol" else "List Bullet") + (f" {depth}" if 1 < depth <= 3 else "")
        p = self.new_para(style)
        if li.text:
            self.text(li.text, fmt)
        for c in li:
            if not isinstance(c.tag, str):
                continue
            if c.tag in ("ul", "ol"):
                self.block(c, fmt)
                self.para = None
            elif c.tag in BLOCKS and c.tag != "li":
                # a <p> inside the item: its first one continues the bullet, later ones start their own paragraph
                self.para = p if not p.text else self.new_para()
                self.inline_children(c, fmt)
            else:
                if self.para is None:
                    self.para = self.new_para()
                self.inline(c, fmt)
            if c.tail and (c.tail.strip() or self.para is not None):
                if self.para is None:
                    self.para = self.new_para()
                self.text(c.tail, fmt)
        self.para = None

    def table(self, el, fmt):
        rows = [r for r in el.iter("tr")]
        if not rows:
            return
        ncols = max(len([c for c in r if isinstance(c.tag, str) and c.tag in ("td", "th")]) for r in rows)
        if not ncols:
            return
        t = self.doc.add_table(rows=len(rows), cols=ncols)
        try:
            t.style = "Table Grid"
        except Exception:
            pass
        for ri, r in enumerate(rows):
            cells = [c for c in r if isinstance(c.tag, str) and c.tag in ("td", "th")]
            for ci, c in enumerate(cells[:ncols]):
                cell = t.cell(ri, ci)
                self.para = cell.paragraphs[0]
                self.inline_children(c, {**fmt, "bold": fmt.get("bold") or c.tag == "th"})
        self.para = None
        self.doc.add_paragraph()

    def image(self, el):
        p = _asset_path(el.get("src") or "")
        if not p:
            return
        try:
            self.new_para().add_run().add_picture(str(p), width=Cm(14))
        except Exception:
            log.info("export: couldn't add image %s", p, exc_info=True)
        self.para = None

    def align(self, p, el):
        a = _style(el).get("text-align") or el.get("align")
        if a in ("center", "right", "justify"):
            from docx.enum.text import WD_ALIGN_PARAGRAPH
            p.alignment = {"center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT,
                           "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}[a]

    # ------------------------------------------------------------ inline
    def inline_children(self, el, fmt):
        self.ensure_para()
        if el.text:
            self.text(el.text, fmt)
        for c in el:
            if isinstance(c.tag, str):
                if c.tag in BLOCKS and c.tag not in ("figcaption", "summary"):
                    if c.tag == "img":
                        self.image(c)
                        self.new_para()
                    else:
                        self.text(" " + c.text_content().strip() + " ", fmt)
                else:
                    self.inline(c, fmt)
            if c.tail:
                self.text(c.tail, fmt)

    def inline(self, el, fmt):
        tag = el.tag
        if tag == "br":
            self.ensure_para().add_run().add_break()
            return
        if tag == "img":
            p = _asset_path(el.get("src") or "")
            if p:
                try:
                    self.ensure_para().add_run().add_picture(str(p), width=Cm(12))
                except Exception:
                    pass
            return
        if tag in ("svg", "math"):
            self.text("[diagram]", {**fmt, "italic": True})
            return
        f = dict(fmt)
        cls = set((el.get("class") or "").split())
        if tag in ("b", "strong", "th") or "term" in cls:
            f["bold"] = True
        if tag in ("i", "em", "cite"):
            f["italic"] = True
        if tag == "u":
            f["underline"] = True
        if tag in ("s", "strike", "del"):
            f["strike"] = True
        if tag == "sub":
            f["sub"] = True
        if tag == "sup":
            f["sup"] = True
        if tag in ("code", "kbd") or "tex" in cls:
            f["mono"] = True
        if tag == "mark":
            f["highlight"] = _highlight(el.get("data-color") or (el.get("class") or "") or "yellow") or WD_COLOR_INDEX.YELLOW
        if tag == "a":
            f["underline"] = True
            f["color"] = RGBColor(0x1F, 0x5F, 0xBF)
        if tag == "font":
            if el.get("color"):
                f["color"] = _rgb(el.get("color")) or f.get("color")
            if el.get("face"):
                f["font"] = el.get("face").split(",")[0].strip("'\" ")
        st = _style(el)
        if "font-weight" in st and (st["font-weight"] in ("bold", "bolder") or st["font-weight"].isdigit() and int(st["font-weight"]) >= 600):
            f["bold"] = True
        if st.get("font-style") == "italic":
            f["italic"] = True
        if "underline" in st.get("text-decoration", "") or "underline" in st.get("text-decoration-line", ""):
            f["underline"] = True
        if "line-through" in st.get("text-decoration", "") or "line-through" in st.get("text-decoration-line", ""):
            f["strike"] = True
        if st.get("color"):
            f["color"] = _rgb(st["color"]) or f.get("color")
        if st.get("background-color") or st.get("background"):
            hl = _highlight(st.get("background-color") or st.get("background"))
            if hl:
                f["highlight"] = hl
        if st.get("font-family"):
            f["font"] = st["font-family"].split(",")[0].strip("'\" ")
        if st.get("font-size"):
            m = re.match(r"([\d.]+)(px|pt)", st["font-size"])
            if m:
                f["size"] = float(m.group(1)) * (0.75 if m.group(2) == "px" else 1)
        if el.text:
            self.text(el.text, f)
        for c in el:
            if isinstance(c.tag, str):
                self.inline(c, f)
            if c.tail:
                self.text(c.tail, f)

    def text(self, s: str, fmt: dict):
        s = re.sub(r"\s+", " ", s)
        if not s:
            return
        p = self.ensure_para()
        if not p.runs and not p.text:
            s = s.lstrip()
            if not s:
                return
        r = p.add_run(s)
        r.bold = fmt.get("bold") or None
        r.italic = fmt.get("italic") or None
        r.underline = fmt.get("underline") or None
        if fmt.get("strike"):
            r.font.strike = True
        if fmt.get("sub"):
            r.font.subscript = True
        if fmt.get("sup"):
            r.font.superscript = True
        if fmt.get("mono"):
            r.font.name = "Consolas"
        elif fmt.get("font"):
            r.font.name = fmt["font"]
        if fmt.get("size"):
            r.font.size = Pt(max(6, min(fmt["size"], 72)))
        if fmt.get("color") is not None:
            r.font.color.rgb = fmt["color"]
        if fmt.get("highlight") is not None:
            r.font.highlight_color = fmt["highlight"]


def build(title: str, html: str) -> bytes:
    doc = Document()
    doc.core_properties.title = title
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    doc.add_heading(title, level=0)
    w = Writer(doc)
    root = lxml_html.fragment_fromstring(html or "<p></p>", create_parent="div")
    w.container(root, {}, None)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
