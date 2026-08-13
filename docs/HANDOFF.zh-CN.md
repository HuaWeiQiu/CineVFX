# CineVFX 项目交接文档

> 交接日期：2026-08-12
>
> 事实同步：2026-08-14（记录 T1–T3 实际落地，以及仍未在真实宿主验证的项）
>
> 仓库：<https://github.com/HuaWeiQiu/CineVFX>
>
> 分支：`main`
>
> 功能基线提交：`dafb216`（`feat: add non-destructive local glow effect`）
>
> 协议：MIT
>
> 当前性质：开发预览，不是签名 CCX，也不是一键安装包

## 1. 一句话说明

CineVFX 是一个面向 Photoshop 2026 / 27.x 的 UXP 分层特效项目。
当前已经有一个可以在 Photoshop 中真实执行的非破坏性“柔和发光”功能，
以及一套经过契约、Mock API、真实 Node socket 和发布打包测试的后续特效工作流骨架。

当前可用功能不是 AI 生图，也不会自动识别人像。它依据**当前选中图层的透明度轮廓**
创建可编辑发光层：

```text
CineVFX 发光
├── 柔光扩散   颜色叠加 + 高斯模糊 + 滤色/线性减淡
└── 发光边缘   外发光图层样式
原始选中图层   保留在原位置，不移动、不变换、不写入像素
```

如果选中的是铺满画布、不带透明区域的背景层，效果会覆盖整张画面并整体偏向所选颜色。
要得到人物轮廓光，应先选择已经抠出、周围具有透明区域的人物图层或智能对象。

## 2. 当前交付状态

| 范围 | 状态 | 证据 |
| --- | --- | --- |
| 契约 | 已完成 | `20/20` 测试；Schema、OpenAPI、声明生成通过 |
| Mock API | 已完成 | `59/59` 测试；资源上限、幂等、取消、会话和脱敏通过 |
| Photoshop UXP | 已完成开发预览 | T2 后 Node 测试 `165/165`；项目内 TypeScript、检查和构建通过。Node 测试不是 Photoshop 宿主证据 |
| Node 真实 socket 集成 | 已完成 | root `15/15`，其中 4 项是真实 loopback socket 测试 |
| 本地柔和发光 | macOS 窄范围实机通过 | Photoshop 2026 / 27.9.1 创建、撤销、重做成功；不是完整运行时矩阵 |
| Imaging 源层身份核对（T1） | Node 契约已落地，真实宿主未测 | 假 Imaging API 覆盖 SHA-256 与 `dispose()`；未在真实 Photoshop 测到 SHA-256 |
| 失败/取消残留组清理（T2） | Node 编排已落地，真实宿主取消未验证 | 假宿主覆盖创建组、第一副本、模糊后的取消/失败；不是实机回滚证据 |
| 宿主证据 Runbook（T3） | 已写操作手册，全部 UNVERIFIED | [`docs/runbooks/photoshop-host-evidence.md`](runbooks/photoshop-host-evidence.md) |
| Windows Photoshop | 未验证 | 需要 Windows + Photoshop 2026 实机 |
| 透明像素层 / 智能对象 | 未验证 | 真实宿主尚未按 Runbook 跑这两条路径 |
| UXP Developer Tool 加载 | 未验证 | 尚未用 UDT 加载 `apps/photoshop-uxp/dist/plugin/manifest.json` 做验收 |
| 4K / 8K 计时与内存 | 未验证 | p50、p95、scratch 峰值、UXP heap 均未实测 |
| 真实代理图导出/清单导入 | 未实现 | 当前仍是 metadata-only 计划 |
| 正式安装与发布 | 未实现 | 无签名 CCX、正式插件 ID、Marketplace 发布 |

最终自动化门禁：

```bash
pnpm verify
```

2026-08-12 交付快照的执行结果为 `VERIFY_EXIT=0`，包含全部 package/root 的
`check`、`test`、真实 TypeScript 编译和 `build`。T1 / T2 质量门禁再次记录了
上述 Node 门禁，以及 `pnpm --filter photoshop-uxp test`（T1 后 `161/161`，
T2 后 `165/165`）。这些结果只证明 Node 契约与假宿主编排，不能当作
Photoshop 宿主证据，也不能把 `photoshopRuntimeVerified` 设为 `true`。

