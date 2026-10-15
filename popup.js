// 哔哩哔哩 Cookies 登录助手 - 弹出窗口逻辑

// DOM 元素
const cookieInput = document.getElementById("cookie-input");
const btnParse = document.getElementById("btn-parse");
const btnClear = document.getElementById("btn-clear");
const btnManual = document.getElementById("btn-manual");
const btnOpen = document.getElementById("btn-open");
const btnLogout = document.getElementById("btn-logout");
const btnCheck = document.getElementById("btn-check");
const btnFetch = document.getElementById("btn-fetch");
const btnFetchFill = document.getElementById("btn-fetch-fill");
const btnCopy = document.getElementById("btn-copy");
const btnExport = document.getElementById("btn-export");
const btnImport = document.getElementById("btn-import");
const txtImportInput = document.getElementById("txt-import");
const btnSaveAccount = document.getElementById("btn-save-account");
const accountNameInput = document.getElementById("account-name");
const accountListEl = document.getElementById("account-list");
const messageEl = document.getElementById("message");

// 手动字段
const fieldSessdata = document.getElementById("field-sessdata");
const fieldBiliJct = document.getElementById("field-bili-jct");
const fieldDedeUserid = document.getElementById("field-dede-userid");
const fieldDedeCkmd5 = document.getElementById("field-dede-ckmd5");

// 状态显示
const statusCard = document.getElementById("login-status");
const statusUsername = document.getElementById("status-username");
const statusLogin = document.getElementById("status-login");

/**
 * 显示消息
 * @param {string} text 消息内容
 * @param {"success"|"error"|"info"} type 消息类型
 */
function showMessage(text, type = "info") {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  messageEl.classList.remove("hidden");
  // 自动隐藏；错误提示（如"凭证已过期"）需要用户处理，给更长的阅读时间
  clearTimeout(showMessage._timer);
  const delay = type === "error" ? 15000 : 6000;
  showMessage._timer = setTimeout(() => {
    messageEl.classList.add("hidden");
  }, delay);
}

/**
 * 解析 Cookie 字符串为键值对数组
 * @param {string} str Cookie 字符串
 * @returns {Array<{name: string, value: string}>}
 */
function parseCookieString(str) {
  if (!str || !str.trim()) return [];
  const result = [];
  // 用分号分割，兼容空格
  const parts = str.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) result.push({ name, value });
  }
  return result;
}

/**
 * 将 Cookie 数组格式化为 Cookie 字符串
 * @param {Array<{name:string,value:string}>} cookies
 * @returns {string}
 */
function cookiesToString(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * 解析导入的 Cookie 文本，支持两种格式：
 * 1) 本插件导出的 txt（含 # 注释行、完整字符串、逐条明细）
 * 2) 纯 Cookie 字符串（name=value; name=value）
 * @param {string} text 文件文本内容
 * @returns {Array<{name:string,value:string}>}
 */
function parseCookieText(text) {
  if (!text || !text.trim()) return [];
  const result = [];
  // 过滤掉以 # 开头的注释行和空行
  const lines = text.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    return t && !t.startsWith("#");
  });
  // 每行按分号拆成键值对（兼容完整字符串与逐条明细两种排版）
  for (const line of lines) {
    result.push(...parseCookieString(line));
  }
  return result;
}

/**
 * 发送消息到后台
 */
function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        const error = new Error((response && response.error) || "操作失败");
        // 后台会附带每个 Cookie 的失败原因，一并带给调用方展示
        error.summary = response && response.summary;
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

/**
 * 把秒级时间戳格式化为本地时间
 * @param {number|null} seconds
 * @returns {string}
 */
function formatDate(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds)) return "-";
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 把后台返回的写入统计整理成给用户看的补充说明
 * @param {{failed?:Array<{name:string,reason:string}>, refreshedExpiry?:string[]}} summary
 * @returns {string}
 */
