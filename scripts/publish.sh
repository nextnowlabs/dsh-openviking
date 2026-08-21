#!/usr/bin/env bash
#
# publish.sh — 将 @nextnowlabs/dsh-openviking 发布到 npmjs 官方 registry。
#
# 用法：
#   ./scripts/publish.sh [选项]
#
# 选项：
#   -n, --dry-run           仅构建并预览将要发布的 tarball 内容，不真正发布
#   -t, --tag <name>        npm dist-tag（默认：预发布版本→beta，正式版本→latest）
#   -o, --otp <code>        一次性密码（二步验证）；也支持 NPM_OTP 环境变量
#   -r, --registry <url>    npm registry（默认 https://registry.npmjs.org/）
#   -b, --bump <level>      先升级版本：patch|minor|major|prepatch|preminor|premajor|prerelease
#   --skip-checks           跳过分支/工作区脏检查（供 CI 使用）
#   --force                 允许发布已存在的版本号（覆盖"已发布"检查）
#   --no-git-tag            发布成功后不创建 git tag
#   --push                  发布成功后推送 main 分支与 tag 到 origin
#   -h, --help              显示帮助
#
# 说明：
#   * 本仓库用户级 ~/.npmrc 默认指向 npmmirror 镜像，本脚本显式使用官方
#     registry，避免把包发到镜像。
#   * 发布前会先执行 npm run build（prepack 钩子也会构建一次）。
#   * 首次发布需要先登录：npm login --registry https://registry.npmjs.org/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NPMJS_REGISTRY="https://registry.npmjs.org/"
ACCESS="public"          # scoped 包默认公开
TAG=""                   # 空则按版本自动推导
OTP="${NPM_OTP:-}"
REGISTRY="$NPMJS_REGISTRY"
BUMP=""
DRY_RUN=0
SKIP_CHECKS=0
FORCE=0
GIT_TAG=1
PUSH=0

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

die() {
  echo "错误：$*" >&2
  exit 1
}

# `publish` 是 npm 的生命周期脚本名：`npm publish` 上传 tarball 完成后会再次
# 执行名为 publish 的脚本。若本脚本被 npm 以该生命周期形式调用，说明发生了
# 递归重入（0.2.3 事故：包已发布成功，嵌套的 publish.sh 却报“版本已存在”并
# 让整个 npm publish 以失败退出）。请使用 `npm run release` 发布。
if [[ "${npm_lifecycle_event:-}" == "publish" ]]; then
  die "scripts/publish.sh 被 npm 的 publish 生命周期钩子重入；请改用 npm run release"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    -t|--tag) TAG="${2:?--tag 需要参数}"; shift ;;
    -o|--otp) OTP="$2"; shift ;;
    -r|--registry) REGISTRY="$2"; shift ;;
    -b|--bump) BUMP="$2"; shift ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    --force) FORCE=1 ;;
    --no-git-tag) GIT_TAG=0 ;;
    --push) PUSH=1 ;;
    -h|--help) usage ;;
    *) die "未知参数：$1（使用 --help 查看用法）" ;;
  esac
  shift
done

PKG_NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"

# npm 写 tarball 需要可写缓存目录；默认用仓库本地 .npm-cache（已 gitignore），
# 避免 ~/.npm 只读（如沙箱/CI）时 pack/publish 报 EROFS。
CACHE_DIR="${NPM_CONFIG_CACHE:-$REPO_ROOT/.npm-cache}"
mkdir -p "$CACHE_DIR"

# 未显式指定 dist-tag 时，按版本号推导：预发布 → beta，正式 → latest
if [[ -z "$TAG" ]]; then
  if [[ "$VERSION" == *-* ]]; then TAG="beta"; else TAG="latest"; fi
fi

echo "==> 包：$PKG_NAME@$VERSION  →  $REGISTRY  (tag: $TAG)"

# ---------- 1. 环境预检 ----------
command -v npm >/dev/null 2>&1 || die "未找到 npm"

if [[ "$SKIP_CHECKS" -ne 1 ]]; then
  BRANCH="$(git branch --show-current)"
  [[ "$BRANCH" == "main" ]] || die "当前分支为 '$BRANCH'，发布应在 main 分支上（或使用 --skip-checks）"
  if [[ -n "$(git status --porcelain)" ]]; then
    die "工作区有未提交改动，请先提交或使用 --skip-checks"
  fi
fi

# ---------- 2. 登录校验（dry-run 不需要） ----------
if [[ "$DRY_RUN" -ne 1 ]]; then
  if ! npm whoami --registry "$REGISTRY" >/dev/null 2>&1; then
    die "未登录 $REGISTRY，请先执行：npm login --registry $REGISTRY"
  fi
fi

# ---------- 3. 可选：升级版本 ----------
if [[ -n "$BUMP" ]]; then
  echo "==> 升级版本（$BUMP）"
  npm version "$BUMP" --no-git-tag-version --registry "$REGISTRY"
  VERSION="$(node -p "require('./package.json').version")"
  echo "==> 新版本：$VERSION"
fi

# ---------- 4. 版本号是否已发布 ----------
if [[ "$FORCE" -ne 1 && "$DRY_RUN" -ne 1 ]]; then
  if npm view "$PKG_NAME@$VERSION" version --registry "$REGISTRY" >/dev/null 2>&1; then
    die "$PKG_NAME@$VERSION 已存在于 $REGISTRY（用 --force 强制覆盖，或 --bump 升级版本）"
  fi
fi

# ---------- 5. 构建 ----------
echo "==> 构建 lib/（tsc + client bundle）"
npm run build

# ---------- 6. dry-run：预览发布内容 ----------
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> [dry-run] 预览将被打包的文件（不发布）："
  npm pack --dry-run --registry "$REGISTRY" --cache "$CACHE_DIR"
  echo
  echo "==> [dry-run] 完成。未执行任何发布或 git 操作。"
  exit 0
fi

# ---------- 7. 发布 ----------
ARGS=(--registry "$REGISTRY" --access "$ACCESS" --tag "$TAG" --cache "$CACHE_DIR")
if [[ -n "$OTP" ]]; then
  ARGS+=(--otp "$OTP")
fi
echo "==> npm publish ${ARGS[*]}"
npm publish "${ARGS[@]}"
echo "==> 已发布：$PKG_NAME@$VERSION (tag: $TAG)"

# ---------- 8. 发布成功后的 git tag / push ----------
if [[ "$GIT_TAG" -eq 1 ]]; then
  echo "==> 创建 git tag v$VERSION"
  git tag -a "v$VERSION" -m "release $VERSION"
  if [[ "$PUSH" -eq 1 ]]; then
    echo "==> git push origin main v$VERSION"
    git push origin main
    git push origin "v$VERSION"
  else
    echo "    （未推送；如需推送请加 --push）"
  fi
fi

echo "==> 完成 ✅"
