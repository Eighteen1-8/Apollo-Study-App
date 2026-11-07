"""Builds the small Office files the golden parsing tests read (tests/test_office_golden.py). Run it again only to
change them: `.venv/Scripts/python tests/fixtures/make_office.py`. They hold what the parsers must get right: headings,
tables, Office Math (fractions, powers, roots, a matrix), an mc:AlternateContent whose Fallback duplicates content
(and must be skipped), speaker notes, and grouped shapes."""
from pathlib import Path

from docx import Document
from docx.oxml import parse_xml
from pptx import Presentation
from pptx.util import Inches

HERE = Path(__file__).parent
M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'


def r(t):
    return f"<m:r><m:t>{t}</m:t></m:r>"


FRACTION = f"<m:oMath {M}><m:f><m:num>{r('v')}</m:num><m:den>{r('t')}</m:den></m:f></m:oMath>"  # \frac{v}{t}
POWER = f"<m:oMath {M}>{r('E=m')}<m:sSup><m:e>{r('c')}</m:e><m:sup>{r('2')}</m:sup></m:sSup></m:oMath>"  # E=mc^{2}
ROOT = f"<m:oMath {M}><m:rad><m:radPr><m:degHide m:val=\"1\"/></m:radPr><m:deg/><m:e>{r('x')}</m:e></m:rad></m:oMath>"
MATRIX = (f"<m:oMath {M}><m:m><m:mr><m:e>{r('1')}</m:e><m:e>{r('0')}</m:e></m:mr>"
          f"<m:mr><m:e>{r('0')}</m:e><m:e>{r('1')}</m:e></m:mr></m:m></m:oMath>")


def docx():
    d = Document()
    d.add_heading("Kinematics", level=1)
    p = d.add_paragraph("Average speed is ")
    p._p.append(parse_xml(FRACTION))
    p.add_run(" over the whole trip.")
    p = d.add_paragraph("Mass and energy: ")
    p._p.append(parse_xml(POWER))
    d.add_heading("Tables and roots", level=1)
    t = d.add_table(rows=2, cols=2)
    for (i, j), v in {(0, 0): "Quantity", (0, 1): "Unit", (1, 0): "Force", (1, 1): "newton"}.items():
        t.cell(i, j).text = v
    p = d.add_paragraph("The root ")
    p._p.append(parse_xml(ROOT))
    p.add_run(" and the identity ")
    p._p.append(parse_xml(MATRIX))
    # a text box Word saves twice: the Choice and a Fallback copy (only the Choice counts, and its equation once)
    p = d.add_paragraph("Boxed: ")
    p._p.append(parse_xml(
        f"<mc:AlternateContent {MC} {W} {M}><mc:Choice Requires=\"wps\"><w:r><w:t>Choice copy</w:t></w:r>{FRACTION}"
        f"</mc:Choice><mc:Fallback><w:r><w:t>Fallback copy</w:t></w:r>{FRACTION}</mc:Fallback></mc:AlternateContent>"))
    d.save(HERE / "golden.docx")


def pptx():
    prs = Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = "Waves"
    body = s.placeholders[1].text_frame
    body.text = "Wave speed"
    para = body.add_paragraph()
    para.text = "Frequency "
    para._p.append(parse_xml(f"<a14:m xmlns:a14=\"http://schemas.microsoft.com/office/drawing/2010/main\">"
                             f"<m:oMathPara {M}>{FRACTION}</m:oMathPara></a14:m>"))
    s.notes_slide.notes_text_frame.text = "Mention the demo."
    s2 = prs.slides.add_slide(prs.slide_layouts[5])
    s2.shapes.title.text = "Grouped shapes"
    g = s2.shapes.add_group_shape()
    box = g.shapes.add_textbox(Inches(1), Inches(2), Inches(3), Inches(1))
    box.text_frame.text = "Inside a group"
    rows = s2.shapes.add_table(2, 2, Inches(1), Inches(4), Inches(4), Inches(1)).table
    for (i, j), v in {(0, 0): "Colour", (0, 1): "Wavelength", (1, 0): "Red", (1, 1): "700 nm"}.items():
        rows.cell(i, j).text = v
    prs.save(HERE / "golden.pptx")


if __name__ == "__main__":
    docx()
    pptx()
    print("wrote", HERE / "golden.docx", HERE / "golden.pptx")
