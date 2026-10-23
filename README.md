# dsh-qqbot

> 把 **DeepSeek Harness（dsh）** 接进 QQ 的一套机器人方案：一个人格化的聊天对象，加上一个能管住她的网页面板。

她不是"问答机器人"。她会按自己的作息过日子、主动找人说话、发表情包、发语音、记仇也记好，
有一个可以随时调整的人格和一批能自己调用的工具（搜索、听歌、看图、画画、记日程……）。

这个仓库是**工程实现**，不是模型：聊天能力全部来自 dsh 与它背后的模型，这里负责的是
「怎么让一个通用 Agent 表现得像个具体的人，并且不出乱子」。

---

## 她长什么样（能力概览）

| 模块 | 做什么 |
|---|---|
| **人格与语气** | 名字、关系、说话风格、口癖、忌讳、脏话尺度、emoji 频率，全部面板可调 |
| **状态机** | 按「年龄 / 职业 / 作息 / 课表 / 今天的活动」推出此刻在干嘛、忙不忙、睡没睡 |
| **主动搭话** | 不是定时群发：受免打扰、活跃时段、忙碌度、每日上限、话题权重、情绪倍率共同约束 |
| **对话是否结束** | 由模型自己判断"对方是不是去忙了/睡了"，未结束且对方沉默时才提高续聊倾向 |
| **语音** | 本地 Edge TTS（免费）或火山引擎声音复刻（含情感指令）；长回复可转成图片卡片 |
| **表情包** | 自己的表情库，按情绪标签挑图；能自己上网补货、自己收藏别人发的图 |
| **引用回复** | 对方连发多条时，能指定"我回的是哪一条" |
| **群聊** | 白名单群 + 必须 @；每个群可单独设人格/语音/表情/黑话 |
| **按人设置** | 访客默认 + 每个号单独覆盖（人格、回复概率、语音、表情、黑话） |
| **黑话学习** | 从聊天里收集网络用语，查证后入库；确认过的才会用，避免学歪 |
| **生图** | 接 OpenAI 兼容的 `/images/generations`，画完自己发出来 |
| **看图 / 听语音** | 图片转文字描述、语音转写，支持外部多模态与 ASR 接口 |
| **文件管理器** | 面板里直接浏览/上传/下载服务器文件（含文件夹上传，有路径穿越防护） |
| **19 个 `qq-*` 工具** | 搜索、读网页、搜图、下载、OCR、听歌、抖音解析、画图、改头像、发说说、记日程/立场等 |

代码规模：`panel/` 约 1.67 万行，全仓 120 个 JS/Python/HTML 源文件，36 个测试文件，
手册里收录了 **41 条**踩过的坑。

---

## 它是怎么搭起来的

```
QQ 客户端
   ↕
NapCat（OneBot 11 协议端，Docker / Termux）
   ↕ 反向 WebSocket
┌──────────────────────────────────────┐
│  qqbot-panel（本项目，Node.js）        │
│  ├─ 代理层 proxy.js                   │
│  │    收消息 → 过滤/防抖/合并 → 注入设定 │
│  │    收回复 → 剥草稿/去重/分条/引用/剥内部标记 │
│  ├─ 面板 server.js + public/index.html │
│  │    配置、日志、文件管理、各类自检      │
│  └─ 调度：主动搭话 / 状态机 / 黑话学习    │
└──────────────────────────────────────┘
   ↕ OneBot WebSocket
dsh（DeepSeek Harness，独立进程）
   ↕
模型 API
```

**关键设计**：把「模型不可靠的地方」全部拦在代理层，而不是寄希望于提示词。

- 模型偶尔会把思考草稿写进正文 → 代理层剥离
- 一条回复里写两个 `[[引用 1]]` → 代理层全量剥除
- 长回复会刷屏 → 代理层按句分条、按打字速度发
- 重复回复 → 代理层判重丢弃
- 内部标记写错位置 → 全量扫描剥除（**任何情况下都不能让对方看到**）

---

## 快速开始

### 前置

