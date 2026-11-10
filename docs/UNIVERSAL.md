# YH 通用能力（v0.2）

本页说明 v0.2 新增的通用接口。每一项都标明验证状态：**已测** 表示仓库里有会失败的自动测试并已运行；**未验证** 表示代码已写好，但没有在对应的真实软件或硬件上跑过。

## 1. 事件协议 v1

桥接广播的帧：

```json
{"kind":"osc","v":1,"seq":12,"tMs":351.2,"address":"/yh/level","typeTags":"fs","args":[0.42,"cables"],"sourceId":"cables","source":{"address":"127.0.0.1","port":51930}}
```

- `args[0]` 仍是数值，旧接入端不用改。
- `sourceId` 标明事件来自哪个输入源。WebSocket 客户端用构造参数 `sourceId`（`[A-Za-z0-9_.-]{1,32}`）；没填则桥接分配 `ws-N`。外部 OSC/UDP 发送者标为 `osc-<ip>:<port>`，不能自称其他 sourceId（只有桥接自己的回环发送口携带的 sourceId 才被采信）。
- `tMs` 和 `seq` 仍是桥接接收时刻与序号，不是音频采集时刻。
- 桥接每 2 秒发一条 `{"kind":"status","status":"heartbeat"}`。`YHEventClient` 超过 `staleMs`（默认 8 秒）没收到任何帧，就判定断线并重连。

地址约定：

| 地址 | 含义 |
|---|---|
| `/yh/level` | 0–1 连续电平 |
| `/yh/onset` | 一次性瞬态脉冲（值 1） |
| `/yh/band/low` `/yh/band/mid` `/yh/band/high` | 0–1 频段能量（约 20–250 Hz、250–2000 Hz、2–12 kHz），取自浏览器 `AnalyserNode` 的字节频谱，是相对值，未标定 |

状态：**已测**（`test/bridge.test.mjs`、`test/microphone.test.mjs`）。

## 2. 连接可靠性与访问控制

- `YHEventClient` 默认指数退避自动重连（250 ms 起，上限 5 s），`connect()` 重复调用共用同一个 socket。`sendControl()` 在未连接时返回 `false` 并计入 `client.stats.notSent`；它不会排队补发。
- 令牌：设置环境变量 `YH_TOKEN`（或 `startBridge({ token })`）后，WebSocket 必须带 `?token=...`。`YHEventClient({ token })` 会自动附加；网页控制台读取页面地址里的 `?token=`。
- 非回环保护：只有 `localhost` 和字面回环 IP（IPv4 `127.0.0.0/8`、`::1`）被视为回环；`127.stage.example` 之类的主机名不算。`WS_HOST` 不是回环地址时，没有 `YH_TOKEN` 桥接拒绝启动。`OSC_HOST` 不是回环地址时，必须设 `YH_ALLOW_REMOTE_OSC=1`。UDP 本身无法认证，开放后同网段任何人都能发送 OSC。
- 来源策略 `YH_SOURCE_POLICY`：`merge`（默认，所有来源并行广播）或 `exclusive`（第一个发 `/yh/*` 的来源独占，其他来源被丢弃，独占者静默 `YH_SOURCE_TIMEOUT_MS`（默认 1500 ms）后交接）。丢弃数见 `bridge.stats().droppedBySource`。被丢弃的事件若来自 WebSocket `control`，桥接会向发送它的 socket 发一条 `{"kind":"status","status":"source-rejected","address":…,"sourceId":…,"owner":…}`（只发给产生这个事件的那条连接，即使别的页面用同一个来源名；每条连接 500 ms 内至多一条，与地址无关；该连接发送缓冲已超限时不发）；外部 UDP 来源没有这条通知。
- 慢客户端的发送缓冲超过 512 kB（`maxBufferedBytes` 选项可调）时，对它丢帧，不拖累其他客户端；丢帧数见 `stats().droppedBackpressure`。
- 来源追踪表最多保留 256 个来源（`maxTrackedSources`），按最近使用淘汰，淘汰数见 `stats().sourcesEvicted`。换 `sourceId` 或换 UDP 端口不会让桥接内存无限增长。`maxTrackedSources` 必须是正整数，`NaN`、负数、0、小数和字符串都会在启动时被拒绝。
- OSC 参数里的 `NaN`、`±Infinity` 无法用 JSON 表示，桥接会丢弃整条消息（任何地址），计入 `stats().droppedNonFinite`，并向客户端发 `{"kind":"status","status":"non-finite-osc","address":…}`；监听者不会收到 `null` 冒充的值。JavaScript 适配器和动画路由对 `null`、`NaN`、`Infinity`、非数字字符串的事件同样忽略，只有没带任何值的 `/yh/onset` 仍按满强度触发。
- `control` 帧的 `value` 必须是 JSON 数字；`null`、字符串、布尔、数组、对象都会被忽略。数值夹到 ±1e6。地址只校验格式，不限制在 `/yh/*` 之下。同一令牌下的客户端可以自报任意合法的 `source`，互相冒充。

