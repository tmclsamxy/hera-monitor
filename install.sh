#!/usr/bin/env bash
#
# Hera Monitor 服务端一键部署脚本
#
# 用法：
#   # 从仓库直接部署（推荐）
#   curl -fsSL https://raw.githubusercontent.com/tmclsamxy/hera-monitor/main/install.sh | sudo bash
#
#   # 已克隆仓库，本地部署
#   sudo bash install.sh
#
#   # 自定义端口与安装目录
#   sudo bash install.sh --port 9000 --dir /opt/hera
#
set -u

REPO="${HERA_REPO:-tmclsamxy/hera-monitor}"
BRANCH="${HERA_BRANCH:-main}"
INSTALL_DIR="/opt/hera-monitor"
PORT="8080"
HOST="0.0.0.0"
SERVICE_NAME="hera-monitor"
NODE_MIN_MAJOR=18
NO_SERVICE=0
UNINSTALL=0
FORCE=0

ORIG_ARGS=("$@")

RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; CYAN='\033[36m'; PLAIN='\033[0m'
[ -t 1 ] || { RED=''; GREEN=''; YELLOW=''; CYAN=''; PLAIN=''; }

info() { printf '%s[hera]%s %s\n' "$CYAN" "$PLAIN" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$GREEN" "$PLAIN" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$YELLOW" "$PLAIN" "$*" >&2; }
die()  { printf '%s[fail]%s %s\n' "$RED" "$PLAIN" "$*" >&2; exit 1; }
step() { printf '\n%s==>%s %s\n' "$CYAN" "$PLAIN" "$*"; }

usage() {
  cat <<'EOF'
Hera Monitor 服务端一键部署

用法:
  install.sh [选项]

选项:
  --port PORT       面板监听端口，默认 8080
  --host HOST       监听地址，默认 0.0.0.0
  --dir DIR         安装目录，默认 /opt/hera-monitor
  --repo OWNER/REPO GitHub 仓库，默认 tmclsamxy/hera-monitor
  --branch BRANCH   分支名，默认 main
  --no-service      只部署不注册系统服务
  --force           覆盖已存在的安装目录
  --uninstall       卸载（保留数据目录）
  -h, --help        显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)       PORT="${2:-}"; shift 2 ;;
    --host)       HOST="${2:-}"; shift 2 ;;
    --dir)        INSTALL_DIR="${2:-}"; shift 2 ;;
    --repo)       REPO="${2:-}"; shift 2 ;;
    --branch)     BRANCH="${2:-}"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --force)      FORCE=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) die "未知参数: $1（用 --help 查看用法）" ;;
  esac
done

case "$PORT" in ''|*[!0-9]*) die "端口必须是数字" ;; esac

# ------------------------------------------------------------------ 权限
if [ "$(id -u)" != "0" ]; then
  SELF="$0"
  if [ ! -f "$SELF" ]; then
    die "需要 root 权限。请改用：curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh | sudo bash"
  fi
  command -v sudo >/dev/null 2>&1 || die "当前不是 root 且未安装 sudo，请以 root 身份运行"
  info "需要 root 权限，正在通过 sudo 重新执行…"
  exec sudo -E bash "$SELF" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi

# ------------------------------------------------------------------ 卸载
if [ "$UNINSTALL" = "1" ]; then
  info "开始卸载 Hera Monitor…"
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -rf "$INSTALL_DIR/server" "$INSTALL_DIR/agent" "$INSTALL_DIR/install.sh" \
         "$INSTALL_DIR/README.md" "$INSTALL_DIR/LICENSE" "$INSTALL_DIR/deploy" \
         "$INSTALL_DIR/Dockerfile" "$INSTALL_DIR/docker-compose.yml"
  ok "已卸载程序文件。数据保留在 ${INSTALL_DIR}/data，如需彻底删除请手动执行 rm -rf"
  exit 0
fi

# ------------------------------------------------------------- 依赖检查
command -v curl >/dev/null 2>&1 || {
  info "未找到 curl，尝试自动安装…"
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq curl
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl
  elif command -v yum >/dev/null 2>&1; then yum install -y -q curl
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl
  else die "请先手动安装 curl"; fi
}
command -v tar >/dev/null 2>&1 || die "未找到 tar，请先安装"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major
  v="$(node -v 2>/dev/null)" || return 1
  major="${v#v}"; major="${major%%.*}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

