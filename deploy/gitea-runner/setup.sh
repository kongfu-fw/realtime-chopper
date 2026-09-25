#!/usr/bin/env bash
# ==============================================================================
# Gitea Runner (act_runner) 一键初始化与启动脚本
# ==============================================================================

set -euo pipefail

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${RUNNER_DIR}"

echo "=========================================="
echo "🤖 Gitea Runner 部署与注册向导"
echo "=========================================="

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
  else
    touch .env
  fi
fi

# 检查环境变量
source .env 2>/dev/null || true

URL="${GITEA_INSTANCE_URL:-http://kongfu-onedrive.kooka-salmon.ts.net:23000}"
TOKEN="${GITEA_RUNNER_REGISTRATION_TOKEN:-}"

if [ -z "${TOKEN}" ] || [ "${TOKEN}" = "your_registration_token_here" ]; then
  echo ""
  echo "请输入 Gitea 实例地址 (默认: ${URL}):"
  read -r input_url
  if [ -n "${input_url}" ]; then
    URL="${input_url}"
  fi

  echo ""
  echo "请输入 Gitea Runner Registration Token:"
  echo "(可在 Gitea 仓库/组织设置 -> Actions -> Runners -> 'Create Runner' 页面找到)"
  read -r input_token
  TOKEN="${input_token}"

  if [ -z "${TOKEN}" ]; then
    echo "❌ 错误: Registration Token 不能为空！"
    exit 1
  fi

  cat > .env <<EOF
GITEA_INSTANCE_URL=${URL}
GITEA_RUNNER_REGISTRATION_TOKEN=${TOKEN}
GITEA_RUNNER_NAME=realtime-chopper-runner
EOF
fi

mkdir -p ./data

echo ""
echo "🚀 正在启动 Gitea Runner 容器..."
if docker compose version >/dev/null 2>&1; then
  docker compose up -d
else
  docker-compose up -d
fi

echo ""
echo "⏳ 等待 Runner 启动并向 Gitea 注册..."
sleep 3

echo ""
echo "📜 Runner 容器最新日志："
docker logs --tail 20 gitea-runner || true

echo ""
echo "=========================================="
echo "✅ Runner 启动成功！"
echo "现在回到 Gitea 仓库设置 -> Actions -> Runners 刷新页面，即可看到该 Runner 处于激活状态。"
echo "之后向 dev 分支 push 代码即可自动触发部署。"
echo "=========================================="
