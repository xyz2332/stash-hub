/**
 * Baidu Netdisk iOS App AdBlock & UI Cleanup (Stash response script)
 *
 * Arguments (from the override):
 *  - adBlock (default: true)  strip popups, banners, reward-ad prompts, ad switches & album promos
 *  - cleanUI (default: true)  strip game center, coin bubbles, novel/shortplay, search promos & AI spam cards
 *  - debug   (default: false) log every modification
 */

function parseArguments() {
  const cfg = {
    adBlock: true,
    cleanUI: true,
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
  if (CFG.debug) console.log('[baidupan-adblock] ' + msg);
}

const KINGKONG_DROP = new Set(['novel', 'shortplay', 'game', 'live', 'mall']);

const ALBUM_PROMO_KEYS = [
  'album_find_photo_top_banner',
  'album_story_list_yike',
  'album_story_list_yike_new',
  'album_story_tab_day_view_yike_operation_json',
];

function handleJson(obj) {
  if (!obj || typeof obj !== 'object') return false;

  // --- adBlock endpoints ---

  if (/\/act\/api\/activityentry$/.test(URL_PATH)) {
    if (!CFG.adBlock) return false;
    if (Array.isArray(obj.popup_list) && obj.popup_list.length > 0) {
      log(`activityentry: cleared ${obj.popup_list.length} popup(s)`);
      obj.popup_list = [];
      return true;
    }
    return false;
  }

  if (/\/rest\/2\.0\/pcs\/adv$/.test(URL_PATH)) {
    if (!CFG.adBlock) return false;
    let changed = false;
    if (Array.isArray(obj.scene_list) && obj.scene_list.length > 0) {
      log(`pcs/adv: cleared ${obj.scene_list.length} ad scene(s)`);
      obj.scene_list = [];
      changed = true;
    }
    if (obj.open_in_app) {
      obj.open_in_app = 0;
      changed = true;
    }
    return changed;
  }

  if (/\/buy\/ad\/(conf|get)$/.test(URL_PATH)) {
    if (!CFG.adBlock) return false;
    obj.data = {};
    if (Array.isArray(obj.ad_list)) obj.ad_list = [];
    log(`${URL_PATH.split('/').slice(-2).join('/')}: emptied`);
    return true;
  }

  if (/\/api\/getconfig$/.test(URL_PATH)) {
    if (!CFG.adBlock || !Array.isArray(obj.list)) return false;
    let changed = false;
    for (const item of obj.list) {
      if (!item || typeof item.value !== 'string') continue;
      if (item.conf_key === 'public_activite_setting') {
        try {
          const v = JSON.parse(item.value);
          if (Array.isArray(v.activity_list) && v.activity_list.length > 0) {
            v.activity_list = [];
            item.value = JSON.stringify(v);
            changed = true;
            log('getconfig: cleared public_activite_setting.activity_list');
          }
        } catch (e) {}
      } else if (item.conf_key === 'public_system_setting') {
        try {
          const v = JSON.parse(item.value);
          const disableKeys = [
            'advertise_video_switch',
            'advertise_video_download_switch',
            'setting_page_advertise_banner_present_switch',
            'how_share_distribution_prompt',
            'commerce_qrcode_duxiaoman_switch',
          ];
          let mod = false;
          for (const k of disableKeys) {
            if (v[k]) {
              v[k] = 0;
              mod = true;
            }
          }
          if (mod) {
            item.value = JSON.stringify(v);
            changed = true;
            log('getconfig: disabled public_system_setting ad switches');
          }
        } catch (e) {}
      }
    }
    return changed;
  }

  if (/\/api\/getsyscfg$/.test(URL_PATH)) {
    let changed = false;
    if (CFG.adBlock) {
      const albumCfg = obj.public_album_config;
      if (albumCfg && Array.isArray(albumCfg.cfg_list)) {
        for (const node of albumCfg.cfg_list) {
          if (!node || node.node_key !== 'album_operation') continue;
          for (const k of ALBUM_PROMO_KEYS) {
            if (node[k]) {
              node[k] = '';
              changed = true;
            }
          }
        }
        if (changed) log('getsyscfg: cleared album_operation promo banners');
      }
    }
    if (CFG.cleanUI) {
      const genflow = obj.genflow_fe_sugs;
      if (genflow && Array.isArray(genflow.cfg_list)) {
        let gfChanged = false;
        for (const node of genflow.cfg_list) {
          if (!node) continue;
          if (node.genflow_home_sug) {
            node.genflow_home_sug = '{"sugs":[]}';
            gfChanged = true;
          }
          if (node.personaAgentMemoryQuery) {
            node.personaAgentMemoryQuery = '';
            gfChanged = true;
          }
          if (node.proactiveFoldAllTitle) {
            node.proactiveFoldAllTitle = '';
            gfChanged = true;
          }
        }
        if (gfChanged) {
          changed = true;
          log('getsyscfg: cleared genflow_fe_sugs');
        }
      }
    }
    return changed;
  }

  if (/\/api\/notice\/list$/.test(URL_PATH)) {
    if (!CFG.adBlock || !obj.data || !Array.isArray(obj.data.list) || obj.data.list.length === 0) {
      return false;
    }
    log(`api/notice/list: cleared ${obj.data.list.length} promo notice(s)`);
    obj.data.list = [];
    return true;
  }

  if (/\/rest\/2\.0\/membership\/product$/.test(URL_PATH)) {
    if (!CFG.adBlock || !obj.data || typeof obj.data !== 'object') return false;
    const d = obj.data;
    let changed = false;
    if (d.secondary_ad_video && d.secondary_ad_video !== '0') {
      d.secondary_ad_video = '0';
      changed = true;
    }
    for (const k of ['advanced_search_before_banner', 'advanced_search_after_banner', 'guide_transfer_nahalffloating']) {
      if (d[k]) {
        d[k] = 0;
        changed = true;
      }
    }
    if (changed) log('membership/product: disabled ad/banner flags');
    return changed;
  }

  if (/\/rest\/2\.0\/membership\/user$/.test(URL_PATH)) {
    if (!CFG.cleanUI) return false;
    let changed = false;
    if (obj.new_guide_data && Array.isArray(obj.new_guide_data.sub_card_list) && obj.new_guide_data.sub_card_list.length > 0) {
      obj.new_guide_data.sub_card_list = [];
      changed = true;
    }
    if (obj.v10_guide) {
      delete obj.v10_guide;
      changed = true;
    }
    if (obj.tips_data && obj.tips_data.title) {
      obj.tips_data = {};
      changed = true;
    }
    if (Array.isArray(obj.tips_data_list) && obj.tips_data_list.length > 0) {
      obj.tips_data_list = [];
      changed = true;
    }
    if (changed) log('membership/user?method=guide: cleared My-page promo cards/tips');
    return changed;
  }

  // --- cleanUI endpoints ---

  if (/\/coins\/center\/notice$/.test(URL_PATH)) {
    if (!CFG.cleanUI || !obj.data || typeof obj.data !== 'object') return false;
    obj.data = {};
    log('coins/center/notice: emptied task/coin center card');
    return true;
  }

  if (/\/feed\/kingkongdistrict$/.test(URL_PATH)) {
    if (!CFG.cleanUI || !obj.data || !Array.isArray(obj.data.data)) return false;
    const before = obj.data.data.length;
    obj.data.data = obj.data.data.filter((item) => !KINGKONG_DROP.has(String(item && item.type)));
    if (obj.data.data.length !== before) {
      log(`kingkongdistrict: removed ${before - obj.data.data.length} of ${before}`);
      return true;
    }
    return false;
  }

  if (/\/act\/v2\/gamecenter\/(recommend|gametaskinfo|historyplay)$/.test(URL_PATH)) {
    if (!CFG.cleanUI || !obj.data) return false;
    if (Array.isArray(obj.data)) {
      obj.data = [];
    } else if (typeof obj.data === 'object') {
      if (Array.isArray(obj.data.info)) obj.data.info = [];
      if (Array.isArray(obj.data.list)) obj.data.list = [];
      if (Array.isArray(obj.data.task_list)) obj.data.task_list = [];
    }
    log(`${URL_PATH.split('/').pop()}: emptied gamecenter`);
    return true;
  }

  if (/\/act\/v2\/(lifeguide\/home|ipcultivate\/noticelist)$/.test(URL_PATH)) {
    if (!CFG.cleanUI) return false;
    obj.data = {};
    if (Array.isArray(obj.list)) obj.list = [];
    log(`${URL_PATH.split('/').slice(-2).join('/')}: emptied`);
    return true;
  }

  if (/\/recommend\/searchbox\/bottom$/.test(URL_PATH)) {
    if (!CFG.cleanUI || !obj.data || !Array.isArray(obj.data.list) || obj.data.list.length === 0) {
      return false;
    }
    log(`searchbox/bottom: cleared ${obj.data.list.length} placeholder(s)`);
    obj.data.list = [];
    return true;
  }

  if (/\/recommend\/shortseries\/list$/.test(URL_PATH)) {
    if (!CFG.cleanUI || !obj.data || typeof obj.data !== 'object') return false;
    let changed = false;
    if (Array.isArray(obj.data.list) && obj.data.list.length > 0) {
      obj.data.list = [];
      changed = true;
    }
    if (Array.isArray(obj.data.feed_list) && obj.data.feed_list.length > 0) {
      obj.data.feed_list = [];
      changed = true;
    }
    if (changed) log('recommend/shortseries/list: cleared video short-drama feed');
    return changed;
  }

  if (/\/recommend\/yunyiduo\/personal$/.test(URL_PATH)) {
    if (!CFG.cleanUI || !obj.data || typeof obj.data !== 'object') return false;
    let changed = false;
    if (Array.isArray(obj.data.conversation) && obj.data.conversation.length > 0) {
      obj.data.conversation = [];
      changed = true;
    }
    if (Array.isArray(obj.data.card_list) && obj.data.card_list.length > 0) {
      obj.data.card_list = [];
      changed = true;
    }
    if (changed) log('recommend/yunyiduo/personal: cleared AI video prompts');
    return changed;
  }

  if (/\/aisearch\/kukuai\/inspirationcards$/.test(URL_PATH)) {
    if (!CFG.cleanUI || !Array.isArray(obj.list) || obj.list.length === 0) return false;
    log(`inspirationcards: cleared ${obj.list.length} card(s)`);
    obj.list = [];
    obj.has_more = false;
    return true;
  }

  if (/\/rest\/2\.0\/xpan\/smartprogram$/.test(URL_PATH)) {
    if (!CFG.cleanUI || !Array.isArray(obj.list) || obj.list.length === 0) return false;
    const before = obj.list.length;
    obj.list = obj.list.filter((item) => {
      const ent = String((item && item.entrance) || '');
      const name = String((item && item.name) || '');
      // Drop commercial print/video square mini-programs, keep document/PDF utilities
      if (ent.includes(',square,') || /冲印|印品|打印|爱奇艺/.test(name)) return false;
      return true;
    });
    if (obj.list.length !== before) {
      log(`smartprogram: removed ${before - obj.list.length} of ${before}`);
      return true;
    }
    return false;
  }

  return false;
}

(() => {
  const raw = $response && $response.body;
  if (!raw) return $done({});
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return $done({});
  }
  if (!handleJson(obj)) return $done({});
  $done({ body: JSON.stringify(obj) });
})();
