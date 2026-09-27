# 用 Docker Compose 部署

这个容器只做一件事：**把构建好的网页发出去**。

录音、语音识别、翻译、朗读全部在浏览器里跑，服务器上没有后端、没有数据库、没有密钥。
所以整套部署就是"一个 nginx + 一个静态目录"，CPU 和内存占用可以忽略。

---

## 30 秒开始

```bash
docker compose up -d --build
```

然后打开 <http://127.0.0.1:8080/>（本机）；同一局域网 / 同一个 Tailscale 网段的其它机器，
用这台机器的 IP 加 8080 端口也能打开，比如 <http://192.168.50.145:8080/>。

第一次打开会让你装一个识别模块（英文、韩语各约 62 MB，中文约 240 MB）。
模块从网上直接下到**浏览器**里，只下一次，跟容器无关。

需要联网的只有两件事：构建时拉取 npm 依赖，以及你的浏览器下载识别模块。

---

## 监听地址与安全上下文

默认监听 `0.0.0.0:8080`，也就是**所有网卡**：本机（`127.0.0.1`）、局域网 IP、Tailscale IP
都能连上。想改只让本机访问，写 `RC_BIND=127.0.0.1`（等于回到以前的行为）。

但**能打开页面不等于能用麦克风**。浏览器只在**安全上下文**里给麦克风，而安全上下文只有两种：

- `https://` 开头的地址；
- `http://localhost` / `http://127.0.0.1`（浏览器把这几个当成本机，特批）。

| 打开方式 | 地址 | 能不能录音 |
| --- | --- | --- |
| 本机浏览器 | `http://127.0.0.1:8080` | ✅ 可以 |
| 局域网 IP / Tailscale IP | `http://192.168.50.145:8080` | ❌ 界面正常，点录音会提示"这个浏览器不能录音" |
| 域名 + HTTPS | `https://speak.example.com` | ✅ 可以 |

所以：把监听放开是为了**在别的机器上能访问、能看界面、能验证服务活着**；
真正要在别的机器（尤其手机）上录音，还是得走下面两条 HTTPS 路子之一。

---

## 在手机上用

### 方案一：Tailscale（推荐，不用域名、不用开端口）

```bash
tailscale serve --bg 8080
```

它会给你一个 `https://<机器名>.<你的 tailnet>.ts.net` 地址，证书是自动签的。
手机装上 Tailscale 登同一个账号，用 Safari 打开这个地址 → **分享 → 添加到主屏幕**，
就是一个独立图标的应用（项目里有 PWA manifest）。麦克风在 HTTPS 下正常可用。

（不要去用 `http://100.x.y.z:8080` 那个 Tailscale IP：监听虽然通了，但它是 http，
手机拿到页面也用不了麦克风。域名 + HTTPS 才是关键。）

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
| 只让本机访问 | `RC_BIND=127.0.0.1 docker compose up -d`（默认是 `0.0.0.0`） |
| 改界面文案 / 功能 | 改源码 → `docker compose up -d --build` |
| 改缓存、MIME 等规则 | 改 `deploy/nginx.conf` → 重新构建（配置是打进镜像的，不是挂载的） |
| 不开容器，直接开发 | `npm install && npm run dev`（开发服务器在 5273，不做构建） |

### 文件都是干什么的

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 两阶段：node 里 `npm ci` + `npm run build`，再把它交给 nginx |
| `.dockerignore` | 别把 `node_modules`、`dist`、`.env` 塞进构建上下文 |
| `docker-compose.yml` | 默认部署：监听 `0.0.0.0:8080`，可用 `RC_BIND` / `RC_PORT` 改 |
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
| 只想让本机访问 | `RC_BIND=127.0.0.1 docker compose up -d`（默认是 `0.0.0.0`，局域网/Tailscale 都能连） |
| 局域网能打开、但点了录音提示不能录 | 正常现象：非 https、非 localhost 不是安全上下文，见上面那一节 |
| 白屏 / 404 | 如果部署在子路径下，地址要带结尾斜杠（`/app/` 而不是 `/app`）——应用用的是相对路径。默认部署在根路径，不会有这个问题 |

