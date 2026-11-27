/**
 * Bilibili iOS App AdBlock & SponsorBlock (Stash response script)
 *
 * One binary-mode script entry serves both kinds of endpoints:
 *  - JSON (decoded from bytes): splash, home feed, story feed, tab layout
 *  - gRPC protobuf:
 *      AdBlock:      View, RelatesFeed, DynAll, SearchAll
 *      SponsorBlock: PlayViewUnite (AD_FRAGMENT strip + cache warmup),
 *                    ViewProgress (Chronos auto-skip bundle + progress bar chapters),
 *                    DmSegMobile (Chronos airborne trigger danmaku)
 *
 * Arguments (from the override):
 *  - splash       (default: true)  empty the splash (launch screen) ad lists
 *  - feed         (default: true)  drop ad cards from home / story / dynamic / search feeds
 *  - view         (default: true)  drop the under-player ad and ad cards in related videos
 *  - sponsorBlock (default: true)  skip / mark in-video sponsor segments via bsbsb.top
 *  - hideTabs     (default: false) remove activity tabs, game center and mall entries
 *  - debug        (default: false) log every modification
 */

function parseArguments() {
  const cfg = {
    splash: true,
    feed: true,
    view: true,
    sponsorBlock: true,
    hideTabs: false,
    debug: false,
  };
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
// Protobuf helpers (no schema; edits by field number/path)
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

function writeVarintBig(n) {
  let v = BigInt(n);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
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

// Returns [{ f, wt, start, end, val, num }] or throws when the bytes are not a message.
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
    let num = 0;
    if (wt === 0) {
      [num, i] = readVarint(b, i);
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
    out.push({ f, wt, start, end: i, val, num });
  }
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function varintField(f, n) {
  return Uint8Array.from([...writeVarint(f * 8), ...writeVarintBig(n)]);
}

function lenField(f, bytes) {
  return cat([Uint8Array.from([...writeVarint(f * 8 + 2), ...writeVarint(bytes.length)]), bytes]);
}

function strField(f, s) {
  return lenField(f, enc.encode(s));
}

function unpackGrpc(raw) {
  if (!raw || raw.length < 5) return null;
  const flag = raw[0];
  const n = ((raw[1] << 24) | (raw[2] << 16) | (raw[3] << 8) | raw[4]) >>> 0;
  if (5 + n > raw.length) return null;
  let msg = raw.slice(5, 5 + n);
  if (flag === 1) msg = $utils.ungzip(msg);
  return { flag, msg };
}

function packGrpc(flag, msg) {
  const payload = flag === 1 ? $utils.gzip(msg) : msg;
  const hdr = new Uint8Array(5);
  hdr[0] = flag;
  new DataView(hdr.buffer).setUint32(1, payload.length);
  return cat([hdr, payload]);
}

function finishGrpc(out) {
  if (!out) return $done({});
  // Stash drops HTTP/2 trailers once the body is replaced; without grpc-status
  // the client treats the call as failed and retries. Carry it in the headers.
  const headers = Object.assign({}, $response.headers, {
    'grpc-status': '0',
    'grpc-message': '',
    'bili-status-code': '0',
  });
  $done({ headers, body: out });
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

function handleStaticGrpc(raw) {
  const rule = GRPC_RULES.find(([on, re]) => re.test(URL_PATH) && on());
  if (!rule) return null;
  const g = unpackGrpc(raw);
  if (!g) return null;

  let msg = g.msg;
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
  return changed ? packGrpc(g.flag, msg) : null;
}

// ---------------------------------------------------------------------------
// SponsorBlock (bsbsb.top)
// ---------------------------------------------------------------------------

const SB_CACHE_KEY = 'bili_sb_cache_v1';
const SB_CACHE_TTL_MS = 10 * 60 * 1000;
const SB_CACHE_MAX = 20;
const SB_CATEGORIES = '["sponsor","selfpromo"]';
const SB_LABELS = {
  sponsor: '恰饭广告',
  selfpromo: '自我推广',
};

function av2bv(aid) {
  const XOR_CODE = 23442827791579n;
  const MAX_AID = 1n << 51n;
  const BASE = 58n;
  const TABLE = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
  const bytes = ['B', 'V', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0'];
  let idx = 11;
  let tmp = (MAX_AID | BigInt(aid)) ^ XOR_CODE;
  while (tmp !== 0n) {
    bytes[idx--] = TABLE[Number(tmp % BASE)];
    tmp /= BASE;
  }
  [bytes[3], bytes[9]] = [bytes[9], bytes[3]];
  [bytes[4], bytes[7]] = [bytes[7], bytes[4]];
  return bytes.join('');
}

function formatTime(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function readSbCache() {
  try {
    if (typeof $persistentStore === 'undefined') return {};
    const raw = $persistentStore.read(SB_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function writeSbCache(cache) {
  try {
    if (typeof $persistentStore === 'undefined') return;
    const keys = Object.keys(cache);
    if (keys.length > SB_CACHE_MAX) {
      keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
      for (let i = 0; i < keys.length - SB_CACHE_MAX; i++) delete cache[keys[i]];
    }
    $persistentStore.write(JSON.stringify(cache), SB_CACHE_KEY);
  } catch (e) {}
}

function updateCachedDuration(aid, cid, duration) {
  if (!aid || !cid || !duration) return;
  const key = `${aid}:${cid}`;
  const cache = readSbCache();
  if (cache[key]) {
    cache[key].dur = duration;
    writeSbCache(cache);
  }
}

function normalizeSegments(list) {
  if (!Array.isArray(list)) return [];
  const raw = [];
  for (const item of list) {
    if (!item || !Array.isArray(item.segment) || item.segment.length < 2) continue;
    if (item.actionType && item.actionType !== 'skip') continue;
    const start = Number(item.segment[0]);
    const end = Number(item.segment[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 2) continue;
    raw.push({
      start,
      end,
      label: SB_LABELS[item.category] || '推广广告',
    });
  }
  raw.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg.start <= prev.end + 1) {
      if (seg.end > prev.end) prev.end = seg.end;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

function fetchSponsorSegments(aid, cid, durationHint, cb) {
  if (!aid) return cb([], durationHint || 0);
  const key = `${aid}:${cid || 0}`;
  const now = Date.now();
  const cache = readSbCache();
  const hit = cache[key];
  if (hit && now - hit.ts < SB_CACHE_TTL_MS) {
    if (durationHint && !hit.dur) {
      hit.dur = durationHint;
      writeSbCache(cache);
    }
    return cb(hit.segs || [], durationHint || hit.dur || 0);
  }

  let bvid;
  try {
    bvid = av2bv(aid);
  } catch (e) {
    return cb([], durationHint || 0);
  }

  let url = `https://bsbsb.top/api/skipSegments?videoID=${encodeURIComponent(bvid)}&categories=${encodeURIComponent(SB_CATEGORIES)}`;
  if (cid) url += `&cid=${cid}`;

  $httpClient.get(
    {
      url,
      headers: {
        origin: 'stash-bili-adblock',
        'x-ext-version': '1.0.0',
      },
      timeout: 3,
    },
    (err, resp, data) => {
      if (err || !resp || (resp.status !== 200 && resp.status !== 404)) {
        log(`sb lookup failed (${bvid}): ${err || (resp && resp.status)}`);
        return cb([], durationHint || 0);
      }
      let segs = [];
      if (resp.status === 200 && data) {
        try {
          segs = normalizeSegments(JSON.parse(data));
        } catch (e) {
          segs = [];
        }
      }
      const latest = readSbCache();
      latest[key] = { ts: Date.now(), segs, dur: durationHint || (latest[key] && latest[key].dur) || 0 };
      writeSbCache(latest);
      if (segs.length > 0) {
        log(`sb hit ${bvid} (cid=${cid}): ${segs.map((s) => `${Math.round(s.start)}-${Math.round(s.end)}s`).join(', ')}`);
      }
      cb(segs, latest[key].dur);
    }
  );
}

// ---------------------------------------------------------------------------
// PlayViewUnite: strip AD_FRAGMENT + warm SponsorBlock cache with duration
// ---------------------------------------------------------------------------

function isAdFragmentVideo(b) {
  try {
    for (const fld of parse(b)) {
      // FragmentVideoInfo.fragment_info (1) -> FragmentInfo.fragment_type (3) === 1 (AD_FRAGMENT)
      if (fld.f === 1 && fld.wt === 2) {
        for (const sub of parse(fld.val)) {
          if (sub.f === 3 && sub.wt === 0 && sub.num === 1) return true;
        }
      }
    }
  } catch (e) {}
  return false;
}

function handlePlayViewUnite(raw) {
  const g = unpackGrpc(raw);
  if (!g) return finishGrpc(null);
  let msg = g.msg;
  let changed = false;

  // Strip official AD_FRAGMENT entries in field 10 (FragmentVideo)
  const adStat = { n: 0 };
  const stripped = dropAt(msg, [10, 1], isAdFragmentVideo, adStat);
  if (stripped) {
    msg = stripped;
    changed = true;
    log(`PlayViewUnite: AD_FRAGMENT x${adStat.n}`);
  }

  // Extract aid, cid, duration from PlayArc (field 6) to pre-warm cache for ViewProgress / DmSegMobile
  let aid = 0;
  let cid = 0;
  let duration = 0;
  try {
    for (const fld of parse(msg)) {
      if (fld.f === 6 && fld.wt === 2) {
        for (const af of parse(fld.val)) {
          if (af.f === 2 && af.wt === 0) aid = af.num;
          else if (af.f === 3 && af.wt === 0) cid = af.num;
          else if (af.f === 8 && af.wt === 0) duration = af.num;
        }
      }
    }
  } catch (e) {}

  fetchSponsorSegments(aid, cid, duration, () => {
    finishGrpc(changed ? packGrpc(g.flag, msg) : null);
  });
}

// ---------------------------------------------------------------------------
// ViewProgress: patch Chronos bundle (auto-skip) + inject VideoViewPoint chapters
// ---------------------------------------------------------------------------

const CHRONOS_BASE =
  'https://raw.githubusercontent.com/kokoryh/chronos/69a8996b1f1311b606021e3f194b0390280ab618/';
const CHRONOS_MAP = {
  '45b564f5ba1fdd3746406937059addd8': 'e5a968f1a5055bbe5c12e67b100a6dcb',
  'c29bd8f2b64a8f57f49c3622c0f763db': 'ecca73e42e160074e0caf4b3ddb54a52',
  'c218977c14e5dfdafd51edf3ae49ed02': 'f993a054969a4f6ae6b20a65f1292e47',
  '8232ffb6ee43b687b5fe5add5b3e97de': 'feaca416bbc1174b8e935cf87ff8f0b5',
  '325e7073ffc6fb5263682fecdcd1058f': '932002070dc1b51241198a074d2279fc',
  '3a14beddd23328eaddfe9f0eb048d713': '8c3feda2e92bf60e8a7aeade1a231586',
};

function getReqHeader(name) {
  const h = ($request && $request.headers) || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) return String(h[k] || '');
  }
  return '';
}

function patchChronosField(chronosBytes) {
  const inner = parse(chronosBytes);
  let md5 = '';
  for (const fld of inner) {
    if (fld.f === 1 && fld.wt === 2) {
      md5 = dec.decode(fld.val).toLowerCase();
      break;
    }
  }
  if (!/^[a-f0-9]{32}$/.test(md5)) return null;
  if (Object.values(CHRONOS_MAP).includes(md5)) return null;

  let next = CHRONOS_MAP[md5];
  if (!next) {
    const ua = getReqHeader('user-agent');
    if (/\bbili-hd\b/.test(ua)) next = 'f993a054969a4f6ae6b20a65f1292e47';
    else if (/\bbili-inter\b/.test(ua)) next = '8c3feda2e92bf60e8a7aeade1a231586';
    else next = 'e5a968f1a5055bbe5c12e67b100a6dcb';
  }

  // Replace field 1 (md5) & field 2 (file), drop field 3 (sign), preserve unknown fields
  const kept = inner
    .filter((fld) => fld.f !== 1 && fld.f !== 2 && fld.f !== 3)
    .map((fld) => chronosBytes.subarray(fld.start, fld.end));
  return cat([strField(1, next), strField(2, CHRONOS_BASE + next + '.zip'), ...kept]);
}

function buildVideoPoints(segs, duration) {
  const points = [];
  let cursor = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const s = Math.floor(seg.start);
    const e = Math.ceil(seg.end);
    if (s > cursor) {
      points.push({ from: cursor, to: s, content: i === 0 ? '正片' : '⏭ 跳过广告' });
    }
    points.push({ from: s, to: e, content: '⏩ ' + seg.label });
    cursor = Math.max(cursor, e);
  }
  if (duration > cursor) {
    points.push({ from: cursor, to: Math.ceil(duration), content: '⏭ 跳过广告' });
  }
  return points.map((p) =>
    lenField(
      1,
      cat([
        varintField(1, 2), // type = 2 (chapter / segment)
        varintField(2, p.from),
        varintField(3, p.to),
        strField(4, p.content),
      ])
    )
  );
}

function handleViewProgress(raw) {
  const g = unpackGrpc(raw);
  const reqG = unpackGrpc($request.body);
  if (!g || !reqG) return finishGrpc(null);

  let aid = 0;
  let cid = 0;
  try {
    for (const fld of parse(reqG.msg)) {
      if (fld.f === 1 && fld.wt === 0) aid = fld.num;
      else if (fld.f === 2 && fld.wt === 0) cid = fld.num;
    }
  } catch (e) {}

  fetchSponsorSegments(aid, cid, 0, (segs, duration) => {
    try {
      const pointEntries = segs.length > 0 ? buildVideoPoints(segs, duration) : [];
      const fields = parse(g.msg);
      const parts = [];
      let changed = false;
      let hasGuide = false;

      for (const fld of fields) {
        if (fld.f === 2 && fld.wt === 2) {
          // Field 2 = Chronos: swap to airborne-enabled Chronos zip (enables auto-seek)
          const nc = patchChronosField(fld.val);
          if (nc) {
            parts.push(lenField(2, nc));
            changed = true;
            log('ViewProgress: patched Chronos bundle');
            continue;
          }
        }
        if (fld.f === 1 && fld.wt === 2 && pointEntries.length > 0) {
          hasGuide = true;
          const gFields = parse(fld.val);
          const gParts = [];
          let hasVP = false;
          for (const gf of gFields) {
            if (gf.f === 2 && gf.wt === 2) {
              hasVP = true;
              const vpFields = parse(gf.val);
              const vpParts = [];
              let hasPerm = false;
              for (const vf of vpFields) {
                if (vf.f === 3 && vf.wt === 0) {
                  hasPerm = true;
                  vpParts.push(varintField(3, 1));
                } else {
                  vpParts.push(gf.val.subarray(vf.start, vf.end));
                }
              }
              const adOnly = segs.map((seg) =>
                lenField(
                  1,
                  cat([
                    varintField(1, 2),
                    varintField(2, Math.floor(seg.start)),
                    varintField(3, Math.ceil(seg.end)),
                    strField(4, '⏩ ' + seg.label),
                  ])
                )
              );
              vpParts.push(...adOnly);
              if (!hasPerm) vpParts.push(varintField(3, 1));
              gParts.push(lenField(2, cat(vpParts)));
            } else {
              gParts.push(fld.val.subarray(gf.start, gf.end));
            }
          }
          if (!hasVP) {
            gParts.push(lenField(2, cat([...pointEntries, varintField(3, 1)])));
          }
          parts.push(lenField(1, cat(gParts)));
          changed = true;
          continue;
        }
        parts.push(g.msg.subarray(fld.start, fld.end));
      }

      if (!hasGuide && pointEntries.length > 0) {
        const vp = cat([...pointEntries, varintField(3, 1)]);
        parts.push(lenField(1, lenField(2, vp)));
        changed = true;
      }

      if (pointEntries.length > 0) log(`ViewProgress: injected ${segs.length} sponsor chapter(s)`);
      finishGrpc(changed ? packGrpc(g.flag, cat(parts)) : null);
    } catch (e) {
      log('ViewProgress inject err: ' + e.message);
      finishGrpc(null);
    }
  });
}

// ---------------------------------------------------------------------------
// DmSegMobile: inject Chronos airborne trigger danmaku (auto-seek to ad end)
// ---------------------------------------------------------------------------

function handleDmSegMobile(raw) {
  const g = unpackGrpc(raw);
  const reqG = unpackGrpc($request.body);
  if (!g || !reqG) return finishGrpc(null);

  let aid = 0;
  let cid = 0;
  let type = 0;
  let segIdx = 1;
  let duration = 0;
  try {
    for (const fld of parse(reqG.msg)) {
      if (fld.f === 1 && fld.wt === 0) aid = fld.num;
      else if (fld.f === 2 && fld.wt === 0) cid = fld.num;
      else if (fld.f === 3 && fld.wt === 0) type = fld.num;
      else if (fld.f === 4 && fld.wt === 0) segIdx = fld.num;
      else if (fld.f === 11 && fld.wt === 2) {
        try {
          const j = JSON.parse(dec.decode(fld.val));
          if (j && j.duration) duration = Math.round(j.duration / 1000);
        } catch (e) {}
      }
    }
  } catch (e) {}

  if (type !== 1 || !aid) return finishGrpc(null);
  if (duration) updateCachedDuration(aid, cid, duration);

  fetchSponsorSegments(aid, cid, duration, (segs) => {
    try {
      const winStart = (segIdx - 1) * 360;
      const winEnd = segIdx * 360;
      const inWin = segs.filter((s) => s.start >= winStart && s.start < winEnd);
      if (inWin.length === 0) return finishGrpc(null);

      // Avoid duplicate airborne injection if already present
      const existingActions = new Set();
      try {
        for (const fld of parse(g.msg)) {
          if (fld.f === 1 && fld.wt === 2) {
            for (const ef of parse(fld.val)) {
              if (ef.f === 10 && ef.wt === 2) existingActions.add(dec.decode(ef.val));
            }
          }
        }
      } catch (e) {}

      const injected = [];
      for (const seg of inWin) {
        const startMs = Math.max(500, Math.round(seg.start * 1000));
        const endMs = Math.round(seg.end * 1000);
        const action = 'airborne:' + endMs;
        if (existingActions.has(action)) continue;
        const dmId = 900000000 + Math.floor(startMs);
        injected.push(
          lenField(
            1,
            cat([
              varintField(1, dmId),
              varintField(2, startMs),
              varintField(3, 5),         // mode = 5 (top)
              varintField(4, 50),        // fontsize = 50
              varintField(5, 16777215),  // white
              strField(6, '1948dd5d'),   // midHash
              strField(7, '空指部已就位'), // Chronos airborne trigger text
              varintField(8, 1735660800),
              varintField(9, 11),        // weight = 11
              strField(10, action),      // airborne:<endMs>
              strField(12, String(dmId)),
              varintField(13, 1310724),  // attr
              varintField(25, 1),        // type
              varintField(26, cid),      // oid
              varintField(27, 1),        // dm_from
            ])
          )
        );
      }
      if (injected.length === 0) return finishGrpc(null);

      log(`DmSegMobile(seg=${segIdx}): injected ${injected.length} airborne trigger(s)`);
      finishGrpc(packGrpc(g.flag, cat([g.msg, ...injected])));
    } catch (e) {
      log('DmSegMobile inject err: ' + e.message);
      finishGrpc(null);
    }
  });
}

// ---------------------------------------------------------------------------

(function main() {
  try {
    const body = $response.body;
    if (!body) return $done({});

    // JSON endpoints live under /x/; binary-mode hands them over as decoded bytes.
    if (typeof body === 'string' || /^https:\/\/app\.bilibili\.com\/x\//.test(URL_PATH)) {
      const text = typeof body === 'string' ? body : dec.decode(body);
      const obj = JSON.parse(text);
      if (!handleJson(obj)) return $done({});
      const out = JSON.stringify(obj);
      return $done({ body: typeof body === 'string' ? out : enc.encode(out) });
    }

    // Async SponsorBlock gRPC endpoints
    if (CFG.sponsorBlock) {
      if (/\/bilibili\.app\.playerunite\.v1\.Player\/PlayViewUnite$/.test(URL_PATH)) {
        return handlePlayViewUnite(body);
      }
      if (/\/bilibili\.app\.(view|viewunite)\.v1\.View\/ViewProgress$/.test(URL_PATH)) {
        return handleViewProgress(body);
      }
      if (/\/bilibili\.community\.service\.dm\.v1\.DM\/DmSegMobile$/.test(URL_PATH)) {
        return handleDmSegMobile(body);
      }
    }

    // Synchronous AdBlock gRPC endpoints
    finishGrpc(handleStaticGrpc(body));
  } catch (e) {
    console.log('[bili-adblock] error: ' + (e && e.message ? e.message : e));
    $done({});
  }
})();
