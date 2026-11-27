/**
 * YouTube iOS App AdBlock & Enhance (Protobuf binary-mode response script for Stash)
 *
 * Features (configurable via Stash override arguments):
 *  - AdBlock (always on):
 *      /youtubei/v1/player, get_watch, browse, search, next,
 *      reel/reel_item_watch, reel/reel_watch_sequence
 *  - bgPlay (default: true):
 *      Unlocks background playback & forces Picture-in-Picture (PiP) in PlayerResponse
 *  - hideShorts (default: false):
 *      Removes Shorts tab from /youtubei/v1/guide & Shorts shelves from browse/search/next
 *  - hideUpload (default: false):
 *      Removes the center Upload (+) button from /youtubei/v1/guide
 *  - debug (default: false):
 *      Logs each modification to Stash script log
 */

function parseArguments() {
  const cfg = {
    bgPlay: true,
    hideShorts: false,
    hideUpload: false,
    debug: false,
  };
  if (typeof $argument !== 'string' || !$argument) return cfg;
  const pairs = $argument.split('&');
  for (let i = 0; i < pairs.length; i++) {
    const idx = pairs[i].indexOf('=');
    if (idx === -1) continue;
    const k = pairs[i].slice(0, idx).trim();
    const v = pairs[i].slice(idx + 1).trim().toLowerCase();
    if (k in cfg) {
      cfg[k] = v === 'true' || v === '1' || v === 'on';
    }
  }
  return cfg;
}

const CFG = parseArguments();

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
  42, // adSlots (legacy)
  68, // adSlots (YouTube iOS v21+)
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

function makeTag(fieldNumber, wireType) {
  return fieldNumber * 8 + wireType;
}

function encodeVarintField(fieldNumber, value) {
  const tb = encodeVarint(makeTag(fieldNumber, 0));
  const vb = encodeVarint(value);
  const out = new Uint8Array(tb.length + vb.length);
  out.set(tb, 0);
  out.set(vb, tb.length);
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
 * Checks whether an elementRenderer (153515154) or its wrapper message is an ad (or Shorts if hideShorts is on).
 */
function isFilteredElement(buf, start, end, depth) {
  if (depth > 6) return false;
  if (
    bytesContainAscii(buf, start, end, 'pagead/adview') ||
    bytesContainAscii(buf, start, end, 'pagead/interaction') ||
    bytesContainAscii(buf, start, end, 'googlesyndication.com') ||
    bytesContainAscii(buf, start, end, 'ad_badge.eml')
  ) {
    return true;
  }
  if (
    CFG.hideShorts &&
    (bytesContainAscii(buf, start, end, 'shorts_video_cell.eml') ||
      bytesContainAscii(buf, start, end, 'shorts_lockup.eml') ||
      bytesContainAscii(buf, start, end, 'shorts_shelf'))
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
      if (isFilteredElement(buf, f.valStart, f.valEnd, depth + 1)) return true;
    }
  }
  return false;
}

// Pre-encoded protobuf blobs for Background Playback & Picture-in-Picture (PiP)
const BG_PLAY_FIELD = encodeLengthDelimited(
  makeTag(11, 2),
  encodeLengthDelimited(makeTag(64657230, 2), encodeVarintField(1, 1))
);
const PIP_ACTIVE_FIELD = encodeLengthDelimited(
  makeTag(21, 2),
  encodeLengthDelimited(makeTag(151635310, 2), encodeVarintField(1, 1))
);

/**
 * Unlocks Background Playback (field 11 -> 64657230 -> 1=1) and PiP (field 21 -> 151635310 -> 1=1)
 * inside PlayerResponse.playabilityStatus (field 2).
 */
function enhancePlayabilityStatus(buf, start, end) {
  const fields = parseFields(buf, start, end);
  if (!fields) return null;

  let modified = false;
  let hasBg = false;
  let hasPip = false;
  const parts = [];

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.fn === 11 && f.wt === 2) {
      hasBg = true;
      parts.push(BG_PLAY_FIELD);
      modified = true;
      continue;
    }
    if (f.fn === 21 && f.wt === 2) {
      hasPip = true;
      // Check if 151635310 -> 1 is already 1; if not, patch it
      const pipWrap = parseFields(buf, f.valStart, f.valEnd);
      if (pipWrap && pipWrap.length === 1 && pipWrap[0].fn === 151635310 && pipWrap[0].wt === 2) {
        const inner = parseFields(buf, pipWrap[0].valStart, pipWrap[0].valEnd);
        if (inner) {
          let activeOk = false;
          const innerParts = [];
          for (let j = 0; j < inner.length; j++) {
            if (inner[j].fn === 1 && inner[j].wt === 0) {
              const [v] = readVarint(buf, inner[j].valStart, inner[j].valEnd);
              if (v === 1) {
                activeOk = true;
                innerParts.push(buf.subarray(inner[j].rawStart, inner[j].rawEnd));
              } else {
                innerParts.push(encodeVarintField(1, 1));
                modified = true;
              }
            } else {
              innerParts.push(buf.subarray(inner[j].rawStart, inner[j].rawEnd));
            }
          }
          if (!activeOk) {
            innerParts.push(encodeVarintField(1, 1));
            modified = true;
          }
          if (modified) {
            const newInner = encodeLengthDelimited(pipWrap[0].tag, concatParts(innerParts));
            parts.push(encodeLengthDelimited(f.tag, newInner));
            continue;
          }
        }
      }
      parts.push(buf.subarray(f.rawStart, f.rawEnd));
      continue;
    }
    parts.push(buf.subarray(f.rawStart, f.rawEnd));
  }

  if (!hasBg) {
    parts.push(BG_PLAY_FIELD);
    modified = true;
  }
  if (!hasPip) {
    parts.push(PIP_ACTIVE_FIELD);
    modified = true;
  }

  return modified ? concatParts(parts) : null;
}

