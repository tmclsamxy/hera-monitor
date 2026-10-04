#!/usr/bin/env bash
#
# install.sh 的参数、交互与生命周期测试
#
#   bash test/install-args.sh
#
# 全部走 --dry-run 或只看输出，不需要 root，也不碰系统里真正的安装。
# 交互通过 HERA_TTY 指向文件来模拟终端。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  \033[32m✅\033[0m %s%s\n' "$1" "${2:+ — $2}"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m❌\033[0m %s%s\n' "$1" "${2:+ — $2}"; }

WORK=".tmp-test"
FAKE="$ROOT/$WORK/fake"
FRESH="$ROOT/$WORK/fresh"

# 断言：命令失败且输出含关键字
expect_fail() {
  local name="$1" keyword="$2"; shift 2
  local out
  out="$(bash install.sh "$@" 2>&1)"
  if [ $? -ne 0 ] && printf '%s' "$out" | grep -q -- "$keyword"; then
    ok "$name" "$(printf '%s' "$out" | grep -- "$keyword" | head -1 | cut -c1-58)"
  else
    bad "$name" "未按预期拒绝：$(printf '%s' "$out" | tail -1 | cut -c1-58)"
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

# 写一份模拟终端输入
answers() { printf '%b' "$2" > "$1"; }

# 带模拟终端执行 install.sh
run_tty() {
  local ans="$1"; shift
  HERA_TTY="$ans" bash install.sh "$@" 2>&1
}

# 准备一个「已安装」的假目录
setup_fake() {
  rm -rf "$WORK" 2>/dev/null
  mkdir -p "$FAKE/server/src" "$WORK"
  printf 'HERA_PORT=7777\nHERA_BIND=127.0.0.1\nHERA_PUBLIC_URL=https://old.example.com\n' > "$FAKE/.env"
  echo '// dummy' > "$FAKE/server/src/index.js"
}

printf '\ninstall.sh 测试\n'
printf '─%.0s' {1..60}; printf '\n'

# ============================================================ 1. 非法参数
printf '\n[非法参数]\n'
expect_fail '非数字端口被拒绝'      '--port 必须是数字'      --port abc
expect_fail '端口下越界被拒绝'      '1-65535'                --port 0
expect_fail '端口上越界被拒绝'      '1-65535'                --port 70000
expect_fail '负数端口被拒绝'        '--port 必须是数字'      --port -1
expect_fail '非法 mode 被拒绝'      '--mode 只能是'          --mode bogus
expect_fail '相对路径 install dir'  '--dir 必须是绝对路径'   --dir relative/path
expect_fail '未知参数被拒绝'        '未知参数'               --nope
expect_fail '--upgrade 但未安装'    '本机未检测到'           --upgrade --dry-run --dir "$FRESH"
expect_fail '--reconfigure 但未安装' '本机未检测到'          --reconfigure --dry-run --dir "$FRESH"

# ============================================================== 2. --help
printf '\n[--help]\n'
HELP="$(bash install.sh --help 2>&1)"
if [ $? -eq 0 ] && printf '%s' "$HELP" | grep -q -- '--port'; then
  ok '--help 正常输出' "$(printf '%s' "$HELP" | wc -l) 行"
else
  bad '--help 正常输出'
fi
for k in '--mode' '--port' '--host' '--public-url' '--image' '--dry-run' \
         '--uninstall' '--upgrade' '--reconfigure' '--yes'; do
  if printf '%s' "$HELP" | grep -q -- "$k"; then ok "帮助里列出了 $k"; else bad "帮助里缺少 $k"; fi
done

# ============================================================== 3. 演练输出
printf '\n[演练输出]\n'
expect_contains '默认端口 8080'        '面板端口    8080'        --mode native --dir "$FRESH"
expect_contains '自定义端口 9443'      '面板端口    9443'        --mode docker --port 9443 --dir "$FRESH"
expect_contains '自定义监听地址'        '监听地址    127.0.0.1'   --mode docker --port 9443 --host 127.0.0.1 --dir "$FRESH"
expect_contains '自定义公网地址'        'https://mon.example.com' --mode docker --public-url https://mon.example.com --dir "$FRESH"
expect_contains '自定义安装目录'        '/srv/hera'               --mode docker --dir /srv/hera
expect_contains 'docker 写出 HERA_PORT' 'HERA_PORT=9443'          --mode docker --port 9443 --dir "$FRESH"
expect_contains 'docker 写出 HERA_BIND' 'HERA_BIND=127.0.0.1'     --mode docker --host 127.0.0.1 --dir "$FRESH"
expect_contains '正确的端口映射'        '127.0.0.1:9443:8080'     --mode docker --port 9443 --host 127.0.0.1 --dir "$FRESH"

OUT="$(bash install.sh --dry-run --mode native --port 9000 --dir "$FRESH" 2>&1)"
if printf '%s' "$OUT" | grep -q 'systemd' && printf '%s' "$OUT" | grep -q 'HERA_PORT=9000'; then
  ok 'native 模式显示 systemd 单元信息'
else
  bad 'native 模式显示 systemd 单元信息'
fi

OUT="$(bash install.sh --dry-run --mode docker --image ghcr.io/x/y:latest --port 7000 --dir "$FRESH" 2>&1)"
if printf '%s' "$OUT" | grep -q 'docker run' && printf '%s' "$OUT" | grep -q '7000:8080'; then
  ok '--image 模式显示 docker run 命令'
else
  bad '--image 模式显示 docker run 命令'
fi

# ========================================================== 4. 交互式安装
printf '\n[交互式安装]\n'
setup_fake
T="$WORK/a1"; answers "$T" '9443\ny\nhttps://mon.example.com\ny\n'
OUT="$(run_tty "$T" --dry-run --dir "$FRESH")"
for pair in '面板端口|9443' '监听地址|127.0.0.1' '公网地址|https://mon.example.com'; do
  k="${pair%%|*}"; v="${pair##*|}"
  if printf '%s' "$OUT" | grep -E "^  $k" | grep -q -- "$v"; then
    ok "交互式采集 $k = $v"
  else
    bad "交互式采集 $k = $v" "$(printf '%s' "$OUT" | grep -E "^  $k" | head -1)"
  fi
done

# 端口校验循环：先给两个非法值，再给合法值
T="$WORK/a2"; answers "$T" 'abc\n70000\n0\n9443\ny\n\n\n'
OUT="$(run_tty "$T" --dry-run --dir "$FRESH")"
[ "$(printf '%s' "$OUT" | grep -c '端口必须是数字')" -ge 1 ] \
  && ok '非数字端口被要求重输' || bad '非数字端口被要求重输'
[ "$(printf '%s' "$OUT" | grep -c '端口必须在 1-65535 之间')" -ge 2 ] \
  && ok '越界端口被要求重输（两次）' || bad '越界端口被要求重输（两次）'
printf '%s' "$OUT" | grep -E '^  面板端口' | grep -q '9443' \
  && ok '校验后接受合法端口 9443' || bad '校验后接受合法端口 9443'

# 确认阶段回答 n → 应取消且不做任何事
T="$WORK/a3"; answers "$T" '9000\nn\n\nn\n'
OUT="$(run_tty "$T" --dry-run --dir "$FRESH")"
if printf '%s' "$OUT" | grep -q '已取消' && ! printf '%s' "$OUT" | grep -q '演练模式'; then
  ok '确认阶段选 n 会取消并退出'
else
  bad '确认阶段选 n 会取消并退出'
fi

# ==================================================== 5. 已安装检测与菜单
printf '\n[已安装检测与菜单]\n'
setup_fake
T="$WORK/b0"; answers "$T" '\n'
OUT="$(run_tty "$T" --dry-run --dir "$FAKE")"
for pair in '检测到本机已安装|' '当前端口|7777' '监听地址|127.0.0.1' '公网地址|https://old.example.com' '部署方式|Docker'; do
  k="${pair%%|*}"; v="${pair##*|}"
  if printf '%s' "$OUT" | grep -E "^  $k" | grep -q -- "$v"; then
    ok "已安装信息：$k${v:+ = $v}"
  else
    bad "已安装信息：$k${v:+ = $v}"
  fi
done
if printf '%s' "$OUT" | grep -q '请选择要执行的操作'; then ok '弹出操作菜单'; else bad '弹出操作菜单'; fi
for opt in '1) 升级' '2) 修改端口' '3) 卸载' '4) 退出'; do
  printf '%s' "$OUT" | grep -q "$opt" && ok "菜单含「$opt」" || bad "菜单缺少「$opt」"
done

# 选 1：升级，保留现有配置
T="$WORK/b1"; answers "$T" '1\n'
OUT="$(run_tty "$T" --dry-run --dir "$FAKE")"
if printf '%s' "$OUT" | grep -q '本次动作    upgrade' \
   && printf '%s' "$OUT" | grep -E '^  面板端口' | grep -q '7777' \
   && printf '%s' "$OUT" | grep -E '^  公网地址' | grep -q 'old.example.com'; then
  ok '菜单选 1 升级并保留端口与域名'
else
  bad '菜单选 1 升级并保留端口与域名'
fi

# 选 2：重新配置，应用新参数
T="$WORK/b2"; answers "$T" '2\n9443\nn\nhttps://new.example.com\n\n\n'
OUT="$(run_tty "$T" --dry-run --dir "$FAKE")"
if printf '%s' "$OUT" | grep -E '^  面板端口' | grep -q '9443' \
   && printf '%s' "$OUT" | grep -E '^  监听地址' | grep -q '0.0.0.0' \
   && printf '%s' "$OUT" | grep -E '^  公网地址' | grep -q 'new.example.com'; then
  ok '菜单选 2 重新配置并应用新参数'
else
  bad '菜单选 2 重新配置并应用新参数' "$(printf '%s' "$OUT" | grep -E '^  (面板端口|监听地址|公网地址)')"
fi

# 选 3：卸载（演练，不得真删）
T="$WORK/b3"; answers "$T" '3\n'
OUT="$(run_tty "$T" --dry-run --dir "$FAKE")"
if printf '%s' "$OUT" | grep -q '本次动作    uninstall' && [ -d "$FAKE/server" ]; then
  ok '菜单选 3 进入卸载流程（演练不真删）'
else
  bad '菜单选 3 进入卸载流程（演练不真删）'
fi

# 选 4：退出
T="$WORK/b4"; answers "$T" '4\n'
OUT="$(run_tty "$T" --dry-run --dir "$FAKE")"
if printf '%s' "$OUT" | grep -q '已取消' && ! printf '%s' "$OUT" | grep -q '演练模式'; then
  ok '菜单选 4 直接退出'
else
  bad '菜单选 4 直接退出'
fi

# 非法菜单选项应重新询问
T="$WORK/b5"; answers "$T" '9\n1\n'
OUT="$(run_tty "$T" --dry-run --dir "$FAKE")"
if printf '%s' "$OUT" | grep -q '请输入 1-4' \
   && printf '%s' "$OUT" | grep -q '本次动作    upgrade'; then
  ok '非法菜单选项会重新询问'
else
  bad '非法菜单选项会重新询问'
fi

# ============================================== 6. 非交互与自动降级
printf '\n[非交互与自动降级]\n'
setup_fake
OUT="$(bash install.sh --dry-run --dir "$FAKE" 2>&1)"   # 无 HERA_TTY
if printf '%s' "$OUT" | grep -q '本次动作    upgrade'; then
  ok '无可用终端时自动降级：已安装 → 直接升级'
else
  bad '无可用终端时自动降级：已安装 → 直接升级'
fi

OUT="$(bash install.sh --dry-run --dir "$FRESH" 2>&1)"
if printf '%s' "$OUT" | grep -q '本机尚未安装' && printf '%s' "$OUT" | grep -q '面板端口    8080'; then
  ok '无可用终端时用默认参数安装'
else
  bad '无可用终端时用默认参数安装'
fi

OUT="$(bash install.sh --yes --dry-run --dir "$FAKE" 2>&1)"
if printf '%s' "$OUT" | grep -q '本次动作    upgrade' \
   && printf '%s' "$OUT" | grep -E '^  面板端口' | grep -q '7777'; then
  ok '--yes 非交互：已安装则升级且保留配置'
else
  bad '--yes 非交互：已安装则升级且保留配置'
fi

# --uninstall --dry-run 不得真的删除
setup_fake
OUT="$(bash install.sh --uninstall --dry-run --dir "$FAKE" 2>&1)"
if [ -f "$FAKE/.env" ] && [ -d "$FAKE/server" ] && printf '%s' "$OUT" | grep -q 'uninstall（卸载）'; then
  ok '--uninstall --dry-run 只打印计划不删除文件'
else
  bad '--uninstall --dry-run 只打印计划不删除文件'
fi

# 演练模式下指定目录不应被创建
CHECK="$ROOT/$WORK/should-not-exist"
rm -rf "$CHECK" 2>/dev/null
bash install.sh --dry-run --mode docker --dir "$CHECK" >/dev/null 2>&1
if [ ! -e "$CHECK" ]; then
  ok '演练模式零副作用（不创建目录）'
else
  bad '演练模式零副作用（不创建目录）'
fi

rm -rf "$WORK" 2>/dev/null || true

printf '─%.0s' {1..60}; printf '\n'
printf '  通过 %d 项，失败 %d 项\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
