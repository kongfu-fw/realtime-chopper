/**
 * English for everything below the interface — the log lines, the diagnostic
 * report, engine status, provider and pipeline errors — keyed by the Chinese
 * source text (see `../index.ts`).
 *
 * These are read by whoever a phone hands them to, so they are written as
 * sentences rather than as codes: `参数 {name}` placeholders move freely, and a
 * translator can put them wherever the target language needs them.
 *
 * Technical tokens stay as they are: WebGPU, CPU, SharedArrayBuffer, Moonshine,
 * SenseVoice, HTTP, and the model names.
 */
export const EN_CORE: Record<string, string> = {
  // ── app/state.ts ──────────────────────────────────────────────────────────
  '已复制': 'Copied',
  '复制下面这段内容：': 'Copy the text below:',
  '自检完成': 'Self-check finished',
  '项数': 'checks',
  '：': ': ',
  '注意 · {text}': 'Note · {text}',
  '失败 · {text}': 'Failed · {text}',

  // ── app/wakelock.ts ───────────────────────────────────────────────────────
  // The screen lock is the failure a classroom meets first — nobody touches the
  // screen during a lesson — so these four sentences are the ones that have to be
  // actionable: each names the setting that gives the screen back.
  '屏幕常亮已开启：录音期间屏幕不会自动熄灭':
    'Screen wake lock on: the screen will not go to sleep while recording',
  '屏幕常亮没能生效': 'The screen wake lock did not take effect',
  '怎么办': 'What to do',
  '这个浏览器不支持屏幕常亮（Safari 要 16.4 或更新）：录音时请在「设置 → 显示与亮度 → 自动锁定」里选「永不」':
    'This browser cannot keep the screen awake (Safari needs 16.4 or newer): while recording, choose “Never” under “Settings → Display & Brightness → Auto-Lock”',
  '系统拒绝了屏幕常亮（低电量模式开着，或者页面当时不在前台）：把低电量模式关掉，或把「自动锁定」设成「永不」':
    'The system refused to keep the screen awake (Low Power Mode is on, or the page was not in the foreground): switch Low Power Mode off, or set Auto-Lock to “Never”',
  '屏幕常亮被系统收回了（多半是低电量模式刚打开）：屏幕可能还会自动熄灭':
    'The system took the screen wake lock back (usually Low Power Mode being switched on): the screen may go dark again',
  '屏幕常亮没能开启；录音时请在「设置 → 显示与亮度 → 自动锁定」里选「永不」':
    'The screen wake lock could not be taken; while recording, choose “Never” under “Settings → Display & Brightness → Auto-Lock”',

  // ── app/update.ts ─────────────────────────────────────────────────────────
  // A page that never navigates never learns about a deploy, so it asks the
  // server for its own version. These three say what the self-check found: one
  // line written just before the page reloads itself, and one line plus one
  // sentence for the case where a session makes it wait.
  '服务端有新版本 {version}，页面正在自动更新':
    'The server has a newer version ({version}); the page is updating itself now',
  '服务端有新版本 {version}，这一场还占着页面：先不更新':
    'The server has a newer version ({version}), but this session still owns the page: not updating yet',
  '服务端有新版本 {version}：不打断这一场；把应用关掉再打开就会更新':
    'The server has a newer version ({version}): this session is not interrupted — close the app and open it again to update',

  // ── asr/device.ts ─────────────────────────────────────────────────────────
  '显卡加速可用': 'GPU acceleration works',
  'iPhone / iPad 上开显卡加速会把整个页面带崩（实测：一启用就整页闪一下重开）':
    'On iPhone / iPad, enabling GPU acceleration kills the whole page (measured: the page flashes and reloads the moment it is switched on)',
  '这台设备上次显卡加速失败过：{reason}': 'GPU acceleration failed on this device last time: {reason}',
  '原因未记录': 'no reason recorded',

  // ── asr/models.ts ─────────────────────────────────────────────────────────
  // The module names below reach t() through a variable (`t(MODULE_NAME[id])`),
  // which is the one thing the source scan of `messages.test.ts` cannot see — so
  // a missing one is added by hand, and checked by eye in all three languages.
  '英文识别模块': 'English recognition module',
  '韩语识别模块': 'Korean recognition module',
  '中韩识别模块': 'Chinese & Korean recognition module',
  '英文 · Moonshine': 'English · Moonshine',
  '韩语 · Moonshine': 'Korean · Moonshine',
  '中韩 · SenseVoice': 'Chinese & Korean · SenseVoice',
  '韩语识别服务（koasr）': 'Korean recognition service (koasr)',
  '韩语 · 网络服务': 'Korean · network service',
  '韩语识别服务（koasr · faster-whisper large-v3-turbo 韩语）':
    'Korean recognition service (koasr · faster-whisper large-v3-turbo, Korean)',
  '英文识别模块（Moonshine Base）': 'English recognition module (Moonshine Base)',
  '韩语识别模块（Moonshine Base）': 'Korean recognition module (Moonshine Base)',
  '中韩识别模块（SenseVoice Small int8）':
    'Chinese recognition module (SenseVoice Small int8)',
  '英文识别模块（Parakeet，已移除）': 'English recognition module (Parakeet, removed)',
  // The live module and the names retired with this round's change: every language
  // now resolves to SenseVoice, and the Moonshine downloads and the Korean network
  // service are only mentioned by leftover crash notes and install records.
  '识别模块（SenseVoice Small int8）': 'Recognition module (SenseVoice Small int8)',
  'SenseVoice · 中英韩日粤': 'SenseVoice · zh/en/ko/ja/yue',
  '英文识别模块（Moonshine，已移除）': 'English recognition module (Moonshine, removed)',
  '韩语识别模块（Moonshine，已移除）': 'Korean recognition module (Moonshine, removed)',
  '韩语识别服务（koasr，已移除）': 'Korean recognition service (koasr, removed)',
  '这个设备内存不够装这个模块：关掉其他应用再试一次':
    'This device does not have enough memory for the module — close other apps and try again',
  '约 {mb} MB': 'about {mb} MB',
  // The refusal an Apple-mobile page gets before the download starts, and the
  // report line that names the one recogniser left. Both carry the same two facts:
  // what the model costs, and that a phone cannot pay it.
  '{module}在这台设备上装不下：iOS 给网页的内存放不下 {size} 的模型（实测几百 MB 就会把整个页面关掉）。识别只能在电脑上使用。':
    '{module} does not fit on this device: iOS hands a web page less memory than a {size} model needs (measured: a few hundred MB is enough for the whole page to be closed). Recognition is available on a computer only.',
  '识别模块：{module}（{lang} 源）': 'Recognition module: {module} (source {lang})',
  '可用配额约 {quota} GB，已用 {used} MB · 识别模块约 230 MB':
    'About {quota} GB of quota, {used} MB used · the recognition module is about 230 MB',
  '下载中断了，检查网络后重试': 'The download was interrupted — check the network and try again',
  '下载被拒绝，换个网络重试': 'The download was refused — try a different network',
  '找不到模块文件，可能需要更新版本': 'The module files were not found — the app may need an update',
  '下载太久没动静，重试一次': 'The download stalled — try again',
  '手机存储空间不够，清理后重试': 'Not enough storage on this device — free some space and try again',
  '浏览器不让存文件，用 https 打开再试': 'The browser will not store the files — open the app over https and try again',
  '识别引擎没能在浏览器里启动，换个浏览器再试': 'The recognition engine could not start in this browser — try another one',
  '浏览器拦住了加载，用 https 或换个浏览器打开': 'The browser blocked the download — open it over https, or in another browser',
  '模块没能装好，再试一次': 'The module could not be installed — try once more',

  // ── asr/moonshine.ts ──────────────────────────────────────────────────────
  '下载 {file}': 'Downloading {file}',
  '下载识别模块': 'Downloading the recognition module',
  '准备识别模块': 'Preparing the recognition module',
  '装配识别模块': 'Assembling the recognition module',
  '显卡不可用，回退到 CPU': 'the GPU became unavailable, falling back to the CPU',
  '用户指定用 CPU': 'the CPU was chosen in settings',
  '用户指定用显卡': 'the GPU was chosen in settings',
  '本机没有 WebGPU，改用 CPU': 'this machine has no WebGPU, so the CPU is used',
  '{reason}，改用 CPU': '{reason}, so the CPU is used',
  '使用显卡加速': 'Using GPU acceleration',
  '没有为 {module} 配置 Moonshine 模型': 'no Moonshine model is configured for {module}',
  '显卡加速没能在 {sec} 秒内启动，改用 CPU': 'GPU acceleration did not start within {sec}s, so the CPU is used',
  'Moonshine 模型加载失败': 'Loading the Moonshine model failed',
  '识别模块还没准备好': 'The recognition module is not ready yet',

  // ── asr/router.ts ─────────────────────────────────────────────────────────
  '{module} 不在本 worker 中运行（{engine} 有自己的 worker）':
    '{module} does not run in this worker ({engine} has one of its own)',
  '没有为 {module} 决定用哪个加速器': 'no accelerator was chosen for {module}',
  '没有给 {module} 配置服务地址': 'no service address is configured for {module}',

  // ── asr/koasr.ts ──────────────────────────────────────────────────────────
  // The recognition service on the network: everything it says about itself, and
  // everything the app has to say when it cannot be reached. The last two exist
  // because a fetch that fails has no useful error of its own — these are what
  // turn "Failed to fetch" into a sentence about the service.
  '正在连接识别服务': 'Connecting to the recognition service',
  '网络识别服务': 'Network recognition service',
  '服务在用 {engine}，队列 {depth}': 'the service is running {engine}, queue {depth}',
  '识别服务正在关闭（{status}）': 'The recognition service is shutting down ({status})',
  '识别服务没有就绪（HTTP {status}）': 'The recognition service is not ready (HTTP {status})',
  '识别服务 {sec} 秒没有回应': 'The recognition service did not answer within {sec}s',
  '连不上识别服务（{reason}）': 'Could not reach the recognition service ({reason})',
  '识别服务还没连上': 'The recognition service is not connected yet',
  '识别服务出错了（HTTP {status}）': 'The recognition service failed (HTTP {status})',
  '识别服务出错了：{message}': 'The recognition service failed: {message}',
  '识别服务返回了看不懂的内容': 'The recognition service returned something unreadable',

  // ── audio/capture.ts ──────────────────────────────────────────────────────
  '麦克风权限被拒绝了：点地址栏的锁图标，允许麦克风后再试一次':
    'Microphone permission was refused: tap the lock in the address bar, allow the microphone and try again',
  '没找到麦克风，看看麦克风或耳机插好了没': 'No microphone found — check that the microphone or headset is plugged in',
  '麦克风被别的软件占用了，关掉会议或录音软件再试':
    'Another app is using the microphone — close the meeting or recording app and try again',
  '这个麦克风不符合音质要求，换一个再用': 'This microphone does not meet the audio requirements — try another one',
  '启动被中断了，再点一次': 'Starting was interrupted — tap once more',
  '麦克风打不开：{error}': 'The microphone will not open: {error}',
  '这个浏览器不能录音，换个浏览器试试': 'This browser cannot record — try another one',
  '浏览器没有完全遵守高保真拾音设置，识别质量可能受影响':
    'The browser did not fully honour the high-fidelity capture settings, so recognition may be a little worse',
  '音频启动失败，换个浏览器或设备再试：{error}': 'Audio capture would not start — try another browser or device: {error}',
  '麦克风已开启': 'Microphone open',
  '麦克风已关闭': 'Microphone closed',
  '麦克风已重新打开': 'Microphone reopened',
  '麦克风没能重新打开：{error}': 'The microphone could not be reopened: {error}',
  // The pickup summary the vad worker reports every few seconds. "Input" is the raw
  // level the microphone delivered — the number that says whether the phone is too
  // far from the speaker; "gain" is how much the front-end added to it.
  '拾音：输入 {input} dBFS，增益 {gain} dB，输出 {output} dBFS，信噪比 {snr} dB':
    'Pickup: input {input} dBFS · gain {gain} dB · output {output} dBFS · SNR {snr} dB',
  '启动被取消': 'Starting was cancelled',

  // ── diag.ts ───────────────────────────────────────────────────────────────
  '版本：{version}': 'Version: {version}',
  '平台：{platform} · {ua}': 'Platform: {platform} · {ua}',
  'iOS/iPadOS': 'iOS/iPadOS',
  '非 iOS': 'not iOS',
  '安全上下文：{secure}': 'Secure context: {secure}',
  '是': 'yes',
  '否（麦克风与缓存都会被禁用）': 'no (the microphone and caching are both disabled)',
  ' · SharedArrayBuffer：{state}': ' · SharedArrayBuffer: {state}',
  '可用': 'available',
  '不可用': 'not available',
  'CPU 核心：{cores}': 'CPU cores: {cores}',
  '未知': 'unknown',
  ' · 设备内存（Chrome 才报）：{gb}': ' · device memory (Chrome only): {gb}',
  'WebGPU：{available}': 'WebGPU: {available}',
  '浏览器提供': 'offered by the browser',
  // '没有' and '失败' are defined with the interface strings in shell.ts.
  ' · 上次判定：{verdict}': ' · last verdict: {verdict}',
  '（{reason}）': ' ({reason})',
  '还没试过': 'not tried yet',
  ' · 本次将直接用 CPU': ' · this time the CPU is used straight away',
  '朗读引擎：{engine}': 'Read-aloud engine: {engine}',
  '（{detail}）': ' ({detail})',
  '浏览器不支持': 'not supported by this browser',
  '系统朗读：音色 {n} 个': 'System speech: {n} voices',
  ' · 暂停态：{paused}': ' · paused: {paused}',
  '是（会没声音）': 'yes (which means silence)',
  '否': 'no',
  ' · 语音会话：{session}': ' · audio session: {session}',
  '存储：配额约 {quota} MB，已用 {used} MB': 'Storage: quota about {quota} MB, {used} MB used',
  '存储：浏览器不提供配额信息': 'Storage: the browser does not report a quota',
  '存储：读取配额失败': 'Storage: reading the quota failed',
  '缓存桶：{keys}': 'Cache buckets: {keys}',
  '（空）': '(empty)',
  '缓存桶：读取失败': 'Cache buckets: reading them failed',
  '# 乔巴 · 诊断信息': '# 乔巴 · diagnostics',
  '情况：{headline}': 'What happened: {headline}',
  '识别服务：{backend} · {url} · 当前语言用 {module}':
    'Recognition: {backend} · {url} · {module} for the current language',
  '没填地址': 'no address',

  // ── log/store.ts ──────────────────────────────────────────────────────────
  '页面重新加载过：已恢复上一个标签页留下的 {n} 条日志（那个标签页已经不在了）':
    'The page reloaded: recovered {n} log lines left by another tab (which is gone now)',
  '页面重新加载过：已恢复上次的 {n} 条日志': 'The page reloaded: recovered {n} log lines from last time',

  // ── mt/client.ts ──────────────────────────────────────────────────────────
  '整批翻译失败，改为逐句重试：{message}': 'The batch translation failed; retrying sentence by sentence: {message}',
  '{provider} 第 {n} 次失败，{wait}ms 后重试': '{provider} failed (attempt {n}); retrying in {wait}ms',
  '{provider} 不可用，尝试下一个翻译来源': '{provider} is unavailable; trying the next provider',
  '所有翻译来源都失败了': 'Every translation provider failed',
  '这一句翻译失败了：{text}': 'This sentence failed to translate: {text}',

  // ── mt/probe.ts ───────────────────────────────────────────────────────────
  '返回内容为空': 'the response was empty',
  '等待 {ms} ms 没有响应（可能是冷连接或网络不通）':
    'no response within {ms} ms (a cold connection, or the network is blocked)',

  // ── mt/providers ──────────────────────────────────────────────────────────
  // Provider names, also through a variable: `t(provider.label)`.
  '谷歌翻译': 'Google Translate',
  '微软翻译': 'Microsoft Translate',
  'AI 模型': 'AI model',
  '谷歌翻译网络错误：{error}': 'Google Translate network error: {error}',
  '谷歌翻译返回 HTTP {status}': 'Google Translate returned HTTP {status}',
  '谷歌翻译返回的句子数量与请求不一致': 'Google Translate returned a different number of sentences than were sent',
  '微软翻译网络错误：{error}': 'Microsoft Translate network error: {error}',
  '微软翻译返回 HTTP {status}': 'Microsoft Translate returned HTTP {status}',
  '微软翻译返回的句子数量与请求不一致': 'Microsoft Translate returned a different number of sentences than were sent',
  '微软翻译第 {n} 句缺少译文': 'Microsoft Translate returned no translation for sentence {n}',
  '还没有配置 AI 模型': 'no AI model is configured yet',
  'AI 模型的地址和名称不能为空': 'The AI model URL and name cannot be empty',
  'AI 模型需要填写密钥': 'The AI model needs an API key',
  'AI 模型返回的格式不符合要求（编号行数不匹配）': 'The AI model’s reply had the wrong shape (the numbered lines did not line up)',
  'AI 模型没有返回文本内容': 'The AI model returned no text',
  'AI 模型网络错误：{error}': 'AI model network error: {error}',
  'AI 模型返回 HTTP {status}：{text}': 'The AI model returned HTTP {status}: {text}',
  'AI 模型的响应不是 JSON': 'The AI model’s response was not JSON',
  '翻译接口返回 HTTP {status}': 'The translation endpoint returned HTTP {status}',

  // ── pipeline/session.ts ───────────────────────────────────────────────────
  '准备启动{module}：{plan}': 'Starting {module}: {plan}',
  '{device}（{dtype}）—— {reason}': '{device} ({dtype}) — {reason}',
  'sherpa WebAssembly（CPU）': 'sherpa WebAssembly (CPU)',
  '这台设备已经在显卡加速（WebGPU）下被关掉页面两次了：请在设置里把「显卡加速」改成 CPU 再试':
    'This device has had its page killed twice under GPU acceleration (WebGPU): change “GPU acceleration” to the CPU in settings and try again',
  '{module}在这台设备上装不下：已经两次在启动时把整个页面关掉了（内存不够），先别试了':
    '{module} does not fit on this device: twice now the whole page was killed while starting it (out of memory). Leave it for now.',
  '{module}在这台设备上装不下：上次启动它时，系统直接把整个页面关掉了（内存不够）。手机上改用英文模块，中文留给电脑。':
    '{module} does not fit on this device: last time it was started, the system killed the whole page (out of memory). Use the English module on a phone, and keep Chinese for a computer.',
  '识别模块已就绪（{device}）': 'Recognition module ready ({device})',
  '原因': 'Reason',
  '下载太久没动静，检查网络后重试': 'The download stalled — check the network and try again',
  '识别模块加载失败：{message}': 'Loading the recognition module failed: {message}',
  '识别失败：{message}': 'Recognition failed: {message}',
  '正在加载识别模块': 'Loading the recognition module',
  '识别模块没能装好：{reason}': 'The recognition module could not be installed: {reason}',
  '识别模块没能装好，再试一次': 'The recognition module could not be installed — try once more',
  '网络识别服务 {url}': 'Network recognition service {url}',
  '还没填识别服务地址': 'No recognition service address is filled in',
  '地址是 http、页面是 https，浏览器不会发这个请求':
    'the address is http and the page is https, so the browser will not send the request',
  '{module}用不了，改用本机模型：{reason}':
    '{module} is unavailable, so the local model is used instead: {reason}',
  '网络识别服务用不了，这一场改用本机模型：{reason}':
    'The network recognition service is unavailable, so this session uses the local model: {reason}',
  '网络识别服务用不了：{reason}。这台设备不退回本机模型：把服务调通，或者在设置里把「识别走哪里」改成「只用本机模型」。':
    'The network recognition service is unavailable: {reason}. This device does not fall back to the local model — make the service reachable, or set “Where recognition happens” to “Local model only” in settings.',
  '正在连接翻译服务': 'Connecting to the translation service',
  '录音已达上限，后面的不再保存': 'The recording limit was reached; nothing further is saved',
  '录音中断了，语音识别不受影响': 'The recording was interrupted; recognition is unaffected',
  '正在准备麦克风': 'Preparing the microphone',
  '浏览器降低了录音质量，识别可能差一点': 'The browser lowered the recording quality, so recognition may be a little worse',
  '开麦后的语音输出状态': 'Speech output state once the microphone is open',
  // Coming back to a page that was hidden, which on iOS is what a locked screen
  // does. The two repairs differ only in what has to be rebuilt, and the sentence
  // says which one happened because the hole in the recording is the same either
  // way — the samples the page missed were never produced.
  '回到前台：麦克风一直在工作': 'Back in the foreground: the microphone never stopped working',
  '息屏期间没有录到声音，麦克风已恢复':
    'Nothing was recorded while the screen was off; the microphone is back',
  '恢复方式': 'How it was put back',
  '继续用同一个音频通道': 'kept using the same audio path',
  '重新打开麦克风': 'reopened the microphone',
  '刚才息屏了一小段，那一段没有录到；录音和识别已继续':
    'The screen was off for a moment and that stretch was not recorded; recording and recognition have continued',
  '麦克风被系统收回了，这一场已停下':
    'The system took the microphone away, so this session has stopped',
  '麦克风被系统收回后，自动重新开始录音':
    'Recording is starting again by itself after the system took the microphone',
  '麦克风被系统收回了，录音已停下（录音和文字都保留着）；回到应用会自动重新开始':
    'The system took the microphone away, so recording has stopped (the recording and the transcript are kept); coming back to the app starts it again',
  '引擎': 'Engine',
  '开始录音了': 'Recording started',
  '源语言': 'Source language',
  '目标语言': 'Target language',
  '已取消启动': 'Starting was cancelled',
  '启动失败：{message}': 'Could not start: {message}',
  '已停止录音': 'Recording stopped',
  '识别超时，跳过这一段': 'Recognition timed out; skipping this stretch',
  '识别结果是编的，已丢弃这一段：{text}': 'That recognition was invented, so this stretch was dropped: {text}',
  '模型背下来的句子': 'a sentence the model memorised',
  '句子里没有这种语言的文字': 'no text of the source language in it',
  '同一句重复了三遍': 'the same sentence three times over',
  '语音时长': 'Speech',
  '记录超过 {n} 行，最旧的已从界面上移除': 'More than {n} lines were recorded, so the oldest left the screen',
  '识别完成：{text}': 'Recognised: {text}',
  '朗读引擎切换为{engine}': 'Read-aloud engine switched to {engine}',
  '代理': 'Proxy',
  '，第 {n} 次尝试才通': ', which needed {n} attempts',
  '{name}可用（{ms} ms{suffix}）': '{name} works ({ms} ms{suffix})',
  '{name}不可用': '{name} is unavailable',
  '谷歌翻译用不了，已换成{label}': 'Google Translate is unreachable, so {label} is used instead',
  '已自动从{from}切换到{to}': 'Switched from {from} to {to} automatically',
  '译文（{provider}{cached}）：{text}': 'Translation ({provider}{cached}): {text}',
  '系统把朗读留在了暂停状态（切后台或锁屏之后常见），已尝试恢复':
    'The system had left speech paused (common after backgrounding or locking the screen); tried to resume it',
  '朗读请求失败': 'The read-aloud request failed',
  '朗读没有等到结束回调，这句跳过': 'Read-aloud never got its completion callback; skipping this sentence',
  '文本': 'Text',
  '朗读卡住了（这句已跳过）；一直没声音就刷新页面再试':
    'Read-aloud stalled (this sentence was skipped); if there is still no sound, reload the page',
  '朗读失败': 'Read-aloud failed',
  'TTS 代理没有可用音色：检查设置里的代理地址': 'The TTS proxy has no usable voices: check the proxy address in settings',
  '没有可用音色，去系统里装一个': 'No voices are available; install one in the system settings',
  '手机里没有这种语言的朗读声音': 'This device has no read-aloud voice for that language',
  'Edge TTS 代理连不上了：检查网络和设置里的代理地址':
    'The Edge TTS proxy cannot be reached: check the network and the proxy address in settings',
  '朗读被系统拒绝了：先点一下页面，再确认侧面的静音开关':
    'The system refused to speak: tap the page once, then check the mute switch on the side',
  '朗读语速调整为 {rate}x（积压 {n} 句）': 'Read-aloud rate set to {rate}x ({n} sentences behind)',
  '已跳到最新，放弃 {n} 句待读内容': 'Skipped to the newest, dropping {n} sentences waiting to be read',
  '这句没有录音，无法重新识别': 'There is no recording of this line, so it cannot be recognised again',
  '从录音重新识别这一句（{sec} 秒）': 'Recognising this sentence again from the recording ({sec}s)',
  '重新识别没有听出内容': 'Recognising it again heard nothing',
  '重新识别只听到模型编的内容，没有采用：换个长一点的范围':
    'Recognising it again only produced invented text, so it was not used: try a longer range',
  '翻译没有返回内容': 'The translation came back empty',
  '重新翻译失败：{message}': 'Translating it again failed: {message}',
  '还没有录音可以导出': 'There is no recording to export yet',
  '已导出录音（{mb} MB）': 'Recording exported ({mb} MB)',
  '已删除录音': 'Recording deleted',
  '等待流水线清空超时，剩余内容已放弃': 'Timed out waiting for the pipeline to drain; what was left has been dropped',

  // ── selfcheck.ts ──────────────────────────────────────────────────────────
  '运行环境': 'Environment',
  '安全上下文：{state}': 'Secure context: {state}',
  '否（麦克风会不可用）': 'no (the microphone will not work)',
  '线程隔离（SharedArrayBuffer）：{state}': 'Cross-origin isolation (SharedArrayBuffer): {state}',
  '否（WASM 单线程）': 'no (WASM runs single-threaded)',
  '设备：{device}{memory}': 'Device: {device}{memory}',
  'iOS（网页内存很紧：实测几百 MB 就会关掉页面）':
    'iOS (a web page is tight on memory: a few hundred MB is measured to be enough to kill it)',
  ' · 内存约 {gb} GB': ' · about {gb} GB of memory',
  '显示语言：{lang}': 'Display language: {lang}',
  '识别加速方式': 'Recognition accelerator',
  '将使用 {device}（{dtype}）—— {reason}': 'Will use {device} ({dtype}) — {reason}',
  '存储空间': 'Storage',
  '可用配额约 {quota} GB，已用 {used} MB · 中韩模块约 230 MB，手机上的韩语模块约 64 MB':
    'About {quota} GB of quota available, {used} MB used · the Chinese & Korean module is about 230 MB, the phone-only Korean one about 64 MB',
  '这个浏览器不提供存储配额信息': 'This browser does not report a storage quota',
  '无法读取存储配额': 'The storage quota could not be read',
  '已缓存，可直接使用': 'Cached and ready to use',
  '未安装 · 约 {mb} MB 下载': 'Not installed · about {mb} MB to download',
  '{provider}连通性': '{provider} reachability',
  '{ms} ms 往返': '{ms} ms round trip',
  '不可用：{reason}': 'unavailable: {reason}',
  '未知原因': 'no reason given',
  'AI 模型连通性（{model}）': 'AI model reachability ({model})',
  'AI 模型连通性': 'AI model reachability',
  '未配置密钥，跳过': 'No API key configured; skipped',
  '{provider}批量能力': '{provider} batching',
  '一次请求 {n} 句正常，{ms} ms · 示例：{sample}': '{n} sentences in one request, fine, {ms} ms · example: {sample}',
  '返回 {got} 句，与请求的 {asked} 句不匹配': 'Came back with {got} sentences for the {asked} that were sent',
  '{lang}朗读音色（{engine}）': '{lang} read-aloud voices ({engine})',
  '{n} 个可用 · 例：{list}': '{n} available · e.g. {list}',
  '没有填 TTS 代理地址': 'No TTS proxy address is set',
  '这个浏览器不支持 speechSynthesis': 'This browser has no speechSynthesis',
  '朗读试读（{engine}）': 'Read-aloud test ({engine})',
  '朗读测试，一二三。': 'This is a reading test, one two three.',
  '朗读请求失败：{reason}': 'The read-aloud request failed: {reason}',
  '引擎 {engine}': 'engine {engine}',
  '语音会话 {session}': 'audio session {session}',
  '系统音色 {n} 个': '{n} system voices',
  '原来是暂停状态（已恢复）': 'it had been paused (now resumed)',
  '读完「{text}」用了 {ms} ms · {context}': 'Reading “{text}” took {ms} ms · {context}',
  '发了朗读请求但一直没等到结束（等了 {ms} ms）—— 听不到声音多半就是这种 · {context}':
    'The speak request went out but never finished (waited {ms} ms) — this is what silence usually looks like · {context}',
  '朗读被拒绝了（{outcome}）· {context}': 'Speaking was refused ({outcome}) · {context}',
  // '连发探测' is defined in shell.ts (the drawer's button).
  '连发探测（5 次单句）': 'Burst probe (5 single-sentence requests)',
  '成功 {ok}/5 · 耗时 {timings} ms · 总计 {total} ms': '{ok}/5 succeeded · {timings} ms · {total} ms in total',
  ' · 出现限流或失败，攒批与缓存是必需项': ' · throttling or failures appeared, so batching and caching are not optional',
  '中文': 'Chinese',
  '韩语': 'Korean',
  '英文': 'English',

  // ── store/settings.ts ─────────────────────────────────────────────────────
  '未知大小': 'size unknown',

  // ── tts ───────────────────────────────────────────────────────────────────
  // The engine's name inside a sentence (`ttsEngineLabel`); the settings option
  // beside it is the separate '系统朗读（默认）' entry in the shell file.
  '系统朗读': 'System voice',
  '：{message}': ': {message}',
  'TTS 代理返回 HTTP {status}{detail}': 'The TTS proxy returned HTTP {status}{detail}',
  '未提供': 'not provided',

  // ── workers ───────────────────────────────────────────────────────────────
  '{name} 崩溃了': '{name} crashed',
  '未知错误': 'unknown error',
  '已被新的加载请求取代': 'superseded by a newer load request',
  '识别模块加载已取消': 'loading the recognition module was cancelled',
  '翻译缓存状态': 'Translation cache state',
  '缓存条数': 'cached',
  '排队数': 'queued',
  '翻译自检超时': 'The translation self-check timed out',
  '模型已在内存中': 'The model is already in memory',

  // ── main.ts ───────────────────────────────────────────────────────────────
  '缺少 #app 挂载点': 'The #app mount point is missing',
}
