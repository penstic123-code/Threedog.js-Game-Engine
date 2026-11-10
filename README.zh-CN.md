<p align="center">
  <img src="docs/brand/threedog-square.png" alt="Threedog.js 标志：三只卡通小狗" width="200">
</p>

<h1 align="center">Threedog.js</h1>

<p align="center">
  为 AI 设计的 three.js 游戏引擎。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/threedog"><img src="https://img.shields.io/npm/v/threedog?label=npm" alt="npm 上的版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/three.js-0.187-black" alt="three.js 0.187">
  <img src="https://img.shields.io/badge/rendering-WebGPU%20%7C%20WebGL2-teal" alt="渲染：WebGPU 和 WebGL2">
</p>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

<p align="center">
  <a href="#看看它能做什么">能做什么</a> · <a href="#快速开始">快速开始</a> · <a href="#最小代码示例">代码示例</a> · <a href="#开发背景">开发背景</a> · <a href="#设计哲学">设计哲学</a> · <a href="#架构">架构</a> · <a href="#模块总览">模块</a> · <a href="#示例">示例</a> · <a href="#为-ai-提供的工具">AI 工具</a> · <a href="#性能与分区">性能</a> · <a href="#现状和已知限制">现状</a> · <a href="#文档">文档</a> · <a href="#常见问题">常见问题</a>
</p>

Threedog 让 AI 用普通 JavaScript 和 three.js 做游戏。引擎负责时间、输入、资源、存档、物理和世界管理，也提供运行、检查和调试项目的工具。项目可以从一个空场景开始，再按需要装上模块。

画面和玩法由项目决定。材质、灯光、模型和场景对象都是 three.js 的，引擎只管多个系统要一起遵守的事。这样 AI 容易找到正确的接口，能验证自己做的结果，遇到复杂需求时仍然可以直接用 three.js。

