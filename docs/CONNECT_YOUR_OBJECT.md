# 把自己的场景对象接入 YH

## 先确认事件

所有引擎使用同一条本机 WebSocket：`ws://127.0.0.1:8765/ws`。先在项目根目录启动 YH（Windows 命令见主 README），并让它保持运行。

- `/yh/level`：0–1 的连续电平。数据会持续保留；场景响应层可以过滤低电平起伏，再将明显较大的变化平滑映射到对象参数。
- `/yh/onset`：短促触发信号（通常为 1）；默认适配器在基准值上加一次缩放脉冲，再平滑衰减。
- `/yh/band/low|mid|high`：0–1 频段能量（相对值，未标定）。适配器的缩放不使用它，可经动画映射层使用，见 [`UNIVERSAL.md`](UNIVERSAL.md)。
- `/yh/cue/<名称>`：仅在网页控制台的 **仅目标声** 模式、并且识别到你录入的某个目标声时发送一次（值为 1）。每个目标声有自己的名字，如 `/yh/cue/clap`、`/yh/cue/door`，可用来让不同的声音触发不同的动作；同一时刻还会发一次 `/yh/onset`，只关心“有目标声”的接入端不用改。动画路由里写 `{ type: 'trigger', address: '/yh/cue/clap', clip: 'Jump' }` 即可，自己订阅则用 `YHEventClient` 的 `on('/yh/cue/clap', …)`。地址里的名称在网页上录入时决定：英文名（小写字母、数字、`-`、`_`）直接成为地址；中文等名字作为页面里的显示名，地址按 `cue`、`cue-2`… 顺序分配，页面列表会标出每个目标的地址。

适配器默认 `scaleMode: 'relative'`：创建适配器那一刻对象的缩放就是常态，响应以倍数叠加，保留非均匀比例，`dispose()` 时恢复。需要旧的绝对缩放行为时传 `scaleMode: 'absolute'`（Godot 在 Inspector 里设 `scale_mode`）。

默认场景响应门限为 `0.18`：电平需持续高于门限 `120 ms` 才会推动缩放；低于 `0.12` 持续 `180 ms` 后回到常态大小。平滑只作用于场景，不会改写或停止 `/yh/level` 数据；`/yh/onset` 仍独立触发。JavaScript 适配器可通过 `levelThreshold`、`levelReleaseThreshold`、`levelAttackMs`、`levelReleaseMs`、`levelSmoothing` 与 `restLevel` 调整这组行为，也可在运行时调用 `adapter.setLevelThreshold(value)` 随现场噪声调整门限。

## 找到你的对象

在引擎的场景树或对象层级中选中要响应的 Mesh/Node，给它一个容易辨认且不重复的名称，例如 `YH_Target`。代码里通过名称取对象；如果模型是嵌套导入的，确认名称属于真正需要缩放的 Mesh 或父节点。

## Three.js

在场景加载完成后找到 `Object3D`，创建 adapter，并在现有渲染循环每帧调用 `update`：

```js
const target = scene.getObjectByName('YH_Target');
const yh = new YHEventClient({ url: 'ws://127.0.0.1:8765/ws' });
await yh.connect();
const adapter = new YHThreeAdapter(yh, target);
renderer.setAnimationLoop(() => adapter.update(clock.getDelta()));
```

## Verge3D

等 `app.loadScene(...)` 完成后，从 `app.scene` 按名称取对象；运行本机 Verge3D `App`，把 adapter 接到 `app.renderCallbacks`。项目内 [Verge3D 样例](../examples/verge3d/)可参考完整加载方式。

```js
const target = app.scene.getObjectByName('YH_Target');
const adapter = new YHVerge3DAdapter(yh, target);
let last = performance.now();
app.renderCallbacks.push(() => {
  const now = performance.now();
  adapter.update((now - last) / 1000);
  last = now;
});
```

Verge3D runtime 不随 YH 包分发；使用你本机已安装的 runtime，并按样例说明放在 `public/vendor/verge3d/`。

## Babylon.js

在场景资源加载后用 `scene.getMeshByName` 找 Mesh。把更新接入 Babylon 的渲染前回调，注意把毫秒换算成秒：

```js
const target = scene.getMeshByName('YH_Target');
const adapter = new YHBabylonAdapter(yh, target);
scene.onBeforeRenderObservable.add(() =>
  adapter.update(engine.getDeltaTime() / 1000)
);
```

## Godot 4

把 `examples/godot/YHEventNode.gd`（或 `src/adapters/godot/YHEventNode.gd`）附加到场景中的普通 `Node`。在 Inspector 的 `target_path` 指向要驱动的 `Node3D`，例如脚本节点是根节点子节点时填 `../YH_Target`。脚本会自行连到上面的 WebSocket、轮询事件并更新目标缩放，无需手动加渲染回调。

## 验证与清理

先用主页面的合成 `/yh/level`、`/yh/onset` 按钮验证，再打开麦克风。JavaScript 场景结束时调用 `adapter.dispose()` 和 `yh.close()`；网络应保持在本机地址，不需要发布到公网。更多完整场景见 [`examples/README.md`](../examples/README.md)。