/**
 * Strips PlayerResponse ad fields (7, 13, 42, 68, 69) and optionally unlocks bgPlay/PiP.
 */
function filterPlayerResponse(buf, start, end, stats) {
  const fields = parseFields(buf, start, end);
  if (!fields) return { modified: false, bytes: null };
  let modified = false;
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (PLAYER_AD_FIELDS.has(f.fn)) {
      stats.removed++;
      modified = true;
      continue;
    }
    if (CFG.bgPlay && f.fn === 2 && f.wt === 2) {
      const enhanced = enhancePlayabilityStatus(buf, f.valStart, f.valEnd);
      if (enhanced) {
        stats.enhanced = true;
        modified = true;
        parts.push(encodeLengthDelimited(f.tag, enhanced));
        continue;
      }
    }
    parts.push(buf.subarray(f.rawStart, f.rawEnd));
  }
  if (!modified) return { modified: false, bytes: null };
  return { modified: true, bytes: concatParts(parts) };
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
      if (isFilteredElement(buf, f.valStart, f.valEnd, 0)) {
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
      if (f.fn === 153515154) {
        if (isFilteredElement(buf, f.valStart, f.valEnd, 1)) {
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

  if (currentFn === 50195462 && droppedItemCount > 0 && keptItemCount === 0) {
    return 'EMPTY';
  }
  if (modified && parts.length === 0) {
    return 'EMPTY';
  }
  return modified ? concatParts(parts) : null;
}

/**
 * Filters /youtubei/v1/guide bottom pivotBar items (FEshorts / FEuploads).
 */
function filterPivotBar(buf, start, end, stats) {
  const fields = parseFields(buf, start, end);
  if (!fields) return null;
  let modified = false;
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.fn === 1 && f.wt === 2) {
      const dropShorts = CFG.hideShorts && bytesContainAscii(buf, f.valStart, f.valEnd, 'FEshorts');
      const dropUpload = CFG.hideUpload && bytesContainAscii(buf, f.valStart, f.valEnd, 'FEuploads');
      if (dropShorts || dropUpload) {
        modified = true;
        stats.removed++;
        continue;
      }
    }
    parts.push(buf.subarray(f.rawStart, f.rawEnd));
  }
  return modified ? concatParts(parts) : null;
}

function filterGuideResponse(buf, stats) {
  if (!CFG.hideShorts && !CFG.hideUpload) return null;
  const fields = parseFields(buf, 0, buf.length);
  if (!fields) return null;
  let modified = false;
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if ((f.fn === 4 || f.fn === 6) && f.wt === 2) {
      const sub = parseFields(buf, f.valStart, f.valEnd);
      if (sub) {
        let subMod = false;
        const subParts = [];
        for (let j = 0; j < sub.length; j++) {
          const sf = sub[j];
          if (sf.fn === 117866661 && sf.wt === 2) {
            const pb = filterPivotBar(buf, sf.valStart, sf.valEnd, stats);
            if (pb) {
              subMod = true;
              subParts.push(encodeLengthDelimited(sf.tag, pb));
              continue;
            }
          }
          subParts.push(buf.subarray(sf.rawStart, sf.rawEnd));
        }
        if (subMod) {
          modified = true;
          parts.push(encodeLengthDelimited(f.tag, concatParts(subParts)));
          continue;
        }
      }
    }
    parts.push(buf.subarray(f.rawStart, f.rawEnd));
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
        const pr = filterPlayerResponse(buf, inner[0].valStart, inner[0].valEnd, stats);
        if (pr.modified) {
          const wrapped = encodeLengthDelimited(inner[0].tag, pr.bytes);
          parts.push(encodeLengthDelimited(f.tag, wrapped));
          modified = true;
          continue;
        }
      } else {
        const pr = filterPlayerResponse(buf, f.valStart, f.valEnd, stats);
        if (pr.modified) {
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
        isFilteredElement(buf, f.valStart, f.valEnd, 0)
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
      const pr = filterPlayerResponse(buf, f.valStart, f.valEnd, stats);
      if (pr.modified) {
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

    const stats = { removed: 0, enhanced: false };
    let out = null;

    if (/\/youtubei\/v1\/player(\?|$)/.test(url)) {
      const res = filterPlayerResponse(body, 0, body.length, stats);
      if (res.modified) out = res.bytes;
    } else if (url.indexOf('/youtubei/v1/get_watch') !== -1) {
      out = filterGetWatch(body, stats);
    } else if (url.indexOf('/youtubei/v1/guide') !== -1) {
      out = filterGuideResponse(body, stats);
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

    if (out && (stats.removed > 0 || stats.enhanced)) {
      if (CFG.debug) {
        console.log(
          `[YouTube Enhance] ${url.split('?')[0].replace('https://youtubei.googleapis.com', '')}: removed=${stats.removed}, bgPlay=${stats.enhanced}, bytes=${body.length}->${out.length}`
        );
      }
      $done({ body: out });
    } else {
      $done({});
    }
  } catch (err) {
    console.log('[YouTube Enhance] error: ' + err);
    $done({});
  }
})();
