// 哔哩哔哩 Cookies 登录助手 - 后台 Service Worker
// 负责 Cookie 的写入、读取、清除，以及与弹出窗口通信

const BILIBILI_DOMAIN = ".bilibili.com";
const BILIBILI_URL = "https://www.bilibili.com/";

// 需要写入的关键 Cookie 字段
const KEY_COOKIES = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"];

// 多账号存储 key
const ACCOUNTS_STORAGE_KEY = "bili_accounts"; // 多账号存储 key

// 设置存储 key（①④② 的可配置项都保存在这里）
const SETTINGS_STORAGE_KEY = "bili_settings";
const RENEW_REPORT_KEY = "bili_renew_report"; // 最近一次临期检查的报告
const WEBDAV_FILE_NAME = "bilibili-cookies-backup.json";

const DEFAULT_SETTINGS = {
  autoRenew: true,      // ① 临期自动获取新 Cookie
  renewDays: 15,        // ① 距过期不足该天数（或已过期）时触发，默认 15 天
  autoReload: true,     // ④ 写入/清除/切换后自动刷新已打开的 B 站页面
  webdavEnabled: false, // ② WebDAV 云同步开关
  webdavAuto: true,     // ② 账号变更后自动上传
  webdavUrl: "",        // ② WebDAV 目录地址或完整 .json 文件地址
  webdavUser: "",       // ② WebDAV 账户
  webdavPass: "",       // ② WebDAV 密码
};

/**
 * 读取设置（与默认值合并，保证旧版本数据缺字段时也能拿到完整配置）
 * @returns {Promise<object>}
 */
async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_STORAGE_KEY] || {}) };
}

/**
 * 合并保存设置
 * @param {object} patch 要更新的字段
 * @returns {Promise<object>} 保存后的完整设置
 */
async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch || {}) };
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
  return next;
}

// 过期 Cookie 的兜底有效期。
// Chrome 对 expirationDate 已经过去的 Cookie 不会报错，而是直接丢弃并让
// cookies.set() 返回 null——看起来就像"写入被拒绝"。所以绝不原样转发过期的有效期。
const DEFAULT_TTL_SECONDS = 30 * 24 * 3600; // 30 天
const EXPIRY_SLACK_SECONDS = 60; // 距过期不足 60 秒也当作已过期

/**
 * 判断一个有效期是否已经过去（或即将过去）
 * @param {number|undefined} expirationDate 秒级时间戳
 * @param {number} now 秒级当前时间
 * @returns {boolean}
 */
function isStaleExpiry(expirationDate, now) {
  if (typeof expirationDate !== "number" || !Number.isFinite(expirationDate)) return true;
  return expirationDate <= now + EXPIRY_SLACK_SECONDS;
}

/**
 * 把一条 Cookie 还原成 chrome.cookies.set() 需要的参数
 *
 * 关键点：
 * 1. 保留 Cookie 自己的 domain / path，host-only Cookie（如 www.bilibili.com）
 *    不会被强行改写成 .bilibili.com；
 * 2. 有效期已过去时刷新为默认有效期，否则原样保留；
 * 3. 统一写入 Secure：bilibili 全站 HTTPS，而实测非 Secure 的 Cookie 在部分
 *    Chromium 版本/拦截策略下会被静默丢弃（set() 返回对象但存储里查不到）；
 * 4. SameSite 按原值保留，只有原本就是 None(no_restriction) 时才用 None，
 *    不把 Lax/未指定的 Cookie 一律改成 SameSite=None。
 * @param {{name:string,value:string,domain?:string,path?:string,secure?:boolean,httpOnly?:boolean,sameSite?:string,expirationDate?:number}} cookie
 * @param {number} now 秒级当前时间
 */
function buildCookieDetails(cookie, now) {
  const domain = cookie.domain || BILIBILI_DOMAIN;
  const path = cookie.path && cookie.path.startsWith("/") ? cookie.path : "/";
  // 始终使用 https：manifest 的 host_permissions 只覆盖 https://*.bilibili.com/*
  const host = domain.replace(/^\./, "");
  const sameSite =
    cookie.sameSite === "no_restriction" || cookie.sameSite === "strict" || cookie.sameSite === "lax"
      ? cookie.sameSite
      : undefined;

  const details = {
    url: `https://${host}${path}`,
    name: cookie.name,
    value: String(cookie.value === undefined ? "" : cookie.value),
    domain,
    path,
    secure: true,
    expirationDate: isStaleExpiry(cookie.expirationDate, now)
      ? now + DEFAULT_TTL_SECONDS
      : cookie.expirationDate,
  };
  if (sameSite) details.sameSite = sameSite;
  if (typeof cookie.httpOnly === "boolean") details.httpOnly = cookie.httpOnly;
  return details;
}

