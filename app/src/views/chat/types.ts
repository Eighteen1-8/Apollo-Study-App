/* Shared by the chat's parts. */
export const TERMINAL = ['ready', 'failed', 'cancelled'];
export const LEVEL_LABEL: Record<string, string> = { off: 'Off', low: 'Low', medium: 'Medium', xhigh: 'XHigh' };
/** How the chat sits in the centre: a floating window in a corner, half the centre beside what's open, or all of it. */
export type ChatMode = 'float' | 'split' | 'full';
