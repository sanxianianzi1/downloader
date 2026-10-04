import { pathToFileURL } from "node:url";

const TELEGRAM_API = "https://api.telegram.org";
const GITHUB_API = "https://api.github.com";
const EVENT_TYPE = "download-task";
const POLL_TIMEOUT_SEC = 50;

// tgstate 管理面（/api/bot/*）：与 tgstate 同一 compose 网络时走内网地址。
const TGSTATE_URL = (process.env.TGSTATE_URL || "http://tgstate:7860")
  .trim()
  .replace(/\/+$/, "");
const TGSTATE_BOT_KEY = (process.env.TGSTATE_BOT_KEY || "").trim();
const TGSTATE_HTTP_TIMEOUT_MS = 15000;
// 对外访问 tgstate 的公开地址（与 compose 里 tgstate 的 BASE_URL 同源变量），用于拼接分享链接。
const TGSTATE_PUBLIC_URL = (process.env.TGSTATE_PUBLIC_URL || "")
  .trim()
  .replace(/\/+$/, "");

const RMDIR_CONFIRM_TTL_MS = 60000;
const MESSAGE_MAX_CHARS = 3500;
const SHORT_ID_RE = /^[A-Za-z0-9]{10}$/;

// 每个会话的当前目录（规范化路径，根 = ""）。bot 重启后回到根目录。
const userCwd = new Map(); // chatId -> path
// chatId -> 最近一次成功派发的 { url, folder }；/setcookie 成功后自动重派，/retry 手动重派
const lastDispatch = new Map();

function cwdOf(chatId) {
  return userCwd.get(chatId) || "";
}

const HELP_TEXT = [
  "下载机器人使用方法：",
  "",
  "1) 直接发送下载链接，支持：",
  "- http/https 直链（含 .torrent）",
  "- magnet:?xt=urn:btih:...",
  "- ed2k://|file|...",
  "",
  "机器人把任务提交到 GitHub Actions，用 Gopeed 下载后上传 Telegram 频道，分享链接发回本会话。",
  "支持一次粘贴多条链接（换行分隔），每条链接独立排队处理。",
  "在某个目录里（/cd 后）发链接，下载完成的文件自动存入该目录。",
  "",
  "2) 文件管理命令（管理 tgstate 网盘）：",
  "/pwd                      查看当前目录",
  "/cd [目录路径]            切换当前目录，/cd / 回根目录",
  "/ls [目录路径]            浏览目录，省略 = 当前目录",
  "/links [目录路径]        列出目录内所有文件的分享链接，省略 = 当前目录",
  "/mkdir <目录路径>         创建目录（相对当前目录，支持多级）",
  "/mv <文件> [目标目录]     移动文件，省略目标 = 当前目录，/ = 根目录",
  "/rename <文件> <新文件名> 重命名文件（short_id 与分享链接保持不变）",
  "/rm <文件>                删除单个文件",
  "/rmdir <目录路径>         级联删除目录，需 60 秒内发送 /rmdir confirm <路径> 二次确认",
  "",
  "3) Cookie 维护（夸克直链失效时用）：",
  "/setcookie <Cookie>       更新夸克 Cookie（存 VPS 数据库），成功后自动重试上次未完成任务",
  "/setcookie                查看 Cookie 是否已设置",
  "/retry                    重试本会话最近一次下载任务",
  "/help                     查看本说明",
  "",
  "文件参数写法：10 位 short_id（如 aBc123XyZ9），或 路径/文件名（如 EP01.mkv）。",
  "路径以 / 开头表示从根目录开始，否则相对当前目录；名称匹配大小写不敏感。",
].join("\n");

function requireEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) {
    console.error(`缺少环境变量 ${name}`);
    process.exit(1);
  }
  return v;
}

let env = null;
function getEnv() {
  if (!env) {
    env = {
      BOT_TOKEN: requireEnv("BOT_TOKEN"),
      GITHUB_TOKEN: requireEnv("GITHUB_TOKEN"),
      GITHUB_REPO: requireEnv("GITHUB_REPO"),
      ALLOWED_USER_IDS: (process.env.ALLOWED_USER_IDS || "").trim(),
    };
  }
  return env;
}

