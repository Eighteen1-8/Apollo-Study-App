"""Marking the student's own work (Make content → Marking): an essay, an assignment or worked answers, as files (Word,
PDF, slides, text, photos of handwritten pages), optionally with a rubric / marking guide.

The files are copied under <data>/assets/marking/<artifact id>/ when the request is made (so Regenerate works) and
are never ingested or embedded. A `generate` job (generate.run_artifact → gen_marking) reads each file to text and page
images, takes the rubric as text (or as pictures when it has none), or first derives criteria from the task and the
material, marks the pages in batches of at most BATCH, then writes a summary. Every call starts with the same system
prompt (rules, rubric, material) and the same first user blocks (rubric pictures, the work's text, the student's
instructions), so the prefix cache serves every call after the first; what changes (the task, a batch's pages) comes
last. Material is optional: "check against nothing" marks from the rubric and general knowledge alone."""
import json
import logging
import re
import shutil
import tempfile
from pathlib import Path

import pymupdf
from fastapi import HTTPException
from pydantic import BaseModel, Field

from . import config, context, db, errors, grants, llm, render, search
from .parsers import IMAGE_EXTS, SUPPORTED, approx_tokens, parse, render_pdf_page

log = logging.getLogger(__name__)

MAX_PAGES = 40      # pages (and photos) of work in one marking
MAX_FILES = 10
BATCH = 6           # page images per marking call
RUBRIC_IMAGES = 4   # pages of a rubric that has no text, sent as pictures
DPI = 130


def folder(aid: int) -> Path:
    return config.assets_dir() / "marking" / str(aid)


def remove_files(aid: int):
    """The copied work, rubric and page images (when the artifact is purged)."""
    shutil.rmtree(folder(aid), ignore_errors=True)


# ---------------------------------------------------------------- the request

def _file(path_str: str) -> Path:
    path = grants.require(path_str)
    if not path.is_file():
        raise HTTPException(400, f"[APO-FILE-301] {path.name}: file not found")
    if path.suffix.lower() not in SUPPORTED:
        raise HTTPException(400, f"[APO-FILE-303] {path.name}: Apollo can't read {path.suffix} files. "
                                 "Use Word, PDF, PowerPoint, text or a photo.")
    return path


def checked_files(args: dict) -> dict:
    """The work and rubric files of a marking request, checked (granted, present, readable types)."""
    work = args.get("work_paths") or []
    if not isinstance(work, list) or not work:
        raise HTTPException(400, "Add the work you want Apollo to mark.")
    if len(work) > MAX_FILES:
        raise HTTPException(400, f"[APO-GEN-404] Add at most {MAX_FILES} files to mark at once.")
    out_of = args.get("out_of")
    if out_of not in (None, ""):
        try:
            if float(out_of) <= 0:
                raise ValueError
        except (TypeError, ValueError):
            raise HTTPException(400, "“Marked out of” must be a number above 0, or left empty.")
    return {"work": [_file(p) for p in dict.fromkeys(work)],
            "rubric": _file(args["rubric_path"]) if args.get("rubric_path") else None}


def params(args: dict, files: dict) -> dict:
    """What is kept in the artifact's params (the copies' places are added by store_files)."""
    out = {k: v for k, v in args.items() if k not in ("work_paths", "rubric_path", "against", "out_of")}
    out["material"] = args.get("against") != "nothing"
    out["out_of"] = float(args["out_of"]) if args.get("out_of") not in (None, "") else None
    return out


def title(files: dict) -> str:
    first = files["work"][0].stem
    return f"Marking: {first}" + (f" +{len(files['work']) - 1}" if len(files["work"]) > 1 else "")


def _safe(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]+', " ", name).strip()[:80] or "file"


def store_files(aid: int, args: dict, files: dict) -> dict:
    """Copy the work and rubric under assets/marking/<aid>/ and note where in the params."""
    out = dict(args)
    out["work"] = []
    for i, p in enumerate(files["work"], 1):
        rel = f"marking/{aid}/work/{i:02d}_{_safe(p.name)}"
        config.copy_atomic(p, config.assets_dir() / rel)
        out["work"].append({"name": p.name, "file": rel})
    out["rubric"] = None
    if files["rubric"]:
        p = files["rubric"]
        name = files.get("rubric_name") or p.name  # a new version reuses the previous marking's copy
        rel = f"marking/{aid}/rubric/{_safe(name)}"
        config.copy_atomic(p, config.assets_dir() / rel)
        out["rubric"] = {"name": name, "file": rel}
    return out


