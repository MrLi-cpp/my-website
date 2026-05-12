# 霁光 · 个人网站

一个全栈个人网站，支持博客、朋友圈、私信、个人中心与后台管理。

## 技术栈

- **后端**：Node.js + Express + SQLite
- **前端**：原生 HTML/CSS/JS（无框架）
- **样式**：暗黑主题（黑金配色）
- **认证**：Session-based（express-session）

## 功能

| 模块 | 说明 |
|------|------|
| 🏠 主页 | 四屏滑动系统：主页 / 朋友圈 / 博客 / 关于我 |
| 📝 博客 | Markdown 渲染、封面图、标签、浏览计数、点赞、评论（支持追评） |
| 📸 朋友圈 | 图文/视频动态、九宫格图片、位置、点赞、评论 |
| 💬 私信 | 多用户实时聊天、用户资料弹窗 |
| 👤 个人中心 | 头像上传、资料编辑、修改密码 |
| 🔐 后台 | 博客/朋友圈/故事的发布与管理 |

## 快速启动

```bash
npm install
node server.js
```

默认端口 `3000`，访问 `http://localhost:3000`。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `SESSION_SECRET` | Session 密钥 | 自动生成 |

## 文件结构

```
.
├── server.js          # Express 后端 + SQLite 数据库
├── public/            # 静态前端页面
│   ├── index.html     # 四屏滑动主页
│   ├── blog.html      # 博客列表 + 详情 + 评论
│   ├── moments.html   # 朋友圈
│   ├── chat.html      # 私信
│   ├── profile.html   # 个人中心
│   ├── admin.html     # 后台管理
│   ├── style.css      # 全局样式
│   └── script.js      # 通用工具函数
├── database.sqlite    # SQLite 数据库（.gitignore）
└── uploads/           # 用户上传文件（.gitignore）
```

## 管理员账号

首次启动自动创建管理员账号，详见 `server.js` 初始化逻辑。

## 数据库

SQLite 单文件，包含以下表：
- `users` — 用户（含软删除标记）
- `blogs` — 博客文章
- `moments` — 朋友圈动态
- `comments` — 评论（博客 + 朋友圈共用）
- `likes` — 点赞记录
- `messages` — 私信
- `stories` — 故事/连载

---

© 霁光
