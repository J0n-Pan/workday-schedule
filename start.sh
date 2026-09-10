#!/usr/bin/env sh
# 工作日程 — macOS / Linux 启动脚本
#
# 用法：
#   ./start.sh              # 启动服务并打开浏览器（默认 5173 端口）
#   PORT=5174 ./start.sh    # 换端口
#
# 需要 Node >= 22.5（项目运行在 node:sqlite 上）。若项目内自带 runtime/node 则优先使用。

set -e
cd "$(dirname "$0")"

PORT="${PORT:-5173}"
URL="http://127.0.0.1:${PORT}/"

# --- 选择 Node 运行时：项目自带 -> PATH ---
if [ -x "./runtime/node" ]; then
  NODE_BIN="./runtime/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  echo "未找到 Node 运行时（需要 Node >= 22.5）。"
  echo "请先安装：https://nodejs.org/   或   brew install node"
  exit 1
fi

VER="$("$NODE_BIN" -v 2>/dev/null || echo v0)"
MAJOR="$(printf '%s' "$VER" | sed 's/^v\([0-9]*\).*/\1/')"
if [ "${MAJOR:-0}" -lt 22 ]; then
  echo "Node 版本过低：${VER}（需要 >= 22.5）"
  echo "请升级：https://nodejs.org/"
  exit 1
fi

is_up() {
  curl -fs --noproxy '*' --max-time 1 "${URL}api/health" >/dev/null 2>&1
}

if is_up; then
  echo "服务已在运行：${URL}"
else
  echo "启动服务中..."
  PORT="$PORT" "$NODE_BIN" server/index.js >/dev/null 2>&1 &
  i=0
  while [ "$i" -lt 75 ]; do
    if is_up; then break; fi
    i=$((i + 1))
    sleep 0.2
  done
  if ! is_up; then
    echo "服务启动失败。请直接运行以查看日志："
    echo "  PORT=${PORT} ${NODE_BIN} server/index.js"
    exit 1
  fi
  echo "服务就绪：${URL}"
fi

if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1
else
  echo "请手动在浏览器打开：${URL}"
fi