async function sendTelegramMessage(chatId, text) {
  const body = text.length > MESSAGE_MAX_CHARS
    ? `${text.slice(0, MESSAGE_MAX_CHARS)}\n...（内容过长已截断）`
    : text;
  const resp = await fetch(`${TELEGRAM_API}/bot${getEnv().BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: body,
      disable_web_page_preview: true,
    }),
  });
  if (!resp.ok) {
    console.error(`sendMessage failed: ${resp.status} ${await resp.text()}`);
  }
}

function isAllowedUser(userId) {
  const allowList = getEnv()
    .ALLOWED_USER_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  return allowList.includes(userId);
}

// ============================================================
// tgstate 管理面客户端（X-Bot-Key 鉴权）
// ============================================================

async function tgApiJson(pathname, opts = {}) {
  try {
    const resp = await fetch(`${TGSTATE_URL}${pathname}`, {
      method: opts.method || "GET",
      headers: {
        "X-Bot-Key": TGSTATE_BOT_KEY,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body,
      signal: AbortSignal.timeout(TGSTATE_HTTP_TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e };
  }
}

function mapTgError(res) {
  if (res.status === 0) {
    return `tgstate 无响应（${TGSTATE_URL}），请检查容器状态与网络。`;
  }
  const detail = res.data && res.data.detail ? res.data.detail : null;
  const msg = detail && detail.message ? detail.message : `HTTP ${res.status}`;
  if (res.status === 503) {
    return `tgstate 管理面未启用：${msg}\n请在 .env 配置 TGSTATE_BOT_KEY 并重启 tgstate。`;
  }
  if (res.status === 401) {
    return `鉴权失败：${msg}\n请检查 bot-worker 的 TGSTATE_BOT_KEY 与 tgstate 的 BOT_API_KEY 是否一致。`;
  }
  return msg;
}

function managementEnabled() {
  return TGSTATE_BOT_KEY.length > 0;
}

// ============================================================
// 纯函数（可单测）
// ============================================================

function normalizePath(input) {
  return String(input || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const text = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1);
  return `${text}${units[i]}`;
}

function parseCommand(text) {
  const m = /^\/([A-Za-z][A-Za-z0-9_]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/.exec(
    String(text || "").trim()
  );
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

function renderListing(data, pathLabel) {
  const folders = (data && data.folders) || [];
  const files = (data && data.files) || [];
  const lines = [
    `目录 ${pathLabel || "/"}：${folders.length} 个文件夹，${files.length} 个文件`,
  ];
  for (const f of [...folders].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      `  [目录] ${f.name}  (id=${f.id}, ${f.folder_count} 子目录 / ${f.file_count} 文件)`
    );
  }
  for (const f of [...files].sort((a, b) => a.filename.localeCompare(b.filename))) {
    lines.push(`  [文件] ${f.filename}  ${humanSize(f.filesize)}  (id=${f.short_id})`);
  }
  if (folders.length === 0 && files.length === 0) {
    lines.push("  （空）");
  }
  return lines.join("\n");
}

// /links 渲染：目录内每个文件一条「序号. 文件名（大小）+ 分享链接」。
// 链接用 tgstate 短链形态 {base}/d/{short_id}，不带文件名段，避免特殊字符转义问题。
// 未配置 TGSTATE_PUBLIC_URL 时退化为 short_id 清单并给出配置提示。
function renderLinks(data, pathLabel) {
  const files = (data && data.files) || [];
  const label = pathLabel || "/";
  if (files.length === 0) {
    return `目录 ${label} 内没有文件。子目录内容请用 /links 目录路径 单独查看。`;
  }
  const head = `目录 ${label} 的文件链接（${files.length} 个）：`;
  const sorted = [...files].sort((a, b) =>
    String(a.filename).localeCompare(String(b.filename))
  );
  if (!TGSTATE_PUBLIC_URL) {
    const lines = sorted.map((f) => `  ${f.filename}  (id=${f.short_id})`);
    return [
      head,
      ...lines,
      "",
      "未配置 TGSTATE_PUBLIC_URL，无法生成链接；在 VPS 的 .env 填写后 docker compose up -d bot 重新生效。",
    ].join("\n");
  }
  const lines = sorted.map(
    (f, i) =>
      `${i + 1}. ${f.filename}（${humanSize(f.filesize)}）\n   ${TGSTATE_PUBLIC_URL}/d/${f.short_id}`
  );
  return [head, ...lines].join("\n");
}

function validateRmdirConfirm(pending, inputPath, cwdPath = "") {
  if (!pending) {
    return { ok: false, message: "没有待确认的 /rmdir 操作。用法：/rmdir <目录路径>" };
  }
  if (Date.now() > pending.expiresAt) {
    return { ok: false, message: "确认已超时（60 秒），请重新发起 /rmdir。" };
  }
  const raw = normalizePath(inputPath);
  // 待确认路径是绝对的；confirm 输入按「原样」或「相对当前目录」两种写法宽容匹配。
  const withCwd = normalizePath(`${normalizePath(cwdPath)}/${raw}`);
  const norm = raw === pending.path ? raw : withCwd === pending.path ? withCwd : raw;
  if (norm !== pending.path) {
    return {
      ok: false,
      message: `路径与待确认目录不一致。\n待确认目录：/${pending.path}\n请发送：/rmdir confirm /${pending.path}`,
    };
  }
  return { ok: true };
}

// ============================================================
// 路径 / 文件解析（走管理面接口）
// ============================================================

function listUrl(parentId) {
  return `/api/bot/folders${parentId != null ? `?parent_id=${parentId}` : ""}`;
}

// 从指定起点逐层下钻。baseId=null 表示根目录；baseParts 用于错误提示里的完整路径。
async function walkFolders(baseId, baseParts, parts) {
  let parentId = baseId;
  const walked = [...baseParts];
  for (const part of parts) {
    const res = await tgApiJson(listUrl(parentId));
    if (!res.ok) return { ok: false, message: mapTgError(res) };
    const folders = (res.data && res.data.folders) || [];
    const matches = folders.filter(
      (f) => String(f.name).toLowerCase() === part.toLowerCase()
    );
    if (matches.length === 0) {
      return { ok: false, message: `路径不存在：/${[...walked, part].join("/")}` };
    }
    if (matches.length > 1) {
      const cands = matches.map((m) => `  · id=${m.id} ${m.name}`).join("\n");
      return {
        ok: false,
        message: `路径有歧义：/${[...walked, part].join("/")}\n候选：\n${cands}\n请用 /ls 查看后改用 id 操作`,
      };
    }
    parentId = matches[0].id;
    walked.push(matches[0].name);
  }
  return { ok: true, id: parentId, path: walked.join("/") };
}

// 目录路径解析。pathInput 以 / 开头 = 绝对路径（从根开始）；
// 否则相对 cwdPath 解析。空输入 = cwdPath 本身（根目录时 id 为 null）。
async function resolvePath(pathInput, cwdPath = "") {
  const raw = String(pathInput || "").trim();
  const cwd = normalizePath(cwdPath);
  if (!raw) {
    if (!cwd) return { ok: true, id: null, path: "" };
    return walkFolders(null, [], cwd.split("/").filter(Boolean));
  }
  const parts = normalizePath(raw).split("/").filter(Boolean);
  if (raw.startsWith("/")) return walkFolders(null, [], parts);
  const baseParts = cwd.split("/").filter(Boolean);
  if (baseParts.length === 0) return walkFolders(null, [], parts);
  const base = await walkFolders(null, [], baseParts);
  if (!base.ok) return base;
  return walkFolders(base.id, baseParts, parts);
}

// 文件参数解析：10 位 short_id 直接命中；否则按「目录路径/文件名」逐层解析后
// 在目标目录的文件清单里做大小写不敏感匹配。相对路径基于 cwdPath。
async function findFile(arg, cwdPath = "") {
  const raw = String(arg || "").trim();
  const clean = normalizePath(raw);
  if (!clean) return { error: "请提供文件参数：short_id 或 路径/文件名" };
  if (SHORT_ID_RE.test(clean)) {
    return { shortId: clean, filename: clean, folderPath: "" };
  }
  const parts = clean.split("/").filter(Boolean);
  const name = parts.pop();
  const dirInput = raw.startsWith("/") ? `/${parts.join("/")}` : parts.join("/");
  const dir = await resolvePath(dirInput, cwdPath);
  if (!dir.ok) return { error: dir.message };
  const res = await tgApiJson(listUrl(dir.id));
  if (!res.ok) return { error: mapTgError(res) };
  const files = (res.data && res.data.files) || [];
  const matches = files.filter(
    (f) => String(f.filename).toLowerCase() === name.toLowerCase()
  );
  if (matches.length === 0) {
    return { error: `在 /${dir.path} 下未找到文件：${name}` };
  }
  if (matches.length > 1) {
    const cands = matches.map((m) => `  · ${m.filename} (id=${m.short_id})`).join("\n");
    return {
      error: `同名文件有多个，请用 /ls 查看 short_id 后指定：\n${cands}`,
    };
  }
  return {
    shortId: matches[0].short_id,
    filename: matches[0].filename,
    folderPath: dir.path,
  };
}

// ============================================================
// 管理命令
// ============================================================

const pendingRmdir = new Map(); // chatId -> { path, expiresAt }

async function cmdLs(chatId, args) {
  const target = await resolvePath(args, cwdOf(chatId));
  if (!target.ok) return sendTelegramMessage(chatId, target.message);
  const res = await tgApiJson(listUrl(target.id));
  if (!res.ok) return sendTelegramMessage(chatId, mapTgError(res));
  await sendTelegramMessage(
    chatId,
    renderListing(res.data, target.path ? `/${target.path}` : "/")
  );
}

async function cmdLinks(chatId, args) {
  const target = await resolvePath(args, cwdOf(chatId));
  if (!target.ok) return sendTelegramMessage(chatId, target.message);
  const res = await tgApiJson(listUrl(target.id));
  if (!res.ok) return sendTelegramMessage(chatId, mapTgError(res));
  await sendTelegramMessage(
    chatId,
    renderLinks(res.data, target.path ? `/${target.path}` : "/")
  );
}

async function cmdPwd(chatId) {
  const cwd = cwdOf(chatId);
  await sendTelegramMessage(chatId, `当前目录：/${cwd}`);
}

async function cmdCd(chatId, args) {
  const raw = String(args || "").trim();
  if (!raw || raw === "/") {
    userCwd.set(chatId, "");
    return sendTelegramMessage(chatId, "当前目录：/");
  }
  const target = await resolvePath(raw, cwdOf(chatId));
  if (!target.ok) return sendTelegramMessage(chatId, target.message);
  userCwd.set(chatId, target.path);
  await sendTelegramMessage(
    chatId,
    `当前目录：/${target.path}\n（此后发下载链接，文件将存入此目录；/cd / 回根目录）`
  );
}

async function cmdMkdir(chatId, args) {
  const raw = String(args || "").trim();
  if (!raw) {
    return sendTelegramMessage(chatId, "用法：/mkdir 目录路径（支持多级，如 /mkdir 影视/剧集）");
  }
  const parts = normalizePath(raw).split("/").filter(Boolean);
  if (parts.length === 0) {
    return sendTelegramMessage(chatId, "用法：/mkdir 目录路径（支持多级，如 /mkdir 影视/剧集）");
  }
  let parentId = null;
  let walked = [];
  if (!raw.startsWith("/")) {
    const baseParts = cwdOf(chatId).split("/").filter(Boolean);
    if (baseParts.length > 0) {
      const base = await walkFolders(null, [], baseParts);
      if (!base.ok) return sendTelegramMessage(chatId, base.message);
      parentId = base.id;
      walked = baseParts;
    }
  }
  for (const part of parts) {
    const res = await tgApiJson(listUrl(parentId));
    if (!res.ok) return sendTelegramMessage(chatId, mapTgError(res));
    const folders = (res.data && res.data.folders) || [];
    const hit = folders.find(
      (f) => String(f.name).toLowerCase() === part.toLowerCase()
    );
    if (hit) {
      parentId = hit.id;
      walked.push(hit.name);
      continue;
    }
    const created = await tgApiJson("/api/bot/folders", {
      method: "POST",
      body: JSON.stringify({ name: part, parent_id: parentId }),
    });
    if (!created.ok) return sendTelegramMessage(chatId, mapTgError(created));
    parentId = created.data.id;
    walked.push(created.data.name);
  }
  await sendTelegramMessage(chatId, `目录已就绪：/${walked.join("/")}`);
}

async function cmdMv(chatId, args) {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return sendTelegramMessage(chatId, "用法：/mv <文件> [目标目录]（省略目标 = 当前目录，/ = 根目录）");
  }
  const file = await findFile(parts[0], cwdOf(chatId));
  if (file.error) return sendTelegramMessage(chatId, file.error);
  const targetRaw = parts.slice(1).join(" ");
  const target = await resolvePath(targetRaw, cwdOf(chatId));
  if (!target.ok) return sendTelegramMessage(chatId, target.message);
  const res = await tgApiJson(`/api/bot/files/${encodeURIComponent(file.shortId)}/move`, {
    method: "POST",
    body: JSON.stringify({ target_folder_id: target.id }),
  });
  if (!res.ok) return sendTelegramMessage(chatId, mapTgError(res));
  await sendTelegramMessage(
    chatId,
    `已移动 ${file.filename} 到 ${target.path ? `/${target.path}` : "/"}`
  );
}

async function cmdRename(chatId, args) {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return sendTelegramMessage(chatId, "用法：/rename <文件> <新文件名>");
  }
  const file = await findFile(parts[0], cwdOf(chatId));
  if (file.error) return sendTelegramMessage(chatId, file.error);
  const newName = parts.slice(1).join(" ").trim();
  if (!newName || newName.includes("/") || newName.includes("\\")) {
    return sendTelegramMessage(chatId, "新文件名不能为空，且不能包含 / 或 \\");
  }
  const res = await tgApiJson(`/api/bot/files/${encodeURIComponent(file.shortId)}`, {
    method: "PATCH",
    body: JSON.stringify({ filename: newName }),
  });
  if (!res.ok) return sendTelegramMessage(chatId, mapTgError(res));
  await sendTelegramMessage(
    chatId,
    `已重命名：${file.filename} -> ${res.data.filename}\n（short_id 不变，已发布的分享链接仍然有效）`
  );
}

async function cmdRm(chatId, args) {
  if (!args.trim()) {
    return sendTelegramMessage(chatId, "用法：/rm <文件>");
  }
  const file = await findFile(args.trim(), cwdOf(chatId));
  if (file.error) return sendTelegramMessage(chatId, file.error);
  const res = await tgApiJson(`/api/bot/files/${encodeURIComponent(file.shortId)}`, {
    method: "DELETE",
  });
  if (!res.ok) return sendTelegramMessage(chatId, mapTgError(res));
  const detail = res.data && res.data.details ? res.data.details : null;
  const tg = detail && detail.tg ? detail.tg : null;
  const failedChunks = tg && Array.isArray(tg.failed_chunks) ? tg.failed_chunks.length : 0;
  const lines = [`已删除：${file.filename}`];
  if (failedChunks > 0) {
    lines.push(`注意：有 ${failedChunks} 个分块删除失败，可稍后重试或检查 tgstate 日志。`);
  }
  await sendTelegramMessage(chatId, lines.join("\n"));
}

// /setcookie <cookie>：更新夸克直链 Cookie（存 tgstate 数据库，workflow 每次下载前实时取用），
// 成功后自动重派本会话最近一次下载任务。
async function cmdSetCookie(chatId, args) {
  const cookie = args.trim();
  if (!cookie) {
    const current = await tgApiJson("/api/bot/quark-cookie");
    if (!current.ok) return sendTelegramMessage(chatId, mapTgError(current));
    const has = !!(current.data && current.data.cookie);
    return sendTelegramMessage(
      chatId,
      has
        ? "当前已设置夸克 Cookie（内容不回显）。更新用法：/setcookie <新Cookie>"
        : "当前未设置夸克 Cookie（将回落使用 GitHub Secret GOPEED_COOKIE）。设置用法：/setcookie <Cookie>"
    );
  }
  if (cookie.length > 8000) {
    return sendTelegramMessage(chatId, `Cookie 过长（${cookie.length} 字符），请检查是否复制了多余内容。`);
  }
  const res = await tgApiJson("/api/bot/quark-cookie", {
    method: "POST",
    body: JSON.stringify({ cookie }),
  });
  if (!res.ok) return sendTelegramMessage(chatId, mapTgError(res));
  const lines = [
    `夸克 Cookie 已更新（长度 ${cookie.length} 字符），之后所有下载任务自动使用新 Cookie。`,
  ];
  const pending = lastDispatch.get(chatId);
  if (pending) {
    const resp = await dispatchDownload(pending.url, chatId, pending.folder);
    if (resp.ok) {
      lastDispatch.delete(chatId);
      lines.push("正在自动重试上次未完成的下载任务，完成后会回报。");
    } else {
      lines.push("自动重试提交失败，可稍后发 /retry 或直接重发链接。");
    }
  } else {
    lines.push("本会话没有待重试的下载任务。");
  }
  await sendTelegramMessage(chatId, lines.join("\n"));
}

// /retry：重派本会话最近一次下载任务（补完 Cookie 后 /setcookie 会自动做，也可手动）。
async function cmdRetry(chatId) {
  const pending = lastDispatch.get(chatId);
  if (!pending) {
    return sendTelegramMessage(
      chatId,
      "本会话没有记录到待重试的下载任务（bot 重启后记录会清空，直接重发链接即可）。"
    );
  }
  const resp = await dispatchDownload(pending.url, chatId, pending.folder);
  if (resp.ok) {
    lastDispatch.delete(chatId);
    return sendTelegramMessage(chatId, "已重新提交上次未完成的下载任务，完成后会回报。");
  }
  return sendTelegramMessage(chatId, mapTgError(resp));
}

async function cmdRmdir(chatId, args) {
  const raw = args.trim();

  const confirmMatch = /^confirm(?:\s+([\s\S]+))?$/.exec(raw);
  if (confirmMatch) {
    const pending = pendingRmdir.get(chatId);
    const check = validateRmdirConfirm(pending, confirmMatch[1] || "", cwdOf(chatId));
    if (!check.ok) return sendTelegramMessage(chatId, check.message);
    pendingRmdir.delete(chatId);
    const target = await resolvePath(pending.path);
    if (!target.ok) return sendTelegramMessage(chatId, target.message);
    if (target.id == null) {
      return sendTelegramMessage(chatId, "根目录不可删除。");
    }
    const res = await tgApiJson(`/api/bot/folders/${target.id}`, { method: "DELETE" });
    if (!res.ok) return sendTelegramMessage(chatId, mapTgError(res));
    const d = res.data || {};
    const lines = [
      `已级联删除：/${pending.path}`,
      `文件夹 ${d.folders_deleted || 0} 个，文件 ${d.files_deleted || 0} 个，释放 ${humanSize(d.bytes_freed || 0)}`,
    ];
    const failedFiles = d.failed_files || [];
    if (failedFiles.length > 0) {
      lines.push(
        "以下文件 Telegram 删除失败，已移回根目录，可稍后 /rm 重试：",
        ...failedFiles.map((f) => `  · ${f.filename}`)
      );
    }
    const failedChunks = d.failed_chunks || [];
    if (failedChunks.length > 0) {
      lines.push(`另有 ${failedChunks.length} 个分块删除失败，详情见 tgstate 日志。`);
    }
    return sendTelegramMessage(chatId, lines.join("\n"));
  }

  if (!raw) {
    return sendTelegramMessage(
      chatId,
      "用法：/rmdir <目录路径>（级联删除该目录下全部子目录与文件，需二次确认）"
    );
  }
  const target = await resolvePath(raw, cwdOf(chatId));
  if (!target.ok) return sendTelegramMessage(chatId, target.message);
  if (target.id == null) {
    return sendTelegramMessage(chatId, "根目录不可删除。");
  }
  const res = await tgApiJson(listUrl(target.id));
  if (!res.ok) return sendTelegramMessage(chatId, mapTgError(res));
  const fileCount = ((res.data && res.data.files) || []).length;
  pendingRmdir.set(chatId, {
    path: target.path,
    expiresAt: Date.now() + RMDIR_CONFIRM_TTL_MS,
  });
  await sendTelegramMessage(
    chatId,
    [
      `将级联删除 /${target.path}`,
      `（直接包含 ${fileCount} 个文件，子目录一并删除；目录内文件的分享链接将失效）`,
      `确认请在 60 秒内发送：/rmdir confirm /${target.path}`,
    ].join("\n")
  );
}

const COMMANDS = {
  ls: cmdLs,
  links: cmdLinks,
  pwd: cmdPwd,
  cd: cmdCd,
  mkdir: cmdMkdir,
  mv: cmdMv,
  rename: cmdRename,
  rm: cmdRm,
  rmdir: cmdRmdir,
  setcookie: cmdSetCookie,
  retry: cmdRetry,
};

async function handleCommand(chatId, text) {
  const cmd = parseCommand(text);
  if (!cmd) return false;
  if (cmd.name === "help" || cmd.name === "start") {
    await sendTelegramMessage(chatId, HELP_TEXT);
    return true;
  }
  const handler = COMMANDS[cmd.name];
  if (!handler) {
    await sendTelegramMessage(chatId, `未知命令 /${cmd.name}，发送 /help 查看支持的命令。`);
    return true;
  }
  if (!managementEnabled()) {
    await sendTelegramMessage(
      chatId,
      "tgstate 管理面未启用：请在 bot-worker 配置 TGSTATE_BOT_KEY（与 tgstate 的 BOT_API_KEY 一致）后重启。"
    );
    return true;
  }
  await handler(chatId, cmd.args);
  return true;
}

// ============================================================
// 下载派发（GitHub Actions）
// ============================================================

const MAX_URLS_PER_MESSAGE = 20;

function extractUrls(text) {
  const urls = [];
  const seen = new Set();
  const re = /magnet:\?[^\s<>"'`]+|ed2k:\/\/[^\s<>"'`]+|https?:\/\/[^\s<>"'`]+/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    if (/^https?:/i.test(raw)) {
      try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      } catch {
        continue;
      }
    }
    seen.add(raw);
    urls.push(raw);
    if (urls.length >= MAX_URLS_PER_MESSAGE) break;
  }
  return urls;
}

