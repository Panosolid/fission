// One way to make a request to a model: with a time limit, no cookies, no
// referrer, and errors in plain words that never contain the API key.

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** How long a model may take to answer: small local models on a CPU can take a minute or more. */
export const ANSWER_TIMEOUT_MS = 180_000;
/** How long a "is it there?" check may take (Ollama on this computer answers in milliseconds). */
export const CHECK_TIMEOUT_MS = 3_000;

export interface PostOptions {
  fetch: Fetch;
  url: string;
  headers?: Record<string, string>;
  /** JSON body; GET when absent. */
  body?: unknown;
  timeoutMs: number;
  /** Who is being asked, for messages: "Ollama at http://localhost:11434". */
  who: string;
  /** Removed from every message, in case a provider echoes it back. */
  secret?: string;
}

const hide = (text: string, secret?: string) => (secret ? text.split(secret).join("[your key]") : text);

/**
 * The parsed JSON reply, or a thrown Error saying what went wrong in plain
 * words. Gives up after `timeoutMs` (timed with setTimeout, so tests can
 * drive the clock).
 */
export async function requestJson(o: PostOptions): Promise<unknown> {
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, o.timeoutMs);
  try {
    let response: Response;
    try {
      response = await o.fetch(o.url, {
        method: o.body === undefined ? "GET" : "POST",
        headers: { ...(o.body === undefined ? {} : { "content-type": "application/json" }), ...o.headers },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: abort.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (e) {
      if (timedOut) throw new Error(`${o.who} didn't answer within ${Math.round(o.timeoutMs / 1000)} s`);
      throw new Error(hide(`couldn't reach ${o.who}: ${e instanceof Error ? e.message : String(e)}`, o.secret));
    }
    let text: string;
    try {
      text = await response.text();
    } catch (e) {
      if (timedOut) throw new Error(`${o.who} didn't answer within ${Math.round(o.timeoutMs / 1000)} s`);
      throw e;
    }
    if (!response.ok) throw new Error(hide(`${o.who} refused the request (HTTP ${response.status}): ${errorText(text)}`, o.secret));
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(hide(`${o.who} sent a reply that isn't JSON: ${text.slice(0, 80)}`, o.secret));
    }
  } finally {
    clearTimeout(timer);
  }
}

/** The provider's own error message when it sends one ({"error": {"message"}} or {"error": "…"}), else the start of the body. */
function errorText(body: string): string {
  try {
    const e = (JSON.parse(body) as { error?: unknown }).error;
    if (typeof e === "string") return e;
    if (e && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  } catch {
    // not JSON
  }
  return body.slice(0, 200) || "no details given";
}