此外，三路只读审查分别覆盖宿主事务/ActionJSON、输入竞态与内存边界、
日志脱敏与交付事实；修复后最终复审均为 `CLEAN`。

## 3. 实机验收记录

验收环境：

- macOS
- Adobe Photoshop 2026 / 27.9.1
- 853 x 1280、RGB 8 位 JPEG
- 唯一选中图层为锁定背景像素层
- 插件通过本机外部开发插件注册加载，不是 UXP Developer Tool 验收

验收结果：

1. 中文面板真实加载。
2. 点击“刷新”后正确识别像素图层、RGB 8 位和尺寸。
3. 默认参数成功创建顶层 `CineVFX 发光` 组。
4. 组内包含 `柔光扩散` 和 `发光边缘`。
5. 原始 `背景` 图层仍存在。
6. 一次 `Cmd+Z` 删除整个结果组，原始背景保留。
7. 一次重做恢复整个结果组。

这次验收**没有**证明：

- 原始图层像素 SHA-256 前后绝对一致；T1 只在 Node 假 Imaging API 上落地了
  读写后核对与及时 `dispose()`，真实宿主从未测到 SHA-256，缺 Imaging 时保持
  unverified，不会编造哈希；
- 智能对象路径在真实宿主中的全部行为；
- 带透明轮廓的像素层在真实宿主中的轮廓光行为；
- Windows 行为；
- 通过 UXP Developer Tool 加载 `apps/photoshop-uxp/dist/plugin/manifest.json`；
- 取消或中途失败时的真实宿主回滚；T2 只在 Node 假宿主上证明同一
  modal/history 内会删除本事务新建残留组，真实宿主取消仍未验证；
- 4K / 8K 连续创建+撤销的 p50、p95、Photoshop scratch 峰值和 UXP heap；
- Photoshop 中的 HTTPS 证书信任和 Mock API 网络流程。

T3 的 [`docs/runbooks/photoshop-host-evidence.md`](runbooks/photoshop-host-evidence.md)
是后续实机记录手续，不是已经跑过的证据。其中每一行目前都是 `UNVERIFIED`。

因此发布元数据中的 `photoshopRuntimeVerified` 仍保持 `false`，它表示完整跨平台
运行时矩阵尚未通过，不与这次窄范围 macOS 验收冲突，也不因 Node 测试或
Runbook 文件存在而改为 `true`。

## 4. 仓库结构

```text
apps/photoshop-uxp/       Photoshop 面板、任务状态、效果计划和宿主写入
apps/api-server/          本地有界 Mock API
packages/contracts/       JSON Schema、OpenAPI、示例和生成类型
packages/effect-spec/     通用确定性效果原语
services/vfx-renderer/    未来程序化渲染边界，目前不是运行时实现
services/ai-pipeline/     未来可选 AI/分割/深度边界，目前不是运行时实现
tests/                    根级契约、打包、命令和真实 socket 集成测试
docs/                     架构、契约、发布与交接资料
```

优先阅读：

1. [`AGENTS.md`](../AGENTS.md)：不可破坏的产品和安全边界。
2. [`PROJECT_STATE.md`](../PROJECT_STATE.md)：当前事实和未验证项。
3. [`apps/photoshop-uxp/README.md`](../apps/photoshop-uxp/README.md)：面板安装和使用。
4. [`docs/RELEASE.md`](RELEASE.md)：打包、校验和 UDT 加载。
5. [`docs/runbooks/photoshop-host-evidence.md`](runbooks/photoshop-host-evidence.md)：后续宿主证据手续，不是已通过的矩阵。
6. [`docs/agent-pack/02_SYSTEM_ARCHITECTURE.md`](agent-pack/02_SYSTEM_ARCHITECTURE.md)：总体架构。

## 5. 本地发光架构

