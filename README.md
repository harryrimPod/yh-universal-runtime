# YH Universal Runtime

YH 的本机通用音频事件原型：浏览器直接获取麦克风，在本地计算音频电平与触发，再经统一接口把事件送到引擎。

## English summary

YH Universal Runtime is a local-only prototype that turns microphone audio into engine-agnostic events. The browser analyses audio on-device (RMS level, three frequency bands, onset detection, and user-recorded "target sound" matching using a log-mel + DTW matcher), and a small Node bridge fans the events out as OSC-style messages over WebSocket (`ws://127.0.0.1:8765/ws`) and UDP (`127.0.0.1:9000`). Adapters are included for Three.js, Babylon.js, Verge3D and Godot 4. No raw audio is uploaded or stored; target-sound features are kept in the browser's `localStorage`.

Quick start: install Node.js 22.12+ (or 20.19+), run `npm ci`, then `node scripts/dev.mjs` and open `http://127.0.0.1:5173`. On Windows you can double-click `Start_YH.bat`. Tests: `node --test` (162 tests); Godot headless tests: `node scripts/run-godot-tests.mjs` (set `GODOT_BIN`).

License: Apache License 2.0 (see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for third-party attributions).

Status: v0.2 prototype, not a certified product. Verified on one Windows machine with one microphone array; false-trigger rates in noisy venues, hosted https deployment, and several engines/versions are not verified. See the Chinese sections below for the full list. The Verge3D runtime is proprietary and is not included.

页面本身是一个本地 Web 应用，内置演示场景用于验证事件链路。服务只在本机运行，不会发布到公网，也不会上传或保存原始音频。

## 运行（Windows）

1. 解压 ZIP 文件夹。
2. 双击其中的 **`Start_YH.bat`**。启动器自动查找 PATH 里的 Node.js（也可用环境变量 `YH_NODE_EXE` 指定 `node.exe`）；首次启动时按需安装依赖（需要联网），服务就绪后自动打开浏览器。

不需要打开 PowerShell 或输入启动命令。保持启动窗口打开，按 **Ctrl+C** 可停止服务；停止后按任意键关闭窗口。如果提示找不到 Node.js，请安装 Node.js **22.12+**（或 20.19+）后再双击启动器。应用运行期间只连接本机 `127.0.0.1`，不会发布到公网。

打开页面后点击 **开启麦克风** 并允许权限；系统会用约 1.2 秒的普通环境声估算底噪，不要求环境绝对安静，随后持续自适应跟踪底噪并抑制持续背景声。黄色门限标记调节最低触发门限；只有信号同时超过它并明显高于底噪时，才发送 `/yh/onset`。演示对象的场景响应另有低电平门控、滞回与平滑；它会根据估算底噪提高独立的缩放响应门限，低于门限的起伏不会驱动模型。显著较大的连续电平仍会平滑改变大小，`/yh/onset` 仍会独立触发短暂放大。关闭麦克风会停止分析并释放音轨。

若暂时不使用麦克风，可拖动 **基准电平**滑杆或点击 **发送合成 onset**。连续 `/yh/level` 仍按原频率发送给接入端，不逐帧堆积；事件监视器只汇总显示它的最新值，`/yh/onset` 与其他事件仍逐条记录。这些按钮是合成事件链路测试，不是实际麦克风测试。`Ctrl+C` 关闭本地服务。

### 用目标声音触发

