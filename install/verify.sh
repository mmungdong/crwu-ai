#!/usr/bin/env bash
# 校验 legacy/ 两份源码：sha256 与 legacy/REV 一致，且语法可解析。
# 客户端半是「函数体」，要用一层 async 函数壳包起来才能 node --check。
set -u
cd "$(dirname "$0")/.." || exit 1

fail=0
expect() {
  local file=$1 want=$2
  local got
  got=$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}')
  if [ -z "$got" ]; then
    echo "MISSING  $file"; fail=1; return
  fi
  if [ "$got" = "$want" ]; then
    echo "OK       $file  $got"
  else
    echo "MISMATCH $file"
    echo "  want $want"
    echo "  got  $got"
    fail=1
  fi
}

want_host=$(awk '$1=="sha256" && $2=="legacy/host.js"   {print $3}' legacy/REV)
want_client=$(awk '$1=="sha256" && $2=="legacy/client.js" {print $3}' legacy/REV)

expect legacy/host.js   "$want_host"
expect legacy/client.js "$want_client"

command -v node >/dev/null 2>&1 || { echo "SKIP     node 不在 PATH，跳过语法检查"; exit $fail; }

# 两份都**不是模块**，而是函数体：host 半是 `return { apply(ctx){...} }`，
# client 半是 `return { inject:[...], apply(ctx){...} }`。
# 直接 `node --check legacy/host.js` 会报 "Illegal return statement" —— 本仓
# package.json 有 "type": "module"，.js 按 ESM 解析时顶层 return 一定非法。
# 所以必须各套一层函数壳再查。（这也是 DSH 动态插件的真实形态。）
#
# macOS 的 mktemp -t 会把模板后缀再拼一层，导致文件不以 .js 结尾、node --check 直接拒收，
# 所以自己拼一个保证以 .js 结尾的临时名。
tmp_h="${TMPDIR:-/tmp}/crwu-host-check.$$.$RANDOM.js"
tmp_c="${TMPDIR:-/tmp}/crwu-client-check.$$.$RANDOM.js"

{ echo "function __h(ctx, harness, console, btoa, atob, TextEncoder, TextDecoder) {"; cat legacy/host.js; echo "}"; } > "$tmp_h"
if node --check "$tmp_h" 2>/dev/null; then
  echo "OK       node --check legacy/host.js（套函数壳）"
else
  echo "SYNTAX   legacy/host.js 解析失败"; node --check "$tmp_h" || true; fail=1
fi

{ echo "async function __c(ctx, React, host, styles, console) {"; cat legacy/client.js; echo "}"; } > "$tmp_c"
if node --check "$tmp_c" 2>/dev/null; then
  echo "OK       node --check legacy/client.js（套 async 函数壳）"
else
  echo "SYNTAX   legacy/client.js 解析失败"; node --check "$tmp_c" || true; fail=1
fi
rm -f "$tmp_h" "$tmp_c"

if grep -qE "harness\.handle\('([^']+)'" legacy/host.js; then
  h=$(grep -oE "harness\.handle\('[^']+'" legacy/host.js | sed "s/.*('//;s/'//" | sort -u | wc -l | tr -d ' ')
  c=$(grep -oE "call\('[^']+'" legacy/client.js | sed "s/.*('//;s/'//" | sort -u | wc -l | tr -d ' ')
  orphan=$(comm -23 <(grep -oE "call\('[^']+'" legacy/client.js | sed "s/.*('//;s/'//" | sort -u) \
                    <(grep -oE "harness\.handle\('[^']+'" legacy/host.js | sed "s/.*('//;s/'//" | sort -u))
  echo "INFO     host handlers=$h  client callers=$c"
  if [ -n "$orphan" ]; then echo "ORPHAN   客户端调用没有对应处理器:"; echo "$orphan"; fail=1; fi
fi

[ "$fail" -eq 0 ] && echo "PASS" || echo "FAIL"
exit $fail
