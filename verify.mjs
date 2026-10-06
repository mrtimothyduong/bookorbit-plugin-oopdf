/**
 * Exercises the plugin against pages saved from the live catalogue on 2026-10-06, so the HTML
 * reader is tested on the markup it actually has to survive rather than on fixtures written to
 * match it. That matters more here than usual: the site answers a real browser's session, a
 * challenge page to anything else, and a file URL that lives in a meta-refresh rather than where
 * its own form claims to point, and none of that is documented anywhere.
 *
 * Also exercises the FlareSolverr path offline, which is the whole point of the feature: a plain
 * fetch of the site is a "Just a moment" page, and the plugin's clearing route is to hand the
 * address to a solver and replay the cookies it earns.
 *
 * Run with: node verify.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import plugin from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

// A live search for one title answered with seven hits, one of which (Frankenstein) carries both
// an EPUB and a PDF form. The book page states the sizes, the identifiers, and the file host.
const SEARCH = fixture('search.html');
const BOOK = fixture('book-frankenstein.html');
const HOME = fixture('home.html');
const MINT = fixture('fetch-epub-response-body.txt');
const CHALLENGE =
  '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body></html>';

const res = (body, init = {}) => new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });

let pass = 0;
let fail = 0;
const ok = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
};

/**
 * Answers only the three addresses the plugin knows, and only for a session it recognises.
 * Two sessions are recognised, because the test that earns one (the solver section) and the
 * test that presumes one (every other) run in the same process, and the plugin remembers a
 * session per address rather than per search. Before any session is presented, every call is a
 * challenge, so a test that forgets one sees the failure.
 */
function answeredHostFetch(url, init) {
  const u = new URL(url);
  if (u.host === 'oceanofpdf.com') {
    const cookie = init?.headers?.Cookie ?? '';
    const authenticated = cookie.includes('cf_clearance=fixed-for-verify') || cookie.includes('cf_clearance=solved-by-solver');
    if (!authenticated) return res(CHALLENGE, { status: 403 });
    if (u.pathname === '/Fetching_Resource.php') return res(MINT);
    if (u.pathname.startsWith('/authors/')) return res(BOOK);
    return res(SEARCH);
  }
  return res('not found', { status: 404 });
}

function makeHost(fetchImpl, { capturedCredential } = {}) {
  const reqs = [];
  return {
    reqs,
    get calls() {
      return reqs.map((entry) => entry.url);
    },
    fetch: async (url, init) => {
      reqs.push({ url, init });
      return fetchImpl(url, init);
    },
    logger: { log: () => {}, warn: () => {} },
    // Mirrors server/src/modules/book-request/indexers/search-text.ts
    buildSearchText: (q) =>
      [q.title.replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s+/g, ' ').trim() || q.title, q.author]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    saveCredential: async (value) => {
      if (capturedCredential) capturedCredential.push(value);
    },
    fail: (code, message) => Object.assign(new Error(message), { code }),
  };
}

