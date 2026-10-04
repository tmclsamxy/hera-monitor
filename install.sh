#!/usr/bin/env bash
#
# Hera Monitor 服务端一键部署脚本
#
# 用法：
#   # 从仓库直接部署（自动选择 Docker，没有 Docker 则走裸机 + systemd）
#   curl -fsSL https://raw.githubusercontent.com/tmclsamxy/hera-monitor/main/install.sh | sudo bash
#
#   # 自定义端口（两种模式都生效）
#   curl -fsSL .../install.sh | sudo bash -s -- --port 9000
#   sudo bash install.sh --port 9000
#
#   # 强制指定部署方式
#   sudo bash install.sh --port 9000 --mode docker
#   sudo bash install.sh --port 9000 --mode native
#
#   # 直接用预构建镜像（不本地构建）
#   sudo bash install.sh --port 9000 --mode docker --image ghcr.io/tmclsamxy/hera-monitor:latest
#
set -u

REPO="${HERA_REPO:-tmclsamxy/hera-monitor}"
BRANCH="${HERA_BRANCH:-main}"
INSTALL_DIR="/opt/hera-monitor"
PORT="8080"
HOST="0.0.0.0"
MODE="auto"
IMAGE=""
PUBLIC_URL=""
SERVICE_NAME="hera-monitor"
NODE_MIN_MAJOR=18
NO_SERVICE=0
UNINSTALL=0
FORCE=0
DRY_RUN=0
ASSUME_YES=0        # -y / --yes：强制非交互
ACTION="auto"       # auto | install | upgrade | reconfigure | uninstall | abort
INTERACTIVE=0       # 有可用终端且未指定 --yes 时为 1
PORT_FROM_CLI=0
HOST_FROM_CLI=0
URL_FROM_CLI=0
INSTALLED=0
INSTALL_KIND=""     # docker | native | unknown
INSTALLED_RUNNING=0
CURRENT_PORT=""
CURRENT_BIND=""
CURRENT_URL=""
COMPOSE=""
COMPOSE_SERVICE="hera-monitor"
DEPLOY_KIND=""   # compose | run

ORIG_ARGS=("$@")

RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; CYAN='\033[36m'; BOLD='\033[1m'; PLAIN='\033[0m'
[ -t 1 ] || { RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; PLAIN=''; }

info() { printf '%s[hera]%s %s\n' "$CYAN" "$PLAIN" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$GREEN" "$PLAIN" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$YELLOW" "$PLAIN" "$*" >&2; }
die()  { printf '%s[fail]%s %s\n' "$RED" "$PLAIN" "$*" >&2; exit 1; }
step() { printf '\n%s==>%s %s\n' "$CYAN" "$PLAIN" "$*"; }

usage() {
  cat <<'EOF'
Hera Monitor 服务端一键部署 / 升级 / 卸载

直接执行（不带参数）时是交互式的：
  · 本机未安装 → 引导你选择端口等参数后安装
  · 本机已安装 → 列出当前配置，让你选升级 / 改端口 / 卸载 / 退出

  交互输入走 /dev/tty，所以 curl | bash 这种方式一样可以交互。

用法:
  install.sh [选项]

部署方式:
  --mode MODE       auto（默认）/ docker / native
                    auto = 检测到可用 Docker 就用 Docker，否则走裸机 + systemd
  --image IMAGE     仅 Docker 模式：直接用预构建镜像，不本地构建
                    例如 ghcr.io/tmclsamxy/hera-monitor:latest

网络与端口:
  --port PORT       面板对外端口，默认 8080（两种模式均生效）
  --host HOST       监听地址，默认 0.0.0.0
                    native 模式 = 服务监听地址；docker 模式 = 宿主机绑定地址
                    填 127.0.0.1 则只允许本机访问（适合 Nginx 反代）
  --public-url URL  面板公网地址，填了之后生成的一键接入命令会用它
                    例如 https://monitor.example.com

生命周期:
  --install         强制走全新安装流程
  --upgrade         直接升级到最新版本（保留数据与现有端口 / 域名配置）
  --reconfigure     重新配置（改端口等，保留数据）
  --uninstall       卸载（数据默认保留）
  -y, --yes         非交互，全部使用默认值（适合脚本 / CI）

其它:
  --dir DIR         安装目录，默认 /opt/hera-monitor
  --repo OWNER/REPO GitHub 仓库，默认 tmclsamxy/hera-monitor
  --branch BRANCH   分支名，默认 main
  --no-service      native 模式：只部署不注册系统服务
  --force           覆盖已存在的程序文件（保留 data 数据目录）
  --dry-run         演练：只打印将要执行的操作，不做任何改动
  -h, --help        显示帮助

示例:
  sudo bash install.sh                          # 交互式（推荐）
  sudo bash install.sh --port 9000              # 直接指定端口
  sudo bash install.sh --upgrade                # 升级到最新版本
  sudo bash install.sh --dry-run --port 9000    # 先看会做什么
  curl -fsSL <仓库>/install.sh | sudo bash      # 一键（会引导选端口）
EOF
}

