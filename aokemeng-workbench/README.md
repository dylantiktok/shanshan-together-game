# AOKEMENG TikTok Operations Workbench
# AOKEMENG TikTok 智能运营工作台

AOKEMENG Malaysia Sdn Bhd 的本地电商运营工作台。它可以在 Windows 和 macOS 上安装运行，数据存在本机 SQLite 数据库中，不依赖云服务器也能启动。

- 市场：马来西亚 · 货币 MYR · 时区 Asia/Kuala_Lumpur
- 平台：TikTok Shop Malaysia（已接官方 Partner API 适配层）、Shopee Malaysia（已预留适配层）
- 界面语言：中文（默认）/ English / Bahasa Melayu

---

## 1. 安装与运行

需要 Node.js 20 或更高版本（https://nodejs.org）。

```bash
cd aokemeng-workbench
npm install
```

**桌面版（Electron 窗口）**

```bash
npm start
```

第一次运行 `npm start` 会自动下载 Electron 运行文件（约 100MB）。默认从 npmmirror 镜像下载，速度较快。
新版 npm 默认不执行依赖包的安装脚本，所以 `npm install` 不会自动下载 Electron。

如果下载中断，可以单独重新下载：

```bash
npm run setup:electron
```

如需改用官方源，先设置环境变量 `ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/`。

**无桌面壳（本机浏览器访问，适合调试）**

```bash
npm run server
```

启动后打开 `http://127.0.0.1:3780`。本地服务只监听 127.0.0.1，局域网其他电脑无法访问。

**打包 Windows 安装包（在 Windows 上执行）**

```bash
npm run dist:win
```

生成的 NSIS 安装包在 `dist/` 目录。macOS 安装包用 `npm run dist:mac`，需要在 macOS 上执行。

**运行测试**

```bash
npm test
```

### 首次启动

系统中没有任何账号时，会显示“创建董事账号”页面。系统没有默认账号，也没有默认密码。创建第一个账号后，这个初始化入口会永久关闭。

### 数据位置

