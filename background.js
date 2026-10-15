// 哔哩哔哩 Cookies 登录助手 - 后台 Service Worker
// 负责 Cookie 的写入、读取、清除，以及与弹出窗口通信

const BILIBILI_DOMAIN = ".bilibili.com";
const BILIBILI_URL = "https://www.bilibili.com/";

// 需要写入的关键 Cookie 字段
const KEY_COOKIES = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"];

// 多账号存储 key
const ACCOUNTS_STORAGE_KEY = "bili_accounts"; // 多账号存储 key

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
  const account = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (name && name.trim()) || `账号 ${raw.length + 1}`,
    uid,
    cookies,
    savedAt: Date.now(),
  };
  raw.push(account);
  await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: raw });
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
        .then((summary) => sendResponse({ ok: true, summary }))
        .catch((err) => sendResponse({ ok: false, error: err.message, summary: err.summary }));
      break;

    case "clearCookies":
      clearCookies()
        .then(() => sendResponse({ ok: true }))
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
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: err.message, summary: err.summary }));
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