```text
中文面板 index.html / index.js
          |
          | 用户参数、刷新、busy 状态、固定中文错误
          v
createLocalGlowService
          |
          | 首个 await 前稳定快照；单飞；网络/写入互斥
          v
planGlowEffect                 纯函数，不访问 Photoshop
          |
          | 严格字段、范围、身份、内存估算、deep freeze
          v
createPhotoshopGlowHost        唯一 Photoshop 写入口
          |
          | executeAsModal + 单一 history + DOM + batchPlay
          v
Photoshop 图层组 / 两个派生层
```

### 5.1 纯计划层

文件：[`glow-plan.mjs`](../apps/photoshop-uxp/src/effects/glow-plan.mjs)

职责：

- 只接受稳定、data-only 的普通数据；拒绝 getter、函数、稀疏/异常结构和未知字段。
- 验证当前文档、图层身份、RGB 模式、8/16 位和支持的图层类型。
- 验证颜色、强度、发光范围、模糊半径和混合模式。
- 生成冻结的 `local_glow_plan`，不直接操作 Photoshop。
- 使用 BigInt 估算内存，超过 100MP 或估算峰值 1GiB 时 fail closed。

当前参数范围：

| 参数 | 范围/值 |
| --- | --- |
| 配方 | `soft_glow` |
| 颜色 | `#RRGGBB` |
| 强度 | `0..100` |
| 发光范围 | `1..250 px` |
| 模糊半径 | `0.1..250 px`，面板当前最小值为 1 |
| 混合模式 | `screen` 或 `linearDodge` |

强度映射：`outerOpacity = intensity`，
`bloomOpacity = round(intensity * 0.65)`。

### 5.2 服务编排层

文件：[`local-glow-service.mjs`](../apps/photoshop-uxp/src/effects/local-glow-service.mjs)

职责：

- 串联“读取当前选层 -> 生成计划 -> 进入 Photoshop 写入区”。
- 在任何异步等待前快照调用者参数，避免 TOCTOU。
- 同一时刻只允许一个发光写任务。
- 通过共享 write guard 保证网络等待不能进入 Photoshop 写作用域。
- 失败或取消时不另外开一次 Photoshop 写去清残留组；清理留在宿主那一次写入里。

### 5.3 Photoshop 宿主层

文件：[`photoshop-glow-host.mjs`](../apps/photoshop-uxp/src/host/photoshop-glow-host.mjs)

职责：

- 延迟加载 `require("photoshop")`，Node 测试不依赖真实宿主。
- 读取恰好一个可见像素层或智能对象。
- 在 `executeAsModal` 内重新核对文档 ID、图层 ID 和位深，防止等待期间切换选择。
- 通过 `suspendHistory` 把全部写入合并成一个历史记录。
- 创建组、复制两个派生层，绝不移动源层。
- 用 batchPlay 写入 Outer Glow / Color Overlay，用 DOM 执行 Gaussian Blur。
- 写入前后核对源层 parent、bounds、visibility、opacity、blend 和 locks。
- 若 Imaging API 可用，则对源层像素做前后 SHA-256，并及时 `dispose()`
  imageData；Imaging 不可用或读失败时保持 unverified，不编造哈希，也不把
  digest 写进公开结果。
- 写入后核对派生图层结构。
- 成功 `resumeHistory(..., true)`；失败或取消先在同一 modal/history 内删除
  本事务新建残留组，再 `resumeHistory(..., false)`。删不掉或残留组包含受保护
  源层则 fail closed。历史丢弃本身不当作无残留证明。
- 不把 Photoshop 的本地化错误消息、文档名或图层名写入公开日志。
- 上述 Imaging 与残留清理均已有 Node 假宿主测试；真实 Photoshop 取消和真实
  Imaging SHA-256 仍未验证。

## 6. 安装与运行

### 6.1 环境要求

- Node.js 24 或更高版本
- pnpm 10.33.0
- Adobe Photoshop 2026 / 27.x
- 开发加载建议安装 Adobe UXP Developer Tool

项目本身不提供 Photoshop，也不绕过 Adobe 授权。

### 6.2 从源码构建

