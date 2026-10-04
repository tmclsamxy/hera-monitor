#!/usr/bin/env bash
#
# 在临时实例上运行端到端测试（不会碰你的正式数据）
#
#   bash test/run.sh
#
# 依赖：本机有 node，且没有代理劫持 localhost（必要时先 unset HTTP_PROXY 等）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${HERA_TEST_PORT:-18099}"
DATA_DIR="$(mktemp -d)"
LOG="${DATA_DIR}/server.log"
NODE_BIN="${NODE_BIN:-node}"

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# 本机回环不要走代理，否则连接会被劫持
export NO_PROXY="127.0.0.1,localhost,::1,${NO_PROXY:-}"
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

echo "[test] 启动临时实例：端口 ${PORT}，数据目录 ${DATA_DIR}"
HERA_PORT="$PORT" HERA_HOST=127.0.0.1 HERA_DATA_DIR="$DATA_DIR" \
  "$NODE_BIN" "$ROOT/server/src/index.js" > "$LOG" 2>&1 &
SERVER_PID=$!

# install.sh 的参数测试（纯本地，不依赖上面的服务端）
echo ""
bash "$ROOT/test/install-args.sh"
ARGS_CODE=$?
if [ "$ARGS_CODE" -ne 0 ]; then
  echo "[test] install.sh 参数测试未通过"
fi
echo ""

for _ in $(seq 1 40); do
  if curl -fsS --noproxy '*' "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[test] 服务启动失败，日志："
    cat "$LOG"
    exit 1
  fi
  sleep 0.5
done

if ! curl -fsS --noproxy '*' "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1; then
  echo "[test] 服务在 20 秒内未就绪，日志："
  cat "$LOG"
  exit 1
fi

HERA_TEST_BASE="http://127.0.0.1:${PORT}" HERA_TEST_DATA="$DATA_DIR" "$NODE_BIN" "$ROOT/test/e2e.js"
CODE=$?

# 任一环节失败，整体就算失败
if [ "$ARGS_CODE" -ne 0 ] && [ "$CODE" -eq 0 ]; then
  CODE=$ARGS_CODE
fi

echo "[test] 退出码：$CODE"
exit $CODE
