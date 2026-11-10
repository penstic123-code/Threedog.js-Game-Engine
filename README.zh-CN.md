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

Threedog 是建在原生 three.js 0.187 上的游戏引擎，面向中大型网页游戏，设计成由 AI 编程助手来驱动。新游戏默认用 WebGPU 和 TSL 着色器，WebGL 也保留着。引擎负责多个系统必须一起遵守的事：时间、输入、存档、资源、物理、流式加载的世界、模块的装卸；它还给 AI 一套工具，用来找到该用的入口、把游戏跑起来、检查结果。它**不**把 three.js 藏起来：场景、网格、材质、灯光和着色器都是游戏自己写的 three.js 对象。它也没有现成的画风和玩法类型：起步画面是灰的，美术完全由游戏自己决定。

| | |
|---|---|
| ![第一人称视角，霰弹枪朝围墙院子里的行尸开火](docs/brand/screens/shooter-yard.jpg) | ![黄昏时一红一蓝两辆车行驶在暗色松林间的路上](docs/brand/screens/racing-dusk.jpg) |
| ![夕阳下，一只狐狸跑过剪纸风格地面上的金币](docs/brand/screens/platformer-fox.jpg) | ![夜里的木结构小镇街道，窗户和路灯亮着](docs/brand/screens/open-world-town-night.jpg) |

这些都是 AI 助手按一段简短要求做出来的，美术也是它做的；记录在[能力测试](docs/testing/capability/)里。

## 开一个游戏