| 需要 | 说明 |
|---|---|
| 一台 Linux 服务器 | 本项目按 Ubuntu 24.04 验证；1.7G 内存可跑（无 GPU 需求） |
| Node.js ≥ 22 | 面板只依赖 `ws` 一个包 |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | OneBot 11 协议端，负责登 QQ；Docker 或 Termux 均可 |
| [DeepSeek Harness](https://github.com/deepseek-ai) | 提供 Agent 能力，`dsh web` 需能启动 |
| 一个 QQ 小号 | 建议专用小号，主号有风险 |

### 三步

```bash
# 1. 装 NapCat 并扫码登录（官方文档为准）
docker run -d --name napcat -p 6099:6099 ... mlikiowa/napcat-docker:latest

# 2. 起 dsh web（按 dsh 官方文档），确认 3080 能访问

# 3. 起面板
git clone <this-repo> qqbot-panel && cd qqbot-panel/panel
npm install
PANEL_PORT=18080 PANEL_DATA=./data node server.js
```

然后浏览器打开 `http://<your-server-ip>:18080`，首次会要求设密码，进去按页填。

**完整部署（含坑位排查）见 [`docs/DEPLOY-HANDBOOK.md`](docs/DEPLOY-HANDBOOK.md)**，
那是这个项目最值钱的部分：每一步都有验证方法，第 8 节按「现象 → 根因 → 改法」收录了 40 多条踩过的坑。

### 配置

所有配置都在 `panel/data/config.json`（面板写入，也可手改后重启）。

从 [`config.example.json`](config.example.json) 复制一份开始，**里面是占位符，不要直接用于生产**。

必须自己填的：

| 字段 | 说明 |
|---|---|
| `qq.adminQQ` | 你的 QQ（唯一的管理员，能私聊、能收到测试消息） |
| `qq.botQQ` | 机器人 QQ |
| `dsh.onebotPort` / `proxy.port` | dsh 的 OneBot 端口 / 面板代理监听端口 |
| `auth.hash` | 面板密码（首次在网页里设置，自动写入） |
| `paths.workspace` | 工作区绝对路径（她的文件、表情、语音都在这） |
| `voice.volc.*` | 用火山语音时才填（appId / accessToken / 音色 ID） |

---

## 目录结构

```
panel/                  面板 + 代理（服务端）
  server.js             HTTP 服务、API、各种自检
  lib/proxy.js          核心：消息进出、节奏、分条、引用、去重、注入
  lib/store.js          配置、状态、人格文件生成、档案合并
  lib/proactive.js      主动搭话调度
  lib/campus.js         作息与状态机
  lib/slang.js          黑话学习
  lib/multimodal.js     生图 / 外部语音识别
  lib/fsapi.js          文件管理器（含路径穿越防护）
  public/index.html     整个前端（单文件，无构建步骤）
tools/caps/             19 个 qq-* 命令（Python / Node）
tests/                  36 个测试 + 隔离运行脚本
docs/DEPLOY-HANDBOOK.md 部署手册（含 41 条坑）
tests/test-report.md    改造与测试报告（含每次事故的复盘）
```

---

## 安全与合规（请认真读）

1. **用专用小号**。QQ 对自动化登录有风控，账号可能被限制或封禁，不要用主号。
2. **面板必须设密码**。它能在服务器上读写文件、执行操作，暴露在公网等于把机器交出去。
   建议只监听内网 / 用 SSH 隧道访问，而不是直接 `0.0.0.0:18080` 暴露。
3. **API Key 只放配置里**，不要写进代码、不要提交到仓库。仓库里的 `config.example.json` 全是占位符。
4. **情绪化人格需要边界**。这个项目的人格是完全可配的，请自行确保生成内容合法合规，
   不用于骚扰、冒充、诈骗等用途。
5. **语音克隆有法律风险**。用他人声音做复刻前，请确认已获得授权。
6. **遵守平台规则**。自动化操作 QQ 可能违反腾讯的服务条款，风险自负。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DEPLOY-HANDBOOK.md`](docs/DEPLOY-HANDBOOK.md) | 从零部署、面板每一项的作用、**41 条坑**、手机部署预研、数据迁移施工单 |
| [`tests/test-report.md`](tests/test-report.md) | 每次改造的「现象 → 根因 → 改法 → 验证 → 取舍」，含事故复盘 |

---

## 许可

代码以 **MIT** 发布，见 [`LICENSE`](LICENSE)。

`_plugin/` 下是对第三方插件 `dsh-onebot` 的阅读与补丁参考，版权归原作者，遵循其 MIT 许可。
项目里用到的第三方服务（微软 Edge TTS、火山引擎、DeepSeek API、NapCat）各有自己的条款。

---

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai) —— Agent 运行时
- [NapCat](https://github.com/NapNeko/NapCatQQ) —— OneBot 11 协议端
- [dsh-onebot](https://github.com/JackZo400/dsh-onebot) —— QQ 通道插件
- 黑话学习模块的思路参考了 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）