1. 开启音频，等底噪校准完成。先看实时 RMS，把 **最低门限** 调到背景声与目标声之间（按钮旁有同样的提示）。
2. 在 **目标名称** 填一个名字，选 **录入次数**（3、4 或 5 次），点击 **录入目标声**。英文名（如 `clap`、`door`）会直接成为地址 `/yh/cue/clap`；中文等名字（如「拍手」）会作为显示名，地址按顺序分配为 `/yh/cue/cue`、`/yh/cue/cue-2`…，列表里每个目标都标着它的地址。再次输入已有的名称或显示名会替换那个目标声（录入提示里会写明），输入其他名字总是新增一个，不会覆盖。删除过的目标，它的自动分配地址不会再分给别的声音（避免仍订阅旧地址的场景被新声音误触发）；自己输入英文地址则视为有意复用。
3. 按提示依次发出同一个短声，每次发声后停顿。页面显示「第 n/m 次已录入」后再来下一次。几次之间的差异决定这个声音的 **容差**：你每次发得越一致，容差越小；几次差异太大，或者混进了两种不同的声音（比如两次拍手、两次响指），页面会提示重录，不会保存。
4. 录完后控制台切换到 **仅目标声**。再发出该声音时，桥接先收到 `/yh/cue/<名称>`（说明是哪一个声音），再收到一次 `/yh/onset`（任何目标声都会发，方便已有接入端直接使用）。电平表仍会显示输入，采集通道只在匹配时发送这些事件。

可以录入多个目标声，各自有名字、地址和容差，下方列表可逐个删除，**清除全部** 会回到 **电平与起音**。接入端订阅 `/yh/cue/<名称>` 就能让不同声音驱动不同的动画或事件；本工具只负责识别并发出事件，动画怎么做由接入端决定。**识别严格度**（严格 / 标准 / 宽松）统一缩放所有目标声的容差：误触发多就调严格，漏识别多就调宽松。

识别方法：每段声音取 32 个梅尔频带的对数频谱形状和相对自身峰值的音量变化，用动态时间规整（DTW）对齐后比较，再加上时长差异，不再把声音固定切成 12 片。因此拍手、短音、提示音这类 1.25 秒以内的短声都能录入。同一个声音多录几次，比只录一次更稳。录入后请用实际场地的目标声和背景声试一下，确认识别效果。

目标声模式下页面会区分几种“没触发”：「听到声音但未达门限」（峰值接近但低于有效门限，请调低 RMS 最低门限或靠近麦克风）、「检测到声音但不是目标声」（附最接近的目标、匹配度和原因：时长、频谱或音量变化），以及「持续超过 1.25 秒」（太长的声音不参与识别，页面会说明）。安静环境里一个突然出现的轻声，只要达到门限的约 30% 也会提示「未达门限」；稳定的背景声不提示，低于约 30% 门限的声音没有任何提示。提示只显示 4 秒。新录入的目标声与已有目标声很像时，录完会提醒可能互相误识别。

**旧版本保存的单样本格式（`yh.sound-cue.v1`）不再兼容**，页面会提示重新录入（旧数据只读不删，你录入新目标声之前这条提示一直在，旧版页面仍能用它）。尚未做背景噪声谱扣除，也没有量化真实场地的误触发率。相近音高（如 520 与 540 Hz）区分力有限。

本机已验收的目标声是 [yh-target-cue.wav](./public/examples/yh-target-cue.wav)。用扬声器播放此文件录入（需连续播放 3 次，每次之间停顿），再用同一文件触发。该验收在多次录入改版之前完成。改版后的识别器见下文“本地验证”一节的说明。本次实测最低 RMS 门限为 `0.004`，可作为参考值先试；页面默认门限仍是 `0.010`，调整后的门限会随目标声保存在浏览器里、刷新后恢复；实际使用按扬声器音量和背景声调整。自动建议门限留待有更多音量和设备数据后再做。

## 本机边界与麦克风数值

页面及桥接默认只绑定到 `127.0.0.1`。WebSocket 使用 `ws://127.0.0.1:8765/ws`；OSC/UDP 接收端为 `127.0.0.1:9000`。麦克风样本由浏览器的 Web Audio API 在本机处理；内置麦克风链路只向桥接发送归一化数值事件，不发送 PCM 音频（桥接的 OSC 解码器本身能处理字符串和二进制，外部本机程序可以发送任意 OSC）。默认只绑定回环地址；`WS_HOST` 或 `OSC_HOST` 改成非回环地址需要 `YH_TOKEN` / `YH_ALLOW_REMOTE_OSC=1`。应用没有联网分析、云端端点或录音保存功能。浏览器只在安全环境（https 页面，或 `localhost` / `127.0.0.1`）下放行麦克风。

