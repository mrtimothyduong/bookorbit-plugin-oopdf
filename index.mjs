/**
 * Ocean of PDF as a BookOrbit indexer plugin.
 *
 * An unlicensed ebook catalogue: tens of thousands of commercially published books, uploaded in
 * response to requests. The Authors Guild calls it one of the most notorious ebook piracy sites.
 * Running it is a deliberate choice about your own address, like Gutenberg's.
 *
 * What the source expects of a client:
 *
 *   The whole site sits behind a Cloudflare JavaScript challenge. A plain fetch of any page,
 *   including the search form, answers 403 with a "Just a moment" interstitial. The expected way
 *   in is a real browser that solves the challenge and earns a `cf_clearance` cookie, which a
 *   normal HTTP client can then replay. Where no browser is on hand, FlareSolverr provides one:
 *   this plugin can point at a solver URL, ask it to open the site, and keep the cookies the
 *   solver earned, refreshing them when the site starts serving the challenge again. Without a
 *   configured solver, answers that are only a challenge are reported as refused rather than
 *   read as "no results".
 *
 *   Nothing is documented. There is no search API and robots.txt is itself behind the challenge.
 *   The working surface, confirmed 2026-10-06, is:
 *
 *   • Search is WordPress' own, GET `/?s=TITLE` answering paginated HTML, one `<article>` per hit,
 *     the hit's link in `a.entry-title-link` and author and language in a `div.postmetainfo`.
 *   • A book page (URL pattern `/authors/<slug>/pdf-epub-<title>-download/`) lists the book's own
 *     fields — name, author, language, ISBN, per-format size — in labelled `<li>` rows, and, per
 *     format, carries one form posting `{id, filename}` to `Fetching_Resource.php`. The page also
 *     carries navigation lists, so the details are read wherever labelled rows live, not from a
 *     fixed position in the markup.
 *   • That POST answers 200 with an interactive form auto-submitted to a parked domain AND a
 *     meta-refresh to the file: `<meta http-equiv="Refresh" content="5;url=https://fsN.oceanofpdf.com/FILE?md5=…&expires=…"/>`.
 *     The file is the Refresh target, never the form action. The signed URL carries an expiry
 *     stamp in unix seconds.
 *   • The file host answers a plain GET with the file when the request comes from an ordinary
 *     address; it runs its own challenge against datacenter traffic. The signed URL needs no
 *     cookie, so the download client takes it straight.
 *
 *   The site states no rate limit, so this plugin takes the conservative reading of its own
 *   practice: one search page per search, a small handful of books confirmed per search, and no
 *   retry of a request the site throttled.
 *
 * Dependency free and single file on purpose. A plugin runs inside the BookOrbit process with
 * that process's access, so it has to be something a person can read start to finish before
 * trusting it.
 */

/** Cap on how many book pages one search confirms. Each confirmation costs two requests. */
const MAX_RESULTS = 5;

/**
 * How many of the site's own top hits get confirmed. The site answers many near-misses per
 * spelling — a search for one title comes back with its sequels and retellings — so name a wider
 * field and let the confirmations drop the ones that offer no file.
 */
const NAME_CAP = 8;

/** How many book pages may be in flight. The site answers a slow search, not a burst. */
const MAX_CONCURRENT = 2;

/** Named rather than left to Node, which announces itself as `node`. */
const USER_AGENT = 'BookOrbit';

/** Human-readable sizes the book page states, as in "82 MB". */
const SIZE_UNITS = { kB: 1e3, KB: 1e3, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824 };

/**
 * The file host URL, wherever the Refresh tag hides it. The match must end where the URL ends,
 * so the character class stops short of whitespace and every quote: a URL with query survives,
 * and the tag around it does not leak in.
 */