仍然没有：TLS、按客户端的权限、命令白名单、丢包重传。令牌只在 URL 查询参数里，不要用在不可信网络上。

状态：**已测**。

### 托管网页与远程桥接

控制台页面既可以在本机打开，也可以托管到服务器。页面选择桥接地址的规则在 `src/bridge-url.mjs`：

- 页面经 http 打开（本机开发）：`ws://<页面主机>:8765/ws`，与以前一致。
- 页面经 https 托管：同源的 `wss://<页面主机>/ws`。浏览器不允许安全页面连接远程的明文 `ws://`，所以服务器上要用反向代理（nginx、Caddy 等）把 `/ws` 转给桥接。麦克风也要求 https 页面才会被浏览器放行。
- `?bridge=ws://127.0.0.1:8765/ws`：让托管页面连接访问者自己机器上的桥接。只接受本机回环地址或页面自己的主机，其他主机会被忽略，避免别人构造的链接把麦克风派生的事件发到别处。

服务器侧：桥接默认只允许本机页面的 Origin。托管页面的来源必须写进 `ALLOWED_WS_ORIGINS`（逗号分隔，如 `https://yh.example.com`，协议和端口都算在内）。桥接放在反向代理后面时，让它继续绑定 `127.0.0.1`；如果直接对外监听，必须设 `YH_TOKEN`。令牌放在页面地址的 `?token=`，会出现在浏览器历史和服务器访问日志里。访问者本机桥接同样要把托管页面的来源写进 `ALLOWED_WS_ORIGINS`。

构建产物使用相对路径（`vite.config.mjs` 里 `base: './'`），可以放在服务器的子目录下。

注意:同一个远程桥接是共享的。所有连到它的页面都会收到彼此的事件,每个访问者的麦克风电平和触发会广播给其他人。要让多人各自独立,每人用自己本机的桥接(`?bridge=`)。

状态:地址选择规则、`ALLOWED_WS_ORIGINS` 的放行与拒绝、构建产物在子路径下的资源解析已有自动测试。**没有在真实 https 服务器、反向代理后验证过**,也没有验证 Chrome 对 https 页面访问 `ws://127.0.0.1` 的本地网络访问提示。

## 3. 输入源

### 浏览器音频输入

`YHMicrophone` 支持：

- `deviceId`：指定麦克风设备。
- `inputKind: 'display'`：捕获标签页或系统音频（`getDisplayMedia`，需要用户在浏览器选择器里勾选共享音频）。
- `onBands`：频段回调，网页控制台已把它接到 `/yh/band/*`。

启动与停止的竞态已修复：权限请求期间调用 `stop()`，之后到达的音频流会被立即释放，不会自行开启。