/**
 * 统计一组 Cookie 的有效期情况，用于提示账号是否已经过期
 * @param {Array<{name:string,expirationDate?:number}>} cookies
 * @returns {{expired:boolean, expiresAt:number|null, sessionOnly:boolean}}
 */
function accountExpiryInfo(cookies) {
  const now = Math.floor(Date.now() / 1000);
  const essential = cookies.filter((c) => KEY_COOKIES.includes(c.name));
  const pool = essential.length > 0 ? essential : cookies;
  const withExpiry = pool.filter((c) => typeof c.expirationDate === "number" && Number.isFinite(c.expirationDate));
  if (withExpiry.length === 0) {
    return { expired: false, expiresAt: null, sessionOnly: true };
  }
  const expiresAt = Math.min(...withExpiry.map((c) => c.expirationDate));
  return { expired: isStaleExpiry(expiresAt, now), expiresAt, sessionOnly: false };
}

/**
 * 将 Cookie 数组格式化为浏览器请求头中的 Cookie 字符串
 * @param {Array<{name: string, value: string}>} cookies
 * @returns {string}
 */
function cookiesToString(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * 写入一组 Cookie 到 bilibili.com 域
 *
 * 只有"关键登录 Cookie"（KEY_COOKIES）写入失败才会抛错；其余 Cookie 失败会
 * 放进返回值的 failed 里由界面提示，避免一个无关字段让整次切换判定为失败。
 * 返回值同时带上 refreshedExpiry，便于界面提醒用户账号已过期。
 *
 * @param {Array<{name:string,value:string}>} cookies
 * @returns {Promise<{total:number, written:number, failed:Array<{name:string,reason:string}>, refreshedExpiry:string[], essentialFailed:string[]}>}
 */
async function writeCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("没有可写入的 Cookie 数据");
  }

  const now = Math.floor(Date.now() / 1000);
  const written = [];
  const failed = [];
  const refreshedExpiry = [];

  for (const cookie of cookies) {
    if (!cookie || !cookie.name || cookie.value === undefined) continue;

    const details = buildCookieDetails(cookie, now);
    if (details.expirationDate !== cookie.expirationDate) refreshedExpiry.push(cookie.name);

    try {
      // 注意：set() 失败时可能返回 null 而不是抛异常，需同时检查两者
      const result = await chrome.cookies.set(details);
      if (result) {
        written.push(cookie.name);
      } else {
        failed.push({ name: cookie.name, reason: "浏览器拒绝写入（有效期已过或字段不合法）" });
      }
    } catch (e) {
      failed.push({ name: cookie.name, reason: e && e.message ? e.message : String(e) });
    }
  }

  const essentialFailed = failed.filter((f) => KEY_COOKIES.includes(f.name));
  const summary = {
    total: cookies.length,
    written: written.length,
    failed,
    refreshedExpiry,
    essentialFailed: essentialFailed.map((f) => f.name),
  };

  if (written.length === 0 && failed.length === 0) {
    throw new Error("没有可写入的 Cookie 数据");
  }

  if (essentialFailed.length > 0) {
    const detail = essentialFailed.map((f) => `${f.name}（${f.reason}）`).join("；");
    const err = new Error(`关键登录 Cookie 写入失败：${detail}`);
    err.summary = summary;
    throw err;
  }

  return summary;
}

/**
 * 清除 bilibili.com 域的所有 Cookie
 */
async function clearCookies() {
  const all = await chrome.cookies.getAll({ domain: BILIBILI_DOMAIN });
  for (const cookie of all) {
    await chrome.cookies.remove({
      url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
      name: cookie.name,
    });
  }
  return all.length;
}

/**
 * 按设置自动刷新所有已打开的哔哩哔哩标签页
 * 写入 Cookie / 清除 Cookie / 切换账号之后调用，已打开的页面即可立刻反映新的登录状态
 * @returns {Promise<number>} 刷新的标签页数量
 */
