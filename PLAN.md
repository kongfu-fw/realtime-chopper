# 实时语音翻译 Web App（realtime-chopper）实施计划 v2

> 依据：`realtime-chopper.md`（20 条需求）
> **原需求冲突处，以本文件为准**（逐条列在 §1）。
> v2 相对 v1 的核心变化：**翻译改为纯前端多提供方适配器，自建代理整个删除，应用退回无后端纯静态 PWA**（依据实测，见 §4.3）。

---

## 1. 需求挑战 → 决议对照表

| 需求 | 原文要求 | 技术冲突 | 决议 |
|---|---|---|---|
| 1 | 实时语音 web 单页应用 | — | 纯静态 SPA（Svelte 5 + TS + Vite），**无后端** |
| 2 | SenseVoice-small int8 识别 | SenseVoice **非流式**；单语模型需路由 | 按源语言路由：**en=Moonshine Base**（transformers.js，WebGPU→WASM）、**zh/ko=SenseVoice-small int8**（sherpa-onnx WASM）。**韩语不再用专门的 Moonshine Base-KO**：它读韩语明显更差，而 SenseVoice 本身多语（zh/en/ja/ko/yue），韩语搭中文这一个模块即可 —— 一份下载、一条缓存、一个常驻模型，zh ↔ ko 切换连重载都不需要。"实时"= **逐句准实时**（0.7~1.5s / 手机兜底 ~2s），不做词级流式 |
| 3 | Google 翻译每句话 | 无 key 的旧端点不支持批量 | **多提供方适配器**：主用 Google `translateHtml`（原生批量），兜底微软（免 key、原生批量），可选 **BYOK LLM**。**不需要后端**，见 §4.3 |
| 4 | edge TTS 朗读 | 微软要求 `Sec-MS-GEC`，**浏览器 WebSocket 无法设置握手头**（扩展可以，网页不行） | **浏览器 `speechSynthesis`**：删掉 TTS 中转与 DRM 维护风险，语速成为一等公民属性（需求 6 因此变简单） |
| 5 | 四个模块用队列保序 | 文档只列了 3 个可对应模块 | 四级队列：**采集/VAD → ASR → 翻译 → TTS/播放** |
| 6 | 按待 TTS 队列长度自动调速 | 未定义范围与拥塞策略；瓶颈可能在翻译而非 TTS | rate 1.0→1.8 线性映射；**只加速不丢弃** + 滞后秒数 + 超阈值才出现的"跳到最新"按钮 |
| 7 | 样式参考 Basecamp | 未指明版本/明暗模式 | 暖白底 + 近黑蓝字 + 芥末黄强调 + 粗描边圆角按钮 |
| 10 | 设置页，"说人话"+ 气泡说明 | 未列参数清单 | §7 给出参数的人话命名与气泡文案 |
| 11 | 首次访问弹窗"安装语音识别模块" | 可选模块只剩两个（约 62MB + 240MB） | **按当前源语言按需下载**，显示体积/进度/断点续传/`storage.persist()`；弹窗只列两个模块（英文 / 中文和韩语）。**进度到 100% 后仍有几秒到几十秒的引擎启动时间**（建 ONNX 会话 / 解包运行时，期间没有任何数字），这一阶段弹窗显示转圈 + 进度条呼吸动画 +「正在启动识别引擎，第一次会慢一些」，下载中则显示「正在下载，别关掉这个窗口」 |
| 12 | 调试模式：语音和文字在页面上匹配 | "匹配"含义不明；SenseVoice 导出未必有词级时间戳 | §6.5（逐句 raw 文本 + 标签 + 分段起止 + 推理耗时 + 强制显示音频），**不依赖词级时间戳** |
| 13 | 尽可能高音质拾取 | 关 AEC 会形成 TTS→麦克风回声自翻译 | 关 AEC/NS/AGC + 48k→16k 重采样，**配合"必须戴耳机"**（§4.1） |
| 14 | 支持 PWA | — | manifest + SW + 安装提示；iOS 走"分享→添加到主屏幕"指引 |
| 15 | 兼容 iOS | 无版本下限 | 目标 **iOS 17+**；WebGPU 可用则用，WASM 兜底 |
| 16 | 用 workers 防主线程卡死 | **`speechSynthesis` 只存在于主线程** | ASR/VAD/翻译进 Worker；TTS 必须主线程，靠任务切分避免长任务。此条**无法 100% 满足** |
| 17 | 三明治结构，录音键居中于状态栏 | — | 保留，§6.1 |
| 18 | "…" 打开左侧滑出日志抽屉，每条可复制 | — | 保留，§6.4 |
| 19 | 左右双栏，iOS 上下；音频默认关；点击译文起读；翻译栏选音色 | 与需求 6 的自动朗读语义可能冲突 | 保留；默认自动朗读，点击即"重排朗读起点"（§4.4） |
| 20 | 副标题栏展示各流程队列数量 | — | 保留，追加**滞后秒数**与失败计数 |
| 8、9 | **文档中缺失** | — | 待确认（§12），当前按不存在处理 |

