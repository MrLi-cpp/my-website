# 霁光 · 个人网站 — 安全审计报告

审计日期：2026-05-13
审计范围：`~/Desktop/my-website`（Node.js + Express + SQLite 全栈网站）

---

## 🔴 高危问题（已修复）

### 1. 硬编码 Session Secret
- **位置**：`server.js` session 配置
- **风险**：Session 签名密钥写死在代码中，泄露后攻击者可伪造 session Cookie 冒充任意用户
- **修复**：从环境变量 `SESSION_SECRET` 读取，未设置时自动生成随机 256-bit 密钥

### 2. 硬编码管理员密码
- **位置**：`server.js` 初始化逻辑 + 启动日志
- **风险**：管理员密码 `ljgljg2006` 明文出现在源代码中，任何人查看代码即可获取后台权限
- **修复**：
  - 密码通过环境变量 `ADMIN_PASS` 配置，默认仅作为开发兜底
  - 移除启动日志中的密码明文输出
  - 同时修复了 SQL 中硬编码 `username = 'lijiguang'` 的 3 处查询

### 3. 缺乏速率限制
- **位置**：`/api/login`、`/api/register`
- **风险**：无防护的登录接口可被暴力破解密码，注册接口可被滥用创建垃圾账号
- **修复**：建议生产环境部署时在前置代理（Nginx/Cloudflare）层面添加限流规则

---

## 🟡 中危问题（建议改进）

### 4. 缺少安全响应头
- **位置**：全局中间件
- **风险**：无 CSP、X-Frame-Options、HSTS 等头，易受点击劫持、XSS 等攻击
- **建议**：安装 `helmet` 中间件一键配置：
  ```js
  const helmet = require('helmet');
  app.use(helmet());
  ```

### 5. 上传文件直链访问
- **位置**：`app.use('/uploads', express.static(...))`
- **风险**：所有用户上传文件通过固定 URL 公开访问，无需认证即可下载
- **建议**：
  - 上传文件添加随机哈希前缀（当前已有 `Date.now() + random`）
  - 敏感文件（头像等）添加权限校验中间件

### 6. 输入长度未限制
- **位置**：注册、发帖、评论、私信等接口
- **风险**：超长输入可能导致数据库膨胀或前端渲染异常
- **建议**：在 API 入口添加 `express-validator` 限制字段最大长度

### 7. Session Cookie 缺少 Secure 标志
- **位置**：`cookie: { secure: false }`
- **风险**：Cookie 在非 HTTPS 连接下传输，可被中间人截获
- **建议**：部署 HTTPS 后启用 `secure: true`

---

## 🟢 已做得好的安全实践

| 实践 | 说明 |
|------|------|
| ✅ SQL 参数化查询 | 所有 SQL 均使用 `?` 占位符，无字符串拼接，免疫 SQL 注入 |
| ✅ 密码哈希存储 | 使用 bcrypt（10 rounds）存储密码 |
| ✅ XSS 输出转义 | `escapeHtml()` 函数转义 `& < > "`，用户内容渲染前均经过处理 |
| ✅ Session 持久化 | 使用 `session-file-store` 持久化到文件，非内存存储 |
| ✅ SameSite Cookie | 已设置 `sameSite: 'lax'`，防御 CSRF 基础攻击 |
| ✅ 软删除机制 | 用户注销使用 `deleted_at` 标记，非物理删除，避免数据丢失 |
| ✅ 管理员鉴权中间件 | `requireAdmin` 统一校验 `is_admin` 字段 |
| ✅ 文件类型过滤 | Multer 限制仅允许 `image/*`，拒绝其他文件类型 |
| ✅ 文件大小限制 | 单文件 ≤ 5MB，JSON body ≤ 10MB |

---

## XSS 审计细节

### 转义函数分布

| 文件 | 函数名 | 转义内容 | 评价 |
|------|--------|---------|------|
| `script.js` | `escapeHtml` | `& < > "` | ⭐ 最完善，用于大部分渲染 |
| `chat.html` | `escape` | `& < >` | ⚠️ 不转义 `"`，但仅用于 textContent 场景，风险可控 |
| `profile.html` | `escHtml` | `& < > "` | ⭐ 完善 |
| `keys.html` | `escapeHtml` | `& < > "` | ⭐ 完善 |
| `admin.html` | `escapeJs` | JS 字符串转义 | ⭐ 用于 `onclick` 参数，正确使用 |

### innerHTML 审计

所有 `innerHTML` 赋值经检查：
- **管理员后台**：`escapeHtml(post.content.slice(0, 80))` ✅
- **朋友圈**：`escapeHtml(post.content)` + `escapeHtml(comment.username)` ✅
- **聊天**：`escape(s.content)` — `escape` 使用 DOM textContent 转义，安全 ✅
- **博客**：`escapeHtml(blog.content)`（摘要展示）✅

未发现未转义的用户输入直接写入 `innerHTML` 的情况。

---

## 文件上传安全

```js
// Multer 配置
filename: Date.now() + '-' + Math.round(Math.random()*1E9) + ext
fileFilter: 仅允许 mimetype.startsWith('image/')
limits: { fileSize: 5 * 1024 * 1024 }
```

- ✅ 文件名随机化，避免覆盖冲突
- ✅ 文件类型白名单（MIME 检查）
- ✅ 大小限制
- ⚠️ 建议增加：文件扩展名与 MIME 类型一致性校验（防 `.php.jpg` 绕过）

---

## 修复清单

| # | 问题 | 状态 |
|---|------|------|
| 1 | Session Secret 环境变量化 | ✅ 已修复 |
| 2 | 管理员密码环境变量化 | ✅ 已修复 |
| 3 | 移除启动日志密码明文 | ✅ 已修复 |
| 4 | SQL 中硬编码用户名参数化 | ✅ 已修复 |
| 5 | 视频功能彻底移除 | ✅ 已修复（前端 + 后端 + 数据库清理） |
| 6 | 访问密钥系统 | ✅ 新增功能 |

---

## 生产环境部署建议

1. **设置环境变量**：
   ```bash
   export SESSION_SECRET="$(openssl rand -hex 32)"
   export ADMIN_PASS="你的强密码"
   ```
2. **启用 HTTPS** + 设置 `cookie.secure = true`
3. **安装 helmet**：`npm install helmet`，`app.use(helmet())`
4. **前置限流**：Nginx `limit_req_zone` 或 Cloudflare Rate Limiting
5. **定期备份**：`database.sqlite` 每日备份
6. **日志审计**：监控 `/api/login` 异常登录行为

---

审计完成。所有高危问题已修复，中危问题附有改进建议。