需要 [Node.js](https://nodejs.org) 20.19 以上或 22.12 以上。

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

打开终端里打印的地址。默认起点是一个空场景，带相机、存档和设置菜单，不预设任何玩法类型。`init` 可以加 `--open-world`（地面、天空、跟随相机和一个玩家）或 `--pixel`（像素画起点），加 `--webgl` 则改用 WebGL 和 GLSL，不用 WebGPU 和 TSL。如果 npm 不接受文件夹名（比如中文名），跳过 `npm init -y` 这一行即可。完整步骤见[配方 01](packages/engine/docs/recipes/01-new-game.md)。

### 或者交给你的 AI 助手

在空文件夹里打开 AI 助手，贴入下面这段，再描述你想要的游戏：

```text
在这个空文件夹里建一个 threedog 游戏：npm init -y、npm install threedog@1 three@~0.187.0、npm install -D @threedog/tools@1、npx threedog init、npm install。
先读新生成的 CLAUDE.md：里面列着引擎已经有的系统，其余的用 `npx threedog how "<英文任务词>"` 查。
然后循环到游戏能玩、样子符合要求为止：`npx threedog play` 运行，`npx threedog shot --play` 看画面，按报错和 `npx threedog check` 指的地方修。
```

装好的包里带着 AI 要用的资料：`node_modules/threedog/docs/AI.md` 和它指向的配方。

## 引擎里有什么

全部可选，游戏用 `engine.use(...)` 装自己要的。每一行写了从 [`packages/engine/docs/recipes/`](packages/engine/docs/recipes/) 里哪篇配方开始看。完整的任务索引在 [AI.md](packages/engine/docs/AI.md)。

| 系统 | 入口 | 配方 |
|---|---|---|
| 固定步长的时间、计时器、事件、可复现的随机数 | `engine.onFixed`、`engine.clock`、`engine.random` | 06 |
| 可以拒绝的玩家动作 | `engine.ops.define` | 23 |
| 存档、自动存档、剧情标记 | `engine.saves.define`、`engine.vars` | 20 |
| 偏好设置和设置菜单（每个 `settings.define` 一行） | `engine.settings` | 26 |
| 内容数据：物品、NPC、地点 | `engine.content` | 20 |
| 键盘、手柄、改键 | `engine.input` | 58 |
| 玩家、NPC、谁在控制谁 | `engine.characters`、`engine.control` | 57 |
| 相机：跟随、第一人称、固定、RTS、2D | `engine.cameraRig` | 21 |
| 碰撞、Rapier 物理、载具 | `engine.collision`、`engine.rigid` | 11 |
| 导航网格和寻路 | `engine.nav` | 12 |
| 地形、植被、流式加载的世界 | `engine.terrain`、`engine.vegetation`、`engine.world` | 28、18 |
| 交互、对话、背包、任务 | `engine.interactions`、`engine.dialogue`、`engine.inventory`、`engine.quests` | 03、04 |
| 场景流程、暂停、过场 | `engine.flow`、`engine.timeline` | 07 |
| 大量子弹或成群的敌人 | `engine.swarm` | 65 |
| 天空、天气、水、昼夜 | `engine.sky`、`engine.weather`、`engine.water`、`engine.calendar` | 08 |
| 粒子，也能被场景灯光照亮（`lit: true`） | `engine.particles` | 64 |
| 灯光池、环境光、看得见的光束 | `engine.lightPool`、`lightShaft` | 09、34 |
| 后期效果、阴影 | `engine.post`、`engine.shadows` | 52、45 |
| 音效、音乐、按地点的环境声、混响 | `engine.audio`、`engine.music`、`engine.ambience` | 31 |
| HUD、菜单、多语言、拍照模式 | `engine.hud`、`engine.ui`、`engine.i18n`、`engine.photo` | 26 |
| 自己写模块，或替换引擎的模块 | `requires`、`provides`、`replaces` | 14 |

画面代码用原生 three.js 写；它怎么接进引擎、边界在哪，见 [THREE.md](packages/engine/docs/THREE.md)。几个包：[`threedog`](packages/engine)（引擎本体）、[`@threedog/tools`](packages/tools)（命令行、MCP 服务、检查）、[`@threedog/post-effects`](packages/post-effects)、[`@threedog/terrain-noise`](packages/terrain-noise)。

## 怎么让 AI 不跑偏

```sh
npx threedog how "day night cycle"   # 某个任务看哪篇配方（用英文词）
npx threedog check                   # 规则、类型、内容、接口误用；最后一行是通过或失败
npx threedog play                    # 把游戏跑起来给工具用
npx threedog shot --play             # 截图，附画面数据和几条提示
npx threedog test -w my-game         # 跑游戏自己的测试
```

- **手搓提示。** `check` 会发现自己从头造引擎已有系统的代码（用 `setTimeout` 做计时器、`Math.random`、`localStorage` 存档、直接监听 `keydown`、手写背包），并指出该用哪个系统。确实是有意这么做的，可以按行或按项目关掉提示。
- **报错带修法。** 引擎的错误带错误码、修法和该读的文档；`engine.describe()` 和 `engine.explain(...)` 说明正在运行什么、某件事为什么没发生。
- **脚本试玩。** `threedog verify <scenario>` 按键、执行动作、以文字检查结果，给出 PASS 或 FAIL。
- 同样的入口也能通过 MCP 用（Claude Code、Cursor 等）。全部命令见 [COMMANDS.md](packages/engine/docs/COMMANDS.md)。

## 现状和数据

- **版本：** npm 上是 1.1.0。这个仓库比它新，还没发布的改动写在 [CHANGELOG](packages/engine/CHANGELOG.md) 的 "Unreleased" 下。
- **单项任务：** [85 项任务](docs/testing/capability/)覆盖各模块和命令，每项由脚本或写明标准的截图判定。
- **一座大城：** 1.9 km 的城（约 6400 栋楼），加 1.4 万个走动的车和人、200 个 NPC、8 盏真灯，在一台 RTX 5060 笔记本上用 WebGPU 运行；数据和极限见[验收报告](docs/testing/field/2026-11-05-city/acceptance.md)。
- **性能：** 测量方法和参考数据在 [perf.md](docs/testing/perf.md)。
- **测试：** `packages/engine/tests/` 和 `packages/tools/tests/` 里的测试用 `npm test` 运行；[CI](.github/workflows/ci.yml) 每次推送都跑静态检查、一组浏览器测试和构建。哪些记录公开，见 [docs/testing](docs/testing/README.md)。
- **浏览器：** 在 Windows 的 Chrome 和 Edge 上用真显卡开发和测量，WebGPU 和 WebGL 都测。CI 在 Linux 的 Chromium 上用软件渲染跑。Safari、macOS 和手机还没测过。没有 WebGPU 时，游戏在 three.js 的 WebGL2 后端上运行，会慢一些。
- **实验性：** 标了 `@experimental` 的名字可能会变；`engine.net` 联机就是其中之一。

常见疑问，包括引擎做不到的事：[FAQ](docs/faq.zh-CN.md)。

## 参与开发

要改引擎本身，克隆这个仓库：`npm install`，然后 `npm run new-game -- my-game` 和 `npm run dev -- my-game`。先读 [CLAUDE.md](CLAUDE.md)（改引擎的 AI 入口），再读 [docs/design.md](docs/design.md)（为什么这样设计，和其他文档冲突时以它为准）和 [docs/architecture.md](docs/architecture.md)（现在是怎么搭的）。每次改完跑 `npm run check`。欢迎提 issue，请写明引擎和 three.js 版本、渲染后端、最少的复现步骤，以及报错或截图。

## 许可证

[MIT](LICENSE)。标志由 AI 生成，截图由引擎渲染；素材说明见 [ASSETS.md](ASSETS.md)。