# ---------------------------------------------------------------- 参数解析
while [ $# -gt 0 ]; do
  case "$1" in
    --port)       PORT="${2:-}"; PORT_FROM_CLI=1; shift 2 ;;
    --host)       HOST="${2:-}"; HOST_FROM_CLI=1; shift 2 ;;
    --mode)       MODE="${2:-}"; shift 2 ;;
    --image)      IMAGE="${2:-}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:-}"; URL_FROM_CLI=1; shift 2 ;;
    --dir)        INSTALL_DIR="${2:-}"; shift 2 ;;
    --repo)       REPO="${2:-}"; shift 2 ;;
    --branch)     BRANCH="${2:-}"; shift 2 ;;
    --install)    ACTION="install"; shift ;;
    --upgrade)    ACTION="upgrade"; shift ;;
    --reconfigure) ACTION="reconfigure"; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    --force)      FORCE=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) die "未知参数: $1（用 --help 查看用法）" ;;
  esac
done

# ---- 参数校验
case "$PORT" in
  ''|*[!0-9]*) die "--port 必须是数字，收到：${PORT}" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port 必须在 1-65535 之间，收到：${PORT}"

case "$MODE" in
  auto|docker|native) ;;
  *) die "--mode 只能是 auto / docker / native，收到：${MODE}" ;;
esac