// 派发下载任务。folder: { targetFolderId, targetFolderPath } —— 派发那一刻
// 的当前目录；workflow 上传完成后把文件 move 进去。targetFolderId=null 表示根目录。
async function dispatchDownload(url, chatId, folder = { targetFolderId: null, targetFolderPath: "" }) {
  return fetch(`${GITHUB_API}/repos/${getEnv().GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${getEnv().GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "tg-download-bot",
    },
    body: JSON.stringify({
      event_type: EVENT_TYPE,
      client_payload: {
        url,
        chat_id: String(chatId),
        target_folder_id: folder.targetFolderId,
        target_folder_path: folder.targetFolderPath,
      },
    }),
  });
}

// 把当前目录解析成 { targetFolderId, targetFolderPath }；目录已消失时回落根目录。
async function resolveDispatchFolder(chatId) {
  const cwd = cwdOf(chatId);
  if (!cwd) return { targetFolderId: null, targetFolderPath: "" };
  const base = await walkFolders(null, [], cwd.split("/").filter(Boolean));
  if (!base.ok) {
    return { targetFolderId: null, targetFolderPath: "" };
  }
  return { targetFolderId: base.id, targetFolderPath: base.path };
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message || typeof message.text !== "string") return;

  const chatId = message.chat.id;
  const fromId = message.from ? message.from.id : null;

  if (!isAllowedUser(fromId)) {
    await sendTelegramMessage(chatId, "未授权用户，无法使用本机器人。");
    return;
  }

  const text = message.text.trim();

  if (await handleCommand(chatId, text)) return;

  const dispatchHints = {
    401: "GitHub Token 无效或过期。",
    403: "GitHub Token 权限不足，需要对仓库的 Contents 读写权限。",
    404: "仓库不存在或 Token 无权访问，请检查 GITHUB_REPO 配置。",
    422: "仓库中没有监听 download-task 事件的 workflow，请确认 workflow 文件已推送到默认分支。",
  };

  const urls = extractUrls(text);
  if (urls.length === 0) {
    await sendTelegramMessage(
      chatId,
      "未识别到下载链接，请发送 http/https、magnet 或 ed2k 链接；发送 /help 查看用法。"
    );
    return;
  }

  const describeUrl = (u) => {
    if (!/^https?:/i.test(u)) return u.length > 80 ? `${u.slice(0, 77)}...` : u;
    try {
      const parsed = new URL(u);
      const name = parsed.searchParams.get("filename");
      if (name) return `${parsed.host} · ${name}`;
    } catch {}
    return u.length > 80 ? `${u.slice(0, 77)}...` : u;
  };

  const submitted = [];
  const failed = [];
  const folder = await resolveDispatchFolder(chatId);
  const folderNote =
    folder.targetFolderPath != null && folder.targetFolderPath !== ""
      ? `\n下载完成后将存入：/${folder.targetFolderPath}`
      : "";
  for (const url of urls) {
    let resp;
    try {
      resp = await dispatchDownload(url, chatId, folder);
    } catch (e) {
      failed.push(`${describeUrl(url)}\n    网络错误：${e.message}`);
      continue;
    }
    if (resp.ok) {
      lastDispatch.set(chatId, { url, folder });
      submitted.push(url);
      continue;
    }
    const body = await resp.text().catch(() => "");
    const hint = dispatchHints[resp.status] || `HTTP ${resp.status} ${body.slice(0, 200)}`;
    failed.push(`${describeUrl(url)}\n    ${hint}`);
  }

  const lines = [];
  if (submitted.length > 0) {
    lines.push(
      `已提交 ${submitted.length} 个任务，GitHub Actions 排队处理中（完成后分享链接会逐条发到这里）：${folderNote}`,
      ...submitted.map((u) => `· ${describeUrl(u)}`)
    );
  }
  if (failed.length > 0) {
    lines.push(`提交失败 ${failed.length} 个：`, ...failed.map((f) => `· ${f}`));
  }
  await sendTelegramMessage(chatId, lines.join("\n"));
}

async function telegramCall(method, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const resp = await fetch(`${TELEGRAM_API}/bot${getEnv().BOT_TOKEN}/${method}${qs}`);
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || data.ok !== true) {
    const desc = data && data.description ? data.description : `HTTP ${resp.status}`;
    throw new Error(`${method} failed: ${desc}`);
  }
  return data.result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await telegramCall("deleteWebhook", { drop_pending_updates: "true" });
  console.log(
    `bot started, repo=${getEnv().GITHUB_REPO}, tgstate=${TGSTATE_URL} (管理面${
      managementEnabled() ? "已启用" : "未启用：缺少 TGSTATE_BOT_KEY"
    })`
  );

  let offset = 0;
  let backoff = 1000;

  for (;;) {
    try {
      const updates = await telegramCall("getUpdates", {
        offset: String(offset),
        timeout: String(POLL_TIMEOUT_SEC),
        allowed_updates: JSON.stringify(["message"]),
      });
      backoff = 1000;
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (e) {
          console.error(`handleUpdate error: ${e && e.stack ? e.stack : e}`);
        }
      }
    } catch (e) {
      console.error(`poll error: ${e.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

export {
  HELP_TEXT,
  extractUrls,
  findFile,
  handleCommand,
  handleUpdate,
  humanSize,
  mapTgError,
  normalizePath,
  parseCommand,
  renderListing,
  resolvePath,
  tgApiJson,
  validateRmdirConfirm,
  walkFolders,
};

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
