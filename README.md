# Hera Monitor

轻量、零依赖、一键部署的服务器监控面板 —— 类似[哪吒监控](https://github.com/nezhahq/nezha)，但部署与接入都只需要**一条命令**。

> **Server 端零 npm 依赖**（只用 Node 内置模块），**Agent 是纯 bash 脚本**（只依赖 `/proc` 和 `curl`）。

```
┌──────────────┐    HTTP/JSON 上报     ┌─────────────────────────┐
│  被监控服务器  │ ───────────────────▶ │   Hera 服务端 (Node.js)  │
│  hera-agent  │                       │  ┌───────────────────┐  │
│  (纯 bash)   │ ◀─────── 下发间隔 ──── │  │ 面板 / SSE / 告警  │  │
└──────────────┘                       │  └───────────────────┘  │
                                       └────────────┬────────────┘
                                                    │ 浏览器实时推送
                                                ┌───▼────┐
                                                │ 监控面板 │
                                                └────────┘
```

---

## 📸 界面预览

**概览** —— 卡片式实时状态，CPU / 内存 / 硬盘 / 负载 / 网速一屏看完

![概览](docs/screenshot-overview.png)

**服务器详情** —— Canvas 手绘历史曲线，5 分钟到 7 天自由切换

![详情](docs/screenshot-detail.png)

**站点监控** —— HTTP / TCP 探针，延迟、可用率、最近 60 次探测热力条

![站点监控](docs/screenshot-monitors.png)

**告警** —— 多渠道推送 + 规则配置 + 事件日志

![告警](docs/screenshot-alerts.png)

---

## ✨ 特性

| 能力 | 说明 |
|---|---|
| 🖥 **实时监控** | CPU / 内存 / 交换分区 / 磁盘 / 网络速率 / 负载 / 进程数 / TCP 连接 / 在线时长，SSE 秒级推送 |
| 📈 **历史曲线** | 5 分钟 / 1 小时 / 6 小时 / 24 小时 / 7 天，服务端自动降采样；Canvas 手绘图表，无 CDN 依赖 |
| 🌐 **站点监控** | HTTP(S) / TCP 探针，状态码与关键字校验、延迟统计、24 小时可用率、最近 60 次探测热力条 |
| 🔔 **多渠道告警** | Webhook / Telegram / 钉钉 / 飞书 / Bark / Server 酱 / Gotify；支持阈值、持续时长、指定服务器、冷却时间 |
| 🏷 **服务器管理** | 分组、标签、地区、备注、价格、到期日、自定义排序 |
| 🔒 **安全** | 随机初始密码、HMAC 签名会话、登录限流、路径穿越防护、Agent 密钥可轮换、时序数据裁剪 |
| 📦 **一键部署** | `install.sh` 自动装 Node + 注册 systemd；也提供 Docker / docker-compose |
| 🪶 **轻量** | 单进程常驻内存约 40MB；Agent 常驻内存 < 3MB |

---

## 🚀 快速开始

### 一、部署服务端

在**一台**服务器上执行（Debian / Ubuntu / CentOS / RHEL / Alma / Rocky / Alpine / Arch 均可）：

```bash
# 方式 A：从仓库直接部署
curl -fsSL https://raw.githubusercontent.com/tmclsamxy/hera-monitor/main/install.sh | sudo bash

# 方式 B：已克隆仓库，本地部署
git clone https://github.com/tmclsamxy/hera-monitor.git
cd hera-monitor && sudo bash install.sh
```

脚本会自动完成：检测/安装 Node.js → 拷贝程序到 `/opt/hera-monitor` → 注册 systemd 服务 → 启动。

启动后会打印**管理员初始密码**（也写入 `data/initial-password.txt`）。浏览器打开 `http://服务器IP:8080` 即可登录。

**Docker 部署（任选）：**

```bash
docker compose up -d
# 或
docker run -d --name hera-monitor -p 8080:8080 -v hera-data:/data --restart unless-stopped ghcr.io/tmclsamxy/hera-monitor:latest
```

> 💡 生产环境建议用 Nginx / Caddy 反代并开启 HTTPS（配置示例见 `deploy/nginx.conf`）。
> 反代时记得关闭 SSE 缓冲：`proxy_buffering off;`（本项目的示例配置已包含）。

### 二、接入被监控服务器

登录面板 → 右上角 **「+ 接入新服务器」**，复制那一条命令，在目标服务器上以 root 执行：

```bash
curl -fsSL http://你的面板地址:8080/install-agent.sh | sudo bash -s -- \
  --server http://你的面板地址:8080 --key 你的AGENT密钥
```

约 3 秒后面板上就会出现这台服务器。**不需要在面板上预先添加服务器**，Agent 首次上报会自动注册。

可选参数：

```bash
--name 香港-Web-01     # 自定义显示名称
--region HK            # 地区标签
--group 生产            # 分组
--interval 30          # 上报间隔（秒），也可在面板统一调整
```

卸载：

```bash
curl -fsSL http://你的面板地址:8080/install-agent.sh | sudo bash -s -- --uninstall
```

---

## 🧩 目录结构

```
hera-monitor/
├── server/                  # 服务端（Node.js，零 npm 依赖）
│   ├── src/
│   │   ├── index.js         # HTTP 服务、路由、SSE、静态资源
│   │   ├── config.js        # 配置与密钥、密码哈希
│   │   ├── store.js         # 服务器状态、时序指标落库与降采样
│   │   ├── probe.js         # HTTP / TCP 探针实现
│   │   ├── monitors.js      # 站点监控调度器
│   │   ├── alert.js         # 告警规则引擎与各渠道推送
│   │   └── util.js          # 通用工具
│   ├── public/              # 面板前端（原生 JS + Canvas 图表）
│   └── package.json
├── agent/
│   ├── hera-agent.sh        # Agent 本体（纯 bash）
│   └── install.sh           # Agent 一键安装脚本
├── deploy/
│   ├── nginx.conf           # 反代配置示例
│   └── hera-monitor.service # systemd 单元参考
├── Dockerfile
├── docker-compose.yml
└── install.sh               # 服务端一键部署
```

---

## ⚙️ 配置

服务端通过环境变量调整：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HERA_PORT` | `8080` | 监听端口（也兼容 `PORT`） |
| `HERA_HOST` | `0.0.0.0` | 监听地址 |
| `HERA_DATA_DIR` | `../data` | 数据目录，Docker 中为 `/data` |

Agent 通过命令行参数或 `/etc/hera-agent.conf` 配置，另支持：

| 变量 | 说明 |
|---|---|
| `HERA_AGENT_CONF` | 配置文件路径，默认 `/etc/hera-agent.conf` |
| `HERA_AGENT_STATE` | 状态目录，默认 `/var/lib/hera-agent` |
| `HERA_AGENT_INSECURE=1` | 跳过 HTTPS 证书校验（自签证书场景） |
| `VERBOSE=1` | 打印每次上报结果 |

**Agent 排障：**

```bash
hera-agent --print      # 只打印采集到的 JSON，不上报
hera-agent --once       # 只上报一次，观察返回
tail -f /var/log/hera-agent.log
journalctl -u hera-agent -n 50
```

---

## 🔔 告警渠道配置要点

| 渠道 | 需要填写 |
|---|---|
| 自定义 Webhook | 接收 URL（POST JSON：`{title, text, source, time}`） |
| Telegram | Bot Token + Chat ID |
| 钉钉机器人 | Webhook 完整地址；开启「加签」时再填密钥 |
| 飞书机器人 | Webhook 完整地址 |
| Bark | 推送 Key（自建服务填服务地址） |
| Server 酱 | SendKey |
| Gotify | 服务地址 + 应用 Token |

规则类型：`CPU 使用率` / `内存使用率` / `硬盘使用率` / `系统负载` / `服务器离线` / `站点监控失败`。
每条规则可设置**阈值**、**持续时长**（避免抖动误报）、**生效服务器**和**通知渠道**，全局冷却时间默认 600 秒。

---

## 🛠 常见问题

**Q：面板打不开 / Agent 上报失败？**
检查安全组是否放行了面板端口；确认 `--server` 用的是 Agent 能访问到的地址（不要写 `localhost`）。

**Q：Agent 装完没反应？**
在目标机执行 `hera-agent --print` 看 JSON 是否正常，再执行 `hera-agent --once` 看上报返回。若返回 `invalid agent key`，说明密钥不对或被重置过。

**Q：只显示 CPU 不显示网速？**
网速是两次上报之间的差值算出来的，**第一次上报必然为 0**，等一个上报周期即可。

**Q：数据存在哪？会不会一直涨？**
`data/metrics/*.jsonl` 按服务器分文件追加，默认保留 7 天（面板可改），每 6 小时自动裁剪一次。

**Q：想用域名 + HTTPS？**
用 Nginx/Caddy 反代到 `127.0.0.1:8080`，然后在面板「设置 → 面板公网地址」填写域名，一键安装命令会自动使用该地址。参考 `deploy/nginx.conf`。

---

## 🧪 开发与测试

服务端零 npm 依赖，克隆下来直接跑：

```bash
git clone https://github.com/tmclsamxy/hera-monitor.git
cd hera-monitor
node server/src/index.js          # 默认 http://localhost:8080
```

跑一遍端到端测试（会自动起一个临时实例，不碰你的正式数据）：

```bash
bash test/run.sh
```

覆盖健康检查、静态资源、鉴权、登录限流、Agent 注册与上报、指标降采样、站点监控探测、
告警触发与推送、密钥轮换、SSE 推送、异常与边界共 56 项断言。

Agent 本地排障（任何 Linux 机器上都能跑，不需要服务端）：

```bash
bash agent/hera-agent.sh --print     # 只打印采集到的 JSON
bash agent/hera-agent.sh --once --server http://x:8080 --key yy   # 只上报一次
```

---

## 📄 License

[MIT](LICENSE)
