# TG Link Downloader

Telegram Bot 与 tgstate-rust 跑在同一台 VPS 上，GitHub Actions 用 Gopeed 下载，上传 tgstate（文件存入 Telegram 频道），可选 rclone 转存到网盘：

```
你在 Telegram 发送下载链接（http / magnet / ed2k）
        |
        v
VPS 上的 Bot 容器（getUpdates 长轮询，校验白名单）
        |  GitHub API: repository_dispatch
        v
GitHub Actions 安装 Gopeed CLI 并启动下载任务
        |  rclone copy work <RCLONE_DEST>
        v
你的网盘（rclone remote，配置来自 Secret RCLONE_CONF）
        |  登录 /api/auth/login，POST /api/upload
        v
同一台 VPS 上的 tgstate-rust（文件存入 Telegram 频道）
        |
        v
Actions 调 Bot API 把 rclone 目标与分享短链 /d/<id> 发回你的会话
```

## 目录结构

```
bot-worker/                     Telegram Bot（Node 长轮询）
  src/index.js
  Dockerfile
docker-compose.yml              Bot + tgstate 同机编排
.env.example                    环境变量模板（复制为 .env）
.github/workflows/download-upload.yml   Gopeed 下载 + rclone copy + tgstate 上传 + 回传链接
```

## 你需要准备的东西

| 组件 | 作用 |
|---|---|
| VPS（Docker + Docker Compose） | 同时跑 Bot 和 tgstate |
| 两个 Telegram Bot | 下载助手一个、网盘存文件一个，Token 不能共用 |
| GitHub 仓库 + Actions | 跑 Gopeed 下载、rclone 转存、回传网盘 |
| rclone（本机生成 conf） | 把下载结果 copy 到网盘 |
| 你的 Telegram 用户 ID | Bot 白名单 |

Telegram 每个 Bot 同时只能有一个 `getUpdates` 消费者。下载 Bot 和 tgstate 都在长轮询，必须用两个 Token。

## 第 1 步：创建两个 Bot

