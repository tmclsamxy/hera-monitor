#!/usr/bin/env bash
#
# Hera Monitor Agent 一键安装脚本
#
# 用法（在目标服务器上执行）：
#   curl -fsSL http://<面板地址>:8080/install-agent.sh | bash -s -- --server http://<面板地址>:8080 --key <密钥>
#
# 卸载：
#   curl -fsSL http://<面板地址>:8080/install-agent.sh | bash -s -- --uninstall
#
set -u

ORIG_ARGS=("$@")

INSTALL_BIN="/usr/local/bin/hera-agent"
CONF_FILE="/etc/hera-agent.conf"
STATE_DIR="/var/lib/hera-agent"
SERVICE_NAME="hera-agent"
LOG_FILE="/var/log/hera-agent.log"
DEFAULT_REPO="${HERA_REPO:-}"

SERVER=""
KEY=""
INTERVAL=""
NAME=""
REGION=""
GROUP=""
REPO="$DEFAULT_REPO"
INSECURE=0
UNINSTALL=0
NO_START=0

RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; CYAN='\033[36m'; PLAIN='\033[0m'
[ -t 1 ] || { RED=''; GREEN=''; YELLOW=''; CYAN=''; PLAIN=''; }

info()  { printf '%s[hera]%s %s\n' "$CYAN" "$PLAIN" "$*"; }
ok()    { printf '%s[ ok ]%s %s\n' "$GREEN" "$PLAIN" "$*"; }
warn()  { printf '%s[warn]%s %s\n' "$YELLOW" "$PLAIN" "$*" >&2; }
die()   { printf '%s[fail]%s %s\n' "$RED" "$PLAIN" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Hera Monitor Agent 安装脚本

用法:
  install.sh --server <面板地址> --key <密钥> [选项]
  install.sh --uninstall

选项:
  --server URL     面板地址，例如 http://1.2.3.4:8080
  --key KEY        Agent 密钥（面板「设置」页获取）
  --interval N     上报间隔秒数，默认 30
  --name NAME      自定义显示名称
  --region REGION  地区标签，例如 CN / HK / JP
  --group GROUP    分组名
  --repo OWNER/REPO  GitHub 仓库（用于回退下载，可选）
  --insecure       跳过 HTTPS 证书校验
  --no-start       只安装不启动
  --uninstall      卸载 Agent
  -h, --help       显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server)    SERVER="${2:-}"; shift 2 ;;
    --key)       KEY="${2:-}"; shift 2 ;;
    --interval)  INTERVAL="${2:-}"; shift 2 ;;
    --name)      NAME="${2:-}"; shift 2 ;;
    --region)    REGION="${2:-}"; shift 2 ;;
    --group)     GROUP="${2:-}"; shift 2 ;;
    --repo)      REPO="${2:-}"; shift 2 ;;
    --insecure)  INSECURE=1; shift ;;
    --no-start)  NO_START=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) die "未知参数: $1（用 --help 查看用法）" ;;
  esac
done

# ----------------------------------------------------------------- 权限
if [ "$(id -u)" != "0" ]; then
  # 被 curl | bash 方式执行时 $0 不是真实文件，需要先把脚本落到临时文件再提权
  SELF="$0"
  if [ ! -f "$SELF" ]; then
    if [ -n "$SERVER" ] && curl -fsSL --connect-timeout 10 -o /tmp/hera-install.sh "${SERVER}/install-agent.sh" 2>/dev/null; then
      SELF=/tmp/hera-install.sh
    else
      die "需要 root 权限。请改用：curl -fsSL <面板地址>/install-agent.sh | sudo bash -s -- ${ORIG_ARGS[*]:-}"
    fi
  fi
  command -v sudo >/dev/null 2>&1 || die "当前不是 root 且未安装 sudo，请以 root 身份运行"
  info "需要 root 权限，正在通过 sudo 重新执行…"
  exec sudo -E bash "$SELF" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi

# ----------------------------------------------------------------- 卸载
if [ "$UNINSTALL" = "1" ]; then
  info "开始卸载 Hera Monitor Agent…"
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if [ -f "/etc/init.d/${SERVICE_NAME}" ]; then
    "/etc/init.d/${SERVICE_NAME}" stop >/dev/null 2>&1 || true
    rm -f "/etc/init.d/${SERVICE_NAME}"
  fi
  pkill -f "$INSTALL_BIN" >/dev/null 2>&1 || true
  rm -f "$INSTALL_BIN" "$CONF_FILE"
  rm -rf "$STATE_DIR"
  ok "已卸载。配置文件与状态目录均已删除。"
  exit 0
fi

[ -z "$SERVER" ] && die "必须提供 --server，例如 --server http://1.2.3.4:8080"
[ -z "$KEY" ] && die "必须提供 --key，可在面板「设置」页复制"
SERVER="${SERVER%/}"

# ------------------------------------------------------------- 依赖检查
command -v curl >/dev/null 2>&1 || die "未找到 curl，请先安装：apt install curl 或 yum install curl"

if command -v ss >/dev/null 2>&1; then
  :
elif [ ! -r /proc/net/dev ]; then
  warn "无法读取 /proc/net/dev，网速采集可能不可用"
fi

# ------------------------------------------------------------- 获取 Agent
TMP_AGENT="$(mktemp)"
cleanup() { rm -f "$TMP_AGENT"; }
trap cleanup EXIT

CURL_OPTS=(-fsSL --connect-timeout 10)
[ "$INSECURE" = "1" ] && CURL_OPTS+=(-k)

SRC_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo '')"
fetched=0