---

## 跨源隔离（已开启并实测）

`Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`
**现在是默认开的**：`deploy/nginx.conf` 的 server 块里各一行，`vite.config.ts` 里是一个
把两个头盖到每一个响应上的中间件（dev 和 preview 都装，只配部署的写法等于本地测不了）。
开了以后 `crossOriginIsolated` 为真、`SharedArrayBuffer` 才存在，onnxruntime 的线程版
wasm 才能起来。

顺带一个其实早就存在的事实：构建产物里**从来只有线程版那一个 wasm**
（`ort-wasm-simd-threaded.asyncify-*.wasm`，26.9 MB，dist 里就这一个）。所以缺的从来不是
产物，而是那两个头 —— 没有头的时候同一个二进制自己降回单线程跑，一切看起来都正常。

**实测收益**（Mac mini，10 核；同一段 7.43 秒英文音频；同一个 q8 Moonshine；同一份代码，
唯一变量就是这两个头）。单线程是把构建好的 `crossOriginIsolated` 读成 false 量出来的：

| | 首次 | 稳态 | 对应 RTF |
|---|---|---|---|
| 单线程 | 607 ms | 521 / 526 ms | 0.071 |
| COI 开启（`min(4, 核数)` = 4 线程） | 429 ms | 280 / 291 / 291 ms | 0.039 |

约 **1.8 倍**，而且两次的转写文本逐字相同 —— 多线程没有改变结果，只改变了用时。

### 为什么可以开：跨源依赖逐条实测过

`require-corp` 会拦掉**不满足 COEP 的跨源响应**，所以风险全在"我们还要跨源拿什么"。
本应用的答案：全部是 CORS 模式的 `fetch`，一个 `no-cors` 都不需要。在隔离的页面里实发：

| 请求 | 隔离后 |
|---|---|
| `edge.microsoft.com/translate/translatetext`（无密钥默认链路） | 200，正常返回译文 |
| `translate-pa.googleapis.com/v1/translateHtml`（无密钥默认链路） | 200 `[["你好世界。"]]` |
| `api.openai.com/v1/models`（LLM 转发，故意用假 key） | 401 —— 请求到达了服务器，说明没被 COEP 挡 |
| `huggingface.co/...`（模型） | 200 |
| 对照：同样两个跨源 URL 用 `mode: 'no-cors'` | **TypeError: Failed to fetch** |

最后一行就是那条代价：**以后再加第三方图片、字体、CDN `<script>` 这类隐式 `no-cors` 资源会
直接加载不出来**，而症状是"本地好好的、上线就白"。加之前先看有没有 `Cross-Origin-Resource-Policy`。

### 三个踩过的坑

