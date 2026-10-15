# 哔哩哔哩 Cookies 登录助手

一个基于 **Chrome Manifest V3** 的浏览器插件，通过导入 Cookies 快速登录哔哩哔哩网页端（`bilibili.com`）。

![License](https://img.shields.io/badge/license-MIT-green) ![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge-blue) ![Manifest](https://img.shields.io/badge/manifest-v3-orange)

## 功能

- **自动获取已登录 Cookie**：从当前浏览器已登录的 B 站账号中一键读取全部 Cookie，可「获取并写入」「获取并填入表单」或「复制」。
- **多账号管理**：保存多个 B 站账号的 Cookie，随时一键切换登录。
- **导出 Cookie 到 txt**：将当前 B 站 Cookie 导出为文本文件，方便备份或转移到其他设备。
- **从 txt 文件导入 Cookie**：选择本插件导出的 txt（或任意纯 Cookie 字符串文本）即可解析并写入，与导出功能配合实现跨设备转移。
- **粘贴完整 Cookie 字符串**：从浏览器开发者工具复制 B 站 Cookie，一键解析并写入。
- **手动填写关键字段**：单独填写 `SESSDATA`、`bili_jct`、`DedeUserID` 等字段。
- **一键打开 B 站**：写入后直接打开哔哩哔哩首页。
- **退出登录**：一键清除 B 站全部 Cookie。
- **登录状态检测**：实时显示当前账号的登录状态。

## 工作原理

插件通过 Chrome 的 `cookies` API，将你提供的 Cookie 写入 `bilibili.com` 域。之后打开哔哩哔哩网页端即为登录状态。

「自动获取」功能同样基于 `cookies` API：插件直接读取当前浏览器中 `bilibili.com` 域已有的 Cookie（即你已登录账号的凭证），可一键写入（等效于把该账号的登录转移到当前浏览器）、填入表单查看，或复制导出。

> **安全说明**：所有 Cookie 仅保存在本地浏览器中，插件不会上传到任何服务器。

## 安装方法

1. 打开 Chrome / Edge 浏览器，进入扩展管理页：
   - Chrome：地址栏输入 `chrome://extensions/`
   - Edge：地址栏输入 `edge://extensions/`
2. 开启右上角 **「开发者模式」**。
3. 点击 **「加载已解压的扩展程序」**，选择本目录 `bilibili-cookie-login`。
4. 插件即出现在工具栏。

## 如何获取 B 站 Cookie

1. 在浏览器中打开 `https://www.bilibili.com/` 并**登录**你的账号。
2. 按 `F12` 打开开发者工具，切换到 **「网络（Network）」** 标签。
3. 刷新页面，在请求列表中找到任意一个 `bilibili.com` 的请求。
4. 点击该请求，在右侧 **「请求头（Request Headers）」** 中找到 `Cookie:` 字段，复制其完整内容。
5. 打开本插件，将复制的 Cookie 粘贴到输入框，点击 **「解析并写入 Cookie」**。

## 导入 / 导出 Cookie

**导出**：点击「导出 Cookie 到 txt」，浏览器会下载一个 `bilibili_cookies_<UID>_<时间戳>.txt` 文件，内含导出时间、完整 Cookie 字符串和逐条明细。

**导入**：点击「从 txt 导入 Cookie」选择文件，插件会自动解析并写入，同时把内容回填到输入框方便核对。支持两种格式：

1. 本插件导出的 txt（自动跳过 `#` 开头的注释行，兼容完整字符串与逐条明细两种排版）；
2. 任意纯 Cookie 字符串文本（`name=value; name=value` 格式，每行一条也可以）。

> 典型用法：在设备 A 上「导出 Cookie 到 txt」，把文件传到设备 B，再用「从 txt 导入 Cookie」即可完成跨设备登录转移。

## Cookie 过期说明（重要）

B 站的 Cookie 有固定有效期（通常是登录后 30 天，同一次登录写入的 Cookie 会在同一时刻一起过期）。插件对此的处理是：

- **保存账号时**：记录每个 Cookie 的有效期；若记录到的凭证已过期，会立即提示。
- **账号列表**：每个账号下方显示「有效期至 …」或红色的「已过期（…）」，一眼就能看出哪个账号还能用。
- **切换账号时**：如果该账号的凭证已经过期，插件仍会写入（有效期按 30 天重新计算），但会明确提示「很可能仍显示未登录」。

> 为什么过期会导致「部分 Cookie 写入失败」：Chrome 对 `expirationDate` 已经过去的 Cookie 不会报错，而是直接丢弃并让 `cookies.set()` 返回 `null`。如果原样转发过期时间，整批 Cookie 都会被判定为写入失败。
>
> **过期的 Cookie 无法恢复登录**：请先在 B 站网页端重新登录，再重新保存该账号（或直接点「获取并写入」）。

## 关键 Cookie 字段说明

| 字段 | 是否必填 | 说明 |
|------|---------|------|
| `SESSDATA` | ✅ 必填 | 登录凭证核心字段，决定是否登录 |
| `bili_jct` | 建议填写 | CSRF Token，发评论/投稿等写操作需要 |
| `DedeUserID` | 建议填写 | 用户 UID |
| `DedeUserID__ckMd5` | 可选 | 用户校验值 |

## 图标

插件已内置生成的 PNG 图标（`icons/icon16.png`、`icon48.png`、`icon128.png`），并在 `manifest.json` 中引用，加载扩展即可显示。

如需自定义图标，修改 `generate_icons.py` 后运行：

```bash
pip install Pillow
python generate_icons.py
```

## 目录结构

```
bilibili-cookie-login/
├── manifest.json        # 扩展清单 (MV3)
├── popup.html           # 弹出窗口界面
├── popup.js             # 弹出窗口逻辑
├── styles.css           # 界面样式
├── background.js        # 后台 Service Worker（Cookie 写入/清除/状态）
├── generate_icons.py    # 图标生成脚本（可选）
├── LICENSE              # MIT 许可证
└── icons/
    ├── icon.svg         # SVG 图标源文件
    ├── icon16.png       # 工具栏图标
    ├── icon48.png       # 扩展管理页图标
    └── icon128.png      # 安装对话框图标
```

## 注意事项

- 插件只支持 **Chromium 内核**浏览器（Chrome、Edge、Brave、Opera 等）。
- Cookie 会过期，过期后需重新导入；导入的 txt 中若缺少 `SESSDATA`，插件会提示可能无法登录。
- 导出的 txt 文件等同于账号凭证，请妥善保管，不要分享给他人。

## 许可证

[MIT](LICENSE) © 2026 yumoii789