---

## 2. 已锁定决策

| 决策项 | 结论 |
|---|---|
| 识别模型 | en→Moonshine Base / zh、ko→SenseVoice int8（共用），**按模块懒加载，不同时驻留** |
| 源语言 / 目标语言 | 标题栏：源 ∈ {中,英,韩} **默认英**；译文语音 ∈ {中,韩,英} **默认中**（默认 en→zh） |
| 推理运行时 | **混合**：Moonshine → transformers.js（WebGPU 优先、WASM 兜底）；SenseVoice → sherpa-onnx WASM |
| 翻译 | **纯前端多提供方**：Google（主）→ 微软（免 key 兜底）→ BYOK LLM（可选扩展）。无自建代理 |
| 录音/朗读冲突 | **要求使用耳机**（软提示，非强拦截） |
| 队列拥塞 | **只加速，绝不丢弃** |
| 技术栈 | **Svelte 5 + TS + Vite**，纯静态产物 |

---

## 3. 架构（无后端）

```
                        主线程                                   Web Worker
 ┌────────────────────────────────────────┐      ┌───────────────────────────────────┐
 │ 三明治 UI (Svelte)                      │      │ vad.worker:  分段（能量 VAD 默认）  │
 │  ├ 标题栏: 语言选择 / "…"               │◄─段──┤ asr.worker:  路由 → moonshine |   │
 │  ├ 内容: 双栏列表                       │      │              sensevoice           │
 │  ├ 副标题栏: 队列 / 滞后                 │      │ mt.worker:   提供方适配 + 批量 +   │
 │  └ 状态栏: ●录音 / 提示                  │      │              去重缓存 + 退避重试     │
 │  TTS 模块 (speechSynthesis) ← 只能主线程 │      └───────────────────────────────────┘
 └────────────────────────────────────────┘              │ fetch（CORS 已实测放行）
                                                          ▼
                        Google translateHtml  /  Microsoft translatetext  /  BYOK LLM
```

**运行时硬约束**

| 能力 | 必须在哪 | 原因 |
|---|---|---|
| `speechSynthesis` | 主线程 | Worker 中不存在该 API |
| sherpa-onnx WASM | Worker | CPU 密集；**无 WebGPU 后端** |
| transformers.js (Moonshine) | Worker | WebGPU 可用则用，否则 WASM |
| 麦克风采集 | 主线程 + AudioWorklet | `getUserMedia` 需窗口上下文 |
| 翻译/模型下载 | Worker | 避免主线程长任务；CORS 实测放行 |

---

## 4. 模块设计

### 4.1 采集、VAD 与"戴耳机"策略
- `getUserMedia({ audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1, sampleRate:48000 }})`；不强求 16k（iOS 不可靠），统一重采样。
- AudioWorklet 输出 Float32，100ms 块送 VAD。
- 分段：静音 500ms（可调 300–1200ms）、最短段 600ms、最长段 8s 强制切分、段首前留 150ms。
- **耳机策略**：浏览器无可靠耳机检测 API → ①启动前一次性确认弹窗 ②软检测（已授权时看输出设备名）③设置开关。未确认时状态栏黄色提示，不阻止使用。

