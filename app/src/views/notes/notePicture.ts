/* A mind map or drawing as a PNG (data URL), from its stored data: for exports and Check with Apollo from the notes
   list, without opening the editor. */
import { Note } from '../../api';
import { drawingSvg, normalizeDrawing, svgToPng } from '../../components/ink';
import { mapSvg, normalizeMap } from './mapModel';

export function notePicture(n: Pick<Note, 'kind' | 'data'>, maxSide = 2400): Promise<string> {
  const s = n.kind === 'map' ? mapSvg(normalizeMap(n.data)) : drawingSvg(normalizeDrawing(n.data));
  return svgToPng(s.svg, s.w, s.h, maxSide);
}

/** The export HTML for a map or drawing: its picture (and a drawing's description). */
export async function pictureHtml(n: Pick<Note, 'kind' | 'data'>): Promise<string> {
  const img = await notePicture(n);
  const desc = n.kind === 'drawing' ? normalizeDrawing(n.data).description : '';
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return `<p><img src="${img}" alt="" style="max-width:100%"></p>${desc ? `<p><i>${esc(desc)}</i></p>` : ''}`;
}