1. **304 会把头弄丢，而丢掉的那个头修不好。** 这是整件事里最贵的一个坑，值得写清楚。

   浏览器对已缓存的响应走条件请求，服务端回 `304 Not Modified`。**如果 304 里没有这两个头，
   浏览器会继续沿用那份"没有头"的存储副本** —— 也就是说，一个在加头之前缓存过的条目，
   之后无论重新加载多少次都拿不到隔离，`crossOriginIsolated` 永远是 false（线程数永远是 1）。
   在它之上还长出了第二个故障：Chrome **拒绝启动**响应头不满足 COEP 的同源 classic worker，

   ```
   GET /sherpa-asr.worker.js → net::ERR_BLOCKED_BY_RESPONSE
   [session] asr 崩溃了
   ```

   结果是**跑在那个运行时上的模块全废（当时的英文 Parakeet 和中文 SenseVoice），而 Moonshine
   好好的** —— 因为只有 Moonshine 的 worker 是构建产物、URL 带查询串，永远撞不上那个旧缓存
   条目。整个现象看起来像 sherpa 的问题，其实一个都不是。

   两边现在的行为（都是实测的，不是推的）：

   | | 200 | 304 |
   |---|---|---|
   | nginx `add_header … always` | 带头 | **带头**（`always` 就是管这个的） |
   | `vite.config.ts` 的插件（比静态中间件更靠前） | 带头 | **带头** |
   | ~~`server.headers`~~（以前的写法） | 带头 | **一个头都不带** |

   所以：**生产一直是对的，dev 是坏的**，而 dev 坏的样子恰好是"换个模型就好了"的错觉。
   现在两种写法都被 `src/cross-origin-isolation.test.ts` 钉住了：它启一个真的 dev server，
   对每个响应先请求一次、再带 `If-None-Match` 请求一次，两次都要带头。

   如果你手上是一个**更早的**浏览器会话撞上的旧毛病（这个仓库第一次开这个功能之前的缓存），
   硬刷新一次仍然是最快的解法 —— 但代码已经不需要你手动救了。
2. **`static/sw.js` 的 `activate` 原来会删掉"所有"非当前外壳缓存** —— 包括识别引擎自己的
   `rc-model-*` 桶和 transformers.js 的 `transformers-cache`。外壳版本一升，已装的 240MB 中文和
   英文模块就全被清掉重下。现在只清理 `rc-shell-*` 前缀，外壳版本推到 `rc-shell-v2`。
3. **同一份 worker 在两次部署之间换了内容，但 URL 没换。** 第 1 条里救下 Moonshine 的正是
   "URL 带查询串"这件事（它的 worker 是构建产物），而 `sherpa-asr.worker.js` 是 `static/` 里的
   固定文件名 —— 于是它成了唯一能被旧缓存顶掉、却不会报错的脚本。实测到的样子：页面已经是新版
   （日志里 `Version: 20260926.4`，`index.html` 与 assets 都是新的），但 worker 还是第一个版本的
   —— 英文界面里那句中文报错就是证据（第一个版本的 worker 根本没有 `setLang`，`PACKS` 里只有
   `zh`），于是「安装韩语模块」当场失败：`这个版本不认识识别模块 ko`。
   该路径上的 `Cache-Control: no-cache` **一直就在**（上面那张 location 表里的第一版就有），
   说明这件事不能靠缓存头解决。现在这个 URL 上也带了内容戳（`?v=<内容哈希>`，见
   `vite.config.ts` 的 `SHERPA_WORKER_REV`）：内容变了 URL 就变，上一次的缓存条目再也撞不上；
   内容没变 URL 就不变，缓存照旧命中。`location = /sherpa-asr.worker.js { expires -1; }` 留着，
   它管的是"旧页面请求旧 URL"这种正常情况。

### 只对 Moonshine 有效

**sherpa WASM 那份运行时是彻底单线程的**，开不开隔离都一样：它的胶水里
`PThread` / `pthread_create` / `SharedArrayBuffer` / `Atomics` 出现次数全是 0
（`sherpa-onnx-asr.js` 和 `sherpa-onnx-wasm-main-vad.js` 都查了），wasm 里只有一处弱桩
`pthread_create`。这是没带 `-pthread` 编出来的产物，不是可以调参打开的开关。
所以 **中文（SenseVoice）在任何设备上都是单线程**，从前的英文 Parakeet 也一样；要它多线程只能
自己用 emscripten 从 sherpa-onnx 源码重编一份，那是另一个工程。这也是英文模块只用
transformers.js 那条路（真能吃到多线程）的原因之一。

### 回滚

删掉 `deploy/nginx.conf` 和 `vite.config.ts` 里的这两行重新构建。删除后 `crossOriginIsolated`
回到 false，Moonshine 自动降到 1 线程（`moonshine.ts` 里是按这个判断的），其余功能不受影响。