const cfg = (over = {}) => ({
  id: 5,
  name: 'Ocean of PDF',
  priority: 1,
  baseUrl: 'https://oceanofpdf.com',
  credential: null,
  allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [], comic: [] },
  seedRatioGoal: null,
  seedTimeMinutes: null,
  settings: {},
  ...over,
});
const query = (over = {}) => ({
  title: 'Frankenstein',
  author: 'Mary Shelley',
  isbn13: null,
  isbn13s: [],
  mediaKind: 'ebook',
  language: null,
  limit: 5,
  ...over,
});
// Runs the search through a session the plugin earned, over the fixture catalogue.
const session = { cookie: 'cf_clearance=fixed-for-verify; PHPSESSID=verify', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36' };
const search = (host, over = {}, config = cfg({ credential: JSON.stringify(session) })) =>
  plugin.search(query(over), config, host, AbortSignal.timeout(5000));

console.log('declaration');
{
  ok('targets the contract this build speaks', plugin.apiVersion === 1);
  ok('states a plain version', plugin.version === '1.0.0' && !plugin.version.startsWith('v'));
  ok('names the source', plugin.type === 'oceanofpdf' && plugin.label === 'Ocean of PDF');
  ok('needs no upstream credential but may hold a cleared session', plugin.requiresCredential === false && plugin.credentialKind === 'sessionId');
  ok('carries ebooks and nothing else', JSON.stringify(plugin.mediaKinds) === '["ebook"]');
  ok('joins no swarm and uses no categories', plugin.seedsBack === false && plugin.usesCategories === false);
  ok('offers a file-variant choice', JSON.stringify(plugin.settingsFields?.map((f) => f.key)) === '["fileVariant","flareSolverrUrl","flareSolverrToken"]');
  ok('offers the solver address', plugin.settingsFields?.[1]?.key === 'flareSolverrUrl');
}

console.log('search requests');
{
  const host = makeHost(answeredHostFetch);
  await search(host);
  const urls = host.calls;
  const searchUrls = urls.filter((c) => c.includes('/?s='));
  ok('searches the site', searchUrls.some((c) => c === 'https://oceanofpdf.com/?s=Frankenstein'), searchUrls[0]);
  ok('does not send the author with the search', searchUrls.every((c) => !c.toLowerCase().includes('shelley')));
  ok('confirms only a handful of the top hits', urls.filter((c) => c.includes('/authors/')).length <= 8);
  ok('mints a file for every confirmed hit', urls.filter((c) => c.includes('Fetching_Resource.php')).length === urls.filter((c) => c.includes('/authors/')).length);
}

console.log('reading the results');
{
  const host = makeHost(answeredHostFetch);
  const out = await search(host);
  ok('keeps only a handful of releases', out.length > 0 && out.length <= 5, out.length);
  const first = out[0];
  ok('points at the confirmed book page, not the search', typeof first.guid === 'string' && first.guid.includes('/authors/'), first.guid);
  ok('carries the format in the title a reader can see', /epub|pdf/i.test(first.title), first.title);
  ok('keeps the undecorated title for scoring', first.bookTitle === 'Frankenstein', first.bookTitle);
  ok('holds the signed file host URL', /https:\/\/fs\d+\.oceanofpdf\.com\/\S+?md5=\S+?expires=/.test(first.downloadUrl), first.downloadUrl);
  ok('states the size the page gives, in bytes', first.sizeBytes === 82e6, first.sizeBytes);
  ok('widens the ten-digits-and-a-dash ISBN to thirteen', first.isbn === '9780063452060', first.isbn);
  ok('leaves the author to the page', typeof first.author === 'string' && first.author.length > 0, first.author);
  ok('reports no swarm rather than zero', first.seeders === null && first.leechers === null);
  ok('is free in the sense the picker means and never a split set', first.freeleech === true && first.primaryFileCount === 1);
}
{
  const host = makeHost(answeredHostFetch);
  const out = await search(host, { limit: 2 });
  ok('asks for no more releases than the request wanted', out.length <= 2);
}
{
  // The same page carries a PDF form and an EPUB form; the choice is the reader's.
  const host = makeHost(answeredHostFetch);
  const out = await search(host, {}, cfg({ credential: JSON.stringify(session), settings: { fileVariant: 'pdf' } }));
  ok('points at the PDF upload when asked', out.every((r) => r.format === 'pdf'), out[0]?.format);
  ok('and its size, not the EPUB size', out.every((r) => r.sizeBytes === 82e6), out[0]?.sizeBytes);
}
{
  // A book page can carry no download form at all; that is not a worse choice, it is no choice.
  const host = makeHost((url, init) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/authors/') && !u.pathname.includes('pdf-epub-frankenstein-download/'))
      return res('<html><body>no download here</body></html>');
    return answeredHostFetch(url, init);
  });
  const out = await search(host);
  ok('drops hits that offer no file and keeps the ones that do', out.length === 1, out.length);
}