最低门限默认 **0.010 corrected RMS**，可调 **0.001–0.050**，检测使用浏览器的零中心 `Float32` 波形样本；另用滚动中位数跟踪约 1.2 秒的环境底噪，有效触发门限取最低门限与底噪相对门限中的较高值。该数值未经设备增益或声学标定，不应解释为 dBFS 或 dB SPL。发送的 `/yh/level` 是 `clamp(rms / 0.25, 0, 1)` 得到的连续归一化电平，不能与 RMS 门限直接比较；`/yh/onset` 是明显高于背景的瞬态脉冲（值为 `1`），带有滞回、100 毫秒安静重置和短暂重触发间隔。场景适配层对低电平数据的处理不会改写或停止 `/yh/level` 输出。

## 托管网页

控制台页面可以托管到服务器，桥接可以放在同一台服务器（反向代理转发 `/ws`），也可以让访问者各自用本机桥接（页面地址加 `?bridge=ws://127.0.0.1:8765/ws`）。托管页面的来源要写进桥接的 `ALLOWED_WS_ORIGINS`。远程桥接是共享的，所有页面互相收到事件。详见 [托管网页与远程桥接](./docs/UNIVERSAL.md#托管网页与远程桥接)。这条路径只有自动测试，没有在真实 https 服务器上验证过。

## 通用 YH 事件 API

所有适配器遵循相同的两个地址：

- **`/yh/level`**：0–1 的连续归一化电平。原始数据保持持续输出；接入端可将其映射到对象缩放或其他连续参数，并在场景响应层设置低电平门限及平滑。
- **`/yh/onset`**：瞬态触发脉冲（通常为 1）。触发后短暂放大，再平滑回落到稳定的常态大小；此触发不受连续电平的低电平门限影响。

JavaScript 适配器默认要求 `/yh/level` 连续高于 `0.18` 至少 `120 ms` 才开始驱动缩放，低于 `0.12` 持续 `180 ms` 后回到常态；响应随时间平滑过渡。内置演示场景还会根据测得底噪自动把门限提高到至少归一化底噪的 `1.8` 倍（上限 `0.75`）。适配器可用构造选项 `levelThreshold`、`levelReleaseThreshold`、`levelAttackMs`、`levelReleaseMs`、`levelSmoothing` 与 `restLevel` 调整场景响应，也可运行时调用 `setLevelThreshold(value)`；这些设置不改变通过统一接口的电平数据。

本机 WebSocket 接收帧示例：

```json
{"kind":"osc","v":1,"seq":12,"tMs":351.2,"address":"/yh/level","typeTags":"fs","args":[0.42,"yh-web"],"sourceId":"yh-web","source":{"address":"127.0.0.1","port":51930}}
```

`args[0]` 是数值，`sourceId` 标明输入源。v0.2 新增的频段地址 `/yh/band/low|mid|high`、重连与令牌、来源策略、外部电平源（如 Cables）、动画映射层，见 [`docs/UNIVERSAL.md`](./docs/UNIVERSAL.md)，其中逐项标注了已测与未验证的范围。

引擎侧 `YHEventClient` 将帧归一化为 `{ kind:'event', address, value, args, seq, timeMs, source }`，可直接监听地址：

```js
import { YHEventClient } from './src/event-client.mjs';
const yh = new YHEventClient({ url: 'ws://127.0.0.1:8765/ws' });
await yh.connect();
yh.on('/yh/level', event => console.log('level', event.value));
yh.on('/yh/onset', event => console.log('onset', event.value));
yh.sendControl('/yh/onset', 1); // 测试：经本机 OSC/UDP 回环广播
```

若使用 OSC 而非 WebSocket，直接向 `127.0.0.1:9000` 发送 OSC 1.0 消息即可。所有地址在 YH 中保持 `/yh/level` 与 `/yh/onset`。

## 引擎适配示例

- **Three.js**：[`src/adapters/three.js`](./src/adapters/three.js) — `YHThreeAdapter(client, object3D)`，每帧调用 `adapter.update(deltaSeconds)`。
- **Verge3D**：[`src/adapters/verge3d.js`](./src/adapters/verge3d.js) — `YHVerge3DAdapter(client, object3D)`；在 Verge3D 场景加载完成后把对象传入，每帧调用 `update(delta)`。
- **Babylon.js**：[`src/adapters/babylonjs.js`](./src/adapters/babylonjs.js) — `YHBabylonAdapter(client, mesh)`，每帧调用 `update(deltaSeconds)`。
- **Godot 4**：[`src/adapters/godot/YHEventNode.gd`](./src/adapters/godot/YHEventNode.gd) — 将脚本挂在 `Node`，把 `target_path` 指向要缩放的 `Node3D`。

前三个 JavaScript 适配器复用同一个 `YHEventClient`，Godot 4 使用原生 `WebSocketPeer` 读取相同 JSON 帧。Three.js、Babylon.js 与 Godot 都有独立的可运行样例；Verge3D 样例需使用本机安装的 runtime（不在此分发）。样例目录与验证矩阵见 [`examples/README.md`](./examples/README.md)，接入代码见 [`docs/ENGINE_INTEGRATION.md`](./docs/ENGINE_INTEGRATION.md)。
想把自己的场景对象接入 YH，可先看一页版[对象接入快速指南](./docs/CONNECT_YOUR_OBJECT.md)，其中按四种引擎分别说明对象查找、适配器挂接和更新入口。

## 四个最小引擎样例

启动本机服务后，可直接打开 Three.js：`http://127.0.0.1:5173/examples/threejs/`、Babylon.js：`http://127.0.0.1:5173/examples/babylonjs/`，或 Verge3D：`http://127.0.0.1:5173/examples/verge3d/`。Verge3D 需要先把本机安装的 runtime 文件复制到 `public/vendor/verge3d/`；引擎没有随包分发。

Godot 4 项目在 `examples/godot/project.godot`；保持本机桥接运行后，用 Godot 打开此项目。可运行自动回环测试：`godot --headless --path .\examples\godot res://tests/test_runner.tscn`。具体说明和实际测试矩阵在 [`examples/README.md`](./examples/README.md)。

## 本地验证

```powershell
npm test
npm run build
```

v0.2 的 `npm test` 共 162 项（Node，含真实 Three.js `AnimationMixer`、Babylon.js `NullEngine` 动画组、桥接令牌/来源策略/重连/心跳、`npm run bridge` 入口、麦克风启停竞态、目标声音匹配）。Godot 的三个回环测试用 `npm run test:godot`（即 `node scripts/run-godot-tests.mjs`）运行（自动启动并关闭桥接，需要本机 Godot 4.x，路径可用 `GODOT_BIN` 指定，且 8765/9000 端口须空闲），详见 [`examples/README.md`](./examples/README.md)。

测试覆盖合成 440 Hz 波形、稳态和轻微起伏的背景噪声抑制、校准与重触发、场景电平门控与滞回、适配器缩放及独立 onset 脉冲，以及 `/yh/level` 和 `/yh/onset` 的 WebSocket → OSC/UDP 回环链路。Three.js 和 Babylon.js 的浏览器样例已启动验证。Godot **4.6.2** 的三个无头场景均通过，4.7.x 尚未在当前环境复验。Verge3D 只验证了本地 glTF 资产，真实 runtime 尚未运行。

Windows Chrome 已用真实 Realtek 麦克风阵列完成本机验收（这是单样本识别器时的结果。多次录入、梅尔 + DTW、多目标的新识别器：我用合成信号和 Chrome 文件注入验证过；用户另报告在这台电脑的真实麦克风上手动测试了新识别器，拍手、响指都能触发（来源是用户报告；我没有亲自验证，也没有留下录音、匹配度或容差数据）。现场背景声下的误触发率仍未量化）。默认扬声器播放的参考短音可录入，重放三次各触发一次，异频短音和同频长音均未触发。实机也验证了独占丢弃提示、无样本选择和清除样本回退。主动停止后，第二个 WebSocket 客户端收到电平和三个频段的四个零值。验收范围为这台电脑本机运行，USB 拔插不在验收范围内。最终目标声可在确定后用实际背景音试录。逐次的录音数据和原始记录未随仓库发布。
