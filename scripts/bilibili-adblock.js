/**
 * Bilibili iOS App AdBlock (Stash response script)
 *
 * One script serves two override entries:
 *  - JSON endpoints (text mode): splash, home feed, story feed, tab layout
 *  - gRPC endpoints (binary-mode): View, RelatesFeed, DynAll, SearchAll
 *
 * Arguments (from the override):
 *  - splash   (default: true)  empty the splash (launch screen) ad lists
 *  - feed     (default: true)  drop ad cards from home / story / dynamic / search feeds
 *  - view     (default: true)  drop the under-player ad and ad cards in related videos
 *  - hideTabs (default: false) remove activity tabs, game center and mall entries
 *  - debug    (default: false) log every modification
 */

function parseArguments() {
  const cfg = { splash: true, feed: true, view: true, hideTabs: false, debug: false };
  if (typeof $argument !== 'string' || !$argument) return cfg;
  $argument.split('&').forEach((kv) => {
    const idx = kv.indexOf('=');
    if (idx === -1) return;
    const k = kv.slice(0, idx).trim();
    const v = kv.slice(idx + 1).trim().toLowerCase();
    if (k in cfg) cfg[k] = v === 'true' || v === '1' || v === 'on';
  });
  return cfg;
}

const CFG = parseArguments();
const URL_PATH = ($request.url || '').split('?')[0];

function log(msg) {
  if (CFG.debug) console.log('[bili-adblock] ' + msg);
}

// ---------------------------------------------------------------------------
// JSON endpoints
// ---------------------------------------------------------------------------

function isAdItem(item) {
  if (!item || typeof item !== 'object') return false;
  const gotoType = String(item.card_goto || item.goto || '');
  const cardType = String(item.card_type || '');
  if (/(^|_)ad(_|$)/.test(gotoType)) return true; // ad_av, ad_web_s, vertical_ad_av ...
  if (/^cm_/.test(cardType)) return true;
  if (gotoType === 'banner' || /^banner/.test(cardType)) return true;
  if (item.ad_info) return true; // promoted videos disguised as normal av cards
  return false;
}

function filterItems(list, tag) {
  if (!Array.isArray(list)) return list;
  const out = list.filter((x) => !isAdItem(x));
  if (out.length !== list.length) log(`${tag}: removed ${list.length - out.length} of ${list.length}`);
  return out;
}

const TAB_DROP = /^bilibili:\/\/(following\/home_activity_tab|game_center|mall)/;

