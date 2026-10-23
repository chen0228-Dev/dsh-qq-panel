#!/usr/bin/env bash
# dsh + NapCat 环境初始化（Ubuntu / Debian / Alibaba Cloud Linux / CentOS 通用）
# 用法：bash bootstrap.sh
set -euo pipefail

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "必须用 root 运行"

# ---------- 0. 发行版检测 ----------
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1;    then PM=dnf
elif command -v yum >/dev/null 2>&1;    then PM=yum
else die "无法识别的发行版，请手动安装"
fi
log "包管理器：$PM"

ARCH=$(uname -m)
log "架构：$ARCH　内核：$(uname -r)"

MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
log "内存：${MEM_MB}MB　根分区可用：${DISK_GB}GB"
[ "$DISK_GB" -ge 8 ] || die "磁盘可用空间不足 8GB，dsh 的 node_modules 放不下"

# ---------- 1. swap（<4G 内存必做） ----------
if [ "$MEM_MB" -lt 4096 ] && [ ! -f /swapfile ]; then
  log "内存不足 4G，创建 2G swap"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  log "swap 已挂载：$(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
fi

# ---------- 2. 基础依赖 ----------
log "安装基础依赖（curl / git / 编译链 / python3）"
if [ "$PM" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg git build-essential python3 xz-utils lsb-release
else
  $PM install -y curl ca-certificates git gcc gcc-c++ make python3 xz
fi

# ---------- 3. Node.js 22 ----------
if command -v node >/dev/null 2>&1; then NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]'); else NODE_MAJOR=0; fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  log "安装 Node.js 22.x"
  if [ "$PM" = apt ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null
    $PM install -y nodejs
  fi
else
  log "已存在 Node.js $(node -v)"
fi
node -v

# ---------- 4. npm 镜像 + pnpm ----------
log "配置 npm 镜像并安装 pnpm"
npm config set registry https://registry.npmmirror.com
npm install -g pnpm@latest >/dev/null
pnpm -v

# ---------- 5. Docker ----------
if command -v docker >/dev/null 2>&1; then
  log "Docker 已存在：$(docker -v)"
else
  log "安装 Docker"
  if curl -fsSL --max-time 20 https://get.docker.com -o /tmp/get-docker.sh; then
    sh /tmp/get-docker.sh >/dev/null
  else
    warn "get.docker.com 拉取失败，改用阿里云镜像源安装"
    if [ "$PM" = apt ]; then
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    else
      die "非 Debian 系请手动安装 Docker 后重跑"
    fi
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker -v
docker compose version

# ---------- 6. 目录骨架 ----------
mkdir -p /opt/qqbot/napcat/config /opt/qqbot/napcat/qq
log "工作目录已建：/opt/qqbot"

# ---------- 7. 防火墙（只放行 SSH） ----------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null
  log "ufw 已放行 22"
fi

log "环境初始化完成"
echo
echo "下一步："
echo "  1) cd /opt/qqbot && docker compose up -d      # 起 NapCat"
echo "  2) ssh -L 6099:127.0.0.1:6099 root@<服务器IP>  # 本地开隧道看 WebUI"
echo "  3) npm i -g @deepseek-ai/dsh && dsh web        # 装并起 dsh"
