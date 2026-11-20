// ==UserScript==
// @name         RYM Display Track Ratings
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Shows average track ratings, the track page genre and rankings, and each track's own voted genres and descriptors directly on RYM release pages.
// @author       cariosa
// @match        https://rateyourmusic.com/release/*
// @icon         https://e.snmc.io/2.5/img/sonemic.png
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      GPL-3.0-or-later
// ==/UserScript==

/*
 * v2.0
 *  - Descriptor links are computed from the name (album charts); genre links come from the vote response.
 *  - Toolbar above the tracklist: [Fetch Ratings] [Fetch track details] [x Show] [⚙]. While a fetch runs, its button reads
 *    "Stop n/m" (click it to stop). The ⚙ menu holds Expand all, Page genre beside details, Hide inherited and
 *    "Clear data for this release".
 *  - Track details = each track's own voted genres, scenes/movements and descriptors (RYM's /go/process requests),
 *    3 tracks at a time. Inherited items are kept apart and can be hidden.
 *  - Data is stored per song / per release (no more single cache object). Fetch buttons skip fresh records
 *    (older than "cache days" are refetched); Shift+click refetches everything. Stored data is always displayed.
 *  - Failed requests are never counted as loaded; Cloudflare/429/401 stop the run.
 *  - No external library: delay and cache days are set from the userscript manager menu.
 */