function describeSummary(summary) {
  if (!summary) return "";
  const parts = [];
  if (summary.failed && summary.failed.length > 0) {
    parts.push(
      `失败 ${summary.failed.length} 个：` +
        summary.failed.map((f) => `${f.name}（${f.reason}）`).join("、")
    );
  }
  if (summary.refreshedExpiry && summary.refreshedExpiry.length > 0) {
    parts.push(`其中 ${summary.refreshedExpiry.length} 个 Cookie 的有效期已过，已按 30 天重新计算后写入`);
  }
  return parts.join("；");
}

/**
 * 写入 Cookie 并刷新状态
 * @param {Array<{name:string,value:string}>} cookies
 */
async function applyCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    showMessage("未解析到任何 Cookie，请检查输入内容。", "error");
    return;
  }

  // 同名 Cookie 去重（保留最后一次出现的值）
  const map = {};
  for (const c of cookies) {
    if (c && c.name) map[c.name] = c.value === undefined ? "" : c.value;
  }
  const deduped = Object.keys(map).map((name) => ({ name, value: map[name] }));

  // 关键字段校验：缺少 SESSDATA 时提示但允许继续
  const hasSessdata = deduped.some((c) => c.name === "SESSDATA");

  showMessage(`正在写入 ${deduped.length} 个 Cookie...`, "info");
  try {
    const res = await sendToBackground({ action: "writeCookies", cookies: deduped });
    const summary = res.summary || {};
    const extra = describeSummary(summary);
    if (summary.written === 0 && summary.failed && summary.failed.length > 0) {
      showMessage(`写入失败：所有 Cookie 都未能写入。${extra}`, "error");
    } else if (hasSessdata) {
      showMessage(
        `Cookie 写入成功（共 ${summary.written || deduped.length} 个）！请刷新或打开哔哩哔哩页面。` +
          (extra ? ` 注意：${extra}` : ""),
        extra ? "info" : "success"
      );
    } else {
      showMessage("已写入，但未包含 SESSDATA 字段，可能无法完成登录。", "info");
    }
    await refreshStatus();
    await renderAccountList();
  } catch (e) {
    const extra = describeSummary(e.summary);
    showMessage(`写入失败：${e.message}${extra ? `（${extra}）` : ""}`, "error");
  }
}

/**
 * 刷新登录状态
 */
async function refreshStatus() {
  try {
    const res = await sendToBackground({ action: "getStatus" });
    const s = res.status;
    statusCard.classList.remove("hidden");
    statusUsername.textContent = s.hasUserId ? `UID: ${s.uid}` : "-";
    if (s.loggedIn) {
      statusLogin.textContent = "已登录";
      statusLogin.className = "status-value online";
    } else {
      statusLogin.textContent = s.hasSessdata ? "部分字段，可能未完全登录" : "未登录";
      statusLogin.className = "status-value offline";
    }
  } catch (e) {
    statusCard.classList.remove("hidden");
    statusLogin.textContent = "查询失败";
  }
}

/**
 * 从当前浏览器已登录的 B 站账号自动获取 Cookie
 * @returns {Promise<Array<{name:string,value:string}>>}
 */
async function fetchCookies() {
  const res = await sendToBackground({ action: "getCookies" });
  const cookies = res.cookies || [];
  if (cookies.length === 0) {
    throw new Error("当前浏览器中未找到 bilibili.com 的 Cookie。请先在 B 站网页端登录。");
  }
  return cookies;
}

/**
 * 将获取到的 Cookie 填入手动字段表单
 * @param {Array<{name:string,value:string}>} cookies
 */
function fillManualFields(cookies) {
  const map = {};
  for (const c of cookies) map[c.name] = c.value;
  fieldSessdata.value = map["SESSDATA"] || "";
  fieldBiliJct.value = map["bili_jct"] || "";
  fieldDedeUserid.value = map["DedeUserID"] || "";
  fieldDedeCkmd5.value = map["DedeUserID__ckMd5"] || "";
}