async function reloadBilibiliTabs() {
  const settings = await getSettings();
  if (!settings.autoReload) return 0;
  const tabs = await chrome.tabs.query({ url: ["*://*.bilibili.com/*"] });
  let count = 0;
  for (const tab of tabs) {
    try {
      chrome.tabs.reload(tab.id);
      count++;
    } catch (e) {
      // 标签页可能刚好被用户关闭，忽略
    }
  }
  return count;
}

/**
 * 读取当前登录状态
 */
async function getStatus() {
  const cookies = await chrome.cookies.getAll({ domain: BILIBILI_DOMAIN });
  const map = {};
  for (const c of cookies) map[c.name] = c.value;

  const hasSessdata = !!map["SESSDATA"];
  const hasUserId = !!map["DedeUserID"];
  const expiresAt = cookies.reduce((min, c) => {
    if (c.name !== "SESSDATA" || typeof c.expirationDate !== "number") return min;
    return min === null || c.expirationDate < min ? c.expirationDate : min;
  }, null);

  return {
    loggedIn: hasSessdata && hasUserId,
    hasSessdata,
    hasUserId,
    uid: map["DedeUserID"] || "",
    expiresAt,
    cookieCount: cookies.length,
  };
}

/**
 * 读取浏览器中 bilibili.com 域的全部 Cookie
 * 用于从当前已登录的 B 站网页自动获取登录凭证
 * @returns {Promise<Array<{name: string, value: string, domain: string, secure: boolean, expirationDate?: number}>>}
 */
async function getCookies() {
  const all = await chrome.cookies.getAll({ domain: BILIBILI_DOMAIN });
  return all.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
  }));
}

/**
 * 通过 B 站 nav 接口获取"浏览器当前登录账号"的头像与昵称
 * manifest 的 host_permissions（https://*.bilibili.com/*）已覆盖 api.bilibili.com，
 * credentials: "include" 让请求自动带上当前浏览器的 B 站 Cookie
 * @returns {Promise<{uid:string, uname:string, face:string}|null>} 未登录或失败时返回 null
 */
async function fetchBilibiliUserInfo() {
  try {
    const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.code !== 0 || !json.data) return null;
    const d = json.data;
    return {
      uid: d.mid === undefined || d.mid === null ? "" : String(d.mid),
      uname: typeof d.uname === "string" ? d.uname : "",
      face: typeof d.face === "string" ? d.face : "",
    };
  } catch (e) {
    return null;
  }
}

/**
 * 读取已保存的多账号列表
 * 返回的每一项会附带计算出来的过期信息（expired / expiresAt / sessionOnly），
 * 这些字段只用于界面展示，不会被写回存储。
 * @returns {Promise<Array>}
 */
async function listAccounts() {
  const data = await chrome.storage.local.get(ACCOUNTS_STORAGE_KEY);
  const accounts = data[ACCOUNTS_STORAGE_KEY] || [];
  return accounts.map((a) => ({ ...a, ...accountExpiryInfo(a.cookies || []) }));
}

/**
 * 保存当前账号到多账号列表
 * @param {string} name 账号备注
 * @param {Array<{name:string,value:string}>} cookies
 * @returns {Promise<object>} 保存后的账号对象（含过期信息）
 */
async function saveAccount(name, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("没有可保存的 Cookie 数据");
  }
  const map = {};
  for (const c of cookies) map[c.name] = c.value;
  const uid = map["DedeUserID"] || "未知UID";

  const accounts = await chrome.storage.local.get(ACCOUNTS_STORAGE_KEY);
  const raw = accounts[ACCOUNTS_STORAGE_KEY] || [];
  // 尝试从 B 站接口补全昵称与头像（只有浏览器当前登录的就是该账号时才会拿到）
  let uname = "";
  let face = "";
  const userInfo = await fetchBilibiliUserInfo();
  if (userInfo && userInfo.uid === uid) {
    uname = userInfo.uname;
    face = userInfo.face;
  }

  const account = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (name && name.trim()) || uname || `账号 ${raw.length + 1}`,
    uid,
    note: "",
    uname,
    face,
    cookies,
    savedAt: Date.now(),
  };
  raw.push(account);
  await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: raw });
  triggerWebdavSync();
  return { ...account, ...accountExpiryInfo(account.cookies) };
}

