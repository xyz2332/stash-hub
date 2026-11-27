/**
 * YouTube iOS App AdBlock (Protobuf binary-mode response script for Stash)
 *
 * Targets InnerTube application/x-protobuf responses:
 *  - /youtubei/v1/player                  (pre-roll, mid-roll, post-roll ads)
 *  - /youtubei/v1/get_watch               (combined player + next)
 *  - /youtubei/v1/browse                  (home / feed / continuation ads)
 *  - /youtubei/v1/search                  (search result ads)
 *  - /youtubei/v1/next                    (watch-page companion & feed ads)
 *  - /youtubei/v1/reel/reel_item_watch    (Shorts player ads)
 *  - /youtubei/v1/reel/reel_watch_sequence (Shorts feed ads)
 */

const AD_EML_PATTERNS = [
  'video_display_full',
  'video_display_carousel',
  'video_display_button',
  'video_ads_lockup',
  'feed_ad_',
  'banner_text_icon_buttoned_layout',
  'text_image_button_group_layout',
  'full_width_square_image_layout',
  'landscape_image_wide_button_layout',
  'square_image_layout',
  'image_text_button',
  'product_carousel',
  'shopping_carousel',
  'shopping_item_card',
  'brand_video_singleton',
  'carousel_ad',
  'display_ad',
  'ad_badge',
  'ad_slot',
  'ad_card',
  'ad_details',
  'ad_cta',
  'ads_',
  '_ad_',
  'in_feed_ad',
  'in_feed_survey',
  'reel_ad',
  'statement_banner',
  'mealbar_promo',
  'premium_upsell',
  'promoted',
  'sponsored',
  'merchandise',
  'paid_content',
];

// Known ad renderer protobuf field numbers inside section/item/rich containers
const AD_RENDERER_FIELDS = new Set([
  424701016, // adSlotRenderer
  152873793, // promotedSparklesWebRenderer / promotedSparklesTextSearchRenderer
  120280839, // compactPromotedItemRenderer
  55504968,  // displayAdRenderer
  96907215,  // mealbarPromoRenderer
  263638641, // statementBannerRenderer
]);

// PlayerResponse top-level ad field numbers
const PLAYER_AD_FIELDS = new Set([
  7,  // adPlacements
  13, // playerAds
  42, // adSlots
  69, // adBreakHeartbeatParams
]);

function readVarint(buf, pos, end) {
  let res = 0;
  let shift = 0;
  while (pos < end) {
    const b = buf[pos++];
    res += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return [res, pos];
    shift += 7;
    if (shift > 53) return [-1, pos];
  }
  return [-1, pos];
}

