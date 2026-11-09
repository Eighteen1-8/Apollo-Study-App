/* Flashcards: flip, rate yourself (struggling cards go to the chat tutor), shuffle. */
import { useEffect, useState } from 'react';
import { api, Artifact } from '../../api';
import Markdown from '../../components/Markdown';
import { useOverlay } from '../../components/overlay';
import { Progress } from '../../components/ui';
import { Source } from './Sections';
import Icon from '../../components/Icon';

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
  // the end of a round: a summary instead of starting again from the first card
  const [summary, setSummary] = useState(false);
  const idx = order[i];
  const c = cards[idx];
  const go = (d: number) => {
    setFlipped(false);
    if (d > 0 && i === order.length - 1) { setSummary(true); return; }
    setI((x) => (x + d + order.length) % order.length);
  };
  const startRound = (next: number[]) => { setOrder(next); setI(0); setFlipped(false); setSummary(false); };

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
    if (list || summary) return;
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === ' ') { e.preventDefault(); setFlipped((f) => !f); }
      else if (e.key === '1') rate('confident');
      else if (e.key === '2') rate('struggling');
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  if (!cards.length) return <div className="muted">No cards were generated.</div>;
  const confident = Object.values(ratings).filter((r) => r === 'confident').length;
  const struggling = Object.values(ratings).filter((r) => r === 'struggling').length;
  const pct = (i + 1) / order.length;
  const R = 11, C = 2 * Math.PI * R;

  return (
    <div className="fc-wrap">
      <div className="fc-bar">
        {!list && !summary && (
          <svg className="fc-ring" viewBox="0 0 28 28" aria-hidden>
            <circle cx="14" cy="14" r={R} className="fc-ring-track" />
            <circle cx="14" cy="14" r={R} className="fc-ring-fill" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} />
          </svg>
        )}
        <span className="muted">{list ? `${cards.length} cards` : summary ? 'Round finished' : `Card ${i + 1} of ${order.length}`}</span>
        <span className="fc-tally"><span className="ok"><Icon name="check" size={14} /> {confident}</span><span className="bad"><Icon name="wrong" size={14} /> {struggling}</span></span>
        <span className="spacer" />
        {!list && !summary && <button className="btn btn-sm" onClick={() => { setOrder([...order].sort(() => Math.random() - 0.5)); setI(0); setFlipped(false); }}>Shuffle</button>}
        {!list && !summary && struggling > 0 && <button className="btn btn-sm" onClick={() => { setOrder(order.filter((k) => ratings[k] === 'struggling')); setI(0); setFlipped(false); }}>Only ✗ cards</button>}
        {!list && !summary && order.length !== cards.length && <button className="btn btn-sm" onClick={() => { setOrder(cards.map((_, k) => k)); setI(0); }}>All cards</button>}
        {!list && !summary && <button className="btn btn-sm" data-tip="Delete this card from the deck" onClick={() => removeCards([idx])}>Delete card</button>}
        <button className="btn btn-sm" onClick={() => setList(!list)}>{list ? 'Study mode' : 'List all'}</button>
      </div>
      {list ? (
        <div className="card-list">
          {cards.map((c, k) => (
            <div key={k} className={`card-list-item${ratings[k] ? ` rated-${ratings[k]}` : ''}`}>
              <button className="x-btn card-x" title="Delete card" onClick={() => removeCards([k])}><Icon name="close" size={14} /></button>
              <Markdown text={c.front} className="card-list-front" />
              <Markdown text={c.back} />
              <Source s={c.source} />
            </div>
          ))}
        </div>
      ) : summary ? (
        <RoundSummary known={order.filter((k) => ratings[k] === 'confident').length} again={order.filter((k) => ratings[k] === 'struggling').length}
          total={order.length}
          onAgain={() => startRound(order.filter((k) => ratings[k] === 'struggling'))}
          onRestart={() => startRound(cards.map((_, k) => k))}
          onShuffle={() => startRound(cards.map((_, k) => k).sort(() => Math.random() - 0.5))} />
      ) : (
        <>
          <div className={`flashcard${flipped ? ' flipped' : ''}${ratings[idx] ? ` rated-${ratings[idx]}` : ''}`} onClick={() => setFlipped(!flipped)}>
            <div className="flashcard-inner">
              <div className="flashcard-face front"><Markdown text={c.front} /><div className="flip-hint">Click or press Space to flip</div></div>
              <div className="flashcard-face back"><Markdown text={c.back} /><Source s={c.source} /></div>
            </div>
          </div>
          <div className="fc-rate">
            <button className={`rate-btn rate-yes${ratings[idx] === 'confident' ? ' on' : ''}`} data-tip="I'm confident with this" onClick={() => rate('confident')}><Icon name="check" size={18} /><span className="rate-label">Got it</span></button>
            <button className={`rate-btn rate-no${ratings[idx] === 'struggling' ? ' on' : ''}`} data-tip="I need more revision on this" onClick={() => rate('struggling')}><Icon name="wrong" size={18} /><span className="rate-label">Practise again</span></button>
          </div>
          <div className="fc-keys" aria-hidden><kbd>Space</kbd> flip <kbd>←</kbd><kbd>→</kbd> move <kbd>1</kbd> got it <kbd>2</kbd> practise again</div>
          <div className="viewer-nav">
            <button className="btn" onClick={() => go(-1)}>← Previous</button>
            <Progress value={(i + 1) / order.length} />
            <button className="btn btn-primary" onClick={() => go(1)}>{i === order.length - 1 ? 'Finish round' : 'Next'} <Icon name="next" size={15} /></button>
          </div>
          {toast && <div className="toast">{toast}</div>}
        </>
      )}
    </div>
  );
}

/** The end of a round: how many you knew, how many to practise again, and what to do next. */
function RoundSummary({ known, again, total, onAgain, onRestart, onShuffle }: {
  known: number; again: number; total: number; onAgain: () => void; onRestart: () => void; onShuffle: () => void;
}) {
  const pct = Math.round((known / Math.max(1, total)) * 100);
  return (
    <div className="fc-summary">
      <div className="ring" style={{ ['--pct' as string]: `${pct}` }}><span>{known}/{total}</span></div>
      <h2>{again === 0 && known === total ? 'You knew every card!' : known >= total * 0.7 ? 'Nicely done' : 'Round finished'}</h2>
      <div className="fc-summary-stats">
        <span className="ok"><Icon name="check" size={16} /> {known} known</span>
        <span className="bad"><Icon name="wrong" size={16} /> {again} to practise again</span>
        {total - known - again > 0 && <span className="muted">{total - known - again} not rated</span>}
      </div>
      <div className="fc-summary-actions">
        {again > 0 && <button className="btn btn-primary" onClick={onAgain}>Practise the {again} again</button>}
        <button className={`btn${again ? '' : ' btn-primary'}`} onClick={onRestart}>Start over</button>
        <button className="btn" onClick={onShuffle}>Shuffle and start over</button>
      </div>
    </div>
  );
}
