# DeepSeek Harness 接入 QQ：部署交接手册

> **这份文档是给「下一个 Agent」看的**，不是给人读的产品介绍。
> 目标：拿到这份文档 + 项目代码，能在**任意一台干净的主机**上把同样的事做出来，
> 不重复踩我们踩过的坑。
>
> 产品级细节（每个面板开关什么意思、每条提示词为什么这么写）在 `README.md`（1700+ 行）。
> 本文只讲**怎么搭起来、为什么这么搭、哪里会炸**。

## 阅读路线（按你的任务选）

| 你要做的事 | 看哪几节 |
|---|---|
| **从零部署一台新机器** | 0 → 2 → 3（全）→ 9 |
| 部署到 Windows / macOS（不是 Linux） | 0.2 → 2.1 → 3.1/3.2/3.6 的平台提示 → 8.23–8.25 |
| 部署完不通，排查 | 9（验收）→ 12（最常见 5 个）→ 8（按现象搜） |
| 要改行为（分条 / 节奏 / 提示词） | 5（代码地图）→ 6（面板）→ 8 |
| 要加新工具 | 7 → 5.1 |
| **想部署到手机上**（Android / Termux） | 13（预研：可行性与改动清单，**尚未实施**） |
| 交接给下一个人 | 全文 + 文末「核心经验」 |

**全文占位符**：`{{APP_DIR}}` `{{WORKSPACE}}` `{{DSH_HOME}}` `{{BIN_DIR}}` `{{TOKEN}}`
`{{ADMIN_QQ}}` `{{QQ_NUM}}` `{{IS_REMOTE}}` —— 取值见第 2 节。

---

## 0. 开工前先做这 3 件事（不要跳过）

**这份文档覆盖 Linux / macOS / Windows 三种系统，本地主机和远程服务器两种场景。**
不同组合的差异集中在本节和「第 2 节 部署参数表」，其余章节是共通的。

### 0.1 必须向用户确认的问题

按顺序问，问完才能动手。**不要自己猜**——猜错会导致路径、端口、守护方式全盘返工。

| # | 问题 | 为什么必须问 | 影响 |
|---|---|---|---|
| 1 | **部署在哪台机器？** 本机 / 远程服务器 | 决定访问方式和防火墙策略 | 本机用 `localhost`；远程才需要隧道或安全组 |
| 2 | **什么操作系统？** Linux / macOS / Windows | 决定守护进程、包管理、Docker 网络模式 | 见 0.2 矩阵 |
| 3 | **有公网 IP 吗？还是内网？** | 决定端口暴露方式和安全边界 | 内网可放宽，公网必须收紧 |
| 4 | **用哪个 QQ 号？** 主号还是小号 | 协议端有封号风险 | 强烈建议小号 |
| 5 | **DeepSeek 账号能用吗？** | dsh 走 `deepseek-account` provider | 没账号整条链路跑不起来 |
| 6 | **这台机器上已经装过 dsh 了吗？** | 决定是全新装还是复用现有 profile | 会用 `dsh plugin add` 而不是重装 |

### 0.2 三种部署形态（按目标机器选）

| 形态 | 典型场景 | 访问方式 | 守护进程 | Docker 网络 |
|---|---|---|---|---|
| **A. 远程 Linux 服务器** | VPS / 云主机 | SSH 隧道（推荐）或反代 + 鉴权 | systemd | `network_mode: host` 可用 |
| **B. 本地 Linux / macOS** | 自己电脑上跑 | 直接 `127.0.0.1` | systemd / launchd | macOS 用 Docker Desktop，**不支持 host 网络** |
| **C. 本地 Windows** | 自己电脑上跑 | 直接 `127.0.0.1` | 计划任务 / nssm | Docker Desktop，**不支持 host 网络** |

> **最容易翻车的一点（先说）**：NapCat 容器和代理层之间的反向 WS，
> 是靠「容器能连到宿主机的 8643」实现的。
> - Linux 用 `network_mode: host`，容器和宿主机共享网络栈，`ws://127.0.0.1:8643/ws` 直接通。
> - **Windows / macOS 的 Docker Desktop 不支持 host 网络**，必须改成端口映射 + `host.docker.internal`：
>   NapCat 里填 `ws://host.docker.internal:8643/ws`，且 compose 里映射 `6099:6099`。
>   详见 3.2「起 NapCat」里的平台提示。

### 0.3 部署顺序（后面的章节按这个走）

```
① 填参数表（第 2 节）        ← 先想清楚路径和端口，别边装边改
② 环境初始化（3.1）
③ 起 NapCat + 登 QQ（3.2 / 3.3）
④ 装 dsh + 配 onebot 插件（3.4）
⑤ 起代理层（3.5）
⑥ 配守护进程（3.6）           ← 别用 nohup
⑦ 验收（第 9 节）
```

---

## 1. 一句话说清这是什么

在一台主机上跑一个 **DeepSeek Harness（dsh）**，通过 **NapCat**（QQ 协议端，OneBot 11）接进 QQ，
中间插一个**自己写的代理层**（Node.js，约 3000 行）负责分条、节奏、记忆、表情、说说、引用等一整套"像人"的行为。

```
QQ 用户
  ↕ (腾讯协议)
NapCat 容器（OneBot 11 协议端）
  ↕ ws://127.0.0.1:8643/ws        ← NapCat 作为客户端反向连进来
代理层 {{APP_DIR}}/panel（Node.js）
  ↕ ws://127.0.0.1:8645/ws        ← 代理作为客户端连 dsh
dsh web（@deepseek-ai/dsh，模型 + 工具 + 会话）
  ↕
DeepSeek API
```

> 下文用 `{{APP_DIR}}` 表示程序目录、`{{WORKSPACE}}` 表示她的工作区目录。
> 具体值在「第 2 节 部署参数表」按平台填好，全篇通用。

**代理层是可选的，但强烈建议保留。** 第 5 节说明理由。

---

### 1.1 架构（先看这张表，后面全靠它）

### 端口一览

| 端口 | 谁监听 | 谁连 | 作用 |
|---|---|---|---|
| `6099` | NapCat（容器内 QQ 进程） | 你的浏览器 | NapCat WebUI，扫码登录 / 配 OneBot |
| `8643` | **代理层** | NapCat | 代理接 OneBot 事件（反向 WS） |
| `8645` | **dsh** | 代理层 | 代理把消息交给 dsh（`dsh-onebot` 插件的 WS） |
| `3080` | dsh | 你的浏览器 | dsh 自己的 Web UI |
| `18080` | **代理层的控制面板** | 你的浏览器 | 改人格、看日志、调所有开关 |

**安全边界**：除 `18080`（面板，有密码）外，全部**只监听 `127.0.0.1`**。
- 远程服务器：安全组只开 22，其余走 SSH 隧道。
- 本地机器：本来就是回环，无需额外处理。

### 消息怎么流

**入站**（QQ → 模型）：
```
NapCat 发 OneBot 事件到 8643
  → 代理层 queueMessage()：判断值不值得回、算延迟（0 秒～25 分钟）、攒批
  → 到点后 dispatch()：往消息前面注入若干提示（状态 / 表态许可 / 联想许可 / 表情催促）
  → 转发到 8645
  → dsh 调模型，模型用工具（qq-search 等）干活
```

**出站**（模型 → QQ）：
```
dsh 发 send_private_msg 到 8645
  → 代理层：
     ① 拦系统提示（「任务运行中，新消息已排队」这类）
     ② 剥思考草稿（模型偶尔把英文推演写进正文）
     ③ 解析 [[引用 N]] 换成 reply 段
     ④ 去重、模拟打字延迟、拆成多条逐条发、表情挂末尾
  → 发到 8643
  → NapCat → QQ
```

### 目录

```
{{APP_DIR}}/
├── bootstrap.sh              环境初始化（按包管理器自适应）
├── docker-compose.yaml       NapCat 容器
├── napcat/config/            NapCat 的 OneBot 配置（含 token）
├── cordis.patch.yml          模板；实际生效的在 {{DSH_HOME}}/profiles/web/
├── panel/                    ★ 代理层 + 控制面板（本文档的重点）
│   ├── server.js             HTTP 服务 + 面板 API + 启动代理
│   ├── lib/
│   │   ├── proxy.js          ★ 核心：WS 代理、分条、节奏、注入、引用、草稿剥离
│   │   ├── store.js          ★ 配置读写 + 人格渲染（AGENTS.md）+ 面板数据
│   │   ├── pacing.js         回复延迟决策（几档、深夜、忙闲）
│   │   ├── campus.js         ★ 人格状态机（身份→日程→忙闲，含偷闲窗口）
│   │   ├── campus-templates.js 六套职业日程模板 + 按年龄推年级
│   │   ├── faces.js          275 条小黄脸编号→中文名（把对方发的表情翻译成文字）
│   │   ├── goaway.js         从她的话里认出「我先去写作业了」→ 自动改状态
│   │   ├── proactive.js      主动发消息 / 发说说
│   │   ├── assoc.js          跳题联想（素材池）
│   │   ├── opinion.js        独立观点 + 立场库
│   │   ├── stances-builtin.js 她天生的 17 条偏好
│   │   ├── dsh-proxy.js      把 dsh 自己的 Web UI 反代进面板（流式 + WS）
│   │   ├── stickers.js       表情包索引与匹配
│   │   └── stats.js          Token / 消息统计
│   ├── data/                 配置、状态、立场库（运行时生成）
│   └── public/index.html     控制面板（单文件，内联 JS）
├── tools/caps/               15 个 qq-* 命令（装进 PATH）
└── _bak/                     每次部署前的自动备份（回滚用）

{{WORKSPACE}}/                她的"工作区"
├── AGENTS.md                 ★ 由面板自动生成（人格 + 规则），每次保存覆盖
├── AGENTS.local.md           ★ 她自己的长期记忆，只初始化一次，永不覆盖
├── stickers/                 表情库（index.json 是元数据）
├── voice/  douyin/  downloads/
└── last-msg.json             每个会话最后一条消息的 id（引用、贴表情用）
```

---

## 2. 部署参数表（先填这张，再动手）

**把这张表填完，再往下看。** 后面所有命令里的 `{{...}}` 都从这里取值。

| 占位符 | 含义 | Linux 示例 | macOS 示例 | Windows 示例 |
|---|---|---|---|---|
| `{{APP_DIR}}` | 程序目录 | `/opt/qqbot` | `~/qqbot` | `D:\qqbot` |
| `{{WORKSPACE}}` | 她的工作区 | `/root/qq-workspace` | `~/qqbot-workspace` | `D:\qqbot-workspace` |
| `{{DSH_HOME}}` | dsh 的数据目录 | `/root/.dsh` | `~/.dsh` | `D:\DeepSeekHarness\dsh_Data` |
| `{{BIN_DIR}}` | 工具安装目录（要在 PATH 里） | `/usr/local/bin` | `/usr/local/bin` | `%USERPROFILE%\bin` |
| `{{QQ_NUM}}` | 机器人 QQ 号 | — | — | — |
| `{{ADMIN_QQ}}` | 你（主人）的 QQ 号 | — | — | — |
| `{{TOKEN}}` | 内部通信 token（自己随机生成，三处要一致） | `openssl rand -hex 20` | 同左 | `node -e "console.log(require('crypto').randomBytes(20).toString('hex'))"` |
| `{{SERVER}}` | 远程服务器的 IP 或域名（**仅远程部署用**） | `1.2.3.4` | — | — |
| `{{USER}}` | 远程服务器的登录用户（**仅远程部署用**） | `root` | — | — |
| `{{IS_REMOTE}}` | 是否远程服务器（决定用不用隧道） | `true` / `false` | — | — |

### 2.1 前置条件（按平台）

| 项 | 要求 | Linux | macOS | Windows |
|---|---|---|---|---|
| **内存** | ≥ 2G；**2G 机器必须开 swap** | swap file | 系统自带 | 调虚拟内存 |
| **磁盘** | ≥ 8G 可用（dsh 的 node_modules 很大） | — | — | — |
| **Node** | **22.x**，低于 22 会在某些依赖上炸 | `bootstrap.sh` 装 | `brew install node@22` | 官网 msi 或 `winget install OpenJS.NodeJS` |
| **Docker** | 任意近期版本，用来跑 NapCat | Engine | Docker Desktop | Docker Desktop |
| **ffmpeg** | 语音转码用 | `apt install ffmpeg` | `brew install ffmpeg` | `winget install Gyan.FFmpeg` |
| **zstd** | 读 dsh 的 session 日志 | `apt install zstd` | `brew install zstd` | 单独下 `zstd.exe` 放进 PATH |
| **pnpm** | 装 dsh 用 | `npm i -g pnpm` | 同 | 同 |
| **QQ 号** | 最好是小号 | 有封号风险，别用主号 | — | — |
| **DeepSeek 账号** | 能登 | dsh 走 `deepseek-account` | — | — |

> **Windows 额外注意**：Docker Desktop 需要 WSL2 后端；NapCat 是 Linux 镜像，
> 所以「容器连宿主机」必须走 `host.docker.internal`，不能用 `127.0.0.1`。

---

## 3. 部署（7 步，每步都有验证）

> **先说清楚脚本的平台边界**（省得白跑）：
> - `bootstrap.sh` —— **只支持 Linux**（要 root，检测 apt/dnf/yum）。macOS/Windows 按下面手动装。
>   它内部有 3 处 `/opt/qqbot` 写死（建目录用），换了 `{{APP_DIR}}` 要先改，否则会多建个空目录。
> - `panel/install.sh` —— npm 装依赖那半是跨平台的，但 `PANEL_DIR=/opt/qqbot/panel` 和
>   **注册服务那半写死了 systemd**。见 3.5 的处理办法。
>
> 这两个脚本不改也能用：非 Linux 场景照着手动步骤做，等价。

### 3.1 环境初始化

**Linux**（服务器或本机）：

```bash
cd {{APP_DIR}}
bash bootstrap.sh
```

它会做：识别发行版、建 swap（内存 < 4G 时）、装基础依赖（含 ffmpeg / zstd）、装 Node 22、
配 npmmirror、装 pnpm、装 Docker、建 `{{APP_DIR}}/napcat/{config,qq}`、防火墙只放行 22。

**macOS**：

```bash
brew install node@22 pnpm ffmpeg zstd
# Docker Desktop 手动装：https://www.docker.com/products/docker-desktop/
mkdir -p {{APP_DIR}}/napcat/{config,qq}
```

**Windows**（PowerShell）：

```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg
npm i -g pnpm
# Docker Desktop 手动装，安装时勾选 WSL2 后端
# zstd 需单独下载 zstd-vX.X.X-win64.zip，把 zstd.exe 放进 PATH
New-Item -ItemType Directory -Force "{{APP_DIR}}\napcat\config","{{APP_DIR}}\napcat\qq"
```

**验证**（三平台通用）：

```bash
node -v      # v22+
docker -v
pnpm -v
ffmpeg -version | head -1
zstd --version
```

> 坑：`npm config set registry npmmirror` 之后，装带大量 scoped 依赖的包（比如 dsh 本体）
> 可能因为镜像没缓存而卡住。装 dsh 时如果卡了，加 `--registry=https://registry.npmjs.org/` 直连。
>
> Windows 若报 `[safe-delete] SAFE_DELETE_BULK_CONFIRM_REQUIRED`：
> 命令前加 `$env:NODE_OPTIONS=""` 再跑（某些环境注入了删除防护 shim）。

### 3.2 起 NapCat

**Linux** —— 用 host 网络，最简单。`docker-compose.yaml`：

```yaml
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: always
    network_mode: host          # ← 容器直接占宿主机端口
    environment:
      - WEBUI_TOKEN=${WEBUI_TOKEN:?请在 .env 里设置 WEBUI_TOKEN}
      - TZ=Asia/Shanghai
      - NAPCAT_UID=0
      - NAPCAT_GID=0
    volumes:
      - ./napcat/config:/app/napcat/config
      - ./napcat/qq:/app/.config/QQ
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

```bash
cd {{APP_DIR}}
cat > .env <<'EOF'
WEBUI_TOKEN={{TOKEN}}
EOF
docker compose up -d
```

容器用 **host 网络**，QQ 进程直接占宿主机的 6099。

**macOS / Windows** —— Docker Desktop **不支持 host 网络**，必须改端口映射：

```yaml
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: always
    # network_mode: host     ← 去掉这行
    environment:
      - WEBUI_TOKEN=${WEBUI_TOKEN:?请在 .env 里设置 WEBUI_TOKEN}
      - TZ=Asia/Shanghai
      - NAPCAT_UID=0
      - NAPCAT_GID=0
    ports:
      - "6099:6099"          # ← WebUI 必须显式映射（host 模式下不需要）
    volumes:
      - ./napcat/config:/app/napcat/config
      - ./napcat/qq:/app/.config/QQ
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

```bash
cd {{APP_DIR}}
# .env 同上
docker compose up -d
```