console.log('the challenge');
{
  // No solver configured: a challenge is a refusal, not "nothing found".
  const err = await plugin
    .search(query(), cfg({ credential: null }), makeHost(() => res(CHALLENGE, { status: 403 })), AbortSignal.timeout(5000))
    .catch((e) => e);
  ok('answers a challenge with no solver as unauthorized', err?.code === 'unauthorized', err?.code);
}

console.log('FlareSolverr, offline');
{
  const seen = [];
  const credentials = [];
  // The solver answers once with the session; thereafter the site admits the replayed cookies
  // directly, so the solver is called exactly once for the whole search.
  const fetchImpl = (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'solver.local' || u.port === '8181') {
      seen.push(url);
      return res(JSON.stringify({ success: true, solution: { status: 200, userAgent: 'Mozilla/5.0 (verify)', cookies: [{ name: 'cf_clearance', value: 'solved-by-solver' }] } }));
    }
    const sessionCookie = init?.headers?.Cookie ?? '';
    if (sessionCookie.includes('cf_clearance=solved-by-solver')) {
      if (u.pathname === '/Fetching_Resource.php') return res(MINT);
      if (u.pathname.startsWith('/authors/')) return res(BOOK);
      return res(SEARCH);
    }
    return res(CHALLENGE, { status: 403 });
  };
  const host = makeHost(fetchImpl, { capturedCredential: credentials });
  const out = await plugin.search(
    query(),
    cfg({ credential: null, settings: { flareSolverrUrl: 'https://solver.local:8181/v1' } }),
    host,
    AbortSignal.timeout(5000),
  );
  ok('uses the solver to get in', out.length > 0, out.length);
  ok('asks the solver only once for the whole search', seen.length === 1, seen.length);
  ok('remembers the session it was given', credentials.length === 1, credentials.length);
  const saved = JSON.parse(credentials[0]);
  ok('stores the cookies together with the user agent that earned them', saved.cookie.includes('cf_clearance=solved-by-solver') && saved.userAgent === 'Mozilla/5.0 (verify)');
  ok('does not call the solver again on the replayed session', host.calls.filter((c) => c.includes('solver.local')).length === 1);
}
{
  // A solver address that cannot be reached is said as unreachable, not read as refused.
  const err = await plugin
    .search(query(), cfg({ credential: null, settings: { flareSolverrUrl: 'https://solver.local:8181/v1' } }), makeHost((url) => {
      if (url.startsWith('https://solver.local:8181')) return Promise.reject(new Error('connect ECONNREFUSED'));
      return res(CHALLENGE, { status: 403 });
    }), AbortSignal.timeout(5000))
    .catch((e) => e);
  ok('reports a solver it cannot reach as unreachable', err.code === 'unreachable', err.code);
}
{
  // A solver that answers but earns no session has not got us through, and says so as an error.
  const err = await plugin
    .search(query(), cfg({ credential: null, settings: { flareSolverrUrl: 'https://solver.local:8181/v1' } }), makeHost((url) => {
      if (url.startsWith('https://solver.local:8181'))
        return res(JSON.stringify({ success: true, solution: { status: 200, cookies: [] } }));
      return res(CHALLENGE, { status: 403 });
    }), AbortSignal.timeout(5000))
    .catch((e) => e);
  ok('reports a solver that earned no session as an error', err.code === 'error', err.code);
}

