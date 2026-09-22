# 用 Docker Compose 部署

这个容器只做一件事：**把构建好的网页发出去**。

录音、语音识别、翻译、朗读全部在浏览器里跑，服务器上没有后端、没有数据库、没有密钥。
所以整套部署就是"一个 nginx + 一个静态目录"，CPU 和内存占用可以忽略。

---

## 30 秒开始

```bash
docker compose up -d --build
```

然后打开 <http://127.0.0.1:8080/>。

第一次打开会让你装一个识别模块（英文、韩语各约 62 MB，中文约 240 MB）。
模块从网上直接下到**浏览器**里，只下一次，跟容器无关。

需要联网的只有两件事：构建时拉取 npm 依赖，以及你的浏览器下载识别模块。

---

## 为什么默认只监听 127.0.0.1

浏览器只在**安全上下文**里给麦克风，而安全上下文只有两种：

- `https://` 开头的地址；
- `http://localhost` / `http://127.0.0.1`（浏览器把这几个当成本机，特批）。

| 打开方式 | 地址 | 能不能录音 |
| --- | --- | --- |
| 本机浏览器 | `http://127.0.0.1:8080` | ✅ 可以 |
| 局域网 IP | `http://192.168.1.5:8080` | ❌ 界面正常，点录音会提示"这个浏览器不能录音" |
| 域名 + HTTPS | `https://speak.example.com` | ✅ 可以 |

所以默认只绑本机，不会把服务暴露到局域网里；想在手机上用，走下面两条路之一。

---

## 在手机上用

### 方案一：Tailscale（推荐，不用域名、不用开端口）

```bash
tailscale serve --bg 8080
```

它会给你一个 `https://<机器名>.<你的 tailnet>.ts.net` 地址，证书是自动签的。
手机装上 Tailscale 登同一个账号，用 Safari 打开这个地址 → **分享 → 添加到主屏幕**，
就是一个独立图标的应用（项目里有 PWA manifest）。麦克风在 HTTPS 下正常可用。

`tailscale serve status` 看现状，`tailscale serve --https=443 off` 关掉。

### 方案二：自己的域名 + Caddy（配置已经写好）

```bash
echo 'RC_DOMAIN=speak.example.com' > .env
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

前提：域名解析到这台机器，80 / 443 对外可达（Let's Encrypt 用 80 做校验）。
证书由 Caddy 自动申请和续期，放在 `caddy-data` 卷里。

如果你机器上本来就跑着反向代理（Nginx Proxy Manager、群晖、宝塔等），
那就什么都不用加 —— 让它代理到 `127.0.0.1:8080` 就行。

---

## 常用命令

```bash
docker compose up -d --build        # 构建并启动（改了代码就要重新构建）
docker compose ps                   # 看状态，healthy 才算真的起来了
docker compose logs -f app          # 看访问日志
docker compose down                 # 停止并删除容器（镜像留着）
RC_PORT=9000 docker compose up -d   # 换个对外端口
docker compose build --no-cache     # 依赖变了、缓存可疑时重建
```

| 我想要 | 怎么做 |
| --- | --- |
| 换端口 | `RC_PORT=9000 docker compose up -d`，或把 `RC_PORT=9000` 写进 `.env` |
| 改界面文案 / 功能 | 改源码 → `docker compose up -d --build` |
| 改缓存、MIME 等规则 | 改 `deploy/nginx.conf` → 重新构建（配置是打进镜像的，不是挂载的） |
| 不开容器，直接开发 | `npm install && npm run dev`（开发服务器在 5273，不做构建） |

### 文件都是干什么的

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 两阶段：node 里 `npm ci` + `npm run build`，再把它交给 nginx |
| `.dockerignore` | 别把 `node_modules`、`dist`、`.env` 塞进构建上下文 |
| `docker-compose.yml` | 默认部署：只监听 `127.0.0.1:8080` |
| `docker-compose.tls.yml` | 可选覆盖：加一层 Caddy 做 HTTPS |
| `deploy/nginx.conf` | 缓存策略、`.wasm` 类型、健康检查 |
| `deploy/Caddyfile` | Caddy 只要 4 行：拿证书 + 转发 |
| `DOCKER.md` | 就是这份文档 |

---

## 镜像里有什么

1. **构建阶段** `node:24-alpine` —— 装依赖、跑 `vite build`，产出 `dist/`。
2. **运行阶段** `nginx:alpine` —— 只有两样东西：`deploy/nginx.conf` 和 `dist/`。

没有 node、没有数据库、没有数据卷、没有任何环境变量（除了端口和域名）。
镜像是只读的：重启、重建、换机器都不影响用户手里的数据。

---

## 数据存在哪

容器是**无状态**的，用户数据一样都不在容器里：

| 数据 | 存在哪 |
| --- | --- |
| 已下载的识别模块（62–240 MB） | 浏览器的 Cache Storage，不在容器里 |
| 整场录音（WAV） | 浏览器的 OPFS |
| 设置、识别结果、日志 | 浏览器的 localStorage |

两个直接后果：

- `docker compose down`、删镜像、换机器都**不会丢任何东西**；只有清浏览器站点数据才会。
- 换个地址打开（`localhost:8080` → `https://speak.example.com`）会被当成**第一次使用**：
  模块要重下、设置和录音都看不到，因为浏览器按"来源"隔离存储。