// --- 事件绑定 ---

// 自动获取并写入（等效于把当前账号的登录"转移"到本浏览器）
btnFetch.addEventListener("click", async () => {
  try {
    showMessage("正在从已登录的 B 站网页获取 Cookie...", "info");
    const cookies = await fetchCookies();
    await applyCookies(cookies);
  } catch (e) {
    showMessage(`获取失败：${e.message}`, "error");
  }
});

// 自动获取并填入表单，方便查看/编辑
btnFetchFill.addEventListener("click", async () => {
  try {
    const cookies = await fetchCookies();
    fillManualFields(cookies);
    // 同时把完整字符串填入输入框
    cookieInput.value = cookiesToString(cookies);
    showMessage(`已获取 ${cookies.length} 个 Cookie 并填入表单，可查看或直接写入。`, "success");
  } catch (e) {
    showMessage(`获取失败：${e.message}`, "error");
  }
});

// 复制全部 Cookie 字符串到剪贴板
btnCopy.addEventListener("click", async () => {
  let cookies;
  try {
    cookies = await fetchCookies();
  } catch (e) {
    showMessage(`复制失败：${e.message}`, "error");
    return;
  }

  const str = cookiesToString(cookies);
  try {
    await navigator.clipboard.writeText(str);
  } catch (e) {
    // 剪贴板 API 在 popup 中可能受限，回退到输入框选中复制
    try {
      cookieInput.value = str;
      cookieInput.select();
      document.execCommand("copy");
    } catch (e2) {
      showMessage(`复制失败：${e2.message}`, "error");
      return;
    }
  }
  showMessage(`已复制 ${cookies.length} 个 Cookie 到剪贴板。`, "success");
});

// 解析并写入完整 Cookie 字符串
btnParse.addEventListener("click", () => {
  const cookies = parseCookieString(cookieInput.value);
  applyCookies(cookies);
});

// 清空输入框
btnClear.addEventListener("click", () => {
  cookieInput.value = "";
  cookieInput.focus();
});

// 手动填写关键字段
btnManual.addEventListener("click", async () => {
  const cookies = [];
  if (fieldSessdata.value.trim()) cookies.push({ name: "SESSDATA", value: fieldSessdata.value.trim() });
  if (fieldBiliJct.value.trim()) cookies.push({ name: "bili_jct", value: fieldBiliJct.value.trim() });
  if (fieldDedeUserid.value.trim()) cookies.push({ name: "DedeUserID", value: fieldDedeUserid.value.trim() });
  if (fieldDedeCkmd5.value.trim()) cookies.push({ name: "DedeUserID__ckMd5", value: fieldDedeCkmd5.value.trim() });

  if (cookies.length === 0) {
    showMessage("请至少填写一个字段。", "error");
    return;
  }
  await applyCookies(cookies);
});

// 打开哔哩哔哩
btnOpen.addEventListener("click", () => {
  sendToBackground({ action: "openBilibili" }).catch(() => {});
});

// 清除 Cookie（退出登录）
btnLogout.addEventListener("click", async () => {
  if (!confirm("确定要清除哔哩哔哩的所有 Cookie 吗？这将退出当前登录。")) return;
  try {
    await sendToBackground({ action: "clearCookies" });
    showMessage("已清除 B 站 Cookie。", "success");
    await refreshStatus();
  } catch (e) {
    showMessage(`清除失败：${e.message}`, "error");
  }
});

// 刷新状态
btnCheck.addEventListener("click", () => refreshStatus());

// --- 多账号管理 ---

/**
 * 渲染已保存的账号列表
 */
