interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * JMA (Japan Meteorological Agency) MCP — keyless weather forecasts, warnings,
 * and earthquake data straight from www.jma.go.jp/bosai/.
 *
 * All data originates from the Japan Meteorological Agency's public bosai JSON
 * feeds (no API key, no registration). Forecast/warning labels are native
 * Japanese; this pack adds an English field wherever JMA itself publishes a
 * stable English name (area master list) or where we maintain a static
 * translation table for JMA's own fixed weather/warning code sets. Where no
 * stable mapping exists, only the Japanese text is returned rather than
 * guessing.
 *
 * Endpoints used (all under https://www.jma.go.jp/bosai/):
 * - common/const/area.json                    — office/region/city hierarchy
 * - forecast/data/forecast/<office>.json       — 3-day + weekly forecast
 * - warning/data/warning/<office>.json         — current warnings/advisories
 * - quake/data/list.json                       — recent earthquake bulletins
 *
 * Forecasts and warnings are published per forecast OFFICE (58 offices,
 * roughly one per prefecture plus Hokkaido/Okinawa subdivisions) — callers say
 * a place name ("Tokyo", "Sapporo"), not an office code, so every tool that
 * takes an `area` argument resolves it through the same place-name resolver
 * used by `jma_resolve_area`.
 */


const UA = 'pipeworx-mcp-jma/1.0 (+https://pipeworx.io)';
const BASE = 'https://www.jma.go.jp/bosai';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'JMA');
}

// ── Area master (office/region/city hierarchy) ─────────────────────────────
//
// area.json is ~260KB and changes essentially never (JMA's forecast area
// boundaries are a standing administrative structure). Cache it in module
// scope rather than refetching on every resolve — a cold Worker isolate pays
// one fetch, warm isolates pay none for 24h.

interface AreaEntry {
  name: string;
  enName: string;
  officeName?: string;
  parent?: string;
  children?: string[];
}
type AreaLevel = 'offices' | 'class10s' | 'class15s' | 'class20s';
interface AreaData {
  centers: Record<string, AreaEntry>;
  offices: Record<string, AreaEntry>;
  class10s: Record<string, AreaEntry>;
  class15s: Record<string, AreaEntry>;
  class20s: Record<string, AreaEntry>;
}

let areaCache: { data: AreaData; fetchedAt: number } | null = null;
const AREA_TTL_MS = 24 * 60 * 60 * 1000;

async function getAreaData(): Promise<AreaData> {
  if (areaCache && Date.now() - areaCache.fetchedAt < AREA_TTL_MS) return areaCache.data;
  const res = await pwFetch(`${BASE}/common/const/area.json`);
  if (!res.ok) throw await httpError(res, 'JMA area master');
  const data = await parseJson<AreaData>(res, 'JMA area master');
  areaCache = { data, fetchedAt: Date.now() };
  return data;
}

// class10.parent -> office code directly. class15.parent -> a class10 code.
// class20.parent -> a class15 code. A handful of small offices ARE their own
// class10 entry under the same numeric code (e.g. 011000 Soya) — walking by
// the level you actually matched at (never by "is this code globally unique")
// handles that edge case correctly, since offices/class10s/class15s/class20s
// are four separate namespaces that do overlap numerically.
function walkToOffice(data: AreaData, code: string, level: AreaLevel): string | null {
  if (level === 'offices') return data.offices[code] ? code : null;
  if (level === 'class10s') return data.class10s[code]?.parent ?? null;
  if (level === 'class15s') {
    const parent = data.class15s[code]?.parent;
    return parent ? walkToOffice(data, parent, 'class10s') : null;
  }
  if (level === 'class20s') {
    const parent = data.class20s[code]?.parent;
    return parent ? walkToOffice(data, parent, 'class15s') : null;
  }
  return null;
}

interface Candidate {
  code: string;
  level: AreaLevel;
  nameJa: string;
  nameEn: string;
}

interface AlternativeCandidate extends Candidate {
  office: string | null;
}