def new_version(prev: dict, args: dict) -> tuple[dict, dict, str]:
    """(params args, files, title) for "Mark a new version" of the marking `prev`: new work files, and the same rubric,
    instructions, out-of and material as before unless the request changes them. The result links back to `prev`
    (params.previous) and its summary compares with it (gen_marking)."""
    old = json.loads(prev["params"] or "{}")
    req = {"work_paths": args.get("work_paths") or [], "rubric_path": args.get("rubric_path") or None,
           "out_of": args["out_of"] if "out_of" in args else old.get("out_of")}
    files = checked_files(req)
    if not files["rubric"] and old.get("rubric") and not args.get("drop_rubric"):
        copy = config.assets_dir() / old["rubric"]["file"]
        if copy.is_file():
            files["rubric"], files["rubric_name"] = copy, old["rubric"]["name"]
    out = {k: v for k, v in old.items() if k in ("units", "document_ids", "instructions", "material")}
    if isinstance(args.get("instructions"), str):
        out["instructions"] = args["instructions"].strip()[:2000]
        if not out["instructions"]:
            out.pop("instructions")
    out["out_of"] = float(req["out_of"]) if req["out_of"] not in (None, "") else None
    out["previous"] = prev["id"]
    n = len(history(prev["id"])) + 1
    return out, files, f"{title(files)} (version {n})"


def history(aid: int, limit: int = 20) -> list[dict]:
    """The marking `aid` and the earlier versions it was a new version of, newest first: {id, title, score, out_of,
    created_at} (deleted ones are skipped but followed)."""
    out, seen = [], set()
    while aid and aid not in seen and len(seen) < limit:
        seen.add(aid)
        a = db.q1("SELECT id, title, params, content, status, deleted_at, created_at FROM artifacts WHERE id=? AND type='marking'", (aid,))
        if a is None:
            break
        m = (json.loads(a["content"]) if a["content"] else {}).get("marking") or {}
        if not a["deleted_at"]:
            out.append({"id": a["id"], "title": a["title"], "score": m.get("score"), "out_of": m.get("out_of"),
                        "created_at": a["created_at"], "status": a["status"]})
        aid = (json.loads(a["params"] or "{}")).get("previous")
    return out


# ---------------------------------------------------------------- reading the files

def _office_pdf(path: Path, aid: int) -> Path | None:
    """An exact PDF of a Word/PowerPoint file (Office or LibreOffice, as for the viewer), kept beside the copy."""
    out = folder(aid) / "pdf" / f"{path.stem}.pdf"
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_suffix(".part.pdf")
    with render._lock:  # one Office conversion at a time
        error = render.export_pdf(path, part, path.suffix.lower()[1:])
    if error:  # marked from its text alone
        log.warning("marking %s: no PDF of %s: %s", aid, path.name, error)
    if error is None and part.exists():
        part.replace(out)
        return out
    part.unlink(missing_ok=True)
    return None


def _page_count(pdf: Path) -> int:
    with pymupdf.open(pdf) as d:
        return len(d)


def read_file(path: Path, aid: int) -> dict:
    """{name, text, pdf, images: [(bytes, mime)]} of one file: its text from the native parsers, and its pages as
    pictures (a PDF's pages, a Word/PowerPoint file's exact PDF when a converter exists, a photo scaled down)."""
    ext = path.suffix.lower()
    if ext in IMAGE_EXTS:
        return {"name": path.name, "text": "", "pdf": None, "images": [llm.model_image(path.read_bytes(), max_side=2048)]}
    with tempfile.TemporaryDirectory() as tmp:  # extracted pictures aren't kept: the page images are what's sent
        units, _ = parse(path, Path(tmp), {**config.DEFAULT_SETTINGS, **db.get_settings()})
    text = "\n\n".join(f"[{u['label']}]\n{u['text'].strip()}" for u in units if u["text"].strip())
    pdf = path if ext == ".pdf" else _office_pdf(path, aid) if ext in render.OFFICE_EXTS else None
    return {"name": path.name, "text": text, "pdf": pdf, "images": []}


def _render_pages(f: dict) -> None:
    if f["pdf"] and not f["images"]:
        f["images"] = [(render_pdf_page(f["pdf"], i, dpi=DPI), "image/png") for i in range(1, _page_count(f["pdf"]) + 1)]