### 4.2 ASR 路由
- `源语言 → 引擎` 静态映射；切换源语言时先释放旧模型再加载新模型。
- Moonshine：transformers.js，`device:'webgpu'` 失败自动 `wasm`。
- SenseVoice：sherpa-onnx WASM（运行时按需下载、可配置 CDN）。
- 统一输出 `{ text, rawText, lang, segStartMs, segEndMs, engine, inferMs }`。

### 4.3 翻译：多提供方适配器

统一接口：`translate(texts, sl, tl, opts) => Promise<(string|null)[]>`，序对齐、逐项可失败。

**P1 `google-translate`（默认）**

```
POST https://translate-pa.googleapis.com/v1/translateHtml
Content-Type: application/json+protobuf
X-Goog-API-Key: <Google 网页翻译控件的公开 key>
body: [[[text1, text2, ...], sl, tl], "wt_lib"]
resp: [["译文1","译文2", ...]]        // resp[0]，与输入等长
```

- **实测确认**：从普通网页 200 通过 CORS、原生批量顺序对齐、缺 key 403。
- 输入 HTML 转义，输出解码实体一次。
- 始终传显式 `sl`，不用 `auto`（短句 auto 会误判并污染缓存）。

**P2 `microsoft-translate`（免 key 兜底）**

```
POST https://edge.microsoft.com/translate/translatetext?from=<sl>&to=<tl>&isEnterpriseClient=false
body: ["句子1","句子2"]                 // 裸 JSON 字符串数组
resp: [{translations:[{text:"..."}]}, ...]
```

- **实测确认**：普通网页 200、原生批量、无需 key、顺序对齐。
- `from=auto` 传空串；不支持 HTML；输入同样转义。

**P3 `llm:*`（BYOK）**
- OpenAI 兼容（自填 baseURL + key + model）/ Anthropic / Gemini / Ollama。
- 实测：Anthropic 浏览器直连可用（需 `anthropic-dangerous-direct-browser-access: true`）；OpenAI 兼容类待实测。
- key 只存本机（localStorage），不上传服务器。
- 批量用编号行协议 + 严格校验行数，不符则拆单重发。
- **延迟警告**：LLM 单句 0.5–3s，不适合实时朗读，适合质量优先场景。

**通用机制**
- **可达性探针**：3s 超时跑一句 "hello"，Google 不通自动切微软并提示当前提供方。
- **批量**：攒批窗口 300ms 或满 20 句。
- **去重缓存**：key = `sha256(providerId | model | promptVersion | sl | tl | 归一化文本)`。**必须包含提供方与 prompt 版本**，否则切换后会命中过期译文。
- **重试**：429/5xx/网络错误指数退避最多 3 次；**批量失败自动拆单重发**；仍失败该句标记 `null` 占位、行内"翻译失败 · 重试"、不阻塞后续。
- **可插拔**：设置里可切换/锁定提供方。

**⚠️ 风险**
1. `X-Goog-API-Key` 是 Google 随网页翻译控件下发的**公开 key**，会被限流、随时可能轮换；个人 MVP 可用，**不应作为商业产品地基**。设置页提供自填 key 入口。
2. **许可证**：陪读蛙（read-frog）为 GPLv3 + 商业双许可。端点/参数/协议属事实性信息，可照此独立实现；**不得复制其源码**。本项目所有相关代码均为独立实现。

### 4.4 TTS 与播放（浏览器 SpeechSynthesis）
- 首次用户手势里解锁 iOS（空 utterance 探测）。
- 长句切分：按标点切成 ≤150 字符片段再入队（规避 Chrome 长 utterance 截断）。
- 语速 `utterance.rate`（0.5–2.0），只对尚未开始朗读的句子生效。
- 音色：`getVoices()` 按目标语言过滤，等 `voiceschanged`，存 `voiceURI`。
- 播放语义：默认自动朗读；点击某行 = 把朗读起点重排到该行并读到"点击时刻的最新行"；朗读中不打断当前句，只在句间切换。
- **全双工（已定案）**：朗读期间照常向 ASR 投递音频段，实时性与"接着说"不受朗读影响；回声靠"先戴上耳机"解决（§4.1），不再用丢音频的方式回避。（早期版本默认半双工，2026-09 按产品决定移除。）