音轨自己结束（设备被拔出、标签页共享被停止）时，`YHMicrophone` 会停止采样、释放流和 `AudioContext`，调用一次最终 `onLevel(0, 0)`，并以 `{ state: 'error', reason: 'track-ended' }` 通知。曾采集过的会话主动 `stop()` 时也会调用最终零电平，网页的电平模式将该值转发。监听在 `AudioContext.resume()` 之前安装，启动前已结束或等待恢复期间结束的音轨都不会进入运行态。

网页控制台有"音频来源"（麦克风 / 标签页·系统音频）和"输入设备"下拉框，切换时若正在采集会自动按新来源重启。

状态：
- 生命周期、设备参数、标签页音频的轨道处理用假的 `mediaDevices` 做了自动测试（**已测**）。
- 整页在真实 Chromium 里跑过：页面内把 `getUserMedia`/`getDisplayMedia` 替换成合成振荡器流，走通了真实 `AudioContext`/`AnalyserNode`、底噪校准、onset、`/yh/level` 与 `/yh/band/*` 经桥接发出、来源切换（**已测，但音频是合成的，不是真实麦克风**；这次是手动驱动，没有留成自动测试）。
- Windows Chrome 已实测默认 Realtek 麦克风、设备标签、非零电平与频段广播，以及主动停止后第二客户端收到零电平。USB 拔插明确不做(项目只在本机或网页场景使用);真实 `getDisplayMedia` 选择器仍待实测。

网页控制台支持 **仅目标声**，可以录入多个有名字的目标声。开启音频、等待校准、填写 **目标名称**（英文名直接成为地址；中文等名字作为显示名，地址按 `cue`、`cue-2`… 分配，不同名字不会互相覆盖，输入已有名称才替换）、选择录入次数（3–5 次）、点击 **录入目标声**，按提示连续发出同一个短声。当前浏览器保存每个目标的各次录入（32 个梅尔频带的对数频谱形状和音量变化）及按各次差异学到的容差。识别时用动态时间规整（DTW）对齐后比较，并计入时长差异。某个目标匹配时，桥接先收到一次 `/yh/cue/<名称>`，再收到一次 `/yh/onset`；接入端订阅 `/yh/cue/<名称>` 就能让不同的声音触发不同的事件，动画如何响应由接入端决定。本地电平表继续更新。可删除单个目标、清除全部或切回 **电平与起音**；**识别严格度** 缩放所有目标的容差。页面会区分“听到声音但未达门限”和“检测到声音但不是目标声”（附最接近的目标、匹配度和时长、频谱或音量变化原因）。拍手这类响度不一的短促声按自身峰值的 10% 判定结束。各次录入差异过大或混进两种不同的声音时拒绝保存。超过 1.25 秒的声音不参与识别，页面会提示。没有目标声时不能进入仅目标声模式（选择会被拒绝并提示先录入；录入被取消、超时、无效、各次差异过大或因停止采集而中断时，回到录入前的模式）。桥接在 `exclusive` 下丢弃这些事件时，页面会提示触发已被丢弃。旧版单样本格式（`yh.sound-cue.v1`）不兼容，需重新录入。识别流程已用合成信号和 Chrome 文件注入整页验证；用户另报告在这台电脑的真实麦克风上手动测试了新识别器，拍手、响指都能触发（来源是用户报告；我没有亲自验证，也没有留下录音、匹配度或容差数据）。现场背景声下的误触发率没有量化，效果取决于用户录入的声音和环境。目标声、严格度和 RMS 最低门限保存在浏览器里，同一浏览器的多个控制台页面共享：保存时只改本次动作涉及的部分，另一页的改动会同步过来，不会用旧内容覆盖。模式（电平与起音 / 仅目标声）只在你切换下拉框或录入成功时保存，删除、清除、改严格度和门限不会改动另一页保存的模式（最后一个目标声被删时仍会回到电平与起音）。浏览器存储写入失败时，页面会在状态行提示设置只在本页有效。页面从浏览器后退缓存恢复时会自动重新加载。

### 外部电平源（包括 Cables）

