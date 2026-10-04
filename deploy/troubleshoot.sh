#!/usr/bin/env bash
#
# Hera Monitor 容器部署排障脚本（只读，不改动任何配置）
#
# 在部署面板的那台宿主机上执行：
#   bash deploy/troubleshoot.sh
#   bash deploy/troubleshoot.sh --port 9000 --container hera-monitor
#
set -uo pipefail

CONTAINER="${HERA_CONTAINER:-hera-monitor}"
PORT="${HERA_PORT:-8080}"
PORT_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port)      PORT="${2:-8080}"; PORT_SET=1; shift 2 ;;
    --container) CONTAINER="${2:-hera-monitor}"; shift 2 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

# ⚠️ 必须用 $'...'（ANSI-C 引用）：单引号里的 \033 是字面量，会被原样打印出来
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
CYAN=$'\033[36m'; BOLD=$'\033[1m'; PLAIN=$'\033[0m'

# 颜色开关：非终端默认关闭；NO_COLOR 强制关闭；FORCE_COLOR 强制开启（便于测试）
if [ -n "${NO_COLOR:-}" ] \
   || { [ -z "${FORCE_COLOR:-}" ] && [ ! -t 1 ]; }; then
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; PLAIN=''
fi

HINTS=()
hint() { HINTS+=("$1"); }
sec()  { printf '\n%s── %s %s\n' "$CYAN" "$1" "$PLAIN"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$PLAIN" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$PLAIN" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$PLAIN" "$1"; }
info() { printf '    %s\n' "$1"; }

printf '\n%sHera Monitor 容器部署排障%s\n' "$BOLD" "$PLAIN"
printf '容器名 %s   目标端口 %s\n' "$CONTAINER" "$PORT"

# ---------------------------------------------------------------- 1. Docker
sec "1/7 Docker 环境"

if ! command -v docker >/dev/null 2>&1; then
  bad "未找到 docker 命令"
  hint "先安装 Docker：https://docs.docker.com/engine/install/"
  printf '\n%s诊断结束：Docker 未安装%s\n' "$RED" "$PLAIN"
  exit 1
fi
ok "docker 可用（$(docker --version 2>/dev/null | head -1)）"

if ! docker info >/dev/null 2>&1; then
  bad "无法连接 Docker 守护进程（当前用户可能没有权限）"
  hint "尝试 sudo 运行，或把当前用户加入 docker 组：sudo usermod -aG docker \$USER"
  printf '\n%s诊断结束：Docker 守护进程不可用%s\n' "$RED" "$PLAIN"
  exit 1
fi
ok "Docker 守护进程正常"

# --------------------------------------------------------------- 2. 容器
sec "2/7 容器状态"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  bad "找不到名为 ${CONTAINER} 的容器"
  info "当前运行的容器："
  docker ps --format '    {{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}' 2>/dev/null | head -20
  hint "容器没起来。在 docker-compose.yml 所在目录执行 docker compose logs hera-monitor 查看原因"
  hint "如果是首次构建失败，先确认能拉取 node:22-alpine 基础镜像"
  printf '\n%s✗ 诊断未完成：容器不存在%s\n' "$RED" "$PLAIN"
  exit 1
fi

RUNNING="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)"
HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)"
RESTARTS="$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null)"
PORTS="$(docker inspect -f '{{range $p, $conf := .NetworkSettings.Ports}}{{$p}} -> {{range $conf}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$CONTAINER" 2>/dev/null)"

if [ "$RUNNING" = "true" ]; then
  ok "容器正在运行（health=${HEALTH}，重启次数=${RESTARTS}）"
else
  bad "容器已停止（退出码 $(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER" 2>/dev/null)）"
  info "最近日志："
  docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/    /'
  hint "容器没在跑，外部必然访问不到。先按上面的日志修掉启动错误"
  printf '\n%s✗ 诊断未完成：容器未运行%s\n' "$RED" "$PLAIN"
  exit 1
fi

if [ "$HEALTH" = "unhealthy" ]; then
  warn "容器健康检查未通过，最近日志："
  docker logs --tail 20 "$CONTAINER" 2>&1 | sed 's/^/    /'