> **关键差异**：容器内要访问宿主机的代理层（8643）时，
> - Linux（host 网络）：`ws://127.0.0.1:8643/ws`
> - **macOS / Windows**：`ws://host.docker.internal:8643/ws` ← 必须改这个
>
> 这个值填在 NapCat 的 OneBot 配置里（下一步）。

**验证**：`docker ps | grep napcat` 在跑；6099 有监听（Linux 用 `ss -tlnp | grep 6099`，
Windows 用 `netstat -ano | findstr 6099`）。

### 3.3 登录 QQ + 配 OneBot

**访问 NapCat WebUI**：

| 场景 | 怎么做 |
|---|---|
| 本地部署（任何 OS） | 浏览器直接开 `http://127.0.0.1:6099/webui` |
| 远程服务器 | 先开隧道：`ssh -L 6099:127.0.0.1:6099 {{USER}}@{{SERVER}}`，再开同样的地址 |

用 `{{TOKEN}}` 登录，扫码登 QQ。

然后配 **OneBot 11 → WebSocket 客户端（反向）**：

| 字段 | 值 |
|---|---|
| URL | Linux：`ws://127.0.0.1:8643/ws`<br>**macOS / Windows：`ws://host.docker.internal:8643/ws`** |
| Token | 和面板 / dsh 配置里的一致（见 3.4） |
| messagePostFormat | **`array`** ← 必须，见下方说明 |
| 心跳 | 保持默认（30 秒一次） |

> **`messagePostFormat` 必须是 `array`。** CQ 码字符串（`string`）会让代理层所有
> 按段处理的逻辑失效（表情、图片、引用都拆不出来）。这是**第一个必须确认的配置**。

配置落在 `{{APP_DIR}}/napcat/config/onebot11_<QQ号>.json`。

**验证**：NapCat 日志里出现「反向 WS 已连接」。此时因为代理还没起，会连不上 8643，正常。

### 3.4 装 dsh 并起服务

```bash
npm i -g @deepseek-ai/dsh
dsh --version    # 本文写作时是 0.2.1-rc.2

# profile 里装 onebot 插件
dsh plugin --profile web add dsh-onebot-qq

# 注入配置：端口 / token / 白名单 / 工作区
cp {{APP_DIR}}/cordis.patch.yml {{DSH_HOME}}/profiles/web/cordis.patch.yml
```

`cordis.patch.yml` 模板里除了 onebot 段，还有 `agent-default-model`（模型）、
`compaction-basic`（上下文压缩阈值）、`ui-settings-general` 几段。
**这几段照抄即可，只有下面这些要按你的环境改**：

```yaml
- id: dsh-onebot
  config:
    mode: reverse          # dsh 侧监听，等代理来连。别改成 forward
    host: 127.0.0.1
    port: 8645
    accessToken: '{{TOKEN}}'      # ★ 要和 NapCat / 面板三处完全一致
    requireMention: true          # 群里要 @ 才理（本部署只开私聊，无影响）
    dmPolicy: open
    groupPolicy: disabled         # ★ 只接私聊
    allowAllUsers: false          # ★ 配合 adminUsers 白名单
    adminUsers: ['{{ADMIN_QQ}}']  # ★ 不加白名单它谁都不理
    workspacePath: '{{WORKSPACE}}'
    sttEnabled: true              # 语音转文字
    sttEngine: auto
    sttModel: base
    textImageThreshold: 150       # 超过 150 字渲染成图片卡片
    logLevel: info
    agentPreset: ''
```

> **Windows 注意**：`workspacePath` 要写成 Windows 路径（`D:\qqbot-workspace`），
> YAML 里用单引号包住，或写成 `D:/qqbot-workspace`（正斜杠更保险，反斜杠在 YAML 里要转义）。

> **坑：`allowAllUsers: false` + `adminUsers` 为空 = 谁都不回。** 第一次部署最容易卡在这，
> 表现是"NapCat 在线、dsh 在线、发消息没反应"，日志里也不报错。

**起服务（守护进程见 3.6，别用 nohup）**：

```bash
# Linux
systemctl enable --now dsh-web

# macOS（launchd）见 3.6
# Windows（计划任务 / nssm）见 3.6
```

**验证**：服务 active；`8645` 有监听；
浏览器能打开 dsh 的 Web UI（远程走 `ssh -L 3080:127.0.0.1:3080`，本地直接开 `http://127.0.0.1:3080`）。

### 3.5 起代理层

> **先看这个**：`panel/install.sh` 里第一行是 `PANEL_DIR=/opt/qqbot/panel`，**写死的**。
> 如果你的 `{{APP_DIR}}` 不是 `/opt/qqbot`，直接跑它会把程序复制到错误位置（还可能要 root）。
> 两种做法：① 先 `sed -i "s#/opt/qqbot#$你的目录#" panel/install.sh`；
> ② 干脆跳过脚本，用下面的手动命令。

**手动装（推荐，跨平台通用）**：

```bash
cd {{APP_DIR}}/panel
npm install --omit=dev          # 只依赖 ws
node server.js                  # 先手工跑一次看日志
```

**Linux 想用脚本**（`{{APP_DIR}}` 就是 `/opt/qqbot` 时）：

```bash
cd {{APP_DIR}}/panel
bash install.sh                 # 复制 + npm i + 注册 systemd
```

首次启动会自动生成 `data/config.json` 和一份默认 `AGENTS.md`。

**验证**：

```bash
# Linux
journalctl -u qqbot-panel -n 20 --no-pager
# macOS / Windows：看控制台输出，或重定向到日志文件后 tail

# 应该看到这三条：
#   代理端口 8643 → dsh 端口 8645
#   已连接 dsh: ws://127.0.0.1:8645/ws
#   NapCat 已接入代理
```

三条日志齐了，就说明链路通了。去 QQ 里发一句，她应该回。
确认没问题后，按 3.6 把它挂成守护进程（别一直开着终端跑）。

### 3.6 配守护进程（按 OS）

**别用 `nohup`**——终端一断就没了。三种系统的做法：

**Linux — systemd**

两个 unit 模板都在仓库里（`{{APP_DIR}}/dsh-web.service`、`{{APP_DIR}}/panel/qqbot-panel.service`），
但**里面的路径是写死的**，换目录必须改。完整内容如下，直接按你的 `{{APP_DIR}}` 生成：

```ini
# /etc/systemd/system/dsh-web.service
[Unit]
Description=DeepSeek Harness Web (dsh)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/dsh web
Restart=always
RestartSec=5
WorkingDirectory=你的家目录
Environment=NODE_ENV=production
Environment=TZ=Asia/Shanghai
StandardOutput=journal
StandardError=journal
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/qqbot-panel.service
[Unit]
Description=QQ Bot Control Panel (dsh + NapCat)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={{APP_DIR}}/panel
ExecStart=/usr/bin/node {{APP_DIR}}/panel/server.js
Restart=always
RestartSec=3
Environment=PANEL_PORT=18080
Environment=PANEL_BIND=0.0.0.0
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=qqbot-panel

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now dsh-web qqbot-panel
```

> `ExecStart` 里的 `/usr/bin/node` 和 `/usr/bin/dsh` 要按 `which node` / `which dsh` 的实际路径改。
> 用 nvm 装的话路径在 `~/.nvm/versions/node/vXX/bin/` 下，systemd 读不到你的 shell PATH，必须写绝对路径。

**macOS — launchd**

`~/Library/LaunchAgents/com.qqbot.panel.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.qqbot.panel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>{{APP_DIR}}/panel/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>{{APP_DIR}}/panel</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{{APP_DIR}}/panel.log</string>
  <key>StandardErrorPath</key><string>{{APP_DIR}}/panel.err.log</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.qqbot.panel.plist
```

dsh 同理再写一个 `com.qqbot.dsh.plist`，`ProgramArguments` 换成 `dsh web`。

**Windows — 计划任务（自带的，不装第三方）**

```powershell
# 开机自启 + 崩溃重试
$act = New-ScheduledTaskAction -Execute "node" -Argument "{{APP_DIR}}\panel\server.js" -WorkingDirectory "{{APP_DIR}}\panel"
$trg = New-ScheduledTaskTrigger -AtStartup
$set = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName "qqbot-panel" -Action $act -Trigger $trg -Settings $set -RunLevel Highest
```

dsh 同理：`-Execute "dsh" -Argument "web"`。