case "$INSTALL_DIR" in
  /*) ;;
  *) die "--dir 必须是绝对路径，收到：${INSTALL_DIR}" ;;
esac

[ -n "$PUBLIC_URL" ] && PUBLIC_URL="${PUBLIC_URL%/}"

# ------------------------------------------------------------------ 权限
# Docker 模式下若当前用户已在 docker 组，其实不需要 root；
# 但安装目录默认在 /opt，仍然需要写权限，所以统一按需提权。
need_root=1
if [ "$MODE" = "docker" ] && [ "$(id -u)" != "0" ] \
   && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
   && [ -w "$(dirname "$INSTALL_DIR")" ] 2>/dev/null; then
  need_root=0
fi

if [ "$need_root" = "1" ] && [ "$(id -u)" != "0" ] && [ "$DRY_RUN" != "1" ]; then
  SELF="$0"
  if [ ! -f "$SELF" ]; then
    die "需要 root 权限。请改用：curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh | sudo bash -s -- ${ORIG_ARGS[*]:-}"
  fi
  command -v sudo >/dev/null 2>&1 || die "当前不是 root 且未安装 sudo，请以 root 身份运行"
  info "需要 root 权限，正在通过 sudo 重新执行…"
  exec sudo -E bash "$SELF" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi

# ----------------------------------------------------------- 环境探测工具
detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
    return 0
  fi
  return 1
}

docker_usable() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  detect_compose || return 1
  return 0
}

# 优先用宿主机 curl 探活；没有 curl 就在容器内自测
docker_health_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 --noproxy '*' "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && return 0
    return 1
  fi
  docker exec "$COMPOSE_SERVICE" node -e \
    "fetch('http://127.0.0.1:'+(process.env.HERA_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

# --------------------------------------------------------- 交互与状态探测
#
# 注意：curl | sudo bash 执行时脚本占用了 stdin，直接 read 会立刻拿到 EOF，
# 所以输入统一从终端设备读。fd 3 用只读方式打开（不用读写混用的 <>），
# 否则写提示会污染文件偏移、把还没读到的答案覆盖掉。
# 提示一律走 stderr：既不会混进命令替换的输出，管道场景下也依然显示在终端。
# 终端路径可用 HERA_TTY 覆盖，便于测试或指定其它终端。

TTY_PATH="${HERA_TTY:-/dev/tty}"

# 在子 shell 里试探能否打开；用子 shell 是因为 exec 重定向失败
# 会让非交互 shell 直接退出，不能拿它做探测。
tty_openable() { ( exec 3<"$TTY_PATH" ) 2>/dev/null; }

# ask <提示> [默认值] -> 把答案写到 stdout
ask() {
  local prompt="$1" def="${2:-}" ans=""
  if [ "$INTERACTIVE" != "1" ]; then
    printf '%s' "$def"
    return 0
  fi
  if [ -n "$def" ]; then
    printf '%s [%s]: ' "$prompt" "$def" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r ans <&3 || ans=""
  ans="${ans#"${ans%%[![:space:]]*}"}"
  ans="${ans%"${ans##*[![:space:]]}"}"
  printf '%s' "${ans:-$def}"
}

# ask_yn <提示> <y|n 为默认> -> 返回 0=是 1=否
ask_yn() {
  local prompt="$1" def="${2:-n}" hint ans
  [ "$def" = "y" ] && hint="Y/n" || hint="y/N"
  if [ "$INTERACTIVE" != "1" ]; then
    [ "$def" = "y" ]
    return $?
  fi
  printf '%s [%s]: ' "$prompt" "$hint" >&2
  read -r ans <&3 || ans=""
  ans="$(printf '%s' "$ans" | tr 'A-Z' 'a-z')"
  [ -z "$ans" ] && ans="$def"
  case "$ans" in y|yes) return 0 ;; *) return 1 ;; esac
}

# 循环追问直到拿到合法端口；非交互时直接返回默认值
ask_port() {
  local prompt="$1" def="$2" p
  while :; do
    p="$(ask "$prompt" "$def")"
    if [ -z "$p" ]; then printf '%s' "$def"; return 0; fi
    case "$p" in
      *[!0-9]*)
        printf '  端口必须是数字，请重新输入\n' >&2 ;;
      *)
        if [ "$p" -ge 1 ] && [ "$p" -le 65535 ]; then
          printf '%s' "$p"; return 0
        fi
        printf '  端口必须在 1-65535 之间\n' >&2 ;;
    esac
  done
}

# 探测本机是否已安装，并顺带把现有配置读出来（升级时不冲掉用户改过的值）
detect_install() {
  INSTALLED=0; INSTALL_KIND=""; INSTALLED_RUNNING=0
  CURRENT_PORT=""; CURRENT_BIND=""; CURRENT_URL=""

  # 1) Docker 容器
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
     && docker inspect "$COMPOSE_SERVICE" >/dev/null 2>&1; then
    INSTALLED=1
    INSTALL_KIND="docker"
    [ "$(docker inspect -f '{{.State.Running}}' "$COMPOSE_SERVICE" 2>/dev/null)" = "true" ] \
      && INSTALLED_RUNNING=1
    CURRENT_PORT="$(docker inspect -f \
      '{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostPort}} {{end}}{{end}}' \
      "$COMPOSE_SERVICE" 2>/dev/null | awk '{print $1; exit}')"
  fi

  # 2) 部署目录里的 .env（Docker 模式的配置来源）
  if [ -f "${INSTALL_DIR}/.env" ]; then
    [ -z "$CURRENT_PORT" ] && CURRENT_PORT="$(sed -n 's/^HERA_PORT=\([0-9]\{1,5\}\).*/\1/p' "${INSTALL_DIR}/.env" | head -n1)"
    CURRENT_BIND="$(sed -n 's/^HERA_BIND=\(.*\)$/\1/p' "${INSTALL_DIR}/.env" | head -n1)"
    CURRENT_URL="$(sed -n 's/^HERA_PUBLIC_URL=\(.*\)$/\1/p' "${INSTALL_DIR}/.env" | head -n1)"
  fi

  # 3) 裸机的 systemd 单元
  local unit="/etc/systemd/system/${SERVICE_NAME}.service"
  if [ -f "$unit" ]; then
    INSTALLED=1
    [ -z "$INSTALL_KIND" ] && INSTALL_KIND="native"
    [ -z "$CURRENT_PORT" ] && CURRENT_PORT="$(sed -n 's/^Environment=HERA_PORT=\([0-9]\{1,5\}\).*/\1/p' "$unit" | head -n1)"
    [ -z "$CURRENT_BIND" ] && CURRENT_BIND="$(sed -n 's/^Environment=HERA_HOST=\(.*\)$/\1/p' "$unit" | head -n1)"
    [ -z "$CURRENT_URL" ] && CURRENT_URL="$(sed -n 's/^Environment=HERA_PUBLIC_URL=\(.*\)$/\1/p' "$unit" | head -n1)"
    systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null && INSTALLED_RUNNING=1
  elif [ "$INSTALLED" = "0" ] && [ -f "${INSTALL_DIR}/server/src/index.js" ]; then
    # 目录里有程序文件，但没有容器也没有 systemd 单元（比如被手动停掉了）
    INSTALLED=1
  fi

  # 部署形态兜底：有 .env / docker-compose.yml 按 Docker 算，否则按裸机算
  if [ "$INSTALLED" = "1" ] && [ -z "$INSTALL_KIND" ]; then
    if [ -f "${INSTALL_DIR}/docker-compose.yml" ] || [ -f "${INSTALL_DIR}/.env" ]; then
      INSTALL_KIND="docker"
    elif [ -f "${INSTALL_DIR}/server/src/index.js" ]; then
      INSTALL_KIND="native"
    else
      INSTALL_KIND="unknown"
    fi
  fi

  [ "$INSTALLED" = "1" ] && [ -z "$CURRENT_PORT" ] && CURRENT_PORT="8080"

  # 升级 / 重新配置时沿用现有配置，避免把用户改过的端口和域名冲掉
  if [ "$INSTALLED" = "1" ]; then
    [ "$PORT_FROM_CLI" = "0" ] && [ -n "$CURRENT_PORT" ] && PORT="$CURRENT_PORT"
    [ "$HOST_FROM_CLI" = "0" ] && [ -n "$CURRENT_BIND" ] && HOST="$CURRENT_BIND"
    [ "$URL_FROM_CLI" = "0" ] && [ -n "$CURRENT_URL" ] && PUBLIC_URL="$CURRENT_URL"
  fi
}

print_installed_info() {
  local line
  line="$(printf '─%.0s' {1..62})"
  printf '\n%s%s%s\n' "$CYAN" "$line" "$PLAIN"
  printf '  %s检测到本机已安装 Hera Monitor%s\n' "$BOLD" "$PLAIN"
  printf '%s%s%s\n' "$CYAN" "$line" "$PLAIN"
  printf '  安装目录    %s%s\n' "$INSTALL_DIR" "$([ -d "$INSTALL_DIR" ] || echo '（不存在）')"
  printf '  部署方式    %s\n' "$([ "$INSTALL_KIND" = "docker" ] && echo 'Docker' || echo '裸机 systemd')"
  printf '  当前端口    %s\n' "${CURRENT_PORT:-未知}"
  printf '  监听地址    %s\n' "${CURRENT_BIND:-0.0.0.0}"
  [ -n "$CURRENT_URL" ] && printf '  公网地址    %s\n' "$CURRENT_URL"
  printf '  运行状态    %s%s%s\n' \
    "$([ "$INSTALLED_RUNNING" = "1" ] && printf '%s' "$GREEN" || printf '%s' "$YELLOW")" \
    "$([ "$INSTALLED_RUNNING" = "1" ] && echo '运行中' || echo '已停止')" "$PLAIN"
  printf '%s%s%s\n' "$CYAN" "$line" "$PLAIN"
}

