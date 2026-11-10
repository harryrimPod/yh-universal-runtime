# 引擎接入示例

详细运行版样例见 [`examples/README.md`](../examples/README.md)：[Three.js](../examples/threejs/)、[Babylon.js](../examples/babylonjs/)、[Verge3D](../examples/verge3d/) 与 [Godot 4](../examples/godot/)。前三者的运行资源均由本地项目或用户本机引擎提供，Godot 使用单独的 Godot 项目。所有运行时都连本机 `ws://127.0.0.1:8765/ws`；不访问公共服务。Verge3D runtime 未随包分发，须从本机安装中拷入 `public/vendor/verge3d/`。

## Three.js

```js
import { YHEventClient } from '../src/event-client.mjs';
import { YHThreeAdapter } from '../src/adapters/three.js';

const yh = new YHEventClient();
await yh.connect();
const adapter = new YHThreeAdapter(yh, orb); // orb: THREE.Object3D
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => adapter.update(clock.getDelta()));
// 结束场景时：adapter.dispose(); yh.close();
```

## Verge3D

Verge3D 的场景对象提供 Three.js 兼容的 `Object3D.scale` 向量。待 Verge3D 场景加载完成、目标对象已存在后，连接 YH 并添加 adapter：

```js
import { YHEventClient } from '../src/event-client.mjs';
import { YHVerge3DAdapter } from '../src/adapters/verge3d.js';

const yh = new YHEventClient();
await yh.connect();
const target = app.scene.getObjectByName('YH_Target');
if (!target) throw new Error('Missing YH_Target in the Verge3D scene');
const adapter = new YHVerge3DAdapter(yh, target);

// Verge3D App 暴露 renderCallbacks；deltaSeconds 使用秒。
let lastFrame = performance.now();
app.renderCallbacks.push(() => {
  const now = performance.now();
  adapter.update(Math.min(0.05, (now - lastFrame) / 1000));
  lastFrame = now;
});
```

Adapter 不替换 Verge3D 的启动、场景加载或渲染循环，仅处理共享的两个 YH 地址。

## Babylon.js

```js
import { YHEventClient } from '../src/event-client.mjs';
import { YHBabylonAdapter } from '../src/adapters/babylonjs.js';

const yh = new YHEventClient();
await yh.connect();
const adapter = new YHBabylonAdapter(yh, mesh); // mesh: BABYLON.Mesh
scene.onBeforeRenderObservable.add(() => adapter.update(engine.getDeltaTime() / 1000));
// 结束场景时：adapter.dispose(); yh.close();
```

## Godot 4

可直接打开 [`examples/godot/project.godot`](../examples/godot/project.godot) 运行完整示例；其内 `YHEventNode.gd` 使用 Godot 原生 `WebSocketPeer`。自动化往返测试：先启动根项目桥接，再运行 `godot --headless --path examples/godot res://tests/test_runner.tscn`。如需复制到其他项目，把 `YHEventNode.gd` 挂在一个 `Node`，在 Inspector 把 `target_path` 指向目标 `Node3D`；脚本自动监听 `/yh/level` 与 `/yh/onset`，也可用 `send_control(address, value)` 发送标量。

## 缩放行为与动画映射

缩放适配器默认把对象构造时的缩放当作常态，按倍数响应，保留非均匀比例，`dispose()` 时恢复原缩放，且 `dispose()` 之后继续调用 `update()` 不会再写对象。旧的统一绝对缩放用 `scaleMode: 'absolute'`（Godot 为 Inspector 的 `scale_mode`）。

触发剪辑、驱动权重或播放速度、驱动材质参数，见 [`UNIVERSAL.md`](./UNIVERSAL.md) 的“动画映射层”。Godot 用 `YHAnimationBinder.gd`（挂在场景里，指向 `YHEventNode` 与 `AnimationPlayer`）。

## 场景响应与信号含义

`/yh/level` 始终是未经场景门控改写的连续 0–1 数据；门控只决定它何时、以多快的速度影响场景对象。默认只有 level 连续高于 `0.18` 至少 `120 ms` 才开始改变缩放；低于 `0.12` 持续 `180 ms` 后回到稳定的常态大小，并通过时间平滑过渡。内置演示会用本地估算的底噪将门限提高到至少归一化底噪的 `1.8` 倍（最高 `0.75`），进一步防止较高环境噪声驱动对象。`/yh/onset` 仍是独立的瞬态脉冲，可立即触发短暂放大并平滑衰减，不受 level 门限影响。

JavaScript 适配器可用构造选项 `levelThreshold`、`levelReleaseThreshold`、`levelAttackMs`、`levelReleaseMs`、`levelSmoothing` 和 `restLevel` 调整场景响应，也可在运行时调用 `setLevelThreshold(value)`；接入端可按输入强度提高或降低门限。Godot 脚本在 Inspector 中提供对应的 level 阈值、持续时间、平滑速度和常态大小参数。门限只影响场景响应，不会改变从接口接收或传出的 `/yh/level` 数值。

## 直接使用原始 WebSocket JSON

若不使用 JavaScript adapter，可解析桥接广播的 JSON：

```json
{"kind":"osc","v":1,"address":"/yh/onset","typeTags":"is","args":[1,"yh-web"],"sourceId":"yh-web"}
```

收到 `kind: "osc"` 后读取 `address` 与 `args[0]` 即可；`args[1]` 是来源标识，可忽略。地址和数值含义在各引擎中一致。桥接在 WebSocket 上有重连、令牌和来源策略，见 [`UNIVERSAL.md`](./UNIVERSAL.md)。也可以不使用 WebSocket，直接向本机 UDP `127.0.0.1:9000` 发送标准 OSC 消息。