const LEVELS: AreaLevel[] = ['offices', 'class10s', 'class15s', 'class20s'];
const LEVEL_PRIORITY: Record<AreaLevel, number> = { offices: 0, class10s: 1, class15s: 2, class20s: 3 };
const SUFFIX_WORDS = ['prefecture', 'pref', 'city', 'town', 'village', 'ward', 'island', 'islands', 'region', 'district', 'area'];

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
function stripSuffixes(s: string): string {
  let out = normalize(s);
  for (const suf of SUFFIX_WORDS) out = out.replace(new RegExp(`\\b${suf}\\b`, 'g'), '');
  return out.replace(/\s+/g, ' ').trim();
}
function allCandidates(data: AreaData): Candidate[] {
  const out: Candidate[] = [];
  for (const level of LEVELS) {
    // Object.entries order is NOT source order for these keys: JS lists
    // canonical-integer-like keys first, numerically, so every leading-zero
    // code (all of Hokkaido and Tohoku, 01–09) is pushed behind every other
    // prefecture. That artifact decided same-name ties — sort by code so the
    // tie-break is deterministic JIS prefecture order instead.
    const entries = Object.entries(data[level]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    for (const [code, e] of entries) out.push({ code, level, nameJa: e.name, nameEn: e.enName });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** True if `needle` occurs in `haystack` as a whole alphanumeric word/phrase,
 * not merely as a letter sequence inside a longer word. Plain `.includes()`
 * false-positives constantly on romanized Japanese place names, where "date"
 * (伊達) is a common word-final syllable: "Hakodate", "Odate" and "Inakadate"
 * all contain the literal substring "date" with nothing to do with 伊達市. */
function wordBoundaryIncludes(needle: string, haystack: string): boolean {
  if (!needle) return false;
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`).test(haystack);
}

/** How strongly `query` (raw `trimmed`/`q`, and its suffix-stripped form `qStripped`)
 * identifies candidate `c`. Lower is stronger. `null` means "no match at all".
 *   0 — the candidate's name IS the query, verbatim (case-insensitive for English).
 *   1 — the query appears as a whole word/phrase inside the candidate's name
 *       (English, word-boundary aware) or the raw Japanese query is contained
 *       in the candidate's Japanese name.
 *   2 — matches only after both sides have generic suffixes ("City"/"Town"/
 *       "Ward"/…) stripped. This is the tier that let a bare town far away
 *       ("Yokohama Town", Aomori) outrank the real target: JMA splits several
 *       designated cities into wards or Northern/Southern halves with no
 *       plain "<City>" leaf of their own, so the leaf that most literally
 *       says the query's name may not be the prominent one.
 *   3 — loosest fallback: query is a raw substring of the candidate (or vice
 *       versa) with no word-boundary guarantee. Kept only so a genuinely
 *       partial/abbreviated query still resolves to *something*; excluded
 *       from `alternatives` display (see resolveArea) because it is exactly
 *       the tier that produces "Hakodate City" noise for a "Date" query. */
function matchTier(c: Candidate, q: string, qStripped: string, trimmed: string): 0 | 1 | 2 | 3 | null {
  const nameEn = normalize(c.nameEn);
  if (nameEn === q || c.nameJa === trimmed) return 0;
  if (wordBoundaryIncludes(q, nameEn) || (trimmed !== '' && c.nameJa.includes(trimmed))) return 1;
  if (stripSuffixes(c.nameEn) === qStripped) return 2;
  if ((q !== '' && nameEn.includes(q)) || (trimmed !== '' && c.nameJa !== '' && trimmed.includes(c.nameJa))) return 3;
  return null;
}

/** Resolve any of: a JMA area code (office/class10/class15/class20), an
 * English place name, or a Japanese place name, to a forecast/warning office
 * code. Matches offices themselves before regions before cities, so a broad
 * query like "Tokyo" lands on the Tokyo office rather than some sub-ward.
 *
 * Ranking is (match tier, level priority, area code) — HOW WELL the name
 * matches dominates, and only among equally-good matches does the broader
 * area win. Both signals matter, and their ORDER matters:
 *   - tier before level: "Iga" is a city in Mie whose name is also a loose
 *     substring of the office "Niigata". Level-first hands a caller asking
 *     for Iga a Niigata forecast 500km away, because an office outranks
 *     everything regardless of how badly it matches. Same shape for Kaga
 *     (Ishikawa) -> Kagawa, Oki (Shimane) -> Okinawa, Aki (Kochi) ->
 *     Nagasaki, "Ono City" (Fukui) -> Bungoono City (Oita).
 *   - level as the tie-break: "Yokohama" matches the region "Yokohama
 *     Kawasaki" and the unrelated leaf "Yokohama Town" in Aomori at the same
 *     tier, and the region — which is the actual Yokohama, since JMA splits
 *     designated cities into Northern/Southern halves with no plain
 *     "<City>" leaf — must win.
 * Measured over every one of the 2,217 English names in the area master:
 * querying an area by its own name returns that area 2,217/2,217 times
 * (2,038 before this ordering, 1,981 before the tier signal existed). */
function resolveArea(data: AreaData, query: string): { office: string; matched: Candidate; alternatives: AlternativeCandidate[] } | null {
  const trimmed = query.trim();
  if (/^\d{5,7}$/.test(trimmed)) {
    for (const level of LEVELS) {
      const e = data[level][trimmed];
      if (e) {
        const office = walkToOffice(data, trimmed, level);
        if (office) return { office, matched: { code: trimmed, level, nameJa: e.name, nameEn: e.enName }, alternatives: [] };
      }
    }
    return null;
  }

  const q = normalize(trimmed);
  const qStripped = stripSuffixes(trimmed);
  const cands = allCandidates(data);

  const scored: { candidate: Candidate; tier: 0 | 1 | 2 | 3 }[] = [];
  for (const c of cands) {
    const tier = matchTier(c, q, qStripped, trimmed);
    if (tier !== null) scored.push({ candidate: c, tier });
  }
  if (scored.length === 0) return null;

  // Array.prototype.sort is stable, so an equal (tier, level) pair falls
  // through to the candidate order set in allCandidates() — sorted by area
  // code, i.e. JIS prefecture order. Genuinely same-named places in different
  // prefectures (伊達市 in Hokkaido and Fukushima, 川崎町 in Miyagi and
  // Fukuoka) cannot be told apart from the query alone; the tie-break decides
  // one and `alternatives` carries the others WITH their office, which is the
  // part a caller can act on.
  scored.sort((a, b) => a.tier - b.tier || LEVEL_PRIORITY[a.candidate.level] - LEVEL_PRIORITY[b.candidate.level]);

  const best = scored[0].candidate;
  const office = walkToOffice(data, best.code, best.level);
  if (!office) return null;

  const rest = scored.slice(1);
  const withOffice = (s: { candidate: Candidate; tier: 0 | 1 | 2 | 3 }): AlternativeCandidate => ({
    ...s.candidate,
    office: walkToOffice(data, s.candidate.code, s.candidate.level),
  });
  // Only tier <=2 (word/suffix-level) matches are shown as alternatives — tier
  // 3's loose substring match is what produced "Hakodate City"/"Odate City"
  // noise for a "Date" query. Fall back to the raw top-5 if nothing else
  // matched at all, so alternatives never silently mask that the best match
  // itself was already a loose one.
  const strong = rest.filter((s) => s.tier <= 2).slice(0, 5).map(withOffice);
  const alternatives = strong.length > 0 ? strong : rest.slice(0, 5).map(withOffice);
  return { office, matched: best, alternatives };
}

async function requireOffice(area: string): Promise<{ officeCode: string; officeEntry: AreaEntry; matched: Candidate; alternatives: AlternativeCandidate[]; data: AreaData }> {
  const data = await getAreaData();
  const resolved = resolveArea(data, area);
  if (!resolved) {
    throw new Error(
      `No JMA forecast area matches "${area}". Try an English or Japanese place name ` +
        '(e.g. "Tokyo", "Sapporo", "Naha", "大阪") or a JMA area code from jma_resolve_area.',
    );
  }
  const officeEntry = data.offices[resolved.office];
  if (!officeEntry) throw new Error(`Resolved to office code ${resolved.office} but it is not a known forecast office.`);
  return { officeCode: resolved.office, officeEntry, matched: resolved.matched, alternatives: resolved.alternatives, data };
}

function nameForCode(data: AreaData, code: string): { nameJa: string; nameEn: string } | null {
  for (const level of LEVELS) {
    const e = data[level][code];
    if (e) return { nameJa: e.name, nameEn: e.enName };
  }
  return null;
}

// ── Weather code table (JMA's own fixed telop/weatherCode set) ─────────────
//
// These three-digit codes are a closed, JMA-published standard reused across
// every forecast office's JSON — the mapping below is a full static table,
// not a guess. `weathers[]` (the narrative Japanese sentence with time
// modifiers) is left untranslated: that free text is compositional in ways
// that risk a wrong nuance, where the fixed per-code label does not.
const WEATHER_CODE_EN: Record<string, string> = {
  '100': 'Clear', '101': 'Clear, occasionally cloudy', '102': 'Clear, temporarily rain',
  '103': 'Clear, occasionally rain', '104': 'Clear, temporarily snow', '105': 'Clear, occasionally snow',
  '106': 'Clear, temporarily rain or snow', '107': 'Clear, occasionally rain or snow',
  '108': 'Clear, temporarily rain or thunderstorms', '110': 'Clear, later occasionally cloudy',
  '111': 'Clear, later cloudy', '112': 'Clear, later temporarily rain', '113': 'Clear, later occasionally rain',
  '114': 'Clear, later rain', '115': 'Clear, later temporarily snow', '116': 'Clear, later occasionally snow',
  '117': 'Clear, later snow', '118': 'Clear, later rain or snow', '119': 'Clear, later rain or thunderstorms',
  '120': 'Clear, rain in the morning and evening', '121': 'Clear, temporarily rain in the morning',
  '122': 'Clear, temporarily rain in the evening', '123': 'Clear, thunderstorms near mountains',
  '124': 'Clear, snow near mountains', '125': 'Clear, thunderstorms in the afternoon',
  '126': 'Clear, rain from midday', '127': 'Clear, rain from evening', '128': 'Clear, rain at night',
  '130': 'Fog in the morning, later clear', '131': 'Clear, fog at dawn', '132': 'Clear, cloudy in the morning and evening',
  '140': 'Clear, occasionally rain with thunder', '160': 'Clear, temporarily rain or snow',
  '170': 'Clear, occasionally rain or snow', '181': 'Clear, later rain or snow',
  '200': 'Cloudy', '201': 'Cloudy, occasionally clear', '202': 'Cloudy, temporarily rain',
  '203': 'Cloudy, occasionally rain', '204': 'Cloudy, temporarily snow', '205': 'Cloudy, occasionally snow',
  '206': 'Cloudy, temporarily rain or snow', '207': 'Cloudy, occasionally rain or snow',
  '208': 'Cloudy, temporarily rain or thunderstorms', '209': 'Fog', '210': 'Cloudy, later occasionally clear',
  '211': 'Cloudy, later clear', '212': 'Cloudy, later temporarily rain', '213': 'Cloudy, later occasionally rain',
  '214': 'Cloudy, later rain', '215': 'Cloudy, later temporarily snow', '216': 'Cloudy, later occasionally snow',
  '217': 'Cloudy, later snow', '218': 'Cloudy, later rain or snow', '219': 'Cloudy, later rain or thunderstorms',
  '220': 'Cloudy, rain in the morning and evening', '221': 'Cloudy, temporarily rain in the morning',
  '222': 'Cloudy, temporarily rain in the evening', '223': 'Cloudy, occasionally clear during the day',
  '224': 'Cloudy, rain from midday', '225': 'Cloudy, rain from evening', '226': 'Cloudy, rain at night',
  '228': 'Cloudy, snow from midday', '229': 'Cloudy, snow from evening', '230': 'Cloudy, snow at night',
  '231': 'Cloudy, fog or drizzle near the coast', '240': 'Cloudy, occasionally rain with thunder',
  '250': 'Cloudy, occasionally snow with thunder', '260': 'Cloudy, temporarily snow or rain',
  '270': 'Cloudy, occasionally snow or rain', '281': 'Cloudy, later snow or rain',
  '300': 'Rain', '301': 'Rain, occasionally clear', '302': 'Rain, intermittent', '303': 'Rain, occasionally snow',
  '304': 'Rain or snow', '306': 'Heavy rain', '308': 'Rain with storm-force wind', '309': 'Rain, temporarily snow',
  '311': 'Rain, later clear', '313': 'Rain, later cloudy', '314': 'Rain, later occasionally snow',
  '315': 'Rain, later snow', '316': 'Rain or snow, later clear', '317': 'Rain or snow, later cloudy',
  '320': 'Rain in the morning, later clear', '321': 'Rain in the morning, later cloudy',
  '322': 'Rain, temporarily snow in the morning and evening', '323': 'Rain, clear from midday',
  '324': 'Rain, clear from evening', '325': 'Rain, clear at night', '326': 'Rain, snow from evening',
  '327': 'Rain, snow at night', '328': 'Rain, temporarily heavy', '329': 'Rain, temporarily sleet',
  '340': 'Snow or rain', '350': 'Rain with thunder', '361': 'Snow or rain, later clear',
  '371': 'Snow or rain, later cloudy', '400': 'Snow', '401': 'Snow, occasionally clear',
  '402': 'Snow, intermittent', '403': 'Snow, occasionally rain', '405': 'Heavy snow',
  '406': 'Strong wind and snow', '407': 'Snowstorm', '409': 'Snow, temporarily rain',
  '411': 'Snow, later clear', '413': 'Snow, later cloudy', '414': 'Snow, later rain',
  '420': 'Snow in the morning, later clear', '421': 'Snow in the morning, later cloudy',
  '422': 'Snow, rain from midday', '423': 'Snow, rain from evening', '425': 'Snow, temporarily heavy',
  '426': 'Snow, later sleet', '427': 'Snow, temporarily sleet', '450': 'Snow with thunder',
};
function weatherCodeEn(code: string | undefined): string | null {
  if (!code) return null;
  return WEATHER_CODE_EN[code] ?? null;
}

// ── Warning/advisory code table ─────────────────────────────────────────────
const WARNING_CODE: Record<string, { ja: string; en: string }> = {
  '02': { ja: '暴風雪警報', en: 'Snowstorm Warning' },
  '03': { ja: '大雨警報', en: 'Heavy Rain Warning' },
  '04': { ja: '洪水警報', en: 'Flood Warning' },
  '05': { ja: '暴風警報', en: 'Storm Warning' },
  '06': { ja: '大雪警報', en: 'Heavy Snow Warning' },
  '07': { ja: '波浪警報', en: 'Wave Warning' },
  '08': { ja: '高潮警報', en: 'Storm Surge Warning' },
  '09': { ja: '土砂災害警報', en: 'Landslide Warning' },
  '10': { ja: '大雨注意報', en: 'Heavy Rain Advisory' },
  '12': { ja: '大雪注意報', en: 'Heavy Snow Advisory' },
  '13': { ja: '風雪注意報', en: 'Wind and Snow Advisory' },
  '14': { ja: '雷注意報', en: 'Thunderstorm Advisory' },
  '15': { ja: '強風注意報', en: 'Strong Wind Advisory' },
  '16': { ja: '波浪注意報', en: 'Wave Advisory' },
  '17': { ja: '融雪注意報', en: 'Snowmelt Advisory' },
  '18': { ja: '洪水注意報', en: 'Flood Advisory' },
  '19': { ja: '高潮注意報', en: 'Storm Surge Advisory' },
  '20': { ja: '濃霧注意報', en: 'Dense Fog Advisory' },
  '21': { ja: '乾燥注意報', en: 'Dry Air Advisory' },
  '22': { ja: 'なだれ注意報', en: 'Avalanche Advisory' },
  '23': { ja: '低温注意報', en: 'Low Temperature Advisory' },
  '24': { ja: '霜注意報', en: 'Frost Advisory' },
  '25': { ja: '着氷注意報', en: 'Ice Accretion Advisory' },
  '26': { ja: '着雪注意報', en: 'Snow Accretion Advisory' },
  '29': { ja: '土砂災害注意報', en: 'Landslide Advisory' },
  '32': { ja: '暴風雪特別警報', en: 'Snowstorm Special Warning' },
  '33': { ja: '大雨特別警報', en: 'Heavy Rain Special Warning' },
  '35': { ja: '暴風特別警報', en: 'Storm Special Warning' },
  '36': { ja: '大雪特別警報', en: 'Heavy Snow Special Warning' },
  '37': { ja: '波浪特別警報', en: 'Wave Special Warning' },
  '38': { ja: '高潮特別警報', en: 'Storm Surge Special Warning' },
  '39': { ja: '土砂災害特別警報', en: 'Landslide Special Warning' },
  '43': { ja: '大雨危険警報', en: 'Heavy Rain Emergency Warning' },
  '48': { ja: '高潮危険警報', en: 'Storm Surge Emergency Warning' },
  '49': { ja: '土砂災害危険警報', en: 'Landslide Emergency Warning' },
};
const WARNING_STATUS_EN: Record<string, string> = {
  '発表警報・注意報はなし': 'No warnings or advisories in effect',
  '継続': 'Continuing',
  '発表': 'Issued',
  '解除': 'Lifted',
  '警報から注意報へ切り替え': 'Downgraded from warning to advisory',
  '注意報から警報へ切り替え': 'Upgraded from advisory to warning',
};

// ── Seismic intensity scale (震度) ──────────────────────────────────
const INTENSITY_EN: Record<string, string> = {
  '1': '1', '2': '2', '3': '3', '4': '4',
  '5-': '5 Lower', '5+': '5 Upper', '6-': '6 Lower', '6+': '6 Upper', '7': '7',
};

// ── Tools ────────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'jma_resolve_area',
    description:
      'Resolve a Japanese place name (English romaji or Japanese, e.g. "Tokyo", "Sapporo", "大阪") or a JMA area code to the JMA forecast OFFICE code used by jma_forecast and jma_warnings. Sourced from the Japan Meteorological Agency (JMA) area master list (www.jma.go.jp/bosai/common/const/area.json), which covers all 58 forecast offices plus every prefecture, region, city, ward and town JMA itself names in English. Use this when you need the raw office code, or just pass the place name straight into jma_forecast / jma_warnings — they resolve internally.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Place name (English or Japanese) or JMA area code, e.g. "Tokyo", "Naha", "130000".' },
      },
      required: ['query'],
    },
  },
  {
    name: 'jma_forecast',
    description:
      'Weather forecast for a Japanese region from the Japan Meteorological Agency (JMA), covering a 3-day short-term outlook (weather, precipitation probability, temperature per sub-area) and a 7-day weekly outlook (weather, precipitation probability, reliability, min/max temperature with confidence range). Sourced from www.jma.go.jp/bosai/forecast/data/forecast/<office>.json. Accepts a place name in English or Japanese ("Tokyo", "Sapporo", "大阪") or a JMA office code directly — resolved the same way as jma_resolve_area. Weather text is native Japanese; an English gloss is included for JMA\'s fixed weatherCode set (weatherEn), derived from a static translation table, not machine-translated on the fly.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Place name or JMA area/office code, e.g. "Tokyo", "Fukuoka", "130000".' },
      },
      required: ['area'],
    },
  },
  {
    name: 'jma_warnings',
    description:
      'Current weather warnings and advisories (警報・注意報) for a Japanese region, from the Japan Meteorological Agency (JMA). Returns the headline bulletin plus per-area status (issued / continuing / lifted / no warnings in effect) for every warning/advisory category JMA tracks (heavy rain, storm, flood, wave, storm surge, dense fog, thunderstorm, avalanche, frost, etc.), at both the sub-prefecture and municipality level. Sourced from www.jma.go.jp/bosai/warning/data/warning/<office>.json. Accepts a place name (English or Japanese) or a JMA office code, resolved the same way as jma_resolve_area. Category and status names are native Japanese with an English gloss from JMA\'s fixed warning-code table.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Place name or JMA area/office code, e.g. "Osaka", "東京", "130000".' },
      },
      required: ['area'],
    },
  },
  {
    name: 'jma_earthquakes',
    description:
      'Recent earthquakes reported by the Japan Meteorological Agency (JMA), including magnitude, maximum seismic intensity (震度, JMA\'s 10-step scale: 1-4, 5 Lower, 5 Upper, 6 Lower, 6 Upper, 7), epicenter (Japanese + English where JMA publishes one), and report time. Sourced from www.jma.go.jp/bosai/quake/data/list.json, which JMA keeps as a rolling feed (typically the last few weeks of bulletins, newest first). Filter by minimum magnitude or minimum intensity to cut noise from the very small, frequent events JMA also reports.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max events to return (default 20, max 200).' },
        min_magnitude: { type: 'number', description: 'Only events with magnitude >= this value.' },
        min_intensity: {
          type: 'string',
          description: 'Only events whose max reported intensity is at least this JMA scale value: "1","2","3","4","5-","5+","6-","6+","7" (5- = 5 Lower, 5+ = 5 Upper, etc.).',
        },
      },
    },
  },
];

// ── Implementations ──────────────────────────────────────────────────────

function candidateOut(c: Candidate) {
  return { code: c.code, level: c.level, name_ja: c.nameJa, name_en: c.nameEn };
}
/** Alternatives carry the OFFICE (prefecture-equivalent) each one resolves to,
 * not just the candidate's own name — that's the only way a caller (human or
 * LLM) can actually tell "Yokohama Town, alternative in Aomori" apart from
 * "Southern Yokohama City, alternative in the same Kanagawa match" without a
 * second round-trip. A non-empty `alternatives` is meaningful precisely
 * because it can now name a genuinely different prefecture. */
function alternativeOut(c: AlternativeCandidate, data: AreaData) {
  const officeEntry = c.office ? data.offices[c.office] : undefined;
  return {
    ...candidateOut(c),
    office: c.office ? { code: c.office, name_ja: officeEntry?.name ?? null, name_en: officeEntry?.enName ?? null } : null,
  };
}

async function resolveAreaTool(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'query is required' };
  const data = await getAreaData();
  const resolved = resolveArea(data, query);
  if (!resolved) {
    return {
      error: `No JMA area matches "${query}".`,
      hint: 'Try an English or Japanese place name (e.g. "Tokyo", "Sapporo", "大阪") or a 5-7 digit JMA area code.',
    };
  }
  const office = data.offices[resolved.office];
  return {
    query,
    matched: candidateOut(resolved.matched),
    office: {
      code: resolved.office,
      name_ja: office?.name,
      name_en: office?.enName,
      office_name_ja: office?.officeName,
    },
    alternatives: resolved.alternatives.map((c) => alternativeOut(c, data)),
    source: 'JMA area master list (www.jma.go.jp/bosai/common/const/area.json)',
  };
}

async function forecastTool(args: Record<string, unknown>) {
  const area = String(args.area ?? '').trim();
  if (!area) return { error: 'area is required' };
  const { officeCode, officeEntry, matched, data } = await requireOffice(area);

  const res = await pwFetch(`${BASE}/forecast/data/forecast/${officeCode}.json`);
  if (!res.ok) throw await httpError(res, 'JMA forecast');
  const payload = await parseJson<any[]>(res, 'JMA forecast');
  const shortTerm = payload[0];
  const weekly = payload[1];

  const resolvedOffice = {
    code: officeCode,
    name_ja: officeEntry.name,
    name_en: officeEntry.enName,
    matched_query: `${matched.nameEn} (${matched.nameJa})`,
  };

  function nameOf(areaCode: string) {
    return nameForCode(data, areaCode) ?? { nameJa: areaCode, nameEn: null };
  }

  const shortTermWeather = (shortTerm?.timeSeries ?? [])[0];
  const shortTermPop = (shortTerm?.timeSeries ?? [])[1];
  const shortTermTemp = (shortTerm?.timeSeries ?? [])[2];

  const short_term = (shortTermWeather?.areas ?? []).map((a: any) => {
    const n = nameOf(a.area.code);
    return {
      area: { code: a.area.code, name_ja: n.nameJa, name_en: n.nameEn },
      periods: (shortTermWeather.timeDefines ?? []).map((t: string, i: number) => ({
        time: t,
        weather_ja: a.weathers?.[i] ?? null,
        weather_code: a.weatherCodes?.[i] ?? null,
        weather_en: weatherCodeEn(a.weatherCodes?.[i]),
        wind: a.winds?.[i] ?? null,
        wave: a.waves?.[i] ?? null,
      })),
    };
  });

  const precipitation_probability = (shortTermPop?.areas ?? []).map((a: any) => {
    const n = nameOf(a.area.code);
    return {
      area: { code: a.area.code, name_ja: n.nameJa, name_en: n.nameEn },
      entries: (shortTermPop.timeDefines ?? []).map((t: string, i: number) => ({ time: t, pop_percent: a.pops?.[i] ?? null })),
    };
  });

  const temperature = (shortTermTemp?.areas ?? []).map((a: any) => {
    const n = nameOf(a.area.code);
    return {
      area: { code: a.area.code, name_ja: n.nameJa, name_en: n.nameEn },
      entries: (shortTermTemp.timeDefines ?? []).map((t: string, i: number) => ({ time: t, temp_c: a.temps?.[i] ?? null })),
    };
  });

  const weeklyWeather = (weekly?.timeSeries ?? [])[0];
  const weeklyTemp = (weekly?.timeSeries ?? [])[1];

  const weekly_forecast = (weeklyWeather?.areas ?? []).map((a: any) => {
    const n = nameOf(a.area.code);
    return {
      area: { code: a.area.code, name_ja: n.nameJa, name_en: n.nameEn },
      entries: (weeklyWeather.timeDefines ?? []).map((t: string, i: number) => ({
        date: t,
        weather_code: a.weatherCodes?.[i] ?? null,
        weather_en: weatherCodeEn(a.weatherCodes?.[i]),
        pop_percent: a.pops?.[i] ?? null,
        reliability: a.reliabilities?.[i] ?? null,
      })),
    };
  });

  const weekly_temperature = (weeklyTemp?.areas ?? []).map((a: any) => {
    const n = nameOf(a.area.code);
    return {
      area: { code: a.area.code, name_ja: n.nameJa, name_en: n.nameEn },
      entries: (weeklyTemp.timeDefines ?? []).map((t: string, i: number) => ({
        date: t,
        min_c: a.tempsMin?.[i] || null,
        min_c_range: [a.tempsMinLower?.[i] || null, a.tempsMinUpper?.[i] || null],
        max_c: a.tempsMax?.[i] || null,
        max_c_range: [a.tempsMaxLower?.[i] || null, a.tempsMaxUpper?.[i] || null],
      })),
    };
  });

  return {
    resolved_office: resolvedOffice,
    report_datetime: shortTerm?.reportDatetime ?? null,
    publishing_office_ja: shortTerm?.publishingOffice ?? null,
    short_term,
    precipitation_probability,
    temperature,
    weekly_report_datetime: weekly?.reportDatetime ?? null,
    weekly_forecast,
    weekly_temperature,
    source: `JMA (www.jma.go.jp/bosai/forecast/data/forecast/${officeCode}.json)`,
  };
}

async function warningsTool(args: Record<string, unknown>) {
  const area = String(args.area ?? '').trim();
  if (!area) return { error: 'area is required' };
  const { officeCode, officeEntry, matched, data } = await requireOffice(area);

  const res = await pwFetch(`${BASE}/warning/data/warning/${officeCode}.json`);
  if (!res.ok) throw await httpError(res, 'JMA warnings');
  const payload = await parseJson<any>(res, 'JMA warnings');

  function nameOf(areaCode: string) {
    return nameForCode(data, areaCode) ?? { nameJa: areaCode, nameEn: null };
  }

  const areaTypes = (payload.areaTypes ?? []).map((group: any) => ({
    areas: (group.areas ?? []).map((a: any) => {
      const n = nameOf(a.code);
      return {
        code: a.code,
        name_ja: n.nameJa,
        name_en: n.nameEn,
        warnings: (a.warnings ?? []).map((w: any) => {
          const kind = w.code ? WARNING_CODE[w.code] : null;
          return {
            code: w.code ?? null,
            name_ja: kind?.ja ?? null,
            name_en: kind?.en ?? null,
            status_ja: w.status ?? null,
            status_en: w.status ? (WARNING_STATUS_EN[w.status] ?? null) : null,
          };
        }),
      };
    }),
  }));

  return {
    resolved_office: {
      code: officeCode,
      name_ja: officeEntry.name,
      name_en: officeEntry.enName,
      matched_query: `${matched.nameEn} (${matched.nameJa})`,
    },
    report_datetime: payload.reportDatetime ?? null,
    publishing_office_ja: payload.publishingOffice ?? null,
    headline_ja: payload.headlineText || null,
    area_groups: areaTypes,
    source: `JMA (www.jma.go.jp/bosai/warning/data/warning/${officeCode}.json)`,
  };
}

async function earthquakesTool(args: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
  const minMag = args.min_magnitude !== undefined ? Number(args.min_magnitude) : null;
  const minIntensity = args.min_intensity !== undefined ? String(args.min_intensity) : null;

  const res = await pwFetch(`${BASE}/quake/data/list.json`);
  if (!res.ok) throw await httpError(res, 'JMA earthquake list');
  const payload = await parseJson<any[]>(res, 'JMA earthquake list');

  // JMA's own scale, in ascending severity order — used to compare min_intensity.
  const SCALE_ORDER = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];
  const scaleRank = (v: string | undefined) => (v ? SCALE_ORDER.indexOf(v) : -1);
  const minRank = minIntensity ? scaleRank(minIntensity) : -1;

  const events = payload
    .filter((e) => (minMag === null ? true : e.mag && !Number.isNaN(Number(e.mag)) && Number(e.mag) >= minMag))
    .filter((e) => (minRank < 0 ? true : scaleRank(e.maxi) >= minRank))
    .slice(0, limit)
    .map((e) => ({
      event_id: e.eid ?? null,
      info_type_ja: e.ttl ?? null,
      info_type_en: e.en_ttl ?? null,
      reported_at: e.rdt ?? null,
      occurred_at: e.at ?? null,
      epicenter_ja: e.anm ?? null,
      epicenter_en: e.en_anm ?? null,
      magnitude: e.mag && e.mag !== '' ? Number(e.mag) : null,
      max_intensity: e.maxi || null,
      max_intensity_en: e.maxi ? (INTENSITY_EN[e.maxi] ?? e.maxi) : null,
      areas_affected: (e.int ?? []).map((i: any) => ({
        area_code: i.code,
        max_intensity: i.maxi || null,
        max_intensity_en: i.maxi ? (INTENSITY_EN[i.maxi] ?? i.maxi) : null,
        city_count: (i.city ?? []).length,
      })),
      detail_url: e.json ? `${BASE}/quake/data/${e.json}` : null,
    }));

  return {
    count: events.length,
    total_available: payload.length,
    events,
    source: 'JMA (www.jma.go.jp/bosai/quake/data/list.json)',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'jma_resolve_area':
        return await resolveAreaTool(args);
      case 'jma_forecast':
        return await forecastTool(args);
      case 'jma_warnings':
        return await warningsTool(args);
      case 'jma_earthquakes':
        return await earthquakesTool(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