info "正在获取 Agent 程序…"
if curl "${CURL_OPTS[@]}" -o "$TMP_AGENT" "${SERVER}/agent/hera-agent.sh" 2>/dev/null \
   && head -n1 "$TMP_AGENT" | grep -q '^#!/usr/bin/env bash'; then
  fetched=1
  info "来源：面板自建分发"
elif [ -n "$REPO" ] && curl "${CURL_OPTS[@]}" -o "$TMP_AGENT" \
   "https://raw.githubusercontent.com/${REPO}/main/agent/hera-agent.sh" 2>/dev/null \
   && head -n1 "$TMP_AGENT" | grep -q '^#!/usr/bin/env bash'; then
  fetched=1
  info "来源：GitHub raw"
elif [ -n "$SRC_DIR" ] && [ -f "${SRC_DIR}/hera-agent.sh" ]; then
  cp "${SRC_DIR}/hera-agent.sh" "$TMP_AGENT"
  fetched=1
  info "来源：本地目录"
fi

[ "$fetched" = "1" ] || die "下载 Agent 失败，请检查面板地址是否可访问：${SERVER}"

install -m 0755 "$TMP_AGENT" "$INSTALL_BIN"
ok "已安装到 ${INSTALL_BIN}"

# ------------------------------------------------------------ 配置文件
umask 077
cat > "$CONF_FILE" <<EOF
# Hera Monitor Agent 配置（由安装脚本生成）
SERVER="${SERVER}"
KEY="${KEY}"
INTERVAL="${INTERVAL:-30}"
CFG_NAME="${NAME}"
CFG_REGION="${REGION}"
CFG_GROUP="${GROUP}"
EOF
chmod 600 "$CONF_FILE"
mkdir -p "$STATE_DIR"
ok "已写入配置 ${CONF_FILE}"

# ------------------------------------------------------------- 验证连通
info "正在验证与面板的连通性…"
if "$INSTALL_BIN" --once >/dev/null 2>&1; then
  ok "上报成功，面板上应该已经能看到这台服务器了"
else
  warn "首次上报未成功。可能原因：面板地址不可达 / 密钥不正确"
  warn "可手动排障：${INSTALL_BIN} --once  或  ${INSTALL_BIN} --print"
fi

[ "$NO_START" = "1" ] && { ok "已跳过启动（--no-start）"; exit 0; }

# --------------------------------------------------------------- 服务化
start_systemd() {
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Hera Monitor Agent
Documentation=${SERVER}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_BIN}
Restart=always
RestartSec=10
StartLimitBurst=0
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
NoNewPrivileges=true
ProtectHome=true
ProtectKernelTunables=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 1
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "systemd 服务已启动并设为开机自启（${SERVICE_NAME}）"
    return 0
  fi
  warn "systemd 服务启动失败，日志：journalctl -u ${SERVICE_NAME} -n 50"
  return 1
}

start_initd() {
  cat > "/etc/init.d/${SERVICE_NAME}" <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          ${SERVICE_NAME}
# Required-Start:    \$network \$remote_fs
# Required-Stop:     \$network \$remote_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Hera Monitor Agent
### END INIT INFO
case "\$1" in
  start) nohup ${INSTALL_BIN} >>${LOG_FILE} 2>&1 & echo \$! > /var/run/${SERVICE_NAME}.pid ;;
  stop)  [ -f /var/run/${SERVICE_NAME}.pid ] && kill "\$(cat /var/run/${SERVICE_NAME}.pid)" 2>/dev/null; pkill -f ${INSTALL_BIN} 2>/dev/null; rm -f /var/run/${SERVICE_NAME}.pid ;;
  restart) \$0 stop; sleep 1; \$0 start ;;
  status) pgrep -f ${INSTALL_BIN} >/dev/null && echo "running" || echo "stopped" ;;
  *) echo "Usage: \$0 {start|stop|restart|status}"; exit 1 ;;
esac
exit 0
EOF
  chmod +x "/etc/init.d/${SERVICE_NAME}"
  "/etc/init.d/${SERVICE_NAME}" restart >/dev/null 2>&1
  if [ -f /etc/rc.local ]; then
    grep -q "$SERVICE_NAME" /etc/rc.local || sed -i "1i /etc/init.d/${SERVICE_NAME} start >/dev/null 2>&1" /etc/rc.local
  else
    printf '#!/bin/sh -e\n/etc/init.d/%s start >/dev/null 2>&1\nexit 0\n' "$SERVICE_NAME" > /etc/rc.local
    chmod +x /etc/rc.local
  fi
  if pgrep -f "$INSTALL_BIN" >/dev/null 2>&1; then
    ok "sysvinit 服务已启动（${SERVICE_NAME}），日志：${LOG_FILE}"
    return 0
  fi
  warn "服务启动失败，可手动前台运行：${INSTALL_BIN}"
  return 1
}

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  info "检测到 systemd，正在注册系统服务…"
  start_systemd || true
else
  info "未检测到 systemd，使用 sysvinit 方式…"
  start_initd || true
fi

printf '\n'
ok "Hera Monitor Agent 安装完成"
printf '  %s面板地址%s  %s\n' "$CYAN" "$PLAIN" "$SERVER"
printf '  %s程序路径%s  %s\n' "$CYAN" "$PLAIN" "$INSTALL_BIN"
printf '  %s配置文件%s  %s\n' "$CYAN" "$PLAIN" "$CONF_FILE"
printf '  %s查看日志%s  tail -f %s\n' "$CYAN" "$PLAIN" "$LOG_FILE"
printf '  %s排障命令%s  %s --once   /   %s --print\n\n' "$CYAN" "$PLAIN" "$INSTALL_BIN" "$INSTALL_BIN"
