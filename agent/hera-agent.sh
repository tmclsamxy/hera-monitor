#!/usr/bin/env bash
#
# Hera Monitor Agent —— 纯 bash 实现的服务器监控上报端
# 只依赖 /proc、coreutils 和 curl，无需 Python / Go / Node 运行时。
#
# 用法：
#   hera-agent --server http://panel.example.com:8080 --key <AGENT_KEY>
#   hera-agent --once          # 只上报一次，便于排障
#   hera-agent --print         # 只打印采集到的 JSON，不上报
#
set -u

AGENT_VERSION="1.0.0"
CONF_FILE="${HERA_AGENT_CONF:-/etc/hera-agent.conf}"
STATE_DIR="${HERA_AGENT_STATE:-/var/lib/hera-agent}"

SERVER=""
KEY=""
INTERVAL=""
CFG_NAME=""
CFG_REGION=""
CFG_GROUP=""
ONCE=0
PRINT_ONLY=0
INSECURE="${HERA_AGENT_INSECURE:-0}"

usage() {
  cat <<'EOF'
Hera Monitor Agent - 轻量服务器监控上报端

用法:
  hera-agent --server <面板地址> --key <密钥> [选项]

选项:
  --server URL      面板地址，例如 http://1.2.3.4:8080
  --key KEY         Agent 密钥（面板「设置」页获取）
  --interval N      上报间隔秒数，默认 30
  --name NAME       自定义显示名称
  --region REGION   地区标签，例如 CN / HK / JP
  --group GROUP     分组名，默认「默认」
  --once, -1        只上报一次后退出
  --print           只打印采集到的 JSON，不上报（排障用）
  --insecure        跳过 HTTPS 证书校验
  -h, --help        显示帮助

环境变量:
  HERA_AGENT_CONF   配置文件路径，默认 /etc/hera-agent.conf
  HERA_AGENT_STATE  状态目录，默认 /var/lib/hera-agent
EOF
}

# ---------------------------------------------------------------- 参数解析
if [ -f "$CONF_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONF_FILE"
fi

CLI_INTERVAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server)   SERVER="${2:-}"; shift 2 ;;
    --key)      KEY="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; CLI_INTERVAL=1; shift 2 ;;
    --name)     CFG_NAME="${2:-}"; shift 2 ;;
    --region)   CFG_REGION="${2:-}"; shift 2 ;;
    --group)    CFG_GROUP="${2:-}"; shift 2 ;;
    --once|-1)  ONCE=1; shift ;;
    --print)    PRINT_ONLY=1; shift ;;
    --insecure) INSECURE=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$PRINT_ONLY" != "1" ]; then
  [ -z "$SERVER" ] && { echo "错误：必须提供 --server" >&2; exit 1; }
  [ -z "$KEY" ] && { echo "错误：必须提供 --key" >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { echo "错误：未找到 curl，请先安装" >&2; exit 1; }
fi

SERVER="${SERVER%/}"

mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="${TMPDIR:-/tmp}/hera-agent"
[ "$CLI_INTERVAL" = "0" ] && [ -z "$INTERVAL" ] && INTERVAL=$(cat "$STATE_DIR/interval" 2>/dev/null)
INTERVAL="${INTERVAL:-30}"
case "$INTERVAL" in ''|*[!0-9]*) INTERVAL=30 ;; esac
[ "$INTERVAL" -lt 5 ] && INTERVAL=5
[ "$INTERVAL" -gt 3600 ] && INTERVAL=3600

# ------------------------------------------------------------------ 采集
json_escape() {
  printf '%s' "$1" | tr -d '[:cntrl:]' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# 数字兜底：非法值一律输出 0，避免生成非法 JSON
nz() {
  case "${1:-}" in
    ''|*[!0-9.+-]*) printf '0' ;;
    *) printf '%s' "$1" ;;
  esac
}