def _too_much(technical: str, plain: str):
    return errors.AppError("APO-GEN-404", technical, plain=plain)


# ---------------------------------------------------------------- what the model returns

class Criterion(BaseModel):
    label: str = Field(description="short name: 'Q1', 'Q2b', or a criterion like 'Use of evidence'")
    max: float = Field(gt=0, description="marks available")
    description: str = Field(default="", description="what earns the marks")


class Criteria(BaseModel):
    task: str = Field(default="", description="what the work was asked to do, in one sentence")
    criteria: list[Criterion]


class MarkItem(BaseModel):
    label: str = Field(description="the question or criterion, named exactly as in the rubric / criteria")
    awarded: float
    max: float
    feedback: str = Field(description="specific feedback to the student: what is right, what is wrong and why")
    corrections: list[str] = Field(default=[], description="each mistake with the correct version")
    quote: str = Field(default="", description="the student's own words or working this is about, copied exactly")
    page: int | None = Field(default=None, description="the page number (as labelled) the quote is on")


class Batch(BaseModel):
    items: list[MarkItem]


class Score(BaseModel):
    label: str
    awarded: float
    max: float


class Summary(BaseModel):
    overall: str = Field(description="2-4 sentences to the student on the work as a whole")
    strengths: list[str]
    improvements: list[str] = Field(description="the most useful things to do next time, most important first")
    scores: list[Score] = Field(default=[], description="one final mark per question/criterion")
    improved: list[str] = Field(default=[], description="only when a PREVIOUS MARKING is given: what this version does "
                                "better than the previous one, most important first; otherwise empty")
    still_to_do: list[str] = Field(default=[], description="only when a PREVIOUS MARKING is given: what the previous "
                                   "marking asked for that this version still doesn't do; otherwise empty")


# ---------------------------------------------------------------- prompts

RULES = ("You are Apollo, an experienced and fair teacher marking a student's own work for {scope}.\n"
         "Mark strictly against the marking guide (or the criteria given with the task): award marks only where the "
         "work earns them, partial credit where the guide allows it, never more than a question's or criterion's marks. "
         "Be specific: quote the student's words or working, say what is right, what is wrong and why, and give the "
         "correct version of every mistake. Be honest and encouraging, and address the student as 'you'. "
         "Handwriting and photos: read them carefully; if something can't be read, say so rather than guessing. "
         "Write maths in LaTeX between $...$.")


def _system(scope: str, rubric: dict | None, material: str) -> str:
    out = RULES.format(scope=scope)
    if rubric and rubric["text"]:
        out += f"\n\n=== MARKING GUIDE (from the student's file '{rubric['name']}') ===\n{rubric['text']}"
    elif rubric:
        out += f"\n\n=== MARKING GUIDE ===\nThe marking guide '{rubric['name']}' is in the pictures at the start of the student's message."
    else:
        out += "\n\nThere is no marking guide: mark against the criteria given with the task."
    if material:
        out += ("\n\n=== STUDY MATERIAL (what the student was taught: check facts against it, and when feedback relies on "
                "it, cite where as [[filename · Slide/Page/Section label]]) ===\n" + material)
    return out


def _work_block(files: list[dict], pages: list[dict], out_of: float | None, instructions: str) -> str:
    """The first user block, the same in every call: the work's extracted text and how the pages are numbered."""
    parts = ["=== THE STUDENT'S WORK ==="]
    for f in files:
        parts.append(f"--- {f['name']} ---\n{f['text'] or '(no text could be extracted: read it from its pictures)'}")
    if any(p.get("asset") for p in pages):
        parts.append("Its pages are numbered across all files: " + "; ".join(
            f"Page {i} = {p['label']}" for i, p in enumerate(pages, 1) if p.get("asset")))
    if out_of:
        parts.append(f"The work is marked out of {out_of:g}.")
    if instructions:
        parts.append(f"The student's instructions for this marking: {instructions}")
    return "\n\n".join(parts)


def _material(art: dict, params: dict, query: str) -> str:
    """The material to check against: all of it when it fits, else the passages that match the work."""
    if not params.get("material", True):
        return ""
    units = context.norm_units(params.get("units"))
    groups = context.material_groups(art["subject_id"], art["topic_id"], int(llm.context_tokens() * 0.35),
                                     params.get("document_ids") or None, units)
    if not groups:
        return ""
    if len(groups) == 1:
        return groups[0]["text"]
    ids = sorted({s["doc_id"] for g in groups for s in g["sections"]})
    return context._format_hits(search.search(query[:3000] or art["title"], ids, 14))


