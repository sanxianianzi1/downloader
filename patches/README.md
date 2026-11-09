# patches/

上游克隆的本地补丁。`tgstate-rust/` 本身被 `.gitignore` 排除，补丁存在这里，
所以新机器可以完整复原。

## tgstate-rust-10gib-body-limit.patch

把 tgstate-rust 的上传体积上限从 **512 MiB** 提到 **10 GiB**。

- 基线：上游 `buyi06/tgstate-rust` 提交 `bf4253a`（tag `v2.1.7`）
- 改动：`src/constants.rs`、`src/main.rs`（+18 / -3）
- 新增环境变量：`MAX_UPLOAD_BODY_SIZE_MB`（兆字节，最小 16，默认 10240）

### 为什么需要

`src/main.rs` 原本写死 `.layer(DefaultBodyLimit::max(512 * 1024 * 1024))`。
axum 的 `DefaultBodyLimit` 在**读取请求体阶段**就中断连接，早于业务 handler 执行，
所以超过 512 MiB 的上传失败时**容器日志里没有任何业务错误**，只有客户端看到连接被断开。

补丁把常量换成运行时读取的函数 `max_upload_body_size()`，并在启动日志里打印实际上限。

### 怎么用

仓库根目录执行：

    ./setup-tgstate-rust.sh

自动完成：clone 上游 → 切到基线 → 打补丁 → 自检 → `docker compose up -d --build`。
只想准备代码、不构建，加 `--prep`。

### 手动打补丁

    cd tgstate-rust
    git apply ../patches/tgstate-rust-10gib-body-limit.patch

### 升级上游版本时

上游发新版本后补丁可能不再干净应用。步骤：

1. `cd tgstate-rust && git fetch --tags`
2. 挑新 tag，先试 `git apply --check ../patches/tgstate-rust-10gib-body-limit.patch`
3. 冲突就手工改两处：`src/constants.rs` 的 `max_upload_body_size()`，
   `src/main.rs` 的 `.layer(DefaultBodyLimit::max(max_body))`
4. 用 `git diff <旧tag> HEAD > ../patches/tgstate-rust-10gib-body-limit.patch` 重新导出，
   并同步更新 `setup-tgstate-rust.sh` 里的 `BASE`

### 验证上限是否生效

容器启动日志会打印一行 `上传体积上限: 10240 MiB`。检查：

    docker compose logs tgstate | grep 上传体积上限

## tgstate-rust-folders-botapi.patch

