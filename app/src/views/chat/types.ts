/* Shared by the chat's parts. */
export const TERMINAL = ['ready', 'failed', 'cancelled'];
/** Reasoning level names in the current mode (plain or technical, terms.ts). */
export { levelLabel } from '../../terms';
/** How the chat sits in the centre: a floating window in a corner, half the centre beside what's open, or all of it. */
export type ChatMode = 'float' | 'split' | 'full';
