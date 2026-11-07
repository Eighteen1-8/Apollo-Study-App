/* Slash commands in the chat box (components/slashCommands.tsx lists them). */
import { api, Chat, Subject, ToolName } from '../../api';
import { CREATE_ITEMS } from '../SubjectView';
import { stopReply } from '../../chatStreams';
import { renameChatUndoable } from '../chatActions';
import { COMMANDS, StatsCard } from '../../components/slashCommands';
import { LEVEL_LABEL } from './types';

/** What a slash command can see and do in the chat (ChatView passes its own state and actions). */
export interface CommandContext {
  chat: Chat | null; subject: Subject; levels: string[]; reasoning: string; busy: boolean;
  /** Show a card in the chat (never sent to Apollo). */
  card: (node: React.ReactNode) => void;
  ensureChat: () => Promise<Chat>; pickLevel: (level: string) => void;
  quick: (tool: ToolName, args?: Record<string, unknown>) => Promise<void>;
  setTopic: (topicId: number | null) => Promise<void>; newChat: (topicId: number | null) => Promise<Chat>;
  renameThis: () => Promise<void>; deleteThis: () => Promise<void>;
  setChat: (c: Chat) => void; loadChats: () => Promise<Chat[]>;
}

/** Run a slash command typed in the chat box. They run in the app and are never sent to Apollo. */
export async function runCommand(text: string, ctx: CommandContext) {
  const { chat, subject, levels, reasoning, busy, card, ensureChat, pickLevel, quick, setTopic, newChat, renameThis, deleteThis, setChat, loadChats } = ctx;
  const [, name = '', rest = ''] = /^\/(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
  const arg = rest.trim();
  const cmd = COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!cmd) { card(<div className="msg-note small">Unknown command <b>/{name}</b>. Type <b>/help</b> for the list.</div>); return; }
  switch (cmd.name) {
    case 'help':
      card(<div className="cmd-card"><div className="cmd-card-title">Commands</div>
        {COMMANDS.map((c) => <div key={c.name} className="cmd-row"><b>/{c.name}</b>{c.args && <span className="muted"> {c.args}</span>} <span className="muted">· {c.summary}</span></div>)}
      </div>);
      break;
    case 'stats': {
      if (!chat && arg !== 'all' && arg !== 'subject') { card(<div className="msg-note small">No chat yet: ask something first, or try <b>/stats subject</b>.</div>); break; }
      const c = await ensureChat();
      const scope = arg === 'all' ? 'all' : arg === 'subject' ? 'subject' : 'chat';
      card(<StatsCard stats={await api.chatStats(c.id, scope)} subject={subject.name} />);
      break;
    }
    case 'effort': {
      const want = arg.toLowerCase().replace(/^x-?high$/, 'xhigh');
      if (!want) { card(<div className="msg-note small">Reasoning is <b>{LEVEL_LABEL[reasoning] ?? reasoning}</b>. Use /effort {['off', ...levels].join(' | ')}.</div>); break; }
      if (want !== 'off' && !levels.includes(want)) { card(<div className="msg-note small">Choose one of: {['off', ...levels].join(', ')}.</div>); break; }
      pickLevel(want);
      card(<div className="msg-note small">Reasoning set to <b>{LEVEL_LABEL[want] ?? want}</b>.</div>);
      break;
    }
    case 'create': {
      const [what = '', ...focus] = arg.split(/\s+/);
      const tool = CREATE_ITEMS.find((c) => c.tool.replace('create_', '') === what.toLowerCase().replace(/s$/, '') ||
        c.tool === `create_${what.toLowerCase()}` || c.label.toLowerCase().startsWith(what.toLowerCase()) && what)?.tool;
      if (!tool) { card(<div className="msg-note small">Create what? /create {CREATE_ITEMS.map((c) => c.tool.replace('create_', '')).join(' | ')} [focus]</div>); break; }
      await quick(tool, focus.length ? { focus: focus.join(' ') } : {});
      break;
    }
    case 'topic': {
      const t = arg ? subject.topics.find((x) => x.name.toLowerCase() === arg.toLowerCase())
        ?? subject.topics.find((x) => x.name.toLowerCase().includes(arg.toLowerCase())) : null;
      if (arg && !t && !/^all/i.test(arg)) { card(<div className="msg-note small">No topic matches “{arg}”.</div>); break; }
      await setTopic(t?.id ?? null);
      card(<div className="msg-note small">Apollo now uses <b>{t?.name ?? 'all topics'}</b>.</div>);
      break;
    }
    case 'new': await newChat(chat?.topic_id ?? null); break;
    case 'rename':
      if (!chat) break;
      if (arg) { setChat(await renameChatUndoable(chat, arg)); loadChats(); } else await renameThis();
      break;
    case 'title':
      if (!chat) break;
      setChat(await api.autoTitleChat(chat.id));
      loadChats();
      break;
    case 'delete': await deleteThis(); break;
    case 'todo':
      if (!arg) { card(<div className="msg-note small">Write the to-do after the command, e.g. /todo revise Snell's law</div>); break; }
      await api.addTodo(subject.id, { text: arg, topic_id: chat?.topic_id ?? null });
      card(<div className="msg-note small">✓ Added to your to-do list: {arg}</div>);
      break;
    case 'context': {
      const c = await ensureChat();
      const x = await api.chatContext(c.id);
      card(<div className="cmd-card"><div className="cmd-card-title">Context window</div>
        <div>{x.exact ? '' : '≈ '}{x.total.toLocaleString()} of {x.limit.toLocaleString()} tokens ({Math.round(100 * x.total / x.limit)}%)</div>
        <div className="muted small">Instructions ≈ {x.system.toLocaleString()} · material ≈ {x.material.toLocaleString()}
          {x.full_context ? '' : ' (excerpts are added to each question)'} · conversation ≈ {x.history.toLocaleString()}</div></div>);
      break;
    }
    case 'stop': if (chat && busy) stopReply(chat.id); break;
  }
}