_norm = lambda s: re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()  # noqa: E731


def _merge(batches: list[list[MarkItem]], criteria: list[Criterion] | None, scores: list[Score]) -> list[dict]:
    """One entry per question/criterion. A criterion judged in several batches (e.g. an essay's structure) gets the
    summary's final mark (else the average); its feedback and quotes are kept from every batch."""
    out: dict[str, dict] = {}
    for c in criteria or []:
        out.setdefault(_norm(c.label), {"label": c.label, "max": c.max, "marks": [], "feedback": [], "corrections": [],
                                        "quotes": [], "pages": []})
    for items in batches:
        for it in items:
            k = _norm(it.label) or "?"
            c = out.setdefault(k, {"label": it.label.strip() or "Other", "max": 0.0, "marks": [], "feedback": [],
                                   "corrections": [], "quotes": [], "pages": []})
            c["max"] = max(c["max"], float(it.max or 0))
            c["marks"].append(float(it.awarded or 0))
            if it.feedback.strip():
                c["feedback"].append(it.feedback.strip())
            c["corrections"] += [x.strip() for x in it.corrections if x.strip() and x.strip() not in c["corrections"]]
            if it.quote.strip():
                c["quotes"].append({"text": it.quote.strip(), "page": it.page})
            if it.page and it.page not in c["pages"]:
                c["pages"].append(it.page)
    final = {_norm(s.label): s for s in scores}
    rows = []
    for k, c in out.items():
        s = final.get(k) if len(c["marks"]) > 1 else None
        if s is not None:
            c["max"] = max(c["max"], float(s.max or 0))
        awarded = float(s.awarded) if s is not None else (sum(c["marks"]) / len(c["marks"]) if c["marks"] else 0.0)
        feedback = "\n\n".join(c["feedback"]) or ("Apollo couldn't find an answer for this in the work." if not c["marks"] else "")
        rows.append({"label": c["label"], "awarded": round(max(0.0, min(awarded, c["max"])), 2), "max": c["max"],
                     "feedback": feedback, "corrections": c["corrections"], "quotes": c["quotes"], "pages": sorted(c["pages"])})
    return [r for r in rows if r["max"] > 0 or r["feedback"]]


# ---------------------------------------------------------------- a new version of the same work

def _saved(art: dict, params: dict):
    from .generate import _partial  # here: generate imports this module
    return _partial(art, params)


def _previous(params: dict) -> dict | None:
    """The marking this one is a new version of ({id, title, created_at, marking}), when it's still there and finished."""
    pid = params.get("previous")
    a = db.q1("SELECT id, title, content, created_at FROM artifacts WHERE id=? AND type='marking'", (pid,)) if pid else None
    m = (json.loads(a["content"]) if a and a["content"] else {}).get("marking")
    return {"id": a["id"], "title": a["title"], "created_at": a["created_at"], "marking": m} if m else None


def _previous_text(prev: dict) -> str:
    """The previous marking for the summary call, after the cached prefix (rules, guide, material, the work)."""
    m = prev["marking"]
    lines = [f"- {c['label']}: {float(c.get('awarded') or 0):g} of {float(c.get('max') or 0):g}. "
             + " ".join(str(c.get("feedback") or "").split())[:600] for c in m.get("criteria") or []]
    todo = m.get("improvements") or []
    return ("\n\n=== PREVIOUS MARKING (an earlier version of this same work, marked by you) ===\n"
            f"Score then: {float(m.get('score') or 0):g} out of {float(m.get('out_of') or 0):g}\n" + "\n".join(lines)
            + ("\nWhat it said to improve:\n" + "\n".join(f"- {x}" for x in todo) if todo else "")
            + "\n=== END ===\nThis is a NEW VERSION of that work. Mark it on its own merits (the marks above are not a "
              "starting point), then fill `improved` (what is better now) and `still_to_do` (what the previous marking "
              "asked for that is still missing), comparing with the previous marking.")


