/**
 * Kugou Music Concept Edition (酷狗音乐概念版) iOS App AdBlock
 * Stash response script
 *
 * Handled endpoints:
 *  - gateway.kugou.com/ads.service/v2/lite_v_splash
 *  - gateway.kugou.com/ads.gateway/v2/lite_v_popup
 *  - gateway.kugou.com/ads.gateway/v2/lite_v_youth_my_page_popup
 *  - gateway.kugou.com/ads.gateway/v2/lite_v_youth_player_popup
 *  - gateway.kugou.com/ads.gateway/v2/lite_v_youth_home_banner
 *  - gateway.kugou.com/ads.gateway/v2/lite_v_vip_center
 *  - gateway.kugou.com/ads.gateway/v2/lite_v_search_no_focus
 *  - gateway.kugou.com/youth/v1/yueku/tab
 *  - gateway.kugou.com/youth/v1/account/get_vip_tips
 *  - adservice.kugou.com/v2/lite_v_youth_player_widget
 *  - adservice.kugou.com/v2/lite_v_youth_task_center
 *
 * Arguments (from the override):
 *  - splash   (default: true)  empty splash ads & zero boot/front wait timeouts
 *  - popup    (default: true)  empty popup ads (home, my page, player)
 *  - banner   (default: true)  empty home banner & yueku tab carousel banner
 *  - widget   (default: true)  empty player widget, vip center, task center & vip tips promos
 *  - searchAd (default: true)  empty unfocused search bar promo keywords
 *  - debug    (default: false) log every modification
 */

function parseArguments() {
  const cfg = {
    splash: true,
    popup: true,
    banner: true,
    widget: true,
    searchAd: true,
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
  if (CFG.debug) console.log('[kugou-concept-adblock] ' + msg);
}

/**
 * Empty Kugou's standard `data.ads` container, which is either an Array
 * (e.g. lite_v_splash, lite_v_popup) or a map of slot -> Array
 * (e.g. lite_v_youth_home_banner, lite_v_vip_center, etc.).
 * Returns the number of ad items removed.
 */
function emptyAdsContainer(data) {
  if (!data || typeof data !== 'object' || !('ads' in data)) return 0;
  let removed = 0;
  if (Array.isArray(data.ads)) {
    removed += data.ads.length;
    if (data.ads.length > 0) data.ads = [];
  } else if (data.ads && typeof data.ads === 'object') {
    for (const key of Object.keys(data.ads)) {
      if (Array.isArray(data.ads[key]) && data.ads[key].length > 0) {
        removed += data.ads[key].length;
        data.ads[key] = [];
      }
    }
  }
  return removed;
}

function handleSplash(obj) {
  if (!CFG.splash || !obj || !obj.data) return false;
  let changed = false;
  const removed = emptyAdsContainer(obj.data);
  if (removed > 0) changed = true;

  const conf = obj.data.config;
  if (conf && typeof conf === 'object') {
    const overrides = {
      limit_times: 0,
      boot_display_interval: 86400,
      front_request_interval: 86400,
      boot_fetch_ms: 0,
      front_fetch_ms: 0,
      boot_timeout_ms: 0,
      front_timeout_ms: 0,
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (k in conf && conf[k] !== v) {
        conf[k] = v;
        changed = true;
      }
    }
  }

  if (changed) log(`lite_v_splash: cleared ${removed} ad(s) & disabled splash config`);
  return changed;
}

function handleStandardAdSlot(obj, label, enabled) {
  if (!enabled || !obj || !obj.data) return false;
  const removed = emptyAdsContainer(obj.data);
  if (removed > 0) {
    log(`${label}: cleared ${removed} ad(s)`);
    return true;
  }
  return false;
}

function handleYuekuTab(obj) {
  if (!CFG.banner || !obj || !obj.data || !Array.isArray(obj.data.responses)) return false;
  let changed = false;
  let removed = 0;

  for (const item of obj.data.responses) {
    if (!item || item.module !== 'banner' || typeof item.body !== 'string' || !item.body) {
      continue;
    }
    try {
      const inner = JSON.parse(item.body);
      const n = emptyAdsContainer(inner && inner.data);
      if (n > 0) {
        item.body = JSON.stringify(inner);
        removed += n;
        changed = true;
      }
    } catch (e) {
      log('yueku/tab banner parse err: ' + e.message);
    }
  }

  if (changed) log(`yueku/tab: cleared ${removed} banner item(s)`);
  return changed;
}

function handleVipTips(obj) {
  if (!CFG.widget || !obj || !obj.data || typeof obj.data !== 'object') return false;
  let changed = false;
  if (obj.data.account_tips && Object.keys(obj.data.account_tips).length > 0) {
    obj.data.account_tips = {};
    changed = true;
  }
  if (Array.isArray(obj.data.label_tips) && obj.data.label_tips.length > 0) {
    obj.data.label_tips = [];
    changed = true;
  }
  if (changed) log('account/get_vip_tips: cleared vip promo tips');
  return changed;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

(() => {
  const raw = $response && $response.body;
  if (typeof raw !== 'string' || !raw) return $done({});

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return $done({});
  }

  let changed = false;
  if (/\/ads\.service\/v2\/lite_v_splash$/.test(URL_PATH)) {
    changed = handleSplash(obj);
  } else if (/\/ads\.gateway\/v2\/lite_v_(popup|youth_my_page_popup|youth_player_popup)$/.test(URL_PATH)) {
    changed = handleStandardAdSlot(obj, URL_PATH.split('/').pop(), CFG.popup);
  } else if (/\/ads\.gateway\/v2\/lite_v_youth_home_banner$/.test(URL_PATH)) {
    changed = handleStandardAdSlot(obj, 'lite_v_youth_home_banner', CFG.banner);
  } else if (/\/(ads\.gateway|v2)\/(v2\/)?lite_v_(vip_center|youth_player_widget|youth_task_center)$/.test(URL_PATH)) {
    changed = handleStandardAdSlot(obj, URL_PATH.split('/').pop(), CFG.widget);
  } else if (/\/ads\.gateway\/v2\/lite_v_search_no_focus$/.test(URL_PATH)) {
    changed = handleStandardAdSlot(obj, 'lite_v_search_no_focus', CFG.searchAd);
  } else if (/\/youth\/v1\/yueku\/tab$/.test(URL_PATH)) {
    changed = handleYuekuTab(obj);
  } else if (/\/youth\/v1\/account\/get_vip_tips$/.test(URL_PATH)) {
    changed = handleVipTips(obj);
  }

  $done(changed ? { body: JSON.stringify(obj) } : {});
})();