---

## 浏览器需要能访问的域名

容器自己不需要出网，需要联网的是**你的浏览器**：

| 域名 | 什么时候用 |
| --- | --- |
| `huggingface.co` | 下载识别模块和 wasm 运行库（必需） |
| `translate-pa.googleapis.com` | 谷歌翻译（默认） |
| `edge.microsoft.com` | 微软翻译（谷歌不可用时的自动备选） |
| `api.openai.com` / `generativelanguage.googleapis.com` / `api.anthropic.com` | 只有把翻译来源改成"AI 模型"时才用（默认地址，可自己改） |

公司网络、内网、或挂了广告拦截的浏览器，把 `huggingface.co` 拦掉的话，
表现就是"安装弹窗一直下载失败"。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 点录音提示"这个浏览器不能录音" | 用非 https、非 localhost 的地址打开了，见上面那一节 |
| 打开了但没声音、没反应 | 先看 `docker compose ps` 是不是 `healthy`；再点应用里的"日志"抽屉，那里有每一步的结果 |
| 界面还是旧版本 | `docker compose up -d --build` 之后强刷一次（Ctrl+Shift+R）。`index.html` 和 `sw.js` 已经设成 `no-cache`，但 Service Worker 会缓存外壳；实在不行清一下站点数据 |
| 安装模块一直失败 | 看浏览器控制台和日志抽屉；多半是 `huggingface.co` 被拦或被代理挡住 |
| `npm ci` 构建失败 | 构建阶段要访问 npm registry；公司代理环境需要给 Docker 配 HTTP 代理 |
| 想让局域网直接访问 | 把 `ports` 改成 `"0.0.0.0:8080:80"`。但记得同时上 HTTPS，否则手机拿到页面也用不了麦克风 |
| 白屏 / 404 | 如果部署在子路径下，地址要带结尾斜杠（`/app/` 而不是 `/app`）——应用用的是相对路径。默认部署在根路径，不会有这个问题 |

---

## 可选：跨源隔离（未验证）

默认**没有**开 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`。
开了以后 `crossOriginIsolated` 为真，onnxruntime 那个线程版 wasm
（`ort-wasm-simd-threaded-*.wasm`，26 MB 那个）才能用多线程，识别会更快。

代价是所有跨源资源都要带 CORS/CORP 头，而识别模块正好来自 `huggingface.co`。
这一点在这个环境里没有实际验证过，所以默认不开。想试的话，在 `deploy/nginx.conf`
的 server 块里加上这两行（各 location 都只用 `expires`，所以会被正常继承）：

```nginx
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Cross-Origin-Embedder-Policy require-corp always;
```

如果加了以后"安装模块"开始失败，就是这条路不通，删掉这两行重新构建即可。