/**
 * 删除一个已保存的账号
 * @param {string} id 账号 id
 */
async function deleteAccount(id) {
  const data = await chrome.storage.local.get(ACCOUNTS_STORAGE_KEY);
  const accounts = data[ACCOUNTS_STORAGE_KEY] || [];
  const filtered = accounts.filter((a) => a.id !== id);
  await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: filtered });
  triggerWebdavSync();
}

/**
 * 更新一个账号的备注
 * @param {string} id 账号 id
 * @param {string} note 备注内容
 * @returns {Promise<object>} 更新后的账号对象
 */
async function updateAccountNote(id, note) {
  const data = await chrome.storage.local.get(ACCOUNTS_STORAGE_KEY);
  const accounts = data[ACCOUNTS_STORAGE_KEY] || [];
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new Error("未找到该账号");
  account.note = (note && note.trim()) || "";
  await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: accounts });
  triggerWebdavSync();
  return account;
}

// --- WebDAV 云同步（②）---

/**
 * 把用户填写的 WebDAV 地址规范为备份文件的完整 URL
 * 支持两种填法：目录地址（自动拼上备份文件名）或直接填到 .json 文件
 * @param {string} baseUrl
 * @returns {string}
 */
function webdavFileUrl(baseUrl) {
  const trimmed = (baseUrl || "").trim().replace(/\/+$/, "");
  if (/\.json$/i.test(trimmed)) return trimmed;
  return trimmed + "/" + WEBDAV_FILE_NAME;
}

/**
 * 构造 WebDAV 请求头（Basic 认证）
 * @param {{webdavUser?:string, webdavPass?:string}} settings
 * @returns {object}
 */
function webdavAuthHeaders(settings) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (settings.webdavUser || settings.webdavPass) {
    const raw = (settings.webdavUser || "") + ":" + (settings.webdavPass || "");
    // btoa 只接受 Latin1 字符，先用 encodeURIComponent 处理非 ASCII 密码
    headers["Authorization"] = "Basic " + btoa(unescape(encodeURIComponent(raw)));
  }
  return headers;
}

/**
 * 上传本地账号列表到 WebDAV
 * @returns {Promise<{count:number, url:string}>}
 */
async function webdavUpload() {
  const settings = await getSettings();
  if (!settings.webdavUrl) throw new Error("请先在设置中填写 WebDAV 地址");
  if (!/^https?:\/\//i.test(settings.webdavUrl)) throw new Error("WebDAV 地址需以 http(s):// 开头");
  const data = await chrome.storage.local.get(ACCOUNTS_STORAGE_KEY);
  const accounts = data[ACCOUNTS_STORAGE_KEY] || [];
  const payload = JSON.stringify(
    { app: "bilibili-cookie-login", version: 1, exportedAt: new Date().toISOString(), accounts },
    null,
    2
  );
  const url = webdavFileUrl(settings.webdavUrl);
  let resp;
  try {
    resp = await fetch(url, { method: "PUT", headers: webdavAuthHeaders(settings), body: payload });
  } catch (e) {
    throw new Error("无法连接 WebDAV 服务器：" + (e && e.message ? e.message : String(e)));
  }
  if (!resp.ok) {
    let hint = "";
    if (resp.status === 401) hint = "（用户名或密码错误）";
    else if (resp.status === 404) hint = "（目录不存在，请先在网盘中创建该目录）";
    throw new Error(("上传失败：HTTP " + resp.status + " " + (resp.statusText || "")).trim() + hint);
  }
  return { count: accounts.length, url };
}

/**
 * 从 WebDAV 下载账号列表并整体替换本地数据
 * @returns {Promise<{count:number}>}
 */
async function webdavDownload() {
  const settings = await getSettings();
  if (!settings.webdavUrl) throw new Error("请先在设置中填写 WebDAV 地址");
  if (!/^https?:\/\//i.test(settings.webdavUrl)) throw new Error("WebDAV 地址需以 http(s):// 开头");
  const url = webdavFileUrl(settings.webdavUrl);
  let resp;
  try {
    resp = await fetch(url, { method: "GET", headers: webdavAuthHeaders(settings) });
  } catch (e) {
    throw new Error("无法连接 WebDAV 服务器：" + (e && e.message ? e.message : String(e)));
  }
  if (resp.status === 404) throw new Error("云端还没有备份文件，请先执行一次上传");
  if (!resp.ok) throw new Error(("下载失败：HTTP " + resp.status + " " + (resp.statusText || "")).trim());
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error("云端文件不是有效的备份 JSON");
  }
  const accounts = Array.isArray(json.accounts) ? json.accounts : null;
  if (!accounts) throw new Error("云端备份缺少 accounts 字段");
  for (const a of accounts) {
    if (!a || !a.id || !Array.isArray(a.cookies)) throw new Error("云端备份数据格式不正确");
  }
  await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: accounts });
  return { count: accounts.length };
}