```bash
git clone https://github.com/HuaWeiQiu/CineVFX.git
cd CineVFX
pnpm install
pnpm verify
```

UXP 可加载目录：

```text
apps/photoshop-uxp/dist/plugin/
├── manifest.json
├── index.html
├── index.js
└── styles.css
```

### 6.3 通过 UXP Developer Tool 加载

1. 打开 Photoshop 2026 和 UXP Developer Tool。
2. 在 UDT 中选择 **Add Plugin**。
3. 选择 `apps/photoshop-uxp/dist/plugin/manifest.json`，不要选择源码根 manifest。
4. 点击 **Load**；代码更新后点击 **Reload**。
5. 在 Photoshop 的“增效工具/Plugins”菜单打开：
   `CineVFX Dev Shell -> CineVFX`。

当前插件 ID 为 `com.cinevfx.dev.shell`，只是开发 ID。

### 6.4 使用本地发光

1. 打开 RGB 8/16 位文档。
2. 只选择一个可见的像素层或智能对象。
3. 打开 CineVFX 面板；如果先打开面板后打开文档，点击一次“刷新”。
4. 设置颜色、强度、发光范围和柔光半径。
5. 点击“创建柔和发光”。
6. 在图层面板继续调整生成的两个图层，或一次撤销删除完整结果组。

本地发光不需要启动 Mock API，也不会把图像发到网络。

### 6.5 Mock 工作流

面板下半部分“开发测试（Mock）”与本地发光是两条独立路径。
它目前使用固定演示 ID 和元数据：

- “规划代理图”不读取/导出真实 Photoshop 像素；
- “提交任务”连接本地 Mock API；
- “规划导入”只生成导入计划，不向 Photoshop 写入真实清单图层。

默认 API 地址为 `https://localhost:8787`。证书、Windows HTTP 显式 opt-in 和
会话头说明见 [`docs/RELEASE.md`](RELEASE.md) 与
[`apps/api-server/README.md`](../apps/api-server/README.md)。

## 7. 发布产物

执行：

```bash
pnpm release:dev
```

生成：

```text
dist/release/
├── cinevfx-photoshop-uxp-dev-preview-0.1.0.zip
├── release-manifest.json
└── SHA256SUMS.txt
```

当前 ZIP SHA-256：

```text
9f83eada8e27aac257af48939e8f9985a373759173275f98c7e3b6933a3a9402
```

该 ZIP 是确定性开发预览包，不是 CCX，不包含签名、证书、私钥、图片或用户内容。

## 8. 常见问题

### 面板仍显示旧界面

UXP 会缓存已经加载的插件代码。优先在 UXP Developer Tool 点击 **Reload**；
没有 UDT 时需要关闭 Photoshop、替换完整构建目录后重新启动。不要只覆盖单个源码文件。

### 切到其他应用后面板消失

浮动 UXP 面板跟随 Photoshop 的应用焦点，这是宿主窗口行为。回到 Photoshop 后，
可从“增效工具/Plugins”菜单重新显示 CineVFX。停靠到 Photoshop 侧栏可减少这种情况。

### 面板提示“当前图层不可用”

确认已经打开文档、只选中一个图层，然后点击“刷新”。组、文字、调整层、隐藏层、
非 RGB 文档或不支持的位深会被拒绝。

### 整张图片都变成金色/发亮

当前算法依据图层透明度，不做人物分割。铺满画布的背景层会生成全画面柔光。
先抠出人物或选择已有透明人物层，再执行发光。

### 大图提示内存限制

估算公式为：

```text
width * height * 4 channels * bytesPerChannel * 6 surfaces
```

超过 100MP 或估算峰值 1GiB 会拒绝执行。约 33.2MP 的 8K RGBA 8 位图估算约
759MiB，可以进入计划；同尺寸 16 位图约 1.48GiB，会被拒绝。实际 Photoshop
scratch 和峰值内存尚未完成性能矩阵验证。

### “提交任务”网络失败

本地发光不需要 API；只有 Mock 操作需要。检查 Mock API 是否启动、地址是否正确、
macOS 证书是否受信，以及 Windows 是否按文档显式启用 loopback HTTP。

