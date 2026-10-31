"""Minimal OMML (Office Math, used by Word and PowerPoint equations) -> LaTeX converter.
Covers the constructs common in physics/engineering notes; unknown elements fall back to their text."""
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"

NARY = {"∑": r"\sum", "∏": r"\prod", "∫": r"\int", "∬": r"\iint", "∮": r"\oint"}
SYMBOLS = {"×": r"\times ", "·": r"\cdot ", "÷": r"\div ", "±": r"\pm ", "≈": r"\approx ", "≠": r"\neq ",
           "≤": r"\leq ", "≥": r"\geq ", "∞": r"\infty ", "→": r"\rightarrow ", "Δ": r"\Delta ", "θ": r"\theta ",
           "λ": r"\lambda ", "μ": r"\mu ", "π": r"\pi ", "ω": r"\omega ", "Ω": r"\Omega ", "α": r"\alpha ",
           "β": r"\beta ", "γ": r"\gamma ", "ε": r"\varepsilon ", "ρ": r"\rho ", "σ": r"\sigma ", "φ": r"\phi ",
           "τ": r"\tau ", "η": r"\eta ", "√": r"\sqrt "}


def _child(el, tag):
    return el.find(M + tag)


def _val(el, tag, default=""):
    c = el.find(M + tag)
    return c.get(M + "val", default) if c is not None else default


def _conv(el):
    return "".join(_node(c) for c in el) if el is not None else ""


def _node(el):
    tag = el.tag.replace(M, "")
    if tag == "r":
        return "".join(SYMBOLS.get(ch, ch) for t in el.iter(M + "t") for ch in (t.text or ""))
    if tag == "f":
        return r"\frac{%s}{%s}" % (_conv(_child(el, "num")), _conv(_child(el, "den")))
    if tag == "sSup":
        return "{%s}^{%s}" % (_conv(_child(el, "e")), _conv(_child(el, "sup")))
    if tag == "sSub":
        return "{%s}_{%s}" % (_conv(_child(el, "e")), _conv(_child(el, "sub")))
    if tag == "sSubSup":
        return "{%s}_{%s}^{%s}" % (_conv(_child(el, "e")), _conv(_child(el, "sub")), _conv(_child(el, "sup")))
    if tag == "rad":
        deg = _conv(_child(el, "deg"))
        return (r"\sqrt[%s]{%s}" % (deg, _conv(_child(el, "e")))) if deg else r"\sqrt{%s}" % _conv(_child(el, "e"))
    if tag == "d":
        pr = _child(el, "dPr")
        beg = _val(pr, "begChr", "(") if pr is not None else "("
        end = _val(pr, "endChr", ")") if pr is not None else ")"
        inner = ",".join(_conv(e) for e in el.findall(M + "e"))
        return r"\left%s %s \right%s" % (beg or ".", inner, end or ".")
    if tag == "nary":
        pr = _child(el, "naryPr")
        op = NARY.get(_val(pr, "chr", "∫") if pr is not None else "∫", r"\int")
        sub, sup = _conv(_child(el, "sub")), _conv(_child(el, "sup"))
        return op + (f"_{{{sub}}}" if sub else "") + (f"^{{{sup}}}" if sup else "") + " " + _conv(_child(el, "e"))
    if tag == "acc":
        pr = _child(el, "accPr")
        ch = _val(pr, "chr", "̂") if pr is not None else "̂"
        cmd = {"⃗": r"\vec", "̇": r"\dot", "̄": r"\bar", "̂": r"\hat"}.get(ch, r"\hat")
        return f"{cmd}{{{_conv(_child(el, 'e'))}}}"
    if tag == "bar":
        return r"\overline{%s}" % _conv(_child(el, "e"))
    if tag == "func":
        return r"\%s{%s}" % (_conv(_child(el, "fName")).strip("\\ "), _conv(_child(el, "e")))
    if tag == "limLow":
        return r"%s_{%s}" % (_conv(_child(el, "e")), _conv(_child(el, "lim")))
    if tag == "eqArr":
        return r"\begin{aligned}%s\end{aligned}" % r" \\ ".join(_conv(e) for e in el.findall(M + "e"))
    if tag == "m":
        rows = [" & ".join(_conv(e) for e in mr.findall(M + "e")) for mr in el.findall(M + "mr")]
        return r"\begin{matrix}%s\end{matrix}" % r" \\ ".join(rows)
    if tag.endswith("Pr"):
        return ""
    return _conv(el)


def omml_to_latex(omath):
    """omath: an <m:oMath> lxml element."""
    return _conv(omath).strip()
