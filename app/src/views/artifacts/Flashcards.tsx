/* Flashcards: flip, rate yourself (struggling cards go to the chat tutor), shuffle. */
import { useEffect, useState } from 'react';
import { api, Artifact } from '../../api';
import Markdown from '../../components/Markdown';
import { useOverlay } from '../../components/overlay';
import { Progress } from '../../components/ui';
import { Source } from './Sections';

export type Rating = 'confident' | 'struggling';

export function Flashcards({ artifact }: { artifact: Artifact }) {
  const ov = useOverlay();
  const [cards, setCards] = useState(() => artifact.content!.cards ?? []);
  const [order, setOrder] = useState(() => cards.map((_, i) => i));
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [list, setList] = useState(false);
  const [ratings, setRatings] = useState<Record<number, Rating>>(() =>
    Object.fromEntries(Object.entries(artifact.ratings ?? {}).map(([k, v]) => [Number(k), v])));
  const [toast, setToast] = useState<string | null>(null);
  const idx = order[i];
  const c = cards[idx];
  const go = (d: number) => { setFlipped(false); setI((x) => (x + d + order.length) % order.length); };

  /** Delete badly generated cards (by deck index). Ratings follow the cards that stay, as the backend renumbers them. */
  const removeCards = async (idxs: number[]) => {
    const ok = await ov.confirm({ title: idxs.length === 1 ? 'Delete this card?' : `Delete ${idxs.length} cards?`,
      body: 'It is removed from the deck for good, along with its ✓/✗ rating.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    await api.deleteCards(artifact.id, idxs);
    const drop = new Set(idxs);
    const remap = new Map<number, number>();
    cards.forEach((_, k) => { if (!drop.has(k)) remap.set(k, remap.size); });
    setCards(cards.filter((_, k) => !drop.has(k)));
    setRatings((r) => Object.fromEntries(Object.entries(r).filter(([k]) => remap.has(Number(k))).map(([k, v]) => [remap.get(Number(k))!, v])));
    const kept = order.filter((k) => remap.has(k)).map((k) => remap.get(k)!);
    const next = kept.length ? kept : [...remap.values()];
    setOrder(next);
    setI((x) => Math.min(x, Math.max(0, next.length - 1)));
    setFlipped(false);
  };

  const rate = async (r: Rating) => {
    const next = ratings[idx] === r ? undefined : r;
    setRatings((m) => { const n = { ...m }; if (next) n[idx] = next; else delete n[idx]; return n; });
    await api.rateCard(artifact.id, idx, next ?? 'none');
    if (next === 'struggling') setToast('Noted. Apollo will give this extra attention in chat.');
    else if (next === 'confident') setToast('Marked as confident.');
    setTimeout(() => setToast(null), 2200);
    if (next) setTimeout(() => go(1), 350);
  };

  useEffect(() => {
    if (list) return;
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === ' ') { e.preventDefault(); setFlipped((f) => !f); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  if (!cards.length) return <div className="muted">No cards were generated.</div>;
  const confident = Object.values(ratings).filter((r) => r === 'confident').length;
  const struggling = Object.values(ratings).filter((r) => r === 'struggling').length;

  return (
    <div className="fc-wrap">
      <div className="fc-bar">
        <span className="muted">{list ? `${cards.length} cards` : `Card ${i + 1} of ${cards.length}`}</span>
        <span className="fc-tally"><span className="ok">✓ {confident}</span><span className="bad">✗ {struggling}</span></span>
        <span className="spacer" />
        {!list && <button className="btn btn-sm" onClick={() => { setOrder([...order].sort(() => Math.random() - 0.5)); setI(0); setFlipped(false); }}>Shuffle</button>}
        {!list && struggling > 0 && <button className="btn btn-sm" onClick={() => { setOrder(order.filter((k) => ratings[k] === 'struggling')); setI(0); setFlipped(false); }}>Only ✗ cards</button>}
        {!list && order.length !== cards.length && <button className="btn btn-sm" onClick={() => { setOrder(cards.map((_, k) => k)); setI(0); }}>All cards</button>}
        {!list && <button className="btn btn-sm" data-tip="Delete this card from the deck" onClick={() => removeCards([idx])}>Delete card</button>}
        <button className="btn btn-sm" onClick={() => setList(!list)}>{list ? 'Study mode' : 'List all'}</button>
      </div>
      {list ? (
        <div className="card-list">
          {cards.map((c, k) => (
            <div key={k} className={`card-list-item${ratings[k] ? ` rated-${ratings[k]}` : ''}`}>
              <button className="x-btn card-x" title="Delete card" onClick={() => removeCards([k])}>×</button>
              <Markdown text={c.front} className="card-list-front" />
              <Markdown text={c.back} />
              <Source s={c.source} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className={`flashcard${flipped ? ' flipped' : ''}${ratings[idx] ? ` rated-${ratings[idx]}` : ''}`} onClick={() => setFlipped(!flipped)}>
            <div className="flashcard-inner">
              <div className="flashcard-face front"><Markdown text={c.front} /><div className="flip-hint">Click or press Space to flip</div></div>
              <div className="flashcard-face back"><Markdown text={c.back} /><Source s={c.source} /></div>
            </div>
          </div>
          <div className="fc-rate">
            <button className={`rate-btn rate-yes${ratings[idx] === 'confident' ? ' on' : ''}`} data-tip="I'm confident with this" onClick={() => rate('confident')}>✓</button>
            <button className={`rate-btn rate-no${ratings[idx] === 'struggling' ? ' on' : ''}`} data-tip="I need more revision on this" onClick={() => rate('struggling')}>✗</button>
          </div>
          <div className="viewer-nav">
            <button className="btn" onClick={() => go(-1)}>← Previous</button>
            <Progress value={(i + 1) / order.length} />
            <button className="btn btn-primary" onClick={() => go(1)}>Next →</button>
          </div>
          {toast && <div className="toast">{toast}</div>}
        </>
      )}
    </div>
  );
}
