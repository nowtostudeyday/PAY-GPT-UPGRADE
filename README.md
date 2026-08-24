# KC GPT 自动充值系统

> **KC ChatGPT PLUS 訂閱開通平台**  
> 使用者貼上 Session 與兌換 CDK 後，可使用本地 Stripe 自動化流程，或啟用第三方代充 API 建立並輪詢代充訂單。  
> 配套管理後台：卡池管理、CDK 管理、任務監控、帳單稽核、第三方代充積分與套餐狀態、並發控制。

| 开发者 | TG | 
|--------|-----|
| **KC** | KcCatk |

[License: MIT](LICENSE) · Node.js 20+ · MySQL 8 · Playwright · Docker · [GitHub](https://github.com/KC-CatK/KC-PAY-GPT)

---

## 定制版本说明

本仓库当前版本基于上游项目 [KC-CatK/KC-PAY-GPT](https://github.com/KC-CatK/KC-PAY-GPT) 的 `main` 分支维护，代码基线为提交 `fb4da763f5cdcd6995b5b8ad3b7f758ae0684963`（`merge: preserve remote repository history`）。除非另有说明，下列能力均以该上游项目为基础。

### 本版本的定制内容

| 模块 | 改动 | 行为说明 |
|------|------|----------|
| 订阅管理 | 支付成功后尝试取消自动续费 | 本地 Stripe 自动化支付确认成功后，调用订阅接口取消自动续费；取消失败只记录警告，不会将已成功的支付任务改为失败。 |
| 卡池策略 | 单卡成功订阅上限 | 后台可配置单张卡最多成功绑定的订阅数，默认 `2`。达到上限后卡片保留在卡池中，状态变为“订阅额度用尽”，后续不会再被选用。 |
| 卡池策略 | 明确拒付计数与报废 | 后台可配置单卡最多明确拒付次数，默认 `3`。仅 `card declined` 等明确支付拒绝会累计；达到上限后状态变为“已报废”。成功支付会清空该卡的拒付计数。 |
| 本地 Stripe 流程 | 同任务换卡 | 当前卡明确拒付但尚未达到报废阈值时，会在同一任务内跳过已尝试的卡并选择另一张可用卡继续；不会重复使用同一张已拒付卡。 |
| 第三方代充流程 | 保持终态失败行为 | 第三方返回明确拒付时，系统只记录拒付计数和卡片状态，任务仍按原有逻辑直接失败，不自动创建新的代充订单或重试扣款。 |
| 管理后台 | 卡池配置和状态可视化 | “系统配置 → 并发与维护”新增两个阈值配置；卡池列表新增“成功订阅”“拒付”列，并展示“额度用尽”“已报废”等状态。 |
| 数据库兼容 | 启动时自动迁移 | 新数据库在建表时包含 `card_assets.decline_count`；已有数据库在应用启动时自动补齐该字段及两项默认配置。数据库账户需要具备 `ALTER TABLE` 权限。 |
| 会话认证代码 | Cookie 收集逻辑注释 | 为 Session Cookie 的清洗、去重、分块注入和 CSRF/设备 Cookie 补齐逻辑补充中文注释，便于排查会话注入问题。 |

### 升级与回滚边界

- 升级到本版本后，重启应用会自动执行上述数据库兼容迁移；不会删除已有卡片或历史账单。
- 下调“单卡最多绑定订阅数”并保存配置时，已达到新上限的卡片会立即停止选用；上调上限时，未被其他原因禁用的“订阅额度用尽”卡可恢复选用。
- “已报废”表示达到明确拒付阈值，不会因上调订阅上限自动恢复；如需重新启用，应在确认卡片状态后由管理员人工处理。
- Docker 部署更新源码后，应重新构建应用镜像：`docker compose up -d --build app`。仅执行 `docker compose restart app` 不会更新未挂载到容器的前端静态文件。

> ## 加入 Telegram 社群
> **[點此加入 AI科研組 Telegram 群組](https://t.me/+xPBORDjtky9mM2Mx)**

---

## 这是什么

`KC-GPT-PAY`（KC GPT 自动充值系统）是一套 **Node.js + Playwright + MySQL** 服务端方案，包含：

- **用户前台**（`/public/index.html`）：卡密兑换、Session 提交、订阅自动开通、状态查询
- **管理后台**（`/admin`）：卡池 / CDK / 任务 / 账单 / 系统配置 / 运行日志
- **本地自動化引擎**：Stripe Checkout 填表、信用卡輪換、hCaptcha 求解、反指紋瀏覽器與失敗重試
- **第三方代充 API**：支援套餐／積分查詢、Session 預檢、代充建單、訂單輪詢，以及失敗訂單的供應商卡密前綴顯示

啟用第三方代充 API 後，前台兌換會完全改走供應商代充流程，不再使用本地開通。

> ⚠️ **仅供学习与研究**。使用前请确保符合目标平台 ToS 与所在地法律法规。**开发者不对任何滥用导致的封号、扣款、法律纠纷负责。**

---

## 系统要求

| 组件 | 要求 |
|------|------|
| **Node.js** | ≥ 20.x |
| **MySQL** | ≥ 8.0 |
| **記憶體** | ≥ 2 GB（本地瀏覽器自動化建議 4 GB+） |
| **磁盘** | ≥ 5 GB（含 Chromium + Python hCaptcha 依赖） |
| **操作系统** | Linux / macOS / Windows |

Linux 无图形界面跑 headless 时，需安装 Playwright 系统依赖（见下方各平台说明）。

---

## 部署教程

### 方式一：Docker 一键部署（推荐）

适合 Linux 云服务器、macOS、Windows（Docker Desktop），**自带 MySQL 8**，无需单独装数据库。

#### 1. 安装 Docker

```bash
# Ubuntu / Debian（一键脚本）
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker && sudo systemctl start docker

# macOS / Windows — 安装 Docker Desktop
# https://www.docker.com/products/docker-desktop/
```

#### 2. 拉取代码并配置

```bash
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
DB_PASSWORD=your_strong_mysql_password   # MySQL root 密码
ADMIN_PASSWORD=your_admin_password         # 后台登录密码
PROXY=http://user:pass@proxy-host:port     # 本地自動化或第三方訂單代理（選填）
BROWSER_POOL=0                              # 預設關閉瀏覽器池
```

#### 3. 一键启动

```bash
docker compose up -d
```

首次构建镜像需数分钟（含 Playwright Chromium + hCaptcha Python 依赖）。启动成功后：

| 地址 | 说明 |
|------|------|
| `http://服务器IP:3000/` | 用户前台（卡密兑换） |
| `http://服务器IP:3000/admin-login` | 后台登录（默认路径可在后台修改） |

#### 4. Docker 常用命令

```bash
# 查看应用日志
docker compose logs -f app

# 重启应用
docker compose restart app

# 停止并移除容器（数据卷保留，MySQL 数据不丢）
docker compose down

# 更新代码后重新构建
docker compose up -d --build

# 进入容器调试
docker compose exec app bash
```

> **注意**：请勿使用 `docker compose down -v`，否则会删除 MySQL 数据卷。配置写入 MySQL 后，重启容器不会丢失。

---

## 第三方代充 API

在後台「系統配置 → 第三方代充 API」填寫 API Key 後啟用。預設 Base URL 為：

```text
https://kc.vpss.eu.cc/
```

啟用後，系統會：

1. 使用供應商 `/plans` 取得 GPT 與積分套餐資訊。
2. 以 `/balance` 顯示可用積分與 USD 餘額。
3. 以 `/pay/inspect` 檢查 Session 格式與 JWT 有效期，再以 `/pay` 建立代充訂單。
4. 輪詢供應商訂單結果；後台僅顯示失敗代充訂單及上游公開的 `topup_code` 前綴，不會保存或展示完整卡密。

API Key 至少需要 `plans:read`、`balance:read`、`pay:write` Scope；如需使用任務查詢，另需 `tasks:read`。完整供應商協議見 [對接 API 文件](对接api.md)。

> 瀏覽器池預設關閉（`BROWSER_POOL=0`）。第三方代充模式不使用本地瀏覽器開通流程。

---

### 方式二：多端裸机部署

适合不想用 Docker、或需要在本地调试的场景。

#### macOS / Linux 一键安装

```bash
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
chmod +x scripts/install.sh
./scripts/install.sh
```

脚本会自动检测系统（macOS / Ubuntu / Debian / CentOS 等），安装 Node.js 20+、npm 依赖、Playwright Chromium 及 Linux 系统库。

#### Windows 一键安装

以**管理员权限**打开 PowerShell：

```powershell
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

#### 手动安装（各平台通用）

**① 安装 Node.js 20+**

```bash
# macOS (Homebrew)
brew install node@20

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Windows — 下载 LTS 安装包
# https://nodejs.org/
```

**② 安装 Playwright 系统依赖（仅 Linux 服务器）**

```bash
# Ubuntu / Debian 推荐
npx playwright install --with-deps chromium

# 或手动安装常见依赖
sudo apt-get install -y wget curl fonts-liberation fonts-noto-cjk \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libxss1 libasound2 libpangocairo-1.0-0 libxshmfence1
```

macOS / Windows 无需额外系统依赖。

**③ 安装项目依赖**

```bash
npm install --production
npx playwright install chromium
```

**④ 安装并初始化 MySQL 8**

```bash
# Ubuntu
sudo apt-get install -y mysql-server && sudo systemctl start mysql

# macOS
brew install mysql && brew services start mysql

# 创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

**⑤ 配置环境变量**

```bash
cp .env.example .env
# 编辑 .env
```

裸机部署关键项：

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=plus_papay
ADMIN_PASSWORD=你的后台密码
PROXY=http://user:pass@proxy-host:port
HEADFUL=0          # 调试时可设为 1 开启有头浏览器
```

**⑥ 启动服务**

```bash
npm start
# 或调试模式（有头浏览器）
npm run start:headful
```

启动成功示例：

```
🔓 [资产锁] 启动时已重置所有 in_use 标记
数据库表检查完成
http://localhost:3000
MySQL => root@127.0.0.1:3306/plus_papay
```

---

### 方式三：PM2 生产守护（裸机推荐）

```bash
npm install -g pm2
pm2 start server.js --name kc-gpt-pay
pm2 startup          # 配置开机自启
pm2 save
pm2 logs kc-gpt-pay  # 查看日志
pm2 restart kc-gpt-pay
```

---

### 方式四：Nginx 反向代理 + HTTPS

通过域名访问或启用 HTTPS 时，在 Nginx 中反代到 `127.0.0.1:3000`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

免费 HTTPS（Let's Encrypt）：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 首次使用

1. 打开后台 → **系统配置**：填写代理、支付地区（默认菲律宾 PHP）、邮箱通道、hCaptcha 等
2. **卡池管理** → 批量导入信用卡（格式：`卡号|有效期|CVC|持卡人姓名`）
3. **免税地址** → 确认当前地区有足够地址模板（默认已预置）
4. **CDK 管理** → 生成 Plus / Pro 5x / Pro 20x 激活码
5. 用户访问前台 → 输入 CDK → 粘贴 Session JSON → 提交，约 3–5 分钟自动开通
6. 在 **任务管理** / **运行日志** 查看进度与结果

---

## 主要功能

| 模块 | 说明 |
|------|------|
| **CDK 兑换** | Plus / Pro 5x / Pro 20x 三档套餐，一卡一充 |
| **信用卡卡池** | 批量导入、智能选卡、冷却机制、Stripe 拒卡自动报废、失败换卡重试 |
| **支付地区** | PH / US / SG / MY 可切换，配套免税地址池 |
| **账单审计** | 自动记录每笔支付，支持筛选与 CSV 导出 |
| **瀏覽器池** | 本地自動化的可選多槽位模式；目前預設關閉（`BROWSER_POOL=0`） |
| **hCaptcha** | VLM / 打码平台 / Python solver 多通道 |
| **反指纹** | Stealth + 30+ 指纹点修正，支持真 Chrome / Edge |
| **Telegram 通知** | 任务成功 / 失败推送（后台配置） |
| **并发 & 维护模式** | 前台并发上限、维护开关，保存即生效 |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     server.js (Express)                      │
│   /api/redeem/*   /api/cdk/*   /api/admin/*   /api/public/* │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────┐            ┌─────────────────────┐
│  product_activator  │            │  public/admin.html  │
│  任务调度 / 重试     │            │  KC GPT 管理后台     │
└─────────────────────┘            └─────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  index.js / stripe-payment.js / session-auth.js / browser-pool │
│  Stripe Checkout 自动化 · Session 鉴权 · 卡池支付 · 重试      │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  MySQL — 卡池 / CDK / 任务 / 账单 / 配置 / Session 记录       │
└─────────────────────────────────────────────────────────────┘
```

---

## 目录结构

```
.
├── server.js              # Express 入口、REST API
├── product_activator.js   # 任务调度核心
├── index.js               # Stripe 支付主流程（子进程）
├── stripe-payment.js      # Checkout 表单自动化
├── session-auth.js        # Session 解析与鉴权
├── browser-pool.js        # 浏览器池管理
├── mysql-store.js         # MySQL 全部 CRUD
├── payment-retry.js       # 支付重试与换卡逻辑
├── region-config.js       # 支付地区配置
├── hcaptcha/              # Python hCaptcha solver
├── public/
│   ├── index.html         # 用户前台
│   ├── admin.html         # 管理后台
│   └── admin-login.html   # 后台登录
├── scripts/
│   ├── install.sh         # macOS / Linux 一键安装
│   └── install-windows.ps1
├── docker-compose.yml     # Docker 一键部署
├── Dockerfile
├── mysql-schema.sql
├── .env.example
└── 对接api.md             # 第三方代充 API 對接文件
```

---

## 接口文档

本系統 REST API 請依 `server.js` 路由使用；第三方代充接口見 [對接 API 文件](对接api.md)。常用接口：

| 用途 | Method + Path | 鉴权 |
|------|---------------|------|
| 用户兑换开通 | `POST /api/redeem-product` | 无 |
| 查询 CDK 状态 | `GET /api/cdk/query?cdk=...` | 无 |
| 后台登录 | `POST /api/admin/login` | 密码 |
| 卡池批量导入 | `POST /api/admin/cards/import` | Bearer |
| 外部卡池推送 | `POST /api/external/cards/push` | X-API-Key |
| 账单 CSV 导出 | `GET /api/admin/billing/export` | Bearer |
| 实时运行日志 | `GET /api/admin/runtime-logs` | Bearer |

---

## 常见问题

**Q: Docker 里浏览器崩溃？**  
A: `docker-compose.yml` 已配置 `shm_size: 2gb`。仍崩溃可改为 `4gb`，并确保宿主机内存 ≥ 4 GB。

**Q: Linux 上 Chromium 启动失败？**  
A: 执行 `npx playwright install-deps chromium`，确认 `HEADFUL=0`（无头模式）。

**Q: MySQL 连接被拒绝？**  
A: Docker 模式下 `DB_HOST=mysql`（compose 服务名）；裸机模式下 `DB_HOST=127.0.0.1`。确认 MySQL 服务已启动。

**Q: Stripe 一直 `redirect_status=failed`？**  
A: 多为卡 BIN 被风控、余额不足或代理 IP 不干净。换卡、换代理、确认支付地区设置。

**Q: 卡池枯竭怎么办？**  
A: 后台批量导入，或配置 Webhook `POST /api/external/cards/push` 自动补货。

**Q: 修改哪些文件需要重启？**  
A: `server.js`、`mysql-store.js`、`product_activator.js` 等主进程文件需重启；`index.js`、`stripe-payment.js` 等子进程文件下次任务自动加载。

**Q: Windows 上 Playwright 安装失败？**  
A: 管理员 PowerShell 执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，再 `npx playwright install chromium`。

---

## 端口说明

| 端口 | 用途 |
|------|------|
| 3000 | Web 服务 + WebSocket（可通过 `PORT` 环境变量修改） |
| 3306 | MySQL（Docker 模式下映射到宿主机） |
| 19222+ | 瀏覽器池 CDP 連接埠（僅啟用 `BROWSER_POOL=1` 時使用） |

---

## 开发者 & 联系方式

| 项目 | 信息 |
|------|------|
| 开发者 | **KC** |
| TG | **KcCatk** |




---

## 免责声明

本项目所有代码以 **「AS IS」** 形式发布，开发者**不对以下情形负责**：

- 因使用本项目导致的 OpenAI 账号封禁、银行卡风控
- 违反目标平台 ToS 或所在地法律法规所引起的任何后果
- 因使用本项目导致的资金损失、数据泄露、第三方权益受损

**使用即表示你已阅读、理解并接受以上条款。**

---

## 许可

[MIT License](LICENSE) © KC