function encodeVarint(val) {
  const out = [];
  let v = val;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

function parseFields(buf, start, end) {
  const fields = [];
  let pos = start;
  while (pos < end) {
    const rawStart = pos;
    const [tag, p1] = readVarint(buf, pos, end);
    if (tag <= 0 || p1 > end) return null;
    const fn = Math.floor(tag / 8);
    const wt = tag & 7;
    if (fn === 0 || fn > 600000000) return null;
    pos = p1;
    let valStart = pos;
    let valEnd = pos;
    if (wt === 0) {
      const [v, p2] = readVarint(buf, pos, end);
      if (v < 0 || p2 > end) return null;
      valEnd = p2;
      pos = p2;
    } else if (wt === 1) {
      pos += 8;
      if (pos > end) return null;
      valEnd = pos;
    } else if (wt === 2) {
      const [len, p2] = readVarint(buf, pos, end);
      if (len < 0 || p2 + len > end) return null;
      valStart = p2;
      valEnd = p2 + len;
      pos = valEnd;
    } else if (wt === 5) {
      pos += 4;
      if (pos > end) return null;
      valEnd = pos;
    } else {
      return null;
    }
    fields.push({ fn, wt, tag, rawStart, rawEnd: pos, valStart, valEnd });
  }
  return pos === end ? fields : null;
}

function concatParts(parts) {
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  return out;
}

function encodeLengthDelimited(tag, payload) {
  const tagBytes = encodeVarint(tag);
  const lenBytes = encodeVarint(payload.length);
  const out = new Uint8Array(tagBytes.length + lenBytes.length + payload.length);
  out.set(tagBytes, 0);
  out.set(lenBytes, tagBytes.length);
  out.set(payload, tagBytes.length + lenBytes.length);
  return out;
}

function bytesContainAscii(buf, start, end, needle) {
  const nLen = needle.length;
  const limit = end - nLen;
  if (limit < start) return false;
  const first = needle.charCodeAt(0);
  for (let i = start; i <= limit; i++) {
    if (buf[i] === first) {
      let ok = true;
      for (let j = 1; j < nLen; j++) {
        if (buf[i + j] !== needle.charCodeAt(j)) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
  }
  return false;
}

function readAsciiString(buf, start, end) {
  if (end <= start || end - start > 256) return null;
  let s = '';
  for (let i = start; i < end; i++) {
    const b = buf[i];
    if (b < 32 || b > 126) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

function isAdEmlString(str) {
  if (!str) return false;
  const lower = str.toLowerCase();
  for (let i = 0; i < AD_EML_PATTERNS.length; i++) {
    if (lower.indexOf(AD_EML_PATTERNS[i]) !== -1) return true;
  }
  return false;
}

/**
 * Checks whether an elementRenderer (153515154) or its wrapper message is an ad.
 */
function isAdElement(buf, start, end, depth) {
  if (depth > 6) return false;
  if (
    bytesContainAscii(buf, start, end, 'pagead/adview') ||
    bytesContainAscii(buf, start, end, 'pagead/interaction') ||
    bytesContainAscii(buf, start, end, 'googlesyndication.com') ||
    bytesContainAscii(buf, start, end, 'ad_badge.eml')
  ) {
    return true;
  }
  const fields = parseFields(buf, start, end);
  if (!fields) return false;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (AD_RENDERER_FIELDS.has(f.fn)) return true;
    if (f.wt !== 2) continue;
    if (f.fn === 1 && depth >= 2) {
      const s = readAsciiString(buf, f.valStart, f.valEnd);
      if (s && s.indexOf('.eml') !== -1 && isAdEmlString(s)) return true;
    }
    if (
      f.fn === 153515154 ||
      f.fn === 172660663 ||
      f.fn === 168777401 ||
      f.fn === 172035250 ||
      f.fn === 183314536 ||
      f.fn === 1 ||
      f.fn === 2 ||
      f.fn === 3
    ) {
      if (isAdElement(buf, f.valStart, f.valEnd, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Strips PlayerResponse ad fields (7, 13, 42, 69).
 * Returns { modified, bytes, removed }.
 */
function filterPlayerResponse(buf, start, end) {
  const fields = parseFields(buf, start, end);
  if (!fields) return { modified: false, bytes: null, removed: 0 };
  let removed = 0;
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (PLAYER_AD_FIELDS.has(f.fn)) {
      removed++;
      continue;
    }
    parts.push(buf.subarray(f.rawStart, f.rawEnd));
  }
  if (removed === 0) return { modified: false, bytes: null, removed: 0 };
  return { modified: true, bytes: concatParts(parts), removed };
}

/**
 * Recursively filters feed / search / watch-next protobuf containers.
 * Skips top-level ResponseContext (1) and frameworkUpdates (777) for speed.
 */
function filterFeedMessage(buf, start, end, currentFn, depth, stats) {
  if (depth > 12) return null;
  const fields = parseFields(buf, start, end);
  if (!fields) return null;

  let modified = false;
  const parts = [];
  let keptItemCount = 0;
  let droppedItemCount = 0;

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];

    if (depth === 0 && (f.fn === 1 || f.fn === 777)) {
      parts.push(buf.subarray(f.rawStart, f.rawEnd));
      continue;
    }

    if (AD_RENDERER_FIELDS.has(f.fn)) {
      modified = true;
      stats.removed++;
      continue;
    }

    // Inside itemSectionRenderer (50195462), field 1 is repeated ItemSectionContent
    if (currentFn === 50195462 && f.fn === 1 && f.wt === 2) {
      if (isAdElement(buf, f.valStart, f.valEnd, 0)) {
        modified = true;
        droppedItemCount++;
        stats.removed++;
        continue;
      }
      keptItemCount++;
      parts.push(buf.subarray(f.rawStart, f.rawEnd));
      continue;
    }

    if (f.wt === 2 && f.valEnd - f.valStart >= 16) {
      // Direct elementRenderer (e.g. companion banner in watchNext)
      if (f.fn === 153515154) {
        if (isAdElement(buf, f.valStart, f.valEnd, 1)) {
          modified = true;
          stats.removed++;
          continue;
        }
        parts.push(buf.subarray(f.rawStart, f.rawEnd));
        continue;
      }

      const subResult = filterFeedMessage(buf, f.valStart, f.valEnd, f.fn, depth + 1, stats);
      if (subResult === 'EMPTY') {
        modified = true;
        continue;
      }
      if (subResult) {
        modified = true;
        parts.push(encodeLengthDelimited(f.tag, subResult));
        continue;
      }
    }

    parts.push(buf.subarray(f.rawStart, f.rawEnd));
  }

  // Drop empty itemSectionRenderer after all its ad items are removed
  if (currentFn === 50195462 && droppedItemCount > 0 && keptItemCount === 0) {
    return 'EMPTY';
  }
  if (modified && parts.length === 0) {
    return 'EMPTY';
  }
  return modified ? concatParts(parts) : null;
}

/**
 * Filters ReelItemWatchResponse (embedded PlayerResponse in field 3 or 3 -> 139970731).
 */
function filterReelItemWatch(buf, stats) {
  const fields = parseFields(buf, 0, buf.length);
  if (!fields) return null;
  let modified = false;
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.fn === 3 && f.wt === 2) {
      const inner = parseFields(buf, f.valStart, f.valEnd);
      if (inner && inner.length === 1 && inner[0].fn === 139970731 && inner[0].wt === 2) {
        const pr = filterPlayerResponse(buf, inner[0].valStart, inner[0].valEnd);
        if (pr.modified) {
          stats.removed += pr.removed;
          const wrapped = encodeLengthDelimited(inner[0].tag, pr.bytes);
          parts.push(encodeLengthDelimited(f.tag, wrapped));
          modified = true;
          continue;
        }
      } else {
        const pr = filterPlayerResponse(buf, f.valStart, f.valEnd);
        if (pr.modified) {
          stats.removed += pr.removed;
          parts.push(encodeLengthDelimited(f.tag, pr.bytes));
          modified = true;
          continue;
        }
      }
    }
    parts.push(buf.subarray(f.rawStart, f.rawEnd));
  }
  return modified ? concatParts(parts) : null;
}

/**
 * Filters ReelWatchSequenceResponse (drops ad entries in field 2).
 */
function filterReelWatchSequence(buf, stats) {
  const fields = parseFields(buf, 0, buf.length);
  if (!fields) return null;
  let modified = false;
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.fn === 2 && f.wt === 2) {
      if (
        bytesContainAscii(buf, f.valStart, f.valEnd, 'pagead') ||
        bytesContainAscii(buf, f.valStart, f.valEnd, 'ad_slot') ||
        bytesContainAscii(buf, f.valStart, f.valEnd, 'reel_ad') ||
        isAdElement(buf, f.valStart, f.valEnd, 0)
      ) {
        modified = true;
        stats.removed++;
        continue;
      }
    }
    parts.push(buf.subarray(f.rawStart, f.rawEnd));
  }
  return modified ? concatParts(parts) : null;
}

/**
 * Filters GetWatchResponse (field 2 = PlayerResponse, field 3 = NextResponse).
 */
function filterGetWatch(buf, stats) {
  const fields = parseFields(buf, 0, buf.length);
  if (!fields) return null;
  let modified = false;
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.fn === 2 && f.wt === 2) {
      const pr = filterPlayerResponse(buf, f.valStart, f.valEnd);
      if (pr.modified) {
        stats.removed += pr.removed;
        parts.push(encodeLengthDelimited(f.tag, pr.bytes));
        modified = true;
        continue;
      }
    } else if (f.fn === 3 && f.wt === 2) {
      const nr = filterFeedMessage(buf, f.valStart, f.valEnd, 0, 0, stats);
      if (nr && nr !== 'EMPTY') {
        parts.push(encodeLengthDelimited(f.tag, nr));
        modified = true;
        continue;
      }
    }
    parts.push(buf.subarray(f.rawStart, f.rawEnd));
  }
  return modified ? concatParts(parts) : null;
}