choose_action() {
  local c
  printf '\n  请选择要执行的操作：\n' >&2
  printf '    1) 升级到最新版本         保留数据，沿用当前端口与域名配置\n' >&2
  printf '    2) 修改端口 / 重新配置    保留数据，重新填写参数\n' >&2
  printf '    3) 卸载                   程序文件删除，数据默认保留\n' >&2
  printf '    4) 退出                   不做任何改动\n' >&2
  while :; do
    printf '\n  请输入序号 [1]: ' >&2
    read -r c <&3 || c=""
    [ -z "$c" ] && c=1
    case "$c" in
      1) ACTION="upgrade"; return 0 ;;
      2) ACTION="reconfigure"; return 0 ;;
      3) ACTION="uninstall"; return 0 ;;
      4|q|Q) ACTION="abort"; return 0 ;;
      *) printf '  %s请输入 1-4%s\n' "$RED" "$PLAIN" >&2 ;;
    esac
  done
}

# 全新安装前询问参数（只有交互模式会真的问）
ask_fresh_params() {
  printf '\n  开始安装前确认几个参数，直接回车即使用默认值：\n' >&2

  PORT="$(ask_port '  面板端口' "$PORT")"

  if [ "$HOST_FROM_CLI" = "0" ]; then
    if ask_yn '  是否只允许本机访问（前面挂 Nginx 反代时选 y）' n; then
      HOST="127.0.0.1"
    else
      HOST="0.0.0.0"
    fi
  fi

  if [ "$URL_FROM_CLI" = "0" ]; then
    local u
    u="$(ask '  面板公网地址（走域名时填，否则留空）' '')"
    [ -n "$u" ] && PUBLIC_URL="${u%/}"
  fi

  printf '\n  将使用：端口 %s%s%s\n' "$PORT" \
    "$([ "$HOST" = "127.0.0.1" ] && echo '，仅本机可访问' || echo '，所有网卡可访问')" \
    "${PUBLIC_URL:+，公网地址 $PUBLIC_URL}" >&2

  if ! ask_yn '  确认开始部署' y; then
    info "已取消，未做任何改动"
    exit 0
  fi
}

# ------------------------------------------------------------------ 卸载
do_uninstall() {
  info "开始卸载 Hera Monitor…"

  # Docker 模式：先停容器（compose 与 docker run 两种方式都覆盖）
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if [ -f "${INSTALL_DIR}/docker-compose.yml" ] && detect_compose; then
      ( cd "$INSTALL_DIR" && $COMPOSE down >/dev/null 2>&1 ) && ok "已通过 Compose 停止并移除容器"
    fi
    if docker inspect "$COMPOSE_SERVICE" >/dev/null 2>&1; then
      docker rm -f "$COMPOSE_SERVICE" >/dev/null 2>&1 && ok "已移除容器 ${COMPOSE_SERVICE}"
    fi
  fi

  # 裸机模式：停 service
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  pkill -f "${INSTALL_DIR}/server/src/index.js" >/dev/null 2>&1 || true

  rm -rf "$INSTALL_DIR/server" "$INSTALL_DIR/agent" "$INSTALL_DIR/deploy" \
         "$INSTALL_DIR/install.sh" "$INSTALL_DIR/README.md" "$INSTALL_DIR/LICENSE" \
         "$INSTALL_DIR/Dockerfile" "$INSTALL_DIR/docker-compose.yml" "$INSTALL_DIR/.env"
  ok "程序文件已删除。数据默认保留"
  printf '  彻底清理数据：\n'
  printf '    裸机模式   rm -rf %s/data\n' "$INSTALL_DIR"
  printf '    Compose    docker volume rm %s_hera-data\n' "$(basename "$INSTALL_DIR")"
  printf '    docker run docker volume rm hera-data\n'
}

if [ "$UNINSTALL" = "1" ]; then
  # 带 --dry-run 时只登记动作，交给下面的演练分支去打印计划
  if [ "$DRY_RUN" = "1" ]; then
    ACTION="uninstall"
  else
    do_uninstall
    exit 0
  fi
fi