install_node() {
  step "本机缺少 Node.js ${NODE_MIN_MAJOR}+，开始自动安装"

  local arch os tarball base
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l) arch="armv7l" ;;
    *) die "不支持的 CPU 架构：$arch，请手动安装 Node.js ${NODE_MIN_MAJOR}+" ;;
  esac

  # 优先走系统包管理器（更快，且与系统集成）
  if command -v apt-get >/dev/null 2>&1; then
    info "使用 NodeSource 源安装 Node.js 22"
    if curl -fsSL "https://deb.nodesource.com/setup_22.x" | bash - >/dev/null 2>&1 \
       && apt-get install -y -qq nodejs >/dev/null 2>&1 && node_ok; then
      ok "Node.js 安装完成：$(node -v)"
      return 0
    fi
    warn "NodeSource 安装失败，改用官方二进制包"
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    local pm; command -v dnf >/dev/null 2>&1 && pm=dnf || pm=yum
    info "使用 NodeSource 源安装 Node.js 22"
    if curl -fsSL "https://rpm.nodesource.com/setup_22.x" | bash - >/dev/null 2>&1 \
       && $pm install -y -q nodejs >/dev/null 2>&1 && node_ok; then
      ok "Node.js 安装完成：$(node -v)"
      return 0
    fi
    warn "NodeSource 安装失败，改用官方二进制包"
  fi

  # 兜底：官方静态二进制包
  base="https://nodejs.org/dist/latest-v22.x"
  tarball="$(curl -fsSL "${base}/" 2>/dev/null | grep -o "node-v[0-9.]*-linux-${arch}\.tar\.gz" | head -n1)"
  [ -n "$tarball" ] || die "无法获取 Node.js 二进制包，请检查网络后手动安装"
  info "下载 ${tarball}"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "${tmp}/node.tar.gz" "${base}/${tarball}" || die "下载 Node.js 失败"
  tar -xzf "${tmp}/node.tar.gz" -C "$tmp" || die "解压 Node.js 失败"
  local src; src="$(find "$tmp" -maxdepth 1 -type d -name 'node-v*' | head -n1)"
  [ -n "$src" ] || die "Node.js 包结构异常"
  for d in bin include lib share; do
    [ -d "${src}/${d}" ] && cp -a "${src}/${d}/." /usr/local/"${d}"/ 2>/dev/null || true
  done
  rm -rf "$tmp"
  hash -r 2>/dev/null || true
  node_ok || die "Node.js 安装后仍不可用，请手动安装 Node.js ${NODE_MIN_MAJOR}+"
  ok "Node.js 安装完成：$(node -v)"
}

node_ok || install_node
NODE_BIN="$(command -v node)"
ok "使用 Node.js $("$NODE_BIN" -v)（${NODE_BIN}）"

# --------------------------------------------------------- 获取程序文件
step "准备程序文件到 ${INSTALL_DIR}"

if [ -d "$INSTALL_DIR/server" ] && [ "$FORCE" != "1" ]; then
  warn "${INSTALL_DIR}/server 已存在，将就地升级（保留 data 目录）"
fi
mkdir -p "$INSTALL_DIR"

SRC_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo '')"
if [ -n "$SRC_DIR" ] && [ -f "${SRC_DIR}/server/src/index.js" ]; then
  info "来源：本地目录 ${SRC_DIR}"
  rm -rf "${INSTALL_DIR}/server" "${INSTALL_DIR}/agent" "${INSTALL_DIR}/deploy"
  cp -a "${SRC_DIR}/server" "$INSTALL_DIR/"
  [ -d "${SRC_DIR}/agent" ] && cp -a "${SRC_DIR}/agent" "$INSTALL_DIR/"
  [ -d "${SRC_DIR}/deploy" ] && cp -a "${SRC_DIR}/deploy" "$INSTALL_DIR/"
  for f in install.sh README.md LICENSE Dockerfile docker-compose.yml; do
    [ -f "${SRC_DIR}/${f}" ] && cp -a "${SRC_DIR}/${f}" "$INSTALL_DIR/"
  done
else
  info "来源：GitHub ${REPO}@${BRANCH}"
  tmp="$(mktemp -d)"
  url="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"
  curl -fsSL --retry 3 -o "${tmp}/hera.tar.gz" "$url" || die "下载仓库失败：${url}"
  tar -xzf "${tmp}/hera.tar.gz" -C "$tmp" || die "解压失败"
  pkg="$(find "$tmp" -maxdepth 1 -type d -name 'hera-monitor-*' | head -n1)"
  [ -n "$pkg" ] || die "包结构异常"
  rm -rf "${INSTALL_DIR}/server" "${INSTALL_DIR}/agent" "${INSTALL_DIR}/deploy"
  cp -a "${pkg}/server" "$INSTALL_DIR/"
  [ -d "${pkg}/agent" ] && cp -a "${pkg}/agent" "$INSTALL_DIR/"
  [ -d "${pkg}/deploy" ] && cp -a "${pkg}/deploy" "$INSTALL_DIR/"
  for f in install.sh README.md LICENSE Dockerfile docker-compose.yml; do
    [ -f "${pkg}/${f}" ] && cp -a "${pkg}/${f}" "$INSTALL_DIR/"
  done
  rm -rf "$tmp"