async function renderAccountList() {
  try {
    const res = await sendToBackground({ action: "listAccounts" });
    const accounts = res.accounts || [];
    accountListEl.innerHTML = "";

    if (accounts.length === 0) {
      accountListEl.innerHTML = '<p class="account-empty">暂无已保存的账号。</p>';
      return;
    }

    for (const acc of accounts) {
      const item = document.createElement("div");
      item.className = "account-item";

      const info = document.createElement("div");
      info.className = "account-info";
      const nameEl = document.createElement("div");
      nameEl.className = "account-name";
      nameEl.textContent = acc.name;
      const uidEl = document.createElement("div");
      uidEl.className = "account-uid";
      uidEl.textContent = `UID: ${acc.uid}`;
      info.appendChild(nameEl);
      info.appendChild(uidEl);

      // 有效期提示：Cookie 过期后再切换必然写不进去，提前让用户看到
      const expiryEl = document.createElement("div");
      expiryEl.className = "account-expiry" + (acc.expired ? " expired" : "");
      if (acc.sessionOnly) {
        expiryEl.textContent = "会话 Cookie（无固定有效期）";
      } else if (acc.expired) {
        expiryEl.textContent = `已过期（${formatDate(acc.expiresAt)}）`;
      } else if (acc.expiresAt) {
        expiryEl.textContent = `有效期至 ${formatDate(acc.expiresAt)}`;
      } else {
        expiryEl.textContent = "";
      }
      if (expiryEl.textContent) info.appendChild(expiryEl);

      const actions = document.createElement("div");
      actions.className = "account-actions";

      const switchBtn = document.createElement("button");
      switchBtn.className = "mini-btn switch";
      switchBtn.textContent = "切换";
      switchBtn.addEventListener("click", () => switchToAccount(acc.id));

      const delBtn = document.createElement("button");
      delBtn.className = "mini-btn del";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", () => deleteAccount(acc.id));

      actions.appendChild(switchBtn);
      actions.appendChild(delBtn);

      item.appendChild(info);
      item.appendChild(actions);
      accountListEl.appendChild(item);
    }
  } catch (e) {
    accountListEl.innerHTML = `<p class="account-empty">加载失败：${e.message}</p>`;
  }
}

/**
 * 保存当前账号
 */
async function saveCurrentAccount() {
  try {
    const res = await sendToBackground({ action: "getCookies" });
    const cookies = res.cookies || [];
    if (cookies.length === 0) {
      showMessage("当前没有可保存的 B 站 Cookie，请先登录。", "error");
      return;
    }
    const name = accountNameInput.value.trim();
    const saved = await sendToBackground({ action: "saveAccount", name, cookies });
    accountNameInput.value = "";
    const acc = saved.account || {};
    const nowSec = Math.floor(Date.now() / 1000);
    if (acc.expired) {
      showMessage(
        `账号已保存，但它的登录凭证在 ${formatDate(acc.expiresAt)} 就已过期。请先在 B 站重新登录，再重新保存该账号。`,
        "error"
      );
    } else if (acc.expiresAt && acc.expiresAt - nowSec < 3 * 24 * 3600) {
      // 保存时浏览器里的 Cookie 一定是有效的，但可能很快就过期，提前提醒
      showMessage(
        `账号已保存，但凭证将在 ${formatDate(acc.expiresAt)} 过期（不足 3 天），到期后需重新登录并重新保存。`,
        "info"
      );
    } else {
      showMessage("账号已保存。", "success");
    }
    await renderAccountList();
  } catch (e) {
    showMessage(`保存失败：${e.message}`, "error");
  }
}

/**
 * 切换到指定账号
 * @param {string} id
 */
