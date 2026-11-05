// 哔哩哔哩 Cookies 登录助手 - 设置页逻辑

// DOM 元素
const optAutoRenew = document.getElementById("opt-auto-renew");
const optRenewDays = document.getElementById("opt-renew-days");
const optAutoReload = document.getElementById("opt-auto-reload");
const optWebdavEnabled = document.getElementById("opt-webdav-enabled");
const optWebdavUrl = document.getElementById("opt-webdav-url");
const optWebdavUser = document.getElementById("opt-webdav-user");
const optWebdavPass = document.getElementById("opt-webdav-pass");
const optWebdavAuto = document.getElementById("opt-webdav-auto");
const btnCheckNow = document.getElementById("btn-check-now");
const btnWebdavUpload = document.getElementById("btn-webdav-upload");
const btnWebdavDownload = document.getElementById("btn-webdav-download");
const btnSave = document.getElementById("btn-save");
const renewResultEl = document.getElementById("renew-result");
const webdavResultEl = document.getElementById("webdav-result");
const saveStatusEl = document.getElementById("save-status");

/**
 * 向 background 发消息
 * @param {{action:string, [k:string]:any}} message
 * @returns {Promise<any>}
 */
function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res) {
          reject(new Error("后台无响应"));
          return;
        }
        if (res.ok === false) {
          reject(new Error(res.error || "操作失败"));
          return;
        }
        resolve(res);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 在结果区显示一条消息
 * @param {HTMLElement} el
 * @param {string} text
 * @param {"ok"|"err"} type
 */
function showResult(el, text, type) {
  el.textContent = text;
  el.className = "renew-result " + (type === "err" ? "err" : "ok");
}

// --- 加载当前设置 ---

async function loadSettings() {
  try {
    const res = await sendToBackground({ action: "getSettings" });
    const s = res.settings || {};
    optAutoRenew.checked = !!s.autoRenew;
    optRenewDays.value = s.renewDays != null ? s.renewDays : 15;
    optAutoReload.checked = !!s.autoReload;
    optWebdavEnabled.checked = !!s.webdavEnabled;
    optWebdavUrl.value = s.webdavUrl || "";
    optWebdavUser.value = s.webdavUser || "";
    optWebdavPass.value = s.webdavPass || "";
    optWebdavAuto.checked = !!s.webdavAuto;
  } catch (e) {
    showResult(renewResultEl, `设置加载失败：${e.message}`, "err");
  }
}

// --- 保存设置 ---

/**
 * 从界面收集设置值（不落盘）
 * @returns {{autoRenew:boolean, renewDays:number, autoReload:boolean, webdavEnabled:boolean, webdavUrl:string, webdavUser:string, webdavPass:string, webdavAuto:boolean}}
 */
function collectSettings() {
  const days = parseInt(optRenewDays.value, 10);
  return {
    autoRenew: optAutoRenew.checked,
    renewDays: Number.isFinite(days) && days >= 1 && days <= 90 ? days : 15,
    autoReload: optAutoReload.checked,
    webdavEnabled: optWebdavEnabled.checked,
    webdavUrl: optWebdavUrl.value.trim(),
    webdavUser: optWebdavUser.value.trim(),
    webdavPass: optWebdavPass.value,
    webdavAuto: optWebdavAuto.checked
  };
}

btnSave.addEventListener("click", async () => {
  const settings = collectSettings();
  if (settings.webdavEnabled && !/^https?:\/\//i.test(settings.webdavUrl)) {
    showResult(webdavResultEl, "WebDAV 服务器地址必须以 http:// 或 https:// 开头。", "err");
    return;
  }
  try {
    // 启用 WebDAV 时，先向用户申请访问该站点的权限（MV3 要求在用户手势中请求）
    if (settings.webdavEnabled) {
      const granted = await ensureWebdavPermission(settings.webdavUrl);
      if (!granted) {
        settings.webdavEnabled = false;
        optWebdavEnabled.checked = false;
        showResult(webdavResultEl, "未授予 WebDAV 站点访问权限，已保持 WebDAV 同步为关闭状态。", "err");
      }
    }
    await sendToBackground({ action: "saveSettings", settings });
    saveStatusEl.textContent = "✓ 已保存";
    saveStatusEl.className = "save-status ok";
    setTimeout(() => {
      saveStatusEl.textContent = "";
      saveStatusEl.className = "save-status";
    }, 3000);
  } catch (e) {
    saveStatusEl.textContent = "✗ 保存失败：" + e.message;
    saveStatusEl.className = "save-status err";
  }
});

