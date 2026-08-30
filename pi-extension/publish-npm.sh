#!/usr/bin/env bash
set -Eeuo pipefail

registry="https://registry.npmjs.org/"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_npmrc=""
otp=""

cleanup() {
  unset otp NPM_TOKEN
  if [[ -n "$temp_npmrc" ]]; then
    rm -f "$temp_npmrc"
  fi
}

trap cleanup EXIT

fail() {
  printf '发布中止：%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "找不到命令：$1"
}

cd "$script_dir"
require_command node
require_command npm
require_command pnpm

if [[ -n "${NPM_TOKEN:-}" ]]; then
  temp_npmrc="$(mktemp "${TMPDIR:-/tmp}/remote-pi-npmrc.XXXXXX")"
  chmod 600 "$temp_npmrc"
  printf '%s\n' \
    "registry=$registry" \
    "@yefengr:registry=$registry" \
    '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' \
    >"$temp_npmrc"
  export NPM_CONFIG_USERCONFIG="$temp_npmrc"
  printf '使用 NPM_TOKEN 临时认证；凭据不会写入仓库或命令参数。\n'
fi

package_name="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync("package.json", "utf8")).name)')"
package_version="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync("package.json", "utf8")).version)')"

[[ "$package_name" == "@yefengr/remote-pi" ]] || fail "package.json 的 name 不是 @yefengr/remote-pi：$package_name"
[[ "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "版本必须是精确的 X.Y.Z：$package_version"

if ! npm whoami --registry="$registry" >/dev/null 2>&1; then
  fail "当前 npm 会话未认证；先执行 npm login --registry=$registry"
fi

set +e
version_output="$(npm view "$package_name@$package_version" version --registry="$registry" 2>&1)"
version_status=$?
set -e

if (( version_status == 0 )); then
  fail "$package_name@$package_version 已存在，不能重复发布"
fi

case "$version_output" in
  *E404*|*404*|*"No match found"*) ;;
  *)
    printf '%s\n' "$version_output" >&2
    fail "无法确认版本是否已存在，请检查 npm registry 和网络"
    ;;
esac

printf '准备发布 %s@%s\n' "$package_name" "$package_version"
printf '清理旧 dist/ 编译产物...\n'
rm -rf dist

printf '运行 pnpm verify...\n'
pnpm verify

printf '检查 npm tarball 内容...\n'
set +e
pack_output="$(pnpm pack --dry-run 2>&1)"
pack_status=$?
set -e
printf '%s\n' "$pack_output"
(( pack_status == 0 )) || fail "pnpm pack --dry-run 失败"

if [[ "$pack_output" =~ dist/.*(mesh|rooms|broker|pi_forward|peer_inventory|leader_election) ]]; then
  fail "npm tarball 中仍包含旧 Mesh/跨 Pi 编译产物，请检查 dist/"
fi

# pnpm publish may return a spurious E404 for granular bypass-2FA tokens.
# Verification and packing stay on pnpm; npm CLI performs only the final upload.
publish_args=(publish --access public --ignore-scripts)

if [[ -n "${NPM_TOKEN:-}" ]]; then
  npm "${publish_args[@]}"
else
  printf '请输入 npm 2FA 验证码（OTP）；使用授权链接/扫码请直接回车：'
  IFS= read -r -s otp || true
  printf '\n'
  if [[ -n "$otp" ]]; then
    publish_args+=(--otp="$otp")
  fi
  npm "${publish_args[@]}"
fi

unset otp

published_version="$(npm view "$package_name@$package_version" version --registry="$registry" 2>/dev/null || true)"
[[ "$published_version" == "$package_version" ]] || fail "发布后无法确认 npm 版本：$package_name@$package_version"

printf '发布成功：%s@%s\n' "$package_name" "$package_version"