给 tgstate-rust 加**文件夹树**和 **bot 管理面 API**（/api/bot/*）。

- 基线：上游 `bf4253a`（v2.1.7）+ 前两个补丁
- 改动：`src/database.rs`（+249）、`src/middleware/auth.rs`（+2）、
  `src/routes/api_bot.rs`（新文件）、`src/routes/mod.rs`（+2）
- 新增环境变量：`BOT_API_KEY`（bot 管理面密钥）

### 功能

`folders` 表（id / name / parent_id）+ `files.folder_id` 列（NULL = 根目录），
沿用 PRAGMA 检查式迁移，旧库原地升级。workflow 上传的文件照旧落根目录。

### API（全部走 X-Bot-Key 头）

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | /api/bot/folders?parent_id=N | 列子目录+文件（省略 parent_id = 根） |
| POST | /api/bot/folders | 建目录 {name, parent_id?} |
| POST | /api/bot/folders/:id/rename | 目录改名 {name} |
| DELETE | /api/bot/folders/:id | 级联删除（递归 CTE 收子树，逐文件走 TG 删除流程） |
| POST | /api/bot/files/:file_id/move | 移动 {target_folder_id?}（null = 根） |
| PATCH | /api/bot/files/:file_id | 文件改名 {filename} |
| DELETE | /api/bot/files/:file_id | 删文件（同面板删除流程） |

### 安全模型

- `BOT_API_KEY` 未配置 → 整面 503（fail closed），bot 侧收到明确提示
- `X-Bot-Key` 常量时间比对（复用 `auth::secure_compare`），不匹配 → 401
- 全局 auth 中间件放行 `/api/bot/` 前缀，鉴权由本模块自理
- 面板 UI 的会话登录、上传、分享链接完全不受影响

### 删除语义（与面板一致）

- 主消息删除成功 → 删 DB 行、累计释放字节；分块失败仅记录 failed_chunks
- 主消息删除失败 → 文件行保留并移回根目录，列入 failed_files 供重试
- 已发布的 /d/<short_id> 链接：move/rename 不改 short_id，持续有效；删除即失效

### 验证

    curl -s -H "X-Bot-Key: $TGSTATE_BOT_KEY" http://127.0.0.1:8000/api/bot/folders

## tgstate-rust-panel-folders.patch

给**网页面板**加上目录管理：浏览、新建、改名、级联删除、文件移动/改名。
与 bot 管理面共用同一套 `folders` 数据，两端互通。

- 基线：上游 `bf4253a`（v2.1.7）+ 前三个补丁
- 改动：`src/routes/api_bot.rs`（+94）、`src/database.rs`（+60）、
  `src/routes/pages.rs`（+32）、`src/routes/mod.rs`（+1）、
  `app/templates/index.html`、`app/static/js/main.js`、`app/static/css/style.css`
- 无新增环境变量、无新增数据库迁移（复用第三补丁的 `folders` 表）

### 功能（网页 · 文件管理页）

- 面包屑导航 + 目录卡片，全部**服务端渲染**（`/?folder_id=N` 纯链接跳转），
  浏览器缓存 / JS 失效都不影响目录浏览
- 「+ 新建目录」在当前目录下创建；目录卡片可改名、删除（级联确认后真删，TG 无回收站）
- 文件行有「移动」「改名」按钮；移动输入路径（`/` = 根，`/影视/2026` = 逐层目录，
  服务端解析，与 bot 的 /mv 一致）；文件列表只显示当前目录直属文件
- 两边改动实时互通：Bot 里 /mkdir 建的目录网页立刻可见，反之亦然

### API（复用 bot 的 handler，走面板会话鉴权，未登录 401）

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | /api/folders?parent_id=N | 列子目录+文件（省略 parent_id = 根） |
| POST | /api/folders | 建目录 {name, parent_id?} |
| POST | /api/folders/:id/rename | 目录改名 {name} |
| DELETE | /api/folders/:id | 级联删除（与 bot 同流程，返回失败清单） |
| POST | /api/files/:file_id/move | 移动 {target_folder_id?} 或 {target_path?} |
| PATCH | /api/files/:file_id/rename | 文件改名 {filename} |

handler 在 `api_bot.rs` 内与 `/api/bot/*` 共用（单一实现两处挂载），
面板路由不挂 X-Bot-Key 层，由全局会话中间件保护。
首页 SSR（`/?folder_id=N`）与 `/api/files` 的文件对象均带 `folder_id`
（`pages.rs` 的 `enrich_files` 必须透传该键，模板 `{{ f.folder_id }}`
缺键会让 Tera 渲染失败返回 500——这是历史坑，勿删）。

### 注意

- 目录导航是纯链接（SSR），CRUD 操作后 `location.reload()` 刷新视图
- 搜索框仅过滤当前目录视图内的行
- 部署后浏览器需强刷（模板版本号已升到 `?v=5.7`）

### 验证

浏览器登录面板 → 文件管理页应出现面包屑与「+ 新建目录」；
或 `curl -b <登录cookie> http://127.0.0.1:8000/api/folders`。

## tgstate-rust-quark-cookie.patch

加运行期凭据 KV 存储（`kv_store` 表）与两个 bot 面端点，支撑
「TG 里 /setcookie 补夸克 Cookie → workflow 下载前实时取用」的闭环，
彻底绕开 GitHub Secret 的手动更新。

- 基线：上游 `bf4253a`（v2.1.7）+ 前四个补丁
- 改动：`src/database.rs`（+45：kv_store 表 + kv_get/kv_set）、
  `src/routes/api_bot.rs`（+60）
- 无新增环境变量；数据库新表 `kv_store(key, value, updated_at)`，自动创建

### 端点（X-Bot-Key 鉴权）

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | /api/bot/quark-cookie | 读 Cookie `{cookie: string \| null}` |
| POST | /api/bot/quark-cookie | 写 Cookie `{cookie}`；空串 = 清除；上限 8KB |

### 配套（不在本补丁内）

- bot-worker：/setcookiefile 文件方式写入（唯一写入通道）、/setcookie 查看状态、/retry（手动重试）、
  夸克 Cookie 保活（周期剥离 __puus 请求 /config 续期，读/写走本节的两个端点）
- workflow：Validate link 步骤优先从 tgstate 拉 Cookie，回落 Secret GOPEED_COOKIE；
  下载前做一次 __puus 惰性刷新并回写本端点；失败通知在预检 412/403 时提示 /setcookiefile 补法

### 验证

    curl -s -H "X-Bot-Key: $TGSTATE_BOT_KEY" http://127.0.0.1:8000/api/bot/quark-cookie

## tgstate-rust-429-flood-hardening.patch

加固 Telegram 上传的限流处理，解决并行上传多文件时被 flood control 卡死的问题。

- 基线：上游 `bf4253a`（v2.1.7）+ 前四个补丁
- 改动：`src/constants.rs`（+11）、`src/telegram/service.rs`（+38）
- 新增环境变量：`TG_SEND_GLOBAL_CONCURRENCY`（1..=4，默认 1 = 全局串行上传）

### 内容

- `TG_UPLOAD_MAX_RETRIES` 4 → 8
- 新增进程级全局上传信号量 `global_upload_semaphore()`：Telegram 按**累计体积**
  对 bot 的大文件上传限流，并行多文件上传最容易触发；默认全局限流为 1 路
- `retry_after_secs` 识别 **400 包装的 flood 变体**
  （`Bad Request: too Many Requests: retry after N`，注意非标准大小写），
  从 description 解析等待秒数，上限 60s，附 3 个单元测试

## tgstate-rust-ssr-batch-move.patch

网页面板加**批量移动**按钮：选中多个文件 → 输入目标目录路径（`/` = 根，
`/影视/2026` 逐层解析）→ 逐个调 `/api/files/:id/move`，汇总成功/失败数。

- 基线：上游 `bf4253a`（v2.1.7）+ 前五个补丁
- 改动：纯前端 `app/static/js/main.js`、`app/templates/index.html`
- 无后端改动（复用 move 端点）

## tgstate-rust-v2.1.7-cumulative-fix.patch

**累计补丁**：基线 `bf4253a` 到 VPS 当前工作区的全部未提交改动
（6 个历史补丁 + 本节 48h 孤儿修复，13 文件 +1720/−32，含新文件 `api_bot.rs`）。
新机器复原时用它一个补丁即可替代以上全部；上游升级时也以它为重新 diff 的起点。

- 来源：VPS `/root/patches/tgstate-v2.1.7-fix.patch`，2026-11-09 导出
- 已验证：`git apply --check -R` 可干净回滚；`cargo test` 19 passed；
  运行时验收（容器 healthy、13918 老文件删除成功、成功路径回归）通过
- 辅助文件 `Dockerfile.check`（tgstate-checker:1.87 检查镜像）在补丁外，随 compose 目录留存

### 48h 孤儿修复内容（本次新增，`terminal_orphan` 语义）

背景：Telegram Bot API 硬限制 `deleteMessage` 只能删 48 小时内的消息。
老文件删除时主消息/分片返回 `Bad Request: message can't be deleted`，
修复前原因被写死成 `"error"` 丢弃、整单误报 500、DB 行永久卡住。

- **P0 可观测性**：`delete_message` 失败原因保留 `tg_http_<status>: <description>`
  并落 `tracing::warn!`；分片失败汇总「N 个分片删除失败，首条错误: …」
- **P1 终态分类**：`can't be deleted`/`cant be deleted`（大小写不敏感）归类为
  `terminal_orphan`——永久残留、重试无意义，与可重试失败（限流 `rate_limited_Ns`、
  网络错误）严格区分；`DeleteResult` 新增 `orphaned_chunks`/`main_orphaned` 字段与
  `main_clear()`/`orphaned_count()`；主消息「已删或超 48h」即允许删 DB 行；
  全部分片「已删或超 48h」时状态为 `orphaned`，任一分片非终态失败则为
  `partial_failure`（面板/批量/级联删除同语义）
- **P2 逃生口**：`DELETE /api/bot/files/:id?force_db=1` 跳过 Telegram 只删 DB 行，
  用于 TG 侧故障时的人工清理
- 面板与批量删除（`api_files.rs`）同步改用 `main_clear()` 并在响应里回传
  `tg_orphaned`/`orphaned_count`；bot-worker 的 /rm 会把残留条数转告用户

### 回滚（VPS）

    cd /root/downloader/downloader/tgstate-rust
    git apply -R /root/patches/tgstate-v2.1.7-fix.patch
    cd .. && docker compose build tgstate && docker compose up -d tgstate