/**
 * 为 WebDAV 地址请求可选主机权限
 * @param {string} urlStr
 * @returns {Promise<boolean>}
 */
async function ensureWebdavPermission(urlStr) {
  let origin;
  try {
    origin = new URL(urlStr).origin + "/*";
  } catch (e) {
    return false;
  }
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    // 权限请求失败（例如非用户手势）视为未授予
    return false;
  }
}

// --- ① 立即检查一次 ---

btnCheckNow.addEventListener("click", async () => {
  btnCheckNow.disabled = true;
  showResult(renewResultEl, "正在检查……", "ok");
  try {
    const res = await sendToBackground({ action: "runAutoRenewCheck" });
    const report = res.report || {};
    const renewed = report.renewed || [];
    const stale = report.stale || [];
    if (renewed.length === 0 && stale.length === 0) {
      showResult(renewResultEl, "检查完成：所有账号的凭证都还很新鲜，无需续期。", "ok");
    } else {
      const lines = [];
      if (renewed.length > 0) {
        lines.push(`✓ 已为 ${renewed.length} 个临期账号自动获取最新 Cookie：${renewed.map((r) => r.name || r.uid).join("、")}`);
      }
      if (stale.length > 0) {
        lines.push(`⚠ ${stale.length} 个账号临期/过期但无法自动续期（浏览器中没有该账号更新的登录会话）：${stale.map((r) => r.name || r.uid).join("、")}。请先在 B 站重新登录。`);
      }
      showResult(renewResultEl, lines.join("\n"), stale.length > 0 ? "err" : "ok");
    }
  } catch (e) {
    showResult(renewResultEl, "检查失败：" + e.message, "err");
  } finally {
    btnCheckNow.disabled = false;
  }
});

// --- ② WebDAV 立即上传 / 从云端恢复 ---

btnWebdavUpload.addEventListener("click", async () => {
  // 先把当前界面值存下去，保证上传用的就是界面上的配置
  await persistCurrentSettings();
  btnWebdavUpload.disabled = true;
  showResult(webdavResultEl, "正在上传备份……", "ok");
  try {
    const res = await sendToBackground({ action: "webdavUpload" });
    showResult(webdavResultEl, `✓ 上传成功，已备份 ${res.count} 个账号。`, "ok");
  } catch (e) {
    showResult(webdavResultEl, "上传失败：" + e.message, "err");
  } finally {
    btnWebdavUpload.disabled = false;
  }
});

btnWebdavDownload.addEventListener("click", async () => {
  if (!confirm("从云端恢复将完全覆盖本机已保存的账号列表，确定继续？")) return;
  await persistCurrentSettings();
  btnWebdavDownload.disabled = true;
  showResult(webdavResultEl, "正在恢复……", "ok");
  try {
    const res = await sendToBackground({ action: "webdavDownload" });
    showResult(webdavResultEl, `✓ 恢复成功，共 ${res.count} 个账号。`, "ok");
  } catch (e) {
    showResult(webdavResultEl, "恢复失败：" + e.message, "err");
  } finally {
    btnWebdavDownload.disabled = false;
  }
});

/**
 * 把界面当前值立即落盘（上传/恢复前调用，保证操作用的是界面上的配置）
 */
async function persistCurrentSettings() {
  try {
    const settings = collectSettings();
    if (settings.webdavEnabled && !/^https?:\/\//i.test(settings.webdavUrl)) {
      throw new Error("WebDAV 服务器地址必须以 http:// 或 https:// 开头。");
    }
    if (settings.webdavEnabled) {
      const granted = await ensureWebdavPermission(settings.webdavUrl);
      if (!granted) {
        throw new Error("未授予 WebDAV 站点访问权限，请在「保存设置」时重新授权。");
      }
      settings.webdavEnabled = true;
    }
    await sendToBackground({ action: "saveSettings", settings });
  } catch (e) {
    showResult(webdavResultEl, e.message, "err");
    throw e;
  }
}

// 初始化
loadSettings();