# ------------------------------------------------------------ 获取程序文件
fetch_files() {
  step "准备程序文件到 ${INSTALL_DIR}"

  if [ -d "$INSTALL_DIR/server" ] && [ "$FORCE" != "1" ]; then
    warn "${INSTALL_DIR}/server 已存在，将就地升级（保留 data 目录）"
  fi
  mkdir -p "$INSTALL_DIR"

  local src_dir
  src_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo '')"

  if [ -n "$src_dir" ] && [ -f "${src_dir}/server/src/index.js" ]; then
    info "来源：本地目录 ${src_dir}"
    rm -rf "${INSTALL_DIR}/server" "${INSTALL_DIR}/agent" "${INSTALL_DIR}/deploy"
    cp -a "${src_dir}/server" "$INSTALL_DIR/"
    [ -d "${src_dir}/agent" ] && cp -a "${src_dir}/agent" "$INSTALL_DIR/"
    [ -d "${src_dir}/deploy" ] && cp -a "${src_dir}/deploy" "$INSTALL_DIR/"
    for f in install.sh README.md LICENSE Dockerfile docker-compose.yml .env.example; do
      [ -f "${src_dir}/${f}" ] && cp -a "${src_dir}/${f}" "$INSTALL_DIR/"
    done
  else
    command -v curl >/dev/null 2>&1 || die "未找到 curl，请先安装"
    info "来源：GitHub ${REPO}@${BRANCH}"
    local tmp
    tmp="$(mktemp -d)"
    local url="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"
    curl -fsSL --retry 3 -o "${tmp}/hera.tar.gz" "$url" || die "下载仓库失败：${url}"
    tar -xzf "${tmp}/hera.tar.gz" -C "$tmp" || die "解压失败"
    local pkg
    pkg="$(find "$tmp" -maxdepth 1 -type d -name 'hera-monitor-*' | head -n1)"
    [ -n "$pkg" ] || die "包结构异常"
    rm -rf "${INSTALL_DIR}/server" "${INSTALL_DIR}/agent" "${INSTALL_DIR}/deploy"
    cp -a "${pkg}/server" "$INSTALL_DIR/"
    [ -d "${pkg}/agent" ] && cp -a "${pkg}/agent" "$INSTALL_DIR/"
    [ -d "${pkg}/deploy" ] && cp -a "${pkg}/deploy" "$INSTALL_DIR/"
    for f in install.sh README.md LICENSE Dockerfile docker-compose.yml .env.example; do
      [ -f "${pkg}/${f}" ] && cp -a "${pkg}/${f}" "$INSTALL_DIR/"
    done
    rm -rf "$tmp"
  fi

  chmod +x "${INSTALL_DIR}/install.sh" 2>/dev/null || true
  chmod +x "${INSTALL_DIR}/agent/"*.sh 2>/dev/null || true
  chmod +x "${INSTALL_DIR}/deploy/"*.sh 2>/dev/null || true
  mkdir -p "${INSTALL_DIR}/data"
  ok "程序文件就绪"
}

# ============================================================ Docker 模式
deploy_docker() {
  step "检查 Docker 环境"
  command -v docker >/dev/null 2>&1 || die "未检测到 docker。请先安装 Docker，或改用 --mode native"

  if ! docker info >/dev/null 2>&1; then
    die "无法连接 Docker 守护进程。请在 root 下运行，或把当前用户加入 docker 组：sudo usermod -aG docker \$USER"
  fi
  ok "Docker 可用（$(docker --version 2>/dev/null | head -1)）"

  detect_compose || die "未检测到 docker compose 插件或 docker-compose 命令。请安装 Compose，或改用 --mode native"
  ok "Compose 可用（${COMPOSE}）"

  fetch_files

  step "写入部署配置"
  umask 077
  cat > "${INSTALL_DIR}/.env" <<EOF
# 由 install.sh 生成，可随时手工修改后执行 ${COMPOSE} up -d 生效
HERA_PORT=${PORT}
HERA_BIND=${HOST}
EOF
  if [ -n "$PUBLIC_URL" ]; then
    printf 'HERA_PUBLIC_URL=%s\n' "$PUBLIC_URL" >> "${INSTALL_DIR}/.env"
  fi
  chmod 600 "${INSTALL_DIR}/.env"
  ok "端口 ${PORT}，绑定 ${HOST}${PUBLIC_URL:+，公网地址 ${PUBLIC_URL}}"

  step "构建并启动容器"
  if [ -n "$IMAGE" ]; then
    # 用预构建镜像：直接 docker run，避免去改写 compose 文件
    DEPLOY_KIND="run"
    info "使用预构建镜像：${IMAGE}"
    docker rm -f "$COMPOSE_SERVICE" >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    docker run -d --name "$COMPOSE_SERVICE" --init --restart unless-stopped \
      -p "${HOST}:${PORT}:8080" \
      -v hera-data:/data \
      -e HERA_HOST=0.0.0.0 \
      -e HERA_PORT=8080 \
      -e HERA_DATA_DIR=/data \
      -e HERA_REPO="$REPO" \
      -e TZ=Asia/Shanghai \
      ${PUBLIC_URL:+-e HERA_PUBLIC_URL="$PUBLIC_URL"} \
      "$IMAGE" >/dev/null || die "容器启动失败，检查镜像是否存在：${IMAGE}"
  else
    DEPLOY_KIND="compose"
    ( cd "$INSTALL_DIR" && $COMPOSE up -d --build ) \
      || die "容器启动失败，查看日志：cd ${INSTALL_DIR} && ${COMPOSE} logs"
  fi
  ok "容器已启动"

  step "等待服务就绪"
  local ready=0 i
  for i in $(seq 1 40); do
    if docker_health_ok; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" = "1" ]; then
    ok "服务已就绪，健康检查通过"
  else
    warn "40 秒内健康检查未通过，最近日志："
    docker logs --tail 30 "$COMPOSE_SERVICE" 2>&1 | sed 's/^/    /' || true
    warn "排障：bash ${INSTALL_DIR}/deploy/troubleshoot.sh --port ${PORT}"
  fi

  INITIAL_PWD=""
  if [ "$ready" = "1" ]; then
    INITIAL_PWD="$( docker exec "$COMPOSE_SERVICE" cat /data/initial-password.txt 2>/dev/null | tr -d '\r\n' )" || true
  fi

  # 端口是否在安全组放行是容器部署最常见的坑，明确提示
  PUBLIC_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || echo '')"
  print_summary "docker" "$PUBLIC_IP" "$INITIAL_PWD"
}