const FILE_URL = /url=(https:\/\/[^\s"']*)/;

/** What a release title says about the file it carries. */
const FORMAT_SUBLABEL = { epub: 'epub', pdf: 'PDF' };

/** Where a decorated request title stops being the work's own name. */
const TITLE_SEPARATOR = /[:;,]\s|\s-\s/;

/**
 * The site names languages by mouth, and the list is deliberately narrow: a language this plugin
 * does not know is left unstated rather than guessed, because the state the request matches on is
 * the language the reader asked for, and a wrong stamp is worse than none.
 */
const LANGUAGE_BY_NAME = {
  arabic: 'ar',
  chinese: 'zh',
  czech: 'cs',
  dutch: 'nl',
  english: 'en',
  french: 'fr',
  german: 'de',
  hindi: 'hi',
  hungarian: 'hu',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  norwegian: 'no',
  polish: 'pl',
  portuguese: 'pt',
  russian: 'ru',
  spanish: 'es',
  swedish: 'sv',
  turkish: 'tr',
};

export default {
  apiVersion: 1,
  version: '1.0.0',
  type: 'oceanofpdf',
  label: 'Ocean of PDF',
  requiresCredential: false,
  // The clearance the solver earns is a session, and it lives in the credential slot, which is
  // the only place it survives a restart. Not every configuration needs one: a browser already
  // through the challenge needs nothing, and neither does a site that is not challenged.
  credentialKind: 'sessionId',
  mediaKinds: ['ebook'],
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: 'https://oceanofpdf.com',
  baseUrlHint: "Ocean of PDF's own address. Leave it as https://oceanofpdf.com unless you run a mirror.",
  // No signed update channel: the signing key lives outside the repositories this plugin ships in.
  settingsFields: [
    {
      key: 'fileVariant',
      type: 'string',
      label: 'File variant',
      hint: 'Which upload a release points at: epub or pdf. EPUB suits the ebook importer; PDF where a fixed layout is wanted. Where a title carries only one format, that is what you get.',
      default: 'epub',
    },
    {
      key: 'flareSolverrUrl',
      type: 'string',
      label: 'FlareSolverr URL',
      hint: 'A FlareSolverr /v1 endpoint, as reachable from BookOrbit. Where empty, the site answers only a Cloudflare challenge and the indexer reports refused.',
      default: '',
    },
    {
      key: 'flareSolverrToken',
      type: 'string',
      label: 'FlareSolverr token',
      hint: 'The token a protected solver expects in the Authorization header. Leave empty where it has none.',
      default: '',
    },
  ],

  /**
   * Search is one page, one spelling at a time.
   *
   * The plain title leads because the site matches loose and the request title is what it stores.
   * A shortened form follows as a deliberate broadening: a title decorated with an edition
   * qualifier or a subtitle finds nothing under its full name and plenty under the work's own
   * part. Only a miss costs the extra request, and the author is not sent with either, because
   * this site ANDs its terms and answers a pairing it does not hold with nothing: the author is
   * the scorer's weight, not the search's.
   */
  async search(query, config, host, signal) {
    const limit = Math.min(query.limit, MAX_RESULTS);

    for (const title of searchTitles(query.title)) {
      if (signal.aborted) break;

      let named = [];
      try {
        named = articlesOf(await call(config, host, `/`, { s: title }));
      } catch (error) {
        // A challenge the solver could not clear, a throttle, a deadline: each of these is not
        // "nothing found", so it is reported rather than read.
        if (isFailure(error)) throw error;
        continue;
      }
      if (named.length === 0) continue;

      const releases = [];
      const failures = [];
      const queue = named.slice(0, NAME_CAP);
      const workers = [];
      const worker = async () => {
        for (;;) {
          if (signal.aborted || releases.length >= limit) break;
          const next = queue.shift();
          if (next === undefined) break;
          const release = await bookToRelease(next, config, host, signal).catch((error) => {
            // A dead file is dropped with the rest; a challenge, a throttle, a deadline is not
            // one file, it is the site, and it says so for the whole search.
            if (isFailure(error)) failures.push(error);
            return null;
          });
          if (!release) continue;
          // The check must sit in the same synchronous block as the push, or a second worker
          // that was already admitted can overshoot the limit.
          if (releases.length >= limit) break;
          releases.push(release);
        }
      };
      for (let i = 0; i < Math.min(MAX_CONCURRENT, queue.length); i++) workers.push(worker());
      await Promise.all(workers);
      if (failures.length > 0) throw failures[0];
      if (releases.length === 0) continue;

      // Workers drain a shared queue, so completion order is arbitrary; the site's own order is a
      // better starting point for scoring to work from.
      return releases.sort(
        (a, b) => named.findIndex((n) => n.bookUrl === a.guid) - named.findIndex((n) => n.bookUrl === b.guid),
      );
    }

    return [];
  },

  /**
   * Asked without a title, so the check does not depend on any one book still being catalogued.
   * The homepage answers with a search form, which is as close to a named service as this site
   * comes.
   */
  async test(config, host) {
    try {
      const html = await call(config, host, `/`);
      if (!/name="s"/.test(html) || !/[Oo]cean/.test(html)) {
        return { success: false, error: 'answered, but that address does not look like Ocean of PDF' };
      }
      return { success: true, indexerName: 'Ocean of PDF' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * The file URL was minted during the search, so the ordinary case costs no further request.
   * A minted URL can outlive its stamp between search and grab: the site is then asked for a
   * fresh one, and the form to ask with travelled with the release.
   */
  async resolveFile(release, config, host) {
    let file = release;

    // The URL a search minted carries an expiry stamp. Where the stamp has passed or is absent
    // entirely, the site is asked for a fresh one with the form that travelled with the release.
    const stamped =
      typeof release.downloadUrl === 'string' && /md5=/.test(release.downloadUrl) && /expires=/.test(release.downloadUrl);
    if (!stamped) {
      file = await refreshFile(release, config, host);
    }

    if (!file.downloadUrl) {
      throw host.fail('error', `has stopped offering a file for "${release.title}". Pick another release.`);
    }
    const variant = file.variant ?? release.variant ?? 'epub';

    // The file host sits behind the same Cloudflare challenge as the search site, and the signed
    // URL the download client takes needs no cookie to authorise the file — but the challenge
    // gates the host itself. The cf_clearance cookie this plugin earned (scoped to
    // .oceanofpdf.com, all subdomains) and the User-Agent that earned it must travel with the
    // download, or the file host answers the bare request with 403.
    const session = readSession(config.credential) ?? sessionByAddress.get(config.baseUrl) ?? null;
    const headers = {};
    if (session?.cookie) headers['Cookie'] = session.cookie;
    if (session?.userAgent) headers['User-Agent'] = session.userAgent;

    return {
      url: file.downloadUrl,
      fileName: `${sanitizeName(release.bookTitle ?? release.title)}.${variant}`,
      sizeBytes: file.sizeBytes ?? release.sizeBytes,
      format: variant,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  },
};

/* ------------------------------------------------------------------------ */
/* Searching and naming.                                                     */
/* ------------------------------------------------------------------------ */

/** A failure is worth stopping for and reporting: a challenge that cannot be cleared, a site
 * limiting us, a deadline passed. One of these is not "nothing found", and it is said once, for
 * the whole search, rather than per result.
 */
function isFailure(error) {
  return error instanceof Error && typeof (error.failure ?? error.code) === 'string';
}

/** What the site says is being searched, in the order the site would answer it. */
function searchTitles(rawTitle) {
  const base = stripEditionQualifiers(rawTitle);
  return [...new Set([base, untilFirstSeparator(base)])].filter((title) => title.length > 0);
}

/**
 * A metadata provider appends qualifiers that no stored title carries: "(Unabridged)", "Vol 1".
 * They come off before the site is asked; a title that is nothing but qualifiers keeps its own
 * shape rather than reducing to an empty query.
 */
function stripEditionQualifiers(title) {
  const stripped = title
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : title.trim();
}

function untilFirstSeparator(title) {
  const match = TITLE_SEPARATOR.exec(title);
  return match ? title.slice(0, match.index).trim() : title;
}

/**
 * One result per article: the hit's own link, its title, and the author and language the site
 * states beside it. An entry where the site has said nothing about a field leaves it unset
 * rather than guessing to fill it.
 */
function articlesOf(html) {
  const found = [];
  for (const block of html.match(/<article\b[^>]*>[\s\S]*?<\/article>/g) ?? []) {
    const titleLink = /<a[^>]*class="[^"]*entry-title-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(
      block,
    );
    if (!titleLink) continue;
    const title = decodeEntities(titleLink[2]).replace(/<[^>]+>/g, '').trim();
    if (!title) continue;

    const meta = /<div class="postmetainfo">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '';
    const author = /<strong>\s*Author\s*\s*:?\s*<\/strong>([\s\S]*?)<br/gi.exec(meta)?.[1]
      ?.replace(/\s*\[\w+\]\s*/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const language = /<strong>\s*Language\s*\s*:?\s*<\/strong>([\s\S]*?)<br/gi.exec(meta)?.[1]
      ?.replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    found.push({
      title,
      bookUrl: decodeEntities(titleLink[1]),
      author: author || undefined,
      language: language || undefined,
    });
  }
  return found;
}

/* ------------------------------------------------------------------------ */
/* Confirming one hit into one release.                                      */
/* ------------------------------------------------------------------------ */

async function bookToRelease(candidate, config, host, signal) {
  let bookPath;
  try {
    bookPath = new URL(candidate.bookUrl).pathname;
  } catch {
    bookPath = candidate.bookUrl.replace(/^https?:\/\/[^/]+/, '');
  }
  const html = await call(config, host, bookPath);
  if (signal.aborted) return null;

  const forms = formsOf(html);
  // A page without a download form is not a worse choice, it is not a choice at all.
  if (forms.length === 0) return null;

  const details = detailsOf(html);
  const wanted = config.settings?.fileVariant === 'pdf' ? 'pdf' : 'epub';
  // The page names at most one file per kind; where the wanted kind is absent, the upload exists
  // in the other kind and nothing more.
  const form = forms.find((f) => f.format === wanted) ?? forms[0];

  // The mint is where a dead file shows itself, so it is done once, here, and the URL kept.
  const fileUrl = await mintFileUrl(config, host, form);
  if (!fileUrl) return null;

  const author = details.author ?? candidate.author;
  const language = details.language ?? candidate.language;
  const sizeBytes = form.format === 'pdf' ? details.pdfSize : details.epubSize;
  const isbn = normalizeIsbn(details.isbn);

  return {
    guid: candidate.bookUrl,
    // The format is in the title, which is where a reader spots a fixed-layout file wearing the
    // name of a reflowable one.
    title: `${details.title ?? candidate.title} (${FORMAT_SUBLABEL[form.format] ?? form.format})`,
    bookTitle: details.title ?? candidate.title,
    downloadUrl: fileUrl,
    sizeBytes,
    // No swarm exists. Null, never zero, or the zero-seeder hard filter drops everything.
    seeders: null,
    leechers: null,
    format: form.format,
    ...(isbn ? { isbn } : {}),
    ...(language ? { language: LANGUAGE_BY_NAME[language.toLowerCase()] } : {}),
    ...(author ? { author } : {}),
    // Free in the sense the picker means: it costs the requester nothing to take.
    freeleech: true,
    // One work, one file. Nothing on this site is a split set, and the stamp is a single file's.
    primaryFileCount: 1,
    // The form travels with the release so resolveFile can ask for a fresh URL without re-reading
    // the page; the book path is where that re-read would go.
    bookForm: { id: form.id, filename: form.filename, format: form.format },
    bookPath,
    variant: form.format,
  };
}

/**
 * Post the book's form and read the file URL out of the answer. The answer also carries an
 * interactive form aimed at a parked domain, and taking a form action for a file would store a
 * domain that does not hold one: the file is the site's own file host, named as `fsN.oceanofpdf.com`.
 */
async function mintFileUrl(config, host, form) {
  const base = new URL(config.baseUrl);
  const url = new URL('Fetching_Resource.php', base);

  let response;
  try {
    response = await host.fetch(url.href, {
      method: 'POST',
      headers: requestHeaders(config, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: `id=${encodeURIComponent(form.id)}&filename=${encodeURIComponent(form.filename)}`,
    });
  } catch (error) {
    // A dead file is dropped, but a challenge, a throttle or a deadline is not one file, it is
    // the site; it is re-raised and the search reports it.
    if (isFailure(error)) throw error;
    return null;
  }

  if (response.status === 429) throw host.fail('throttled', 'is rate limiting us');
  if (!response.ok) return null;

  const body = await response.text();
  if (isChallenge(body)) return null;
  const match = FILE_URL.exec(body);
  if (!match) return null;

  let fileUrl;
  try {
    fileUrl = new URL(decodeEntities(match[1]), base);
  } catch {
    return null;
  }
  if (fileUrl.protocol !== 'https:') return null;
  return fileUrl.href;
}

/**
 * A stored URL whose stamp has passed, or a release that carries no URL at all, is re-minted.
 * The form to mint with travels with the release, which keeps the slow grab at one request of
 * the site.
 */
async function refreshFile(release, config, host) {
  let form = release.bookForm;
  if (!form?.id || !form?.filename) {
    const bookPath = release.bookPath ?? relativePath(release.guid);
    const html = await call(config, host, bookPath);
    const forms = formsOf(html);
    if (forms.length === 0) return release;
    form = forms.find((f) => f.format === (release.variant ?? 'epub')) ?? forms[0];
  }
  const downloadUrl = await mintFileUrl(config, host, form);
  if (!downloadUrl) return release;
  return { ...release, downloadUrl, bookForm: form };
}

function relativePath(bookUrl) {
  try {
    return new URL(bookUrl).pathname;
  } catch {
    return bookUrl.replace(/^https?:\/\/[^/]+/, '');
  }
}

/**
 * What the book page states about the book: name, author, language, size, identifiers. A field
 * the page has left empty stays empty; this function reads what is there, not what a book
 * should have.
 */
function detailsOf(html) {
  // The page carries navigation lists as well as the details list, and the details list is
  // wherever the site names the book's own fields. Read them all and keep only labelled rows.
  const rows = {};

  // Compressed text with an index back to the original: every letter of the label maps to its
  // original position, so a value that bolds part of itself lands after the whole label.
  const positions = (plaintext) => {
    let i = 0;
    const map = [];
    for (const ch of plaintext) {
      if (/[a-z0-9]/i.test(ch)) map.push(i);
      i += ch.length;
    }
    return map;
  };

  for (const block of html.match(/<ul[^>]*>[\s\S]*?<\/ul>/g) ?? []) {
    for (const li of block.match(/<li[^>]*>[\s\S]*?<\/li>/g) ?? []) {
      const labelMatch = /<strong[^>]*>([\s\S]*?)<\/strong>/.exec(li);
      if (!labelMatch) continue;
      const label = labelMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const key = label.replace(/[^a-z0-9]+/g, '');
      if (!key) continue;

      const plain = decodeEntities(li.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      const compressed = plain.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const where = compressed.indexOf(key);
      if (where < 0) continue;
      const pos = positions(plain);
      if (where < pos.length) {
        const rest = plain.slice(pos[where] + label.length).trim();
        if (rest) rows[key] = rest;
      }
    }
  }

  if (!rows['fullbookname'])
    return { title: undefined, author: undefined, language: undefined, isbn: undefined, epubSize: null, pdfSize: null };

  return {
    title: rows['fullbookname'] || undefined,
    author: rows['authorname'] || undefined,
    language: rows['editionlanguage'] || undefined,
    isbn: rows['isbn'] || undefined,
    epubSize: parseSize(rows['epubfilesize']),
    pdfSize: parseSize(rows['pdffilesize']),
  };
}

/**
 * One form per kind on the book page, reduced to what the mint needs and the kind it claims.
 * The form buttons are images and the forms carry no other parameters, so a form missing either
 * parameter is not a download and is skipped with its button.
 */
function formsOf(html) {
  const forms = [];
  for (const block of html.match(/<form[^>]*action="[^"]*Fetching_Resource\.php"[\s\S]*?<\/form>/g) ?? []) {
    const id = /<input[^>]*name="id"[^>]*value="([^"]*)"/.exec(block)?.[1];
    const filename = /<input[^>]*name="filename"[^>]*value="([^"]*)"/.exec(block)?.[1];
    if (!id || !filename) continue;
    const format = filename.split('.').pop()?.toLowerCase();
    if (format !== 'epub' && format !== 'pdf') continue;
    forms.push({ id: decodeEntities(id), filename: decodeEntities(filename), format });
  }
  return forms;
}

/** "82 MB" to bytes. Nothing stated, nothing readable: the size is unknown, not zero. */
function parseSize(value) {
  if (!value) return null;
  const match = /([\d.,]+)\s*(kB|KB|MB|MiB|GB|GiB)/.exec(value);
  if (!match) return null;
  const number = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * SIZE_UNITS[match[2]]);
}

/**
 * The page prints an ISBN and an ASIN that share a shape, so a ten-digit ISBN is widened to
 * thirteen rather than stated as one: the request matches on the thirteen-digit form. Anything
 * that is neither is left unstated, because this field is not trusted to be an ISBN and the
 * scorer will not be either.
 */
function normalizeIsbn(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 13) return digits;
  if (digits.length !== 10) return undefined;
  const sum = digits.slice(0, 9).split('').reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `978${digits.slice(0, 9)}${(10 - (sum % 10)) % 10}`;
}

/**
 * Entities are decoded with `&amp;` last, or an escaped entity in the source decodes twice. The
 * order is pinned rather than argued over: one doubled escape in a captured page is enough to
 * prove it wrong, and only a doubled escape shows it.
 */
function decodeEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/\&amp;(?!amp;)/g, '&');
}

