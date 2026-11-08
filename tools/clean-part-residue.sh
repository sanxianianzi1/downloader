#!/usr/bin/env bash
#
# 清理 tgstate 里未完成上传遗留的 .part 残留。
#
# 背景：tgstate 只有在 Telegram 主消息删除成功后才删数据库行。上传半途而废的
# 文件（文件名形如 xxx.part）主消息往往不完整或根本不存在，于是网页面板和
# bot 的 /rm 都会失败，残留在网盘里永远删不掉。本脚本直接清理数据库行和
# 数据目录里的孤儿 .part 临时文件。
#
# 用法（VPS 上，仓库根目录）：
#   ./tools/clean-part-residue.sh           预览模式，只列出将被清理的内容
#   ./tools/clean-part-residue.sh --apply   备份数据库后真正删除
#
# 安全措施：
#   - 默认只预览，不加 --apply 不做任何改动
#   - apply 前自动备份数据库文件到 backups/clean-part-<时间戳>/
#   - apply 期间短暂停止 tgstate 容器，避免写入竞争，结束自动拉起
#   - 只动文件名以 .part 结尾的行，其余数据一律不碰
#
# 说明：清理只删 tgstate 的数据库记录与残留临时文件；残留在 Telegram 频道里
# 的半成品消息不受影响（tgstate 本来也删不到它们），对使用没有任何影响。

set -euo pipefail
cd "$(dirname "$0")/.."

APPLY=0
if [ "${1:-}" = "--apply" ]; then
  APPLY=1
elif [ -n "${1:-}" ]; then
  echo "用法：$0 [--apply]（不带参数 = 只预览）" >&2
  exit 1
fi

# 1. 定位 tgstate 数据卷在宿主机上的真实路径
CID=$(docker compose ps -aq tgstate | head -n1)
if [ -z "$CID" ]; then
  echo "找不到 tgstate 容器，请在仓库根目录运行（docker compose ps 检查）。" >&2
  exit 1
fi
MOUNT=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' "$CID")
if [ -z "$MOUNT" ]; then
  echo "tgstate 容器没有挂载 /app/data，无法定位数据库。" >&2
  exit 1
fi
echo "数据卷位置：$MOUNT"

# 2. 预览 / 应用
if [ "$APPLY" != 1 ]; then
  echo "==> 预览模式（不做任何改动）"
  docker run --rm -v "$MOUNT":/data:ro python:3-alpine python3 - <<'PY'
import glob
import os
import sqlite3

found = False
for db in sorted(glob.glob("/data/*.db") + glob.glob("/data/*.sqlite*")):
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        rows = conn.execute(
            "SELECT filename, filesize, upload_date FROM files "
            "WHERE filename LIKE '%.part' ORDER BY upload_date"
        ).fetchall()
        conn.close()
    except sqlite3.Error as e:
        print(f"  {os.path.basename(db)}: 跳过（{e}）")
        continue
    print(f"  {os.path.basename(db)}: {len(rows)} 个 .part 残留行")
    for name, size, date in rows:
        print(f"    - {name}  {size} 字节  {date}")
    if rows:
        found = True

parts = glob.glob("/data/**/*.part", recursive=True)
print(f"  数据目录孤儿 .part 临时文件：{len(parts)} 个")
for p in parts:
    print(f"    - {p}  {os.path.getsize(p)} 字节")
if parts or found:
    print("确认无误后运行：./tools/clean-part-residue.sh --apply")
else:
    print("没有需要清理的残留。")
PY
  exit 0
fi

# 3. apply：备份数据库 → 停 tgstate → 删除 → 重启
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="backups/clean-part-$STAMP"
mkdir -p "$BACKUP_DIR"
echo "==> 备份数据库到 $BACKUP_DIR/"
docker run --rm -v "$MOUNT":/data:ro -v "$PWD/$BACKUP_DIR":/backup python:3-alpine \
  sh -c 'cp /data/*.db* /backup/ 2>/dev/null; cp /data/*.sqlite* /backup/ 2>/dev/null; ls -la /backup/'
if [ -z "$(ls -A "$BACKUP_DIR")" ]; then
  echo "备份为空（未找到数据库文件），中止。" >&2
  exit 1
fi

echo "==> 停止 tgstate"
docker compose stop tgstate

echo "==> 清理 .part 残留"
docker run --rm -v "$MOUNT":/data python:3-alpine python3 - <<'PY'
import glob
import os
import sqlite3

total_rows = 0
for db in sorted(glob.glob("/data/*.db") + glob.glob("/data/*.sqlite*")):
    try:
        conn = sqlite3.connect(db)
        cur = conn.execute("DELETE FROM files WHERE filename LIKE '%.part'")
        conn.commit()
        conn.close()
    except sqlite3.Error as e:
        print(f"  {os.path.basename(db)}: 清理失败（{e}）")
        continue
    print(f"  {os.path.basename(db)}: 删除 {cur.rowcount} 行")
    total_rows += cur.rowcount

removed = 0
for p in glob.glob("/data/**/*.part", recursive=True):
    try:
        os.remove(p)
        removed += 1
        print(f"  已删除临时文件 {p}")
    except OSError as e:
        print(f"  跳过 {p}: {e}")

print(f"==> 完成：数据库行 {total_rows}，临时文件 {removed}")
PY

echo "==> 重新启动 tgstate"
docker compose start tgstate
docker compose ps tgstate
echo "完成。浏览器强刷网页面板即可看到 .part 残留已消失（如仍显示是页面缓存）。"