/**
 * 账号变更后自动上传到 WebDAV（1 秒防抖，合并短时间内的连续变更）
 * 自动同步失败时保持静默——手动执行同步操作时会给出明确报错
 */
let webdavSyncTimer = null;
function triggerWebdavSync() {
  if (webdavSyncTimer) clearTimeout(webdavSyncTimer);
  webdavSyncTimer = setTimeout(async () => {
    webdavSyncTimer = null;
    try {
      const settings = await getSettings();
      if (!settings.webdavEnabled || !settings.webdavAuto || !settings.webdavUrl) return;
      await webdavUpload();
    } catch (e) {
      // 静默：后台自动同步失败不打断用户
    }
  }, 1000);
}

// --- 临期自动获取新 Cookie（①）---

/**
 * 检查所有已保存账号：当 Cookie 距过期不足设置的天数（默认 15 天）或已过期时，
 * 若浏览器当前登录的就是同一账号，自动用浏览器里最新的 Cookie 更新该账号
 * （即"自动重新获取新 Cookies"）；拿不到更新凭证时记入 stale，由界面与角标提醒重新登录。
 * @returns {Promise<object>} 检查报告 { checkedAt, renewed:[], stale:[], autoRenew }
 */
async function runAutoRenewCheck() {
  const settings = await getSettings();
  const now = Math.floor(Date.now() / 1000);
  const report = { checkedAt: Date.now(), renewed: [], stale: [], autoRenew: settings.autoRenew };

  if (settings.autoRenew) {
    const thresholdSeconds = Math.max(1, Number(settings.renewDays) || 15) * 24 * 3600;
    const data = await chrome.storage.local.get(ACCOUNTS_STORAGE_KEY);
    const accounts = data[ACCOUNTS_STORAGE_KEY] || [];
    const browserCookies = await getCookies();
    const browserMap = {};
    for (const c of browserCookies) browserMap[c.name] = c.value;
    const browserUid = browserMap["DedeUserID"] || "";
    const browserExpiry = accountExpiryInfo(browserCookies);

    for (const account of accounts) {
      const info = accountExpiryInfo(account.cookies || []);
      const nearExpiry =
        info.expired ||
        (!info.sessionOnly && info.expiresAt !== null && info.expiresAt - now <= thresholdSeconds);
      if (!nearExpiry) continue;

      const sameAccount = !!browserUid && browserUid === account.uid;
      const browserNewer =
        !browserExpiry.sessionOnly &&
        browserExpiry.expiresAt !== null &&
        (info.expiresAt === null || browserExpiry.expiresAt > info.expiresAt);
      const browserLoggedIn = !!browserMap["SESSDATA"];

      if (sameAccount && browserNewer && browserLoggedIn) {
        // 浏览器里存在该账号更新的登录会话：自动获取新 Cookie 并更新保存的账号
        account.cookies = browserCookies;
        account.renewedAt = Date.now();
        if (!account.uname || !account.face) {
          const ui = await fetchBilibiliUserInfo();
          if (ui && ui.uid === account.uid) {
            account.uname = ui.uname || account.uname || "";
            account.face = ui.face || account.face || "";
          }
        }
        report.renewed.push({
          name: account.name,
          uid: account.uid,
          expiresAt: browserExpiry.expiresAt,
        });
      } else {
        report.stale.push({
          name: account.name,
          uid: account.uid,
          expiresAt: info.expiresAt,
          expired: info.expired,
        });
      }
    }

    if (report.renewed.length > 0) {
      await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: accounts });
      triggerWebdavSync();
    }
  }

  await chrome.storage.local.set({ [RENEW_REPORT_KEY]: report });
  await updateRenewBadge(report);
  return report;
}

