# YH 最小引擎样例

四个例子共用 YH 本机事件接口：`/yh/level`（归一化 0–1 电平）与 `/yh/onset`（一次性触发脉冲）。WebSocket 端点固定为 `ws://127.0.0.1:8765/ws`，桥接及 OSC/UDP 都只绑定 loopback；样例使用本地资源，不依赖外部 CDN、远程模型或公网部署。

## 一键启动

解压项目后，双击根目录的 **`Start_YH.bat`**。它会自动选择 Node.js、首次按需安装依赖，并在网页与本机桥接都就绪后打开浏览器。首次安装需要联网；此后启动无需输入命令。保持启动窗口打开，按 **Ctrl+C** 停止服务。

下方网页样例由同一个本机服务提供；样例按钮发送合成事件，可与主控台麦克风产生的事件使用同一协议。

## 浏览器样例

- Three.js：<http://127.0.0.1:5173/examples/threejs/>
- Babylon.js：<http://127.0.0.1:5173/examples/babylonjs/>
- Verge3D：<http://127.0.0.1:5173/examples/verge3d/>

Three.js 和 Babylon.js 使用仓库本地 npm 依赖，由双击启动器在首次启动时自动安装，无需手工输入命令。Verge3D 引擎是其安装版的一部分，未随项目分发：把本机 Verge3D 安装目录 `build` 文件夹中的 `v3d.js` 及其所需伴随 runtime 文件复制到 `public/vendor/verge3d/`，保持相对路径；`v3d.js` 必须位于该目录根。样例的 `scene.gltf` 和 `scene.bin` 已包含在项目内，不会从网络下载。该接入方式依照 Verge3D 官方 [`App` API](https://www.soft8soft.com/docs/api/en/extras/App.html) 的 `loadScene`、`enableControls`、`run` 与 `renderCallbacks` 用法。

## Godot 4 项目

用 Godot 4 打开 `examples/godot/project.godot` 并运行默认场景。主场景包含球体、相机、灯光和原生 `WebSocketPeer` 节点。必须先保持上方的本机事件桥接运行。默认场景接收事件；要从 Godot 反向测试，可使用 `YHEventNode.send_control(address, value)`。

自动化往返测试（同样先启动本机桥接，再于第二个终端执行）：

```powershell
godot --headless --path .\examples\godot res://tests/test_runner.tscn
```

测试场景通过 Godot `WebSocketPeer` 发送 `/yh/level` 与 `/yh/onset`，验证桥接回传事件并检查实际目标球体缩放。

动画绑定测试（`YHAnimationBinder.gd`，同样先启动桥接）：

```powershell
godot --headless --path .\examples\godot res://tests/test_binder.tscn
```

它在代码里建一个 `AnimationPlayer` 与剪辑，验证 onset 播放剪辑、level 驱动 `speed_scale`。`examples/godot/` 里的 `.gd` 是 `src/adapters/godot/` 的副本，`test/godot-sync.test.mjs` 会在两份不一致时失败。

韧性测试：

```powershell
godot --headless --path .\examples\godot res://tests/test_resilience.tscn
```

验证 `level_stale_ms` 在电平流停止后让目标回到原缩放、让 `YHAnimationBinder` 退出 gate 并恢复播放速度，以及其他系统写入的缩放被采纳为新的常态而不是被覆盖。

三个场景可以用 `node scripts/run-godot-tests.mjs`（或 `npm run test:godot`）一次跑完：它自己启动并关闭桥接，要求 8765/9000 端口空闲，Godot 路径可用 `GODOT_BIN` 指定。

## 沙盒验证记录

| 引擎样例 | 验证 | 结果 |
|---|---|---|
| Three.js | Chromium headless + 软件 WebGL；本机桥接建连并初始化场景 | 通过 |
| Babylon.js | Chromium headless + 本地 `@babylonjs/core`；本机桥接建连并初始化场景 | 通过 |
| Godot | Godot 4.7.2 实际运行；WebSocket→OSC/UDP→WebSocket 往返和缩放脉冲（历史记录，来自旧版文档） | 通过 |
| Godot（v0.2 复测） | Godot 4.6.2 无头运行 `test_runner.tscn`、`test_binder.tscn` 与 `test_resilience.tscn`，在本机桥接已启动的情况下 | 三项通过 |
| Verge3D | 本地 glTF 由 Khronos Validator 检查；无 Verge3D 安装/runtime 可供真实引擎运行 | 资产 0 错误、0 警告；引擎运行未验证 |

除此之外，根项目 `npm test` 与 `npm run build` 用于测试引擎适配器、事件门限和多页构建。以上不代表在 Windows 麦克风硬件上完成录音测试。
