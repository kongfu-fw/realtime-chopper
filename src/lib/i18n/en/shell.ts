/**
 * English for the app shell — `App.svelte` and every component — keyed by the
 * Chinese source text (see `../index.ts`).
 *
 * House style, translated from the Chinese one: short sentences a reader can
 * follow once, one idea per line, and no explaining anything nobody asked about.
 * `|` marks English number agreement (`'{n} line|{n} lines'`), chosen by `params.n`.
 *
 * Never translated: the app's name 乔巴, and the brand marks `文`/`A` in the
 * provider badge — those are the Google Translate mark, not words.
 *
 * A string that two screens share ('识别', '朗读', …) appears once, under the
 * section where it was first needed; the object is a map, not a per-screen list.
 */
export const EN_SHELL: Record<string, string> = {
  // ── App.svelte ────────────────────────────────────────────────────────────
  '已清理不再使用的识别模块：{list}': 'Cleaned up recognition modules that are no longer used: {list}',
  '、': ', ',
  '应用已启动': 'App started',
  // The tagline, which is also the window title. The manifest description below
  // is the longer sentence and stays about what the app does.
  '录音笔记': 'Recording notes',
  // The manifest description, through `appDesc()` rather than a call site.
  '录音笔记：本地识别 + 多来源翻译 + 浏览器朗读':
    'Recording notes: on-device recognition + multi-source translation + browser read-aloud',
  '版本': 'Version',
  '默认语向': 'Default language pair',
  '识别模块': 'Recognition module',
  '朗读': 'Read-aloud',
  '（不可用）': ' (unavailable)',
  '当前不是安全上下文（https/localhost）：麦克风、模型缓存和显卡加速都会被浏览器禁用':
    'Not a secure context (https/localhost): the browser disables the microphone, model caching and GPU acceleration',
  '这个地址不能用麦克风：请用 https 或电脑上的 localhost 打开':
    'The microphone does not work at this address: open it over https, or as localhost on a computer',
  '没有填 Edge TTS 代理地址，译文不会自动读出来': 'No Edge TTS proxy address is set, so translations will not be read out',
  '这个浏览器不支持语音朗读，译文不会自动读出来': 'This browser cannot speak, so translations will not be read out',
  '上次启用显卡加速时整个页面被系统关掉了': 'The system killed the page the last time GPU acceleration was enabled',
  '上次启动{name}时页面被系统直接关掉了 —— 当时用的是显卡加速（WebGPU），已记住，下次改用 CPU':
    'The system killed the page while {name} was starting — GPU acceleration (WebGPU) was in use. Noted; the next attempt will use the CPU',
  '依据': 'Evidence',
  'iPhone / Safari 上启用 WebGPU 会把渲染进程带崩，一闪重开、无异常可捕':
    'On iPhone / Safari, enabling WebGPU crashes the renderer: the page flashes and reloads, with no exception to catch',
  '显卡加速把页面带崩了，已自动改用 CPU': 'GPU acceleration crashed the page, so the CPU is used from now on',
  'iPhone / Safari 上的 WebGPU 一启用就会把整个页面关掉，这个模块本身没问题。现在再试一次即可（设置里也可以自己确认「显卡加速」选的是 CPU）。':
    'On iPhone / Safari, WebGPU closes the whole page as soon as it is enabled; the module itself is fine. Just try again (settings will also confirm that “GPU preferred” is now on the CPU).',
  '下面标红的那一条记着当时用的是哪个加速器。': 'The line in red below records which accelerator was in use.',
  '上次启动{name}时页面被系统直接关掉了（第 {n} 次，多半是内存不够）':
    'The system killed the page while {name} was starting (attempt {n} — usually not enough memory)',
  '提示': 'Hint',
  '弹窗闪一下就没了、控制台没有任何报错，通常就是这一种':
    'A dialog that flashes and vanishes with nothing in the console is usually this one',
  '下面标红的那一条就是它倒下的地方，它前面几行是崩溃前的最后状态。':
    'The line in red below is where it died; the lines just above it are the last state before the crash.',
  '这次没能找回崩溃前的日志尾巴，只能确认它是在这一步倒下的。':
    'The log tail from before the crash could not be recovered this time, so all we know is that it died at this step.',
  '上次启动{name}时，页面被系统直接关掉了': 'The system killed the page while {name} was starting',
  '这台设备装不下这个模块（240MB 的模型加上识别引擎）。再点还是会一样，先别试了。':
    'This device cannot fit this module (a 240 MB model plus the recognition engine). Trying again will do the same, so leave it.',
  '多半是内存不够：这种失败不会弹任何错误，页面只是闪一下就重开了。':
    'Most likely not enough memory: this failure raises no error at all, the page just flashes and reopens.',
  '页面切到后台（手机上系统可能就在这里回收掉页面）':
    'Page moved to the background (on a phone this is where the system may reclaim it)',
  '页面回到前台': 'Page came back to the foreground',
  '页面正在关闭或重新加载': 'Page is closing or reloading',
  '存储已设为持久，模型不会被自动清理': 'Storage is persistent, so the models will not be cleaned up automatically',
  '存储未获持久授权，长时间不用可能被清理': 'Persistent storage was not granted; unused data may be cleaned up after a while',
  '先戴上耳机': 'Put your headphones on first',
  '不戴耳机，麦克风会听到手机读译文的声音，就会自己翻译自己。':
    'Without headphones, the microphone hears the phone reading the translation and translates itself.',
  '不用了': 'Not now',
  '启动失败：{error}': 'Could not start: {error}',
  '戴好了，开始': 'Headphones on — start',
  // The bar between the two panels, as a separator for assistive technology.
  '拖动调整原文和译文的大小': 'Drag to resize the original and the translation',

  // ── AboutChopper.svelte ───────────────────────────────────────────────────
  '我是{name}': 'I am {name}',
  '哎呀，好痛。。。': 'Ouch, that hurt…',
  '谁呀，敲这么重！': 'Hey! Who is knocking so hard?',
  '我来自《海贼王》，作者最喜欢的动漫。': 'I am from One Piece, the maker’s favourite anime.',
  '我是一只驯鹿，也有一半是人。': 'I am a reindeer, and half human.',
  '动物说的话、人说的话，我都能听懂。': 'I understand what animals say, and what people say.',
  '所以在这儿当翻译，正合适 —— 希望我帮得上你。': 'So translating here suits me. I hope I can help.',
  '想再见到我：点左上角的图标，列表最下面是「版本号」，点它。':
    'To see me again: tap the icon at the top left, then tap the version number at the bottom of the list.',
  '好，翻译去': 'Right — off to translate',

  // ── AsrPanel.svelte ───────────────────────────────────────────────────────
  '这句没有录音': 'No recording for this line',
  '原文': 'Original',
  '回到最新': 'Back to newest',
  '导出原文': 'Export the original text',
  '已导出原文（{n} 句）': 'Exported the original text ({n} sentences)',
  '还没有内容可以导出': 'Nothing to export yet',
  '点下面的按钮开始说话。': 'Tap the button below and start talking.',
  '识别引擎': 'Recognition engine',
  '推理耗时': 'Inference time',
  '播放这句的原始录音': 'Play the original audio of this line',
  '▶ 原声': '▶ Original audio',
  '用录音里的这段音频重新识别一次': 'Recognise this stretch of the recording again',
  '重新识别': 'Re-recognise',
  '模型原始输出：{text}': 'Raw model output: {text}',
  '引擎：{engine} · 推理 {ms} ms · 时长 {sec}s': 'Engine: {engine} · inference {ms} ms · length {sec}s',
  '时间轴：{start} → {end} ms': 'Timeline: {start} → {end} ms',
  '（没有录音，可在设置里打开「保存整场录音」）': '(No recording. Turn on “Keep the whole recording” in settings.)',

  // ── LineAudio.svelte ──────────────────────────────────────────────────────
  '（这句没有录音，可能是录音已删除）': '(No recording for this line — it may have been deleted)',
  '正在取出录音…': 'Fetching the audio…',

  // ── LogDrawer.svelte ──────────────────────────────────────────────────────
  '全部': 'All',
  '错误': 'Errors',
  '警告': 'Warnings',
  '信息': 'Info',
  '调试': 'Debug',
  '日志与自检': 'Log and self-check',
  '日志': 'Log',
  '关闭日志': 'Close the log',
  '自检中…': 'Self-check running…',
  '运行自检': 'Run the self-check',
  '连发 5 次，看会不会被限流': 'Five in a row, to see whether the endpoint throttles',
  '连发探测': 'Burst probe',
  '导出': 'Export',
  '清空': 'Clear',
  '已复制最新 {n} 条日志': 'Copied the latest {n} log lines',
  '复制最新 {n} 条': 'Copy the latest {n}',
  '日期时间 · 级别 · 环节 · 内容，可直接粘进消息里': 'Timestamp · level · stage · message — paste it straight into a chat',
  '关闭这条说明': 'Close this note',
  '现在再试一次': 'Try again now',
  '自检结果': 'Self-check result',
  '：': ': ',
  '自检结果已复制': 'Self-check result copied',
  '复制全部': 'Copy all',
  '还没有日志。': 'No log lines yet.',
  '{n} 条': '{n} line|{n} lines',
  '收起': 'Collapse',
  '详情': 'Details',
  '复制这一条': 'Copy this line',
  '已复制这一条': 'Line copied',
  '复制': 'Copy',

  // ── Modal.svelte ──────────────────────────────────────────────────────────
  '点遮罩': 'tapped the backdrop',
  '按 Esc': 'pressed Esc',
  '按返回键': 'pressed the back key',

  // ── ModelInstallModal.svelte ──────────────────────────────────────────────
  'iPhone / iPad 上装不下：iOS 给一个网页的内存比电脑少一个数量级（实测：几百 MB 就会把整页关掉），这个模块的模型文件本身就有 {size}。识别只能在电脑上使用。':
    'Does not fit on an iPhone / iPad: iOS gives a web page an order of magnitude less memory than a computer (measured: a few hundred MB is enough to close the whole page), and this module’s model file alone is {size}. Recognition is available on a computer only.',
  '内存不够：先关掉其他应用再试。识别模型约 230 MB，需要浏览器腾出足够的空间。':
    'Out of memory: close other apps and try again. The recognition model is about 230 MB, and the browser needs that much room.',
  '识别模块安装失败': 'Installing the recognition module failed',
  '开始安装识别模块：{module}': 'Installing the recognition module: {module}',
  '设备': 'Device',
  '显卡加速': 'GPU acceleration',
  '浏览器有 WebGPU': 'the browser has WebGPU',
  '没有 WebGPU，走 CPU': 'no WebGPU, using the CPU',
  '语音识别模块': 'Speech recognition modules',
  '关闭': 'Close',
  '已安装': 'Installed',
  '准备中': 'Preparing',
  '约 {size}': 'about {size}',
  '下载': 'Download',
  '正在启动识别引擎，第一次会慢一些': 'Starting the recognition engine — the first time takes a while',
  '正在下载，别关掉这个窗口': 'Downloading — do not close this window',
  '报错详情': 'Error details',
  '复制诊断信息': 'Copy diagnostic info',
  '已复制，把它发给开发者就行': 'Copied — just send it to whoever is fixing this',
  '点关闭': 'tapped Close',

  // ── SettingRow.svelte ─────────────────────────────────────────────────────
  '{label}的说明': 'What “{label}” means',
  '关闭说明': 'Close the explanation',

  // ── SettingsView.svelte ───────────────────────────────────────────────────
  '朗读引擎换为{engine}': 'Read-aloud engine switched to {engine}',
  '说明': 'Note',
  '走代理 {url}': 'through the proxy {url}',
  '用系统音色，不需网络': 'system voices, no network needed',
  '应用图标换成「{name}」': 'App icon changed to “{name}”',
  '已经装到桌面的图标要删掉重新添加才会更新': 'An icon already added to the home screen has to be removed and added again to change',
  '已清除 {module} 识别模块，下次使用需要重新下载': 'Cleared the {module} recognition module; it will be downloaded again next time',
  // Lower case, because diag.ts prints the same word inside a sentence.
  '没有': 'none',
  '设置': 'Settings',
  '语言': 'Language',
  '界面语言': 'Interface language',
  '默认跟随浏览器；选错了也可以自己定。日志和诊断报告也跟着这个语言走。':
    'Follows the browser by default; pick one if that is wrong. The log and the diagnostic report follow this language too.',
  '跟随浏览器（{lang}）': 'Follow the browser ({lang})',
  '外观': 'Appearance',
  '应用图标': 'App icon',
  '装到手机或桌面上时用的图标。已经装过的，要删掉重新「添加到主屏幕」才会换成新的。':
    'The icon used when the app is added to a phone or desktop. If it is already installed, remove it and choose “Add to Home Screen” again to get the new one.',
  '图标：{name}': 'Icon: {name}',
  // The icon names, through `tr(icon.label)`, so not visible to the scan.
  '乔巴的帽子': 'Chopper’s hat',
  '只有帽子': 'Just the hat',
  '戴耳机': 'With headphones',
  '小鹿': 'Little deer',
  '识别': 'Recognition',
  '说话停顿多久算一句': 'Pause that ends a sentence',
  '停顿超过这么久，就算一句说完了。': 'A pause longer than this counts as the end of a sentence.',
  '一句话最长不超过': 'Longest a sentence may be',
  '一直不停顿，也会在这里切一句。': 'With no pause at all, a sentence is still cut here.',
  // The slider's read-out. `ms` above is the same word everywhere, but 秒 is not.
  '{n} 秒': '{n}s',
  '识别精度': 'Recognition precision',
  '省电优先更流畅，也更容易听错。': 'Battery-saving runs smoother and mishears more.',
  '高精度': 'High precision',
  '省电优先': 'Prefer battery life',
  '用显卡加速': 'GPU acceleration',
  '有显卡会更快。中文识别一直用 CPU；iPhone / iPad 上别选「显卡优先」——实测一启用就把整个页面带崩，所以那边的自动档走 CPU。':
    'A GPU is faster. Chinese always runs on the CPU; on iPhone / iPad do not choose “GPU preferred” — measuring it crashed the whole page every time, so the automatic setting there stays on the CPU.',
  '自动': 'Automatic',
  '显卡优先': 'GPU preferred',
  'CPU 兜底': 'CPU only',
  '英文识别模型': 'English recognition model',
  '英文只有一个识别模型（Moonshine Base，约 62 MB）：桌面上会走显卡加速，iPhone / iPad 上自动用 CPU 加多线程——同一段音频实测比 Parakeet 更快也更小。Parakeet 已经从这个版本里去掉了。':
    'English has exactly one recognition model (Moonshine Base, about 62 MB): GPU-accelerated on a desktop, and CPU with extra threads on iPhone / iPad — measured faster and smaller than Parakeet on the same audio. Parakeet is gone from this build.',
  '已下载的识别模块': 'Downloaded recognition modules',
  '还没有': 'None yet',
  '{n} 个 · {size}': '{n} installed · {size}',
  // '已安装' is defined with the install dialog's strings above.
  '清除': 'Clear',
  '未安装': 'Not installed',
  '所有语言都使用同一个 SenseVoice 模型（中英韩日粤）；一次只驻留一个模块，iPhone / iPad 上装不下。':
    'Every language uses the same SenseVoice model (Chinese, English, Korean, Japanese, Cantonese); one module is resident at a time, and it does not fit on an iPhone / iPad.',
  // The network recogniser's rows. The two long ones are the ones that matter:
  // they are where a user finds out that the service needs a machine switched on,
  // and that an http address cannot be called from an https page.
  '识别走哪里': 'Where recognition happens',
  '韩语还能交给网络上的识别服务：模型大得多，认得更准，但要在同一网络里有台机器开着它。自动档只在手机上用网络——电脑上的韩语本来就有个更大的本机模型，换成网络只会变慢。':
    'Korean can also be handled by a recognition service on the network: a much larger model that hears more, as long as a machine on the same network is running it. The automatic setting uses the network only on a phone — a desktop already has the larger local model for Korean, so the network would just make it slower.',
  '自动（手机上韩语走网络）': 'Automatic (Korean over the network on a phone)',
  '只用本机模型': 'Local model only',
  '网络服务优先': 'Prefer the network service',
  '识别服务地址': 'Recognition service address',
  '默认是教室那台 Mac 上的 koasr：https://kongfu.kooka-salmon.ts.net —— tailscale serve --bg 8900 把服务的根挂在这个域名上，跨源调用，服务默认允许。换别的服务时主机名可以不带协议（按 https 解析）；想用和页面同一台机器上的服务就填 /asr。页面是 https 时，http:// 开头的地址会被浏览器直接拦掉。':
    'The default is koasr on the Mac in the classroom: https://kongfu.kooka-salmon.ts.net — `tailscale serve --bg 8900` publishes the service at the root of that host, cross-origin, which the service allows by default. For another service a bare hostname is enough (it is read as https); for a service on the same machine as this page, write /asr. When this page is https, an http:// address is blocked outright by the browser.',
  '还没填地址，网络识别不会启用。': 'No address is filled in, so network recognition will not be used.',
  '页面是 https，填 http 的地址浏览器会直接拦掉：把服务也用 https 发出来（见 DOCKER.md），或者把这里改回默认的 https 地址。':
    'This page is https and this address is http, which the browser blocks outright: publish the service over https as well (see DOCKER.md), or put the default https address back here.',
  // Appended on Apple's mobile, where there is no local answer to fall back to
  // (`mayFallBackToLocal`) and so no softer sentence to print.
  '这台设备连不上识别服务会直接报错，不会退回本机韩语模型。':
    'On this device an unreachable service is an error, not a quiet move to the local Korean model.',
  '还没填地址。这台设备连不上识别服务就直接报错，不会退回本机模型：要么把地址填上，要么把上面改成「只用本机模型」。':
    'No address is filled in. This device reports an error instead of falling back to the local model: fill the address in, or change the picker above to “Local model only”.',
  '页面是 https，填 http 的地址浏览器会直接拦掉，而这台设备不会退回本机模型：把服务也用 https 发出来（见 DOCKER.md），或者把这里改回默认的 https 地址。':
    'This page is https and this address is http, which the browser blocks outright — and this device does not fall back to the local model: publish the service over https as well (see DOCKER.md), or put the default https address back here.',
  '识别后端换为 {backend}': 'Recognition backend changed to {backend}',
  '下次开始录音时生效': 'takes effect the next time recording starts',
  '翻译': 'Translation',
  '翻译用哪家': 'Which translator',
  '默认谷歌；谷歌用不了会自动换微软。': 'Google by default; if Google is unreachable it switches to Microsoft by itself.',
  '翻译攒几句一起发': 'Batch translations',
  '攒多几句一起发：省流量，但更慢。': 'Sending several at once saves data but is slower.',
  '记住翻过的句子': 'Remember translated sentences',
  '同一句话不重复翻译。': 'The same sentence is never translated twice.',
  '谷歌 API 密钥（可选）': 'Google API key (optional)',
  '不用填。': 'Not needed.',
  '留空即可': 'Leave it empty',
  'AI 模型的密钥': 'AI model key',
  '只存在这台设备上。': 'Stays on this device only.',
  'AI 模型接口格式': 'AI model API format',
  '不确定就用 OpenAI 兼容。': 'If unsure, use OpenAI-compatible.',
  'OpenAI 兼容': 'OpenAI-compatible',
  'AI 模型地址': 'AI model base URL',
  'AI 模型名称': 'AI model name',
  '朗读引擎': 'Read-aloud engine',
  '系统朗读（默认）': 'System voice (default)',
  'Edge TTS 代理': 'Edge TTS proxy',
  'TTS 代理地址': 'TTS proxy address',
  '你自己的 Edge TTS 代理（这个项目配的是 cloudflare-edge-tts）。音色表就是从它读的：改完地址、离开这一格，朗读设置里的音色下拉会重新读取。想确认通不通，去下面跑一次自检，看「朗读试读」那一行。':
    'Your own Edge TTS proxy (this project ships with cloudflare-edge-tts). The voice list is read from it: change the address, leave the field, and the voice picker in the read-aloud settings reads it again. To check reachability, run the self-check below and look at the “read-aloud test” line.',
  '朗读基础语速': 'Base read-aloud rate',
  '忙时自动加速': 'Speed up when busy',
  '译文堆积时自动读快一点。': 'Read a little faster when translations pile up.',
  '加速上限': 'Rate ceiling',
  '太快会听不清。': 'Too fast and it cannot be followed.',
  '录音与存储': 'Recording and storage',
  '保存整场录音': 'Keep the whole recording',
  '整段声音都存在手机上：可以回放、导出，也能重新识别某一句话。':
    'The whole session is kept on the phone: replay it, export it, and recognise a sentence again from it.',
  '录音最长保存': 'Keep recording for at most',
  '录到这里就停止保存录音，识别不受影响。': 'Recording stops being saved here; recognition is unaffected.',
  '{n} 分钟': '{n} minute|{n} minutes',
  '当前录音': 'Current recording',
  '删除': 'Delete',
  '按日期编号，每改一次手动加一位：20260926 就是 2026-09-26 这一版；同一天发第二次写成 20260926.2。反馈问题时把这个号一起说，就知道是哪一版了。':
    'A date, bumped by hand once per change: 20260926 is the build from 2026-09-26, and a second release the same day becomes 20260926.2. Quote it in a bug report and everyone knows which build you are on.',
  '调试模式': 'Debug mode',
  '打开后，识别、翻译、朗读和日志的高级设置会出现在下面，识别过程也会在原文栏里展开细节。':
    'Once on, the advanced settings for recognition, translation, read-aloud and the log appear below, and recognition details unfold in the original-text panel.',
  '打开调试模式后，识别、翻译、朗读和日志的高级设置会出现在这里。':
    'Turn on debug mode and the advanced settings for recognition, translation, read-aloud and the log appear here.',
  '诊断工具': 'Diagnostics tools',
  '朗读引擎和音色在底栏的朗读设置里。': 'The read-aloud engine and voice are in the read-aloud settings at the bottom of the screen.',
  '「翻译用哪家」在底栏的朗读设置里，音色和朗读引擎也在那里。':
    '“Which translator” is in the read-aloud settings at the bottom of the screen, along with the voice and the read-aloud engine.',
  '记录详细程度': 'How much to log',
  '调试会记录每次识别和翻译的细节。': 'Debug records the details of every recognition and translation.',
  '普通': 'Normal',
  '只看警告': 'Warnings only',
  '只看错误': 'Errors only',
  '日志保留条数': 'Log lines kept',
  '恢复默认设置': 'Reset to defaults',
  '当前语向：{from} → {to}。语音在手机里识别，只有译文文字会上网。':
    'Language pair: {from} → {to}. Speech is recognised on the phone; only translated text goes online.',

  // ── StatusBar.svelte ──────────────────────────────────────────────────────
  '操作失败：{error}': 'That did not work: {error}',
  '未知': 'unknown',
  '已取消安装识别模块（{reason}）': 'Cancelled installing the recognition module ({reason})',
  '暂停录音': 'Pause recording',
  '继续录音': 'Resume recording',
  '取消启动': 'Cancel starting',
  '开始录音': 'Start recording',
  // The labels on the two status-bar pills, which sit side by side in a phone's
  // width: the full sentences above are what a screen reader and the tooltip get.
  '录音': 'Record',
  '暂停': 'Pause',
  '继续': 'Resume',
  '取消': 'Cancel',
  '静音': 'Muted',
  '跳到最新（落后 {sec} 秒）': 'Skip to newest ({sec}s behind)',

  // ── SubtitleBar.svelte ────────────────────────────────────────────────────
  '流水线状态': 'Pipeline status',
  '还没识别的': 'not recognised yet',
  '还没翻译的': 'not translated yet',
  '还没读的': 'not read out yet',
  '翻译失败的，点译文可以重试': 'failed translations — tap the translation to retry',
  '失败': 'Failed',
  '朗读落后了多久': 'how far read-aloud is behind',
  '滞后': 'Behind',
  '正在自动加速': 'speeding up automatically',
  '语速': 'Rate',

  // ── TitleBar.svelte ───────────────────────────────────────────────────────
  '识别语言切换为{lang}': 'Recognition language switched to {lang}',
  '下次开始录音时会加载对应模块': 'the matching module loads the next time recording starts',
  '译文语言切换为{lang}': 'Translation language switched to {lang}',
  '打开导航': 'Open the menu',
  '语言选择': 'Language pair',
  '说': 'Speak',
  '源语言': 'Source language',
  '译': 'Into',
  '译文语言': 'Translation language',
  '返回': 'Back',
  '打开设置': 'Open settings',
  '← 返回': '← Back',
  '打开日志与自检': 'Open the log and self-check',

  // ── TranslationPanel.svelte ───────────────────────────────────────────────
  '翻译失败': 'Translation failed',
  '翻译结果': 'Translation result',
  '译文': 'Translation',
  '导出译文': 'Export the translation',
  '已导出译文（{n} 句）': 'Exported the translation ({n} sentences)',
  '朗读音色': 'Read-aloud voice',
  '正在读取音色…': 'Reading the voice list…',
  '音色读取失败（见日志）': 'Could not read the voice list (see the log)',
  '没有可用音色': 'No voices available',
  '默认音色': 'Default voice',
  '（网络）': ' (online)',
  '暂停自动朗读': 'Pause reading aloud',
  '恢复自动朗读': 'Resume reading aloud',
  '翻译来源：{source}': 'Translated by {source}',
  '译文会出现在这里。': 'Translations appear here.',
  '从这里开始读': 'Read aloud from here',
  ' · 缓存': ' · cached',
  '正在朗读…': 'Reading aloud…',
  '重试': 'Retry',

  // ── ReadSettings.svelte ───────────────────────────────────────────────────
  '朗读设置': 'Read-aloud settings',
  '完成': 'Done',
  '点完成': 'tapped Done',
  '翻译引擎换为{name}': 'Translator switched to {name}',
  '默认谷歌；谷歌用不了会自动换微软。AI 模型要先在调试设置里填好密钥，才能选这一项。':
    'Google by default; if Google is unreachable the app switches to Microsoft. The AI model needs its key filled in under the debug settings before it can be chosen here.',
  '（需要先填密钥）': ' (needs a key first)',
  '默认用系统自带的朗读：不需要网络，句子之间几乎没有间隙，手机上还能在「设置 → 辅助功能 → 朗读内容」里装更好的音色。换成「Edge TTS 代理」则读的是微软的在线神经音色（你自己的代理，见调试设置），各平台听起来一样好，代价是每句一次网络请求、断网时读不出来。':
    'The system’s own speech by default: it needs no network, leaves almost no gap between sentences, and on a phone you can install better voices under Settings → Accessibility → Spoken Content. “Edge TTS proxy” reads Microsoft’s online neural voices through your own proxy (see the debug settings) — the same quality everywhere, at the cost of one network request per sentence and nothing at all when offline.',
  '没填 TTS 代理地址（在调试设置里）': 'No TTS proxy address set (see the debug settings)',
  '这个浏览器不支持语音朗读': 'This browser cannot speak',
  '语速、自动加速和 TTS 代理地址在调试设置里。': 'Speed, automatic speed-up and the TTS proxy address are in the debug settings.',

  // ── SessionClock.svelte ───────────────────────────────────────────────────
  '录音时长': 'How long this recording has been running',
  '下载录音': 'Save the recording to this device',

  // ── StartPage.svelte ──────────────────────────────────────────────────────
  '正在准备识别模块，第一次会慢一些': 'Getting the recognition module ready — the first time takes a while',
  '启动失败，再试一次': 'That did not start; try again',
  '再试一次': 'Try again',
  '历史记录': 'History',
  '{n} 条记录': '{n} note|{n} notes',

  // ── NavDrawer.svelte ──────────────────────────────────────────────────────
  '导航': 'Menu',
  '主页': 'Home',
  '开始翻译': 'Start translating',
  '版本 {version}': 'Version {version}',
  '关于': 'About',

  // ── PausePanel.svelte ─────────────────────────────────────────────────────
  '录音已暂停': 'Recording paused',
  '开启新录音': 'Start a new recording',
  '保存': 'Save',
  '保存中…': 'Saving…',
  '保存到历史记录': 'Save to the notes',
  '保存失败：{message}': 'Could not save it: {message}',
  '已暂停录音': 'Recording paused',
  '已继续录音': 'Recording resumed',
  '继续录音失败：{message}': 'Could not open the microphone again: {message}',

  // ── SaveNoteDialog.svelte ────────────────────────────────────────────────
  '名称': 'Name',
  '日期': 'Date',
  '定位': 'Place',
  '正在获取定位…': 'Finding where this is…',
  '记录定位：{place}': 'Place for this note: {place}',
  '来源': 'Source',

  // ── HistoryView.svelte, and the notes behind it ──────────────────────────
  '记录详情': 'Note details',
  '共 {n} 条 · {size}': '{n} note · {size}|{n} notes · {size}',
  '选择': 'Select',
  '新': 'New',
  '重命名': 'Rename',
  '已重命名': 'Renamed',
  '读取中…': 'Loading…',
  '已选 {n} 条': '{n} selected',
  '全选': 'Select all',
  '取消全选': 'Clear the selection',
  '删除历史记录': 'Delete notes',
  '删除 {n} 条记录？录音和文字都会一起删掉，删了找不回来。':
    'Delete {n} note? Its audio and its text go with it, and it cannot be undone.|Delete {n} notes? Their audio and their text go with them, and it cannot be undone.',
  '还没有历史记录：录完一场，在暂停面板里点「保存」。':
    'No notes yet: record a session and tap “Save” on the pause panel.',
  '没有录音（记录时关闭了「保存整场录音」）':
    'No audio (the recording was not being kept when this was recorded)',
  '这一场没有识别到文字': 'Nothing was recognised in this session',
  '这个浏览器不能长期保存：这些记录关掉页面就没了。':
    'This browser cannot keep anything long term: these notes go when the page does.',
  '这条历史记录读不出来了（可能已被删除）': 'That note could not be read (it may have been deleted)',
  '已存为历史记录：{title}': 'Saved as a note: {title}',
  '已重命名历史记录：{title}': 'Note renamed: {title}',
  '已删除 {n} 条历史记录': 'Deleted {n} note|Deleted {n} notes',
  '这条录音没能存下来：{reason}': 'This recording could not be stored: {reason}',
  '时长': 'Length',
  '句子': 'Sentences',
  '录音文件': 'Audio file',
}