| 运行方式 | 数据目录 |
|---|---|
| Windows 桌面版 | `%APPDATA%\AOKEMENG Workbench\data\` |
| macOS 桌面版 | `~/Library/Application Support/AOKEMENG Workbench/data/` |
| `npm run server` | `aokemeng-workbench/data/`（可用 `--data` 或环境变量 `AOKEMENG_DATA_DIR` 指定） |

数据目录中包含：

- `workbench.sqlite`：主数据库。每次写入都先写临时文件，再原子重命名，防止断电导致数据库损坏。
- `backups/`：每天自动备份一份，保留最近 30 份。
- `secret.key`：本机加密密钥，用来加密 API 密钥。**请和数据库一起备份。** 这个文件丢失后，已保存的接口凭据需要重新填写，业务数据不受影响。

---

## 2. 数据真实性原则（硬性规则）

1. **不生成任何演示或虚假数据。** 没有数据时，界面显示“暂无数据”，并提示如何接入或录入。
2. **每条业务数据都带有来源标记 `data_source`**，界面用不同颜色的标签显示：
   - **平台实际**（`api`）：来自 TikTok Shop 官方接口同步
   - **人工录入**（`manual`）：员工在界面中填写
   - **文件导入**（`import`）：通过 CSV 导入
   - **估算**（`estimate`）：系统按成本档案推算，例如商品毛利、预估净利润
3. **来源优先级：平台实际 > 文件导入 > 人工录入。** 低可信度的数据不能覆盖平台数据。平台同步的订单、价格和库存，也不能在本地修改或删除。
4. **未接通的接口一律显示“未连接”：**
   - 同步任务的状态只会是 `not_connected`（未连接）、`waiting_network`（等待网络）或 `failed`（失败），不会伪装成功。
   - 只有真实调用成功后，连接状态才会标记为“已连接”。
5. **不绕过平台权限、验证码或反爬机制。** 系统只调用平台官方开放接口，没有任何网页抓取。

---

## 3. 已实现功能

### 模块 1：经营总览 Dashboard
- 今日、昨日、近 7 天、近 30 天的销售额，均按马来西亚时区计算日期边界。
- 按区间统计：销售额、订单数量、客单价、退款金额、广告花费、广告 ROAS。
- 商品毛利和预估净利润只对有 `finance.view` 权限的角色显示，并明确标注为“估算”。
  - 毛利会显示成本覆盖率：缺少成本档案的订单行不计入毛利。
  - 计算公式：预估净利润 = 商品毛利 − 广告花费 − 退款金额。
- 销售趋势图、各店铺经营排名。
- 支持日期筛选、店铺筛选、导出 CSV（UTF-8 BOM，Excel 可以直接打开）。
- 已取消、待付款的订单不计入销售额。

### 模块 2：TikTok Shop 店铺管理
- 多店铺资料管理：名称、地区、平台店铺 ID、营业状态、备注。
- 店铺授权状态管理，流程如下：
  1. 配置 App Key / Secret
  2. 打开授权链接，卖家同意授权
  3. 用回调中的 `auth_code` 换取令牌
  4. 需要时刷新令牌，或解除授权
- 商品列表与 SKU 管理：价格、库存、库存预警线。支持人工新增和 CSV 导入，也可以从接口同步。
- 订单管理：筛选、详情、人工录入、CSV 导入（同一订单号自动去重）、导出。
- 退款退货记录：人工登记，也可以从接口同步。
- 店铺绩效指标：店铺评分、延迟发货率、取消率、退货率、响应率、差评率、违规扣分。
- 店铺异常提醒，每 15 分钟及每次相关数据变更后自动重新评估：
  - 断货、低库存
  - 亏损 SKU、缺少成本档案
  - 授权未连接、即将过期、已过期
  - 近 30 天退款率超过 10%
  - 同步失败

### 模块 3：商品利润计算器
每个 SKU 可以录入并保存成本档案，修改时会记录修改前后的值。

| 字段 | 计算方式 |
|---|---|
| 销售价格 | 取自 SKU；试算时可以手动修改 |
| 商品采购成本、包装成本 | 固定成本 |
| 平台佣金 (%)、交易手续费 (%) | 以成交价为基数 |
| 运费、运费补贴 | 净运费 = 运费 − 补贴 |
| *扩展：* 达人联盟佣金 (%) | 以成交价为基数 |
| *扩展：* 商家优惠/券 | 成交价 = 售价 − 商家优惠 |
| *扩展：* 单件广告分摊、其他成本 | 固定成本 |

计算器会输出以下结果：

- 单件利润和利润率
- 逐项成本拆解
- **保本售价**
- **达到目标利润率所需的售价**
- 按数量计算的利润合计

亏损的 SKU 会自动生成严重级别的提醒。

> 说明：需求文档在模块 3 的“运费及运费补贴”之后被截断。上表中标为“扩展”的字段，是根据 TikTok Shop 马来西亚的常见费用结构补充的，其后的需求模块尚未收到。

### 基础能力
- **员工账号与权限（RBAC）**：共 8 个角色。
  - 系统管理员、公司董事、国家负责人、财务人员可以访问全部店铺。
  - 店铺运营、内容运营、主播、达人 BD 只能访问分配给自己的店铺。
  - 共有 23 个权限点，完整矩阵可以在“员工账号”页面查看。
  - 只有董事或系统管理员可以创建、修改董事级账号。
- **登录安全**：
  - 密码使用 scrypt 加盐哈希；要求至少 8 位，并同时包含字母和数字。
  - 连续 5 次登录失败，账号锁定 15 分钟。
  - 会话有效期 12 小时。
  - 新账号首次登录必须修改密码。
- **操作日志**：重要操作都会写入日志，包括登录、登录失败、用户管理、店铺、SKU、成本、订单、退款、广告、导入、导出、接口配置、授权、同步和 AI 调用。日志中不记录明文密钥。
- **离线与同步**：
  - 所有数据存储在本地，离线时可以照常查看和录入。
  - 网络不可用时，同步任务进入“等待网络”状态，并按指数退避自动重试（1 分钟到 30 分钟，最多 12 次）。
  - 浏览器检测到网络恢复时会立即重试。
- **凭据安全**：所有 API 密钥都用 AES-256-GCM 加密保存，接口只返回末 4 位。

---

## 4. 第三方接入

在“接口与同步”页面配置以下服务。

### TikTok Shop（官方 Partner API，版本 202309）

已实现的部分：

- 请求签名：HMAC-SHA256，参数排序后拼接 path、query 和 body，并用 app_secret 包裹。
- 令牌换取与刷新。
- 接口调用：
  - 获取授权店铺：`/authorization/202309/shops`
  - 商品搜索：`/product/202309/products/search`
  - 订单搜索（按更新时间增量）：`/order/202309/orders/search`
  - 退货退款搜索：`/return_refund/202309/returns/search`

接入步骤：

1. 在 TikTok Shop Partner Center 创建应用，开通商品、订单、退货退款相关接口权限。
2. 在工作台中填写 App Key、App Secret 和 Service ID。
3. 在店铺行点击“授权状态”，打开授权页，让卖家完成授权。
4. 把回调地址中的 `code` 粘贴到工作台，换取令牌。系统会自动执行“店铺信息”同步，获取 `shop_cipher`。
5. 点击“立即同步”。

> 适配层已用本地模拟服务验证了签名与数据映射（见 `test/api.test.js`），**但尚未在真实授权的 TikTok 店铺上联调**。首次接入真实店铺时，请检查同步结果。字段映射集中在 `server/integrations/tiktok.js`，便于调整。
>
> TikTok 广告花费（Marketing API）尚未接入，目前在“广告花费”页面按广告后台报表人工录入，系统标记为“人工录入”。

### Shopee Open Platform（预留）
已实现签名算法和凭据结构，业务同步尚未接通，同步任务会显示“未连接”。

### AI 服务
- **Claude**：使用 Anthropic 官方 SDK，默认模型 `claude-opus-5-5`，effort 默认为 medium。请求开启了服务端 `fallbacks: "default"`：遇到安全分类器拒答时，由 Anthropic 自动路由到备用模型，不需要的话可以在 `server/integrations/ai.js` 中删除。
- **OpenAI**：使用 Chat Completions REST 接口。
- **发送范围**：只发送汇总后的经营数据（不含买家个人信息）。
- **两种分析**：
  - 经营数据分析
  - SKU 利润诊断（需要 `costs.view` 权限）

### 飞书 / Lark
- 使用自定义机器人 Webhook，支持签名校验，国内飞书和国际版 Lark 都可以用。
- 可以推送严重提醒和同步失败，所有发送记录都保存在 `notifications_log` 表中。
- 未配置时记录为“未连接”，不会伪装发送成功。

---

## 5. CSV 导入模板

模板在 `templates/` 目录中，只有表头。

**订单导入**：`orders-import-template.csv`

- 必需列：`order_id`、`order_time`（马来西亚时间，格式 `2026-11-09 14:30`）、`status`、`total`
- 可选列：`seller_sku`、`product_name`、`quantity`、`unit_price`
- 同一订单有多件商品时，写成多行，每行用相同的 `order_id`。
- `status` 可用的值：`unpaid`、`on_hold`、`awaiting_shipment`、`awaiting_collection`、`in_transit`、`delivered`、`completed`、`cancelled`

**商品导入**：`products-import-template.csv`

- 必需列：`seller_sku`、`title`、`price`
- 可选列：`stock`、`category`、`sku_name`

---

## 6. 技术架构

```
electron/main.js           桌面壳：进程内启动本地服务（127.0.0.1 随机端口）并打开窗口
server/
  index.js                 Express 应用、安全响应头、统一错误处理
  db.js / migrations.js    SQLite (sql.js/WASM，免原生编译) + 原子落盘 + 每日备份 + 只追加迁移
  auth.js / rbac.js        登录会话、密码哈希、角色权限、店铺数据范围
  audit.js                 操作日志
  services/
    dashboard.js           经营指标与数据来源构成
    profit.js              利润计算器（纯函数，金额以 sen 整数计算）
    ingest.js              统一入库（去重键、来源优先级）
    alerts.js              异常提醒规则引擎
    sync.js                同步任务队列（离线排队 / 指数退避 / 未连接不重试）
    notifier.js            飞书通知
  integrations/            tiktok.js · shopee.js · ai.js · lark.js · credentials.js(加密存储)
  routes/                  core.js（系统/认证/用户/日志）· business.js · integrations.js
web/                       无构建步骤的原生 ES Modules 前端（中/英/马来语）
test/                      node:test 单元测试与 API 集成测试
```

- 金额统一以 sen（仙，整数）存储和计算，避免浮点误差。
- 时间统一按 UTC ISO 存储；日期边界与报表按 Asia/Kuala_Lumpur（UTC+8，无夏令时）计算。
- 数据库结构变更通过在 `server/migrations.js` 中追加新迁移实现，不要修改已发布的迁移。

## 7. 后续扩展建议
- 接入 TikTok Marketing API，同步广告花费和归因 GMV。
- 接入 TikTok Shop Finance 结算接口，用实际结算替代估算的佣金和手续费。
- 完成 Shopee 订单、商品、退款同步的联调。
- 达人 BD 管理：达人库、样品寄送、合作佣金。
- 主播排班与直播场次复盘。
- 飞书多维表格同步、审批流对接。