### 4.5 队列与背压

| 队列 | 生产 | 消费 | 拥塞策略 |
|---|---|---|---|
| `segQ`（段） | VAD | ASR | 不丢弃，深度 >10 时状态栏告警 |
| `mtQ`（句） | ASR | 翻译 | 不丢弃，攒批 + 去重 |
| `ttsQ`（句） | 翻译 | SpeechSynthesis | 不丢弃，按深度加速 |

- `rate = clamp(1.0 + 0.15 × (backlog − 1), 1.0, 1.8)`，3 句迟滞防抖动。
- 滞后估算显示在副标题栏；滞后 > 8s 时状态栏出现"跳到最新"（唯一的丢弃路径，由用户主动触发）。

### 4.6 识别音频存储
- 默认**关闭**；开启后按段保存 16k 单声道 WAV Blob，环形缓冲保留最近 10 分钟或 200 句（约 19MB），可调。

### 4.7 日志与调试
- 环形缓冲 1000 条（可调），`error/warn/info/debug`，字段 `{ts, level, stage, message, detail}`。
- 写入点：模型加载失败、VAD 异常、识别空结果、翻译 429/超时/格式异常、提供方降级、TTS 无音色、存储配额不足、Worker 崩溃重启。

---

## 5. 会话状态机

`idle → 请求权限 → 模型就绪检查 → 录音中 ⇄ 暂停投递(朗读中) → 停止 → 汇总`
- 停止/切后台/锁屏：立即停止采集并保留已识别内容；返回前台需重新点录音。
- Worker 崩溃：`onerror` 捕获 → 重启 Worker → 重放未处理段 → 记 `error`。
- 切换源语言：暂停采集 → 释放旧模型 → 加载新模型 → 恢复。

---

## 6. UI 规范

### 6.1 布局（需求 17）
三明治 `header`/`main`/`footer`；状态栏**中央**圆形录音按钮（含计时器与脉冲动画），**右侧**提示区。
标题栏**左侧**为品牌：**当前选中的应用图标** + 「乔巴」（≤480px 只留名字左边的图）。标记跟着设置走（见 §6.1.1），`components/Logo.svelte` 只负责把选中那款的图按比例画进一个方框；它是图片不是字形，所以不跟着主题色变。

**彩蛋**：点标题栏的小鹿或「乔巴」二字 → 弹出「我是乔巴」（`AboutChopper.svelte`）。内容只讲一件事：乔巴是作者最喜欢的动漫《海贼王》里的角色，是驯鹿也有一半是人，所以动物和人说的话都能听懂，正适合当翻译。配图就是设置里选中的那个图标（`iconPreviewUrl`），Esc / 点遮罩 / 按钮均可关闭。

### 6.1.1 应用图标
四款可选，设置 → 外观 → 应用图标；第一款是默认：

| id | 图 | 素材 |
|---|---|---|
| `hat-antlers` | 乔巴的帽子（含鹿角与耳朵） | `static/chopper-hat-full.svg`（**默认**） |
| `hat` | 只有帽子 | `static/chopper-hat.svg` |
| `headphones` | 戴耳机 | `static/chopper-hat-earphone.jpg`（带去边） |
| `deer` | 小鹿 | 由 `logo.ts` 的几何渲染（不是位图放大） |

图标文件**不要手改**：`npm run icons`（`scripts/make-icons.mjs`）按上面的清单写两套文件——

- 根目录那套（`icon.svg` / `icon-192.png` / `icon-512.png` / `icon-maskable-512.png` / `apple-touch-icon.png`）永远是**默认图标**：`index.html` 与静态 manifest 在任何 JavaScript 跑起来之前就指着它们。
- `static/icons/<id>-<尺寸>.png` 是其余每一款的位图（含默认那款的 180/192/512/maskable）。

文件名由 `iconAsset()` 一处计算，渲染脚本和页面共用，因此两边不会各指一处。生成时顺带量出「图案最远点距中心的半径」与「有多少像素越出圆角」，确认 maskable / iOS 那两档仍在 80% 裁切圆内。PNG 的存在是因为 Android 安装要 PNG、iOS 的 `apple-touch-icon` 从不支持 SVG（缺了它 iPhone 会把页面截图当图标）。

