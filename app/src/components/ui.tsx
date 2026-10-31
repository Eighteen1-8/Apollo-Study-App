import { ReactNode } from 'react';
import katex from 'katex';

export function Button({ children, onClick, kind = 'default', disabled, title, small }: {
  children: ReactNode; onClick?: () => void; kind?: 'default' | 'primary' | 'ghost' | 'danger';
  disabled?: boolean; title?: string; small?: boolean;
}) {
  return (
    <button className={`btn btn-${kind}${small ? ' btn-sm' : ''}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

const STATUS_TONE: Record<string, string> = {
  ready: 'ok', done: 'ok', queued: 'muted', parsing: 'busy', embedding: 'busy', vision: 'busy', running: 'busy',
  pending: 'muted', failed: 'bad', cancelled: 'muted', none: 'muted', skipped: 'muted',
};

export function Pill({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`pill pill-${STATUS_TONE[status] ?? 'muted'}`}>{children ?? status}</span>;
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <div className="progress-bar" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/** Plain text with $...$ / $$...$$ segments rendered by KaTeX (bundled locally, offline). */
export function MathText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\$\$[^$]+\$\$|\$[^$\n]+\$)/g);
  return (
    <div className={`math-text ${className ?? ''}`}>
      {parts.map((p, i) => {
        const display = p.startsWith('$$') && p.endsWith('$$') && p.length > 4;
        const inline = !display && p.startsWith('$') && p.endsWith('$') && p.length > 2;
        if (!display && !inline) return <span key={i}>{p}</span>;
        const tex = display ? p.slice(2, -2) : p.slice(1, -1);
        const html = katex.renderToString(tex, { throwOnError: false, displayMode: display, output: 'html' });
        return <span key={i} className="math" data-tex={tex} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </div>
  );
}

