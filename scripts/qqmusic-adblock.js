/**
 * QQ Music iOS App AdBlock (Stash response script)
 *
 * One binary-mode script entry serves:
 *  - JSON:     (music|tmead).y.qq.com/maproxy/getInfo
 *  - Protobuf: (music|tmead).y.qq.com/maproxy/getPbCompressAd
 *  - Zlib/JSON: c6?.y.qq.com/tips/fcgi-bin/fcg_get_advert.fcg
 *               c6?.y.qq.com/musichall/fcgi-bin/3g_get_mymusic_topbanner.fcg
 *
 * Arguments (from the override):
 *  - adProxy      (default: true)  empty maproxy getInfo & getPbCompressAd ad responses
 *  - legacyBanner (default: true)  empty fcg_get_advert & 3g_get_mymusic_topbanner responses
 *  - debug        (default: false) log every modification
 */

function parseArguments() {
  const cfg = {
    adProxy: true,
    legacyBanner: true,
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
const enc = new TextEncoder();
const dec = new TextDecoder();

function log(msg) {
  if (CFG.debug) console.log('[qqmusic-adblock] ' + msg);
}

// ---------------------------------------------------------------------------
// Minimal Protobuf parser (field-number level, no schema needed)
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

function parseProto(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    const start = i;
    let key;
    [key, i] = readVarint(b, i);
    const f = Math.floor(key / 8);
    const wt = key & 7;
    if (f === 0) throw new Error('field 0');
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
      i += n;
    } else {
      throw new Error('wire type ' + wt);
    }
    if (i > b.length) throw new Error('truncated');
    out.push({ f, wt, start, end: i });
  }
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

// ---------------------------------------------------------------------------
// Minimal RFC 1950 stored-zlib encoder for QQ Music 5-byte-prefixed responses
// ---------------------------------------------------------------------------

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function wrapQqZlib(jsonStr) {
  const payload = enc.encode(jsonStr);
  const len = payload.length;
  const nlen = (~len) & 0xffff;
  const sum = adler32(payload);
  // 5-byte QQ zero header + 2-byte zlib header (78 01) + 5-byte stored block header + payload + 4-byte adler32
  const out = new Uint8Array(5 + 2 + 5 + len + 4);
  out[5] = 0x78;
  out[6] = 0x01;
  out[7] = 0x01; // final stored block
  out[8] = len & 0xff;
  out[9] = (len >>> 8) & 0xff;
  out[10] = nlen & 0xff;
  out[11] = (nlen >>> 8) & 0xff;
  out.set(payload, 12);
  const tail = 12 + len;
  out[tail] = (sum >>> 24) & 0xff;
  out[tail + 1] = (sum >>> 16) & 0xff;
  out[tail + 2] = (sum >>> 8) & 0xff;
  out[tail + 3] = sum & 0xff;
  return out;
}

function isQqZlibFrame(raw) {
  return (
    raw.length > 6 &&
    raw[0] === 0 &&
    raw[1] === 0 &&
    raw[2] === 0 &&
    raw[3] === 0 &&
    raw[4] === 0 &&
    raw[5] === 0x78
  );
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

function handleMaproxyGetInfo(raw) {
  if (!CFG.adProxy) return null;
  let obj;
  try {
    obj = JSON.parse(dec.decode(raw));
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  let removed = 0;
  let changed = false;

  if (Array.isArray(obj.rpt_msg_pos_ad_info) && obj.rpt_msg_pos_ad_info.length > 0) {
    removed += obj.rpt_msg_pos_ad_info.length;
    obj.rpt_msg_pos_ad_info = [];
    changed = true;
  }
  if (Array.isArray(obj.ad_cache_list) && obj.ad_cache_list.length > 0) {
    removed += obj.ad_cache_list.length;
    obj.ad_cache_list = [];
    changed = true;
  }
  const clearNullKeys = [
    'gdt_contract_splash_pak',
    'gdt_contract_splash_pak_ver',
    'local_cache_pick',
    'disable_feature_splash',
  ];
  for (const k of clearNullKeys) {
    if (obj[k] != null) {
      obj[k] = null;
      changed = true;
    }
  }

  if (!changed) return null;
  log(`maproxy/getInfo: cleared ${removed} ad group(s)`);
  return enc.encode(JSON.stringify(obj));
}

// getPbCompressAd top-level protobuf fields observed:
//   1: ret (varint), 2: user_info (msg), 3: rpt_msg_pos_ad_info (repeated msg),
//   5: time (varint), 7: cookie (string), 9..11, 13: use_local_clock (varint),
//   12: noad report URL (string), 15: ad_cache_list (repeated msg)
const PB_DROP_FIELDS = new Set([3, 12, 15]);

function handleMaproxyGetPbAd(raw) {
  if (!CFG.adProxy) return null;
  let fields;
  try {
    fields = parseProto(raw);
  } catch (e) {
    log('maproxy/getPbCompressAd parse err: ' + e.message);
    return null;
  }

  const parts = [];
  let dropped = 0;
  for (const fld of fields) {
    if (PB_DROP_FIELDS.has(fld.f)) {
      dropped++;
      continue;
    }
    parts.push(raw.subarray(fld.start, fld.end));
  }

  if (dropped === 0) return null;
  log(`maproxy/getPbCompressAd: dropped ${dropped} ad field(s)`);
  return cat(parts);
}

function handleLegacyAdvert(raw) {
  if (!CFG.legacyBanner) return null;
  if (isQqZlibFrame(raw)) {
    log('fcg_get_advert: emptied (zlib frame)');
    return wrapQqZlib('{"code":0,"data":[],"msg":"","subcode":0}');
  }
  try {
    const obj = JSON.parse(dec.decode(raw));
    if (obj && Array.isArray(obj.data) && obj.data.length > 0) {
      obj.data = [];
      log('fcg_get_advert: emptied (json)');
      return enc.encode(JSON.stringify(obj));
    }
  } catch (e) {}
  return null;
}

function handleLegacyTopBanner(raw) {
  if (!CFG.legacyBanner) return null;
  if (isQqZlibFrame(raw)) {
    log('3g_get_mymusic_topbanner: emptied (zlib frame)');
    return wrapQqZlib('{"bannerlist":[],"code":0,"msg":"success"}');
  }
  try {
    const obj = JSON.parse(dec.decode(raw));
    if (obj && Array.isArray(obj.bannerlist) && obj.bannerlist.length > 0) {
      obj.bannerlist = [];
      log('3g_get_mymusic_topbanner: emptied (json)');
      return enc.encode(JSON.stringify(obj));
    }
  } catch (e) {}
  return null;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

(() => {
  const body = $response && $response.body;
  if (!body || !body.length) return $done({});
  const raw = body instanceof Uint8Array ? body : new Uint8Array(body);

  let out = null;
  if (/\/maproxy\/getInfo$/.test(URL_PATH)) {
    out = handleMaproxyGetInfo(raw);
  } else if (/\/maproxy\/getPbCompressAd$/.test(URL_PATH)) {
    out = handleMaproxyGetPbAd(raw);
  } else if (/\/tips\/fcgi-bin\/fcg_get_advert\.fcg$/.test(URL_PATH)) {
    out = handleLegacyAdvert(raw);
  } else if (/\/musichall\/fcgi-bin\/3g_get_mymusic_topbanner\.fcg$/.test(URL_PATH)) {
    out = handleLegacyTopBanner(raw);
  }

  $done(out ? { body: out } : {});
})();