任何能产生 0–1 电平的处理器都可以经 `YHLevelSource` 接入：

```js
import { YHEventClient } from './src/event-client.mjs';
import { YHLevelSource } from './src/sources/level-source.mjs';

const client = new YHEventClient({ sourceId: 'cables' });
await client.connect();
const source = new YHLevelSource(client);   // detectOnsets 默认 true，复用麦克风同一套底噪门控
source.pushLevel(0.37);                      // 处理器每帧调用
// 上游已有最终 onset 时：new YHLevelSource(client, { detectOnsets: false }) 然后 source.pushOnset()
```

规则：整条链路里只让一级负责 onset 判定，否则会重复触发。

Cables 侧的两条候选路径（都是协议上可行，**未在真实 Cables 中验证**）：

1. 如果 Cables patch 能向 `127.0.0.1:9000` 发 OSC，直接发 `/yh/level` 和 `/yh/onset`，桥接会把它标为 `osc-127.0.0.1:<port>`。
2. 如果 patch 能运行自定义 JS 或 WebSocket，向 `ws://127.0.0.1:8765/ws` 发 `{"kind":"control","address":"/yh/level","value":0.37,"source":"cables"}`。

同时有麦克风和 Cables 时，用 `YH_SOURCE_POLICY=exclusive` 避免事件交错。

状态：`YHLevelSource` 与桥接来源标记 **已测**；Cables 实际接入 **未验证**。

## 4. 动画映射层

适配器不再只做缩放。`YHAnimationRouter` 把事件映射到驱动器，驱动器对接各引擎的动画系统：

```js
import { YHAnimationRouter } from './src/adapters/animation-router.js';
import { createThreeAnimationDriver } from './src/adapters/animation-drivers.js';

const driver = createThreeAnimationDriver({ mixer, clips: gltf.animations });
const router = new YHAnimationRouter(yh, driver, [
  { type: 'trigger', address: '/yh/onset',    clip: 'Jump', minValue: 0.5, cooldownMs: 250 },
  { type: 'param',   address: '/yh/level',    param: 'Walk:weight', smoothing: 10 },
  { type: 'param',   address: '/yh/band/low', param: 'Walk:timeScale', min: 0.5, max: 2 },
  { type: 'param',   address: '/yh/band/high', apply: v => { material.emissiveIntensity = v * 3; } },
  { type: 'gate',    address: '/yh/level', threshold: 0.5, onEnter: 'Wave', onExit: 'Idle', sourceId: 'cables' }
]);
// 每帧：router.update(deltaSeconds)；结束时 router.dispose()
```

- `trigger`：一次性触发剪辑，强度映射为权重，可设最小值与冷却时间。
- `param`：连续值映射到剪辑权重、播放速度，或任意 `apply(value)` 回调（材质、灯光、后期参数）。
- `gate`：电平持续高于阈值时播放进入动画，回落后播放退出动画（带滞回与持续时间）。
- 每条规则可用 `sourceId` 只听一个来源。

驱动器：

| 引擎 | 驱动器 | 状态 |
|---|---|---|
| Three.js | `createThreeAnimationDriver({ mixer, clips })` | **已测**：用真实 `THREE.AnimationMixer` 与 `AnimationClip`（Node 内，无渲染） |
| Verge3D | `createVerge3DAnimationDriver`（同一实现，因其 `AnimationMixer` 与 Three.js 接口一致） | **未验证**：没有 Verge3D runtime |
| Babylon.js | `createBabylonAnimationDriver({ scene })` | **已测**：用真实 `AnimationGroup`，`NullEngine`，无渲染 |
| Godot 4 | `YHAnimationBinder.gd`（监听 `YHEventNode` 的信号，驱动 `AnimationPlayer`） | **已测**：Godot 4.6.2 无头运行，onset 播放剪辑、level 驱动 `speed_scale` |
| 任意引擎 | `createCallbackDriver({ trigger, setParam, update })` | **已测** |