### 6.2 双栏（需求 19）
桌面左右、iOS 竖屏上下；**CSS media query 判定，不用 UA 嗅探**；每栏独立滚动、自动滚底、用户上滚后暂停并出现"回到最新"。

### 6.3 双栏内容
左：识别原文；时间戳、引擎、推理耗时、`▶ 原声`、`重新识别` **仅调试模式显示**（默认关闭，普通只读文本）。右：译文 + 标题栏**音色下拉**；每行的翻译来源同样只在调试模式显示。译文栏标题栏**最右侧**显示翻译来源标记（Google 为「文 A」图形，降级到微软 / AI 模型时改显示纯文字名字，避免降级被误认为谷歌）。**译文不提供复制按钮**（需要复制请从日志抽屉走）。
标题栏：语言选择**居中于窗口**（三格 `1fr auto 1fr` 网格），左侧品牌、右侧「设置」，**调试模式时**才多一个 `…`；不再显示翻译来源文字。副标题栏（需求 20）`识别 · 翻译 · 朗读 · 滞后`，同样**仅调试模式显示**（默认隐藏；翻译失败仍在译文行上标注，"跳到最新"仍在状态栏）。
状态栏右侧在启动期间显示**当前真实阶段**（`正在加载识别模块` → `正在连接翻译服务` → `正在准备麦克风`，来自 `session.stage`），而不是固定一句猜的“浏览器问权限时点允许”——这三段分别是秒级、十毫秒级、秒级的等待，用户该知道自己在等哪一个。

### 6.4 日志抽屉（需求 18）
调试模式下，标题栏右侧的 `…` → 从**左侧**滑出覆盖式抽屉；每条 = 等级色点 + 时间 + 阶段 + 文案 + 复制按钮；顶部等级过滤 / 清空 / 导出 JSON；点遮罩或 Esc 关闭。

### 6.5 调试模式（需求 12）
识别列表每行展开 `rawText`、归一化文本、分段起止与时长、引擎、推理耗时、**强制显示音频播放器**。

### 6.6 视觉（需求 7）
`src/lib/styles/tokens.css`：暖白背景、近黑蓝正文、芥末黄强调、粗描边圆角按钮、无重阴影。首版仅浅色。

---

## 7. 设置项清单（需求 10）

| 设置项（人话） | 气泡说明 | 默认 |
|---|---|---|
| 应用图标 | 装到手机/桌面时用的图标；已装过的要删掉重新添加才会换 | 乔巴的帽子（4 款可选：帽子·带鹿角 / 只有帽子 / 戴耳机 / 小鹿） |
| 说话停顿多久算一句 | 停顿超过这个时间就认为一句话说完了。调短更跟得上，但容易把一句话切成两半 | 500ms |
| 一句话最长不超过 | 说很久不停顿也会在这里强行收尾，避免一直不出结果 | 8s |
| 识别精度 | 高精度更准但更费电；省电优先会降精度档位 | 高精度 |
| 用显卡加速 | 有显卡时用显卡跑识别，明显更快；关掉则用 CPU 兜底 | 自动 |
| 翻译用哪家 | 谷歌最快最省事；微软不需要填任何 key，可以当备用；AI 模型最准但明显更慢 | 谷歌（不通自动切微软） |
| 翻译攒几句一起发 | 攒的多省流量但更慢；攒的少更快但请求更多 | 300ms |
| 记住翻过的句子 | 同一句话不再重复请求翻译 | 开 |
| AI 模型的密钥 | 只保存在你自己的这台设备上，不会上传 | 空 |
| 朗读音色 | 译文用哪个声音读 | 目标语言首选 |
| 朗读基础语速 | 不忙时的正常语速 | 1.0x |
| 忙时自动加速 | 译文堆积时自动加快朗读，上限 1.8x | 开 1.8x |
| 保存整场录音 | 整段声音存在手机上：能回放、导出、重新识别某句 | 开 |
| 录音最长保存 | 录到这里就停止保存录音，识别不受影响 | 60 分钟 |
| 记录详细程度 | 调试时才需要更啰嗦的记录 | 普通 |
| 已下载的识别模块 | 显示各模型占用空间，可清除重下（英文一个、中文与韩语共用一个） | — |