# ============================================================ 裸机模式
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

  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l) arch="armv7l" ;;
    *) die "不支持的 CPU 架构：$arch，请手动安装 Node.js ${NODE_MIN_MAJOR}+" ;;
  esac

  if command -v apt-get >/dev/null 2>&1; then
    info "使用 NodeSource 源安装 Node.js 22"
    if curl -fsSL "https://deb.nodesource.com/setup_22.x" | bash - >/dev/null 2>&1 \
       && apt-get install -y -qq nodejs >/dev/null 2>&1 && node_ok; then
      ok "Node.js 安装完成：$(node -v)"
      return 0
    fi
    warn "NodeSource 安装失败，改用官方二进制包"
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    local pm
    command -v dnf >/dev/null 2>&1 && pm=dnf || pm=yum
    info "使用 NodeSource 源安装 Node.js 22"
    if curl -fsSL "https://rpm.nodesource.com/setup_22.x" | bash - >/dev/null 2>&1 \
       && $pm install -y -q nodejs >/dev/null 2>&1 && node_ok; then
      ok "Node.js 安装完成：$(node -v)"
      return 0
    fi
    warn "NodeSource 安装失败，改用官方二进制包"
  fi

  local base="https://nodejs.org/dist/latest-v22.x"
  local tarball
  tarball="$(curl -fsSL "${base}/" 2>/dev/null | grep -o "node-v[0-9.]*-linux-${arch}\.tar\.gz" | head -n1)"
  [ -n "$tarball" ] || die "无法获取 Node.js 二进制包，请检查网络后手动安装"
  info "下载 ${tarball}"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "${tmp}/node.tar.gz" "${base}/${tarball}" || die "下载 Node.js 失败"
  tar -xzf "${tmp}/node.tar.gz" -C "$tmp" || die "解压 Node.js 失败"
  local src
  src="$(find "$tmp" -maxdepth 1 -type d -name 'node-v*' | head -n1)"
  [ -n "$src" ] || die "Node.js 包结构异常"
  local d
  for d in bin include lib share; do
    [ -d "${src}/${d}" ] && cp -a "${src}/${d}/." /usr/local/"${d}"/ 2>/dev/null || true
  done
  rm -rf "$tmp"
  hash -r 2>/dev/null || true
  node_ok || die "Node.js 安装后仍不可用，请手动安装 Node.js ${NODE_MIN_MAJOR}+"
  ok "Node.js 安装完成：$(node -v)"
}

deploy_native() {
  step "检查运行环境"
  command -v curl >/dev/null 2>&1 || {
    info "未找到 curl，尝试自动安装…"
    if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq curl
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl
    elif command -v yum >/dev/null 2>&1; then yum install -y -q curl
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl
    else die "请先手动安装 curl"; fi
  }
  command -v tar >/dev/null 2>&1 || die "未找到 tar，请先安装"

  node_ok || install_node
  local node_bin
  node_bin="$(command -v node)"
  ok "使用 Node.js $("$node_bin" -v)（${node_bin}）"

  fetch_files

  step "写入部署配置"
  info "端口 ${PORT}，监听地址 ${HOST}${PUBLIC_URL:+，公网地址 ${PUBLIC_URL}}"

  if [ "$NO_SERVICE" = "1" ]; then
    ok "已跳过服务注册（--no-service）"
    printf '\n启动方式：\n  HERA_PORT=%s HERA_HOST=%s HERA_DATA_DIR=%s/data HERA_REPO=%s%s \\\n    %s %s/server/src/index.js\n\n' \
      "$PORT" "$HOST" "$INSTALL_DIR" "$REPO" \
      "${PUBLIC_URL:+ HERA_PUBLIC_URL=$PUBLIC_URL}" "$node_bin" "$INSTALL_DIR"
    exit 0
  fi

  step "注册系统服务"

  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
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
${PUBLIC_URL:+Environment=HERA_PUBLIC_URL=${PUBLIC_URL}}
Environment=NODE_ENV=production
ExecStart=${node_bin} ${INSTALL_DIR}/server/src/index.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/hera-monitor.log
StandardError=append:/var/log/hera-monitor.log
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
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
    else
      warn "服务启动失败，查看日志：journalctl -u ${SERVICE_NAME} -n 80"
    fi
  else
    info "未检测到 systemd，使用 nohup 方式启动"
    mkdir -p /var/log
    pkill -f "${INSTALL_DIR}/server/src/index.js" >/dev/null 2>&1 || true
    HERA_PORT="$PORT" HERA_HOST="$HOST" HERA_DATA_DIR="${INSTALL_DIR}/data" \
      HERA_REPO="$REPO" ${PUBLIC_URL:+HERA_PUBLIC_URL="$PUBLIC_URL"} \
      nohup "$node_bin" "${INSTALL_DIR}/server/src/index.js" >>/var/log/hera-monitor.log 2>&1 &
    sleep 2
    if pgrep -f "${INSTALL_DIR}/server/src/index.js" >/dev/null 2>&1; then
      ok "已通过 nohup 启动"
      warn "当前环境无 systemd，进程不会开机自启，请自行配置"
    else
      warn "启动失败，日志见 /var/log/hera-monitor.log"
    fi
  fi

  INITIAL_PWD=""
  [ -f "${INSTALL_DIR}/data/initial-password.txt" ] && INITIAL_PWD="$(cat "${INSTALL_DIR}/data/initial-password.txt")"

  PUBLIC_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || echo '')"
  print_summary "native" "$PUBLIC_IP" "$INITIAL_PWD"
}