/** The title reaches a filesystem path, so it is reduced to something a filename can hold. */
function sanitizeName(title) {
  return (
    String(title)
      .replace(/[^\p{L}\p{N}_\s.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'book'
  );
}

/* ------------------------------------------------------------------------ */
/* The one door to the site, with the challenge answered on the way in.      */
/* ------------------------------------------------------------------------ */

/**
 * The session this plugin holds, kept per address rather than in memory per search. The config
 * a search receives is a copy made when the search started, so a session solved half-way through
 * would not be visible to the requests that follow it without this; and a session solved in one
 * search is the one the next search starts from, which is precisely what `saveCredential` is
 * there to make survive a restart.
 */
const sessionByAddress = new Map();

async function call(config, host, path, params) {
  const base = new URL(config.baseUrl);
  const url = new URL(base.origin + path.replace(/^\//, '/'), base);
  if (params) url.search = new URLSearchParams(params).toString();

  const response = await fetchChecked(config, host, url.href, { Accept: 'text/html' });

  if (response.status === 429) throw host.fail('throttled', 'is rate limiting us');
  if (!response.ok) throw host.fail('error', `answered ${response.status}`);

  const html = await response.text();
  // A challenge that slipped past the status check is still not an answer.
  if (isChallenge(html)) throw host.fail('unauthorized', 'is serving its Cloudflare challenge and no clearing session is available');
  return html;
}

async function fetchChecked(config, host, href, extraHeaders, init) {
  const doFetch = (headers) => host.fetch(href, { ...(init ?? {}), headers });

  let response;
  try {
    response = await doFetch(requestHeaders(config, extraHeaders));
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') throw host.fail('timeout', 'did not answer in time');
    throw host.fail('unreachable', `could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status !== 403 && response.status !== 503) return response;

  // The first word the site says to a client without clearance: not an answer, and worth
  // saying plainly rather than reading as "nothing found".
  const body = await response.text().catch(() => '');
  if (!isChallenge(body)) return response;

  // The solver's own failures are thrown as host failures and pass straight through. A null
  // return means no solver is configured, and that is the one case worth saying separately.
  const solved = await solve(config, host, href);
  if (!solved) {
    throw host.fail('unauthorized', 'serving its Cloudflare challenge and no FlareSolverr address is configured');
  }
  return doFetch(requestHeaders(config, { 'User-Agent': solved.userAgent, Cookie: solved.cookie }));
}

/** What a request to the site carries: the newest session, whether it came from the config or was just solved. */
function requestHeaders(config, extra) {
  const session = readSession(config.credential) ?? sessionByAddress.get(config.baseUrl) ?? null;
  const headers = { 'User-Agent': USER_AGENT, ...(extra ?? {}) };
  if (session) {
    headers.Cookie = session.cookie;
    if (session.userAgent) headers['User-Agent'] = session.userAgent;
  }
  return headers;
}

/** The challenge, recognised only by what the challenge actually says and none of the site does. */
function isChallenge(body) {
  return /Just a moment\.\.\.|challenges\.cloudflare\.com/i.test(String(body));
}

/**
 * Ask the solver to open the site in a real browser and keep what it earned: the cookies, the
 * user agent that earned them, and when both happened. The result goes into the credential slot,
 * and into this module's own memory, which is what makes the requests of the same search free of
 * the solver too.
 */
async function solve(config, host, url) {
  const rawSolver = typeof config.settings?.flareSolverrUrl === 'string' ? config.settings.flareSolverrUrl.trim() : '';
  if (!rawSolver) return null;
  const endpoint = rawSolver.endsWith('/v1') ? rawSolver : `${rawSolver.replace(/\/+$/, '')}/v1`;

  const headers = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  const token = typeof config.settings?.flareSolverrToken === 'string' ? config.settings.flareSolverrToken.trim() : '';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await host.fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 }),
    });
  } catch (error) {
    throw host.fail('unreachable', `could not reach the solver: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw host.fail('error', `the solver answered ${response.status}`);

  let solution;
  try {
    solution = (JSON.parse(await response.text()) ?? {}).solution ?? {};
  } catch {
    throw host.fail('error', 'the solver answered with something that is not a solution');
  }

  const cookies = Array.isArray(solution.cookies) ? solution.cookies : [];
  const cookie = cookies
    .filter((c) => c && typeof c.name === 'string' && c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const userAgent = typeof solution.userAgent === 'string' ? solution.userAgent : '';
  if (!cookie) throw host.fail('error', 'the solver earned no session');

  const session = { cookie, userAgent, at: new Date().toISOString() };
  const encoded = JSON.stringify(session);
  sessionByAddress.set(config.baseUrl, session);
  try {
    await host.saveCredential(encoded);
  } catch {
    // The session is remembered either way; losing the store write costs a solver call next
    // time, not this search.
  }
  return session;
}

/**
 * The credential this plugin writes is a small JSON document, and a credential that is not
 * that document — a stale value, a hand-edit — is treated as none rather than trusted to parse.
 */
function readSession(credential) {
  if (typeof credential !== 'string' || credential.trim() === '') return null;
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed.cookie === 'string' && parsed.cookie.length > 0) return parsed;
  } catch {
    return null;
  }
  return null;
}
