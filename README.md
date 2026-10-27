# ClipNote — 多端互通的剪切板 & 笔记本

部署在 [Render](https://render.com) 上的轻量 Web 服务（Node.js + Express + PostgreSQL）。
手机、电脑、平板打开同一个网址，剪切板内容和笔记实时互通。

## 功能

- **剪切板**：一键把文本同步到云端；任意设备上点「复制」取回；支持置顶、删除、按关键词搜索；每条内容标记来源设备
- **笔记本**：标题 + 正文，编辑器防抖自动保存（0.9 秒无输入即落库），按更新时间排列
- **多端同步**：页面在前台时每 3 秒轮询一次，从后台切回立即刷新
- **访问码保护**：设置 `ACCESS_CODE` 环境变量后，必须输入访问码才能进入（HttpOnly Cookie + HMAC 签名，30 天有效；登录接口有 IP 限速）
- **移动端适配**：响应式布局，手机浏览器可「添加到主屏幕」当 App 用

## 项目结构

```
clipnote/
├── server.js            # 后端：Express + PostgreSQL + 访问码鉴权
├── package.json
├── render.yaml          # Render Blueprint（一键部署配置）
└── public/              # 前端（无框架，原生 HTML/CSS/JS）
    ├── index.html
    ├── app.js
    ├── style.css
    └── manifest.webmanifest
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | PostgreSQL 连接串，Render 会自动注入 |
| `ACCESS_CODE` | 强烈建议 | 访问码；不设置则为开放模式，任何拿到网址的人都能看到你的数据 |
| `PORT` | 否 | 默认 3000，Render 自动注入 |

数据表（`clips` / `notes`）在服务启动时自动创建，无需手动建表。

## 部署到 Render（推荐：Blueprint 一键部署）

1. 把 `clipnote/` 目录推到 GitHub 仓库（`node_modules` 已在 `.gitignore` 中）
2. 打开 [Render Dashboard](https://dashboard.render.com) → **New → Blueprint**，选择该仓库
3. Render 识别 `render.yaml`，自动创建一个 Web Service + 一个 PostgreSQL
4. 提示填写 `ACCESS_CODE` 时输入你自己的访问码（即密码）
5. 部署完成后打开 `https://<你的服务名>.onrender.com`，输入访问码即可使用

### 手动部署（不想用 Blueprint 时）

1. **New → PostgreSQL**（plan 选 Free），建好后复制 Internal Database URL
2. **New → Web Service**，连接仓库，Build Command `npm install`，Start Command `node server.js`
3. 在 Environment 中添加：`DATABASE_URL`（第 1 步的连接串）、`ACCESS_CODE`（你的访问码）

### 免费版注意事项

- **Web Service 休眠**：15 分钟无访问会休眠，下次打开需 30–60 秒冷启动——对个人剪切板场景可以接受，等一会儿即可
- **免费 PostgreSQL 只有 90 天寿命**：到期会被删除！建议每 1–2 个月用 Render 面板的备份功能（或 `pg_dump`）导出一次数据；长期使用请升级数据库或换 Neon 免费 Postgres（只需改 `DATABASE_URL`）
- 每月 750 小时免费实例时长，单个常驻服务刚好够用

## 本地开发

```bash
npm install
# 需要一个本地 PostgreSQL，例如：
DATABASE_URL=postgres://postgres:postgres@localhost:5432/clipnote ACCESS_CODE=dev123 npm start
# 打开 http://localhost:3000
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 用访问码换取会话 Cookie |
| GET | `/api/data` | 一次拉取剪切板(200条) + 笔记列表(500条) |
| POST | `/api/clips` | 新增剪切板内容 |
| PATCH | `/api/clips/:id` | 置顶/取消置顶 |
| DELETE | `/api/clips/:id` | 删除 |
| GET | `/api/notes/:id` | 获取笔记全文 |
| POST | `/api/notes` | 新建笔记 |
| PUT | `/api/notes/:id` | 保存笔记 |
| DELETE | `/api/notes/:id` | 删除笔记 |
| GET | `/api/health` | 健康检查（Render 用） |

## 限制

- 单条剪切板内容 ≤ 200KB，单条笔记 ≤ 1MB（纯文本场景足够）
- 仅支持文本，不支持图片/文件（如需可后续加对象存储）