def _compare(rows: list[dict], prev: dict, summary: "Summary") -> dict:
    """Score changes against the previous version: each criterion gets `previous` (its earlier mark, matched by label)
    and the result links back (previous, history: the earlier versions, newest first)."""
    m = prev["marking"]
    before = {_norm(c["label"]): c for c in m.get("criteria") or []}
    for r in rows:
        c = before.get(_norm(r["label"]))
        r["previous"] = {"awarded": c.get("awarded"), "max": c.get("max")} if c else None
    return {"previous": {"id": prev["id"], "title": prev["title"], "score": m.get("score"), "out_of": m.get("out_of"),
                         "created_at": prev["created_at"]},
            "history": history(prev["id"]),
            "improved": [x for x in summary.improved if x.strip()],
            "still_to_do": [x for x in summary.still_to_do if x.strip()]}


# ---------------------------------------------------------------- the job

def gen_marking(art: dict, params: dict, _groups, prog) -> dict:
    aid = art["id"]
    reasoning = db.setting("marking_reasoning")
    work = params.get("work") or []
    if not work:
        raise errors.AppError("APO-GEN-403", "marking without work files", plain="There was no work to mark. Make it again with your files.")
    root = config.assets_dir()
    missing = [w["name"] for w in work if not (root / w["file"]).is_file()]
    if missing:
        raise errors.AppError("APO-FILE-301", f"marking copy missing: {missing}", plain=f"Apollo's copy of {missing[0]} is gone. "
                              "Make the marking again with your files.")

    # 1. read every file (text, then page pictures), within the page cap
    files = []
    for k, w in enumerate(work):
        prog(0.02 + 0.1 * k / len(work), f"Reading {w['name']}")
        f = read_file(root / w["file"], aid)
        f["name"] = w["name"]
        files.append(f)
    n_pages = sum(_page_count(f["pdf"]) if f["pdf"] else len(f["images"]) for f in files)
    if n_pages > MAX_PAGES:
        raise _too_much(f"{n_pages} pages", f"That's {n_pages} pages, more than Apollo marks at once ({MAX_PAGES}). "
                                            "Mark fewer files, or split the work into parts.")
    pages = []  # what the view shows beside the feedback
    shown = folder(aid) / "pages"
    shutil.rmtree(shown, ignore_errors=True)
    for f in files:
        prog.message(f"Preparing the pages of {f['name']}")
        _render_pages(f)
        for n, (img, mime) in enumerate(f["images"], 1):
            rel = f"marking/{aid}/pages/{len(pages) + 1:03d}.{'jpg' if mime == 'image/jpeg' else 'png'}"
            config.write_atomic(root / rel, img)
            pages.append({"file": f["name"], "n": n, "asset": rel, "image": (img, mime),
                          "label": f"{f['name']}, page {n}" if len(f["images"]) > 1 else f["name"]})
        if not f["images"]:  # text only (a text file, or Word without a converter): shown as text
            pages.append({"file": f["name"], "n": 1, "label": f["name"], "text": f["text"][:20000]})
    if not any(f["text"].strip() for f in files) and not any(p.get("asset") for p in pages):
        raise errors.AppError("APO-FILE-306", "marking: no text and no pages", plain="Apollo found nothing to read in the work.")

    rubric = None
    if params.get("rubric"):
        prog.message("Reading the marking guide")
        rf = read_file(root / params["rubric"]["file"], aid)
        if not rf["text"].strip():
            _render_pages(rf)
        rubric = {"name": params["rubric"]["name"], "text": rf["text"].strip(), "images": rf["images"][:RUBRIC_IMAGES] if not rf["text"].strip() else []}

    work_text = "\n\n".join(f["text"] for f in files)
    budget = int(llm.context_tokens())
    if approx_tokens(work_text) > budget * 0.3:
        raise _too_much(f"{approx_tokens(work_text)} tokens of work", "The work is too long to mark at once. Mark one file, "
                        "or part of it, at a time.")
    prog(0.15, "Collecting material" if params.get("material", True) else "Getting ready to mark")
    material = _material(art, params, work_text or params.get("instructions") or "")
    system = _system(art["scope"].split(" (all topics)")[0], rubric, material)
    head = [llm.image_part(img, mime) for img, mime in (rubric or {}).get("images", [])]
    head.append({"type": "text", "text": _work_block(files, pages, params.get("out_of"), (params.get("instructions") or "").strip())})

    def call(task: str, images: list[tuple[int, dict]], schema, max_tokens=16000):
        content = list(head) + [{"type": "text", "text": task}]
        for i, p in images:
            content += [{"type": "text", "text": f"Page {i}: {p['label']}"}, llm.image_part(*p["image"])]
        return llm.chat_json([{"role": "system", "content": system}, {"role": "user", "content": content}], schema,
                             max_tokens=max_tokens, reasoning=reasoning, temperature=0.1)

    numbered = [(i, p) for i, p in enumerate(pages, 1) if p.get("asset")]
    out_of = params.get("out_of")

    # 2. no marking guide: the criteria come from the task itself
    saved = _saved(art, params)
    criteria = None
    if rubric is None and "criteria" in saved:  # worked out before a failure, cancel or restart
        criteria = [Criterion.model_validate(c) for c in saved.get("criteria")]
    elif rubric is None:
        prog(0.2, "Working out what to mark against")
        res = call("There is no marking guide. Decide how this work should be marked: for questions, one criterion per "
                   "question or part, labelled as on the paper ('Q1', 'Q2b'), with the marks shown on it; for an essay, "
                   "report or other extended answer, 4-7 criteria (for example understanding, accuracy, use of evidence, "
                   "structure, communication). "
                   + (f"The marks must add up to {out_of:g}. " if out_of else "Give sensible marks to each. ")
                   + "Base them on what the work was asked to do, the student's instructions and the study material.",
                   numbered[:BATCH], Criteria, max_tokens=12000)
        criteria = [c for c in res.criteria if c.label.strip()]
        saved.put("criteria", [c.model_dump() for c in criteria])
    crit_text = ("\n\nMark against these criteria (use these labels):\n"
                 + "\n".join(f"- {c.label} ({c.max:g} marks): {c.description}" for c in criteria)) if criteria else ""

    # 3. mark, a batch of pages at a time
    chunks = [numbered[i:i + BATCH] for i in range(0, len(numbered), BATCH)] or [[]]
    batches: list[list[MarkItem]] = []
    for b, chunk in enumerate(chunks):
        key = f"b{b}:" + ",".join(p["label"] for _, p in chunk)
        if key in saved:  # marked before a failure, cancel or restart
            batches.append([MarkItem.model_validate(it) for it in saved.get(key)])
            continue
        prog(0.25 + 0.6 * b / len(chunks), f"Marking pages {chunk[0][0]}–{chunk[-1][0]} of {len(numbered)}"
             if len(chunks) > 1 else "Marking the work")
        if len(chunks) == 1:
            task = ("Mark the whole work: every question or criterion of the marking guide, with marks awarded, the marks "
                    "available, feedback, corrections, and the student's words it is about (with its page number).")
        else:
            task = (f"These are pages {chunk[0][0]}–{chunk[-1][0]} of {len(numbered)}. Mark the questions or criteria "
                    "whose answers are on these pages. For a criterion about the whole work (such as structure), judge "
                    "it from these pages only; the parts are combined afterwards. Leave out questions not on these pages.")
        batches.append(call(task + crit_text, chunk, Batch).items)
        saved.put(key, [it.model_dump() for it in batches[-1]])

    # 4. the summary (and one final mark for anything judged in several batches)
    prog(0.88, "Writing the summary")
    found = [it.model_dump() for items in batches for it in items]
    prev = _previous(params)
    summary = call("Here is the marking of each part:\n" + json.dumps(found, ensure_ascii=False)
                   + "\n\nWrite the overall comment to the student, their main strengths, and what to improve, most "
                   "important first. In `scores`, give one final mark for each question or criterion"
                   + (" (one per criterion listed above)." if criteria else ".") + crit_text
                   + (_previous_text(prev) if prev else ""), [], Summary, max_tokens=10000)

    rows = _merge(batches, criteria, summary.scores if len(chunks) > 1 else [])
    got, available = sum(r["awarded"] for r in rows), sum(r["max"] for r in rows)
    scaled = bool(out_of and available and abs(available - out_of) > 0.01)
    score = round(got / available * out_of, 1) if scaled else round(got, 2)
    for p in pages:
        p.pop("image", None)
    compare = _compare(rows, prev, summary) if prev else {}
    return {"marking": {**compare,
        "score": score, "out_of": out_of or available, "scaled": scaled, "raw": {"awarded": got, "available": available},
        "criteria": rows, "overall": summary.overall.strip(), "strengths": summary.strengths,
        "improvements": summary.improvements, "pages": pages, "files": [f["name"] for f in files],
        "rubric": (params.get("rubric") or {}).get("name"), "derived": criteria is not None,
        "material": art["scope"] if params.get("material", True) and material else None,
    }}