# ---------------------------------------------------------------- 收尾输出
print_summary() {
  local mode="$1" public_ip="$2" initial_pwd="$3"
  local host_ip="${public_ip:-<服务器IP>}"

  printf '\n%s%s%s\n' "$GREEN" "$(printf '═%.0s' {1..62})" "$PLAIN"
  printf '  %sHera Monitor 部署完成%s   （%s 模式）\n' "$GREEN" "$PLAIN" \
    "$([ "$mode" = "docker" ] && echo Docker || echo 裸机)"
  printf '%s%s%s\n' "$GREEN" "$(printf '═%.0s' {1..62})" "$PLAIN"
  printf '  面板地址    %shttp://%s:%s%s\n' "$CYAN" "$host_ip" "$PORT" "$PLAIN"
  printf '  安装目录    %s\n' "$INSTALL_DIR"
  if [ "$mode" = "docker" ]; then
    if [ "$DEPLOY_KIND" = "run" ]; then
      printf '  镜像        %s\n' "$IMAGE"
      printf '  数据卷      hera-data（docker volume inspect hera-data）\n'
    else
      printf '  数据卷      %s_hera-data\n' "$(basename "$INSTALL_DIR")"
    fi
    printf '  改端口      重跑本脚本：bash %s/install.sh --port <新端口>\n' "$INSTALL_DIR"
    printf '  日志        docker logs -f %s\n' "$COMPOSE_SERVICE"
    printf '  排障        bash %s/deploy/troubleshoot.sh --port %s\n' "$INSTALL_DIR" "$PORT"
    printf '  停止        docker rm -f %s\n' "$COMPOSE_SERVICE"
  else
    printf '  数据目录    %s/data\n' "$INSTALL_DIR"
    printf '  改端口      重跑本脚本：bash %s/install.sh --port <新端口>\n' "$INSTALL_DIR"
    printf '  日志        tail -f /var/log/hera-monitor.log\n'
    printf '  服务管理    systemctl {status|restart|stop} %s\n' "$SERVICE_NAME"
  fi

  if [ -n "$initial_pwd" ]; then
    printf '\n  %s管理员初始密码：%s%s\n' "$YELLOW" "$initial_pwd" "$PLAIN"
    printf '  （登录后请立即在「设置 → 安全」中修改）\n'
  fi

  printf '\n  %s⚠️  记得在云服务器安全组放行 %s 端口%s\n' "$YELLOW" "$PORT" "$PLAIN"
  if [ "$mode" = "docker" ]; then
    printf '     注意：Docker 会绕过 ufw 规则，安全组必须单独放行\n'
  fi

  printf '\n  在其它服务器上接入 Agent：\n'
  printf '    curl -fsSL http://%s:%s/install-agent.sh | sudo bash -s -- \\\n' "$host_ip" "$PORT"
  printf '      --server http://%s:%s --key <密钥>\n' "$host_ip" "$PORT"
  printf '\n  密钥可在面板「设置」页或「+ 接入新服务器」中复制\n\n'
}

# ---------------------------------------------------------------- 主流程

# 1) 解析部署方式
if [ "$MODE" = "auto" ]; then
  if docker_usable; then
    MODE="docker"
    info "检测到可用的 Docker，使用 Docker 模式（可用 --mode native 强制裸机部署）"
  else
    MODE="native"
    if command -v docker >/dev/null 2>&1; then
      info "Docker 已安装但当前不可用（守护进程未运行或缺少 Compose），改用裸机模式"
    else
      info "未检测到 Docker，使用裸机模式（Node.js + systemd）"
    fi
  fi
fi

# 2) 判断能否交互。交互读写终端设备，因此 curl | bash 也能正常交互
if [ "$ASSUME_YES" = "1" ]; then
  INTERACTIVE=0
elif tty_openable; then
  # 注意：这里不能写 exec 3<"$TTY" 2>/dev/null ——
  # exec 会把该重定向永久应用到当前 shell，等于把整个脚本的 stderr 丢掉，
  # 所有提示都会静默消失。tty_openable 已经确认过可打开，直接开即可。
  exec 3<"$TTY_PATH"
  INTERACTIVE=1
else
  INTERACTIVE=0
fi

# 3) 探测既有安装，并把现有端口 / 绑定地址 / 公网地址带进默认值
detect_install