(function () {
  'use strict';
  if (!/^\/release\//.test(location.pathname)) return;

  // ── Constants and defaults
  const PFX = 'rtr:';
  const CHUNK = 3; // tracks fetched at a time
  const DEFAULTS = {
    settings: { delayMs: 1500, cacheDays: 7 },
    ui: { show: true, expandAll: false, pageGenreInline: true, hideInherited: true },
  };
  const INHERITED_RE = /Inherited from release/i;
  const SM_RE = /\u2937\s*Scenes\s*&\s*Movements/i; // parent line of scene/movement genre items
  const CF_RE = /cf-chl|challenge-platform|cf_chl_opt|<title>\s*Just a moment/i;
  const ULV_RE = /RefreshGenre2\|([^|'"]+)\|\d+\|l\|g\|/;
  const HALT = new Set(['cloudflare', 'auth', 'network', 'aborted']);

  // ── Helpers
  const txt = (e) => (e ? e.textContent : '').replace(/\s+/g, ' ').trim();
  const arr = (x) => (Array.isArray(x) ? x : []);
  const rand = (a, b) => a + Math.random() * (b - a);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  const absUrl = (href) => {
    if (!href) return null;
    try { return new URL(href, location.origin).href; } catch (_) { return null; }
  };
  // "/song/boris/pink/" -> "boris/pink" (raw path, never decoded)
  function trackKeyFromUrl(url) {
    if (!url) return null;
    try {
      const m = new URL(url, location.origin).pathname.match(/^\/song\/(.+?)\/*$/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }
  // Descriptor chart link, computed from the name (no taxonomy needed); always the album chart.
  const descriptorUrl = (name) => `${location.origin}/charts/top/album/all-time/d:${String(name).trim().toLowerCase().replace(/\s+/g, '-')}/`;
  const uniqN = (list) => { const s = new Set(); return list.filter((x) => !s.has(x.n) && s.add(x.n)); };

  class RtrError extends Error {
    constructor(code, message) { super(message); this.name = 'RtrError'; this.code = code; }
  }
  const isStale = (e) => !!e && (e.code === 'protocol' || e.code === 'auth');

  // ── Storage (own namespace)
  const getJ = (k, d) => {
    try { const v = GM_getValue(PFX + k, undefined); return v === undefined || v === null ? d : v; } catch (_) { return d; }
  };
  const setJ = (k, v) => GM_setValue(PFX + k, v);
  const settings = () => {
    const s = Object.assign({}, DEFAULTS.settings, getJ('settings', {}));
    s.delayMs = Math.max(0, Number(s.delayMs) || 0);
    s.cacheDays = Number.isFinite(Number(s.cacheDays)) && Number(s.cacheDays) >= 0 ? Number(s.cacheDays) : DEFAULTS.settings.cacheDays;
    return s;
  };
  const ui = () => Object.assign({}, DEFAULTS.ui, getJ('ui', {}));
  const setUi = (patch) => setJ('ui', Object.assign(ui(), patch));
  const loadRating = (key) => (key ? getJ('rating:' + key, null) : null);
  const saveRating = (r) => setJ('rating:' + r.trackKey, r);
  const loadDetails = (rid) => getJ('details:' + rid, { schemaVersion: 1, releaseId: rid, tracks: {} });
  const saveDetails = (d) => setJ('details:' + d.releaseId, d);
  const isFresh = (rec) => !!rec && !!rec.fetchedAt && Date.now() - Date.parse(rec.fetchedAt) < settings().cacheDays * 864e5;

  // ── Network
  async function request(url, opts, signal) {
    let res, text;
    try {
      res = await fetch(url, Object.assign({ credentials: 'same-origin', signal }, opts));
      text = await res.text();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new RtrError('aborted', 'Stopped.');
      throw new RtrError('network', `Network error: ${(e && e.message) || e}`);
    }
    if (res.status === 401) throw new RtrError('auth', 'RYM rejected the session (401). Log in again and reload.');
    if ([403, 429, 503].includes(res.status) || CF_RE.test(text)) {
      throw new RtrError('cloudflare',
        `Blocked or rate-limited by RYM/Cloudflare (HTTP ${res.status}). Solve any challenge in this tab, wait a while, then continue.`);
    }
    if (!res.ok) throw new RtrError('http', `Unexpected HTTP ${res.status} from RYM.`);
    return text;
  }
  const getText = (url, signal) => request(url, {}, signal);
  const postProcess = (payload, signal) => request('/go/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=' + encodeURIComponent(payload),
  }, signal);

  // ── Release page facts
  function releaseId() {
    const sc = document.querySelector('.album_title input.album_shortcut');
    const a = sc ? (sc.value.match(/\[[A-Za-z]+(\d+)\]/) || [])[1] : null;
    if (a) return a;
    const link = document.querySelector('table.album_info a.genre_descriptor_vote_btn[href*="album_id="]');
    return link ? (link.getAttribute('href').match(/album_id=(\d+)/) || [])[1] || null : null;
  }
  // Which genre names are scenes / movements (they are ordinary genres in the vote responses).
  function sceneMovementKinds() {
    const kinds = new Map();
    for (const tr of document.querySelectorAll('table.album_info tr')) {
      const label = txt(tr.querySelector('th.info_hdr')).toLowerCase();
      if (label !== 'scenes' && label !== 'movements') continue;
      const kind = label === 'scenes' ? 'scene' : 'movement';
      tr.querySelectorAll('.release_pri_genres a.genre, .release_sec_genres a.genre').forEach((a) => kinds.set(txt(a), kind));
    }
    return kinds;
  }
  const rowPos = (li) => {
    if (li.querySelector('.tracklist_total')) return null;
    const p = txt(li.querySelector('.tracklist_num'));
    return !p || p === '-' ? null : p;
  };
  // Unique numbered tracks of the page: { pos, url, key } (url/key null when the row has no a.song link).
  function pageTracks() {
    const out = new Map();
    for (const li of document.querySelectorAll('ul#tracks > li.track, ul#tracks_mobile > li.track')) {
      const pos = rowPos(li);
      if (!pos || out.has(pos)) continue;
      const a = li.querySelector('a.song');
      const url = a ? absUrl(a.getAttribute('href')) : null;
      out.set(pos, { pos, url, key: trackKeyFromUrl(url) });
    }
    return [...out.values()];
  }

  // ── ulv token (HttpOnly cookie; read from the vote page that embeds it in its own request)
  async function getUlv(rid, force = false) {
    if (!force) { const c = getJ('ulv', null); if (c && c.value) return c.value; }
    const text = await getText(`/rgenre/set?album_id=${encodeURIComponent(rid)}`);
    const m = text.match(ULV_RE);
    if (!m) throw new RtrError('not_logged_in', 'Could not find the ulv token on the RYM vote page. Log in to RYM and try again.');
    setJ('ulv', { value: m[1], at: new Date().toISOString() });
    return m[1];
  }

  // ── /go/process response parsing (never eval)
  function readJsString(src, i, q) {
    let out = '';
    while (i < src.length) {
      const c = src[i++];
      if (c === q) return { value: out, end: i };
      if (c !== '\\') { out += c; continue; }
      const n = src[i++];
      switch (n) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '0': out += '\0'; break;
        case 'x': out += String.fromCharCode(parseInt(src.substr(i, 2), 16)); i += 2; break;
        case 'u':
          if (src[i] === '{') {
            const e = src.indexOf('}', i);
            out += String.fromCodePoint(parseInt(src.slice(i + 1, e), 16));
            i = e + 1;
          } else {
            out += String.fromCharCode(parseInt(src.substr(i, 4), 16));
            i += 4;
          }
          break;
        case '\r': if (src[i] === '\n') i++; break;
        case '\n': break;
        default: out += n;
      }
    }
    throw new RtrError('protocol', 'Unterminated string literal in /go/process response.');
  }
  function parseAssignments(text) {
    const re = /document\.getElementById\(\s*(['"])([^'"]+)\1\s*\)\.innerHTML\s*=\s*(['"])/g;
    const out = new Map();
    let m;
    while ((m = re.exec(text))) {
      const { value, end } = readJsString(text, re.lastIndex, m[3]);
      out.set(m[2], value);
      re.lastIndex = end;
    }
    return out;
  }
  function requireKeys(map, keys, what) {
    for (const k of keys) {
      if (!map.has(k)) throw new RtrError('protocol', `${what}: response has no "${k}" assignment (session expired, or RYM changed the protocol).`);
    }
  }
  // The link class is "genre" or "gray", so the genre is found by its [GenreNNN] title. Descriptors have no link here.
  const readGenre = (item) => {
    const a = item.querySelector('a[title^="[Genre"]');
    const n = txt(a);
    return n ? { n, u: absUrl(a.getAttribute('href')) } : null;
  };
  const readDescriptor = (item) => {
    const n = txt(item.querySelector('table td > div'));
    return n ? { n, u: null } : null;
  };
  // Highlighted items (div.<itemClass>): own vs "Inherited from release"; scene/movement genres are routed out.
  function parseItems(html, itemClass, read, kinds) {
    const doc = new DOMParser().parseFromString(html, 'text/html'); // inert
    const own = [], inherited = [], scene = [], movement = [], other = [];
    const votes = {};
    doc.querySelectorAll('div.' + itemClass).forEach((item) => {
      const x = read(item);
      if (!x) return;
      const inh = INHERITED_RE.test(item.textContent);
      const kind = kinds && (kinds.get(x.n) || (SM_RE.test(item.textContent) ? 'other' : null));
      if (kind) {
        if (!inh) (kind === 'scene' ? scene : kind === 'movement' ? movement : other).push(x);
        return;
      }
      if (inh) { inherited.push(x); return; }
      own.push(x);
      const m = item.textContent.match(/voted for:\s*\(\s*(\d+)\s*\)/i);
      if (m) votes[x.n] = parseInt(m[1], 10);
    });
    return { own: uniqN(own), inherited: uniqN(inherited), scenes: uniqN(scene), movements: uniqN(movement), other: uniqN(other), votes };
  }
  async function fetchGenres(ulv, id, pos, signal, kinds) {
    const a = parseAssignments(await postProcess(`RefreshGenre2|${ulv}|${id}|l|g|${pos}`, signal));
    requireKeys(a, ['genreListlg' + id, 'genreListls' + id], `Genres (${pos})`);
    const p = parseItems(a.get('genreListlg' + id), 'genrea', readGenre, kinds);
    const q = parseItems(a.get('genreListls' + id), 'genrea', readGenre, kinds);
    return {
      genres: { primary: p.own, secondary: q.own },
      inherited: { primary: p.inherited, secondary: q.inherited },
      scenes: uniqN([...p.scenes, ...q.scenes]),
      movements: uniqN([...p.movements, ...q.movements]),
      scenesMovements: uniqN([...p.other, ...q.other]),
      votes: { primary: p.votes, secondary: q.votes },
    };
  }
  async function fetchDescriptors(ulv, id, pos, signal) {
    const a = parseAssignments(await postProcess(`RefreshDescriptor2|${ulv}|${id}|l|${pos}`, signal));
    requireKeys(a, ['descriptorListl' + id], `Descriptors (${pos})`);
    const d = parseItems(a.get('descriptorListl' + id), 'descriptora', readDescriptor, null);
    return { descriptors: d.own, inherited: d.inherited, votes: d.votes };
  }

  // ── Track page (rating, bold star, page genre, rankings)
  function parseTrackPage(text, url) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const head = doc.querySelector('.page_song_header_main_info');
    if (!head) throw new RtrError('protocol', 'Not a RYM track page (block page, expired session or changed markup).');
    const trackKey = trackKeyFromUrl(url);
    if (!trackKey) throw new RtrError('protocol', `Not a /song/ URL: ${url}`);
    const ratingEl = head.querySelector('.page_section_main_info_music_rating_value_rating');
    const countEl = head.querySelector('.page_section_main_info_music_rating_value_number');
    const avg = ratingEl ? (txt(ratingEl).match(/\d+(?:\.\d+)?/) || [])[0] || null : null;
    const cm = countEl ? (txt(countEl).match(/[\d,]+/) || [])[0] : null;
    const count = cm ? parseInt(cm.replace(/,/g, ''), 10) : NaN;
    const g = head.querySelector('.page_song_header_info_genre_item_primary a.genre');
    return {
      trackKey,
      url: String(url).split(/[?#]/)[0],
      avgRating: avg,                              // string as displayed (2 decimals); null = no ratings
      ratingCount: Number.isFinite(count) ? count : null,
      bold: !!(ratingEl && ratingEl.querySelector('img.metadata-star-bold, img[alt="rating bolded"]')),
      pageGenre: g ? { name: txt(g), url: absUrl(g.getAttribute('href')) } : null,
      rankings: [...head.querySelectorAll('.page_song_header_info_rest a.comma_separated')]
        .map((a) => ({ text: txt(a), url: absUrl(a.getAttribute('href')) })).filter((x) => x.text),
      fetchedAt: new Date().toISOString(),
    };
  }

  // ── Fetch runner: CHUNK items at a time, delay between chunks, halts on Cloudflare/auth/network, 3 failed chunks stop.
  async function runChunks(items, work, { signal, onProgress, beforeRetry } = {}) {
    const failed = [];
    let status = 'done', reason = null, streak = 0, done = 0, retried = false;
    const report = () => onProgress && onProgress(done, items.length);
    report();
    for (let i = 0; i < items.length; i += CHUNK) {
      if (signal.aborted) { status = 'stopped'; break; }
      const chunk = items.slice(i, i + CHUNK);
      const settled = await Promise.allSettled(chunk.map((it) => work(it, signal)));
      // Whole chunk failed with a session-looking error: refresh once and redo the chunk.
      if (!retried && beforeRetry && settled.every((r) => r.status === 'rejected') && settled.some((r) => isStale(r.reason))) {
        retried = true;
        await beforeRetry();
        i -= CHUNK;
        continue;
      }
      let halt = null, ok = 0;
      settled.forEach((r, idx) => {
        if (r.status === 'fulfilled') { ok++; done++; return; }
        const err = r.reason;
        if (err && HALT.has(err.code)) halt = halt || err;
        else failed.push({ item: chunk[idx], error: (err && err.message) || String(err) });
      });
      report();
      if (halt) { status = halt.code === 'aborted' ? 'stopped' : 'halted'; reason = halt.message; break; }
      streak = ok ? 0 : streak + 1;
      if (streak >= 3) { status = 'halted'; reason = 'Three consecutive chunks failed; see the console.'; break; }
      if (i + CHUNK < items.length) await sleep(rand(settings().delayMs, settings().delayMs * 2), signal);
    }
    return { status, reason, failed, remaining: items.length - done };
  }

  async function fetchRatings(signal, force, onProgress) {
    const targets = new Map();
    pageTracks().forEach((t) => { if (t.url && t.key && !targets.has(t.key)) targets.set(t.key, t.url); });
    if (!targets.size) throw new RtrError('protocol', 'No track links (a.song) found on this page.');
    const pending = [...targets].filter(([key]) => force || !isFresh(loadRating(key)));
    if (!pending.length) return { status: 'done', reason: null, failed: [], remaining: 0, none: true };
    const work = async ([, url], sig) => { saveRating(parseTrackPage(await getText(url, sig), url)); };
    return runChunks(pending, work, { signal, onProgress });
  }

  async function fetchDetails(signal, force, onProgress) {
    const rid = releaseId();
    if (!rid) throw new RtrError('protocol', 'No RYM release id found on this page.');
    const rec = loadDetails(rid);
    const pending = pageTracks().filter((t) => force || !isFresh(rec.tracks[t.pos]));
    if (!pending.length) return { status: 'done', reason: null, failed: [], remaining: 0, none: true };
    const kinds = sceneMovementKinds();
    let ulv = await getUlv(rid);
    const work = async (t, sig) => {
      const [g, d] = await Promise.all([
        fetchGenres(ulv, rid, t.pos, sig, kinds),
        fetchDescriptors(ulv, rid, t.pos, sig),
      ]);
      rec.tracks[t.pos] = {
        fetchedAt: new Date().toISOString(),
        genres: g.genres, inherited: g.inherited,
        scenes: g.scenes, movements: g.movements, scenesMovements: g.scenesMovements,
        descriptors: d.descriptors, descriptorsInherited: d.inherited,
        votes: Object.assign({}, g.votes, { descriptors: d.votes }),
      };
      saveDetails(rec);
    };
    return runChunks(pending, work, { signal, onProgress, beforeRetry: async () => { ulv = await getUlv(rid, true); } });
  }

  // ── Display
  function injectStyles() {
    if (document.getElementById('rtr-style')) return;
    const st = el('style');
    st.id = 'rtr-style';
    st.textContent = `
      .rtr-toolbar { margin: 6px 0 8px; }
      .rtr-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .rtr-gearwrap { position: relative; display: inline-block; }
      .rtr-menu { position: absolute; left: 0; top: 100%; margin-top: 4px; z-index: 50; display: flex; flex-direction: column;
        gap: 6px; padding: 8px; background: #152238; color: #e6edf3; border: 1px solid #2c3e5c; border-radius: 6px;
        white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
      .rtr-menu[hidden] { display: none; }
      .rtr-status { margin-top: 4px; font-size: 0.9em; }
      .rtr-status.rtr-err { color: #d33; }
      .rtr-rating .page_release_section_tracks_track_stats_rating { margin-left: 6px; }
      .rtr-rating .page_release_section_tracks_track_stats_rating.pipe_separated::after,
      .rtr-rating .page_release_section_tracks_track_stats_count.pipe_separated::before { padding: 0 0.35em !important; }
      details.rtr-ext, .rtr-pgline { margin: 2px 0 6px 34px; font-size: 0.9em; }
      details.rtr-ext > summary { cursor: pointer; opacity: 0.75; user-select: none; }
      details.rtr-ext > summary:hover { opacity: 1; }
      .rtr-pg { margin-left: 10px; user-select: text; }
      .rtr-body { margin-top: 4px; }
      .rtr-head { font-weight: bold; margin-top: 6px; }
      .rtr-inh { opacity: 0.6; }
      .rtr-pri, .rtr-pri a { font-weight: bold; }
    `;
    document.head.appendChild(st);
  }

  function anchorOrText(text, url, inherited, title) {
    const e = document.createElement(url ? 'a' : 'span');
    if (url) { e.className = 'genre'; e.href = url; }
    e.textContent = text;
    if (title) e.title = title;
    if (inherited) e.classList.add('rtr-inh');
    return e;
  }
  // items: [{ n, u, inh }]; comma-separated links like the release page.
  function nameList(items, votes, urlFor) {
    const span = el('span');
    items.forEach((it, i) => {
      if (i) span.append(', ');
      const v = votes && votes[it.n];
      const title = it.inh ? 'Inherited from release' : (v != null ? `${v} vote${v === 1 ? '' : 's'}` : '');
      span.append(anchorOrText(it.n, it.u || (urlFor ? urlFor(it.n) : null), it.inh, title));
    });
    return span;
  }
  function toItems(own, inherited) {
    const seen = new Set(arr(own).map((x) => x.n));
    return [...arr(own).map((x) => Object.assign({}, x, { inh: false })),
      ...arr(inherited).filter((x) => !seen.has(x.n)).map((x) => Object.assign({}, x, { inh: true }))];
  }

  // d = stored details of the track | undefined, rating = stored song record | null.
  function buildBlock(d, rating, U) {
    const body = el('div', 'rtr-body');
    const section = (label, nodes) => {
      const c = el('div');
      c.append(...nodes);
      body.append(el('div', 'rtr-head', label), c);
    };
    const pg = [];
    if (rating && (rating.pageGenre || arr(rating.rankings).length)) {
      if (rating.pageGenre) pg.push(anchorOrText(rating.pageGenre.name, rating.pageGenre.url));
      if (rating.pageGenre && arr(rating.rankings).length) pg.push(' • ');
      arr(rating.rankings).forEach((r, i) => { if (i) pg.push(', '); pg.push(anchorOrText(r.text, r.url)); });
      if (!U.pageGenreInline) section('Track page genre & rankings', pg);
    }
    if (d) {
      const hide = U.hideInherited;
      const gi = hide ? {} : (d.inherited || {});
      const votes = d.votes || {};
      const g = d.genres || {};
      const prim = toItems(g.primary, gi.primary);
      const sec = toItems(g.secondary, gi.secondary);
      if (prim.length || sec.length) {
        const nodes = [];
        if (prim.length) { const p = nameList(prim, votes.primary); p.classList.add('rtr-pri'); nodes.push(p); }
        if (prim.length && sec.length) nodes.push(document.createElement('br'));
        if (sec.length) nodes.push(nameList(sec, votes.secondary));
        section('Genres', nodes);
      }
      const sc = toItems(d.scenes, []);
      if (sc.length) section('Scenes', [nameList(sc)]);
      const mv = toItems(d.movements, []);
      if (mv.length) section('Movements', [nameList(mv)]);
      const sm = toItems(d.scenesMovements, []);
      if (sm.length) section('Scenes & Movements', [nameList(sm)]);
      const ds = toItems(d.descriptors, hide ? [] : d.descriptorsInherited);
      if (ds.length) section('Descriptors', [nameList(ds, votes.descriptors, descriptorUrl)]);
    }
    const inline = U.pageGenreInline && pg.length > 0;
    if (!body.children.length) {
      if (!inline) return null;
      const line = el('div', 'rtr-pgline');
      line.append(...pg);
      return line;
    }
    const det = el('details', 'rtr-ext');
    const sum = el('summary', null, 'Details');
    if (inline) { const s = el('span', 'rtr-pg'); s.append(...pg); sum.append(s); }
    det.append(sum, body);
    return det;
  }

  // Same markup RYM uses for its own (sponsored) track ratings; ours has two decimals and the full count.
  function ratingNode(rec) {
    const count = rec.ratingCount != null ? rec.ratingCount.toLocaleString('en-US') : null;
    const wrap = el('span', 'has_tip page_release_section_tracks_songs_song_stats significant rtr-rating');
    wrap.setAttribute('data-tiptip', `${rec.avgRating}${count ? ` from ${count} ratings` : ''}`);
    wrap.innerHTML = `<span class="page_release_section_tracks_track_stats_scores${rec.bold ? ' bold' : ''}">`
      + `<span class="page_release_section_tracks_track_stats_score_star pipe_separated">`
      + `<img alt="${rec.bold ? 'bold star' : 'star'}" class="${rec.bold ? 'metadata-star-bold' : 'metadata-star'}">`
      + `<div class="page_release_section_tracks_track_stats_rating pipe_separated">${rec.avgRating}</div></span>`
      + (count ? `<div class="page_release_section_tracks_track_stats_count pipe_separated">${count}</div>` : '')
      + `</span>`;
    return wrap;
  }
  function placeRating(li, rec) {
    const line = li.querySelector('.tracklist_line');
    const num = li.querySelector('.tracklist_num');
    if (!line || !num || num.parentElement !== line) return false;
    // RYM's own rating (sponsored releases, 1 decimal) is hidden, not deleted, so hiding our data restores it.
    const native = line.querySelector(':scope > span.page_release_section_tracks_songs_song_stats:not(.rtr-rating)');
    if (native) { native.style.display = 'none'; native.setAttribute('data-rtr-hidden', ''); }
    line.insertBefore(ratingNode(rec), num);
    return true;
  }
  function clearRender() {
    document.querySelectorAll('.rtr-rating, details.rtr-ext, .rtr-pgline').forEach((e) => e.remove());
    document.querySelectorAll('[data-rtr-hidden]').forEach((e) => { e.style.display = ''; e.removeAttribute('data-rtr-hidden'); });
  }
  // Idempotent: clears and redraws, keeping the open/closed state of the details blocks.
  function render() {
    injectStyles();
    const U = ui();
    const rid = releaseId();
    const det = rid ? loadDetails(rid) : { tracks: {} };
    const before = [...document.querySelectorAll('details.rtr-ext')];
    const hadAny = before.length > 0;
    const open = new Set(before.filter((d) => d.open).map((d) => d.dataset.k));
    clearRender();
    let rated = 0, detailed = 0;
    for (const list of document.querySelectorAll('ul#tracks, ul#tracks_mobile')) {
      for (const li of list.querySelectorAll(':scope > li.track')) {
        const pos = rowPos(li);
        if (!pos) continue;
        const a = li.querySelector('a.song');
        const rating = loadRating(a ? trackKeyFromUrl(a.getAttribute('href')) : null);
        if (rating && rating.avgRating && placeRating(li, rating)) rated++;
        const d = det.tracks[pos];
        const block = buildBlock(d, rating, U);
        if (!block) continue;
        if (d) detailed++;
        if (block.tagName === 'DETAILS') {
          const k = `${list.id}:${pos}`;
          block.dataset.k = k;
          block.open = hadAny ? open.has(k) : U.expandAll;
        }
        li.appendChild(block);
      }
    }
    return { rated, detailed };
  }

  // ── Toolbar
  const toolbars = [];
  const S = { ctl: null, kind: null };

  function makeBtn(label, onClick, bright) {
    const b = el(bright ? 'button' : 'a', bright ? 'btn btn_small blue_btn' : 'btn', label);
    if (bright) b.type = 'button';
    else { b.setAttribute('role', 'button'); b.tabIndex = 0; b.style.cursor = 'pointer'; }
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(e); });
    if (!bright) b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } });
    return b;
  }
  function makeToggle(label, get, set) {
    const wrap = el('label', 'btn ebr-collection-choice');
    const cb = el('input', 'ebr-checkbox');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => set(cb.checked));
    wrap.append(cb, ' ' + label);
    return { el: wrap, sync: () => { cb.checked = !!get(); } };
  }
  const setStatus = (msg, isErr) => toolbars.forEach((t) => {
    t.status.textContent = msg || '';
    t.status.classList.toggle('rtr-err', !!isErr);
  });
  function setRunning(kind, progress) {
    toolbars.forEach((t) => {
      t.bR.textContent = kind === 'ratings' ? `Stop ${progress}` : 'Fetch Ratings';
      t.bD.textContent = kind === 'details' ? `Stop ${progress}` : 'Fetch track details';
      t.bR.style.opacity = kind === 'details' ? '0.5' : '';
      t.bR.style.pointerEvents = kind === 'details' ? 'none' : '';
      t.bD.style.opacity = kind === 'ratings' ? '0.5' : '';
      t.bD.style.pointerEvents = kind === 'ratings' ? 'none' : '';
    });
  }
  function applyView() {
    const info = ui().show ? render() : (clearRender(), null);
    toolbars.forEach((t) => t.sync());
    return info;
  }

  async function start(kind, e) {
    if (S.ctl) { if (S.kind === kind) S.ctl.abort(); return; }
    S.ctl = new AbortController();
    S.kind = kind;
    setStatus('');
    const label = kind === 'ratings' ? 'Ratings' : 'Track details';
    try {
      setRunning(kind, '…');
      const run = kind === 'ratings' ? fetchRatings : fetchDetails;
      const res = await run(S.ctl.signal, !!(e && e.shiftKey), (done, total) => {
        setRunning(kind, `${done}/${total}`);
        applyView();
      });
      if (res.failed.length) console.warn(`[RYM Track Ratings] failed (${kind}):`, res.failed);
      const tail = res.failed.length ? ` ${res.failed.length} failed (see console).` : '';
      if (res.none) setStatus(`${label}: everything is already fresh (Shift+click to refetch).`);
      else if (res.status === 'done') setStatus(`${label}: done.${tail}`, !!res.failed.length);
      else setStatus(`${label} ${res.status}: ${res.reason || 'by you'} (${res.remaining} remaining).${tail}`, res.status === 'halted');
    } catch (err) {
      console.error('[RYM Track Ratings]', err);
      setStatus(err instanceof RtrError ? err.message : `Unexpected error: ${err && err.message}`, true);
    } finally {
      S.ctl = null;
      S.kind = null;
      setRunning(null);
      const info = applyView();
      if (ui().show && info && !info.rated && !info.detailed && !document.querySelector('.rtr-status.rtr-err')) {
        setStatus('Nothing stored for this release yet: use Fetch Ratings or Fetch track details.');
      }
    }
  }

  function clearReleaseData() {
    const rid = releaseId();
    if (!window.confirm('Delete the stored ratings and track details of this release?')) return;
    if (rid) GM_deleteValue(PFX + 'details:' + rid);
    pageTracks().forEach((t) => { if (t.key) GM_deleteValue(PFX + 'rating:' + t.key); });
    applyView();
    setStatus('Stored data of this release deleted.');
  }

  function buildToolbar() {
    const root = el('div', 'rtr-toolbar');
    const row = el('div', 'rtr-row');
    const bR = makeBtn('Fetch Ratings', (e) => start('ratings', e), true);
    bR.title = 'Fetch each song\'s rating, page genre and rankings (3 at a time). Shift+click: refetch all.';
    const bD = makeBtn('Fetch track details', (e) => start('details', e), false);
    bD.title = 'Fetch each track\'s own voted genres and descriptors (3 tracks at a time). Shift+click: refetch all.';
    const tShow = makeToggle('Show', () => ui().show, (on) => { setUi({ show: on }); applyView(); });

    const menu = el('div', 'rtr-menu');
    menu.hidden = true;
    const tExpand = makeToggle('Expand all', () => ui().expandAll, (on) => {
      setUi({ expandAll: on });
      document.querySelectorAll('details.rtr-ext').forEach((d) => { d.open = on; });
      toolbars.forEach((t) => t.sync());
    });
    const tPage = makeToggle('Page genre beside details', () => ui().pageGenreInline, (on) => { setUi({ pageGenreInline: on }); applyView(); });
    const tHide = makeToggle('Hide inherited', () => ui().hideInherited, (on) => { setUi({ hideInherited: on }); applyView(); });
    menu.append(tExpand.el, tPage.el, tHide.el, makeBtn('Clear data for this release', clearReleaseData, false));

    const gearWrap = el('span', 'rtr-gearwrap');
    const gear = makeBtn('⚙', () => { menu.hidden = !menu.hidden; }, false);
    gear.title = 'Display settings';
    gear.setAttribute('aria-label', 'Display settings');
    gearWrap.append(gear, menu);
    document.addEventListener('click', (e) => { if (!gearWrap.contains(e.target)) menu.hidden = true; });

    const status = el('div', 'rtr-status');
    row.append(bR, bD, tShow.el, gearWrap);
    root.append(row, status);
    return { root, bR, bD, status, sync: () => { [tShow, tExpand, tPage, tHide].forEach((t) => t.sync()); } };
  }

  function mountToolbars() {
    for (const list of document.querySelectorAll('ul#tracks, ul#tracks_mobile')) {
      const prev = list.previousElementSibling;
      if (prev && prev.classList.contains('rtr-toolbar')) continue;
      const tb = buildToolbar();
      toolbars.push(tb);
      list.parentNode.insertBefore(tb.root, list);
    }
  }

  // ── Menu commands (replace the old GM_config dialog)
  function askNumber(title, current, key, min) {
    const v = window.prompt(title, String(current));
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) { window.alert('Please enter a number of at least ' + min + '.'); return; }
    setJ('settings', Object.assign(settings(), { [key]: n }));
  }
  function clearAllData() {
    if (!window.confirm('Delete ALL stored ratings and track details from this script?')) return;
    GM_listValues().filter((k) => k.startsWith(PFX + 'rating:') || k.startsWith(PFX + 'details:')).forEach((k) => GM_deleteValue(k));
    try { GM_setValue('trackDataCache', {}); } catch (_) { /* old v1 cache */ }
    window.alert('RYM Track Ratings: all stored data has been cleared.');
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('⚙️ Request delay (ms, per group of 3 tracks)', () => askNumber('Base delay between groups of 3 tracks, in ms (a random 1x to 2x of it is used):', settings().delayMs, 'delayMs', 0));
    GM_registerMenuCommand('⚙️ Cache days (refetch after)', () => askNumber('Fetch buttons skip data younger than this many days:', settings().cacheDays, 'cacheDays', 0));
    GM_registerMenuCommand('⚠️ Clear all stored data', clearAllData);
  }

  // ── Start
  mountToolbars();
  if (toolbars.length) {
    const info = applyView();
    if (ui().show && info && !info.rated && !info.detailed) {
      setStatus('Nothing stored for this release yet: use Fetch Ratings or Fetch track details.');
    }
  }
})();
