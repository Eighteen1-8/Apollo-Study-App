/* Slash commands in the chat box. They run in the app and are never sent to Apollo (ChatView.runCommand). */
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
  { name: 'new', summary: 'Start a new chat' },
  { name: 'rename', args: '[title]', summary: 'Rename this chat' },
  { name: 'title', summary: 'Let Apollo name this chat' },
  { name: 'stop', summary: 'Stop the reply being written' },
  { name: 'delete', summary: 'Delete this chat' },
  { name: 'help', summary: 'List the commands' },
];

/** Commands starting with what's typed after the slash (then ones containing it). */
export function matchCommands(typed: string): SlashCommand[] {
  const q = typed.toLowerCase();
  return [...COMMANDS.filter((c) => c.name.startsWith(q)), ...COMMANDS.filter((c) => !c.name.startsWith(q) && q && c.name.includes(q))];
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