# 4) 决定本次要做什么
#
# 这里用递归而不是单层 case：菜单里选完「重新配置」后 ACTION 会变，
# 而单层 case 已经匹配过 auto 分支、不会再回到新分支，导致选择被静默忽略。
resolve_action() {
  case "$ACTION" in
    auto)
      if [ "$INSTALLED" = "1" ]; then
        print_installed_info
        if [ "$INTERACTIVE" = "1" ]; then
          choose_action
          resolve_action        # 按用户选的动作重新解析一次
          return
        fi
        ACTION="upgrade"
        info "非交互模式：检测到已安装，默认执行升级"
      else
        ACTION="install"
        if [ "$INTERACTIVE" = "1" ]; then
          printf '\n  %s本机尚未安装 Hera Monitor，开始引导部署%s\n' "$BOLD" "$PLAIN"
          ask_fresh_params
        else
          info "本机尚未安装，使用默认参数安装（端口 ${PORT}）"
        fi
      fi
      ;;
    upgrade)
      [ "$INSTALLED" = "1" ] || die "本机未检测到 Hera Monitor，无法升级。去掉 --upgrade 即可全新安装"
      print_installed_info
      info "将升级到最新版本，沿用当前端口 ${PORT}"
      ;;
    reconfigure)
      [ "$INSTALLED" = "1" ] || die "本机未检测到 Hera Monitor，无法重新配置。去掉 --reconfigure 即可全新安装"
      print_installed_info
      if [ "$INTERACTIVE" = "1" ]; then
        ask_fresh_params
      else
        info "非交互模式：按命令行参数重新配置，端口 ${PORT}"
      fi
      ACTION="upgrade"   # 重新配置 = 带着新参数重新部署一次，数据不动
      ;;
    install)
      if [ "$INTERACTIVE" = "1" ]; then
        printf '\n  %s全新安装 Hera Monitor%s\n' "$BOLD" "$PLAIN"
        ask_fresh_params
      fi
      ;;
  esac
}

resolve_action

if [ "$ACTION" = "abort" ]; then
  info "已取消，未做任何改动"
  exit 0
fi

# ---------------------------------------------------------------- 演练模式
# 放在卸载之前：--dry-run 绝不允许真的删东西
if [ "$DRY_RUN" = "1" ]; then
  printf '\n%s[演练模式] 以下操作不会真正执行%s\n' "$YELLOW" "$PLAIN"
  printf '%s\n' "$(printf '─%.0s' {1..62})"
  if [ "$ACTION" = "uninstall" ]; then
    printf '  本次动作    uninstall（卸载）\n'
    printf '  将停止移除  %s 容器 / systemd 服务\n' "$COMPOSE_SERVICE"
    printf '  将删除      %s 下的程序文件（server / agent / deploy / Dockerfile / .env）\n' "$INSTALL_DIR"
    printf '  数据保留    %s/data 或 hera-data 卷\n' "$INSTALL_DIR"
    printf '%s\n\n' "$(printf '─%.0s' {1..62})"
    exit 0
  fi
  printf '  本次动作    %s%s\n' "$ACTION" "$([ "$INSTALLED" = "1" ] && echo '（检测到已有安装）' || echo '（全新安装）')"
  printf '  部署方式    %s\n' "$MODE"
  printf '  安装目录    %s\n' "$INSTALL_DIR"
  printf '  面板端口    %s\n' "$PORT"
  printf '  监听地址    %s\n' "$HOST"
  printf '  公网地址    %s\n' "${PUBLIC_URL:-（未设置）}"
  printf '  仓库        %s@%s\n' "$REPO" "$BRANCH"

  if [ "$MODE" = "docker" ]; then
    detect_compose && printf '  Compose     %s\n' "$COMPOSE"
    if [ -n "$IMAGE" ]; then
      printf '  镜像        %s（不本地构建）\n' "$IMAGE"
      printf '  将执行      docker run -d --name %s --init -p %s:%s:8080 -v hera-data:/data %s\n' \
        "$COMPOSE_SERVICE" "$HOST" "$PORT" "$IMAGE"
    else
      printf '  端口映射    %s:%s:8080   （宿主机:端口:容器）\n' "$HOST" "$PORT"
      printf '  将写入      %s/.env\n' "$INSTALL_DIR"
      printf '                HERA_PORT=%s\n' "$PORT"
      printf '                HERA_BIND=%s\n' "$HOST"
      [ -n "$PUBLIC_URL" ] && printf '                HERA_PUBLIC_URL=%s\n' "$PUBLIC_URL"
      printf '  将执行      cd %s && %s up -d --build\n' "$INSTALL_DIR" "${COMPOSE:-docker compose}"
    fi
  else
    printf '  Node.js     %s\n' "$(node -v 2>/dev/null || echo '未安装 → 将自动安装 22.x')"
    printf '  将注册      /etc/systemd/system/%s.service\n' "$SERVICE_NAME"
    printf '                HERA_PORT=%s  HERA_HOST=%s  HERA_DATA_DIR=%s/data\n' "$PORT" "$HOST" "$INSTALL_DIR"
    printf '  将执行      systemctl enable --now %s\n' "$SERVICE_NAME"
  fi

  printf '\n  访问地址    http://<服务器IP>:%s\n' "$PORT"
  printf '%s\n\n' "$(printf '─%.0s' {1..62})"
  exit 0
fi

case "$MODE" in
  docker) deploy_docker ;;
  native) deploy_native ;;
esac