Godot 的 binder 目前支持 onset 触发、level→速度、level 门限进入/退出动画，以及 `add_trigger_rule(address, animation, min_value, cooldown_ms)`。没有 `AnimationTree` 状态机或 Tween 映射。

## 5. 保留对象原有缩放

Three.js、Babylon.js、Verge3D 和 Godot 的缩放适配器默认用 `scaleMode: 'relative'`：构造时的缩放就是常态，响应按倍数叠加，非均匀比例保持不变，`dispose()` 恢复原缩放，`dispose()` 之后继续调用 `update()` 不会再写对象。需要旧行为时传 `scaleMode: 'absolute'`（Godot 是 Inspector 的 `scale_mode`）。

注意：相对模式下，常态大小等于对象原大小；旧版常态是 1.129 倍。

**其他系统也写缩放时**（`AnimationMixer` 的缩放轨道、脚本、编辑器）：相对模式发现对象缩放不等于适配器上次写入的值，就把当前值当作新的常态，再把响应倍数乘上去（`followExternalScale`，默认开）。`dispose()` 时如果对象已被外部改过，不再强行恢复。动画必须在适配器 `update()` 之前运行。不想要这个行为时传 `followExternalScale: false`（Godot：`follow_external_scale`）。

**Three.js 模型本身有缩放轨道时**，给模型加一层 `THREE.Group`，让 `AnimationMixer` 驱动模型，让 YH 驱动外层 `Group`。这样动画混合和停止时读取的模型常态不会包含音频缩放。

```js
const audioRoot = new THREE.Group();
scene.add(audioRoot);
audioRoot.add(gltf.scene);

const mixer = new THREE.AnimationMixer(gltf.scene);
const adapter = new YHThreeAdapter(yh, audioRoot);
// 每帧推进 mixer.update(deltaSeconds) 和 adapter.update(deltaSeconds)。
```

**事件流丢失时**：客户端报告 `disconnected`、`error` 或 `stale` 后，适配器和动画路由会回到常态（缩放回落；`param` 规则回到 `min`；活动的 `gate` 触发一次 `onExit`）。可选 `levelStaleMs`（适配器）/`staleMs`（路由）：某个电平地址静默超过这个时间也回落。默认是 0，即保持最后一个值，因为网页的滑块和某些外部源会发送一次后长期保持。Godot 对应 `level_stale_ms`；断线和电平静默统一发出 `level_released`，`YHAnimationBinder` 收到后退出 gate 并恢复 `speed_scale`。

**构造校验**：`minScale`/`maxScale` 必须是有限数且 `minScale <= maxScale`；相对模式还要求常态缩放为正，否则抛 `RangeError`（不会写入 `NaN`）。

状态：用真实 Three.js r187 的 `AnimationMixer` 和缩放轨道验证了父子节点方案的半权重混合、动画停止和 `dispose()`。直接写同一个节点时，动画在音频放大后启动可能叠乘两次，动画值恰好等于 YH 上一帧写入时也可能漏叠加。Godot 的相对缩放、外部写入采纳和静默回落由无头场景覆盖，真实断线分支尚未自动验证。

## 6. 仍未做的事

- 网页控制台没有动画规则编辑界面（规则只能写在代码里）。
- 没有音频文件播放源、MIDI 输入、节拍/音高检测。onset 仍是整帧 RMS 越限状态机。
- 没有 TLS、按客户端权限、事件确认与重传、音频采集时间戳。
- Verge3D 真实引擎、真实 Cables、真实 `getDisplayMedia` 选择器：没有验证。USB 麦克风拔插：明确不做,不在使用场景内。
- 页面在桥接重启后的自动重连：`YHEventClient` 的重连有 Node 自动测试，但没有在整页里实测（Vite 开发服务重启会强制刷新页面，不便观察）。
- 没有设备协议网关、安全互锁与认证。这些仍须放在独立控制层，YH 不承担安全关键控制。