fi

chmod +x "${INSTALL_DIR}/install.sh" 2>/dev/null || true
chmod +x "${INSTALL_DIR}/agent/"*.sh 2>/dev/null || true
mkdir -p "${INSTALL_DIR}/data"
ok "程序文件就绪"

# ------------------------------------------------------ 记录仓库地址
# 面板生成的一键安装命令需要用到这里配置的 GitHub 仓库
info "仓库地址将写入面板配置：${REPO}（用于生成 Agent 安装命令）"

[ "$NO_SERVICE" = "1" ] && {
  ok "已跳过服务注册（--no-service）"
  printf '\n启动方式：\n  HERA_PORT=%s HERA_DATA_DIR=%s/data HERA_REPO=%s %s %s/server/src/index.js\n\n' \
    "$PORT" "$INSTALL_DIR" "$REPO" "$NODE_BIN" "$INSTALL_DIR"
  exit 0
}

# ---------------------------------------------------------------- 服务化
step "注册系统服务"

start_systemd() {
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Hera Monitor - 轻量服务器监控面板
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
Environment=HERA_PORT=${PORT}
Environment=HERA_HOST=${HOST}
Environment=HERA_DATA_DIR=${INSTALL_DIR}/data
Environment=HERA_REPO=${REPO}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server/src/index.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/hera-monitor.log
StandardError=append:/var/log/hera-monitor.log
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=${INSTALL_DIR}/data /var/log

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "systemd 服务已启动并设为开机自启"
    return 0
  fi
  warn "服务启动失败，查看日志：journalctl -u ${SERVICE_NAME} -n 80"
  return 1
}

start_nohup() {
  mkdir -p /var/log
  pkill -f "${INSTALL_DIR}/server/src/index.js" >/dev/null 2>&1 || true
  HERA_PORT="$PORT" HERA_HOST="$HOST" HERA_DATA_DIR="${INSTALL_DIR}/data" HERA_REPO="${REPO}" \
    nohup "$NODE_BIN" "${INSTALL_DIR}/server/src/index.js" >>/var/log/hera-monitor.log 2>&1 &
  sleep 2
  if pgrep -f "${INSTALL_DIR}/server/src/index.js" >/dev/null 2>&1; then
    ok "已通过 nohup 启动（无 systemd 环境）"
    warn "当前环境无 systemd，进程不会开机自启，请自行配置开机启动"
    return 0
  fi
  warn "启动失败，日志见 /var/log/hera-monitor.log"
  return 1
}

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  start_systemd || true
else
  info "未检测到 systemd，使用 nohup 方式启动"
  start_nohup || true
fi

# ---------------------------------------------------------------- 收尾
sleep 1
PUBLIC_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || echo '')"

printf '\n%s%s%s\n' "$GREEN" "$(printf '═%.0s' {1..58})" "$PLAIN"
printf '  %sHera Monitor 部署完成%s\n' "$GREEN" "$PLAIN"
printf '%s%s%s\n' "$GREEN" "$(printf '═%.0s' {1..58})" "$PLAIN"
printf '  面板地址    %shttp://%s:%s%s\n' "$CYAN" "${PUBLIC_IP:-<服务器IP>}" "$PORT" "$PLAIN"
printf '  安装目录    %s\n' "$INSTALL_DIR"
printf '  数据目录    %s/data\n' "$INSTALL_DIR"
printf '  日志        tail -f /var/log/hera-monitor.log\n'
printf '  服务管理    systemctl {status|restart|stop} %s\n' "$SERVICE_NAME"

if [ -f "${INSTALL_DIR}/data/initial-password.txt" ]; then
  printf '\n  %s管理员初始密码：%s%s\n' "$YELLOW" "$(cat "${INSTALL_DIR}/data/initial-password.txt")" "$PLAIN"
  printf '  （登录后请立即在「设置 → 安全」中修改）\n'
fi

printf '\n  %s别忘了在安全组/防火墙放行 %s 端口%s\n' "$YELLOW" "$PORT" "$PLAIN"
printf '\n  在其它服务器上接入 Agent：\n'
printf '    curl -fsSL http://%s:%s/install-agent.sh | sudo bash -s -- --server http://%s:%s --key <密钥>\n' \
  "${PUBLIC_IP:-<服务器IP>}" "$PORT" "${PUBLIC_IP:-<服务器IP>}" "$PORT"
printf '\n  密钥可在面板「设置」页或「+ 接入新服务器」中复制\n\n'
