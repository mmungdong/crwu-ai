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

if node --check legacy/host.js 2>/dev/null; then
  echo "OK       node --check legacy/host.js"
else
  echo "SYNTAX   legacy/host.js 解析失败"; node --check legacy/host.js || true; fail=1
fi

# macOS 的 mktemp -t 会把模板后缀再拼一层，导致文件不以 .js 结尾、node --check 直接拒收，
# 所以自己拼一个保证以 .js 结尾的临时名。
tmp="${TMPDIR:-/tmp}/crwu-client-check.$$.$RANDOM.js"
{ echo "async function __c(ctx,React,host,styles,console){"; cat legacy/client.js; echo "}"; } > "$tmp"
if node --check "$tmp" 2>/dev/null; then
  echo "OK       node --check legacy/client.js（套 async 壳）"
else
  echo "SYNTAX   legacy/client.js 解析失败"; node --check "$tmp" || true; fail=1
fi
rm -f "$tmp"

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
