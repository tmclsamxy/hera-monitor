#!/usr/bin/env bash
#
# install.sh 参数与演练模式的测试
#
#   bash test/install-args.sh
#
# 用 --dry-run 验证，全程不需要 root、不触碰任何系统文件。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  \033[32m✅\033[0m %s%s\n' "$1" "${2:+ — $2}"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m❌\033[0m %s%s\n' "$1" "${2:+ — $2}"; }

# 断言：命令应该失败，并且输出里含指定关键字
expect_fail() {
  local name="$1" keyword="$2"; shift 2
  local out
  out="$(bash install.sh "$@" 2>&1)"
  if [ $? -ne 0 ] && printf '%s' "$out" | grep -q -- "$keyword"; then
    ok "$name" "$(printf '%s' "$out" | head -1 | cut -c1-60)"
  else
    bad "$name" "未按预期拒绝：$(printf '%s' "$out" | head -1 | cut -c1-60)"
  fi
}

# 断言：演练输出里应包含某个字符串
expect_contains() {
  local name="$1" keyword="$2"; shift 2
  local out
  out="$(bash install.sh --dry-run "$@" 2>&1)"
  if printf '%s' "$out" | grep -q -- "$keyword"; then
    ok "$name" "$(printf '%s' "$out" | grep -- "$keyword" | head -1 | sed 's/^ *//')"
  else
    bad "$name" "输出中未找到「$keyword」"
  fi
}

printf '\ninstall.sh 参数测试\n'
printf '─%.0s' {1..58}; printf '\n'

# ---------------------------------------------------------- 非法参数
expect_fail '非数字端口被拒绝'      '--port 必须是数字'      --port abc
expect_fail '端口下越界被拒绝'      '1-65535'                --port 0
expect_fail '端口上越界被拒绝'      '1-65535'                --port 70000
expect_fail '负数端口被拒绝'        '--port 必须是数字'      --port -1
expect_fail '非法 mode 被拒绝'      '--mode 只能是'          --mode bogus
expect_fail '相对路径 install dir'  '--dir 必须是绝对路径'   --dir relative/path
expect_fail '未知参数被拒绝'        '未知参数'               --nope

out="$(bash install.sh --help 2>&1)"
if [ $? -eq 0 ] && printf '%s' "$out" | grep -q -- '--port'; then
  ok '--help 正常输出' "$(printf '%s' "$out" | wc -l) 行"
else
  bad '--help 正常输出'
fi

out="$(bash install.sh --help 2>&1)"
for k in '--mode' '--port' '--host' '--public-url' '--image' '--dry-run' '--uninstall'; do
  if printf '%s' "$out" | grep -q -- "$k"; then ok "帮助里列出了 $k"; else bad "帮助里缺少 $k"; fi
done

# ---------------------------------------------------------- 演练模式
printf '\n'
expect_contains '演练显示默认端口 8080'        '面板端口    8080'        --mode native
expect_contains '演练显示自定义端口 9443'      '面板端口    9443'        --mode docker --port 9443
expect_contains '演练显示自定义监听地址'        '监听地址    127.0.0.1'   --mode docker --port 9443 --host 127.0.0.1
expect_contains '演练显示公网地址'              'https://mon.example.com' --mode docker --public-url https://mon.example.com
expect_contains '演练显示自定义安装目录'        '/srv/hera'               --mode docker --dir /srv/hera
expect_contains 'docker 模式下写出 HERA_PORT'   'HERA_PORT=9443'          --mode docker --port 9443
expect_contains 'docker 模式下写出 HERA_BIND'   'HERA_BIND=127.0.0.1'     --mode docker --host 127.0.0.1
expect_contains 'docker 模式拼出正确的端口映射'  '127.0.0.1:9443:8080'     --mode docker --port 9443 --host 127.0.0.1

out="$(bash install.sh --dry-run --mode native --port 9000 2>&1)"
if printf '%s' "$out" | grep -q 'systemd' && printf '%s' "$out" | grep -q 'HERA_PORT=9000'; then
  ok 'native 模式演练显示 systemd 单元信息'
else
  bad 'native 模式演练显示 systemd 单元信息'
fi

out="$(bash install.sh --dry-run --mode docker --image ghcr.io/x/y:latest --port 7000 2>&1)"
if printf '%s' "$out" | grep -q 'docker run' && printf '%s' "$out" | grep -q '7000:8080'; then
  ok '--image 模式演练显示 docker run 命令' "$(printf '%s' "$out" | grep 'docker run' | sed 's/^ *//' | cut -c1-50)…"
else
  bad '--image 模式演练显示 docker run 命令'
fi

# 演练模式必须零副作用：指定的安装目录不应被创建
CHECK_DIR="/tmp/hera-dryrun-check-$$"
rm -rf "$CHECK_DIR" 2>/dev/null
bash install.sh --dry-run --mode docker --dir "$CHECK_DIR" >/dev/null 2>&1
if [ ! -e "$CHECK_DIR" ]; then
  ok '演练模式未创建任何目录（零副作用）'
else
  bad '演练模式未创建任何目录（零副作用）' "$CHECK_DIR 被创建了"
  rm -rf "$CHECK_DIR" 2>/dev/null
fi

printf '─%.0s' {1..58}; printf '\n'
printf '  通过 %d 项，失败 %d 项\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