(function main() {
  try {
    const url = ($request && $request.url) || '';
    const body = $response && $response.body;
    if (!body || !(body instanceof Uint8Array) || body.length === 0) {
      $done({});
      return;
    }

    const stats = { removed: 0 };
    let out = null;

    if (/\/youtubei\/v1\/player(\?|$)/.test(url)) {
      const res = filterPlayerResponse(body, 0, body.length);
      if (res.modified) {
        stats.removed = res.removed;
        out = res.bytes;
      }
    } else if (url.indexOf('/youtubei/v1/get_watch') !== -1) {
      out = filterGetWatch(body, stats);
    } else if (url.indexOf('/youtubei/v1/reel/reel_item_watch') !== -1) {
      out = filterReelItemWatch(body, stats);
    } else if (url.indexOf('/youtubei/v1/reel/reel_watch_sequence') !== -1) {
      out = filterReelWatchSequence(body, stats);
    } else if (
      url.indexOf('/youtubei/v1/browse') !== -1 ||
      url.indexOf('/youtubei/v1/search') !== -1 ||
      url.indexOf('/youtubei/v1/next') !== -1
    ) {
      const res = filterFeedMessage(body, 0, body.length, 0, 0, stats);
      if (res && res !== 'EMPTY') out = res;
    }

    if (out && stats.removed > 0) {
      console.log(
        `[YouTube AdBlock] ${url.split('?')[0].replace('https://youtubei.googleapis.com', '')}: removed=${stats.removed}, bytes=${body.length}->${out.length}`
      );
      $done({ body: out });
    } else {
      $done({});
    }
  } catch (err) {
    console.log('[YouTube AdBlock] error: ' + err);
    $done({});
  }
})();
