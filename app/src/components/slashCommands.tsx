/* Slash commands in the chat box. They run in the app and are never sent to Apollo (ChatView.runCommand). */
import { useState } from 'react';
import { ChatStats } from '../api';
import { fmtTokens } from '../hooks';

export interface SlashCommand { name: string; args?: string; summary: string }

export const COMMANDS: SlashCommand[] = [
  { name: 'stats', args: '[chat | subject | all]', summary: 'Tokens, time spent and cost' },
  { name: 'effort', args: 'off | low | medium | xhigh', summary: 'How much Apollo thinks before answering' },
  { name: 'create', args: 'flashcards | quiz | exam | notes | cheatsheet | mindmap [focus]', summary: 'Make study material' },
  { name: 'topic', args: '<topic name | all>', summary: 'Which material Apollo uses' },
  { name: 'context', summary: 'How full the context window is' },
  { name: 'todo', args: '<text>', summary: 'Add a to-do' },
  { name: 'calc', args: '[calculation]', summary: 'Open the calculator, or work something out here' },
  { name: 'graph', args: '<function of x>', summary: 'Draw a graph in the calculator' },
  { name: 'new', summary: 'Start a new chat' },
  { name: 'rename', args: '[title]', summary: 'Rename this chat' },
  { name: 'title', summary: 'Let Apollo name this chat' },
  { name: 'stop', summary: 'Stop the reply being written' },
  { name: 'delete', summary: 'Delete this chat' },
  { name: 'shortcuts', summary: 'Keyboard shortcuts and mouse gestures' },
  { name: 'help', summary: 'List the commands' },
];

/** Commands starting with what's typed after the slash (then ones containing it). */
export function matchCommands(typed: string): SlashCommand[] {
  const q = typed.toLowerCase();
  return [...COMMANDS.filter((c) => c.name.startsWith(q)), ...COMMANDS.filter((c) => !c.name.startsWith(q) && q && c.name.includes(q))];
}

/** The suggestions for what's typed in a chat box: a slash and a command name so far, nothing else. */
export function slashMatches(input: string): SlashCommand[] {
  return input.startsWith('/') && !/\s/.test(input) ? matchCommands(input.slice(1)) : [];
}

/** A command that needs nothing more (no arguments, or only optional ones in [ ]) runs when picked; others are put in
 * the box to finish typing. */
export const runsAtOnce = (c: SlashCommand) => !c.args || c.args.startsWith('[');

export interface SlashMenuState {
  list: SlashCommand[]; at: number; setAt: (i: number) => void;
  pick: (c: SlashCommand, complete?: boolean) => void;
  /** The menu's keys (arrows, Tab, Enter, Esc): true when the key was used. */
  onKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Call when the text changes (the highlight goes back to the first suggestion). */
  reset: () => void;
}

/** Slash-command suggestions for a chat box (the chat's composer and the study panel's bar). `onPick(c, complete)`:
 * Enter or a click (complete false) or Tab (complete true: only finish the name); `clear` empties the box (Esc). */
export function useSlashMenu(input: string, onPick: (c: SlashCommand, complete: boolean) => void, clear: () => void): SlashMenuState {
  const [at, setAt] = useState(0);
  const list = slashMatches(input);
  const cur = Math.max(0, Math.min(at, list.length - 1));
  const pick = (c: SlashCommand, complete = false) => { setAt(0); onPick(c, complete); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!list.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((cur + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
      e.preventDefault();
      pick(list[cur], e.key === 'Tab');
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clear(); return true; }
    return false;
  };
  return { list, at: cur, setAt, pick, onKeyDown, reset: () => setAt(0) };
}

/** The suggestion list, placed above the box by its container (position: relative). */
export function SlashMenu({ menu }: { menu: SlashMenuState }) {
  if (!menu.list.length) return null;
  return (
    <div className="slash-menu" role="listbox" aria-label="Commands">
      {menu.list.map((c, i) => (
        <button key={c.name} role="option" aria-selected={i === menu.at} className={`slash-item${i === menu.at ? ' on' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); menu.pick(c); }} onMouseEnter={() => menu.setAt(i)}>
          <b>/{c.name}</b>{c.args && <span className="slash-args">{c.args}</span>}<span className="slash-sum">{c.summary}</span>
        </button>
      ))}
    </div>
  );
}

export function fmtDuration(s: number) {
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function StatsCard({ stats: s, subject }: { stats: ChatStats; subject: string }) {
  const where = s.scope === 'all' ? 'All chats' : s.scope === 'subject' ? `All chats in ${subject}` : 'This chat';
  const counted = s.replies - s.uncounted;
  const cost = s.online_replies ? `$${s.cost.toFixed(s.cost < 0.01 ? 4 : 2)} on OpenRouter` : 'Free (ran on this PC)';
  const rows: [string, string][] = [
    ['Questions · replies', `${s.questions} · ${s.replies}${s.stopped ? ` (${s.stopped} stopped)` : ''}`],
    ['Tokens read (prompt)', s.prompt.toLocaleString()],
    ['Tokens written', `${s.completion.toLocaleString()}${s.reasoning ? ` (of which reasoning ${s.reasoning.toLocaleString()})` : ''}`],
    ['Time generating', `${fmtDuration(s.seconds)}${s.reasoning_seconds ? ` (thinking ${fmtDuration(s.reasoning_seconds)})` : ''}`],
    ['Speed', s.seconds > 0 && s.completion ? `${(s.completion / s.seconds).toFixed(1)} tokens/s overall` : '–'],
    ['Cost', s.online_replies && s.local_replies ? `${cost} · ${s.local_replies} local replies free` : cost],
  ];
  return (
    <div className="cmd-card">
      <div className="cmd-card-title">{where}{s.scope !== 'chat' ? ` · ${s.chats} chats` : ''}</div>
      <table className="cmd-table"><tbody>{rows.map(([k, v]) => <tr key={k}><td className="muted">{k}</td><td>{v}</td></tr>)}</tbody></table>
      {s.models.length > 0 && <div className="muted small">Model{s.models.length > 1 ? 's' : ''}: {s.models.join(', ')}</div>}
      {s.uncounted > 0 && <div className="muted small">{s.uncounted} older repl{s.uncounted === 1 ? 'y' : 'ies'} from before usage was recorded aren't counted{counted ? '' : ' (none are yet)'}.</div>}
      <div className="muted small">≈ {fmtTokens(s.prompt + s.completion)} tokens in total.</div>
    </div>
  );
}