function handleJson(obj) {
  const d = obj && obj.data;
  if (!d) return false;

  if (/\/x\/v2\/splash\/(list|show)$/.test(URL_PATH)) {
    if (!CFG.splash) return false;
    if (Array.isArray(d.list)) d.list = [];
    if (Array.isArray(d.show)) d.show = [];
    if ('max_time' in d) d.max_time = 0;
    log('splash emptied');
    return true;
  }

  if (/\/x\/v2\/feed\/index(\/story)?$/.test(URL_PATH)) {
    if (!CFG.feed || !Array.isArray(d.items)) return false;
    d.items = filterItems(d.items, 'feed');
    return true;
  }

  if (/\/x\/resource\/show\/tab\/v2$/.test(URL_PATH)) {
    if (!CFG.hideTabs) return false;
    ['tab', 'top', 'bottom'].forEach((k) => {
      if (!Array.isArray(d[k])) return;
      const before = d[k].length;
      d[k] = d[k].filter((t) => !TAB_DROP.test(String(t.uri || '')));
      if (d[k].length !== before) log(`tab.${k}: removed ${before - d[k].length}`);
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Protobuf helpers (no schema; edits by field path)
// ---------------------------------------------------------------------------

function readVarint(b, i) {
  let r = 0;
  let s = 1;
  let c;
  do {
    if (i >= b.length) throw new Error('varint overflow');
    c = b[i++];
    r += (c & 0x7f) * s;
    s *= 128;
  } while (c >= 0x80);
  return [r, i];
}

function writeVarint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

function cat(arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const r = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    r.set(a, o);
    o += a.length;
  }
  return r;
}

// Returns [{ f, wt, start, end, val }] or throws when the bytes are not a message.
function parse(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    const start = i;
    let key;
    [key, i] = readVarint(b, i);
    const f = Math.floor(key / 8);
    const wt = key & 7;
    if (f === 0) throw new Error('field 0');
    let val = null;
    if (wt === 0) {
      [, i] = readVarint(b, i);
    } else if (wt === 1) {
      i += 8;
    } else if (wt === 5) {
      i += 4;
    } else if (wt === 2) {
      let n;
      [n, i] = readVarint(b, i);
      if (i + n > b.length) throw new Error('length overflow');
      val = b.subarray(i, i + n);
      i += n;
    } else {
      throw new Error('wire type ' + wt);
    }
    if (i > b.length) throw new Error('truncated');
    out.push({ f, wt, start, end: i, val });
  }
  return out;
}

function lenField(f, bytes) {
  return cat([Uint8Array.from([...writeVarint((f << 3) | 2), ...writeVarint(bytes.length)]), bytes]);
}

/**
 * Walks `path` (field numbers) through every matching length-delimited field and
 * drops the entries at the last level for which `drop(bytes)` is true.
 * Returns the rebuilt message, or null when nothing changed.
 */
function dropAt(buf, path, drop, stat) {
  let fields;
  try {
    fields = parse(buf);
  } catch (e) {
    return null;
  }
  const parts = [];
  let changed = false;
  for (const fld of fields) {
    if (fld.f === path[0] && fld.wt === 2) {
      if (path.length === 1) {
        if (drop(fld.val)) {
          stat.n++;
          changed = true;
          continue;
        }
      } else {
        const nv = dropAt(fld.val, path.slice(1), drop, stat);
        if (nv) {
          parts.push(lenField(fld.f, nv));
          changed = true;
          continue;
        }
      }
    }
    parts.push(buf.subarray(fld.start, fld.end));
  }
  return changed ? cat(parts) : null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const AD_TYPE = enc.encode('type.googleapis.com/bilibili.ad.v1.');

function contains(hay, needle) {
  const first = needle[0];
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const hasAdAny = (b) => contains(b, AD_TYPE);
const always = () => true;

function searchItemIsAd(b) {
  try {
    for (const fld of parse(b)) {
      // field 3 = goto ("av", "live", "video_ad", ...)
      if (fld.f === 3 && fld.wt === 2 && fld.val.length < 32) {
        return /(^|_)ad(_|$)/.test(dec.decode(fld.val));
      }
    }
  } catch (e) {}
  return false;
}

// [enabled, path regex, [[fieldPath, predicate, label], ...]]
const GRPC_RULES = [
  [() => CFG.view, /\/bilibili\.app\.viewunite\.v1\.View\/View$/, [
    [[7], always, 'under-player cm'],
    [[5, 1, 2, 2, 22, 1], hasAdAny, 'relates ad'],
  ]],
  [() => CFG.view, /\/bilibili\.app\.viewunite\.v1\.View\/RelatesFeed$/, [
    [[1], hasAdAny, 'relates ad'],
  ]],
  [() => CFG.feed, /\/bilibili\.app\.dynamic\.v2\.Dynamic\/DynAll$/, [
    [[1, 1], hasAdAny, 'dynamic ad'],
  ]],
  [() => CFG.feed, /\/bilibili\.polymer\.app\.search\.v1\.Search\/SearchAll$/, [
    [[4], searchItemIsAd, 'search ad'],
  ]],
];

function handleGrpc(raw) {
  const rule = GRPC_RULES.find(([on, re]) => re.test(URL_PATH) && on());
  if (!rule || raw.length < 5) return null;

  const flag = raw[0];
  const n = ((raw[1] << 24) | (raw[2] << 16) | (raw[3] << 8) | raw[4]) >>> 0;
  if (5 + n > raw.length) return null;
  let msg = raw.slice(5, 5 + n);
  if (flag === 1) msg = $utils.ungzip(msg);

  let changed = false;
  for (const [path, pred, label] of rule[2]) {
    const stat = { n: 0 };
    const out = dropAt(msg, path, pred, stat);
    if (out) {
      msg = out;
      changed = true;
      log(`${URL_PATH.split('/').pop()}: ${label} x${stat.n}`);
    }
  }
  if (!changed) return null;

  const payload = flag === 1 ? $utils.gzip(msg) : msg;
  const hdr = new Uint8Array(5);
  hdr[0] = flag;
  new DataView(hdr.buffer).setUint32(1, payload.length);
  return cat([hdr, payload]);
}

// ---------------------------------------------------------------------------

(function main() {
  try {
    const body = $response.body;
    if (!body) return $done({});

    if (typeof body === 'string') {
      const obj = JSON.parse(body);
      if (!handleJson(obj)) return $done({});
      return $done({ body: JSON.stringify(obj) });
    }

    const out = handleGrpc(body);
    if (!out) return $done({});
    // Stash drops HTTP/2 trailers once the body is replaced; without grpc-status
    // the client treats the call as failed and retries. Carry it in the headers.
    const headers = Object.assign({}, $response.headers, {
      'grpc-status': '0',
      'grpc-message': '',
      'bili-status-code': '0',
    });
    $done({ headers, body: out });
  } catch (e) {
    console.log('[bili-adblock] error: ' + (e && e.message ? e.message : e));
    $done({});
  }
})();
