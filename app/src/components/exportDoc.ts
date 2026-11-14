/* Export notes, cheat sheets, exams and markings to Word or PDF.
   PDF: the content is rendered into #print-root (print styles hide the rest of the app and use light colours) and
   Electron prints the window, so maths, figures and graphs look exactly as in the app. Word: the backend builds a
   .docx from simpler HTML (maths as LaTeX text, which Word can't take as KaTeX). */
import { api, Artifact, ArtifactContent, ExamQuestion, inElectron } from '../api';
import { renderMarkdown } from './Markdown';
import { leaves } from '../views/artifacts/Exam';

export type ExportFormat = 'pdf' | 'docx';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeName = (s: string) => s.replace(/[<>:"/\\|?*]+/g, ' ').trim().slice(0, 80) || 'export';

/** Generated notes / cheat sheet sections. */
export function sectionsHtml(content: ArtifactContent, word: boolean): string {
  const secs = content.sections ?? [];
  return secs.map((s) => {
    const body = s.html != null
      ? renderMarkdown(s.html, { html: true, figures: s.figures ?? {}, mathText: word })
      : renderMarkdown(s.markdown ?? '', { mathText: word });
    return `${secs.length > 1 ? `<h1>${esc(s.title)}</h1>` : ''}<div class="md nb">${body}</div>`;
  }).join('\n');
}

const md = (text: string, word: boolean) => renderMarkdown(text ?? '', { mathText: word });
const mdInline = (text: string, word: boolean) => renderMarkdown(text ?? '', { mathText: word, inline: true });
const letters = 'ABCDEFGHIJ';

/** An exam paper; with `answers`, the answer key and marking scheme follow it. */
export function examHtml(content: ArtifactContent, word: boolean, answers: boolean): string {
  const parts = content.parts ?? [];
  const out: string[] = [];
  const meta = [content.total_marks != null && `Total: ${content.total_marks} marks`, content.time_minutes && `Time: ${content.time_minutes} minutes`]
    .filter(Boolean).join(' · ');
  if (meta) out.push(`<p><b>${esc(meta)}</b></p>`);
  if (content.blueprint?.instructions) out.push(md(content.blueprint.instructions, word));
  const space = (q: { options?: string[]; marks: number }) => (q.options?.length || word ? '' : `<div class="answer-space" style="height:${Math.min(14, 2 + q.marks * 1.4)}em"></div>`);
  const options = (opts: string[] | undefined) => (opts?.length
    ? `<ol type="A" class="exam-options">${opts.map((o) => `<li>${mdInline(o, word)}</li>`).join('')}</ol>` : '');
  let n = 0;
  for (const p of parts) {
    out.push(`<h2>${esc(p.name)}</h2>`);
    if (p.instructions) out.push(`<p><i>${esc(p.instructions)}</i></p>`);
    for (const q of p.questions) {
      n += 1;
      out.push(`<div class="exam-q"><p><b>Question ${n}</b> <span class="marks">[${q.marks} mark${q.marks === 1 ? '' : 's'}]</span></p>`);
      if (q.stimulus) out.push(`<blockquote>${md(q.stimulus, word)}</blockquote>`);
      out.push(md(q.prompt, word), options(q.options));
      if (q.subquestions?.length) {
        q.subquestions.forEach((s, si) => {
          out.push(`<p><b>(${String.fromCharCode(97 + si)})</b> <span class="marks">[${s.marks}]</span></p>`, md(s.prompt, word), options(s.options), space(s));
        });
      } else out.push(space(q));
      out.push('</div>');
    }
  }
  if (answers) {
    out.push('<h1 class="page-break">Answers and marking scheme</h1>');
    for (const k of leaves(parts)) {
      const q = k.q as ExamQuestion;
      const choice = q.options?.length && q.answer_index != null ? q.options[q.answer_index] : null;
      const key = choice != null ? `<p><b>Answer:</b> ${letters[q.answer_index!]}. ${mdInline(choice, word)}</p>` : '';
      // an MCQ's model answer is usually just the option again
      const model = q.model_answer && q.model_answer.trim() !== choice?.trim() ? md(q.model_answer, word) : '';
      const rubric = q.rubric?.length ? `<ul>${q.rubric.map((r) => `<li>${mdInline(r.point, word)} <b>(${r.marks})</b></li>`).join('')}</ul>` : '';
      out.push(`<h3>${esc(k.label)}</h3>${key}${model}${rubric}`);
    }
  }
  return out.join('\n');
}

/** A marking of the student's work: the score, the overall comment, then each question or criterion's feedback. */
export function markingHtml(content: ArtifactContent, word: boolean): string {
  const m = content.marking;
  if (!m) return '';
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  const cites = (t: string) => t.replace(/\[\[([^\]]+)\]\]/g, '($1)'); // [[file · Slide 4]] citations as plain text
  const out = [`<p><b>Score: ${fmt(m.score)} / ${fmt(m.out_of)}</b>${m.scaled ? ` <i>(${fmt(m.raw.awarded)} / ${fmt(m.raw.available)} on the criteria)</i>` : ''}</p>`];
  const meta = [`Work: ${m.files.join(', ')}`, m.rubric ? `Marking guide: ${m.rubric}` : 'Criteria worked out by Apollo (no marking guide)',
    m.material ? `Checked against: ${m.material}` : ''].filter(Boolean);
  out.push(`<p><i>${esc(meta.join(' · '))}</i></p>`);
  if (m.previous) out.push(`<p><i>${esc(`A new version: the previous one scored ${fmt(m.previous.score)} / ${fmt(m.previous.out_of)}.`)}</i></p>`);
  if (m.overall) out.push(md(cites(m.overall), word));
  const list = (title: string, xs: string[]) => (xs.length ? `<h2>${esc(title)}</h2><ul>${xs.map((x) => `<li>${mdInline(cites(x), word)}</li>`).join('')}</ul>` : '');
  out.push(list('Strengths', m.strengths), list('To improve', m.improvements),
    list('Better than last time', m.improved ?? []), list('Still to do from last time', m.still_to_do ?? []));
  out.push('<h2>Feedback</h2>');
  for (const c of m.criteria) {
    const was = c.previous ? ` <i>(was ${fmt(c.previous.awarded)} / ${fmt(c.previous.max)})</i>` : '';
    out.push(`<h3>${esc(c.label)} <span class="marks">[${fmt(c.awarded)} / ${fmt(c.max)}]</span>${was}</h3>`);
    for (const q of c.quotes) out.push(`<blockquote>${mdInline(q.text, word)}${q.page ? ` <i>(page ${q.page})</i>` : ''}</blockquote>`);
    if (c.feedback) out.push(md(cites(c.feedback), word));
    if (c.corrections.length) out.push(`<p><b>Corrections</b></p><ul>${c.corrections.map((x) => `<li>${mdInline(cites(x), word)}</li>`).join('')}</ul>`);
  }
  return out.join('\n');
}

/** The export HTML for an artifact (notes, cheat sheet, exam or marking). */
export function artifactHtml(a: Artifact, word: boolean, answers = false): string {
  if (!a.content) return '';
  return a.type === 'exam' ? examHtml(a.content, word, answers) : a.type === 'marking' ? markingHtml(a.content, word)
    : sectionsHtml(a.content, word);
}

async function toPdf(title: string, html: string) {
  const root = document.createElement('div');
  root.id = 'print-root';
  root.innerHTML = `<h1 class="print-title">${esc(title)}</h1>${html}`;
  document.body.appendChild(root);
  document.body.classList.add('printing');
  try {
    // figures load from the backend: wait for them so they're in the PDF
    await Promise.all([...root.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
    await document.fonts?.ready;
    if (window.studyApp?.printPdf) return await window.studyApp.printPdf({ defaultName: safeName(title) });
    window.print();
    return null;
  } finally {
    document.body.classList.remove('printing');
    root.remove();
  }
}

async function toDocx(title: string, html: string) {
  if (inElectron) {
    const path = await window.studyApp!.saveFile({ defaultName: `${safeName(title)}.docx`, filters: [{ name: 'Word document', extensions: ['docx'] }] });
    if (!path) return null;
    const res = await api.exportDocx({ title, html, path });
    await window.studyApp!.showItem(res.path);
    return res.path;
  }
  const blob = await api.exportDocxBlob({ title, html });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName(title)}.docx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return a.download;
}

/** Export HTML built by `build(word)` as a PDF or Word file the student saves. */
export function exportAs(format: ExportFormat, title: string, build: (word: boolean) => string) {
  return format === 'pdf' ? toPdf(title, build(false)) : toDocx(title, build(true));
}
