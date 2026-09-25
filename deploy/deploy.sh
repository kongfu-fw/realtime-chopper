#!/usr/bin/env bash
# ==============================================================================
# realtime-chopper 自动部署脚本
#
# 适用于 Gitea Actions (act_runner) 或手动部署。
# 功能：
#   1. 拉取/使用最新代码重新构建 Docker 镜像
#   2. 平滑启动/重置容器
#   3. 自动健康检查 (/healthz)，超时自动告警并打印日志
#   4. 清理旧的悬空镜像 (dangling images)，防止服务器磁盘被占满
# ==============================================================================

set -euo pipefail

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# 定位项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# 可通过环境变量覆盖的配置
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-realtime-chopper}"
RC_PORT="${RC_PORT:-8080}"
NO_CACHE="${NO_CACHE:-false}"
HEALTHCHECK_TIMEOUT="${HEALTHCHECK_TIMEOUT:-45}" # 秒
HEALTHCHECK_INTERVAL=2

export COMPOSE_PROJECT_NAME
export RC_PORT

log_info "=================================================="
log_info "🚀 开始部署项目:   ${COMPOSE_PROJECT_NAME}"
log_info "📂 项目根目录:     ${PROJECT_ROOT}"
log_info "🔌 目标端口:       127.0.0.1:${RC_PORT}"
log_info "⚡ 禁用构建缓存:   ${NO_CACHE}"
log_info "=================================================="

# 1. 检查 Docker 环境
if ! command -v docker >/dev/null 2>&1; then
  log_error "未找到 docker 命令，请确认当前环境已安装 Docker 并具备运行权限。"
  exit 1
fi

USE_COMPOSE=true
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  log_warn "未找到 docker compose 命令，将降级使用 docker build / docker run 执行部署。"
  USE_COMPOSE=false
fi

BUILD_OPTS=""
if [ "${NO_CACHE}" = "true" ] || [ "${NO_CACHE}" = "1" ]; then
  BUILD_OPTS="--no-cache"
fi

# 2. 构建并启动容器
log_info "🔨 开始构建镜像并启动新容器..."
if [ "${USE_COMPOSE}" = true ]; then
  log_info "使用 Compose 命令: ${COMPOSE_CMD}"
  if [ -n "${BUILD_OPTS}" ]; then
    ${COMPOSE_CMD} -p "${COMPOSE_PROJECT_NAME}" build ${BUILD_OPTS}
  fi
  ${COMPOSE_CMD} -p "${COMPOSE_PROJECT_NAME}" up -d --build --remove-orphans
  CONTAINER_ID=$(${COMPOSE_CMD} -p "${COMPOSE_PROJECT_NAME}" ps -q app 2>/dev/null || true)
else
  IMAGE_NAME="${COMPOSE_PROJECT_NAME}:latest"
  docker build ${BUILD_OPTS} -t "${IMAGE_NAME}" -f Dockerfile .
  if docker ps -a --format '{{.Names}}' | grep -qx "${COMPOSE_PROJECT_NAME}"; then
    log_info "停止并移除旧容器: ${COMPOSE_PROJECT_NAME}..."
    docker stop "${COMPOSE_PROJECT_NAME}" >/dev/null 2>&1 || true
    docker rm "${COMPOSE_PROJECT_NAME}" >/dev/null 2>&1 || true
  fi
  CONTAINER_ID=$(docker run -d \
    --name "${COMPOSE_PROJECT_NAME}" \
    -p "127.0.0.1:${RC_PORT}:80" \
    --restart unless-stopped \
    "${IMAGE_NAME}")
fi

if [ -z "${CONTAINER_ID}" ]; then
  log_error "无法获取容器 ID，部署可能已失败！"
  if [ "${USE_COMPOSE}" = true ]; then
    ${COMPOSE_CMD} -p "${COMPOSE_PROJECT_NAME}" logs --tail 50 || true
  fi
  exit 1
fi

CONTAINER_NAME=$(docker inspect --format='{{.Name}}' "${CONTAINER_ID}" | sed 's/^\///')
log_info "新容器已创建: ${CONTAINER_NAME} (${CONTAINER_ID:0:12})"

# 4. 健康检查轮询
log_info "🩺 正在进行健康检查 (等待容器内部 /healthz 返回 200 ok)..."
ELAPSED=0
HEALTHY=false

while [ "${ELAPSED}" -lt "${HEALTHCHECK_TIMEOUT}" ]; do
  # 通过 docker exec 在容器内调用 wget 测试 /healthz
  # 这种方式不依赖宿主机是否能直接访问 127.0.0.1:RC_PORT，在 Docker 内部或 Runner 里都 100% 可靠
  if docker exec "${CONTAINER_ID}" wget -qO- http://127.0.0.1/healthz 2>/dev/null | grep -q "ok"; then
    HEALTHY=true
    break
  fi

  # 检查容器是否已经意外退出
  STATUS=$(docker inspect --format='{{.State.Status}}' "${CONTAINER_ID}" 2>/dev/null || echo "unknown")
  if [ "${STATUS}" = "exited" ] || [ "${STATUS}" = "dead" ]; then
    log_error "容器异常退出，状态为: ${STATUS}"
    break
  fi

  sleep "${HEALTHCHECK_INTERVAL}"
  ELAPSED=$((ELAPSED + HEALTHCHECK_INTERVAL))
  echo -n "."
done
echo ""

if [ "${HEALTHY}" = true ]; then
  log_success "🎉 容器健康检查通过！服务已成功就绪 (耗时约 ${ELAPSED} 秒)"
else
  log_error "❌ 健康检查超时（超过 ${HEALTHCHECK_TIMEOUT} 秒）或容器未能正常运行！"
  log_error "📜 容器最近 50 行日志如下："
  docker logs --tail 50 "${CONTAINER_ID}" || true
  exit 1
fi

# 5. 清理悬空镜像 (dangling images)，防止频繁构建导致磁盘爆满
log_info "🧹 清理旧的无标签构建缓存镜像 (docker image prune)..."
docker image prune -f >/dev/null 2>&1 || true

log_success "=================================================="
log_success "✅ 部署完成！"
log_success "🌐 访问地址: http://127.0.0.1:${RC_PORT}/"
log_success "=================================================="