/**
 * 用工具栏角标提示"有账号凭证需要处理"（数量 = 自动续期失败的账号数）
 */
async function updateRenewBadge(report) {
  try {
    const staleCount = report && Array.isArray(report.stale) ? report.stale.length : 0;
    if (staleCount > 0) {
      await chrome.action.setBadgeText({ text: String(staleCount) });
      await chrome.action.setBadgeBackgroundColor({ color: "#f5222d" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {
    // 角标设置失败不影响主流程
  }
}

/**
 * 切换到指定账号：先清除现有 Cookie，再写入该账号的 Cookie
 * @param {string} id 账号 id
 * @returns {Promise<{summary:object, expiry:object}>} 写入统计与该账号的有效期情况
 */
async function switchAccount(id) {
  const data = await chrome.storage.local.get(ACCOUNTS_STORAGE_KEY);
  const accounts = data[ACCOUNTS_STORAGE_KEY] || [];
  const account = accounts.find((a) => a.id === id);
  if (!account) {
    throw new Error("未找到该账号");
  }
  const expiry = accountExpiryInfo(account.cookies || []);
  await clearCookies();
  const summary = await writeCookies(account.cookies);
  return { summary, expiry };
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case "writeCookies":
      writeCookies(message.cookies)
        .then(async (summary) => {
          const reloaded = await reloadBilibiliTabs();
          sendResponse({ ok: true, summary, reloaded });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message, summary: err.summary }));
      break;

    case "clearCookies":
      clearCookies()
        .then(async () => {
          const reloaded = await reloadBilibiliTabs();
          sendResponse({ ok: true, reloaded });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "getStatus":
      getStatus()
        .then((status) => sendResponse({ ok: true, status }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "getCookies":
      getCookies()
        .then((cookies) => sendResponse({ ok: true, cookies }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "saveAccount":
      saveAccount(message.name, message.cookies)
        .then((account) => sendResponse({ ok: true, account }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "listAccounts":
      listAccounts()
        .then((accounts) => sendResponse({ ok: true, accounts }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "deleteAccount":
      deleteAccount(message.id)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "switchAccount":
      switchAccount(message.id)
        .then(async (result) => {
          const reloaded = await reloadBilibiliTabs();
          sendResponse({ ok: true, reloaded, ...result });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message, summary: err.summary }));
      break;

    case "getSettings":
      getSettings()
        .then((settings) => sendResponse({ ok: true, settings }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "saveSettings":
      saveSettings(message.settings || {})
        .then((settings) => sendResponse({ ok: true, settings }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "updateAccountNote":
      updateAccountNote(message.id, message.note)
        .then((account) => sendResponse({ ok: true, account }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "webdavUpload":
      webdavUpload()
        .then((result) => sendResponse({ ok: true, count: result.count, url: result.url }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "webdavDownload":
      webdavDownload()
        .then((result) => sendResponse({ ok: true, count: result.count }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "runAutoRenewCheck":
      runAutoRenewCheck()
        .then((report) => sendResponse({ ok: true, report }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      break;

    case "openBilibili":
      chrome.tabs.create({ url: BILIBILI_URL }, () => sendResponse({ ok: true }));
      break;

    default:
      sendResponse({ ok: false, error: "未知操作" });
  }
  // 保持消息通道开放，支持异步 sendResponse
  return true;
});

// --- 定时临期检查（①）---
// 服务型 Worker 会被浏览器挂起，chrome.alarms 能把它按周期唤醒。
const RENEW_ALARM = "bili-cookie-renew-check";

function ensureRenewAlarm() {
  chrome.alarms.create(RENEW_ALARM, { periodInMinutes: 360 }); // 每 6 小时检查一次
}

chrome.runtime.onInstalled.addListener(() => {
  ensureRenewAlarm();
  runAutoRenewCheck();
});

chrome.runtime.onStartup.addListener(() => {
  ensureRenewAlarm();
  runAutoRenewCheck();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === RENEW_ALARM) {
    runAutoRenewCheck();
  }
});

// Service Worker 冷启动补跑一次（onStartup 仅在浏览器启动时触发，之后每次唤醒走这里）
ensureRenewAlarm();
runAutoRenewCheck();