fi

printf '    端口映射：%s\n' "${PORTS:-（无）}"

# ------------------------------------------------------ 3. 容器内部监听地址
sec "3/7 容器内部监听地址（关键）"

INTERNAL="$(docker exec "$CONTAINER" node -e "
  fetch('http://127.0.0.1:'+(process.env.HERA_PORT||8080)+'/api/health')
    .then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))
    .catch(e=>console.log('ERR:'+e.message))
" 2>&1 | tail -1)"

LISTEN_ADDR=""
if printf '%s' "$INTERNAL" | grep -q '"ok":true'; then
  LISTEN_ADDR="$(printf '%s' "$INTERNAL" | sed -n 's/.*"address":"\([^"]*\)".*/\1/p')"
  LISTEN_PORT="$(printf '%s' "$INTERNAL" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')"
  ok "容器内 /api/health 正常，实际监听于 ${LISTEN_ADDR}:${LISTEN_PORT}"
else
  bad "容器内自测失败：${INTERNAL:-无响应}"
  info "最近日志："
  docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/    /'
  hint "容器内接口都不通，问题在应用自身。看上面的日志"
fi

case "$LISTEN_ADDR" in
  127.0.0.1|::1|localhost)
    bad "服务只监听了回环地址 ${LISTEN_ADDR} —— 这就是访问不到的根本原因"
    hint "在 docker-compose.yml 的 environment 里确保有 HERA_HOST: 0.0.0.0，然后 docker compose up -d 重建容器"
    ;;
  0.0.0.0|::|"")
    [ -n "$LISTEN_ADDR" ] && ok "监听所有网卡，端口映射可以正常转发"
    ;;
  *)
    warn "监听地址是 ${LISTEN_ADDR}（既不是 0.0.0.0 也不是回环），确认它是容器的网卡地址"
    ;;
esac

# ---------------------------------------------------------- 4. 宿主机端口
sec "4/7 宿主机端口发布情况"

if [ -n "$PORTS" ]; then
  ok "端口映射存在：${PORTS}"
else
  bad "没有检测到端口映射"
  hint "docker-compose.yml 里缺少 ports 配置，或 compose 文件没生效"
fi

if command -v ss >/dev/null 2>&1; then
  LISTENERS="$(ss -lntp 2>/dev/null | grep -E "[:.]${PORT}\b" || true)"
elif command -v netstat >/dev/null 2>&1; then
  LISTENERS="$(netstat -lntp 2>/dev/null | grep -E "[:.]${PORT}\b" || true)"
else
  LISTENERS=""
fi

if [ -n "$LISTENERS" ]; then
  ok "宿主机 ${PORT} 端口有进程监听："
  printf '%s\n' "$LISTENERS" | sed 's/^/    /'
  if printf '%s' "$LISTENERS" | grep -qE '(^|[[:space:]])(127\.0\.0\.1|\[::1\]):'; then
    bad "只监听了 127.0.0.1 —— 外部网络访问不到"
    hint "把 .env 里的 HERA_BIND 改成 0.0.0.0，然后 docker compose up -d"
  fi
else
  warn "宿主机 ${PORT} 端口没有监听进程"
  hint "端口没发布出来，检查 docker-compose.yml 的 ports 段"
fi

# -------------------------------------------------- 5. 宿主机本地回环访问
sec "5/7 宿主机本地访问"

try_curl() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 --noproxy '*' "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -qO /dev/null --timeout=5 --no-proxy "$1" 2>/dev/null && echo 200 || echo 000
  else
    echo "skip"
  fi
}

LOCAL_CODE="$(try_curl "http://127.0.0.1:${PORT}/api/health")"
if [ "$LOCAL_CODE" = "200" ]; then
  ok "http://127.0.0.1:${PORT} 返回 200"
elif [ "$LOCAL_CODE" = "skip" ]; then
  warn "宿主机没有 curl/wget，跳过本地访问测试"
else
  bad "http://127.0.0.1:${PORT} 返回 ${LOCAL_CODE}"
  hint "宿主机本地都访问不了，说明是端口映射或应用问题，不是防火墙"
