/* Error codes on the front end. The backend answers every error as {detail, code, technical} and stores job errors as
   "plain message [APO-…]" (backend errors.py, docs/ERRORS.md). An ApiError keeps the code; `splitError` pulls it out of
   any text; components/ErrorText.tsx shows the message with the code as a link to its explanation. */

export const CODE_RE = /\s*\[?(APO-[A-Z]+-\d{3})\]?\s*/;

/** A failed request: the plain message, its code and the backend's short technical line. String(e) keeps the code
 * at the end ("… [APO-LLM-101]") so places that show the text as it is still show the code. */
export class ApiError extends Error {
  constructor(public detail: string, public code: string, public status: number, public technical = '') {
    super(`${detail} [${code}]`);
  }
}

/** The message and code in an error's text (either order: "msg [CODE]" or "[CODE] msg"). */
export function splitError(text: string): { message: string; code: string | null } {
  const t = text.replace(/^(Api)?Error: /, '');
  const m = t.match(CODE_RE);
  if (!m) return { message: t, code: null };
  return { message: t.replace(CODE_RE, ' ').replace(/\s{2,}/g, ' ').trim(), code: m[1] };
}

/** Any thrown value as display text ("Error: " dropped), code included. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return 'Apollo’s background service isn’t answering. Restart the app. [APO-APP-001]';
  return String(e instanceof Error ? e.message : e).replace(/^Error: /, '');
}

export interface ErrorEntry { code: string; title: string; plain: string; meaning: string; causes: string[]; fixes: string[]; status: number }