> **版本：npm 上是 1.2.0。** 可以从 npm 安装，也可以[从源码运行](#修改引擎本身)。发布之后的新改动列在 [CHANGELOG](packages/engine/CHANGELOG.md) 的“Unreleased”下。

## 看看它能做什么

| | |
|---|---|
| ![围墙院子里的第一人称视角，霰弹枪正朝一个行走的怪物开火，天空是粉色的](docs/brand/screens/shooter-yard.jpg) | ![黄昏时分，红蓝两辆车并排行驶在穿过黑色松林的公路上](docs/brand/screens/racing-dusk.jpg) |
| 第一人称射击 | 赛车 |
| ![一只狐狸在日落时平坦的纸片风景里跑过金币](docs/brand/screens/platformer-fox.jpg) | ![暗色网格上，发光的塔立在石路旁，敌人沿路行走](docs/brand/screens/tower-defense-lanterns.jpg) |
| 2D 横版 | 塔防 |
| ![夜晚的木构小镇街道，窗户和路灯亮着](docs/brand/screens/open-world-town-night.jpg) | ![环形行星下，巨大的蓝紫色水晶从明亮的海面升起](docs/brand/screens/crystal-sea.jpg) |
| 开放世界 | 风格化着色器 |
| ![棋盘格地板的烛光舞厅里飘着一个幽灵](docs/brand/screens/haunted-ballroom.jpg) | ![灰色地形旁的编辑器面板，选中了一个标记并显示它的字段](docs/brand/screens/editor-placing-props.jpg) |
| 恐怖 | 浏览器编辑器 |

这些游戏跑在同一个引擎上，由 AI 按简短需求各用 30 到 60 分钟做成，美术也包括在内，然后用脚本从头玩到尾。每张画面都来自 AI 写的代码。更多记录见[能力测试](docs/testing/capability/)。

## 快速开始

需要 [Node.js](https://nodejs.org) 20.19+（20.x）或 22.12+。

做游戏用第一种方式。只有要修改引擎本身时，才下载这个仓库。

### 创建项目

安装已发布的包。包里带着 AI 做游戏需要的东西（`node_modules/threedog/docs/AI.md` 和它指向的做法示例），不含引擎维护者的文档。

```sh
mkdir my-game
cd my-game
npm init -y
npm install threedog@1 three@~0.187.0
npm install -D @threedog/tools@1
npx threedog init
npm install
npm run dev
```

打开终端里显示的地址。默认模板是一个空场景，有相机、灰色的起步画面，以及启动、存档和设置的基础接线，不预设地形、玩家或游戏类型。文件夹名要是 npm 接受的名字，中文名会让 `npm init -y` 报 "Invalid name"，这时跳过这一行，下一行会写好 `package.json`。

`init` 还有几个选项：

| 选项 | 起点 |
|---|---|
| `--open-world` | 地形、天空、跟随相机和玩家 |
| `--pixel` | 像素画面模板 |
| `--webgl` | 用 WebGL 和 GLSL 着色器，代替默认的 WebGPU 和 TSL |

两条渲染路线的画面代码写法不同，所以要在创建项目时选。`createEngine()` 本身默认用 WebGL，项目模板默认配置成 WebGPU。

也可以全交给 AI：把下面三句粘贴给你的 AI，再描述要做的游戏。

```text
在这个空文件夹里建一个 threedog 游戏：npm init -y、npm install threedog@1 three@~0.187.0、npm install -D @threedog/tools@1、npx threedog init、npm install。
先读新生成的 CLAUDE.md：里面列着引擎已经有的系统，其余的用 `npx threedog how "<英文任务词>"` 查。
然后循环到游戏能玩、样子符合要求为止：`npx threedog play` 运行，`npx threedog shot --play` 看画面，按报错和 `npx threedog check` 指的地方修。
```

### 修改引擎本身

只有要修改引擎时才下载这个仓库。里面是引擎源码和维护者文档（`CLAUDE.md`、`docs/design.md`、`docs/architecture.md`、`.claude/rules/`），做游戏用不到。在这里建的项目放在 `games/my-game/`，连到引擎源码，开发服务器上按 F2 打开编辑器。

```sh
git clone https://github.com/penstic123-code/Threedog.js-Game-Engine.git
cd Threedog.js-Game-Engine
npm install
npm run new-game -- my-game
npm run dev -- my-game
```

想要带地形、天空、跟随相机和玩家的起点，在 `new-game` 那一行末尾加 `--open-world`。

### 从哪里开始修改

```text
main.js       创建引擎、安装模块、连接项目系统
content/      场景实例、物品、地点等内容数据
picture/      用 three.js 写材质、灯光和画面
plugins/      放进来就生效的单文件代码
assets.js     声明项目资源
DESIGN.md     项目的设计说明
STATUS.md     当前进展
CLAUDE.md     给 AI 的工作说明
```

这些目录是推荐的起点，普通 three.js 对象也可以直接加进场景。完整过程见[创建项目](packages/engine/docs/recipes/01-new-game.md)。

## 最小代码示例

下面这段可以替换空白模板的 `main.js`，页面保留模板里的 `<canvas id="view">`。它用 WebGL 和原生材质显示一个旋转的立方体。

```js
import { createEngine, THREE } from 'threedog';

const canvas = document.getElementById('view');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('页面需要 <canvas id="view"></canvas>');
}

const engine = createEngine({
  canvas,
  renderer: 'webgl',
  lights: false,
});

engine.scene.background = new THREE.Color(0x20242c);
engine.camera.position.set(3, 2, 5);
engine.camera.lookAt(0, 0, 0);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x78a6ff }),
);
engine.scene.add(cube);

const ambient = new THREE.HemisphereLight(0xffffff, 0x303040, 2);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(3, 5, 2);
engine.scene.add(ambient, sun);

engine.onFrame(dt => {
  cube.rotation.y += dt * 0.5;
});

// 开发工具通过这个引用检查和操作引擎。
window.engine = engine;
await engine.start();
```

场景、几何体、灯光和材质都是 three.js 对象。`onFrame` 更新视觉动画，伤害、冷却和角色决策这类游戏状态放进 `onFixed` 或项目操作。

## 开发背景

你有没有看到过 AI 用 three.js 做的 demo？那些画面常常好得让人吃惊，也让人忍不住想：能不能用它做一个完整的游戏？AI 这么熟悉前端和 three.js，写起来应该很顺手。可每做一个新游戏，它都要把存档、碰撞和界面重写一遍，项目一大，这些代码也越来越难维护。如果有一个为 three.js 做的引擎，把这些共用的部分先做好，AI 就可以直接拿来做游戏。Threedog.js 就是这样一个引擎。

## 设计哲学

**AI 能找到、使用和检查能力。** 引擎提供按任务查询的文档、能力目录、命令行、MCP 和运行检查。好不好用也看 AI 能不能知道模块是否就绪、操作为什么失败、哪个系统在控制一个对象，以及改动有没有生效。

<p align="center"><img src="docs/brand/diagrams/design.zh.png" alt="循环：AI 写 three.js，引擎接入并协调，AI 检查结果，再做下一次修改" width="760"></p>

**保留 three.js 的表达能力。** 项目可以创建自己的材质、灯光、几何体和着色器，也可以接入自己的渲染过程。[THREE.md](packages/engine/docs/THREE.md) 写了相机、资源释放、共享状态和渲染后端怎么接。

**不绑定画风和玩法。** 灰色占位画面只是起点，卡通、写实、像素和程序化视觉都由项目选。跟随相机、背包、任务和开放世界都是可选的，世界可以用地形高度场、自建网格或导入的关卡。

**工具可以多，概念要少。** 同一件事只有一个推荐入口。three.js 已经能清楚做到的事，引擎不再包一层。

**模块之间有明确边界。** 模块声明依赖和提供的能力，共享状态协调多个系统的修改，诊断工具能查到控制权和写入来源。

更多背景见[设计哲学](docs/philosophy.zh-CN.md)和[设计演进](docs/evolution.zh-CN.md)。

## 架构

```text
项目
├─ 行为代码：规则、操作、角色决策
├─ content/：实例、地点、物品和内容参数
└─ picture/：three.js 材质、灯光和视觉表现
          │
          ▼
可选模块：地形、角色、物理、导航、天气、交互……
          │
          ▼
基础运行层：core/ + render/ + ui/
时间、输入、资源、存档、模块生命周期、渲染和诊断
          │
          ▼
three.js / Rapier / Recast 等基础库

<p align="center"><img src="docs/brand/diagrams/arch.zh.png" alt="分层：你的游戏、模块、核心、渲染、three.js 和 Rapier，旁边是给 AI 的工具" width="760"></p>

开发工具：连上运行中的项目，执行操作、读取状态、检查结果
```

`createEngine()` 创建基础运行环境，`engine.use(...)` 安装模块，`engine.unuse(...)` 卸载。模块用 `requires`、`provides` 和 `replaces` 描述依赖和替换关系。自定义模块和内置模块接入方式相同，它们新增的监听和更新钩子通过 `ctx.track(...)` 纳入生命周期。

时间分成三个阶段：

| 钩子 | 放什么 |
|---|---|
| `onFixed` | 固定步长的游戏逻辑 |
| `onFrame` | 动画、HUD 等每帧表现 |
| `onRender` | 渲染前的画面更新 |

`scene.add(obj)` 适合普通显示对象。需要稳定 ID 和引擎登记的对象用 `engine.add(obj, { id })`，见[场景约定](packages/engine/docs/recipes/40-scene.md)。项目自己的状态用 `engine.saves.define(...)` 接入存档。

维护者可以读[当前架构](docs/architecture.md)，项目作者从 [AI 使用索引](packages/engine/docs/AI.md)开始更直接。

## 玩法和画面怎样协作

玩法代码决定发生什么，画面代码用 three.js 表现这些变化。下雨就是一个例子：天气系统记录当前天气，画面读它来决定云、雨滴和地面湿润，音频读它来播雨声，玩法可以据此调整摩擦或作物生长。同一个下雨状态可以画成写实雨幕、卡通线条或像素粒子。

<p align="center"><img src="docs/brand/diagrams/picture.zh.png" alt="游戏系统把信号交给 picture 文件夹里的原生 three.js，大件提供材质，检查工具读取结果" width="760"></p>

```text
天气状态
├─ 画面读取 → 云、雨滴、地面湿润、灯光
├─ 音频读取 → 雨声、风声
└─ 玩法读取 → 摩擦、作物、角色行为
```

时间、日照和风这类共用信号通过 `engine.uniforms` 接入画面。下面的 `sun` 是项目创建的 three.js 灯光，`palette.sun` 是项目自己的强度：

```js fragment
engine.onRender(() => {
  sun.intensity = palette.sun * engine.uniforms.uDaylight.value;
});
```

角色的位置和规则在固定更新里变化，显示对象可以用 `engine.stepBlend` 在两步之间插值，让移动保持平滑。玩家输入和过场脚本都可能操纵同一个角色，[控制接口](packages/engine/docs/recipes/57-control.md)记录当前的控制者，负责接管和归还。多个系统影响同一个数值时用 `engine.mod`，比如减速和临时增益各留各的来源，效果结束时移除自己那一份。这个接口还标着实验性。

地形、植被和天气的数据和绘制是分开的。项目可以保留地形查询，用来移动和放置，绘制部分换成自己的实现。

## 模块总览

`modules/` 下有 30 个模块目录，一个目录可能有多个公开工厂。输入、存档、资源和基础音频在核心里，不在这张表中。核心音频有一个可选的混响 `engine.audio.reverb(...)`，任何声音总线都能送进去；不调用就不开，环境声规则可以按地点设定它的多少（比如山洞里）。

<p align="center"><img src="docs/brand/diagrams/module.zh.png" alt="一个模块有类型、插槽和 install，ctx 把它接到引擎上，它做的东西随它离开" width="760"></p>

| 模块 | 用途 | 源码 |
|---|---|---|
| 世界 | 世界对象的记录，模型随视野加载和卸载 | [world](packages/engine/modules/world/) |
| 内容 | 把内容数据文件接进各个模块 | [content](packages/engine/modules/content/) |
| 关卡 | 加载 glTF 或代码搭的场景，让它能玩 | [level](packages/engine/modules/level/) |
| 地形 | 分块流式地形、采样、编辑和绘制 | [terrain](packages/engine/modules/terrain/) |
| 植被 | 物种、分布、树木碰撞和实例绘制 | [vegetation](packages/engine/modules/vegetation/) |
| 网格 | 格子摆放：家具、建筑、塔、作物、战棋 | [grid](packages/engine/modules/grid/) |
| 日历 | 日内时间、日期和季节 | [calendar](packages/engine/modules/calendar/) |
| 天空 | 天空表现和环境信号 | [sky](packages/engine/modules/sky/) |
| 天气 | 天气状态、变化和绘制 | [weather](packages/engine/modules/weather/) |
| 水面 | 水面绘制和相关接口 | [water](packages/engine/modules/water/) |
| 碰撞 | 角色移动用的碰撞和障碍查询 | [collision](packages/engine/modules/collision/) |
| 刚体 | Rapier 刚体、关节和相关物理 | [rigid](packages/engine/modules/rigid/) |
| 导航 | Recast 导航网格和寻路 | [nav](packages/engine/modules/nav/) |
| 角色 | 玩家、NPC、移动、载具和控制 | [characters](packages/engine/modules/characters/) |
| 相机 | 跟随、第一人称、固定和策略相机 | [camera](packages/engine/modules/camera/) |
| 玩法 | 交互、对话、背包、拾取和任务 | [gameplay](packages/engine/modules/gameplay/) |
| 触发区 | 谁进入、停留、离开一个区域 | [triggers](packages/engine/modules/triggers/) |
| 流程 | 游戏状态和场景切换 | [flow](packages/engine/modules/flow/) |
| 时间线 | 过场和按时间编排的动作 | [timeline](packages/engine/modules/timeline/) |
| 群体 | 大量同类运动物体，如子弹、碎屑和敌群 | [swarm](packages/engine/modules/swarm/) |
| 粒子 | 粒子效果的运行和绘制；`lit: true` 让场景里的灯给粒子染色 | [particles](packages/engine/modules/particles/) |
| HLOD | 把远处的建筑合并成少量代理网格，减少绘制次数 | [hlod](packages/engine/modules/hlod/) |
| 灯光池 | 大量光源共用少量真实灯光 | [lights](packages/engine/modules/lights/) |
| HUD | 目标标记、计数和进度条 | [hud](packages/engine/modules/hud/) |
| 设置 | 画质、声音、按键等设置菜单；游戏用 `settings.define` 定义的每一项都会画进菜单的“options”页 | [settings](packages/engine/modules/settings/) |
| 拍照 | 拍照模式 | [photo](packages/engine/modules/photo/) |
| 音乐 | 音乐播放和切换 | [music](packages/engine/modules/music/) |
| 环境音 | 环境声音 | [ambience](packages/engine/modules/ambience/) |
| 调试 | 开发调试面板和检查入口 | [debug](packages/engine/modules/debug/) |
| 网络 | 实验性的主机权威合作同步，有已知问题 | [net](packages/engine/modules/net/) |

日常使用先从[任务索引](packages/engine/docs/AI.md)查入口，再读[模块 API](packages/engine/docs/api/) 和对应配方。

## 图形工具和包

引擎提供材质补丁、渐变纹理、顶点 AO、级联阴影、后期效果链、光照探针、光照贴图和遮挡剔除。这些都是可选的，画面优先用原生 three.js 写，需要时再查对应工具。

| 包 | 内容 |
|---|---|
| [`threedog`](packages/engine) | 引擎 |
| [`@threedog/tools`](packages/tools) | `threedog` 命令行、MCP 服务器和制作工具 |
| [`@threedog/post-effects`](packages/post-effects) | 可选的后期效果：调色、胶片颗粒、暗角、景深等 |
| [`@threedog/terrain-noise`](packages/terrain-noise) | 可选的噪声地形：丘陵、岛屿、峡谷、河流 |

新项目默认用 WebGPU 和 TSL（three.js 的节点着色语言）。浏览器没有 WebGPU 时，同一个游戏改走 three.js 的 WebGL2 后端，速度慢一些。少数效果（`voxelGI`、`temporalAA`、`sunShafts`、`lightVolumes`）只有 TSL 版本，详见 [WebGPU 和 TSL](packages/engine/docs/recipes/56-webgpu-tsl.md)。

`threedog/tsl` 里的 `lightShaft(engine, opts)` 画一道看得见的、开销小的空中光束，比如从窗户照进来的日光或舞台光束。它就是一个叠加混合的普通 `THREE.Mesh`。第一人称下，玩家随身带的投影头灯或火把不再被玩家隐藏的身体挡出阴影，两种渲染器都一样；详见[环境光照](packages/engine/docs/recipes/34-environment-lighting.md)。

## 示例

| 示例 | 看什么 |
|---|---|
| [plain-picture](packages/engine/examples/plain-picture/) | 用普通 three.js 写项目画面 |
| [world](packages/engine/examples/world/) | 世界相关能力的组合 |
| [action](packages/engine/examples/action/) | 动作游戏规则的组织 |
| [rc2d](packages/engine/examples/rc2d/) | 俯视和横版游戏的屏幕空间全局光照 |
| [techniques](packages/engine/examples/techniques/) | 不同的画面技术 |
| [webgpu-tsl](packages/engine/examples/webgpu-tsl/) | WebGPU 和节点着色器 |
| [perf-island](packages/engine/examples/perf-island/) | 性能场景和取舍 |

按任务学习时读[配方目录](packages/engine/docs/recipes/)，不用从头读完 API。

## 为 AI 提供的工具

AI 的工作过程是查找能力、写代码、运行操作、读取结果。命令行和 MCP（Claude Code、Cursor 等工具使用的模型上下文协议）提供同一套入口，参数见[命令文档](packages/engine/docs/COMMANDS.md)。

```sh
npx threedog how "day night cycle"   # 这件事该用哪个配方
npx threedog check                   # 规则、类型、内容和接口误用
npx threedog play                    # 启动游戏，交给工具操作
npx threedog describe                # 读取运行状态
npx threedog shot --play             # 截图和画面检查
npx threedog play --stop             # 关掉开发服务器
```

| 入口 | 用途 |
|---|---|
| `how` | 按任务查文档，目前只认英文查询词 |
| `catalog` | 查询能力、参数和操作 |
| `check` | 检查规则、内容和接口使用，最后给一行通过或失败。对自己手写的背包和距离判定，它的提示看代码实际在做什么，而不是认某一种写法 |
| `describe` / `inspect` / `explain` | 读取状态、对象信息和原因 |
| `play` / `press` / `step` / `op` | 启动并操作运行中的项目 |
| `shot` | 截图，并报告画面事实，比如哪里过曝、可能是哪盏灯 |
| `verify` | 跑 `tests/scenarios/` 里的验证场景，给出 PASS 或 FAIL |
| 浏览器编辑器 | 开发服务器上按 F2，改动写回内容文件 |

AI 按下按键、推进游戏时间、执行玩家操作，再把结果读成文字，全程不需要人守在键盘前。模板带有 `CLAUDE.md` 和 MCP 配置，它要求 AI 写新系统前先查这个游戏和引擎是否已有。其他 AI 助手也可以读同样的说明，通过 MCP 或命令行使用工具。

开发版还会在游戏漏掉自己要的东西时给出警告。例如 `session-start-missed`：游戏在 `await engine.start()` 之后才监听 `session:start`，而游戏其实已在 start 里开始了。警告会写明改法。

项目可以创建自定义模块、定义操作、定义存档状态，也可以按公开契约替换部分能力：

- [自定义模块](packages/engine/docs/recipes/14-custom-module.md)
- [共享状态和模块替换](packages/engine/docs/recipes/55-mods-time-wrap.md)
- [直接使用 three.js](packages/engine/docs/THREE.md)
- [接口约定](packages/engine/docs/CONVENTIONS.md)

## 成果

**完整的游戏。** 按简短需求做出七个游戏，每个约 30 到 60 分钟。最新的三个（射击、赛车、2D 平台）只用随包文档和工具完成，引擎没有改动，规则都按系统分成了独立文件。[第一轮记录](docs/testing/capability/composite-round-1.md)。

**单项任务。** [85 项任务](docs/testing/capability/)覆盖引擎的模块和命令组，每项由脚本或指定截图判定。第一轮通过 76 项，其余都进入了之后的引擎修复。

**大型城市。** 在一台 RTX 5060 笔记本上，WebGPU，1280×720：一座 1.9 km 见方的城（约 6400 栋楼、7.2 万个网格），1.4 万辆车和行人同时走动，加 200 个 NPC 和 8 盏真灯，约 60 fps，测量时机器还被其他测试占满。上限由运动物体决定：2.8 万个时为 26 到 35 fps，地图扩大四倍帧时间不变。走 10 分钟没有泄漏，12 轮存读档全部正确。[完整报告](docs/testing/field/2026-11-05-city/acceptance.md)。

**测试集。** 1640 项、11021 个检查，全部通过（2026-11-10）。每次推送，CI 都会跑静态检查、一组浏览器测试和构建。捣乱测试随机执行各种操作，现在也包括画面操作（后期效果、画质档、天空、天气、雾、曝光、阴影、拍照），并在两种渲染器上检查画面。

## 性能与分区

大世界会被分成小块，游戏只为近处的内容付出开销。每一部分都能关掉或替换，也都不改变游戏规则：

- **分区：** 地形和世界内容围绕玩家和其他流式来源按块加载。物理碰撞跟着同样的来源走，远处的模拟对象用更大的步长补上时间。
- **少画：** LOD、远处模型合并（HLOD）、遮挡剔除、重复物体批处理。
- **预算：** 自适应分辨率、阴影更新预算和画质预设只改变显示效果。

2026-11-07 在一台 RTX 5060 笔记本上用 WebGPU 测量：这些全开和全关相比，七个时刻的画面差异为 0%，存档和碰撞相同，每帧主线程时间中位数从 5.2 ms 降到 2.5 ms。这是一个测试页面的结果，真实游戏的收益取决于内容。

## 现状和已知限制

下表只写实际跑过的情况：

| 环境 | 状态 |
|---|---|
| Windows 上的 Chrome 和 Edge，WebGPU 和 WebGL | 支持。真显卡跑过，Chrome 上跑过 30 分钟长跑 |
| Windows 上的 Firefox 和 WebKit 测试版 | 走 WebGL2 后端跑通过一个发布版场景，没有 WebGPU |
| Linux 上的 Chromium | 只有 CI，软件渲染，没有真显卡的记录 |
| Safari、macOS | 没有运行过，Mac 支持在 1.0 之后 |
| 手机、平板、Electron、Tauri | 没测过 |
| 手柄和触屏 | 只用模拟设备测过 |

已知限制：

- **联机：** `engine.net` 是实验性功能，有已知问题，1.0 不保证它的行为。
- **显存：** 反复销毁并重建引擎时，每次显存上涨约 0.2 MB。正常游玩不上涨。
- **WebGPU：** 游戏自己的 `onBeforeRender` 抛错时画面会停住，错误会报出来。这是 three.js 的限制。
- **寻路：** 某个体型第一次寻路时，导航网格在主线程上生成，大关卡可能卡约 0.3 秒，加载时先问一次可以避开。`nav({ crowd: true })` 的人群只跑在一张网格上。
- **存档：** 游戏自己的存档部分如果要等 `level.load` 或 `content.load`，必须传入拿到的 `turn`。不传会一直等到 `engine.loading.timeoutMs`，然后失败。
- **射线：** 同一步里两次射线之间移动的物体，要到下一步才按新位置回答。这是为了让上千个静态网格的射线查询保持便宜。
- **流式加载：** `stream.ready` 表示没有待处理的任务，不代表全部建好。建造失败的内容会报告并跳过。
- **物理道具：** 落稳的道具被移动又撤销回原位后，存档并在新页面读档时，会从内容里写的位置重新落下，偏差最多几厘米。
- **查找功能：** `threedog how` 按英文词匹配，大白话的问法可能把错的答案排在第一。`threedog how --browse` 能按类别列出全部功能。

## 文档

| 文档 | 内容 |
|---|---|
| [AI.md](packages/engine/docs/AI.md) | 按任务找到推荐入口 |
| [API.md](packages/engine/docs/API.md) | 公开 API 索引，由代码生成 |
| [recipes/](packages/engine/docs/recipes/) | 按任务写的使用指南 |
| [COMMANDS.md](packages/engine/docs/COMMANDS.md) | 全部命令 |
| [THREE.md](packages/engine/docs/THREE.md) | 原生 three.js 的接入和边界 |
| [架构](docs/architecture.md) | 给维护者的代码和职责地图 |
| [FAQ](docs/faq.zh-CN.md) | 常见疑问，包括引擎做不到的事 |
| [CHANGELOG](packages/engine/CHANGELOG.md) | 每个版本的变化 |

实验性接口标着 `@experimental`。

## 常见问题

### Threedog 和 three.js 是什么关系？

three.js 提供场景、相机、几何体、材质和渲染。Threedog 在它上面提供游戏运行、模块协作和 AI 开发工具，项目继续用 three.js 写画面，也可以直接操作 `engine.scene`、网格和材质。

### 会固定画风或玩法吗？

不会。画面由项目的模型、材质、灯光和着色器决定，玩法由项目规则决定，模块按需要选。

### 必须安装全部模块吗？

不用。项目通过 `engine.use(...)` 选择模块，只需满足它们的依赖。

### 玩法应该写在哪里？

伤害、冷却和角色决策写在 `onFixed` 或项目操作里，动画和 HUD 写在 `onFrame`，渲染前的画面参数写在 `onRender`。

### 什么时候用引擎，什么时候直接写 three.js？

时间、输入、存档和模块协作这类共用工程优先用引擎，画面用 three.js。引擎的能力不合适时，项目代码通过公开接口接入。

### 必须用指定的 AI 助手吗？

不用。工具有命令行和 MCP 两种入口，人也可以直接写和调试项目。

### 怎样判断 AI 做完了任务？

先跑静态检查，再跑项目的验证场景，读取状态并看画面。把关键操作和预期结果存进验证场景，以后的修改可以重复使用。

更多问题见 [FAQ](docs/faq.zh-CN.md)。

## 参与开发

欢迎提交可复现的问题、文档修正和代码改进。报告问题时请写明引擎和 three.js 版本、渲染后端、最小复现步骤，以及相关错误或截图。生成的 API 文档要从源码更新，不直接改生成结果。

## 许可证

[MIT](LICENSE)。标志由 AI 生成，截图由引擎渲染。素材说明见 [ASSETS.md](ASSETS.md)。