---

## 8. 数据与存储

- `settings`: localStorage（`rc.settings.v1`），变更即时生效。
- API key 仅存 localStorage（UI 标注"仅本机"），不上传、日志脱敏。
- 模型缓存：transformers.js 走 Cache API；sherpa-onnx WASM 走 Cache Storage/OPFS；下载前 `storage.estimate()` 校验，支持 Range 续传。
- 会话记录 v1 不持久化；日志可导出 JSON。

---

## 9. 目录结构

```
PLAN.md / realtime-chopper.md
index.html / vite.config.ts / svelte.config.js / tsconfig.json
src/
  main.ts  App.svelte
  components/   三明治外壳、双栏面板、状态栏、日志抽屉、设置、气泡、弹窗
  lib/audio/    capture / resample / segmentStore(WAV 环形缓冲)
  lib/asr/      router / moonshine(transformers.js) / sensevoice(sherpa) / segmenter(VAD)
  lib/mt/       client / cache / probe / providers/{google,microsoft,llm}
  lib/tts/      speech.ts
  lib/pipeline/ queues / rate / latency / session(状态机)
  lib/log/      store
  lib/store/    settings
  lib/selfcheck.ts  M0 自检
  workers/      vad.worker.ts / asr.worker.ts / mt.worker.ts
static/         manifest.webmanifest / sw.js / icons
```

---

## 10. 里程碑与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0 技术验证** | 推理耗时/体积/内存、三提供方批量与限流实测、Chrome 长 utterance 截断阈值 | 数值表；不达标则降级 |
| **M1 骨架** | Svelte+Vite + 三明治 + Basecamp tokens + 设置页 + 日志抽屉 | 静态部署可访问；设置即时生效 |
| **M2 采集与识别** | 采集/重采样/VAD/分段 + 语言路由 + 按需下载 + 左栏 | 默认 en 首次 ~50MB；10 句全部分段 |
| **M3 翻译** | 适配器 + 探针降级 + 攒批 + 缓存 + 退避 + 单句失败降级 | 断网自动降级并提示；重复句命中缓存 |
| **M4 朗读** | SpeechSynthesis 封装 + 切分 + 音色 + 语速映射 + 点击起读 + 全双工 | iOS 手势后可发声；点击第 N 行从第 N 行读 |
| **M5 联动** | 队列计数、滞后估算、"跳到最新"、调试模式 | 拖慢翻译时滞后正确显示，点按钮立刻追上 |
| **M6 PWA/iOS** | manifest/SW/安装引导、续传、真机矩阵、长会话压测 | iPhone 30 分钟不崩；安装后缓存不被回收 |

---

## 11. 指标与风险

**指标**：端到端延迟 p50 < 1.5s（桌面 WebGPU）/ < 3s（手机兜底）；识别 RTF < 0.6；30 分钟内存峰值 < 1GB；同时只驻留 1 个 ASR 模型；翻译失败率 < 1%。

**风险**：①WebGPU 算子兼容性未验证 ②iOS 230MB 模型内存触顶 ③Google 公开 key 被限流 ④未授权端点随时可能变（适配器隔离）⑤iOS 7 天存储回收 ⑥iOS 后台中断 ⑦Chrome 长 utterance 截断 ⑧中英混说识别坏 ⑨"绝不丢弃"导致永久滞后 ⑩GPL 传染。

---

## 12. 待拍板的尾巴（未答复按假设推进）

1. 需求 8、9 是什么？（假设：不存在）
2. 需求 5 的"第 4 个模块"？（假设：采集/VAD、ASR、翻译、TTS/播放）
3. 需求 12/18 是否同一个面板？（假设：两个独立 UI）
4. 是否允许"跳到最新"按钮？（假设：允许，滞后 >8s 出现）
5. 接受 Google 公开 key 吗？（假设：接受用于 MVP + 提供自填 key 入口）
6. 计划文档落盘位置：`PLAN.md`（已落盘于仓库根目录）
