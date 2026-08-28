// 哔哩哔哩 Cookies 登录助手 - 后台 Service Worker
// 负责 Cookie 的写入、读取、清除，以及与弹出窗口通信

const BILIBILI_DOMAIN = ".bilibili.com";
const BILIBILI_URL = "https://www.bilibili.com/";

// 需要写入的关键 Cookie 字段
const KEY_COOKIES = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"];

// 多账号存储 key
const ACCOUNTS_STORAGE_KEY = "bili_accounts"; // 多账号存储 key

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
 * @param {Array<{name: string, value: string}>} cookies
 */
async function writeCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("没有可写入的 Cookie 数据");
  }

  const results = [];
  for (const cookie of cookies) {
    if (!cookie.name || cookie.value === undefined) continue;

    const details = {
      url: BILIBILI_URL,
      name: cookie.name,
      value: cookie.value,
      domain: BILIBILI_DOMAIN,
      path: "/",
      secure: true,
      sameSite: "no_restriction",
      expirationDate: cookie.expirationDate || Math.floor(Date.now() / 1000) + 30 * 24 * 3600, // 默认 30 天
    };

    try {
      // 注意：set() 失败时可能返回 null 而不是抛异常，需同时检查两者
      const written = await chrome.cookies.set(details);
      if (written) {
        results.push({ name: cookie.name, ok: true });
      } else {
        results.push({ name: cookie.name, ok: false, error: "写入被拒绝" });
      }
    } catch (e) {
      results.push({ name: cookie.name, ok: false, error: e.message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new Error(`部分 Cookie 写入失败: ${failed.map((f) => f.name).join(", ")}`);
  }
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
  const username = map["DedeUserID__ckMd5"] ? "已配置" : "";

  return {
    loggedIn: hasSessdata && hasUserId,
    hasSessdata,
    hasUserId,
    username,
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
 * @returns {Promise<Array>}
 */
async function listAccounts() {
  const data = await chrome.storage.local.get(ACCOUNTS_STORAGE_KEY);
  return data[ACCOUNTS_STORAGE_KEY] || [];
}

/**
 * 保存当前账号到多账号列表
 * @param {string} name 账号备注
 * @param {Array<{name:string,value:string}>} cookies
 * @returns {Promise<object>} 保存后的账号对象
 */
async function saveAccount(name, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("没有可保存的 Cookie 数据");
  }
  const map = {};
  for (const c of cookies) map[c.name] = c.value;
  const uid = map["DedeUserID"] || "未知UID";

  const accounts = await listAccounts();
  const account = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (name && name.trim()) || `账号 ${accounts.length + 1}`,
    uid,
    cookies,
    savedAt: Date.now(),
  };
  accounts.push(account);
  await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: accounts });
  return account;
}

/**
 * 删除一个已保存的账号
 * @param {string} id 账号 id
 */
async function deleteAccount(id) {
  const accounts = await listAccounts();
  const filtered = accounts.filter((a) => a.id !== id);
  await chrome.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: filtered });
}

/**
 * 切换到指定账号：先清除现有 Cookie，再写入该账号的 Cookie
 * @param {string} id 账号 id
 */
async function switchAccount(id) {
  const accounts = await listAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) {
    throw new Error("未找到该账号");
  }
  await clearCookies();
  await writeCookies(account.cookies);
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case "writeCookies":
      writeCookies(message.cookies)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
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
        .then(() => sendResponse({ ok: true }))
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