console.log('failures');
{
  const err = await search(makeHost(() => res('', { status: 429 }))).catch((e) => e);
  ok('reports rate limiting as its own failure', err.code === 'throttled', err.message);
}
{
  const err = await search(makeHost(() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })))).catch((e) => e);
  ok('reports a timeout as a timeout', err.code === 'timeout', err.message);
}
{
  const err = await search(makeHost(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')))).catch((e) => e);
  ok('reports an unreachable source as unreachable', err.code === 'unreachable', err.message);
}
{
  const out = await search(makeHost(() => res('<html>not a catalogue</html>', { headers: { Cookie: session.cookie } })));
  ok('finds nothing in a page that is not the site', out.length === 0);
}

console.log('resolveFile()');
{
  const host = makeHost(answeredHostFetch);
  const [release] = await search(host);
  const before = host.calls.length;
  const file = await plugin.resolveFile(release, cfg({ credential: JSON.stringify(session) }), host, AbortSignal.timeout(5000));
  ok('reuses the file the search already minted, with no further request', host.calls.length === before);
  ok('names the file after the work', file.fileName === 'Frankenstein.epub', file.fileName);
  ok('carries the format and size through', file.format === 'epub' && file.sizeBytes === 82e6);
  ok('carries the session cookie for the download client', file.headers?.Cookie?.includes('cf_clearance=fixed-for-verify'), file.headers?.Cookie);
  ok('carries the user-agent that earned the session', file.headers?.['User-Agent']?.includes('Chrome'), file.headers?.['User-Agent']);
}
{
  // A solver-earned session reaches resolveFile too: the download client gets the same headers
  // the search path used.
  const solvedSession = { cookie: 'cf_clearance=solved-by-solver', userAgent: 'Mozilla/5.0 (verify)' };
  const host = makeHost(answeredHostFetch);
  const [release] = await plugin.search(query(), cfg({ credential: JSON.stringify(solvedSession) }), host, AbortSignal.timeout(5000));
  const file = await plugin.resolveFile(release, cfg({ credential: JSON.stringify(solvedSession) }), host, AbortSignal.timeout(5000));
  ok('passes the solver-earned cookie to the download client', file.headers?.Cookie?.includes('cf_clearance=solved-by-solver'), file.headers?.Cookie);
  ok('passes the solver-earned user-agent to the download client', file.headers?.['User-Agent'] === 'Mozilla/5.0 (verify)', file.headers?.['User-Agent']);
}
{
  // A release whose stored URL has lapsed, or carries none at all, is re-minted. The book path
  // travelled with it, so that re-read goes straight to the page rather than back through search.
  const host = makeHost(answeredHostFetch);
  const [fresh] = await search(host);
  const lapsed = { ...fresh, downloadUrl: undefined };
  const before = host.calls.length;
  const file = await plugin.resolveFile(lapsed, cfg({ credential: JSON.stringify(session) }), host, AbortSignal.timeout(5000));
  ok('re-mints a lapsed URL with a fresh request', host.calls.length > before);
  ok('and the fresh URL is signed again', /\.epub\?md5=.+expires=/.test(file.url), file.url);
}
{
  // A release with neither a URL nor its form survives only if the page still offers the file;
  // where the page offers nothing, resolve says so rather than returning an empty file.
  const pageWithout = res('<html><body><p>a landing page with no upload posted</p></body></html>');
  const host = makeHost((url) => {
    if (url === 'https://oceanofpdf.com/authors/x/pdf-epub-y-download/') return pageWithout;
    return answeredHostFetch(url, { headers: { Cookie: session.cookie } });
  });
  const err = await plugin
    .resolveFile({ guid: 'https://oceanofpdf.com/authors/x/pdf-epub-y-download/', title: 'Y', bookTitle: 'Y', downloadUrl: undefined, bookForm: undefined }, cfg({ credential: JSON.stringify(session) }), host, AbortSignal.timeout(5000))
    .catch((e) => e);
  ok('refuses a release that offers no file', err?.code === 'error', err?.message);
}

console.log('test()');
{
  const out = await plugin.test(cfg({ credential: JSON.stringify(session) }), makeHost(() => res(HOME)));
  ok('passes when the address answers with the site', out.success === true && out.indexerName === 'Ocean of PDF');
}
{
  const out = await plugin.test(cfg({ credential: JSON.stringify(session) }), makeHost(() => res('<html>hello</html>')));
  ok('fails when the address is not the site', out.success === false, out.error);
}
{
  const out = await plugin.test(cfg({ credential: null }), makeHost(() => Promise.reject(new Error('ENOTFOUND'))));
  ok('fails rather than throwing when unreachable', out.success === false, out.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);