## 9. 不可破坏的工程约束

接手后修改实现时必须继续遵守：

1. 不移动、变换、缩放、替换或写入受保护源层像素。
2. Photoshop 写入必须在有界 modal/history 中；网络和模型等待必须在写作用域外。
3. 失败不得留下半个结果组。
4. 不从 bounds 推导“人物绝对空间坐标已被证明不变”。
5. 不记录图像字节、prompt、绝对本机路径、凭据、session token 或用户内容。
6. 新效果类型必须是通用输入/参数，不把“魔法”硬编码为产品唯一模式。
7. 契约变更先于 API/UXP 依赖变更，并保持生成类型与 Schema 一致。
8. 真实 TypeScript 结论必须使用项目固定的 compiler 得出。

## 10. 下一阶段建议

### P0：把当前本地发光做成可交付功能

T1–T3 只完成了 Node 契约、假宿主编排和实机手续文档。下面各项在真实
Photoshop 上仍未关闭；手续见
[`docs/runbooks/photoshop-host-evidence.md`](runbooks/photoshop-host-evidence.md)。
不要把 Node 测试或 Runbook 文件本身记成宿主通过。

1. 在 Windows Photoshop 2026 重复创建、撤销、重做。**未验证。**
2. 用透明人物像素层和智能对象各做一次真实验收。**未验证。**
3. 使用 Imaging API 对小型 fixture 的源层像素做前后 SHA-256，并及时
   `dispose()` imageData；同时核对 parent、bounds、visibility、opacity、blend、locks。
   **Node 假 Imaging API 已落地；真实宿主 SHA-256 未测。**
4. 对“创建组后、第一副本后、模糊后、用户取消”做真实故障注入，证明无残留组。
   **Node 假宿主编排已落地；真实宿主取消未验证。**
5. 连续执行 + 撤销 20 次，记录 4K/8K 的 p50、p95、Photoshop scratch 峰值和 UXP heap。
   **未验证。**
6. 完成正式 UDT 加载矩阵，决定开发 ZIP、签名 CCX 或 Marketplace 的分发路线。
   **UDT 加载未验证。** 仍不要把产品称为已完成交付。

### P1：把发光从单配方扩展为通用效果层

1. 把 `soft_glow` 扩展为可版本化 recipe 注册表，不在 UI 中硬编码魔法类型。
2. 支持用户提供的效果图片/图层、蒙版和空间锚点作为独立输入层。
3. 增加可编辑的颜色匹配、曝光/色温、景深模糊、光晕和颗粒 pass。
4. 保持所有输出为可编辑图层，不把整张结果一次性烘焙到源层。
5. 为每个 Photoshop ActionJSON 在目标 PS 版本录制 golden fixture，并锁定字段。

### P2：内容感知与电影氛围

1. 先完成真实 proxy/mask/reference 导出与 Layer Manifest 导入，再接模型。
2. 将分割、深度、光照方向和色彩统计放在可替换 provider 边界。
3. 模型输出只作为蒙版/参数/效果层输入，人物原图层仍是不可变受保护源。
4. 以 4K/8K 性能、显存、scratch、失败恢复和视觉基准评估是否引入模型。
5. 不宣称“8K 画质”“电影级”或“绝对坐标不变”，除非有对应可复现实证。

## 11. 接手验收清单

- [ ] `git status` 干净，`main` 与远端同步
- [ ] `pnpm install` 成功
- [ ] `pnpm verify` 退出码为 0
- [ ] UDT 加载的是 `dist/plugin/manifest.json`
- [ ] 面板显示中文“本地效果”区
- [ ] 刷新可识别一个透明像素层或智能对象
- [ ] 创建后得到 `CineVFX 发光/柔光扩散/发光边缘`
- [ ] 一次撤销删除完整结果组
- [ ] 源层身份、像素、位置和属性通过真实证据验证
- [ ] Windows、证书和 Mock 网络分别记录验证结果
- [ ] 发布包校验值与 `release-manifest.json` 一致

完成 P0 之前，应继续把项目称为“开发预览”。