async function switchToAccount(id) {
  if (!confirm("切换账号将清除当前 B 站 Cookie 并写入所选账号，确定继续？")) return;
  try {
    showMessage("正在切换账号...", "info");
    const res = await sendToBackground({ action: "switchAccount", id });
    const extra = describeSummary(res.summary);
    if (res.expiry && res.expiry.expired) {
      // 过期凭证无法真正恢复登录：已经按原值写入，但必须明确告诉用户原因
      showMessage(
        `已写入该账号的 Cookie，但它的登录凭证在 ${formatDate(res.expiry.expiresAt)} 就已过期，` +
          `B 站很可能仍显示未登录——请在 B 站重新登录后重新保存该账号。${extra ? ` ${extra}` : ""}`,
        "error"
      );
    } else {
      showMessage(
        "账号切换成功！请刷新或打开哔哩哔哩页面。" + (extra ? ` 注意：${extra}` : ""),
        extra ? "info" : "success"
      );
    }
    await refreshStatus();
    await renderAccountList();
  } catch (e) {
    const extra = describeSummary(e.summary);
    showMessage(`切换失败：${e.message}${extra ? `（${extra}）` : ""}`, "error");
  }
}

/**
 * 删除指定账号
 * @param {string} id
 */
async function deleteAccount(id) {
  if (!confirm("确定要删除该账号吗？")) return;
  try {
    await sendToBackground({ action: "deleteAccount", id });
    showMessage("账号已删除。", "success");
    await renderAccountList();
  } catch (e) {
    showMessage(`删除失败：${e.message}`, "error");
  }
}

// 保存当前账号
btnSaveAccount.addEventListener("click", () => saveCurrentAccount());

// --- 导出 Cookie 到 txt ---

/**
 * 导出当前 B 站 Cookie 到 txt 文件
 */
async function exportCookiesToTxt() {
  try {
    const res = await sendToBackground({ action: "getCookies" });
    const cookies = res.cookies || [];
    if (cookies.length === 0) {
      showMessage("当前没有可导出的 B 站 Cookie。", "error");
      return;
    }

    // 生成 txt 内容
    const lines = [];
    lines.push("# 哔哩哔哩 Cookies 导出");
    lines.push(`# 导出时间: ${new Date().toLocaleString()}`);
    lines.push(`# Cookie 数量: ${cookies.length}`);
    lines.push("");
    lines.push("# 完整 Cookie 字符串（可直接用于本插件「方式一」导入）:");
    lines.push(cookiesToString(cookies));
    lines.push("");
    lines.push("# 逐条明细:");
    for (const c of cookies) {
      lines.push(`${c.name}=${c.value}`);
    }
    const content = lines.join("\n");

    // 生成并下载 txt 文件
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const uid = cookies.find((c) => c.name === "DedeUserID");
    const filename = `bilibili_cookies_${uid ? uid.value : "export"}_${Date.now()}.txt`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showMessage(`已导出 ${cookies.length} 个 Cookie 到 ${filename}`, "success");
  } catch (e) {
    showMessage(`导出失败：${e.message}`, "error");
  }
}

// 导出 Cookie 到 txt
btnExport.addEventListener("click", () => exportCookiesToTxt());

// --- 从 txt 文件导入 Cookie ---

/**
 * 从 File 对象读取 UTF-8 文本内容
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsText(file, "utf-8");
  });
}

// 点击按钮触发隐藏的文件选择框
btnImport.addEventListener("click", () => {
  // 先清空 value，保证重复选择同一文件也能触发 change
  txtImportInput.value = "";
  txtImportInput.click();
});

// 选择文件后解析并写入
txtImportInput.addEventListener("change", async () => {
  const file = txtImportInput.files && txtImportInput.files[0];
  if (!file) return;

  try {
    if (file.size > 2 * 1024 * 1024) {
      throw new Error("文件过大（超过 2MB），请确认选择的是 Cookie 导出文件。");
    }
    const text = await readFileAsText(file);
    const cookies = parseCookieText(text);
    if (cookies.length === 0) {
      throw new Error("未从文件中解析到任何 Cookie，请确认文件格式。");
    }
    // 回填输入框方便核对，然后统一走 applyCookies 写入
    cookieInput.value = cookiesToString(cookies);
    await applyCookies(cookies);
  } catch (e) {
    showMessage(`导入失败：${e.message}`, "error");
  }
});

// 初始化时读取状态
refreshStatus();
renderAccountList();