> 也可以装 [nssm](https://nssm.cc/) 把它做成 Windows 服务，更像 systemd。二选一，别都装。

**验证**：`systemctl is-active` / `launchctl list | grep qqbot` / `Get-ScheduledTask qqbot-panel`。

### 3.7 面板

| 场景 | 怎么做 |
|---|---|
| 本地部署 | 浏览器直接开 `http://127.0.0.1:18080` |
| 远程服务器 | `ssh -L 18080:127.0.0.1:18080 {{USER}}@{{SERVER}}` 后开同样地址 |

首次进去设密码。

> **鉴权边界（改这层之前务必看一遍）**
>
> | 路径 | 要不要登录 | 为什么 |
> |---|---|---|
> | `/`、`/index.html` 等静态文件 | **不要** | 页面里自带登录层，得先加载出来才能弹框 |
> | `/api/me` | **不要** | 前端靠它的 `authed:false` 决定弹不弹登录框 |
> | `/api/login`、`/api/setup` | **不要** | 登录本身 |
> | `/api/*` 其余 | 要 | 全部数据 |
> | `/dsh/*`、`/dsh` | 要 | dsh 界面能看到模型对话 |
>
> 判断顺序在 `server.js` 里是硬性的：**静态块 → `if (!authed)` → dsh 代理 → 其余 API**。
> 把静态块挪到鉴权后面，未登录的人就只会看到一行 `{"error":"未登录"}` 的 JSON
> （手机端最明显，见坑 8.31）。

面板承担：人格编辑、所有行为开关、日志、Token 统计、白名单、表情库、语音、说说、立场库。

**面板还内嵌了 dsh 自己的 Web UI**（「概览」页的「dsh 界面」卡片）。实现是 `panel/lib/dsh-proxy.js` 做反向代理：

- 面板后端把 `/dsh/*` 原样转发到本机 `127.0.0.1:3080`，token/cookie 自动管理（每次 dsh 重启 token 会变，后端从 dsh 的日志里抓最新 token 换 cookie）。
- 这样浏览器只要登录面板、点开「概览」就能直接操作 dsh 的完整界面，**不需要再单独开 SSH 隧道、也不需要抄 token**。

> **跨平台注意**：这个代理靠读 `journalctl -u dsh-web` 抓 token。
> **macOS / Windows 没有 journalctl**，需要改成读日志文件：
> 把 `dsh-proxy.js` 里 `fetchTokenUrl()` 的 `execFile('journalctl', [...])`
> 换成读 `{{APP_DIR}}/dsh.log`（守护进程的 StandardOutPath / 重定向文件），
> 正则不变：`/http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9]+/`。
> 不改的话，面板里那张卡片会显示「取不到认证」——但代理层本身不受影响。

这个反向代理有**四个必须踩对的点**，错一个就是「界面上永远显示正在连接」：

| # | 要点 | 错了会怎样 |
|---|---|---|
| 1 | **必须流式转发**（`upstreamRes.pipe(res)`），不能 `res.on('end')` 攒整包 | dsh 是 LLM 界面，回复逐字吐（`Transfer-Encoding: chunked`），SSE 端点 `/plugins/events` 根本不会 end → 代理永不返回 → 永远「连接中」 |
| 2 | **必须处理 `server.on('upgrade')`** 做 WebSocket 桥接 | dsh 前端用 `new WebSocket(remoteStreamUrl())`（流通道 `/api/remote.mux`），`createServer` 的回调收不到 Upgrade → 握手失败 → 永远「连接中」 |
| 3 | **路由放在静态文件服务之前** | `/dsh/` 被当静态文件返回 404 |
| 4 | **用 `req.url` 原始串切前缀**，不要 `new URL()` | 资源路径是 `plugins/??@scope/name.js&rev=xxx`，`?`/`&` 是路径的一部分，URL 解析会把 `??` 当 query 起始 → 路径截断 → 404 |

dsh 前端同时用 **SSE**（`EventSource('/plugins/events')`，`text/event-stream`）和 **WebSocket**（`/api/remote.mux`），两条都得通。
另外 `FILE_UPLOAD_ROUTE = /api/session/uploadFileBinary` 就是 dsh 自己的文件上传通道，面板代理已经能透传。

---

## 4. 代理层：为什么不能省

dsh 自带的 `dsh-onebot-qq` 插件已经能收发消息。但直接用会有这些**明显不像人**的问题：

| 问题 | 后果 |
|---|---|
| 秒回 | 最强的机器人信号，没有之一 |
| 一条长回复整段甩过来 | 真人会分两三条说 |
| 不会从上下文挑重点 | 你连发 5 条，它逐条回 |
| 表情/语音从不主动发 | 人格里写了也没用 |
| 没有节奏 | 永远精神饱满、随叫随到 |
| 群聊/私聊一个待遇 | 分不清场合 |

代理层就是解决这些。它插在中间，**不改 dsh 一行代码**，只做三件事：
**拦、注、拆**。

- **拦**：系统提示、重复回复、思考草稿、无效内容
- **注**：往入站消息前面加提示（当前状态、要不要表态、可以岔开吗、该发表情了）
- **拆**：长回复拆成多条、按打字速度发、表情挂末尾

> **关键设计决策：延迟做在「入站」而不是「出站」。**
> 出站被 OneBot 的 `action` 超时卡死（30 秒），不可能"等 5 分钟再发"。
> 入站可以压着——消息先存着，到点才交给模型，模型看完立刻回。
> 体感是「她刚才在忙，现在才看手机」，架构一点没动。

---

## 5. 代码地图（动手改之前先看这节）

### 5.1 `proxy.js`（最大，约 3000 行）

一条消息从进到出，按顺序经过这些函数：

**入站**
| 函数 | 干什么 |
|---|---|
| `start()` | 起 8643 的 WS server，校验 token，接 NapCat |
| `ensureUpstream()` | 连 8645 的 dsh，断了自动重连（指数退避） |
| `queueMessage()` | 入站第一站：低价值过滤 → 算延迟 → 攒批 |
| `dispatch()` | **所有注入都在这里**：状态行、表态许可、联想许可、表情/语音催促 |
| `mergeFrames()` | 多条消息合并成一条，给每条打 `[#N]` 序号，记 message_id 备引用 |

**出站**（`ensureUpstream` 里 `sock.on('message')`）
| 步骤 | 函数 | 说明 |
|---|---|---|
| ① | `systemNoticePlan()` | 拦「任务运行中/已排队」这类系统提示 |
| ② | `stripDraftFrame()` | 剥模型写进正文的思考草稿（英文推演、`2 lines`、`Respond lightly:`） |
| ③ | `applyQuote()` | 把 `[[引用 N]]` 换成真正的 `{type:'reply'}` 段 |
| ④ | `isDuplicate()` | 10 分钟内整段重复的直接丢 |
| ⑤ | `splitPlan()` → `chunkReplyText()` | 拆条，决定分几条、每条多长 |
| ⑥ | `scheduleRound()` | **整轮一次排完**：按上一轮水位排队，算好每条的绝对时刻再统一发（见坑 8.30） |
| ⑦ | `firePart()` | 实际发第 i 条，引用段只挂首条、尾巴表情只挂最后一条 |
| ⑧ | `typingDelayFor()` | 模拟打字：`baseMs + 字数/cps`，被 `maxMs` 截断 |

> 出站只保留 `scheduleRound` 一套调度。**不要再加第二套延迟链** —— 两套并存必然交叉，
> 这是 8.21 和 8.27 两次事故的共同根因。

### 5.2 状态与配置

- **`store.js`**：`loadConfig()` 读 `data/config.json`（**深合并默认值**，老配置缺字段会自动补）；
  `renderPersona()` 生成 `AGENTS.md`（**每次保存整体覆盖**，人工改会被冲掉）。
- **`AGENTS.local.md`**：她的长期记忆，**只初始化一次，永不覆盖**。
- **每会话状态**：`proxy.pace` / `proxy.inbox` / `proxy.chatLastAt` / `proxy.quoteMap`（都在内存 Map）。
- **落盘状态**：`data/{proactive,assoc,opinions,stances,qzone}.json`。

### 5.3 提示注入的层次

`dispatch()` 里按顺序往 `frame.message` 前面插 `{type:'text'}` 段：

1. `profileBlock()` — 按人区分的额外设定（可选）
2. `moodLine()` — 当前状态（困/刚醒/上课/该睡了）
3. `opinionLine()` — 表态许可 + 她的立场（**优先于联想，命中就不给联想**）
4. `assocLine()` — 跳题联想许可 + 2 条素材
5. `stickerNudge()` / `voiceNudge()` — 好久没发表情/语音了

**注入要克制。** 每多一层，模型"演算"的概率就高一分（它会把你写的规则念进正文）。

---

## 6. 面板能调什么

按页划分：

| 页 | 关键项 |
|---|---|
| **概览** | 连接状态、今日消息量、Token 统计、QQ 扫码登录 |
| **人格** | 身份/语气/字数、活人味 0-100、反问率、**立场库**（天生的 17 条 + 她自己记的）、<br>**「她现在在干嘛」**（人格卡片正下方，一眼看到当前状态）、**身份与日程**（三层：她是谁 / 什么时候忙 / 她的一天） |
| **回复** | 拆条（字数/条数/间隔）、连发合并、引用、打字速度、跳题联想 |
| **节奏** | 像真人一样回消息（秒回比例 / 三种模式）、深夜变慢、没内容可以不回 |
| **能力** | 搜索/听歌/抖音/OCR/下载/小黄脸/换头像/**记立场**/**改日程** 的开关 |
| **表情包** | 频率、自动收录、贴图回应 |
| **主动** | 主动搭话（时段、间隔、每天几条、话题权重）、忙里偷闲 |
| **说说** | 自动发 QQ 空间、配图概率、来源 |
| **名单** | 白名单、按人设置对话风格 |
| **语音** | TTS 引擎、自动语音频率 |

**所有开关都直接影响 `config.json`**，改完立即生效（不需要重启服务，除非改的是 dsh 侧配置）。

---

### 6.0 面板的「总开关置灰」约定

卡片上的总开关关掉时，卡内其余控件会**变灰且不可编辑**，只留总开关可点，
标题下面会自动出现「（已关闭，下面设置不生效）」。实现是 `data-gate` 属性 + `applyGates()`：

```html
<div class="card" data-gate="r-pace">          <!-- 这张卡受 r-pace 控制 -->
  <div class="switch gate-head">...</div>       <!-- 总开关，永远可点 -->
  <div class="savebar act-keep">...</div>       <!-- 手动动作按钮，不跟着灰 -->
</div>
```

三条约定，加新卡片时照着写：

| 情况 | 用什么 |
|---|---|
| 卡片有自己的总开关 | `data-gate="<开关id>"` + 总开关所在 `.switch` 加 `gate-head` |
| 只有手动动作按钮（发布说说、立即同步） | 那个容器加 `act-keep`，**别让它被灰** |
| 卡片受别的开关牵连（无自己的开关） | `applyGates()` 里单独判断，加 `gated-plain` 或 `gated-by-parent` |

现有牵连关系：**关「启用状态机」→ 「她现在在干嘛」整卡灰 + 「生活节奏」卡灰**
（节奏要读状态决定快慢），但生活节奏自己的开关仍可点。
反过来**关「生活节奏」不影响状态机** —— 状态机还在算，只是不再影响回复时机。

---

### 6.05 表情包：她会自己补货

**开关只有一个：`stickers.enabled`（「表情包」页的总开关）。**

2026-10-22 之前还有第二个：`persona.stickers`（「身份与风格」卡片里的「允许发表情包」，
语义是「这份人设爱不爱用」）。两个开关互相盖不住，是个典型的坑：

| 场景 | 结果 |
|---|---|
| 总闸关、人格写「多发点」 | 命令被禁，叫不出来 —— 人格层的设置是摆设 |
| 总闸开、人格设 `false` | 主号不发，但换个访客又发了 —— 不是「全局不发」 |
| 用户在人格卡片关掉 | 只影响提示词，`qq-sticker` 照样能用，行为看模型心情 |

已经删掉 `persona.stickers`，并在 `loadConfig()` 里加了迁移：老配置读到这个键就
`delete` 并落盘，下次 `writePersona()` 重写 `AGENTS.md` 时那句「不发表情包，情绪用文字表达。」
自动消失。**否则用户会遇到「面板上找不到开关，可她就是不发」—— 改都改不掉。**

> 通用约定：**一个能力只留一个开关，且放在「拥有这个能力」的那张卡片上。**
> 人格层管「怎么说话」，能力层管「能不能做」。同一件事两边都能关，必然出现
> 「关了一个另一个还在跑」的投诉。

库里的表情包是 `paths.stickers` 下的文件 + `index.json` 里的情绪标签。她发图时会按标签挑。

**库空了怎么办**：人格里教了她自己搜（这条不加，她就只会说「没找到合适的」）：

```bash
qq-pic "无语" --sticker -n 4       # 自动补「表情包」关键词，一次下多张候选
# 然后 read_image 看图 → qq-save-sticker "<路径>" --tags "无语,挑眉" --desc "..."
```

搜图用**情绪词**（无语、摆烂、白眼、委屈、得意、震惊），别用「搞笑图片」——
后者出来的是插画和壁纸，不是表情包。工具只保证「像表情包」，贴不贴题靠她看图判断。

> 库里当前 13 张，标签质量不错（`吵嘴_吃白饭的鲱鱼` / `大哭_百万鲸子落泪`），
> 这套标签是「给未来的自己看的」，写的是情绪和场合，不是「图片」「搞笑」这种废话。

### 6.06 对话里的指令：会真去做

人格里有一节「对方让你做事的时候」，划的线是：

- 让他做具体的事（发个表情包、找张图、搜一下、换头像、发说说），**先办再回话**
- 别用「好啊」「我看看」糊过去 —— 那不是像人，那是敷衍
- 三种情况可以不做：工具报错 / 违背自己的立场 / 对方明显在开玩笑；做不到就直说

另外入站这一层还有一道兜底（`panel/lib/request.js`）：识别祈使句，
注入一条「他这句是让你做事」的提示。**优先级：指令 > 表态 > 跳题**，三选一不叠加。

改这段要小心：人格写得越「有人味」（有自己的生活、不是助理），越容易把指令当闲聊。
这两处（人格规则 + 代码兜底）是配套的，删一个另一个就会漏。

---

### 6.07 小黄脸频率

`persona.faceRate`（面板「身份与风格」里的滑杆，0-100，默认 30）：
**十条回复里大概几条挂 QQ 小黄脸**（`[face:14]` 那种）。

- `0` = 完全不用；`100` = 不干预，由模型自己判断
- 人格里会写明「大约每 N 条里有 1 条」，代码再按概率真裁（`proxy.applyFaceRate`）
- 裁剪是**按整条**判断的：命中就保留全部表情，没命中就把这条里的 `[face:N]` 全剥掉。
  逐个剥会出现「一句话带半截表情」，也调不准
- 整条只有一个表情时不会被剥空（那是正常表达，不是噪音）

> 为什么必须有代码这一层：人格里写「别太多」模型根本不听，实测几乎每条都带。
> 想要一个能自己拧的旋钮，就得真按概率裁。

---

### 6.08 语音：三条路，参数怎么填

面板「语音」页有 `provider` 三选一（实际是两档：Edge / 火山，火山里再分官方音色和复刻）。

| 路子 | 音色 ID 长相 | 资源 ID | 花钱 | 你能改吗 |
|---|---|---|---|---|
| **Edge**（默认） | `zh-CN-XiaoyiNeural` | — | 免费 | 面板下拉 14 个 |
| **火山 · 官方音色库** | `zh_female_vv_uranus_bigtts` | `seed-tts-2.0` | 按字符，约 3 元/万字 | 面板下拉 14 个 + 任意手填 |
| **火山 · 声音复刻** | `S_xxxxxxxx` | `seed-icl-2.0` | 同上 | 自己训练后填 |

**核心坑：音色和资源 ID 必须同代，配错不是效果差，是直接失败。**

```
code=55000000 resource ID is mismatched with speaker related resource
```

`seed-tts-2.0` 只认 `*_uranus_bigtts`；`seed-icl-*` 只认 `S_`；1.0 的
`*_moon_bigtts` / `*_mars_bigtts` / `BV*_streaming` 只认 `seed-tts-1.0`。

所以代码里做了两层保护：

1. **面板**：填/选音色 ID 时 `inferResource()` 自动把资源 ID 拨到对应档，
   并在下面提示「识别为 XX，资源 ID 配得上 / 配错了应该是 YY」。
2. **服务端**：`synthesize()` 里再过一遍 `inferResourceId()`，配错就**自动纠正并记日志**
   （复制一份对象再改，不动原配置）。理由：这请求打出去是 100% 失败的，
   纠正一下至少能出声，日志里留下痕迹足够排查。

**实测记录（2026-10-22，该账号）**：官方 2.0 音色 14 个全部能出声（`_uranus_bigtts` 系列），
比复刻还快（595ms vs 1036ms）。**1.0 音色全部 403** —— 不是配错，是「语音合成 1.0」
这个商品没开通。想用 1.0 得先去控制台单独开通，开通后把 `VOLC_PRESET_VOICES`
里的清单一起改（`tests/voice-preset-test.mjs` 会和面板对账，漏改会红）。

**报错怎么读**：

| 现象 | 含义 |
|---|---|
| `55000000 resource ID is mismatched` | 音色版本和资源 ID 不对，见上表 |
| `55000000 json: cannot unmarshal object into Go struct f` | `additions` 传了对象，必须传 JSON 字符串 |
| `403` | 这个音色没开通 / 没授权（1.0 音色最常见） |
| `401` / `Token 错误` | APP ID 或 Access Token 写错 |
| `3001 requested resource not granted` | 走了 V1 旧接口，或该商品没开通 |

**情感（重要坑，2026-10-23 才查清）**：

面板「情感」下拉不是发 `emotion` 字段，而是合成时加一句**语音指令**（`context_texts`）。

原因是实测出来的：官方 2.0 音色（`*_uranus_bigtts`）的音色列表里，支持能力那栏
全是「指令遵循」，没有「多情感」—— `emotion` 字段对它几乎无效（音频只差 ±3%~13%，
基本是抖动），而 `context_texts` 指令差 25%。复刻音色两者都认，`context_texts` 效果也更强。

所以 `synthesizeVolc` 里这样发：

```js
// additions 是 string 类型，必须 JSON.stringify；context_texts 只第一个元素生效，且不参与计费
if (v.emotion && EMOTION_INSTRUCTIONS[v.emotion]) {
  reqParams.additions = JSON.stringify({ context_texts: [EMOTION_INSTRUCTIONS[v.emotion]] })
}
```

映射表在 `store.js` 的 `EMOTION_INSTRUCTIONS`：`happy/sad/angry/surprised/neutral/fear`
→ 「用 XX 的语气说」。面板 `#v-emotion` 的选项必须和它的 key 对账（有测试）。

> 所以「没情感」有两种可能：① 面板情感选的「默认」（不加指令，模型自己发挥）；
> ② 用了 `emotion` 字段的老代码。现在代码统一走指令，选个情感就能听出差别。

**所有失败都会自动回退到 Edge 音色** —— 发不出声音比音色不对更糟。
日志里会写 `语音：火山合成失败，回退到 Edge 音色 —— <原因>`。

**「面板试听」和「她聊天里发语音」必须是同一条链路（2026-10-23 修）**：

```
面板试听  ─┐
          ├─→ synthesize() ─→ 火山（失败回退 Edge）
她发语音  ─┘        ↑
   tts "文字" → POST /api/voice/synth（本机 + internal.token）
```

- 面板试听 `/api/voice/preview`：用**表单上还没保存的值**合成，只回音频、不发 QQ。
- 面板「发到 QQ」`/api/voice`：前端会把**当前表单值**一起带上，
  所以「试听→发送」听到的是同一套参数（掩码 token 会被换回真值）。
- 她聊天里用 `tts "文字"`：**不再自己调 edge-tts**，改为打面板的 `/api/voice/synth`，
  和试听共用 `synthesize()`。想临时换个 Edge 音色：`tts "文字" Xiaoxiao`。

> 以前 `tts` 是独立 bash 脚本，写死 `edge-tts --voice zh-CN-XiaoyiNeural --rate "+8%"`，
> 面板怎么调都不影响它 —— 这就是「试听一个声音、QQ 里另一个声音」的根因，见坑 8.38。

**Edge 没有「情感」设置，这是接口限制不是缺陷**：

`edge-tts` 走的是微软的**免费** Edge 朗读通道，只开放三个旋钮：音色 / 语速（`--rate`）/ 音调（`--pitch`）。
情感风格（`mstts:express-as`）只在 **Azure 付费版** 里才有，免费通道不暴露。

所以面板上「情感」只在**火山**那一档出现 —— 火山的 2.0 音色是「指令遵循」型，
用 `context_texts` 一句话就能让它换成生气/撒娇/温柔，同一段文字听感差 25%（实测）。

想在 Edge 下做出情绪差别，只能靠语速+音调硬调（比如 `-20%` + `+12Hz` 会更像小孩撒娇），
但那是「声学参数」不是「情感」。要真情感就切火山。

**「音色」下拉和「声音 ID」是两个东西**：
- 下拉是**快捷键**：选了具体音色 → 自动填进「声音 ID」框并配好资源 ID。
- 「声音 ID」框才是**真正参数**，复刻音色（`S_xxx`）只能手填。
- 下拉第一项「— 不选，用下面手填的 ID —」= 不再用清单覆盖手填值。
  **它不清空输入框**（清掉复刻 ID 就找不回来了）。

所以「不选 + 保存」之后下拉会**保持在「不选」**（配置里存了 `volc.preset`），
不会又跳回上次那个音色 —— 以前会跳，因为那个选择从来没被提交过。
要真的不用火山，把「声音 ID」框清空（此时界面会提示「还没填声音 ID，发语音会自动退回 Edge」）。

> 权威音色清单在 `store.js` 的 `VOLC_PRESET_VOICES`，面板下拉必须和它一一对应，
> 测试会对账。**加音色先自己实测能出声，再加进清单** —— 清单里放个用不了的 ID，
> 比不放更坑。

---

### 6.09 文件管理器（服务器文件）

面板「文件」页。用于往服务器上传文件、整理 `workspace` 里的资源（复制/粘贴/移动/重命名/删除/下载）。

**安全红线：根目录锁死在 `cfg.paths.workspace`（默认 `/root/qq-workspace`），越界一律拒绝。**

所有路径操作都先过 `panel/lib/fsapi.js` 的 `resolveInRoot(root, rel)`：

```js
const p = path.resolve(root, String(rel || ''))
if (p !== root && !p.startsWith(root + path.sep)) return null   // 越界 → null
```

HTTP 层（`server.js` 的 `/api/fs/*`）和纯文件操作（`fsapi.js`）分开：
- `fsapi.js`：纯函数 + 文件操作，`tests/fsapi-test.mjs` 直接测（不依赖 `ws`）
- `server.js`：路由薄封装，`tests/fs-http-test.mjs` 起独立 server 打真实 HTTP

| 接口 | 作用 |
|---|---|
| `GET /api/fs/list?path=` | 列目录（目录在前、按名排序，带 size/mtime） |
| `POST /api/fs/upload?path=&name=` | 上传（raw body，query 带文件名，上限 64MB） |
| `POST /api/fs/mkdir` | 建文件夹 |
| `POST /api/fs/copy` / `rename` | 复制 / 移动重命名（目标已存在则拒绝，防覆盖） |
| `POST /api/fs/delete` | 删除（文件或目录递归；**不能删根**） |
| `GET /api/fs/download?path=` | 下载 |

两个细节（都是踩过的）：
1. **上传文件名必须等于 `basename`**。别让 `basename()` 静默剥掉 `../x` —— 那样
   「想传 `../x` 结果变成 `x`」，用户一头雾水。`name !== path.basename(name)` 直接 400。
2. **复制/移动都拒绝覆盖**（目标已存在报错），删除才走 `rmSync recursive`。
   这比「静默覆盖」安全 —— 整理文件时手滑覆盖比报错严重得多。

**文件夹上传（2026-10-23 新增）**：

前端多一个「上传文件夹」按钮，对应 `<input type="file" webkitdirectory>`；
每个选中的文件带 `webkitRelativePath`（形如 `我的资料/2026/图.png`），上传时作为 `name` 传给后端。

后端 `safeRelPath()` 负责校验并放行子路径，规则：

| 规则 | 原因 |
|---|---|
| 反斜杠先统一成 `/` | 防 Windows 风格绕过 |
| 拒绝绝对路径（`/x`、`C:x`） | 防跳出根目录 |
| 拒绝空段、`.`、`..`、NUL | 防路径穿越 |
| 每个文件仍过 `resolveInRoot()` | **最终防线**，真实前缀检查 |
| 自动 `mkdir -p` 父目录 | 否则写文件 ENOENT |

> 注意：**放行斜杠 ≠ 放松安全**。原来的 `name === basename(name)` 规则会把合法子目录
> 一起拒掉，导致「选了整个文件夹，一个都传不上去」。换成逐段校验后语义更精确，
> 而且 `resolveInRoot()` 那层没动。
>
> 前端限制：单次最多 300 个文件、总计 512MB（服务器磁盘有限），超了直接拦住并说明原因；
> 多文件时右上角显示「上传中 N/M」；单个文件失败最多报 3 条就停，避免刷屏。

> 前端剪贴板是「复制/剪切 → 去目标文件夹点粘贴」的模型，和桌面文件管理器一致。

---

### 6.1 身份与日程（状态机）怎么配

三层，对应面板上那张卡：

| 层 | 配什么 | 影响 |
|---|---|---|
| **她是谁** | 年龄 + 职业（学生/上班族/自由职业/待业/小朋友/自由自在） | 学生按年龄自动推年级；决定后面用哪套日程模板 |
| **什么时候在忙** | 起床/睡觉/周末起床 + 忙碌时间段 + 这段叫什么 | 忙时她不会主动找你、回得慢；睡觉时间直接判 busy=3 |
| **她的一天** | 日程模板（固定段落 + 活动池）、每天抽几个活动 | 决定每个时刻她说自己"在干嘛"，以及注入给模型的那句话 |

> **换职业会重置固定日程和模板活动池**（因为旧的是上一个职业该做的事：学生改上班族还去打篮球就不对了）。
> 她自己加的活动不受影响，留在 `campus-extra.json` 里跟着走。
> 如果 routine 是她自己定制过的（`source: custom`），换职业也保留 —— 那是她的东西。

**状态判断顺序**（越上优先级越高）：

```
临时计划（qq-routine） > 今日活动 > 忙碌段（课表/上班） > 固定日程 > 赶工日 > 兜底闲
```

**四条使用要点**：

1. **活动优先于忙碌段**。现实里人不是被日程钉死的：大学生会翘课去打球，上班族会请假去团建、
   被派去出差。让课表永远压过活动，反而是假的规律——她天天全勤，一天不落。
   **抽到活动的那天就当她调了课 / 请了假**，人格里也写了「那种日子就不按平时的时间表走」。
2. **活动按日期抽**：今天打球、明天游泳，但同一天内反复问结果固定，不会前后矛盾。
   把「每天抽几个活动」设成 0 就退回天天一样的固定日程。
   **2026-10-23 起「每天抽几个」也可以是「让她自己定」（`eventsPerDay: 'auto'`）**：
   按当天日期种子在 0-3 之间摇（0:15% / 1:40% / 2:33% / 3:12%，期望约 1.4），
   忙的日子多安排两件、累了就一件不安排。同一天内稳定、跨天变化。
   三处入口（面板保存 / 套模板 / 她自己重排一天）都必须走 `normalizeEventsPerDay()`
   统一收口，否则 `Number('auto') = NaN` 会让她「一个活动都抽不出来」。
3. **活动之间不会撞时间**。抽签时排除了重叠的，她不可能同时在图书馆又在逛街。
   撞得太多时宁可当天少抽一个，也不给矛盾状态。
4. **她说了要去干嘛会真算数**：`qq-routine add` 写的是当天的临时计划，优先级最高，
   过了当天自动失效。人格里已经教了她"说要去干嘛就记一笔"。

**跳题（联想）概率按状态分档**：面板上那个「跳题概率」是**基准值**，实际概率 = 基准 × 状态倍率。

| 倍率 | 状态 | 手感 |
|---|---|---|
| 0 | 睡着、午休、正忙、`focus` 活动 | 完全不岔 |
| 0.3-0.4 | 偷闲、赶时间、赶 DDL、关灯后 | 手上有事，只顾回正事 |
| 0.6-0.8 | 临时计划里、刚起床、午/晚饭 | 能聊但不多 |
| 1 | 闲着、固定日程 | 基准值 |
| 1.2-1.3 | 宿舍躺着、晚上、刚忙完 | 最放松，最爱岔 |

要改某一档，在 `config.json` 里写 `reply.assoc.stateFactors`：

```json
{ "reply": { "assoc": { "chance": 30, "stateFactors": { "dorm": 1.8, "crunch": 0.2 } } } }
```

> 这条是「**她说了要去忙，就别立刻岔题**」的实现基础。光靠降概率不够，
> 还得让状态真的变过去 —— 见下面的「自动记状态」。

**自动记状态（`goaway.js`）**：她在话里说「我先去写作业了」「我这边慢慢磨」「我去睡了」时，
出站这层会认出来，自动往当天的临时计划里写一条（默认 45-60 分钟，睡觉 8 小时）。
这样状态会真的变成 `plan`（busy=1），回复变慢、跳题概率降到 0.6，也不会主动找你。

> **为什么需要代码兜底**：人格里早就写了让她自己 `qq-routine add` 记一笔，
> 但从上线到 2026-10-22 她一次都没调用过（`campus-plan.json` 从没被创建）。
> 结果就是嘴上说「我这边慢慢磨」、四分钟后开始聊路边的橘猫。
> 关掉：`reply.autoPlan: false`。

**她的活动池会长大（`data/campus-extra.json`）**

模板里那十来条活动是起点，不是终点。她自己加的、以及从她话里认出来的「想做的事」，
都存在这个文件里，和模板活动池合并参与每天抽签：

```bash
qq-event add "学吉他"                    # 不给时间就自动挑不冲突的空档
qq-event add "去爬山" --from 09:00 --to 12:00
qq-event list / remove "学吉他" / clear
```

- **为什么独立成文件**：`config.campus.routine` 会被「套用模板」「让她重排一天」整个覆盖，
  换职业时也会被清掉 —— 她的积累会一次全没。独立文件跟着她走。
- **上限 30 条**，超出淘汰最早加的。活动池无限长会让「每天抽到不一样的」越来越难。
- **自动排时会避开已有活动**，先试 90 分钟的空档，塞不下压到 60/45/30；
  真挤不下就不加（宁可这次不加，也不要塞一条永远抽不到的重叠活动）。
- **出站兜底**：她说「我想学吉他」「下次想去爬山」时，`proxy.captureWish()` 会自动加进去。
  同样是「提示管不住」的兜底（`qq-routine` 上线至今她一次没调用过）。
  关掉：`reply.autoWish: false`。

**忙里偷闲（sneak）**：`busy >= 2` 的时段里会挖 2-5 分钟的偷闲窗口，那几分钟 `busy` 降成 0，
回消息快、还能主动搭话一次。窗口按「哪一段 + 当天」固定，不会问两次给两个答案。

- **忙碌段和活动都会挖窗口**——再忙的人也会摸一下手机。
- 例外：活动里标了 `focus: true` 的（开会、面试、上课、睡觉）全程不挖，那种场合真看不了。
  要加/去掉这个标记，改 `campus-templates.js` 里活动对象的 `focus` 字段。
- 一天大约挖出 5-15 分钟（看忙多久），不是随时都能偷。

> `busy` 的四档（0 闲 / 1 有点忙 / 2 正忙 / 3 睡着）是 pacing / assoc / proxy / proactive
> 共同依赖的硬契约。**加新职业只换场景，不要动这四档的语义**，否则节奏、联想、主动消息全乱。

---

### 6.2 生图与外部语音识别（模型页）

两个都是「外接别的模型」，都走 OpenAI 兼容协议，所以换个厂商只改地址/模型名。

#### 生图

面板「模型 → 启用生图」。开了之后她在聊天里能自己画图：

```
她 → qq-draw "一句话描述" → 面板 /api/imagegen/generate → 第三方 images/generations
                            ↓
                     workspace/generated-images/*.png
                            ↓
她 → qq_send_image <路径> → 发到 QQ
```

- **接口**：`POST {baseUrl}/images/generations`，`{model, prompt, n:1, size}`。
  `baseUrl` 填到 `/v1` 为止（和 vision 一致）。
- **两种返回都认**：`data[0].b64_json`（直接解码落盘）和 `data[0].url`（下载后落盘）。
  图片格式按**魔数**判定（PNG/JPEG/WebP），不信 `content-type`。
- **上限 10MB**，b64 分支按长度提前拦，不用先解码再拒绝（省内存，2G 机器很关键）。
- **URL 出图必须是公网可达**：`downloadMedia()` 会查 DNS，落到本机/内网/链路本地一律拒。
  这是故意的 —— 让接口返回 `http://127.0.0.1:...` 就能读服务器本机资源，等于 SSRF。
  自己搭的反代如果只在内网，请让生图接口直接回 `b64_json`。
- 落盘文件 7 天后自动清（只清本功能生成的文件名模式，不动别的）。
- 自检按钮会**真的生成一张**（花一次钱），生成完删掉、不发出去；失败率最高的是
  「模型名写错 / baseUrl 少了 `/v1` / key 没额度」，这些只有真调才暴露。

**她怎么知道有这个能力**：`AGENTS.md` 里加了一行 `qq-draw` 说明。
只写「只在真需要图时才用」—— 生成要十几秒，不鼓励当玩笑随手画。

#### 外部语音识别

面板「模型 → 语音识别模型 → 识别方式」。

| 方式 | 谁在转写 | 说明 |
|---|---|---|
| `local` | 插件自带 whisper / 命令行 | 免费、不出机器；默认 |
| `api` | **面板层** `proxy.localizeVoice()` | 音频传给第三方；面板把 record 段换成 `[语音：…]` 再交给模型 |

**必须守住的一条**：`api` 模式下，插件那边的 `sttEnabled` 会被 `renderPatch()` 强制写成
`false`。不这么做的话同一条语音会被转两遍 —— 面板转一次，插件再转一次，第二次还会以
steer 形式补进会话，上下文里出现两份转写。

由此带出一个**必须重启**的约束：`sttEnabled` 写在 `cordis.patch.yml`，dsh 只在启动时读。
所以 `applyConfig()` 把「`asr.provider` 变了」也算进重启条件（`asrChanged`）。
漏掉它的话，界面上切到外部接口、实际插件还在本地转 —— 又变成两遍。

音频来源三种都试：`get_record` 返回的 `base64`、返回的 http(s) 地址、以及宿主机可读的绝对路径。
NapCat 在容器里时最后一种通常读不到，那就降级成 `[语音]`（跟没开这功能一样，不会把消息吞掉）。
外部接口失败也降级，只写日志。

自检按钮用 **1 秒静音** 试连通：验证的是地址/模型/key 通不通，不是识别质量。
对方把静音识别成空字符串属正常，所以「未返回文字」这一种错误算通过。

---

### 6.3 黑话 / 网络用语学习

面板「黑话」页。她聊天时遇到不懂的词，可以「记下来回头学」，确认过的词会写进人格文件。

**为什么不做成「模仿群聊学梗」**：那个思路来自开源项目 `Derpyu520/qq-bridge`（431★），
但它是**仿真群友**——语料是几十个人的群聊，「很多人都在用」本身就是判断依据。
我们是**私聊一对一**（且 `groupPolicy: disabled` 根本没有群），
所以判断标准换成：**这个人反复用**（count）**+ 她自己承认不认识**（主动标记）。

#### 三条采集/研究通道

| 通道 | 触发 | 回执标记 | 成本 |
|---|---|---|---|
| 聊天里顺手标 | 人格里教她：没空查就写一行标记 | `[[生词：词1\|词2]]` | 几乎为 0（几个 token） |
| 每天翻一遍 | 到 `learnAt` 注入一次内部任务 | `[[学词]] {"words":[…]}` | 一次内部回合 |
| 研究含义 | 面板点「研究候选词」 | `[[释义]] [{word,meaning,…}]` | 一次内部回合 + 可能联网 |

三个标记**都在出站层被拦下**，永远不会发到对方那里。

#### 状态机与注入规则

```
新词 → candidate（候选）
        ├─ 面板点「确认」→ confirmed → 满足 count ≥ minCount 才注入人格
        └─ 面板点「拒绝」→ rejected  → 永不注入、再出现也不复活
```

注入写进 `AGENTS.md` 的「## 你最近学会的说法」，条件全满足才收：

1. `status = confirmed`
2. `count ≥ minCount`（默认 2）
3. `meaning` 非空
4. 按 count 排序取前 `injectMax` 条（默认 8，上限 20）

一条都没有就**整节不插入**，不留空标题。

> **注入是这套功能唯一持续增加 token 的地方**：AGENTS.md 每轮全量读取。
> 8 条 × 约 20 字 ≈ 170 字，可以接受；所以默认只放 8 条，并且文案里明写
> 「知道就行，别刻意往句子里塞」。

#### 存储

`panel/data/slang.json`，数组，上限 500 条（超了按「已确认 → count → 最近更新」淘汰）。

```json
{
  "id": "…", "word": "yyds", "meaning": "永远的神", "usage": "", "example": "",
  "status": "confirmed", "source": "ai", "count": 3,
  "evidence": ["语境原文"], "sources": ["来源URL"],
  "createdAt": "…", "updatedAt": "…"
}
```

写入是 `tmp + rename` 原子替换；读取时**区分「文件不存在」和「读失败/JSON 损坏」**——
后者会另存 `.corrupt-<时间戳>` 并抛错，绝不当成空库（否则下一次保存会把学到的词全抹掉）。

#### 面板操作

- **立即学一次**：手动触发「每天翻一遍」那个任务（不用等到点）
- **研究候选词**：把待确认且没有含义的词交给她去查（最多 10 个）
- 每行可以「确认 / 拒绝 / 改 / 删」；「手动加词」直接塞一条（默认已确认）

> `autoResearch`（自动研究）**默认关**：自动研究会把聊天里的词发给搜索引擎，
> 和外部语音识别是同一类隐私问题，要用户自己开。现在的研究一律手动触发。

---

### 6.4 群聊与名单（谁能聊、哪个群能 @）

面板「名单」页把两件事放在一起：**私聊谁能聊** + **哪个群能 @ 她**。
「回复」页那个旧的群聊下拉已经删了 —— 它指向 `reply.groupPolicy`，而实际生效的是
`groups` 配置，那个下拉是**死开关**（改了不生效），留着只会误导。

#### 三层结构

```
群聊总开关（groups.enabled）
  ├─ 关 = 插件层 groupPolicy: disabled，群消息一条都进不来（不进模型、不花 token）
  └─ 开 = groupPolicy: allowlist + groupAllowFrom: [白名单群号]
            └─ requireMention = true（默认）：群里必须 @ 她才回
                 └─ 每个群可有自己的 overrides（人格/回复/语音/表情/黑话）
```

**群成员不需要加进私聊名单**。「能私聊她」和「能在群里 @ 她」是两件事 ——
一个群几十号人逐个加既不现实，语义也不对（`whitelistVerdict` 里群聊走单独分支）。

#### 群档案 vs 访客档案：语义不同，别互相兜底

| | 私聊访客 | 群 |
|---|---|---|
| 继承谁 | 主号配置 + **访客默认** + 个人覆盖 | 主号配置 + 群覆盖，**不套访客默认** |
| 为什么 | 陌生人不熟，通常会设「少说话、不发语音」 | 群里可能是熟人，套陌生人那套会很怪 |

这条前后端必须一致：`resolveProfile(cfg, null, { groupId })` 与前端 `effectiveGroupProfile()`。

#### 群聊没有主动搭话

`proactive` 只通过 `injectPrivateMessage` 往私聊发，群聊天然不会被动到。
**但别把这个当永久保证** —— 以后要加「群里也主动说话」，得单独设计（群消息量大、
容易刷屏、更容易触发风控），不能顺手复用私聊那套调度。

#### 什么改完要重启、什么不用

`cordis.patch.yml` 只在 dsh 启动时读，所以：

| 改动 | 重启 dsh？ |
|---|---|
| 群聊总开关 / 是否 @ / 白名单群号集合 | **要**（会写进 patch） |
| 群里改备注名、调群档案（人格/语音/表情/黑话） | **不用**（只影响我方逻辑） |

判断逻辑在 `server.js` 的 `groupSig()`：只比「会写进 patch 的那几项」。
不能拿整个 `groups` 对象比 —— 那样改个备注名也会白重启一次。

#### 注入上限（2026-10-23 从 155 提到 400）

`profileBlock()` 的正文上限从 155 提到 **400**（整块约 424 字）。

- 原因：155 字连「名字+关系+风格+语气+口头禅」都装不下，按群/按人配置等于白配。
- 成本：424 token / 轮，相对 AGENTS.md 的 ~7245 token 是 **5.8%**，
  且**只对配过档案的群/人才注入** —— 主号私聊仍然是 0。

#### 能力开关不支持按群

`.capabilities.json` 是整个进程一份，19 个 `qq-*` 命令都读它，
**做不到「A 群能搜图、B 群不能」**。这一项是全局的，面板上也没有按群的控制。

要真做，得让命令知道自己被哪个会话调用（改 `qqcap.py` + 传会话上下文），成本远高于其余六项。

---

## 7. 18 个工具（装进 `{{BIN_DIR}}`）

她通过这些命令干活。每个都先过 `qqcap.need()` 检查能力开关，关了就直接拒绝。

> **跨平台注意**：这些工具是 Python 脚本 + 无扩展名（`qq-search` 这种）。
> - Linux / macOS：`cp tools/caps/qq-* {{BIN_DIR}}/ && chmod +x {{BIN_DIR}}/qq-*`，`{{BIN_DIR}}` 要在 PATH 里。
> - **Windows 没有无扩展名可执行文件的概念**，有两种做法：
>   ① 每个包一层 `.cmd`：`@python "{{APP_DIR}}\tools\caps\qq-search" %*`（最省事）
>   ② 改用 `python qq-search` 调用，并同步改 `AGENTS.md` 里的工具用法说明
> - 脚本里若有 `#!/usr/bin/env python3`，Windows 下靠 `python` 命令调用时该行会被忽略，没问题。
> - `qqcap.py` 里若用到 `fcntl` / `pwd` 这类 Linux 专有模块，要换成跨平台实现。

| 命令 | 用途 |
|---|---|
| `qq-search` | 搜网页（多引擎或 DeepSeek 官方） |
| `qq-browse` | 读网页正文 |
| `qq-pic` | **按关键词搜图并下载**（Bing→百度→搜狗兜底，压到 1440px）。加 `--sticker` 走表情包模式：自动补「表情包」关键词、一次下 3-6 张候选，配合 `read_image` 挑图 |
| `qq-grab` | 下载已知 URL 的图片/文件 |
| `qq-music` | 搜歌、歌词、热评 |
| `qq-hear` | 语音转文字 / 猜歌名 |
| `qq-douyin` | 解析抖音链接并抽帧 |
| `qq-ocr` | 图片文字识别 |
| `qq-face` | 查小黄脸编号（回复里写 `[face:14]` 会变真表情） |
| `qq-react` | 给消息贴个大表情（不占一条消息） |
| `qq-sticker` | 看/找表情库 |
| `qq-save-sticker` | 把图存进表情库 |
| `qq-zone` | 发 QQ 空间说说（支持配图，自动 base64） |
| `qq-avatar` | 换自己的头像 |
| `qq-stance` | 记/删自己的立场 |
| `qq-event` | **往自己的活动池里加事**（`add "学吉他"` / `list` / `remove` / `clear`）→ 写 `data/campus-extra.json`，之后哪天可能真的抽到 |
| `qq-routine` | **改自己的当前日程**（`add "19:00-20:30" "打篮球"` / `list` / `now` / `clear`）→ 写 `data/campus-plan.json`，状态机立刻跟着变 |
| `qq-draw` | **按描述生成一张图**，打印路径，再用 `qq_send_image` 发出去。走面板本机接口，**不碰第三方 key**（脚本只读 `panel/data/internal.token`）。`--size` 换比例，`-o` 另存 |

**工具约定**：全部是 `qqcap.py` 的调用方；输出用 `[标签] 内容` 格式便于模型解析；
失败打印 `[错误] 原因` 并退出非 0。

---

## 8. 坑（这一节最值钱，按"现象 → 根因 → 改法"）

> **平台标注**：**没标注的都适用于全平台**。只有系统相关的几条会额外标
> `[Linux 专有]` / `[Windows]` / `[macOS]` / `[Win/Mac]`。
> 换系统部署时，优先扫一遍带标注的条目，其余的坑照旧适用。

### 8.1 心跳被当聊天消息喂给模型

**现象**：日志每 30 秒一条「按回复节奏等待」，但入站消息计数是 0。
**根因**：OneBot 的 `meta_event` 心跳也是 `post_type !== 'message'`，但代码只判断了
`post_type` 存在就往下走，把它当消息交给了模型——白烧 token，还可能顺着那段 `status` JSON 乱说话。
**改法**：非 `post_type === 'message'` 的事件**只透传**给 dsh，不进 `queueMessage`。

```js
if (frame.post_type !== 'message') { this.toNapcat(...); return }  // 透传，不处理
```

### 8.2 延迟做在出站 → 一定失败

**现象**：想让回复"过几分钟再发"，结果报超时。
**根因**：OneBot 的 `send_*` action 有 30 秒超时，回复必须在超时前返回。
**改法**：延迟做在**入站**（压着消息，到点才交给模型）。见第 4 节。

### 8.3 `allowAllUsers: false` 但白名单为空

**现象**：全都连上了，发消息没反应，也没报错。
**改法**：`adminUsers` 必须填上要服务的 QQ 号。

### 8.4 合并时只保留最后一条 frame → 前面的 message_id 全丢

**现象**：想实现"引用第 2 条"，根本拿不到 id。
**根因**：`mergeFrames` 用最后一条当基底，只保留它的 `message_id`。
**改法**：合并时把整批 id 记进 `quoteMap`，并给每条打 `[#N]` 序号让模型能指。

### 8.5 带 `reply` 段的帧被判定"不可分条"

**现象**：一开引用，回复就退化成一整段。
**根因**：`splitPlan` 里 `segs.some(s => s.type !== 'text' && s.type !== 'face')` 直接 `return null`。
**改法**：允许 `reply` 段，单独拎成 `quoteSegs`，**只有第一条带引用**。

### 8.6 入站/出站帧结构不同，同一个 key 算不出来

**现象**：引用静默失效，日志显示查不到。
**根因**：`chatKey(frame)` 认的是入站字段（`post_type` / `message_type` / `user_id`），
而出站帧是 `{action, params:{user_id, message}}`，算出来是 `private:undefined`。
**改法**：加 `outKey(frame)` 同时兼容两种结构，**存和取都用它**。

### 8.7 拆条时删掉中文空格，把标记拆坏

**现象**：`[[引用 2]]` 变成 `[[引用2]]`，解析不出来。
**根因**：`chunkReplyText` 的 `clean()` 会删纯中文片段里的空格。
**改法**：**解析标记必须排在分条之前**。（另外给切分正则加 `(?!\d+\])`，
防止 `[face:27]` 的冒号被当句读切成 `别急[face` + `27]`。）

### 8.8 拼文本段时忽略表情段 → 两句话粘成一句

**现象**：「想你就想你嘛」+ `[face]` + 「被你看出来了啊」→ 发出「想你就想你嘛被你看出来了啊」。
**根因**：`textSegs.map(...).join('')`，过滤掉了中间的 `face` 段。
**改法**：拼接时用占位符 `\u0000` 代替 face 段，清洗完再按占位符换成换行。
`splitPlan` 里同样的问题也要修（它也是 `join('')`）。

### 8.9 拆句丢行边界 → 换行被合并掉

**现象**：她写了两行，发出来是一条。
**根因**：`chunkReplyText` 把每行切碎后全塞进一个数组，行边界丢失，后续"按目标长度合并"会跨行合并。
**改法**：每行结束插一个硬断点，合并循环遇到就 flush。

### 8.10 模型把思考草稿写进正文

**现象**：对方收到 `I'm in class..., Reply briefly explaining.` 或者 `Actually rule: if same thing merge as one reply.`
**根因**：模型会"演算"，尤其当提示写得像说明书时——它会把规则原文念出来。
**改法**：双管齐下。
① 人格里写死「你输出什么 QQ 里就收到什么，不要写思考过程/草稿/英文旁白」；
② 出站兜底 `stripDraftArtifacts()`：整行英文（0 中文 + ≥6 字母）丢、中英混杂且英文占优 + 命中指令词丢、
行首的 `Respond lightly:` 剥前缀、带 `2 lines` 批注时只取引号里那版。
**注意**：必须**先剥前缀再判整行**，否则「Respond lightly: 啊我说反了吗」会连正文一起丢。

### 8.11 主动消息不经过入站漏斗 → 「正在聊」信号丢失

**现象**：她刚主动找你说话，你回一句，她拖几分钟才回。
**根因**：`chatting` 只看 `lastDispatchAt`，而这个时间戳只在入站漏斗里写；
主动消息走 `injectPrivateMessage`，不经过漏斗。
**改法**：加 `markChatSpoke()`，任何真正发出去的私聊都记一笔；`chatting` 看
`max(lastDispatchAt, lastSpokeAt)`。

### 8.12 用全局 `lastUserAt` → 访客压制主号

**现象**：访客说一句话，发给主号的主动消息就被压掉。
**改法**：按会话记 `chatLastAt`，主动消息只看「跟主号这个会话」。

### 8.13 `deepMerge` 只补顶层键 → 新增的子配置是 undefined

**现象**：加了新话题权重，永远抽不到。
**根因**：`loadConfig()` 的深合并只在顶层补默认值，`proactive.weights` 这种嵌套字段新增的 key 不会自动出现。
**改法**：对这类字段**显式写兜底合并**（`mergedWeights()`），别指望深合并。

### 8.14 `[Windows]` 下 `unlink` 会失败，异常被吞 → 状态残留

**现象**：测试里 reset 后还是旧数据，`streak` 一路涨到 69。
**根因**：`fs.unlinkSync` 在文件被占用时抛 EPERM，被 `catch {}` 吞掉，下次读到的还是旧内容。
**改法**：状态权威放内存，文件只当持久化副本；`reset()` 同时清内存。
（Linux 上概率低，但测试里高频跑很容易撞上。）

### 8.15 单字 tag 会误命中

**现象**：说「今天好累」，匹配到的却是「看云」那条素材。
**根因**：tag 里写了 `天`，`今天` 里的 `天` 命中了。
**改法**：**匹配用的 tag 必须是 2 字以上的词**，单字在中文里几乎处处命中。

### 8.16 面板里变量名冲突

**现象**：面板 JS 直接 `SyntaxError: Identifier 'cp' has already been declared`，整页白屏。
**根因**：两个不同功能都用了 `const cp`。
**改法**：改完面板必须跑一次语法检查（把内联 `<script>` 抽出来 `node --check`）。

### 8.17 测试之间共享 `data/config.json` → 互相污染

**现象**：单独跑每个测试都过，连着跑就挂。
**根因**：所有测试共用一个 `PANEL_DATA`，前面的测试把 `campus.enabled` 关了、`enabledAt` 设成现在，
后面的测试就全乱。
**改法**：① 每个测试结束恢复它改过的配置；② 依赖时间的测试显式 `enabledAt: 0`；
③ 会走 `dispatch()` 的测试显式关掉随机注入（联想/表态），否则断言不稳定。

### 8.18 NapCat 在容器里，看不到宿主机的文件

**现象**：`qq-zone --image /root/xxx.png` 报找不到文件。
**根因**：NapCat 容器没挂载宿主机 `/root`。
**改法**：读文件转 `base64://` 再传给 OneBot API。

### 8.19 `reply` 段必须在 message 最前面

**现象**：引用了但不显示。
**改法**：`[{type:'reply',...}, ...正文]`，QQ 只认消息开头的 reply 段。

### 8.20 面板保存会整体覆盖 `AGENTS.md`

**现象**：手工改的规则，下次在面板点保存就没了。
**根因**：`renderPersona()` 每次保存都重写整个文件。
**改法**：要长期保留的内容写进 `AGENTS.local.md`（只初始化一次），或者写进 `persona.extra` 字段。

### 8.21 上游重发同一条回复 → 分条队列交错，语序乱

**现象**：对方收到的句子顺序错乱、有的句子重复。日志里能看到同一个「回复拆成 N 条」出现两次，
「补发第 3/4 条」也出现两次。
**根因**：dsh 偶尔把同一条回复发两遍帧（相隔几秒）。两次都走了 `splitPlan + scheduleRest`，
**两条补发链并行**，各自的延迟不同，于是交错发出。逐条去重挡不住——那一条还没发出去，去重自然命不中。
**改法**：在「分条之后、起发送链之前」加整条判重 `sameReplyAsLast()`：
去掉空白和标点后比对 parts 指纹，30 秒内相同（或一方包含另一方且长度差 <15%）就整条丢弃，
**连 `scheduleRest` 都不启动**。命中时也要回 ack，否则 dsh 收不到响应会重试，重复更多。

> 原来的整条去重是拿**原始文本**算 sha1，两次文本差一个标点就不命中 —— 这是它漏掉的原因。
> 新判重按「去掉标点空白后的指纹」比，才盖得住。

### 8.22 「正在聊」状态在内存里 → 重启后她突然「不理人」

**现象**：改完代码重启面板，紧接着发消息，她几分钟都不回，体感是「刚才还在闲聊，我一说话她就不回」。
**根因**：`proxy.pace` 是纯内存 Map，`lastDispatchAt` / `lastSpokeAt` 一重启就归零 →
`chatting = false` → 节奏层以为「很久没聊」→ 走随机档，抽到 long（8-25 分钟）就真拖几分钟。
2026-10-22 18:47 实测：收到消息 18:47:45，回复 18:53:36，正好 350 秒。
**改法**：① 把这两个时间戳落盘进 `state.json` 的 `chatPace`，`start()` 时 `restorePace()` 读回来；
② 兜底：`startedAt` 之后 3 分钟内一律当「正在聊」（首次部署 / state 被清也能正常回）。
**教训**：凡是「影响体感的时间戳」，只要放内存，就得考虑重启。这个项目里 `assoc` 和 `proactive` 早就落盘了，`pace` 漏了。

### 8.23 `[Win/Mac]` Docker Desktop 不支持 `network_mode: host`

**现象**：在 Windows / macOS 上照抄 Linux 的 compose 文件，NapCat 起不来或起起来但连不上代理；
反向 WS 一直「未连接」。
**根因**：Docker Desktop 的虚拟机网络模型里，`network_mode: host` 要么不支持、要么指向的是 Docker 虚拟机本身，
不是宿主机。Linux 才有真正的 host 共享。
**改法**：
1. compose 里去掉 `network_mode: host`，改成 `ports: ["6099:6099"]`
2. NapCat 的 OneBot 反向 WS 地址从 `ws://127.0.0.1:8643/ws` 改成 **`ws://host.docker.internal:8643/ws`**
3. 代理层和 dsh 仍然跑在宿主机上，互相之间用 `127.0.0.1`，不受影响

### 8.24 `[Win/Mac]` 没有 systemd / journalctl

**现象**：`systemctl` 报 command not found；`dsh-proxy.js` 取不到 dsh 的 token，面板里那张卡片显示「取不到认证」。
**根因**：这套代码最初只为 Linux + systemd 写，日志从 `journalctl -u dsh-web` 里抓。
**改法**：
- 守护进程：macOS 用 launchd（见 3.6），Windows 用计划任务或 nssm
- 日志：让 dsh 的输出重定向到 `{{APP_DIR}}/dsh.log`，然后改 `dsh-proxy.js` 的 `fetchTokenUrl()` 读文件
- **代理层本身不受影响**：它跟 dsh 之间是 `ws://127.0.0.1:8645`，跟 systemd 无关

### 8.28 消息神秘撤回 + 语序乱 → 插件默认开着「流式中间消息」

**现象**：聊天里时不时出现「消息已撤回」，同时句子顺序是乱的（后半句先到、前半句后到）。
日志里能查到 `出站撤回动作：{"action":"delete_msg",...}`，但我们的代码里根本没有 delete_msg。

**根因**：`dsh-onebot-qq` 插件默认开着 `interimMessages`，语义是
**「模型每生成一步（含工具调用之间的中间回复）就把那段文本立即发出去」**，并且：

- 每条中间消息在 `interimRecallMs`（默认 **90 秒**）后**自动单独撤回**
- 回合结束还会先发一张「整轮 t2i 小结卡」再发最终回复

我们的代理层不认识这些中间消息，把它们当成一条条独立回复：
各自拆条、各自按字数算打字延迟。于是消息被拆碎、乱序，然后 90 秒后逐条消失。

**改法**（`writeDshProfile()` 里写进插件配置）：

```yaml
interimMessages: false
interimRecall: false
```

插件就只发最终回复，节奏完全由代理层的分条逻辑控制。改完**必须重启 dsh-web** 才生效。

**排查手法**：`journalctl -u qqbot-panel | grep 出站撤回动作` ——
这条日志是专门加的（`toNapcat` 里对 `delete_msg`/`recall` 留痕）。
如果它出现了，说明撤回请求来自上游插件，不是我们代码。

> 类似的潜在坑：插件还有 `sendErrorNotice`（出错时发 ⚠️ 提示）、
> `rateLimitPerMinute`（每 chat 每分钟条数上限，默认 30）。
> 后者在我们分条策略下可能被触发 —— 一条回复拆 4 条，密集聊天时容易撞上限。

### 8.32 dsh 界面「没连上」：token 含 `_`/`-` 被正则截断

**现象**：概览页的「dsh 界面」卡片里 iframe 显示「dsh web 没连上或取不到认证」，
但概览页顶部的 dsh 状态显示正常。

**根因**：这两处走的是**两条独立链路**，互相不证明对方：
- 概览页「dsh 正常」= panel 通过 WS 连上 dsh 的 onebot（8645）
- iframe「没连上」= panel 反向代理 3080 时**没拿到 dsh 的 auth cookie**

cookie 拿不到是因为抓 token 的正则错了。dsh 的 token 是 40+ 字符、含 `_` 和 `-`：

```
dsh web: http://127.0.0.1:3080/?token=IVMcpLxBup5jQanKTbNDyJpv7Z-PAH6E8tTu3x5dJZw
```

而 `fetchTokenUrl()` 原来的正则 `[A-Za-z0-9]+` 不含 `_`/`-`，token 在第一个 `_`/`-` 处被截断
（`IVMcpLxBup5jQanKTbNDyJpv7Z`），拿去换 cookie 必然 401。

**改法**：正则改成 `[^\s"']+`（匹配到行尾/空白/引号为止），并把提取逻辑抽成
`export function extractTokenUrl(logText)`（`panel/lib/dsh-proxy.js`），单测直接喂日志样本。

实测对照（真实服务器）：
- 截断 token → `401 Unauthorized`
- 完整 token → `303 See Other` + `set-cookie`

> **教训**：token/密钥类字符串别用 `[A-Za-z0-9]+` 去抓。这世界上有的是带 `_`、`-`、`.` 的 token，
> 用 `[^\s"']+`（到空白或引号为止）更稳。

### 8.33 扫码登录失败后二维码「刷新不出新的」

**现象**：QQ 掉线要重新扫码，网页端一直显示旧二维码，点「换一张」也没用。

**根因**：不是前端缓存。NapCat 扫码登录失败（`Login Error,ErrType: 1 ErrCode: 5` = 二维码过期/超时）后，
**不会自动重新生成二维码**，进程就停在那儿。面板的「换一张」只是 force 重新 `docker exec` 读
`/app/napcat/cache/qrcode.png` —— 文件还是旧的，读到的自然还是旧图。mtime 不变，前端轮询也不会换。

**改法（面板侧，`server.js` + `index.html`）**：
- 后端 `napcatLoginError()`：扫 `docker logs napcat --tail 40` 里的 `Login Error,ErrType: N ErrCode: M`
  （5 秒缓存），`/api/qq/login` 在**未登录**时带上这个字段。
- 前端 `renderLogin()`：有 `loginError` 就显示红字「登录失败（ErrType X / ErrCode Y）—— 这个二维码已失效，刷新没用」
  + 一个「重启 NapCat 重新登录」按钮（`docker restart napcat`，重启后自动生成新码）。

> 为什么不在「换一张」里自动重启 NapCat：重启会断掉当前连接（若只是暂时网络抖动会被误伤），
> 所以做成「检测到失败 → 明示 → 用户点一下重启」，而不是后台悄悄重启。

### 8.34 会写 config 的测试必须隔离跑，否则污染生产配置（2026-10-23 出过事）

**现象**：`tests/pace-proactive-test.mjs`、`sneak-test.mjs` 等老测试直接 `saveConfig` 写
`/opt/qqbot/panel/data/config.json`，把它们补同步到服务器后直接 `node tests/xxx.mjs` 跑，
生产的 proactive 被改成测试值（minGap 1、maxGap 2、dailyMax 99、activeFrom 00:00、课表清空），
机器人会带着「测试课表/测试间隔」跑，还查不出为什么。

**根修**：新增 `tests/run-isolated.sh`——把 `PANEL_DATA` 指到临时目录、复制生产 config 进去、
跑完删临时目录。**凡是会 `saveConfig` 的老测试，一律这样跑**：

```bash
cd /opt/qqbot
bash tests/run-isolated.sh pace-proactive-test.mjs
bash tests/run-isolated.sh sneak-test.mjs
```

纯逻辑测试（`conv-state-test`、`campus-test`、`fsapi-test` 等，不写 config）不受影响，直接 `node` 跑。

> 教训：**判断「会不会打架 / 参数范围」先读实际配置，别拿代码 DEFAULT 当真**；
> **会写生产状态的测试必须隔离**。这两条这次都踩了。

### 8.35 切到外部语音识别后同一条语音被转两遍

**现象**：面板选了「外部语音接口」，日志里同一条语音出现两次转写，
模型上下文里有两份内容略有差异的转写，回复开始重复对方刚说过的话。

**根因**：转写有两条链路 —— 面板的 `localizeVoice()` 和插件自带的 STT。
`renderPatch()` 已经把 `sttEnabled` 写成 `false`，但 **`cordis.patch.yml` 只在 dsh 启动时读一次**，
而 `applyConfig()` 当时只把 `model/features/onebotPort/context` 当成重启条件，
`asr.provider` 变了不重启 → 插件带着旧值 `sttEnabled=true` 继续本地转写。

**改法**：
1. `applyConfig()` 增加 `asrChanged`（比较 `before.asr.provider` 与 `after.asr.provider`），
   并入重启条件；
2. `localizeVoice()` 在替换 record 段后，插件只看到 text，从根上不会再转。

**验证**：`tests/multimodal-test.mjs` 第 7 组断言
「`asr.provider=api` 时 patch 里必须是 `sttEnabled: false`」。
线上没做真实切换（会重启 dsh 打断正在聊的天），这条只有单元级证据。

### 8.36 生图接口返回 url 时被自家 SSRF 防护挡住

**现象**：生图自检报「媒体地址不能指向本机或内网」，但接口确实返回了图片 URL。

**根因**：`downloadMedia()` 会先做 DNS 解析再拦私网地址（`127/10/172.16-31/192.168/169.254/…`），
防止「接口返回 `http://127.0.0.1:3080/...` 就把服务器内部页面当图片读回来」。

**改法（不是关掉防护）**：
- 自建反代/内网服务，让它直接回 `b64_json`，绕开下载这一步；
- 或把图片放到公网可达的地址。
**不要**为了跑通去放宽 `privateIP()` —— 那等于给第三方接口开了读内网的口子。

### 8.37 聊天里出现 `[[引用 1]]` 字样

**现象**：对方收到一条正常回复，中间夹着 `[[引用 1]]`（或 `[[引用 2]]`）原文。

**根因**：引用功能只认**段首**那一个标记（`parseQuoteMark` 有 `^` 锚定），剩下的一律当正文。
可她的真实写法是**一条回复写两个标记** —— 合并消息里两条不同的事各指一条，例如：

```
[[引用 2]]那你去忙 [[引用 1]]记得别马上躺
```

段首那个正常变成 QQ 引用，中间那个就原样发出去了。会话记录里能直接查到这种写法。

**改法**：
1. 新增 `stripQuoteMarks(text)`，用**全局**正则删掉所有 `[[引用 N]]` 变体
   （含无空格 `[[引用1]]`、`[[引用第2条]]`），删完把连续空格压成一个；
2. `applyQuote()` 不再只处理 `firstText`，而是遍历**所有 text 段**剥标记：
   段首那个变成真引用，其余的删掉；顺手取「第一个非空 text 段」，
   避免转发/分条塞进来的空段把解析挡掉；
3. 只剩标记、没有正文时返回空 message，交给上层整条丢弃（不能发一个光秃秃的引用气泡）。

**验证**：`tests/quote-test.mjs` Q12–Q15（本地缺 `ws` 依赖，在服务器上跑）：
双标记、只有中间标记、无空格写法、`第N条` 变体、只剩标记整条不发，全部通过。

> 规矩：**内部标记只允许出现在「自己认的位置」**。给模型加新标记时，
> 必须同时想清楚「写错位置会怎样」—— 写错位置不能变成对方看得见的文字。

### 8.38 面板调好音色/语速，QQ 里听到的却是另一个声音

**现象**：面板语音页把音色换成火山复刻的 `vv`、语速调到 0.8，点「试听」是对的；
可她聊天里真发出来的语音完全是另一个声音，改多少次都没用。

**根因（两层，都得修）**：

1. **`/usr/local/bin/tts` 是独立 bash 脚本**，自己写死了
   `edge-tts --voice zh-CN-XiaoyiNeural --rate "+8%" --pitch "+2Hz"`，
   **完全不读面板配置**。试听走 `synthesize()`（火山），她发语音走 `tts`（Edge Xiaoyi）——
   两条链路各用各的参数，设置等于没生效。
2. **掩码 token 进 HTTP header**。面板「发到 QQ」按钮会把表单值一起带给后端，
   而表单里的 `accessToken` 回填的是 `••••••`。判等只写了 `=== MASK`，
   一旦掩码长度/字符对不上就漏判，`•`（U+2022）被塞进 `Authorization`，
   Node 抛 `Cannot convert argument to a ByteString because the character at
   index 0 has a value of 8226`，火山这条路**静默失败 → 自动回退 Edge**，
   于是又听到另一个声音。

**改法**：
1. `tts` 重写成薄客户端：只读 `panel/data/internal.token`，POST `/api/voice/synth`，
   由服务端用 `cfg.voice` 合成。聊天、试听、发送从此共用一条链路。
2. 新增 `looksMasked(s)`：**只要含非 ASCII 就视为掩码**（真 token 必是纯 ASCII），
   替换掉所有 `=== MASK` 精确比对；`synthesizeVolc()` 里再加一道前置校验，
   遇到非法 token 直接报明确错误，而不是静默降级。
3. `/api/voice/synth` 也做「只保留最近 50 个 mp3」的清理（老脚本里有，换实现别丢）。

**验证**（线上真实凭证）：
- `tts "你好呀…"` → 日志 `本机 TTS 合成（volc / zh_female_vv_uranus_bigtts）`；
- `tts "…" Xiaoxiao` → 日志 `（edge / zh-CN-XiaoxiaoNeural）`；
- 模拟面板「发到 QQ」（表单 token 为 `'••••••'`）→ 火山合成成功，没有回退；
- `tests/tts-cli-test.mjs` 14 项（服务器上跑）。

> 教训：**同一个能力有两条实现，就一定会漂**。判断「设置有没有生效」时，
> 先确认「用户操作的那条路」和「实际执行的那条路」是不是同一个函数。

### 8.39 语速调到负数就报 `usage: edge-tts [-h] [-t TEXT] ...`

**现象**：语音页把语速选成 `-10%`（或 `-20%`、音调 `-6Hz`），点试听报：

```
语音合成失败: usage: edge-tts [-h] [-t TEXT] [-f FILE] [-v VOICE] ...
```

错误只有一大段 usage，看不出到底错在哪。调成正数就正常。

**根因**：`synthesize()` 里参数是分开传的：

```js
'--rate', v.rate    // v.rate = '-10%'
```

`edge-tts` 用 argparse 解析，看到 `-10%` 会当成**新的选项**，
于是 `--rate` 缺少参数 → argparse 打印 usage 退出（exit 2）。

触发条件很隐蔽：默认 `+8%` 是正数不炸，一旦拉到负数就必炸。
面板下拉里 **`-20%` / `-10%` / `-6Hz` 三个选项全都会踩**，
也就是说这个功能从上线起就没在"慢速/低沉"下工作过。

**改法**：所有参数一律用等号连写，argparse 才知道后面是值：

```js
const args = [
  `--voice=${v.voiceName || 'zh-CN-XiaoyiNeural'}`,
  `--rate=${v.rate || '+0%'}`,
  `--pitch=${v.pitch || '+0Hz'}`,
  `--text=${String(text).slice(0, 500)}`,
  `--write-media=${file}`
]
```

**顺带**：`/api/voice/preview` 的 catch 以前**不写日志**，试听失败在 `journalctl` 里查不到，
只能靠用户截图。已补 `log('试听合成失败（provider）：原因')`。

**验证**（线上实测，5 组正负组合全过）：

| rate | pitch | 输出 | 说明 |
|---|---|---|---|
| -20% | -6Hz | 32256 B | 两个负数 |
| -10% | +0Hz | 28080 B | 就是报错那组 |
| +0% | -6Hz | 24624 B | 只负音调 |
| +8% | +2Hz | 23328 B | 推荐值 |
| +30% | +12Hz | 21168 B | 又快又高 |

字节数随语速单调递减（越慢文件越大），说明参数真的生效了，不是"能跑就算过"。

> 教训：**给 CLI 传以 `-` 开头的值，一律用 `--opt=value`**。
> 分开写时 argparse / getopt 都可能把它当选项，而报错信息只会甩你一段 usage。

### 8.40 加内部标记时，最容易漏的是「写错位置」

**现象（同类问题出现过两次）**：
- `[[引用 1]]` 漏到聊天里 —— 一条回复写了两个标记，只剥了段首那个；
- 生词标记 `[[生词：…]]` 理论上同样可能夹在正文中间。**这是加功能时必须先想的问题。**

**根因模式**：内部标记的处理很容易写成「只看第一个 text 段 / 只认开头」，
而模型并不遵守「必须写在开头」。一旦位置不对，标记就变成对方看得见的文字。

**规矩（给以后加任何内部标记用）**：

1. **扫全部 text 段、任意位置**，不只 `message[0]`；
2. **剥完没正文就整条不发**，并回 ack（不发光秃秃的标记气泡）；
3. **格式坏的也要吞**：以 `[[学词]]` / `[[释义]]` 开头但 JSON 解析失败的，
   必须匹配前缀就丢弃 —— 否则解析失败 → 继续往下走 → 原样发出去；
4. **处理顺序在分条之前**：`splitPlan` 会把文本切碎，切开的标记谁也认不出；
5. **测试要覆盖「第二个 text 段里的标记」**，这条是对应上面两次事故的回归用例。

> 现在的检查点：`tests/slang-proxy-test.mjs`（11 项）专门验证「标记在第二段也能剥」，
> `tests/quote-test.mjs` Q12–Q15 验证引用标记的同类场景。

### 8.41 加了一行代码，整个代理「假在线」（2026-10-23 真实事故）

**现象**：面板显示 dsh 已连接，但消息发不出去；QQ 侧提示机器人掉线；
面板日志每 30 秒一条「待投 20 条」，**却没有任何「连接中断」记录**。

**根因链（四步，一步比一步隐蔽）**：

1. 部署黑话功能时，`const plain` 被写在了 `if (outFrame) { … }` **块内**，
   而块外新加的一行 `this.rememberSlang('她', plain)` 引用了它
   → **每条出站消息必抛 `ReferenceError: plain is not defined`**。
2. 这个异常发生在 ws 的 `message` 事件回调里，**逃出了事件循环**
   → 把这条上游 socket 的接收流弄坏。
3. socket 坏了之后 **`close` 事件再也不来** → `fail()` 一次没跑 → `scheduleRetry()` 从没挂上
   → **面板永久「假在线」**。日志里一条「连接中断」都没有，所以最难查。
4. dsh 那边 `send_msg` 等 30 秒超时 → 60 秒收不到 pong → `heartbeat timeout` +
   `OneBot disconnected 1006` —— 用户在 QQ 上看到的「掉线」是这一步。

**改法（四条，缺一不可）**：

| 改动 | 作用 |
|---|---|
| `plain` 提到块外声明（`let plain = ''`，块内赋值） | 修 ReferenceError 本身 |
| 上游 `message` 处理整体包 `try/catch` | **单条消息出错只记日志，不许弄死 socket** |
| `fail()` 里置空 `this.upstream`；旧连接迟到的 close/error 不连坐新连接 | 防重连风暴 |
| 新增 20 秒**主动探活** `checkUpstream()` | 不依赖 close 事件：无连接/CLOSED 立即重连，CONNECTING 超 20s 掐掉重来，OPEN 但连续 3 次 ping 无 pong 判死 |

顺手修：`forwardUp()` 断线时**心跳事件不再进补投队列**（原来 30 秒一条心跳把 20 条队列占满，
真正要补的消息全被挤掉）。

**验证**：新增 `tests/proxy-outbound-test.mjs`（临时 PANEL_DATA + 假 dsh/NapCat）。
**旧代码跑同一测试 3 项失败**（帧没转发 + 异常逃逸），新代码 8 项全过 —— 能复现才叫修好。

> **两条教训**：
> 1. **`const`/`let` 的块级作用域 + 后续在块外加代码 = 定时炸弹**。
>    改长函数时，新增的引用一定要确认声明在**同一个或更外层**作用域。
> 2. **不能只依赖 `close` 事件判断连接死活**。socket 可以「活着但收不到任何东西」，
>    必须有一条主动探活（定时 ping / 无 pong 判死）兜底，否则故障表现为「假在线」，
>    比直接断开难查十倍。


### 8.31 未登录只看到一行「未登录」——静态页面被鉴权拦住了

**现象**：手机第一次打开面板，屏幕上一行 `未登录`（或者 `{"error":"未登录"}`），
没有输入框、没有页面、什么都没有。电脑端看着一切正常。

**根因**：静态文件服务排在 `if (!authed(req)) return 401` **后面**。

```
GET /  →  401  application/json  {"error":"未登录"}
```

浏览器拿到的是 JSON 不是 HTML，页面里那个登录层（`#gate`）根本没机会渲染。
电脑端"正常"只是**cookie 还在**——不是它没问题，换个浏览器/清一下 cookie 立刻一样坏。

**改法**：把静态块提到鉴权之前，并**排除 `/dsh` 前缀**（否则 `/dsh/xxx` 的 GET
会被当静态文件查、返回 404，永远走不到反向代理）。

```js
// 静态：公开（目录里只有 index.html，不含数据）
if (req.method === 'GET' && !p.startsWith('/api/') && p !== '/dsh' && !p.startsWith('/dsh/')) { … }

// 以下全部要登录
if (!authed(req)) return send(res, 401, { error: '未登录' })

// dsh 反向代理：在鉴权之后（界面里能看到模型对话）
if (p === '/dsh' || p.startsWith('/dsh/')) { … }
```

**顺序不能变**。安全上没损失：`PUBLIC_DIR` 里只有 `index.html`，
真正的数据全在 `/api/*` 和 `/dsh/*` 后面。

**前端配套改了两处**（原来都靠比字符串，换个措辞就失效）：

1. `api()` 遇到 **HTTP 401** 统一调 `needLogin()` 把登录门叫出来，并给错误对象打
   `e.authRequired = true`。`needLogin()` 是幂等的——`/api/login` 密码错也是 401，
   那时门本来就开着，不能把「密码错误」四个字自己擦掉。
2. `refresh()` 原来写 `if (String(e.message).includes('未登录')) location.reload()`。
   改成看 `e.authRequired`，且**不再 reload**：reload 会丢掉正在填的表单，手机上还多一次白屏。

**顺手修的**：`writeDshProfile()` 直接 `writeFileSync` 到 `profiles/web/cordis.patch.yml`，
目录不存在就 ENOENT 把整个服务带崩。干净机器上首次部署、或 `DSH_HOME` 指到新路径就会撞到。
加一句 `mkdirSync(path.dirname(PATCH_FILE), { recursive: true })`。

**怎么验**（`tests/auth-gate-test.mjs`，27 项，起真实 server 打独立端口）：

```
/            200 text/html  ← 页面能拿到
/api/me      200 authed:false ← 前端靠它弹框
/api/state   401            ← 数据锁住
/dsh/ /dsh   401            ← dsh 界面锁住
/nope.html   404            ← 不存在就是 404，不是 401
```

外加源码级断言：静态块的位置必须在鉴权之前、必须排除 `/dsh`、
dsh 代理必须在鉴权之后。**位置关系错了会直接红，不靠人眼 review。**

### 8.30 一轮话没说完，下一轮插进来 → 语义串味、顺序错乱

**现象**：一次发来几个语义不同的问题，她把它们拆成多条回复时，第二轮的第一条插进了
第一轮的第 2、3 条中间。收到的效果是「问 A 答了一半突然聊 B，然后又跳回 A」，
单看每条都没错，连起来读不通。

**根因**：补发链是「发一条、排下一条」的写法（`scheduleRest`），每轮各自起一条链。
链与链之间**没有排队**——第二轮按自己的延迟开跑，正好落在第一轮还没发完的空档里。
每一轮内部是顺序的，跨轮次就没人管顺序。

**改法**：把「逐条排」换成「整轮一次排完」。

```js
scheduleRound(plan, firstDelay) {
  const qkey = plan.qkey
  const prevAt  = this.outAt.get(qkey)   || 0   // 上一轮：下一条该发的时刻
  const prevEnd = this.outUntil.get(qkey) || 0   // 上一轮：整轮预计结束的时刻
  // 从上一轮结束 + 换气停顿开始，排队上限 15 秒
  let base = prevEnd > Date.now() ? Math.min(prevEnd + ROUND_GAP, Date.now() + MAX_QUEUE) : Date.now()
  const slots = []                                // 先把整轮的绝对时刻全算出来
  // …每条 at = base + delay，一次性 setTimeout
  this.outAt.set(qkey, slots.at(-1).at)
  this.outUntil.set(qkey, slots.at(-1).at + TAIL_MS)
}
```

三个必须一起改的点，少一个就还是乱：

1. **`at = base + delay`**，不能写 `max(now + delay, 上一条时刻)`。
   后者在延迟小于耗时的时候会让两条挤在同一毫秒，实际发送顺序就取决于网络抖动了。
2. **首条不能用自己的判重挡掉**。判重（`sameReplyAsLast`）是为了挡上游重发，
   但新一轮首条如果内容和上一条相近，就会被误杀。改成 `if (i > 0)` 才判。
3. **`chatKey` 认不出出站帧**。出站帧结构和入站不同，用入站的 key 算法算出来是 `null`，
   于是所有轮次都落在同一个桶里。要单独用 `outKey()`。

**排队上限 15 秒**是刻意的取舍：6 条 × 5 秒 = 30 秒，新问题不能等半分钟。
超了就压缩排队、允许轻微重叠——宁可贵一点乱，也不要让人盯着屏幕等。

**验证手法**：起一个假 dsh（定时推两轮帧），在独立端口上抓出站时间戳：

```
1. [+299ms]  甲一     2. [+842ms]  甲二     3. [+1380ms] 甲三
4. [+1759ms] 乙一     5. [+2358ms] 乙二
```

看两点：顺序是否严格甲一二三→乙一二，间隔是否稳定在 400~600ms。

**与 8.21 的区别**：8.21 是**同一条**回复被上游重发两遍 → 两条链并行；
这里是**两条不同的**回复 → 一轮没完就起新一轮。前者靠判重解决，后者只能靠排队。

### 8.29 t2i 长消息卡片静默失效：四层根因（2026-10-23 才全部挖穿）

**现象**：面板上「长消息卡片」开着，但从来没见它转成过图，长回复照样是文字。日志里反复：

```
[dsh-onebot] t2i render failed, falling back to text: t2i: no usable CJK font family
```

**这不是一个 bug，是四层叠在一起的**，每层修掉才露出下一层：

1. **`@napi-rs/canvas` 注册 TTC 只暴露 JP face 且字形加载失败**。
   `NotoSansCJK-Regular.ttc` 注册后 `GlobalFonts.families` 里只有 `Noto Sans CJK JP`，
   而且渲染「中」出来的是豆腐块（实测 PNG 确认）。fontconfig 的 `fc-list` 能看到 SC
   是一回事，@napi-rs/canvas 认不认是另一回事。
2. **配置的 `fontFamilies: ["Noto Sans CJK SC"]` 匹配不到**（available 里只有 JP）。
3. **插件的兜底提取有大小写 bug**：`extractNotoScFace()` 判断 `name.includes('SC')`，
   但 TTC 里的 postscriptName 是 `NotoSansCJKsc-Regular`（**小写 sc**）—— 永远匹配不上。
4. **就算前三层都修了，`inkCheck()` 的阈值 600 在 Linux + Noto 上也过不了**：
   它渲染 40px「中」统计深色像素，作者在 macOS 测出 ">600"，但 Linux Noto 的
   「中」实际只有 ~364（笔画细），被误判成"不可用"。肉眼确认渲染是**完美汉字**。

**修法（对应四层）**：

- **第 1-3 层**：用 fontTools 从 TTC 里把 SC face 抽成独立 OTF
  （`TTCollection.fonts[2].save(...)`，纯解包不重编码，秒级完成 —— **千万别用 fontkit
  全量 createSubset，那次把服务器拖到 SSH 失联**），然后在 onebot 插件配置里加：

  ```yaml
  fontFiles:
    - "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf"
  fontFamilies:
    - "Noto Sans CJK SC"
    # ...
  ```

  插件 init 第一步就注册 fontFiles，families 里有了 SC，`firstAvailable` 直接命中。
  这个配置在 `store.js` 的 `renderPatch()` 里（cordis.patch.yml 是它生成的，手改会被冲）。

- **第 4 层**：插件 `fonts.js` 的 `if (ink < 600)` 改成 `if (ink < 300)`
  （豆腐块实测 ~224，正常「中」~364，300 居中）。
  **这是改 node_modules 里的第三方插件**，备份在 `fonts.js.bak-20261023`，
  **升级 dsh-onebot 插件后要重打这个补丁**。

**最终验证**：`FontManager.create({fontFiles: [...], fontFamilies: [...]})` →
`usable: true`，chain `["Noto Sans CJK SC"]`；渲染「中文测试」PNG 肉眼确认笔画清晰。

**怎么确认服务器上有哪些字体族**：`fc-list :lang=zh family | tr ',' '\n' | sort -u`
（但记住：fc-list 能看到 ≠ @napi-rs/canvas 认）。

---

### 8.27 两套「回复延迟」串联 → 调哪个都不对

**现象**：面板上把「回复速度」拉到秒回，她还是要好几分钟才回；改成生活节奏秒回，又还是慢。

**根因**：存在两段串联的延迟，各由一张卡片控制：

```
pace（0~25 分钟，什么时候交给模型） → speed（0~120 秒，旧机制） → typing（0.5~6 秒，模拟打字）
```

调其中任何一个，另一段照样生效。而且 `speed >= 1` 时还有一段人格提示让她自己跑
`shuf -i 5-90 | xargs sleep`，等于第三重。

**改法**（2026-10-22 已修）：整条 `reply.speed` 链路删除，包括那张卡片、`updateSpeedLabel`、
按人设置的 `pf-r-speed`、以及人格里「你必须先 sleep」的段落。
现在延迟只剩两层，职责清楚：**pace 决定什么时候看手机，typing 决定打多久**。

**教训**：加新的延迟/节奏机制前，先确认「什么时候交给模型」这条链路只有一个入口。
同一个语义有两个开关，用户永远调不对，而且报上来的现象会互相矛盾。

---

### 8.26 重启卡 90 秒，期间 NapCat 连不上、消息全丢

**现象**：`systemctl restart qqbot-panel` 要等一分半才回来；NapCat 日志刷
`ECONNREFUSED 127.0.0.1:8643`，这段时间用户发的消息直接丢。
journal 里是 `State 'stop-sigterm' timed out. Killing.`

**根因**：`server.close(cb)` 的**回调要等所有连接都断开**才触发。面板有 SSE 长连接
（日志流、状态轮询、dsh 反向代理），它们不会自己断，回调永远不执行 → 进程不退出 →
systemd 等 90 秒后 SIGKILL。

**改法**：`SIGTERM` 处理里加两件事（`server.js`）：

```js
server.close(() => process.exit(0))
server.closeAllConnections?.()          // Node 18.2+，立刻掐断 SSE
setTimeout(() => process.exit(0), 800)  // 硬兜底，绝不拖到 systemd
```

实测从 **90 秒降到 848ms**（`closeAllConnections` 之后 close 回调仍不触发，
实际每次都走 800ms 兜底分支，但已经够快）。

**验证方式**（不用真重启，安全）：

```bash
PID=$(systemctl show -p MainPID --value qqbot-panel)
time (kill -TERM $PID; while kill -0 $PID 2>/dev/null; do sleep 0.05; done)
```

---

### 8.25 `[Windows]` 无扩展名脚本跑不了

**现象**：`qq-search` 在 Windows 上「不是内部或外部命令」。
**根因**：`tools/caps/` 里是无扩展名的 Python 脚本 + shebang，Windows 不认。
**改法**：给每个命令配一个 `.cmd` 包装：`@python "{{APP_DIR}}\tools\caps\qq-search" %*`，
或者统一改成 `python qq-search` 调用并同步更新 `AGENTS.md` 里的工具用法。

---

## 9. 验收清单

部署完按这个顺序验，**每一行都过了再往下**。

### 9.1 通用检查（三平台都要过）

```bash
# 1. NapCat 容器在跑
docker ps | grep napcat

# 2. 四个端口都在听
#    Linux/macOS：ss -tlnp | grep -E '6099|8643|8645|18080'
#    Windows：    netstat -ano | findstr "6099 8643 8645 18080"

# 3. 面板能开
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/    # 200 或 302

# 4. 白名单里有自己（空的话她谁都不回）
grep -A2 adminUsers {{DSH_HOME}}/profiles/web/cordis.patch.yml
```

### 9.2 服务与日志（按 OS）

| 检查项 | Linux | macOS | Windows |
|---|---|---|---|
| 服务活着 | `systemctl is-active dsh-web qqbot-panel` | `launchctl list \| grep qqbot` | `Get-ScheduledTask qqbot-panel` |
| 看日志 | `journalctl -u qqbot-panel -n 30` | `tail -30 {{APP_DIR}}/panel.log` | `Get-Content {{APP_DIR}}\panel.log -Tail 30` |
| dsh 插件报错 | `journalctl -u dsh-web -n 30 \| grep -i error` | `tail -30 {{APP_DIR}}/dsh.log \| grep -i error` | 同左 |

**链路必须看到这三条日志**（缺一不可）：

```
代理端口 8643 → dsh 端口 8645
已连接 dsh: ws://127.0.0.1:8645/ws
NapCat 已接入代理
```

### 9.3 功能验收（去 QQ 里发）

| 发什么 | 期望 |
|---|---|
| 「在吗」 | 几秒到几分钟内回（看节奏设置），不是秒回 |
| 一段 100 字的话 | 拆成 2-4 条，条之间有间隔 |
| 连发 3 条不相关的话 | 合并成一次判断，可能带引用 |
| 「发个表情」 | 真发一张表情包 |
| 「发条语音」 | 真发语音 |
| 「你今天干嘛了」 | 会带状态（上课/宿舍/困） |
| 追问同一件事 | 立场前后一致（不会今天一个说法） |

---

## 10. 日常运维

### 10.1 看她在干什么（最有用的命令，没有之一）

```bash
# Linux
journalctl -u qqbot-panel -f | grep -E '收到|拆成|跳过|引用|剥掉|允许这次'

# macOS
tail -f {{APP_DIR}}/panel.log | grep -E '收到|拆成|跳过|引用|剥掉|允许这次'

# Windows（PowerShell）
Get-Content {{APP_DIR}}\panel.log -Wait -Tail 20 | Select-String '收到|拆成|跳过|引用'
```

### 10.2 看她的真实输出（含模型原始文本）

session 是 zstd 压缩的，路径里的 `--root-qq-workspace--` 是工作区路径的转义形式
（Windows 下会变成 `--D-qqbot-workspace--` 这种，按实际目录去看）。

```bash
zstd -dc {{DSH_HOME}}/sessions/<工作区转义>/onebot-private-<QQ号>/session.v4.jsonl.zstd | tail -40
```

> Windows 没有 zstd 的话，可以先 `winget install Facebook.Zstandard`，
> 或者干脆用 dsh 自己的界面看（面板「概览」里内嵌了）。

### 10.3 改完代码后的标准流程

```bash
cd {{APP_DIR}}/panel
node --check lib/proxy.js          # 1. 语法
# 2. 跑测试（见 tests/，14 套）
# 3. 重启（下面按 OS 选一条）
systemctl restart qqbot-panel                          # Linux
launchctl kickstart -k gui/$(id -u)/com.qqbot.panel    # macOS
Stop-ScheduledTask qqbot-panel; Start-ScheduledTask qqbot-panel   # Windows
```

### 10.4 回滚

```bash
ls {{APP_DIR}}/_bak/
cp -a {{APP_DIR}}/_bak/<时间戳>/lib/* {{APP_DIR}}/panel/lib/
# 然后按 10.3 重启
```

**备份策略**：每次部署前 `cp -a panel/lib panel/public server.js` 到 `_bak/<月日-时分>/`。

---

## 11. 不要做的事

1. **别手工改被自动生成的文件**：`{{WORKSPACE}}/AGENTS.md`、`{{DSH_HOME}}/profiles/web/cordis.patch.yml`
   都是面板生成的，下次保存会被覆盖。要改就改面板，或者写 `AGENTS.local.md`。
2. **别用主的 QQ 号**。协议端有封号风险，用小号。
3. **别把 18080 直接暴露到公网**。它有密码鉴权，但没必要。远程用 SSH 隧道就够；
   本地部署它本来就只听回环。
4. **别在 `dispatch()` 里无限加注入**。每多一层提示，模型"念规则"的概率就高一分。
   现在已经有 5 层了，再加要谨慎。
5. **别用 `nohup` 跑服务**。Linux 用 systemd（`Restart=always`）、macOS 用 launchd、
   Windows 用计划任务——否则终端一断就没了。
6. **别指望模型完全听话**。所有"行为约束"都要在代码里兜一层底（这是本工程最大的经验）。
7. **别把 Linux 的 compose 文件直接抄到 Windows/macOS**。`network_mode: host` 在那儿不成立，
   必须改端口映射 + `host.docker.internal`（见 8.23）。

---

## 12. 换一台机器部署时，最容易翻车的 5 个地方

按这个顺序自查，能省掉大部分返工：

| # | 最容易错 | 怎么确认 |
|---|---|---|
| 1 | **NapCat 的反向 WS 地址**（Linux 用 `127.0.0.1`，Win/Mac 用 `host.docker.internal`） | NapCat 日志里有没有「反向 WS 已连接」 |
| 2 | **`adminUsers` 忘了填自己的 QQ** | `grep adminUsers` 有值，且不是空数组 |
| 3 | **`messagePostFormat` 不是 `array`** | NapCat 的 OneBot 配置里确认 |
| 4 | **三个 token 不一致**（NapCat / dsh / 面板） | 三处 `accessToken` 完全相同 |
| 5 | **端口被占 / 被防火墙挡** | 四个端口本地都能 `curl` 或 `netstat` 到 |

过了这 5 条还不行，就去第 8 节按「现象」搜。

---

## 13. 手机部署（预研，尚未实施）

> **状态：只做了依赖审计和方案设计，代码一行没改。**
> 用户 2026-10-23 说「后面再慢慢做」，所以这节先当施工图放着。
> 真正动手时按 13.5 的顺序推进，每步都要能单独验证。

### 13.1 结论先说

**可行，但「装个 App」和「把它搬过去」是两件事。**

- **手机登 QQ（NapCat）**：官方支持，有 Termux 一键脚本，这条路没问题。
- **面板 + dsh 搬上手机**：要改一层「运行环境适配」，因为现有代码默认
  「有 systemd、有 Docker、路径写死在 `/opt/qqbot`」。

### 13.2 两条路线，先选一条

| | A · 半套（手机只当 QQ 端） | B · 全套（手机当服务器） |
|---|---|---|
| 手机跑什么 | 只跑 NapCat | NapCat + dsh + 面板 |
| 电脑/服务器 | 继续跑 dsh + 面板 | 不需要 |
| 改动量 | **很小**：给代理加一个「允许外部 NapCat 连入」的开关（见 13.2.1） | 中到大（13.4 那张清单） |
| 依赖关系 | 离了服务器就不能用 | 完全独立 |
| 适合 | 想让 QQ 登录不占服务器、或想让手机号当机器人 | 想省服务器钱 / 想要一个「自己的实体机器人」 |

> **建议先做 A**：它最大的价值是**先验证手机能不能稳定挂住 QQ**
> （后台被杀、断网重连、连续跑一周不掉线）。这个结论不拿到，
> B 做完了也可能每天掉线，白折腾。

#### 13.2.1 A 路线的连接方向（这点最容易想反）

**方向是「手机主动连服务器」，不是「服务器连手机」** —— 所以**不需要内网穿透**。

```
手机（Termux + NapCat）               服务器
   NapCat 配「WebSocket 客户端」  ──→  ws://<服务器IP>:8643/ws
                                       面板代理（监听 8643）
                                          ↓
                                       dsh（8645）
```

原因：NapCat 支持以**客户端**身份主动连出去，手机在运营商 NAT 后面也能连；
反过来让服务器去连手机才需要穿透。

**但当前代码有个限制**：代理监听写死在本机 ——

```js
// panel/lib/proxy.js:948
new WebSocketServer({ host: '127.0.0.1', port, path: '/ws', ... })
```

所以 A 路线要么：

| 做法 | 安全性 | 改动 |
|---|---|---|
| ① 加配置项，允许改成 `0.0.0.0` | 中（靠 `accessToken` 鉴权，已实现 `checkToken`） | 小：`host` 从配置读 |
| ② 手机侧走 SSH 隧道 / frp / Tailscale | 高 | **零代码改动**，只在手机上多跑一个隧道进程 |

> 推荐 ②：手机 `ssh -L 8643:127.0.0.1:8643 root@服务器` 或装 Tailscale，
> 让手机以为代理在本地。既不用改代码，也不把 8643 暴露到公网。
> ① 留作「不想在手机上多跑东西」时的备选，但**必须同时改 `accessToken` 成强随机值**。

### 13.3 手机端怎么装 NapCat（A/B 都要）

官方支持 Termux，不是野路子：

```bash
# 1. 装 Termux（F-Droid 版，别用 Play 商店那个已停更的）
# 2. 一键脚本
curl -fL -o napcat.termux.sh \
  https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.termux.sh
bash napcat.termux.sh

# 3. 启动（proot 里跑 Linux 版 QQ + 虚拟显示）
bash proot-distro login napcat -- \
  bash -c 'xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox'
```

要点：
- 原理是 **Termux → proot 装 Debian → 跑 Linux 版 QQ + NapCat + Xvfb**（虚拟显示，无头跑 QQ）。
- 备选：`NapNeko/NapCat-Termux` 提供 ZeroTermux 恢复包，适合不想敲命令的。
- **必须把 Termux 设为「允许后台活动」**，否则系统省电策略会随时杀它。
- 建议 `termux-wake-lock` 持有唤醒锁；有 root 的话更稳（可以常驻前台服务）。

### 13.4 需要改的清单（B 路线，按文件列）

审计命令：`grep -rn "systemctl\|journalctl\|'docker'" panel/ --include=*.js`

| # | 现在是什么 | 在哪 | 手机上要变成 |
|---|---|---|---|
| 1 | `systemctl is-active <svc>` ×2、`systemctl restart` ×3 | `panel/server.js`（状态检测、切模型/ASR 后重启 dsh） | 抽象成 `svcStatus(name)` / `svcRestart(name)`；手机端用 **进程 pid 文件 + `kill`** 或 Termux 的 `sv` |
| 2 | `journalctl -u <svc>` 取 dsh token | `panel/lib/dsh-proxy.js:42` | 改成读**日志文件**（dsh 启动时把带 token 的 URL 写进固定文件） |
| 3 | `journalctl -u <svc>` 看日志 | `panel/server.js:1781` | 改成 `tail` 日志文件 |
| 4 | `docker logs / inspect / restart napcat` ×8 | `panel/server.js`（86/122/642/666/731/1043/1307/1784） | 手机上没有 Docker：NapCat 就在**同一个 proot 容器里**，改成读它的日志文件、用 pid 管理 |
| 5 | `docker cp` / `docker exec`（表情同步进 QQ 收藏） | `panel/server.js:642,666` | 直接读写容器内路径（同容器，无需 copy） |
| 6 | `ROOT_DIR` / `DATA_DIR` 默认 `/opt/qqbot/...` | `panel/lib/store.js:10-11` | **已经有 `PANEL_ROOT` / `PANEL_DATA` 环境变量兜底**，手机端设环境变量即可，不用改代码 |
| 7 | `paths.workspace` 默认 `/root/qq-workspace` | `panel/lib/store.js:293` | 首次启动写成手机上的路径（如 `$HOME/qq-workspace`）；面板里也能改 |
| 8 | 19 个 `qq-*` 工具里写死 `/opt/qqbot/panel/data`、`/root/qq-workspace`、`/usr/local/share/whisper` | `tools/caps/*` | 改成读环境变量（`QQPANEL_DATA` / `QQPANEL_WS` / `WHISPER_MODEL`），或装到 Termux 的 `$PREFIX/bin` 并统一 `HOME` |
| 9 | 外部命令 `edge-tts` / `ffmpeg` / `tesseract` / `whisper-cli` | `server.js`、`tools/caps/*` | Termux 里 `pkg install ffmpeg tesseract`、`pip install edge-tts` 都能装；**whisper.cpp 要自己编 arm64**（或改用外部 ASR 接口，我们已经有这个能力） |
| 10 | 代理监听写死 `127.0.0.1`（`panel/lib/proxy.js:948`） | A 路线要让外部 NapCat 连入时才有影响 | 从配置读 `host`，或干脆不改、用 SSH 隧道/Tailscale（13.2.1） |
| 11 | systemd unit 文件 | 部署步骤第 3 节 | 手机上换成 `termux-services`（`sv`）或自写的 `start.sh` + pid 文件 |

**新增一个模块会更省事**：`panel/lib/runtime.js`，把「起服务/查状态/重启/读日志」四件事抽象掉，
`server.js` 里那 14 处调用改成走它，按 `process.env.RUNTIME === 'termux'` 分支。这样以后换别的环境也只改一个文件。

### 13.5 建议的实施顺序（每步都能单独验收）

| 阶段 | 做什么 | 验收标准 |
|---|---|---|
| 0 | 手机装 Termux + NapCat，扫码登 QQ，常驻 24h | 第二天还在线、没被系统杀 |
| 1 | 手机装 NapCat，扫同一个号；配成 **WS 客户端**连服务器 8643（或先起 SSH 隧道） | 面板概览显示 NapCat 已连接，能收发消息 |
| 2 | 抽出 `runtime.js`，服务器行为不变 | 现有测试全过、线上照常工作 |
| 3 | 手机装 Node 22 + 面板（只读模式：能看状态、不能重启服务） | 面板能打开、能看日志 |
| 4 | dsh 在手机上跑起来（**最大风险点**，见 13.6） | `dsh web` 能起、能对话 |
| 5 | 服务管理、日志、路径全部切到手机环境 | 面板所有按钮都能用 |
| 6 | 19 个工具迁移 + 外部命令补齐 | `qq-search` / `qq-ocr` / `tts` 都能跑 |

### 13.6 风险清单（按严重程度）

| 风险 | 说明 | 应对 |
|---|---|---|
| **dsh 原生模块** | 它依赖 `koffi`、`node-pty` 这类原生模块，arm64 上要现场编译，**很可能失败** | 先在 Termux 里 `npm i @deepseek-ai/dsh` 试装；失败就退回 A 路线（dsh 留服务器） |
| **后台被杀** | Android 省电策略会杀 Termux | 允许后台活动 + 唤醒锁；有条件用 root 或旧手机插电常亮 |
| **电量与发热** | 常驻 QQ + Node 服务，旧手机可能一天两充 | 插电、关屏幕、降频 |
| **内存** | 手机 8G 其实比现在 1.7G 的云服务器宽裕；但 Android 自身要吃 3-4G | 关掉不用的 App；面板 `NODE_OPTIONS=--max-old-space-size=192` 可保留 |
| **Termux 的 Python/Node 与系统隔离** | proot 里的 NapCat 和 Termux 主环境是两个世界，路径不互通 | 统一在 Termux 主环境跑 Node，NapCat 在 proot，通过 `127.0.0.1` 通信 |
| **音频能力** | 语音合成要联网（火山/Edge），语音识别要 whisper | 外部 ASR 已经能用，正好绕开本地 whisper |

### 13.7 待定（等真正实施时再补）

- 手机型号 / Android 版本 / 是否 root —— 影响后台存活方案
- 走内网穿透还是公网直连（A 路线需要）
- 是否保留 `docker` 分支（如果以后又回到服务器部署）
- 19 个工具是「改造成环境变量」还是「手机单独一份」—— 前者干净，后者快

### 13.8 换机器 / 换系统时的数据迁移（「她还记得我吗」）

她的「记忆」不在人格提示词里。搞清楚数据分布，才知道换 Windows、换手机、换服务器时该搬什么。

#### 13.8.1 数据分布（2026-10-23 线上实测）

| # | 存什么 | 路径 | 体量 |
|---|---|---|---|
| 1 | **长期记忆**（她主动记的称呼/喜好/约定/日期） | `{{WORKSPACE}}/AGENTS.local.md` | 约 2KB / 21 行 |
| 2 | **对话正本**（"记得上下文"主要靠这个） | `{{DSH_HOME}}/sessions/<workspace-slug>/session-<uuid>/session.v4.jsonl.zstd` | 3.3M |
| 3 | **会话投影缓存**（可重建，**不是正本**） | `{{DSH_HOME}}/storages/session_projcache/sessions/*.json` | 248K |
| 4 | **QQ 会话 → session 映射**（不搬就连不上旧会话） | `{{DSH_HOME}}/media/onebot/chat-sessions.json` | 几百字节 |
| 5 | **工作区注册表** | `{{DSH_HOME}}/storages/workspace.json` | 1.5K |
| 6 | **她的状态**（立场/联想/日程/主动计数/黑话/空间） | `{{APP_DIR}}/data/*.json` | 60K |
| 7 | **配置**（人格/语音/模型/名单/群档案） | `{{APP_DIR}}/data/config.json` | 11K |
| 8 | **表情库**（图片 + `index.json` 索引/标签） | `{{WORKSPACE}}/stickers/` | 3.8M |

**不用搬**：`AGENTS.md`（面板每次保存整体重写）、`.bak`、`panel/data/logs/`、
`voice/` `downloads/` `generated-images/`（体积大，不含记忆）、`panel/data/internal.token`（会重新生成）。

> ⚠️ **第 2 项和第 3 项别搞混**：`session_projcache` 是**投影缓存**，
> 只搬它、不搬 `sessions/` 里的 `session.v4.jsonl.zstd`，等于没搬对话历史。
> 这是最容易踩的一个坑（本文档第一版就写错过）。

#### 13.8.2 打包（在旧机器上）

```bash
cd /
# 路径按实际替换：WORKSPACE / DSH_HOME / APP_DIR
WS=/root/qq-workspace
DH=/root/.dsh
APP=/opt/qqbot/panel

tar -czf /tmp/qqbot-migrate-$(date +%Y%m%d-%H%M).tar.gz \
  "$WS/AGENTS.local.md" \
  "$WS/stickers" \
  "$DH/sessions" \
  "$DH/storages" \
  "$DH/media/onebot/chat-sessions.json" \
  "$APP/data"
```

> `$DH/media/onebot/` 里可能还有 `retired-sessions.json` 等，整目录打包更保险，但别把 `media/` 下的大文件带上。

#### 13.8.3 还原（在新机器上）

```bash
# 1) 先让新机器把服务跑起来（NapCat 登录、dsh 能起），再还原数据
#    否则 dsh 可能已经建了空会话/空工作区，覆盖时容易冲突

# 2) 备份新机器上现有的同名目录
cd / && mv /root/qq-workspace /root/qq-workspace.new 2>/dev/null
mv /root/.dsh /root/.dsh.new 2>/dev/null

# 3) 解包
tar -xzf qqbot-migrate-YYYYmmdd-HHMM.tar.gz -C /

# 4) 修权限（配置里有 key/token，必须收紧）
chmod 600 /opt/qqbot/panel/data/config.json
chmod 700 /root/.dsh

# 5) 改路径（若新机器路径不同）
#    编辑 /opt/qqbot/panel/data/config.json 里的：
#      paths.workspace  → 新机器的工作区绝对路径
#      paths.stickers   → 新机器的 {workspace}/stickers

# 6) 重启
systemctl restart qqbot-panel
```

#### 13.8.4 会踩的坑（按踩到概率排序）

| # | 坑 | 现象 | 怎么办 |
|---|---|---|---|
| 1 | **只搬了 `session_projcache`** | 聊天记录没了，她完全不记得之前聊过什么 | 真正的对话在 `sessions/*.zstd`，见 13.8.1 |
| 2 | **session 目录名是工作区路径的 slug** | 目录搬过去了，dsh 却像换了新会话 | `sessions/<slug>/` 的 slug 由工作区绝对路径生成（如 `--root-dsh_workspace--`）。**新机器路径最好保持完全一致**；不一致就先启动一次看它生成什么 slug，再把旧目录改名过去 |
| 3 | **漏了 `chat-sessions.json`** | QQ 来消息了，但走的是新会话，旧历史读不到 | 这个文件是「QQ 会话 → dsh session」的映射，必须一起搬 |
| 4 | **换了 QQ 号** | 彻底失忆 | 会话文件名和映射都带 QQ 号（`onebot-private-<QQ>.json`）。**同一个号才能延续**，换号等于换一个人 |
| 5 | **`config.json` 里的绝对路径** | 面板打开文件页报错、表情库空 | 改 `paths.workspace` / `paths.stickers` |
| 6 | **`DSH_HOME` 没重设** | dsh 跑到 `~/.dsh` 新建了一套空数据 | Windows 设环境变量；Termux 上是 `$HOME/.dsh`；确认 dsh 实际用的是哪个目录 |
| 7 | **文件权限太松** | 面板能起，但日志警告；config 里有 API key | `chmod 600 config.json`、`chmod 700 ~/.dsh` |
| 8 | **CRLF** | 脚本报 `bad interpreter: /usr/bin/env python3^M` | Windows 上编辑过的文件，部署前 `sed -i 's/\r$//' <file>`（本项目一直这么做） |
| 9 | **dsh 版本差太多** | 会话文件读不出来 / 直接重建空会话 | 会话是 `session.v4.jsonl.zstd`（v4 格式）。**迁移前后保持同一大版本**；升级要单独做，别和迁移混在一起 |
| 10 | **NapCat 登录态搬不走** | 迁移后要重新扫码 | 登录态在容器/设备本地，属于"不能搬"的东西。**迁移前先准备好扫码** |
| 11 | **火山复刻音色是云端资源** | 配置搬过去了，但报 `S_xxx` 不存在 | 音色绑在**火山账号**上，不随文件走。同一个账号 + 同一个 ID 就能用；换账号要重新训练 |
| 12 | **时区不同** | 作息、主动搭话时段整体偏几小时 | `timedatectl set-timezone Asia/Shanghai`（或对应时区） |
| 13 | **`proactive.json` 里的计数** | 迁移当天"已经发过 N 条"，不再主动说话 | 想立刻恢复就把该文件里的当日计数清零；不在意就等第二天 |

#### 13.8.5 搬完怎么验证「她真的记得」

按顺序做，每步都能看出问题出在哪一层：

1. **看长期记忆是否读到** —— 发一句「我是谁」，她应该能叫出你的名字/称呼
   （来自 `AGENTS.local.md`）。叫错 → 第 1 项没搬对。
2. **看对话历史是否接上** —— 提一件**昨天聊过、但长期记忆里没写**的事
   （比如某个临时话题）。她能接上 → 第 2/3 项搬对了。
3. **看会话是否复用** —— `journalctl -u qqbot-panel | grep -i session`，
   或者比对 `.dsh/sessions/` 下有没有新增 session 目录。新建了 → 映射没搬对（坑 3/4）。
4. **看表情库** —— 面板「表情包」页有图、并能正常发。空 → 第 8 项没搬。
5. **看配置** —— 面板各页显示的是你熟悉的设置，不是默认值。

> **一句话**：`AGENTS.local.md` 决定她"记得你是谁"，`sessions/` + `chat-sessions.json`
> 决定她"记得聊过什么"。两个都得搬，缺一个就是半失忆。

---

## 附：这套工程的核心经验（如果只记一句话）

> **提示负责"想让它怎样"，代码负责"保证它一定这样"。**
>
> 提示能塑造风格，但管不住行为。分条、节奏、引用、去重、剥草稿、防复读——
> 这些全都不能只写在提示里，必须在代理层兜一层。
> 凡是"模型偶尔会翻车"的地方，都要有代码级的兜底，而不是加一句"请不要"。
