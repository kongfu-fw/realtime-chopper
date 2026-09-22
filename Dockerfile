# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 1) 构建：把 Svelte + Vite 源码编译成纯静态文件（dist/）
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# 先只装依赖。源码改动时这一层还能命中缓存，不必每次重下 node_modules。
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# 2) 运行：nginx 只负责把 dist/ 发出去
#
# 这个应用没有后端：录音、语音识别、翻译、朗读全部在浏览器里跑，
# 所以这一层里没有 node、没有进程管理、没有数据卷，也不需要任何环境变量。
# 细节见 DOCKER.md。
# ---------------------------------------------------------------------------
FROM nginx:alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/

EXPOSE 80