fi

# ------------------------------------------------------------ 6. 公网访问
sec "6/7 公网地址访问"

PUBLIC_IP="$(curl -fsS --max-time 4 --noproxy '*' https://api.ipify.org 2>/dev/null \
  || curl -fsS --max-time 4 https://ifconfig.me 2>/dev/null || echo '')"

if [ -z "$PUBLIC_IP" ]; then
  warn "拿不到公网 IP（无法连接外网测速接口），跳过"
else
  PUB_CODE="$(try_curl "http://${PUBLIC_IP}:${PORT}/api/health")"
  if [ "$PUB_CODE" = "200" ]; then
    ok "${PUBLIC_IP}:${PORT} 可以访问"
  elif [ "$PUB_CODE" = "skip" ]; then
    warn "缺少 curl/wget，跳过公网测试"
  elif [ "$LOCAL_CODE" = "200" ]; then
    bad "本机 127.0.0.1:${PORT} 通，但公网 ${PUBLIC_IP}:${PORT} 不通"
    hint "这基本可以确定是【云服务器安全组】或【系统防火墙】没放行 ${PORT} 端口 —— Docker 不受 ufw 规则约束，安全组一定要单独放行"
  else
    warn "公网 ${PUBLIC_IP}:${PORT} 返回 ${PUB_CODE}"
  fi
fi

# ---------------------------------------------------------------- 7. 防火墙
sec "7/7 防火墙状态"

FW_FOUND=0
if command -v ufw >/dev/null 2>&1; then
  FW_FOUND=1
  UFW_STATUS="$(ufw status 2>/dev/null | head -1 || echo 'unknown')"
  printf '    ufw: %s\n' "$UFW_STATUS"
  if printf '%s' "$UFW_STATUS" | grep -qi active; then
    if ufw status 2>/dev/null | grep -qE "${PORT}(/tcp)?\b"; then
      ok "ufw 已放行 ${PORT}"
    else
      warn "ufw 已启用但没有放行 ${PORT}（注意：Docker 会绕过 ufw 规则，若仍不通请重点查安全组）"
    fi
  fi
fi

if command -v firewall-cmd >/dev/null 2>&1; then
  FW_FOUND=1
  if firewall-cmd --state >/dev/null 2>&1; then
    if firewall-cmd --list-ports 2>/dev/null | grep -qE "${PORT}/tcp"; then
      ok "firewalld 已放行 ${PORT}/tcp"
    else
      warn "firewalld 运行中但未放行 ${PORT}/tcp"
      hint "执行：sudo firewall-cmd --permanent --add-port=${PORT}/tcp && sudo firewall-cmd --reload"
    fi
  fi
fi

if [ "$FW_FOUND" = "0" ]; then
  info "未检测到 ufw / firewalld"
fi

if command -v iptables >/dev/null 2>&1; then
  DOCKER_RULES="$(iptables -t nat -L DOCKER -n 2>/dev/null | grep -c ":${PORT}\b" || echo 0)"
  if [ "$DOCKER_RULES" -gt 0 ] 2>/dev/null; then
    ok "iptables NAT 中已有 ${PORT} 的 DOCKER 转发规则"
  else
    info "iptables NAT 中未见 ${PORT} 的转发规则（非 root 时读不到，可忽略）"
  fi
fi

# ---------------------------------------------------------------- 结论
printf '\n%s%s%s\n' "$BOLD" "$(printf '═%.0s' {1..62})" "$PLAIN"
if [ ${#HINTS[@]} -eq 0 ]; then
  printf '  %s未发现明显问题%s\n' "$GREEN" "$PLAIN"
  printf '  如果仍无法访问，请把本脚本输出和 docker compose logs 一起提供\n'
else
  printf '  %s建议按顺序处理：%s\n' "$YELLOW" "$PLAIN"
  i=1
  for h in "${HINTS[@]}"; do
    printf '  %d. %s\n' "$i" "$h"
    i=$((i + 1))
  done
fi
printf '%s%s%s\n\n' "$BOLD" "$(printf '═%.0s' {1..62})" "$PLAIN"