向 [@BotFather](https://t.me/BotFather) 各建一次 `/newbot`：

1. **下载 Bot**：你平时发链接给它。记下 Token，后面写入 `.env` 的 `BOT_TOKEN`。
2. **网盘 Bot**：只当频道管理员，把文件存进频道。Token 在 tgstate 网页「设置」里填。

向 [@userinfobot](https://t.me/userinfobot) 发任意消息，记下自己的 `Id`，填进 `ALLOWED_USER_IDS`。

再建一个 Telegram 频道，把**网盘 Bot**加成该频道管理员（发消息权限）。

## 第 2 步：本仓库推到 GitHub

workflow 必须在仓库**默认分支**。GitHub 上只放代码，不要提交 `.env`。

仓库 `Settings -> Secrets and variables -> Actions` 添加：

| Secret / Variable | 值 |
|---|---|
| `TGSTATE_URL` | 网盘公网地址，如 `https://tgstate.example.com`（结尾不带 `/`） |
| `TGSTATE_PASSWORD` | tgstate 管理员密码（第 4 步网页里设的） |
| `BOT_TOKEN` | **下载 Bot** 的 Token（把结果发回会话） |
| `RCLONE_CONF` | 可选，本机 `rclone.conf` 全文（含 remote 段，不要提交到仓库）。留空则跳过转存 |
| `RCLONE_DEST` | 可选，rclone 目标，如 `remote2:downloads`（可放 Actions Variables，也可放 Secrets）。留空则跳过转存 |
| `GOPEED_COOKIE` | 可选兜底 Cookie（推荐改用 TG `/setcookiefile`，见 Cookie 维护节）|
| `GOPEED_HEADERS` | 可选，额外 HTTP 头，每行 `Name: value`，如 `User-Agent: ...` |

再创建 **GitHub PAT**（Bot 用它触发 workflow）：

1. `Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens`
2. Repository access 只勾选本仓库；Permissions 里 `Contents` 选 **Read and write**
3. 复制 token，写入 VPS 上的 `.env` 的 `GITHUB_TOKEN`

`TGSTATE_PASSWORD` 要等网盘网页设好密码后再填；可以先把仓库推上去，Secrets 稍后补。

`RCLONE_CONF` 与 `RCLONE_DEST` 的写法见下面「rclone 转存」。

## Cookie 维护（/setcookiefile 文件方式）

需要登录态才能下的直链（如夸克）要带 Cookie。**设置流程**：把 Cookie 全文保存为
纯文本 txt 文件，在 TG 里发送 `/setcookiefile`，再上传该文件——Cookie 逐字节存入
VPS 的 tgstate 数据库，之后每次下载任务开始时 workflow 自动取最新的用，无需再碰
GitHub Secret。聊天输入框会把 `__` 字符当 Markdown 语义吞掉，直接粘贴文本写入已停用，
`/setcookie` 仅用于查看状态与取消文件接收。
旧任务需要重试时发 `/retry`（手动重派最近一次任务）。

取 Cookie：浏览器登录 pan.quark.cn → F12 开发者工具 → Network → 随便点一个请求
→ Request Headers 里 `Cookie:` 整段复制（不带前缀），存为 txt 文件。

**自动保活（无需再手动换 Cookie）**：夸克会话的关键字段 `__puus` 约 3 小时过期，过期后直链全部 412。
机器人会按周期（默认 90 分钟）剥离 `__puus` 请求一次夸克轻量接口 `/1/clouddrive/config`，
服务端就会在响应里重新下发新鲜的 `__puus`/`__pus`，自动合并回存——Cookie 因此长期有效，
这是 [YunX](https://github.com/CYQawa/YunX) 与 AList（AlistGo/alist#830）同款的会话续期机制。
连续 3 轮刷新失败（判定登录态真失效，约 4.5 小时）时机器人会主动发消息告警；
手动 `/setcookiefile` 写入后告警自动解除。周期由 `QUARK_KEEPALIVE_MINUTES` 控制（分钟，0 关闭保活）。

Secret `GOPEED_COOKIE` 降级为兜底：数据库里没设 Cookie 时才用它。

Gopeed CLI 本身不收 Cookie，workflow 改用官方 gopeed-web 二进制起本地 REST API，创建任务时把该 Secret 写进 `req.extra.header.Cookie`。magnet / ed2k 不使用 Cookie。还要伪装浏览器时，把额外请求头逐行放进 `GOPEED_HEADERS`（每行 `Name: value`）。

## 第 3 步：VPS 上启动 Bot + tgstate

需要 Docker 和 Docker Compose v2。把本仓库和 tgstate 源码放到同一目录：

```bash
git clone https://github.com/你的用户名/你的仓库.git
cd 你的仓库
git clone https://github.com/buyi06/tgstate-rust.git
cp .env.example .env
```

编辑 `.env`：

```
BOT_TOKEN=下载Bot的Token
GITHUB_TOKEN=github_pat_...
GITHUB_REPO=你的用户名/仓库名
ALLOWED_USER_IDS=你的Telegram用户ID
TGSTATE_PUBLIC_URL=https://tgstate.example.com
COOKIE_SECURE=0
TRUST_FORWARDED_FOR=0
TGSTATE_BOT_KEY=随机密钥
```

`TGSTATE_PUBLIC_URL` 填浏览器能打开网盘的地址。走 HTTPS 反代时把 `COOKIE_SECURE` 和 `TRUST_FORWARDED_FOR` 改成 `1`。

`TGSTATE_BOT_KEY` 是 bot 管理面（/ls /mkdir 等命令）访问 tgstate 的密钥，生成方式：

```bash
openssl rand -hex 24
```

不填或留空时这些管理命令会提示「未启用」，其余下载功能不受影响。compose 会把它同时注入 tgstate（`BOT_API_KEY`）和 bot（`TGSTATE_BOT_KEY`）。

启动：

```bash
docker compose up -d --build
```

Bot 启动时会调用 `deleteWebhook`，清掉以前绑在 Cloudflare 上的 webhook，再开始长轮询。

查看日志：

```bash
docker compose logs -f bot
docker compose logs -f tgstate
```

## 第 4 步：配置 tgstate 网页

浏览器打开 `http://VPS的IP:8000`（或你的域名）：

1. 按引导设置管理员密码（与 GitHub Secret `TGSTATE_PASSWORD` 相同）。
2. 登录后进入「设置」。
3. 填写**网盘 Bot** 的 Token 和频道（`@username` 或 `-100xxxxxxxxxx`）。
4. 点击「保存并应用」。
5. 网页上传一个小文件，确认能生成 `/d/<short_id>`。

GitHub Actions 的 `TGSTATE_URL` 填这个公网地址。若 VPS 只有 IP、没有 HTTPS，Actions 也能用 `http://公网IP:8000`，但 Cookie 的 Secure 标志不要开。

## rclone 转存（可选）

文件上传 tgstate 后已经存进 Telegram 频道（tgstate 本身就是电报网盘）。rclone 的作用是把文件额外备份一份到传统网盘；两个 Secret 都留空时 workflow 自动跳过这一步。

写法对齐 [pikpak2cloud](https://github.com/ykxVK8yL5L/pikpak2cloud)：Secret 里放 rclone 配置全文，workflow 写入 `~/.config/rclone/rclone.conf`，再 `rclone copy`。

本机先配好 rclone（OneDrive / 阿里云盘 / S3 等均可）：

```bash
rclone config
rclone lsd remote2:
```

把配置文件全文复制进 GitHub Secret `RCLONE_CONF`。常见路径：

```
Linux: ~/.config/rclone/rclone.conf
macOS: ~/.config/rclone/rclone.conf
Windows: %APPDATA%\rclone\rclone.conf
```

`RCLONE_DEST` 填「远端名 + 路径」，例如：

```
remote2:downloads
```

workflow 会执行：

```bash
rclone copy work "$RCLONE_DEST" --progress --transfers 4 --checkers 8 --retries 3
```

`work/` 是 Gopeed 的下载目录，多文件会原样 copy 过去（zip 只给 tgstate 上传用）。

## 第 5 步：测试

给**下载 Bot**发一条公开直链，例如 `https://speed.hetzner.de/100MB.bin`：

1. Bot 回复「任务已提交」。
2. 仓库 Actions 页面出现 `Download, rclone copy, and upload to tgstate`。
3. 跑完后 Bot 把 rclone 目标与 `https://<tgstate地址>/d/<short_id>` 发回会话。

`/help` 查看说明。磁力链和 ed2k 同样直接发给 Bot。

## 日常使用

直接给下载 Bot 发一条链接。取消排队中的任务：去 Actions 页面手动 Cancel。

## 当前目录与自动归档

Bot 为每个会话记一个「当前目录」（默认根目录）。`/cd 影视/2026` 切换后，再发下载链接，任务完成后文件自动存入该目录（目录在下载期间被删则回落根目录）。`/cd /` 回根目录，`/pwd` 查看当前位置。管理命令里的相对路径都基于当前目录，`/` 开头表示从根开始。

## 管理命令

```
/pwd                      查看当前目录
/cd [目录路径]            切换当前目录，/cd / 回根目录
/ls [目录路径]            浏览目录，省略 = 当前目录
/mkdir <目录路径>         创建目录（相对当前目录，支持多级）
/mv <文件> [目标目录]     移动文件，省略目标 = 当前目录，/ = 根目录
/rename <文件> <新文件名> 重命名文件（分享链接保持不变）
/rm <文件>                删除单个文件
/rmdir <目录路径>         级联删除目录，60 秒内发 /rmdir confirm <路径> 二次确认
/help                     查看全部用法
```

文件参数写 10 位 short_id（如 `aBc123XyZ9`）或「路径/文件名」（如 `EP01.mkv`），名称匹配大小写不敏感；有同名时 Bot 会列出候选。

自动归档依赖 GitHub secret `BOT_API_KEY`（值与 `.env` 的 `TGSTATE_BOT_KEY` 一致）：workflow 上传完成后调用 move 接口把文件挪进派发时的目录；secret 未配置或移动失败时文件暂存根目录，回报消息会注明，可 `/mv` 手动移动。

## 网页面板目录管理

tgstate 网页（`http://VPS:8000`，登录管理员密码）的「文件管理」页与 Bot 共用同一套目录数据：

- 面包屑 + 目录卡片浏览，点目录进入，点面包屑回退
- 「+ 新建目录」在当前目录下创建；目录卡片可改名、删除（级联，确认后直接真删）
- 文件行有「移动」「改名」按钮；移动输入路径（`/` = 根，`/影视/2026` = 逐层目录），与 Bot 的 /mv 语义一致
- 两边改动实时互通：Bot 里 /mkdir 建的目录网页立刻可见，反之亦然

更新代码后在 VPS 上：

```bash
git pull
docker compose up -d --build
```

## 限制与调优

| 事项 | 说明 |
|---|---|
| 文件大小 | 默认上限 10GB（`MAX_FILESIZE_GB`），GitHub 托管 runner 磁盘约 14GB |
| 任务时长 | job `timeout-minutes: 55`，冷门磁力可调大（上限 360） |
| 并发连接 | `GOPEED_CONNECTIONS` 默认 16 |
| 并发任务 | `concurrency.group = download-task` 串行执行 |
| Actions 额度 | 公共仓库无限时长；私有仓库每月 2000 分钟免费 |
| 链接类型 | http/https、`.torrent` URL、magnet、ed2k |
| 分享安全 | 短链即访问凭据，私密文件在 tgstate 网页给该文件设分享密码 |
| 两个 Bot | 下载 Bot 与网盘 Bot 必须分开，不能共用 Token |
| rclone | Secret `RCLONE_CONF` + `RCLONE_DEST`；下载完成后 `rclone copy work <目标>` |
| Cookie | 优先 tgstate 数据库（bot `/setcookiefile` 设置，workflow 实时拉取）；未设置时回落 Secret `GOPEED_COOKIE`（可选 `GOPEED_HEADERS`）|
| Cookie 保活 | bot 内置 __puus 周期刷新（YunX/AList 同款），`QUARK_KEEPALIVE_MINUTES` 默认 90 分钟、0 关闭；连续失效会 TG 告警 |

多文件任务打包 zip 时按需启用「边打包边腾空间」（HatchZip 思路）：仅当「源文件 + 压缩包」同时驻留磁盘可能撑爆 runner（按未压缩估算最坏情况）时，才在每个文件写进压缩包后立刻删除原文件，磁盘峰值降到约等于两者中较大者；余量充足的小任务保持常规打包、源文件不动。Gopeed 残留的 `*.part` 半成品一律剔除、不上传。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| Bot 无回复 | `docker compose logs bot`；检查 `BOT_TOKEN`、是否仍有旧 webhook |
| 「未授权用户」 | `ALLOWED_USER_IDS` 与 @userinfobot 的 Id 不一致 |
| 「任务提交失败：401/403」 | `GITHUB_TOKEN` 过期或权限不足 |
| 「任务提交失败：422」 | workflow 未在默认分支，或 event 名不是 `download-task` |
| Actions 登录网盘失败 | `TGSTATE_URL` / `TGSTATE_PASSWORD` 错误；URL 结尾不要 `/` |
| rclone copy 失败 | `RCLONE_CONF` 不是 conf 全文，或 `RCLONE_DEST` 远端名与 conf 里的 `[remote]` 对不上 |
| 直链 403 / 需要登录 | TG 发 `/setcookiefile` 上传 Cookie 文件（设置后可 `/retry`）；或兜底补 Secret `GOPEED_COOKIE` |
| 收到「夸克 Cookie 保活失效」告警 | 存储的夸克会话已真失效（连续 3 轮刷新失败）。按告警提示重新导出 Cookie，`/setcookiefile` 上传即可；保活会自动恢复 |
| 网盘里有删不掉的 `.part` 文件 | 上传半途而废的残留，tgstate 因 TG 主消息不完整而拒绝删除。VPS 仓库目录运行 `./tools/clean-part-residue.sh`（先预览，`--apply` 真删） |
| tgstate 提示缺 Bot/频道 | 网页设置里填的是网盘 Bot，不是下载 Bot |
| 网页登录后立刻掉线 | HTTPS 反代时设置 `COOKIE_SECURE=1` |
| 频道不同步新文件 | 网盘 Bot 与下载 Bot 共用了 Token，拆成两个 |

## 安全说明

- Bot 只响应 `ALLOWED_USER_IDS` 白名单内的用户。
- `.env` 留在 VPS 本地，已在 `.gitignore` 中，不要提交。
- GitHub PAT 使用 fine-grained 模式，只给本仓库 Contents 读写权限。
- 不要把 VPS 的 8000 端口裸奔到公网太久；有域名时用 Caddy / nginx 做 HTTPS 反代。