get_machine_id() {
  local f v
  for f in /etc/machine-id /var/lib/dbus/machine-id /sys/class/dmi/id/product_uuid; do
    if [ -r "$f" ]; then
      v=$(head -c 128 "$f" 2>/dev/null | tr -d ' \t\n\r')
      [ -n "$v" ] && { printf '%s' "$(printf '%s' "$v" | tr 'A-Z' 'a-z' | cut -c1-32)"; return; }
    fi
  done
  local mac
  mac=$(cat /sys/class/net/*/address 2>/dev/null | grep -v '^00:00:00:00:00:00$' | head -n1 | tr -d ':\n')
  if command -v md5sum >/dev/null 2>&1; then
    printf '%s%s' "$(hostname)" "$mac" | md5sum | cut -c1-32
  else
    printf '%s%s' "$(hostname)" "$mac" | cksum | tr -d ' ' | cut -c1-32
  fi
}

collect_cpu() {
  # 返回: total_delta idle_delta user% system% iowait% steal% usage%
  local now_line prev_file cur_total cur_idle cur_user cur_system cur_iowait cur_steal
  local p_total p_idle p_user p_system p_iowait p_steal
  now_line=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6, $2, $4, $6, $9}' /proc/stat)
  read -r cur_total cur_idle cur_user cur_system cur_iowait cur_steal <<EOF
$now_line
EOF

  prev_file="$STATE_DIR/cpu.state"
  if [ -r "$prev_file" ]; then
    read -r p_total p_idle p_user p_system p_iowait p_steal < "$prev_file" 2>/dev/null || p_total=""
  fi
  printf '%s %s %s %s %s %s\n' "$cur_total" "$cur_idle" "$cur_user" "$cur_system" "$cur_iowait" "$cur_steal" > "$prev_file" 2>/dev/null

  if [ -z "${p_total:-}" ]; then
    # 首次运行没有基线，用开机至今的平均值
    p_total=0; p_idle=0; p_user=0; p_system=0; p_iowait=0; p_steal=0
  fi

  awk -v ct="$cur_total" -v ci="$cur_idle" -v cu="$cur_user" -v cs="$cur_system" -v cw="$cur_iowait" -v ck="$cur_steal" \
      -v pt="$p_total" -v pi="$p_idle" -v pu="$p_user" -v ps="$p_system" -v pw="$p_iowait" -v pk="$p_steal" 'BEGIN{
    dt = ct - pt;
    di = ci - pi;
    if (dt <= 0) { printf "0 0 0 0 0 0 0"; exit }
    usage = (1 - di / dt) * 100;
    if (usage < 0) usage = 0; if (usage > 100) usage = 100;
    if (pt <= 0) {
      # 无基线：用累计值近似
      if (ct > 0) {
        printf "%.2f %.2f %.2f %.2f %.2f %.2f %.2f", ct, ci,
          (cu/ct)*100, (cs/ct)*100, (cw/ct)*100, (ck/ct)*100, (1-ci/ct)*100;
      } else { printf "0 0 0 0 0 0 0" }
      exit
    }
    printf "%.0f %.0f %.2f %.2f %.2f %.2f %.2f", dt, di,
      (cu-pu)/dt*100, (cs-ps)/dt*100, (cw-pw)/dt*100, (ck-pk)/dt*100, usage;
  }'
}

collect_mem() {
  # 输出: total_kb available_kb used_kb swap_total_kb swap_used_kb
  awk '
    /^MemTotal:/     { t = $2 }
    /^MemAvailable:/ { a = $2 }
    /^MemFree:/      { f = $2 }
    /^Buffers:/      { b = $2 }
    /^Cached:/       { c = $2 }
    /^SwapTotal:/    { st = $2 }
    /^SwapFree:/     { sf = $2 }
    END {
      if (a > 0) { u = t - a } else { u = t - f - b - c }
      if (u < 0) u = 0
      printf "%d %d %d %d %d", t, a, u, st, st - sf
    }' /proc/meminfo
}

collect_disks() {
  # 输出若干行: fs<TAB>mount<TAB>total_bytes<TAB>used_bytes<TAB>pct
  # 注意：df 的 1024-blocks 即 KB，统一乘以 1024 转成字节上报，全链路单位一致
  local out
  out=$(df -PT -k 2>/dev/null | awk '
    NR > 1 && $2 ~ /^(ext[234]|xfs|btrfs|zfs|f2fs|vfat|msdos|ntfs|ntfs3|fuseblk|nfs|nfs4|cifs|smb3|hfs|hfsplus|apfs|jfs|reiserfs|udf|exfat|9p)$/ && $3 > 2048 {
      pct = $6; gsub(/%/, "", pct);
      printf "%s\t%s\t%d\t%d\t%s\n", $1, $7, $3 * 1024, $4 * 1024, pct
    }')
  if [ -z "$out" ]; then
    # busybox df 不支持 -T，退化为按类型排除
    out=$(df -P -k 2>/dev/null | awk '
      NR > 1 && $1 !~ /^(tmpfs|devtmpfs|overlay|shm|udev|none)$/ && $2 > 2048 {
        pct = $5; gsub(/%/, "", pct);
        printf "%s\t%s\t%d\t%d\t%s\n", $1, $6, $2 * 1024, $3 * 1024, pct
      }')
  fi
  printf '%s' "$out"
}

collect_net() {
  # 输出若干行: iface rx_bytes tx_bytes
  awk '
    NR > 2 {
      sub(":", "", $1)
      if ($1 ~ /^(lo|docker.*|br-.*|veth.*|virbr.*|vmnet.*|cni.*|cali.*|flannel.*|kube.*|dummy.*)$/) next
      printf "%s %s %s\n", $1, $2, $10
    }' /proc/net/dev 2>/dev/null
}

collect_host_info() {
  OS_NAME=$( [ -r /etc/os-release ] && . /etc/os-release 2>/dev/null; printf "%s" "${PRETTY_NAME:-}" )
  if [ -z "$OS_NAME" ] || [ "$OS_NAME" = "Linux" ]; then
    OS_NAME=$(uname -s -r 2>/dev/null || echo Linux)
  fi
  KERNEL=$(uname -r 2>/dev/null || echo '')
  ARCH=$(uname -m 2>/dev/null || echo '')
  HOSTNAME_V=$(hostname 2>/dev/null || echo unknown)

  CPU_MODEL=$(awk -F: '/^(model name|Model|Hardware|cpu model|Processor)/ { gsub(/^ +| +$/, "", $2); if ($2 != "") { print $2; exit } }' /proc/cpuinfo 2>/dev/null)
  [ -z "$CPU_MODEL" ] && CPU_MODEL="Unknown CPU"
  CPU_CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)
  case "$CPU_CORES" in ''|*[!0-9]*) CPU_CORES=1 ;; esac

  VIRT=$(systemd-detect-virt 2>/dev/null || echo '')
  [ "$VIRT" = "none" ] && VIRT=""
}

collect_misc() {
  UPTIME_S=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)
  case "$UPTIME_S" in ''|*[!0-9]*) UPTIME_S=0 ;; esac
  BOOT_TIME=$(( $(date +%s) - UPTIME_S ))

  PROCS=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)
  case "$PROCS" in ''|*[!0-9]*) PROCS=0 ;; esac

  local t4 t6
  t4=$(awk 'END{print NR-1}' /proc/net/tcp 2>/dev/null || echo 0)
  t6=$(awk 'END{print NR-1}' /proc/net/tcp6 2>/dev/null || echo 0)
  case "$t4" in ''|*[!0-9]*) t4=0 ;; esac
  case "$t6" in ''|*[!0-9]*) t6=0 ;; esac
  TCP_CONN=$(( t4 + t6 ))
}

build_json() {
  local ts
  ts=$(($(date +%s) * 1000))

  collect_host_info
  collect_misc

  local cpu_line
  cpu_line=$(collect_cpu)
  local cpu_usage cpu_user cpu_system cpu_iowait cpu_steal
  cpu_usage=$(echo "$cpu_line" | awk '{print $7}')
  cpu_user=$(echo "$cpu_line" | awk '{print $3}')
  cpu_system=$(echo "$cpu_line" | awk '{print $4}')
  cpu_iowait=$(echo "$cpu_line" | awk '{print $5}')
  cpu_steal=$(echo "$cpu_line" | awk '{print $6}')

  local mem_line mem_total mem_avail mem_used swap_total swap_used
  mem_line=$(collect_mem)
  mem_total=$(echo "$mem_line" | awk '{print $1 * 1024}')
  mem_avail=$(echo "$mem_line" | awk '{print $2 * 1024}')
  mem_used=$(echo "$mem_line" | awk '{print $3 * 1024}')
  swap_total=$(echo "$mem_line" | awk '{print $4 * 1024}')
  swap_used=$(echo "$mem_line" | awk '{print $5 * 1024}')

  local load_line
  read -r load1 load5 load15 _ < /proc/loadavg 2>/dev/null || { load1=0; load5=0; load15=0; }

  # ---- 磁盘 JSON
  local disks_json="" d_fs d_mount d_total d_used d_pct
  while IFS=$'\t' read -r d_fs d_mount d_total d_used d_pct; do
    [ -z "$d_fs" ] && continue
    [ -n "$disks_json" ] && disks_json="$disks_json,"
    disks_json="$disks_json{\"fs\":\"$(json_escape "$d_fs")\",\"mount\":\"$(json_escape "$d_mount")\",\"total\":$(nz "$d_total"),\"used\":$(nz "$d_used"),\"pct\":$(nz "$d_pct")}"
  done <<EOF
$(collect_disks)
EOF

  # ---- 网络 JSON（同时算总量）
  local net_json="" total_rx=0 total_tx=0 n_iface n_rx n_tx iface_count=0
  while read -r n_iface n_rx n_tx; do
    [ -z "$n_iface" ] && continue
    case "$n_rx" in ''|*[!0-9]*) n_rx=0 ;; esac
    case "$n_tx" in ''|*[!0-9]*) n_tx=0 ;; esac
    total_rx=$(( total_rx + n_rx ))
    total_tx=$(( total_tx + n_tx ))
    # 只上报流量最大的前 12 个网卡
    if [ "$iface_count" -lt 12 ]; then
      [ -n "$net_json" ] && net_json="$net_json,"
      net_json="$net_json{\"iface\":\"$(json_escape "$n_iface")\",\"rx\":$(nz "$n_rx"),\"tx\":$(nz "$n_tx")}"
      iface_count=$(( iface_count + 1 ))
    fi
  done <<EOF
$(collect_net)
EOF

  local agent_id show_name
  agent_id=$(get_machine_id)
  show_name="${CFG_NAME:-$HOSTNAME_V}"

  cat <<EOF
{
  "v": 1,
  "agent": {"version": "$AGENT_VERSION", "interval": $(nz "$INTERVAL")},
  "host": {
    "id": "$(json_escape "$agent_id")",
    "hostname": "$(json_escape "$show_name")",
    "os": "$(json_escape "$OS_NAME")",
    "platform": "linux",
    "arch": "$(json_escape "$ARCH")",
    "kernel": "$(json_escape "$KERNEL")",
    "cpuModel": "$(json_escape "$CPU_MODEL")",
    "cpuCores": $(nz "$CPU_CORES"),
    "virt": "$(json_escape "$VIRT")",
    "group": "$(json_escape "$CFG_GROUP")",
    "region": "$(json_escape "$CFG_REGION")"
  },
  "ts": $(nz "$ts"),
  "uptime": $(nz "$UPTIME_S"),
  "bootTime": $(nz "$BOOT_TIME"),
  "procs": $(nz "$PROCS"),
  "tcp": $(nz "$TCP_CONN"),
  "cpu": {"usage": $(nz "$cpu_usage"), "user": $(nz "$cpu_user"), "system": $(nz "$cpu_system"), "iowait": $(nz "$cpu_iowait"), "steal": $(nz "$cpu_steal")},
  "mem": {"total": $(nz "$mem_total"), "used": $(nz "$mem_used"), "available": $(nz "$mem_avail")},
  "swap": {"total": $(nz "$swap_total"), "used": $(nz "$swap_used")},
  "load": {"l1": $(nz "$load1"), "l5": $(nz "$load5"), "l15": $(nz "$load15")},
  "disks": [${disks_json}],
  "net": [${net_json}],
  "netTotal": {"rx": $(nz "$total_rx"), "tx": $(nz "$total_tx")}
}
EOF
}

# ------------------------------------------------------------------ 上报
report_once() {
  local json resp
  json=$(build_json)

  if [ "$PRINT_ONLY" = "1" ]; then
    printf '%s\n' "$json"
    return 0
  fi

  local curl_opts=(-fsS -m "$((INTERVAL > 20 ? INTERVAL - 5 : 15))" -X POST
                   -H 'Content-Type: application/json' -H "X-Agent-Key: $KEY"
                   --data-binary "$json")
  [ "$INSECURE" = "1" ] && curl_opts+=(-k)

  if resp=$(curl "${curl_opts[@]}" "$SERVER/api/agent/report" 2>&1); then
    local new_interval
    new_interval=$(printf '%s' "$resp" | sed -n 's/.*"interval":[[:space:]]*\([0-9]\{1,5\}\).*/\1/p')
    if [ -n "$new_interval" ] && [ "$new_interval" != "$INTERVAL" ]; then
      INTERVAL="$new_interval"
      echo "$INTERVAL" > "$STATE_DIR/interval" 2>/dev/null
      [ "$VERBOSE" = "1" ] && echo "[hera-agent] 服务端下发新上报间隔: ${INTERVAL}s"
    fi
    [ "$VERBOSE" = "1" ] && echo "[hera-agent] $(date '+%F %T') 上报成功"
    return 0
  fi
  echo "[hera-agent] $(date '+%F %T') 上报失败: ${resp:-unknown}" >&2
  return 1
}

VERBOSE="${VERBOSE:-0}"

if [ "$ONCE" = "1" ] || [ "$PRINT_ONLY" = "1" ]; then
  report_once
  exit $?
fi

trap 'echo "[hera-agent] 收到退出信号，停止上报"; exit 0' TERM INT
echo "[hera-agent] v${AGENT_VERSION} 启动，上报目标 ${SERVER}，间隔 ${INTERVAL}s"
while :; do
  report_once || true
  sleep "$INTERVAL"
done
