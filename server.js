const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ===== 哲学家对话 - DeepSeek 配置 =====
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
if (!DEEPSEEK_API_KEY) {
  console.warn('⚠️  DEEPSEEK_API_KEY 未设置，哲学家对话功能将不可用');
}

const app = express();
const PORT = 3000;

// 安全相关常量（生产环境请通过环境变量配置）
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

if (!SESSION_SECRET) {
  console.error('❌ 错误：请设置 SESSION_SECRET 环境变量');
  console.error('   示例：SESSION_SECRET=your_random_string node server.js');
  process.exit(1);
}
if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('❌ 错误：请设置 ADMIN_USER 和 ADMIN_PASS 环境变量');
  console.error('   示例：ADMIN_USER=admin ADMIN_PASS=your_strong_password node server.js');
  process.exit(1);
}

// ========== 数据库 ==========
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// 创建表 + 初始化管理员
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''`, (err) => {});
  db.run(`ALTER TABLE users ADD COLUMN gender TEXT DEFAULT ''`, (err) => {});
  db.run(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`, (err) => {});
  db.run(`ALTER TABLE users ADD COLUMN deleted_at DATETIME`, [], (err) => { /* ignore duplicate column error */ });

  db.run(`ALTER TABLE users ADD COLUMN story_key TEXT DEFAULT ''`, (err) => {});

  // 为已有用户补充分配 story_key
  db.all("SELECT id, story_key FROM users WHERE story_key IS NULL OR story_key = ''", [], (err, rows) => {
    if (err || !rows) return;
    rows.forEach(u => {
      const key = generateStoryKey();
      db.run("UPDATE users SET story_key = ? WHERE id = ?", [key, u.id]);
    });
  });

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    images TEXT DEFAULT '[]',
    type TEXT DEFAULT 'moment',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    display_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    likes_count INTEGER DEFAULT 0
  )`);
  // 我的故事表
  db.run(`CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    paragraphs TEXT DEFAULT '[]',
    images TEXT DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 默认初始化四条记录
  const sections = [
    { section: 'primary', title: '小学' },
    { section: 'middle', title: '初中' },
    { section: 'high', title: '高中' },
    { section: 'university', title: '大学' }
  ];
  sections.forEach(s => {
    db.run(`INSERT OR IGNORE INTO stories (section, title) VALUES (?, ?)`, [s.section, s.title]);
  });

  // comments 表（新增 parent_id）
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // 如 parent_id 不存在则添加
  db.all(`PRAGMA table_info(comments)`, (err, rows) => {
    if (!err && rows && !rows.some(r => r.name === 'parent_id')) {
      db.run(`ALTER TABLE comments ADD COLUMN parent_id INTEGER DEFAULT NULL`);
    }
  });

  // ===== 私信表 =====
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT,
    type TEXT DEFAULT 'text',
    file_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_withdrawn INTEGER DEFAULT 0,
    is_read INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS comment_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(comment_id, user_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, user_id)
  )`);

  db.run(`ALTER TABLE posts ADD COLUMN location TEXT`, (err) => {});

  db.run(`CREATE TABLE IF NOT EXISTS blogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    cover_image TEXT,
    tags TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    display_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    views INTEGER DEFAULT 0,
    likes_count INTEGER DEFAULT 0
  )`);
  db.run(`ALTER TABLE blogs ADD COLUMN location TEXT`, (err) => {});

  db.run(`CREATE TABLE IF NOT EXISTS blog_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(blog_id, user_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS blog_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 数据库索引（带错误回调，防止未捕获异常）
  db.run('CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id)', [], (err) => { if (err) console.error('[INIT] idx_comments_post_id:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id)', [], (err) => { if (err) console.error('[INIT] idx_comments_user_id:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_blog_comments_blog_id ON blog_comments(blog_id)', [], (err) => { if (err) console.error('[INIT] idx_blog_comments_blog_id:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_blog_comments_user_id ON blog_comments(user_id)', [], (err) => { if (err) console.error('[INIT] idx_blog_comments_user_id:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_blog_comments_parent_id ON blog_comments(parent_id)', [], (err) => { if (err) console.error('[INIT] idx_blog_comments_parent_id:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id)', [], (err) => { if (err) console.error('[INIT] idx_likes_post_id:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_likes_user_id ON likes(user_id)', [], (err) => { if (err) console.error('[INIT] idx_likes_user_id:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_blog_likes_blog_id ON blog_likes(blog_id)', [], (err) => { if (err) console.error('[INIT] idx_blog_likes_blog_id:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_blog_likes_user_id ON blog_likes(user_id)', [], (err) => { if (err) console.error('[INIT] idx_blog_likes_user_id:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_posts_display_date ON posts(display_date)', [], (err) => { if (err) console.error('[INIT] idx_posts_display_date:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at)', [], (err) => { if (err) console.error('[INIT] idx_users_deleted_at:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)', [], (err) => { if (err) console.error('[INIT] idx_messages_sender:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id)', [], (err) => { if (err) console.error('[INIT] idx_messages_receiver:', err.message); });
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_receiver_read ON messages(receiver_id, is_read)', [], (err) => { if (err) console.error('[INIT] idx_messages_receiver_read:', err.message); });
  db.run('ALTER TABLE messages ADD COLUMN is_read INTEGER DEFAULT 0', [], (err) => { /* ignore duplicate column error */ });

  // 博客评论添加 parent_id（用于回复）— 先检查再添加，避免重复报错
  db.all("PRAGMA table_info(blog_comments)", [], (err, columns) => {
    if (!err && !columns.find(c => c.name === 'parent_id')) {
      db.run(`ALTER TABLE blog_comments ADD COLUMN parent_id INTEGER DEFAULT NULL`, [], (err) => {
        if (err) console.log('[INIT] blog_comments parent_id 已存在或添加失败:', err.message);
        else console.log('[INIT] blog_comments parent_id 添加成功');
      });
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT DEFAULT '李霁光',
    bio TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    location TEXT DEFAULT '广州',
    email TEXT DEFAULT '',
    github TEXT DEFAULT '',
    wechat TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 初始化管理员
  const adminHash = bcrypt.hashSync(ADMIN_PASS, 10);
  db.run('UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id NOT IN (3, 4) AND deleted_at IS NULL', [], function(err) {
    if (err) console.error('[INIT] soft-delete old accounts:', err.message);
    else console.log('[INIT] soft-deleted old accounts:', this.changes);
  });
  db.run('INSERT OR IGNORE INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)', [ADMIN_USER, adminHash], function() {
    if (this.changes) console.log('[INIT] 管理员账号已创建');
    else console.log('[INIT] 管理员账号已存在');
  });

  // 清理残留视频数据
  db.run("UPDATE posts SET video = NULL", (err) => {
    if (err) console.error('[INIT] 清理 posts 视频失败:', err.message);
    else console.log('[INIT] 已清空 posts 表 video 字段');
  });
  db.run("DELETE FROM messages WHERE type = 'video'", (err) => {
    if (err) console.error('[INIT] 清理视频消息失败:', err.message);
    else console.log('[INIT] 已删除视频类型消息');
  });

  // ===== 学习站资料表 =====
  db.run(`CREATE TABLE IF NOT EXISTS learning_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    cover_image TEXT,
    html_file TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    display_date DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // ===== 哲学家对话表 =====
  db.run(`CREATE TABLE IF NOT EXISTS philosopher_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    session_id TEXT NOT NULL,
    philosopher_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    citations TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_philo_chats_session ON philosopher_chats(session_id)`, [], (err) => { if (err) console.error('[INIT] idx_philo_chats_session:', err.message); });
  db.run(`CREATE INDEX IF NOT EXISTS idx_philo_chats_user_philo ON philosopher_chats(user_id, philosopher_id)`, [], (err) => { if (err) console.error('[INIT] idx_philo_chats_user_philo:', err.message); });

  // ===== 哲学家用户画像表（结构化，替代JSON） =====
  db.run(`CREATE TABLE IF NOT EXISTS philosopher_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    stance TEXT,
    preferred_examples TEXT DEFAULT '[]',
    disliked_styles TEXT DEFAULT '[]',
    total_messages INTEGER DEFAULT 0,
    last_session_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // ===== 哲学家概念掌握度表 =====
  db.run(`CREATE TABLE IF NOT EXISTS philosopher_concepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    philosopher_id TEXT NOT NULL,
    concept_name TEXT NOT NULL,
    level TEXT DEFAULT 'novice',   -- novice | familiar | mastered
    depth TEXT DEFAULT 'basic',    -- basic | intermediate | advanced
    discuss_count INTEGER DEFAULT 1,
    last_discussed DATE,
    related_concepts TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, philosopher_id, concept_name)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_philo_concepts_user ON philosopher_concepts(user_id, philosopher_id)`, [], (err) => { if (err) console.error('[INIT] idx_philo_concepts_user:', err.message); });

  // ===== 哲学家学者兴趣表 =====
  db.run(`CREATE TABLE IF NOT EXISTS philosopher_scholars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    philosopher_id TEXT NOT NULL,
    scholar_name TEXT NOT NULL,
    interest_score INTEGER DEFAULT 1, -- 引用次数/兴趣强度
    first_seen DATE,
    last_seen DATE,
    UNIQUE(user_id, philosopher_id, scholar_name)
  )`);

  // ===== 哲学家会话摘要表（用于长期记忆检索） =====
  db.run(`CREATE TABLE IF NOT EXISTS philosopher_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    philosopher_id TEXT NOT NULL,
    session_id TEXT,
    summary TEXT NOT NULL,
    key_concepts TEXT DEFAULT '[]',
    message_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_philo_summaries_user ON philosopher_summaries(user_id, philosopher_id)`, [], (err) => { if (err) console.error('[INIT] idx_philo_summaries_user:', err.message); });

  // ===== 数据迁移：旧JSON画像 → 结构化表 =====
  db.get("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='philosopher_profiles'", [], (err, row) => {
    if (err || !row || row.cnt === 0) return;
    db.all('SELECT * FROM philosopher_profiles WHERE concept_mastery IS NOT NULL AND concept_mastery != \'{}\'', [], (err, oldProfiles) => {
      if (err || !oldProfiles || !oldProfiles.length) return;
      console.log(`[INIT] 发现 ${oldProfiles.length} 个旧版画像，开始迁移...`);
      for (const p of oldProfiles) {
        const userId = p.user_id;
        const mastery = JSON.parse(p.concept_mastery || '{}');
        const prefs = JSON.parse(p.user_preferences || '{}');
        const summaries = JSON.parse(p.session_summaries || '[]');

        // 迁移 stance + preferences
        db.run(
          'INSERT OR REPLACE INTO philosopher_profiles (user_id, stance, preferred_examples, disliked_styles, total_messages, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, prefs.stance || null, JSON.stringify(prefs.preferredExamples || []), JSON.stringify(prefs.dislikedStyles || []), summaries.length * 2, p.updated_at]
        );

        // 迁移概念
        for (const [name, data] of Object.entries(mastery)) {
          db.run(
            'INSERT OR REPLACE INTO philosopher_concepts (user_id, philosopher_id, concept_name, level, depth, discuss_count, last_discussed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [userId, 'nietzsche', name, data.level || 'novice', data.depth || 'basic', 1, data.lastDiscussed || null, p.updated_at]
          );
        }

        // 迁移学者
        for (const s of (prefs.engagedScholars || [])) {
          db.run(
            'INSERT OR REPLACE INTO philosopher_scholars (user_id, philosopher_id, scholar_name, interest_score, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, 'nietzsche', s, 1, p.updated_at, p.updated_at]
          );
        }

        // 迁移摘要
        for (const sum of summaries) {
          db.run(
            'INSERT INTO philosopher_summaries (user_id, philosopher_id, session_id, summary, key_concepts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, 'nietzsche', sum.sessionId || `sess_${Date.now()}`, sum.summary, JSON.stringify(sum.keyConcepts || []), sum.timestamp || p.updated_at]
          );
        }
      }
      console.log('[INIT] 画像数据迁移完成');
    });
  });

  // ===== 群聊圆桌数据表 =====
  db.run(`CREATE TABLE IF NOT EXISTS group_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '哲思圆桌',
    current_topic TEXT DEFAULT '',
    round_count INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME DEFAULT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS group_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    speaker_type TEXT CHECK(speaker_type IN ('user', 'philosopher')) NOT NULL,
    speaker_id TEXT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_group_msgs_session ON group_chat_messages(session_id)`, [], (err) => { if (err) console.error('[INIT] idx_group_msgs_session:', err.message); });
});

// ========== 安全工具函数 ==========
function isPathSafe(targetPath, allowedBase) {
  const resolved = path.resolve(targetPath);
  const baseResolved = path.resolve(allowedBase);
  return resolved.startsWith(baseResolved + path.sep) || resolved === baseResolved;
}

function sanitizeFilePath(userPath) {
  if (!userPath || typeof userPath !== 'string') return null;
  // 拒绝包含 .. 的路径
  if (userPath.includes('..')) return null;
  // 只允许相对路径（以 / 开头）
  if (!userPath.startsWith('/')) return null;
  return userPath;
}

// CSRF Token 生成与校验
function generateCsrfToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

function csrfProtection(req, res, next) {
  // 只校验 state-changing 方法
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const token = req.headers['x-csrf-token'] || req.body._csrf;
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).json({ error: 'CSRF token 无效' });
    }
  }
  next();
}

// ========== 中间件 ==========
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(session({
  store: new FileStore({ path: './sessions', logFn: () => {} }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'strict',
    secure: false,
    httpOnly: true
  }
}));
// CSRF token 注入：每次请求刷新 token
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});
// CSRF token API
app.get('/api/csrf-token', (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }
  res.json({ csrfToken: req.session.csrfToken });
});
// HSTS + 安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(csrfProtection);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 权限中间件
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '请先登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '请先登录' });
  db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err || !user || !user.is_admin) return res.status(403).json({ error: '权限不足' });
    next();
  });
}

// ========== 文件上传 ==========
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传图片'), false);
    }
  }
});

// ========== API 路由 ==========

// 获取帖子列表（含点赞用户和评论）
app.get('/api/posts', (req, res) => {
  const userId = req.session.userId || 0;
  db.all(`
    SELECT p.*, 'admin' as author_name
    FROM posts p
    ORDER BY p.display_date DESC
  `, [], (err, posts) => {
    if (err) return res.status(500).json({ error: err.message });
    for (const post of posts) {
      post.images = JSON.parse(post.images || '[]');
      post.user_liked = false;
      post.likers = [];
      post.comments_list = [];
    }
    if (!posts.length) return res.json(posts);

    const postIds = posts.map(p => p.id);
    const placeholders = postIds.map(() => '?').join(',');

    // 查询点赞用户
    db.all(`
      SELECT l.post_id, u.username
      FROM likes l
      JOIN users u ON u.id = l.user_id
      WHERE l.post_id IN (${placeholders})
      ORDER BY l.created_at ASC
    `, postIds, (err, likes) => {
      if (!err && likes) {
        for (const l of likes) {
          const post = posts.find(p => p.id === l.post_id);
          if (post) post.likers.push(l.username);
        }
      }

      // 查询评论（含点赞数、当前用户是否点赞、parent_id、点赞用户名列表）
      db.all(`
        SELECT c.id, c.post_id, c.content, c.parent_id, c.created_at, u.username, c.user_id,
          (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) as likes_count,
          (SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = ?) as user_liked,
          (SELECT GROUP_CONCAT(u2.username, '、') FROM comment_likes cl2 JOIN users u2 ON u2.id = cl2.user_id WHERE cl2.comment_id = c.id) as likers
        FROM comments c
        JOIN users u ON u.id = c.user_id
        WHERE c.post_id IN (${placeholders})
        ORDER BY c.parent_id ASC, c.created_at ASC
      `, [userId, ...postIds], (err, comments) => {
        if (!err && comments) {
          for (const c of comments) {
            const post = posts.find(p => p.id === c.post_id);
            if (post) post.comments_list.push(c);
          }
        }

        // 当前用户点赞状态
        if (req.session.userId) {
          db.all('SELECT post_id FROM likes WHERE user_id = ?', [req.session.userId], (err, myLikes) => {
            const likedSet = new Set(myLikes.map(l => l.post_id));
            for (const post of posts) post.user_liked = likedSet.has(post.id);
            res.json(posts);
          });
        } else {
          res.json(posts);
        }
      });
    });
  });
});

// 获取单条帖子
app.get('/api/posts/:id', (req, res) => {
  db.get('SELECT * FROM posts WHERE id = ?', [req.params.id], (err, post) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!post) return res.status(404).json({ error: '帖子不存在' });
    post.images = JSON.parse(post.images || '[]');
    res.json(post);
  });
});

// 管理员发帖
app.post('/api/posts', requireAdmin, upload.array('images', 9), (req, res) => {
  const { content, type, display_date, location } = req.body;
  const images = req.files ? req.files.map(f => '/uploads/' + f.filename) : [];
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO posts (content, images, type, display_date, location) VALUES (?, ?, ?, ?, ?)',
    [content, JSON.stringify(images), type || 'moment', display_date || now, location || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: '发布成功' });
    }
  );
});

// 管理员修改帖子日期
app.put('/api/posts/:id/date', requireAdmin, (req, res) => {
  const { display_date } = req.body;
  if (!display_date) return res.status(400).json({ error: '缺少日期' });
  db.run('UPDATE posts SET display_date = ? WHERE id = ?', [display_date, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: '日期已更新' });
  });
});

// 管理员删除帖子
app.delete('/api/posts/:id', requireAdmin, (req, res) => {
  db.run('DELETE FROM posts WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: '已删除' });
  });
});

// 管理员编辑帖子内容
app.put('/api/posts/:id', requireAdmin, upload.array('images', 9), (req, res) => {
  const { content, type, location } = req.body;
  const images = req.files ? JSON.stringify(req.files.map(f => '/uploads/' + f.filename)) : null;

  // 动态构建 UPDATE 语句
  const fields = ['content = ?', 'type = ?', 'location = ?'];
  const values = [content, type, location || null];

  if (images) { fields.push('images = ?'); values.push(images); }

  values.push(req.params.id);
  const sql = 'UPDATE posts SET ' + fields.join(', ') + ' WHERE id = ?';

  db.run(sql, values, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: '已更新' });
  });
});

// ========== 用户系统 ==========

// 生成16位故事访问密钥
function generateStoryKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 16; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

// 注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '缺少用户名或密码' });
  if (username.length < 2 || password.length < 4) return res.status(400).json({ error: '用户名至少2位，密码至少4位' });

  const hash = bcrypt.hashSync(password, 10);
  const storyKey = generateStoryKey();
  db.run('INSERT INTO users (username, password_hash, story_key) VALUES (?, ?, ?)', [username, hash, storyKey], function(err) {
    if (err) return res.status(400).json({ error: '用户名已存在' });
    req.session.userId = this.lastID;
    req.session.username = username;
    res.json({ id: this.lastID, username, message: '注册成功' });
  });
});

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err || !user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = !!user.is_admin;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: '登录失败' });
      res.json({ id: user.id, username: user.username, is_admin: !!user.is_admin, message: '登录成功' });
    });
  });
});

// 退出
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.clearCookie('connect.sid');
  res.json({ message: '已退出' });
});

// 当前用户
app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  db.get('SELECT id, username, is_admin, avatar, gender, bio, deleted_at FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err || !user) return res.json(null);
    if (user.deleted_at) {
      req.session.destroy();
      return res.status(403).json({ error: '账号已注销' });
    }
    res.json(user);
  });
});

// 更新个人资料
app.put('/api/me', requireLogin, (req, res) => {
  const { username, avatar, gender, bio } = req.body;
  const userId = req.session.userId;
  const updates = [];
  const values = [];
  if (username !== undefined) { updates.push('username = ?'); values.push(username); }
  if (avatar !== undefined) { updates.push('avatar = ?'); values.push(avatar); }
  if (gender !== undefined) { updates.push('gender = ?'); values.push(gender); }
  if (bio !== undefined) { updates.push('bio = ?'); values.push(bio); }
  if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });
  values.push(userId);
  db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: '资料已更新' });
  });
});

// 修改密码
app.post('/api/change-password', requireLogin, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const userId = req.session.userId;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请填写原密码和新密码' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: '新密码至少4位' });
  }

  db.get('SELECT password_hash FROM users WHERE id = ?', [userId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
      return res.status(400).json({ error: '原密码不正确' });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: '密码修改成功' });
    });
  });
});

// 获取用户公开资料
app.get('/api/users/:id', (req, res) => {
  const userId = req.params.id;
  db.get('SELECT id, username, avatar, gender, bio, deleted_at FROM users WHERE id = ?', [userId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    res.json(user);
  });
});

// ========== 点赞/评论 ==========

// 点赞/取消点赞（原子操作）
app.post('/api/posts/:id/like', requireLogin, (req, res) => {
  const postId = req.params.id;
  const userId = req.session.userId;

  db.serialize(() => {
    db.run('BEGIN IMMEDIATE');
    db.get('SELECT id FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId], (err, existing) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }
      if (existing) {
        db.run('DELETE FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId], function(err) {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          db.run('UPDATE posts SET likes_count = MAX(0, likes_count - 1) WHERE id = ?', [postId], function(err2) {
            if (err2) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: err2.message });
            }
            db.run('COMMIT');
            res.json({ liked: false });
          });
        });
      } else {
        db.run('INSERT INTO likes (post_id, user_id) VALUES (?, ?)', [postId, userId], function(err) {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          db.run('UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?', [postId], function(err2) {
            if (err2) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: err2.message });
            }
            db.run('COMMIT');
            res.json({ liked: true });
          });
        });
      }
    });
  });
});

// 评论
app.post('/api/posts/:id/comment', requireLogin, (req, res) => {
  const { content, parent_id } = req.body;
  if (!content || content.trim().length === 0) return res.status(400).json({ error: '评论内容不能为空' });
  db.run('INSERT INTO comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)',
    [req.params.id, req.session.userId, content.trim(), parent_id || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: '评论成功' });
    }
  );
});

// 获取评论
app.get('/api/posts/:id/comments', (req, res) => {
  db.all(`
    SELECT c.*, u.username
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `, [req.params.id], (err, comments) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(comments);
  });
});

// 评论点赞（原子操作）
app.post('/api/comments/:id/like', requireLogin, (req, res) => {
  const commentId = req.params.id;
  const userId = req.session.userId;
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE');
    db.get('SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?', [commentId, userId], (err, row) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }
      if (row) {
        db.run('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?', [commentId, userId], function(err) {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          db.run('COMMIT');
          res.json({ liked: false });
        });
      } else {
        db.run('INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)', [commentId, userId], function(err) {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          db.run('COMMIT');
          res.json({ liked: true });
        });
      }
    });
  });
});

// 修改评论（朋友圈）
app.put('/api/comments/:id', requireLogin, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length === 0) return res.status(400).json({ error: '评论内容不能为空' });
  db.get('SELECT user_id FROM comments WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: '评论不存在' });
    if (row.user_id !== req.session.userId) return res.status(403).json({ error: '无权修改' });
    db.run('UPDATE comments SET content = ? WHERE id = ?', [content.trim(), req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: '修改成功' });
    });
  });
});

// 删除评论（自己或管理员）
app.delete('/api/comments/:id', requireLogin, (req, res) => {
  const commentId = req.params.id;
  const userId = req.session.userId;
  db.get('SELECT user_id FROM comments WHERE id = ?', [commentId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: '评论不存在' });
    db.get('SELECT is_admin FROM users WHERE id = ?', [userId], (err2, user) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (row.user_id !== userId && (!user || !user.is_admin)) return res.status(403).json({ error: '无权删除' });
      db.run('DELETE FROM comments WHERE id = ?', [commentId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    });
  });
});

// ========== 博客系统 ==========

// 获取博客列表
app.get('/api/blogs', (req, res) => {
  db.all(`
    SELECT b.*, ? as author_name
    FROM blogs b
    ORDER BY b.display_date DESC
  `, [ADMIN_USER], (err, blogs) => {
    if (err) return res.status(500).json({ error: err.message });
    for (const blog of blogs) {
      blog.tags = JSON.parse(blog.tags || '[]');
      blog.user_liked = false;
      blog.likers = [];
      blog.comments_list = [];
    }
    if (!blogs.length) return res.json(blogs);

    const blogIds = blogs.map(b => b.id);
    const placeholders = blogIds.map(() => '?').join(',');

    db.all(`
      SELECT l.blog_id, u.username
      FROM blog_likes l
      JOIN users u ON u.id = l.user_id
      WHERE l.blog_id IN (${placeholders})
      ORDER BY l.created_at ASC
    `, blogIds, (err, likes) => {
      if (!err && likes) {
        for (const l of likes) {
          const blog = blogs.find(b => b.id === l.blog_id);
          if (blog) blog.likers.push(l.username);
        }
      }

      db.all(`
        SELECT c.blog_id, c.content, u.username, c.created_at, c.user_id, c.parent_id
        FROM blog_comments c
        JOIN users u ON u.id = c.user_id
        WHERE c.blog_id IN (${placeholders})
        ORDER BY c.created_at ASC
      `, blogIds, (err, comments) => {
        if (!err && comments) {
          for (const c of comments) {
            const blog = blogs.find(b => b.id === c.blog_id);
            if (blog) blog.comments_list.push(c);
          }
        }

        if (req.session.userId) {
          db.all('SELECT blog_id FROM blog_likes WHERE user_id = ?', [req.session.userId], (err, myLikes) => {
            const likedSet = new Set(myLikes.map(l => l.blog_id));
            for (const blog of blogs) blog.user_liked = likedSet.has(blog.id);
            res.json(blogs);
          });
        } else {
          res.json(blogs);
        }
      });
    });
  });
});

// 获取单篇博客
app.get('/api/blogs/:id', (req, res) => {
  db.get('SELECT * FROM blogs WHERE id = ?', [req.params.id], (err, blog) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!blog) return res.status(404).json({ error: '博客不存在' });
    blog.tags = JSON.parse(blog.tags || '[]');
    // 增加浏览量
    db.run('UPDATE blogs SET views = views + 1 WHERE id = ?', [req.params.id]);
    res.json(blog);
  });
});

// 管理员发布博客
app.post('/api/blogs', requireAdmin, upload.single('cover'), (req, res) => {
  const { title, content, tags, display_date, location } = req.body;
  const cover_image = req.file ? '/uploads/' + req.file.filename : '';
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO blogs (title, content, cover_image, tags, display_date, location) VALUES (?, ?, ?, ?, ?, ?)',
    [title, content, cover_image, JSON.stringify(tags ? tags.split(',').map(t => t.trim()) : []), display_date || now, location || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: '博客发布成功' });
    }
  );
});

// 管理员编辑博客
app.put('/api/blogs/:id', requireAdmin, upload.single('cover'), (req, res) => {
  const { title, content, tags, display_date, location } = req.body;
  db.get('SELECT * FROM blogs WHERE id = ?', [req.params.id], (err, blog) => {
    if (err || !blog) return res.status(404).json({ error: '博客不存在' });
    const cover_image = req.file ? '/uploads/' + req.file.filename : blog.cover_image;
    db.run(
      'UPDATE blogs SET title = ?, content = ?, cover_image = ?, tags = ?, display_date = ?, location = ? WHERE id = ?',
      [title, content, cover_image, JSON.stringify(tags ? tags.split(',').map(t => t.trim()) : []), display_date || blog.display_date, location || blog.location, req.params.id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: '博客已更新' });
      }
    );
  });
});

// 管理员删除博客
app.delete('/api/blogs/:id', requireAdmin, (req, res) => {
  db.run('DELETE FROM blogs WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: '博客已删除' });
  });
});

// 博客点赞/取消点赞（原子操作）
app.post('/api/blogs/:id/like', requireLogin, (req, res) => {
  const blogId = req.params.id;
  const userId = req.session.userId;
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE');
    db.get('SELECT id FROM blog_likes WHERE blog_id = ? AND user_id = ?', [blogId, userId], (err, existing) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }
      if (existing) {
        db.run('DELETE FROM blog_likes WHERE blog_id = ? AND user_id = ?', [blogId, userId], function(err) {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          db.run('UPDATE blogs SET likes_count = MAX(0, likes_count - 1) WHERE id = ?', [blogId], function(err2) {
            if (err2) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: err2.message });
            }
            db.run('COMMIT');
            res.json({ liked: false });
          });
        });
      } else {
        db.run('INSERT INTO blog_likes (blog_id, user_id) VALUES (?, ?)', [blogId, userId], function(err) {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          db.run('UPDATE blogs SET likes_count = likes_count + 1 WHERE id = ?', [blogId], function(err2) {
            if (err2) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: err2.message });
            }
            db.run('COMMIT');
            res.json({ liked: true });
          });
        });
      }
    });
  });
});

// 博客评论
app.post('/api/blogs/:id/comment', requireLogin, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length === 0) return res.status(400).json({ error: '评论内容不能为空' });
  db.run('INSERT INTO blog_comments (blog_id, user_id, content) VALUES (?, ?, ?)',
    [req.params.id, req.session.userId, content.trim()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: '评论成功' });
    }
  );
});

// 获取博客评论
app.get('/api/blogs/:id/comments', (req, res) => {
  db.all(`
    SELECT c.*, u.username
    FROM blog_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.blog_id = ?
    ORDER BY c.parent_id ASC, c.created_at ASC
  `, [req.params.id], (err, comments) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(comments);
  });
});

// 修改博客评论
app.put('/api/blog-comments/:id', requireLogin, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length === 0) return res.status(400).json({ error: '评论内容不能为空' });
  db.get('SELECT user_id FROM blog_comments WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: '评论不存在' });
    if (row.user_id !== req.session.userId) return res.status(403).json({ error: '无权修改' });
    db.run('UPDATE blog_comments SET content = ? WHERE id = ?', [content.trim(), req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: '修改成功' });
    });
  });
});

// 删除博客评论
app.delete('/api/blog-comments/:id', requireLogin, (req, res) => {
  db.get('SELECT user_id FROM blog_comments WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: '评论不存在' });
    if (row.user_id !== req.session.userId) return res.status(403).json({ error: '无权删除' });
    db.run('DELETE FROM blog_comments WHERE id = ?', [req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: '删除成功' });
    });
  });
});

// 回复博客评论
app.post('/api/blog-comments/:id/reply', requireLogin, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length === 0) return res.status(400).json({ error: '回复内容不能为空' });
  db.get('SELECT blog_id FROM blog_comments WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: '评论不存在' });
    db.run('INSERT INTO blog_comments (blog_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)',
      [row.blog_id, req.session.userId, content.trim(), req.params.id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, message: '回复成功' });
      }
    );
  });
});

// ========== 个人信息 ==========

app.get('/api/profile', (req, res) => {
  db.get('SELECT * FROM profile WHERE id = 1', [], (err, profile) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!profile) {
      db.run('INSERT INTO profile (id) VALUES (1)');
      return res.json({ id: 1, name: '李霁光', bio: '', avatar: '', location: '广州', email: '', github: '', wechat: '' });
    }
    res.json(profile);
  });
});

// ========== 我的故事 API ==========
const STORY_ACCESS_KEY = 'jiguang2026'; // 故事访问密钥

// 验证故事访问密钥（验证当前登录用户的个人密钥）
app.post('/api/story-verify', (req, res) => {
  const { key } = req.body;
  if (!req.session.userId) return res.status(401).json({ error: '请先登录' });
  db.get('SELECT story_key FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err || !user) return res.status(500).json({ error: '用户不存在' });
    if (user.story_key === key) {
      req.session.storyAccess = true;
      req.session.save(() => res.json({ success: true }));
    } else {
      res.status(403).json({ error: '密钥错误' });
    }
  });
});

// 管理员查看所有用户密钥
app.get('/api/admin/keys', requireAdmin, (req, res) => {
  db.all('SELECT id, username, story_key FROM users WHERE deleted_at IS NULL AND is_admin = 0 ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// 获取故事
app.get('/api/story/:section', (req, res) => {
  const section = req.params.section;
  db.get('SELECT * FROM stories WHERE section = ?', [section], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: '未找到' });
    try {
      row.paragraphs = JSON.parse(row.paragraphs || '[]');
      row.images = JSON.parse(row.images || '[]');
    } catch(e) {
      row.paragraphs = [];
      row.images = [];
    }
    res.json(row);
  });
});

// 保存故事（管理员）
app.put('/api/story/:section', requireAdmin, upload.array('storyImages', 20), (req, res) => {
  const section = req.params.section;
  const { title, paragraphs, images } = req.body;
  // 如果有新上传的文件，合并到图片列表
  let parsedImages = [];
  try {
    parsedImages = JSON.parse(images || '[]');
  } catch(e) {}

  if (req.files && req.files.length > 0) {
    const newUrls = req.files.map(f => '/uploads/' + f.filename);
    parsedImages = parsedImages.concat(newUrls.map((url, i) => ({
      url,
      position: 0.5  // 默认居中
    })));
  }

  db.run(
    'UPDATE stories SET title = ?, paragraphs = ?, images = ?, updated_at = CURRENT_TIMESTAMP WHERE section = ?',
    [title, paragraphs, JSON.stringify(parsedImages), section],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: '已保存' });
    }
  );
});

// 获取所有故事概要（用于列表页）
app.get('/api/stories', (req, res) => {
  db.all('SELECT section, title, updated_at FROM stories ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.put('/api/profile', requireAdmin, upload.single('avatar'), (req, res) => {
  console.log('[PROFILE PUT] file:', req.file, 'body.avatar:', req.body.avatar, 'name:', req.body.name);
  const { name, bio, location, email, github, wechat } = req.body;
  let avatar = req.file ? '/uploads/' + req.file.filename : (req.body.avatar || '');
  db.get('SELECT * FROM profile WHERE id = 1', [], (err, existing) => {
    if (!existing) {
      db.run('INSERT INTO profile (id, name, bio, avatar, location, email, github, wechat) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
        [name, bio, avatar, location, email, github, wechat],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: '个人信息已更新', avatar });
        }
      );
    } else {
      // 如果没上传新头像且没传 avatar 字段，保留原头像
      const finalAvatar = (avatar === '' && existing.avatar) ? existing.avatar : avatar;
      db.run('UPDATE profile SET name = ?, bio = ?, avatar = ?, location = ?, email = ?, github = ?, wechat = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
        [name, bio, finalAvatar, location, email, github, wechat],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: '个人信息已更新', avatar: finalAvatar });
        }
      );
    }
  });
});

// ========== 私信系统 ==========

// 获取管理员用户ID
function getAdminId(callback) {
  db.get("SELECT id FROM users WHERE username = ? LIMIT 1", [ADMIN_USER], (err, row) => {
    if (err || !row) return callback(null);
    callback(row.id);
  });
}

function getAdminIdAsync() {
  return new Promise((resolve) => {
    db.get("SELECT id FROM users WHERE username = ? LIMIT 1", [ADMIN_USER], (err, row) => {
      if (err || !row) return resolve(null);
      resolve(row.id);
    });
  });
}

// 获取与某人的对话
app.get('/api/messages', requireLogin, (req, res) => {
  const userId = req.session.userId;
  const withId = parseInt(req.query.with) || 0;
  if (!withId) return res.status(400).json({ error: '缺少 with 参数' });

  // 先检查对方是否已注销及注销时间
  db.get('SELECT deleted_at FROM users WHERE id = ?', [withId], (err, other) => {
    const otherDeletedAt = other && other.deleted_at ? other.deleted_at : null;

    db.all(
      `SELECT m.*, u1.username as sender_name, u1.id as sender_id
       FROM messages m
       JOIN users u1 ON m.sender_id = u1.id
       WHERE ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
         AND m.is_withdrawn = 0
       ORDER BY m.created_at ASC`,
      [userId, withId, withId, userId],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // 只有发给已注销用户、且发送时间在注销之后的消息才标记
        if (otherDeletedAt) {
          rows.forEach(m => {
            if (m.receiver_id === withId && m.created_at > otherDeletedAt) {
              m.receiver_deleted = true;
            }
          });
        }
        res.json(rows);
      }
    );
  });
});

// 发送消息
app.post('/api/messages', requireLogin, upload.single('image'), async (req, res) => {
  const senderId = req.session.userId;
  const { content, receiver_id: bodyReceiverId, type } = req.body;
  let receiver_id = bodyReceiverId;

  if (!receiver_id) {
    // 兼容旧逻辑：如果没传 receiver_id，默认发给管理员
    receiver_id = await getAdminIdAsync();
  }
  if (!receiver_id) return res.status(400).json({ error: '缺少接收人' });

  const receiverId = parseInt(receiver_id);
  if (!receiverId) return res.status(400).json({ error: '缺少 receiver_id' });

  let fileUrl = null;
  const msgType = type || 'text';
  if (req.file) {
    fileUrl = '/uploads/' + req.file.filename;
  }

  db.get('SELECT deleted_at FROM users WHERE id = ?', [receiverId], (err, receiver) => {
    if (err) return res.status(500).json({ error: err.message });
    const isDeleted = !!(receiver && receiver.deleted_at);

    db.run(
      'INSERT INTO messages (sender_id, receiver_id, content, type, file_url) VALUES (?, ?, ?, ?, ?)',
      [senderId, receiverId, content || '', msgType, fileUrl],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.get('SELECT m.*, u.username as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?', [this.lastID], (err, row) => {
          if (err) return res.status(500).json({ error: err.message });
          if (isDeleted) row.receiver_deleted = true;
          res.json(row);
        });
      }
    );
  });
});

// 撤回消息
app.put('/api/messages/:id/withdraw', requireLogin, (req, res) => {
  const userId = req.session.userId;
  const msgId = req.params.id;
  db.get('SELECT * FROM messages WHERE id = ?', [msgId], (err, msg) => {
    if (err || !msg) return res.status(404).json({ error: '消息不存在' });
    if (msg.sender_id !== userId) return res.status(403).json({ error: '只能撤回自己的消息' });
    // 限制：只能撤回2分钟内的消息
    const created = new Date(msg.created_at);
    const now = new Date();
    if ((now - created) > 2 * 60 * 1000) return res.status(403).json({ error: '超过2分钟无法撤回' });

    db.run('UPDATE messages SET is_withdrawn = 1 WHERE id = ?', [msgId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: '已撤回' });
    });
  });
});

// 获取会话列表（返回当前用户所有相关私信会话）
app.get('/api/chat-sessions', requireLogin, (req, res) => {
  const userId = req.session.userId;

  db.all(
    `SELECT DISTINCT
      CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as user_id
    FROM messages
    WHERE sender_id = ? OR receiver_id = ?`,
    [userId, userId, userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const userIds = rows.map(r => r.user_id);
      if (!userIds.length) return res.json([]);

      db.all(
        `SELECT m.*, u.username, u.id as other_id, u.deleted_at
         FROM messages m
         JOIN users u ON (CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END) = u.id
         WHERE m.id IN (
           SELECT MAX(id) FROM messages
           WHERE (sender_id = ? OR receiver_id = ?)
           GROUP BY CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
         )
         ORDER BY m.created_at DESC`,
        [userId, userId, userId, userId],
        (err2, sessions) => {
          if (err2) return res.status(500).json({ error: err2.message });
          if (!sessions.length) return res.json([]);
          // 为每个会话计算未读数
          let pending = sessions.length;
          sessions.forEach(s => {
            db.get(
              'SELECT COUNT(*) as cnt FROM messages WHERE receiver_id = ? AND sender_id = ? AND is_read = 0',
              [userId, s.other_id],
              (err3, row) => {
                if (!err3) s.unread_count = row ? row.cnt : 0;
                pending--;
                if (pending === 0) res.json(sessions);
              }
            );
          });
        }
      );
    }
  );
});

// 获取当前用户总未读消息数
app.get('/api/unread-count', requireLogin, (req, res) => {
  const userId = req.session.userId;
  db.get(
    'SELECT COUNT(*) as count FROM messages WHERE receiver_id = ? AND is_read = 0',
    [userId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ count: row ? row.count : 0 });
    }
  );
});

// 标记消息为已读
app.post('/api/messages/read', requireLogin, (req, res) => {
  const userId = req.session.userId;
  const otherId = req.body.other_id;
  if (!otherId) return res.status(400).json({ error: '缺少参数' });
  db.run(
    'UPDATE messages SET is_read = 1 WHERE receiver_id = ? AND sender_id = ? AND is_read = 0',
    [userId, otherId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ marked: this.changes });
    }
  );
});

// 发送消息（含文件上传）
app.post('/api/messages/upload', requireLogin, upload.single('file'), (req, res) => {
  const senderId = req.session.userId;
  const receiverId = parseInt(req.body.receiver_id);
  const msgType = req.body.type || 'image';
  const fileUrl = req.file ? '/uploads/' + req.file.filename : '';

  if (!receiverId || !fileUrl) return res.status(400).json({ error: '参数错误' });

  // 普通用户只能发给管理员
  db.get('SELECT is_admin FROM users WHERE id = ?', [senderId], (err, sender) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!sender || !sender.is_admin) {
      db.get("SELECT id FROM users WHERE is_admin = 1", [], (err2, admin) => {
        if (err2 || !admin) return res.status(500).json({ error: '管理员不存在' });
        if (receiverId !== admin.id) return res.status(403).json({ error: '只能给管理员发消息' });
        insertMessage(senderId, receiverId, '', msgType, fileUrl, res);
      });
    } else {
      insertMessage(senderId, receiverId, '', msgType, fileUrl, res);
    }
  });
});

function insertMessage(senderId, receiverId, content, msgType, fileUrl, res) {
  // 检查对方是否已注销
  db.get('SELECT deleted_at FROM users WHERE id = ?', [receiverId], (err, receiver) => {
    if (err) return res.status(500).json({ error: err.message });
    const isDeleted = !!(receiver && receiver.deleted_at);
    db.run(
      'INSERT INTO messages (sender_id, receiver_id, content, type, file_url) VALUES (?, ?, ?, ?, ?)',
      [senderId, receiverId, content || '', msgType, fileUrl || ''],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.get('SELECT m.*, u.username as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?', [this.lastID], (err, row) => {
          if (err) return res.status(500).json({ error: err.message });
          if (isDeleted) row.receiver_deleted = true;
          res.json(row);
        });
      }
    );
  });
}

// 标记管理员在线状态（用于前端判断）
app.get('/api/me/admin', requireLogin, (req, res) => {
  db.get('SELECT id, username, is_admin, avatar, gender, bio, deleted_at FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: '用户不存在' });
    req.session.isAdmin = !!user.is_admin;
    res.json({ is_admin: !!user.is_admin, user_id: req.session.userId, deleted_at: user.deleted_at });
  });
});

// 获取用户列表（所有已登录用户可见，过滤已注销）
app.get('/api/users', requireLogin, (req, res) => {
  db.all('SELECT id, username, is_admin, avatar, gender, bio FROM users WHERE deleted_at IS NULL ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 注销账号（软删除）
app.delete('/api/me', requireLogin, (req, res) => {
  const userId = req.session.userId;
  db.run('UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: '用户不存在' });
    req.session.destroy();
    res.json({ message: '账号已注销' });
  });
});

// ===== 学习站 API =====

// 上传学习资料（管理员）
const learningUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'uploads', 'learning');
      if (!require('fs').existsSync(dir)) {
        require('fs').mkdirSync(dir, { recursive: true });
      }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname);
      const base = file.fieldname === 'html' ? 'doc' : 'cover';
      cb(null, `${base}_${ts}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'html') {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext !== '.html' && ext !== '.htm') {
        return cb(new Error('仅支持 HTML 文件'));
      }
    }
    cb(null, true);
  }
});

app.post('/api/learning', learningUpload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'html', maxCount: 1 }
]), requireAdmin, (req, res) => {
  const title = req.body.title?.trim();
  const displayDate = req.body.display_date;
  if (!title || !displayDate) {
    return res.status(400).json({ error: '标题和日期不能为空' });
  }
  if (!req.files || !req.files.html || !req.files.html[0]) {
    return res.status(400).json({ error: '必须上传 HTML 文件' });
  }

  const htmlPath = '/uploads/learning/' + req.files.html[0].filename;
  const coverPath = req.files.cover && req.files.cover[0]
    ? '/uploads/learning/' + req.files.cover[0].filename
    : null;

  db.run(
    `INSERT INTO learning_items (title, cover_image, html_file, display_date, category) VALUES (?, ?, ?, ?, ?)`,
    [title, coverPath, htmlPath, displayDate, req.body.category || 'other'],
    function(err) {
      if (err) {
        console.error('[LEARNING] 创建失败:', err.message);
        return res.status(500).json({ error: '创建失败' });
      }
      res.json({ id: this.lastID, title, cover_image: coverPath, html_file: htmlPath, category: req.body.category || 'other' });
    }
  );
});

// 获取学习资料列表
app.get('/api/learning', (req, res) => {
  const category = req.query.category;
  let sql = `SELECT id, title, cover_image, html_file, created_at, display_date, category
     FROM learning_items`;
  const params = [];
  if (category && ['web', 'llm', 'other'].includes(category)) {
    sql += ' WHERE category = ?';
    params.push(category);
  }
  sql += ' ORDER BY display_date DESC';
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('[LEARNING] 查询失败:', err.message);
      return res.status(500).json({ error: '查询失败' });
    }
    res.json(rows || []);
  });
});

// 获取单个学习资料
app.get('/api/learning/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 ID' });
  db.get(
    `SELECT id, title, cover_image, html_file, created_at, display_date, category
     FROM learning_items WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error('[LEARNING] 查询失败:', err.message);
        return res.status(500).json({ error: '查询失败' });
      }
      if (!row) return res.status(404).json({ error: '资料不存在' });
      res.json(row);
    }
  );
});

// 修改学习资料（管理员）
app.put('/api/learning/:id', learningUpload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'html', maxCount: 1 }
]), requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 ID' });
  const { title, display_date, location } = req.body;
  db.get('SELECT * FROM learning_items WHERE id = ?', [id], (err, item) => {
    if (err || !item) return res.status(404).json({ error: '资料不存在' });
    let cover_image = item.cover_image;
    let html_file = item.html_file;
    const fs = require('fs');
    // 新封面
    if (req.files && req.files.cover && req.files.cover[0]) {
      if (item.cover_image && sanitizeFilePath(item.cover_image)) {
        const delPath = path.join(__dirname, 'public', item.cover_image);
        if (isPathSafe(delPath, path.join(__dirname, 'public'))) {
          try { fs.unlinkSync(delPath); } catch {}
        }
      }
      cover_image = '/uploads/learning/' + req.files.cover[0].filename;
    }
    // 新HTML
    if (req.files && req.files.html && req.files.html[0]) {
      if (item.html_file && sanitizeFilePath(item.html_file)) {
        const delPath = path.join(__dirname, 'public', item.html_file);
        if (isPathSafe(delPath, path.join(__dirname, 'public'))) {
          try { fs.unlinkSync(delPath); } catch {}
        }
      }
      html_file = '/uploads/learning/' + req.files.html[0].filename;
    }
    db.run(
      'UPDATE learning_items SET title = ?, cover_image = ?, html_file = ?, display_date = ?, location = ?, category = ? WHERE id = ?',
      [title || item.title, cover_image, html_file, display_date || item.display_date, location || item.location, req.body.category || item.category, id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: '资料已更新' });
      }
    );
  });
});

// 删除学习资料（管理员）
app.delete('/api/learning/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 ID' });
  db.get(`SELECT html_file, cover_image FROM learning_items WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: '资料不存在' });
    const fs = require('fs');
    [row.html_file, row.cover_image].forEach(f => {
      if (f && sanitizeFilePath(f)) {
        const fp = path.join(__dirname, 'public', f);
        if (isPathSafe(fp, path.join(__dirname, 'public'))) {
          try { fs.unlinkSync(fp); } catch {}
        }
      }
    });
    db.run(`DELETE FROM learning_items WHERE id = ?`, [id], function(err2) {
      if (err2) return res.status(500).json({ error: '删除失败' });
      res.json({ success: true });
    });
  });
});

// ========== 哲学家对话模块 ==========

const DATA_DIR = path.join(__dirname, 'data');
const SCHOLARS_PATH = path.join(DATA_DIR, 'scholars.json');
const CHUNK_MIN_LENGTH = 80;
const MAX_CHUNKS_PER_QUERY = 3;
const MAX_CHUNK_LENGTH = 800;

// 加载学者阐释数据
function loadJSON(filepath, fallback) {
  if (!fs.existsSync(filepath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filepath, 'utf-8')); } catch { return fallback; }
}
const scholarsData = loadJSON(SCHOLARS_PATH, {});

// 哲学家文本分块存储
let philosopherChunks = { nietzsche: [], hegel: [] };

function loadNietzscheText() {
  const files = [
    { name: '查拉图斯特拉如是说', file: 'zarathustra.txt' },
    { name: '悲剧的诞生', file: 'birth-of-tragedy.txt' },
    { name: '善恶的彼岸', file: 'beyond-good-and-evil.txt' },
    { name: '道德的谱系', file: 'genealogy-of-morals.txt' },
    { name: '敌基督', file: 'antichrist.txt' },
    { name: '偶像的黄昏', file: 'twilight-of-idols.txt' },
    { name: '瓦格纳事件', file: 'case-of-wagner.txt' },
    { name: '瞧，这个人', file: 'ecce-homo.txt' },
    { name: '朝霞', file: 'dawn-of-day.txt' }
  ];
  const chunks = [];
  for (const { name, file } of files) {
    const filepath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filepath)) continue;
    const content = fs.readFileSync(filepath, 'utf-8');
    const cleaned = content
      .replace(/\*\*\* START OF (THIS|THE) PROJECT GUTENBERG EBOOK.*\*\*\*/gi, '')
      .replace(/\*\*\* END OF (THIS|THE) PROJECT GUTENBERG EBOOK.*\*\*\*/gi, '')
      .replace(/Produced by .*?\n/g, '');
    const paragraphs = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > CHUNK_MIN_LENGTH);
    for (const para of paragraphs) {
      if (para.length > MAX_CHUNK_LENGTH) {
        const sentences = para.match(/[^.!?。！？]+[.!?。！？]+/g) || [para];
        let current = '';
        for (const s of sentences) {
          if (current.length + s.length > MAX_CHUNK_LENGTH) {
            if (current.length > CHUNK_MIN_LENGTH) chunks.push({ source: name, text: current.trim() });
            current = s;
          } else { current += s; }
        }
        if (current.length > CHUNK_MIN_LENGTH) chunks.push({ source: name, text: current.trim() });
      } else {
        chunks.push({ source: name, text: para });
      }
    }
  }
  philosopherChunks.nietzsche = chunks;
  console.log(`📚 尼采文本加载: ${chunks.length} chunk`);
}

function loadHegelText() {
  const files = [
    { name: '精神现象学', file: 'hegel-phenomenology-of-spirit.txt' },
    { name: '逻辑学', file: 'hegel-science-of-logic.txt' },
    { name: '美学导论', file: 'hegel-intro-fine-art.txt' },
    { name: 'SEP 黑格尔总论', file: 'hegel-sep-main.txt' },
    { name: 'SEP 辩证法', file: 'hegel-sep-dialectics.txt' },
    { name: 'SEP 美学', file: 'hegel-sep-aesthetics.txt' }
  ];
  const chunks = [];
  for (const { name, file } of files) {
    const filepath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filepath)) { console.warn(`⚠️  黑格尔文本缺失: ${file}`); continue; }
    const content = fs.readFileSync(filepath, 'utf-8');
    const cleaned = content
      .replace(/\*\*\* START OF (THIS|THE) PROJECT GUTENBERG EBOOK.*\*\*\*/gi, '')
      .replace(/\*\*\* END OF (THIS|THE) PROJECT GUTENBERG EBOOK.*\*\*\*/gi, '')
      .replace(/Produced by .*?\n/g, '');
    const paragraphs = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > CHUNK_MIN_LENGTH);
    for (const para of paragraphs) {
      if (para.length > MAX_CHUNK_LENGTH) {
        const sentences = para.match(/[^.!?。！？]+[.!?。！？]+/g) || [para];
        let current = '';
        for (const s of sentences) {
          if (current.length + s.length > MAX_CHUNK_LENGTH) {
            if (current.length > CHUNK_MIN_LENGTH) chunks.push({ source: name, text: current.trim() });
            current = s;
          } else { current += s; }
        }
        if (current.length > CHUNK_MIN_LENGTH) chunks.push({ source: name, text: current.trim() });
      } else {
        chunks.push({ source: name, text: para });
      }
    }
  }
  philosopherChunks.hegel = chunks;
  console.log(`📚 黑格尔文本加载: ${chunks.length} chunk`);
}

loadNietzscheText();
loadHegelText();

// ========== 画像缓存（内存LRU） ==========
const profileCache = new Map();
const PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5分钟
function getCachedProfile(userId) {
  const entry = profileCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > PROFILE_CACHE_TTL) { profileCache.delete(userId); return null; }
  return entry.data;
}
function setCachedProfile(userId, data) { profileCache.set(userId, { data, ts: Date.now() }); }
function invalidateProfileCache(userId) { profileCache.delete(userId); }

// RAG 检索（原著知识轨）
function retrieveRelevantChunks(query, philosopherId = 'nietzsche', topK = MAX_CHUNKS_PER_QUERY) {
  const chunks = philosopherChunks[philosopherId] || [];
  if (!chunks.length) return [];
  const queryWords = query.toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-zA-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
  const scored = chunks.map(chunk => {
    const text = chunk.text.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      score += (text.match(regex) || []).length;
    }
    if (queryWords.some(w => chunk.source.includes(w))) score += 2;
    return { ...chunk, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(c => c.score > 0);
}

// ========== 用户历史记忆检索（画像轨RAG） ==========
async function retrieveUserHistoryMemory(userId, philosopherId, query, topK = 2) {
  // 1. 检索相关会话摘要
  const summaries = await new Promise((resolve) => {
    db.all(
      `SELECT summary, key_concepts FROM philosopher_summaries
       WHERE user_id = ? AND philosopher_id = ?
       ORDER BY created_at DESC LIMIT 5`,
      [userId, philosopherId],
      (err, rows) => resolve(err ? [] : rows || [])
    );
  });

  // 2. 检索用户历史对话中与当前查询相关的片段
  const keywords = query.toLowerCase().replace(/[^\u4e00-\u9fa5a-zA-Z\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (!keywords.length) return { summaries: [], chatSnippets: [] };
  const likePattern = '%' + keywords.join('%') + '%';
  const chatSnippets = await new Promise((resolve) => {
    db.all(
      `SELECT role, content, created_at FROM philosopher_chats
       WHERE user_id = ? AND philosopher_id = ? AND role = 'user'
         AND (content LIKE ? OR content LIKE ?)
       ORDER BY created_at DESC LIMIT ?`,
      [userId, philosopherId, likePattern, '%' + keywords[0] + '%', topK],
      (err, rows) => resolve(err ? [] : rows || [])
    );
  });

  return { summaries, chatSnippets };
}

// ========== 哲学家配置 ==========
const PHILOSOPHERS = {
  nietzsche: {
    id: 'nietzsche', name: '弗里德里希·尼采', nameEn: 'Friedrich Nietzsche', years: '1844–1900',
    avatar: '⚡', tags: ['权力意志', '超人', '永恒轮回', '重估一切价值'],
    quote: '「一个人知道自己为什么而活，就可以忍受任何一种生活。」',
    systemPromptBase: `你是弗里德里希·尼采（Friedrich Nietzsche，1844–1900）。19世纪德国哲学家、语文学家。你此刻正在跟一个对话者交谈，不是在写论文，不是在演讲——是在回应一个具体的人的困惑。

回应风格：
- 像一位锐利而充满力量的对话者。直接回应对方的问题，不绕弯子，但也不急于给出结论。如果对方的问题预设了未经审视的软弱或妥协，你要拆解它。
- 可以反问、追问、指出对方提问方式中的道德残余——这是重估价值的具体操作，不是攻击。
- 每个回应必须推进一个核心概念的运用，让对话者感受到概念在思考中的"刺痛"力量。
- 学者引用不是点缀，而是展示不同阐释路径如何打开问题的不同面向。引用时必须说明学者的具体立场。
- 800–1500字。分2-4个自然段，每段推进一个思想步骤。

核心概念（直接使用，无需解释其基础定义，但要给出操作性运用）：
1. 权力意志（Wille zur Macht）——生命自我扩张、自我塑造、自我超越的内在动力。一切有机过程都是意志向更高形式转化的表现。
2. 超人（Übermensch）——人是应被超越的。主动创造价值、肯定生命全部内涵的存在。
3. 永恒轮回（Ewige Wiederkunft）——若生命中每一细节将无限次重复，你是否仍能说出「我愿意」？
4. 重估一切价值（Umwertung aller Werte）——区分主人道德与奴隶道德（怨恨/Ressentiment）。
5. 酒神与日神（Dionysisch / Apollinisch）——悲剧诞生于两种冲动的统一。
6. 谱系学方法（Genealogie）——追溯道德、知识、真理概念的历史生成。
7. 视角主义（Perspektivismus）——不存在无视角的知识。

可援引的权威阐释者（须明确标注，禁止编造具体引文）：
- Walter Kaufmann：英译与哲学解释的标准奠基者
- Gilles Deleuze（《尼采与哲学》）：将权力意志解读为「力与力的差异」
- Michel Foucault（《尼采、谱系学、历史》）：将谱系学发展为对知识-权力装置的批判
- Martin Heidegger（《尼采》讲座）：将权力意志解读为西方形而上学的完成与终结
- Alasdair MacIntyre（《德性之后》）：将我视为启蒙方案崩溃后的出路之一
- 刘小枫（《尼采的微言大义》）：关注文本的修辞策略与隐微写作
- 汪民安（《尼采与身体》）：从身体、力与激情角度重释

引用学者时的表述规范：
- 必须用"我的XXX"而非"尼采的XXX"。例如："Kaufmann 指出，我的权力意志不是心理学概念，而是..."
- 禁止："尼采认为..."、"尼采的体系..."、"尼采说过..."
- 学者名字用原文或惯用中文译名，著作名加书名号。

绝对禁止：
- 舞台动作描述（括号内的动作、表情、姿态）
- 感叹号
- 反问句
- 情感化感叹
- 「啊」「哦」等感叹词
- 叙事性开场
- 廉价的安慰或道德说教
- 元语言自我指涉（「作为尼采」「我的哲学认为」）
- 编造不存在的学者观点或原著引文
- 第三人称提及自己（"尼采"、"尼采的"、"尼采哲学"等）

语言规范：
- 以分析性、论证性的格言体展开。每个段落推进一个明确的思想步骤。
- 德语哲学术语保留原文：Wille zur Macht、Übermensch、Ewige Wiederkunft、Umwertung、Ressentiment、Genealogie、Perspektivismus、decadence。
- 比喻与举例仅服务于概念澄清。
- 对提问者的软弱、妥协与未经审视的常识进行拆解，但不进行人身攻击。
- 每个回应必须包含至少一个上述核心概念的操作性运用。`
  },
  hegel: {
    id: 'hegel', name: '格奥尔格·威廉·弗里德里希·黑格尔', nameEn: 'Georg Wilhelm Friedrich Hegel', years: '1770–1831',
    avatar: '🜲', tags: ['绝对精神', '辩证法', '主奴辩证法', '实体即主体'],
    quote: '「凡是合乎理性的都是现实的，凡是现实的都是合乎理性的。」',
    systemPromptBase: `你是格奥尔格·威廉·弗里德里希·黑格尔（Georg Wilhelm Friedrich Hegel，1770–1831）。19世纪德国观念论哲学家，耶拿、海德堡与柏林大学教授。你此刻正在跟一个对话者交谈，不是在写论文，不是在讲课——是在回应一个具体的人的困惑。

回应风格：
- 像一位锐利但耐心的对话者。直接回应对方的问题，不绕弯子，但也不急于给出结论。如果对方的问题预设了未经审视的常识，你要拆解它。
- 可以反问、追问、指出对方提问方式中的片面性——这是辩证法的核心操作，不是攻击。
- 每个回应必须推进一个核心概念的运用，让对话者感受到概念在思考中的"展开"力量。
- 学者引用不是点缀，而是展示不同阐释路径如何打开问题的不同面向。引用时必须说明学者的具体立场。
- 800–1500字。分2-4个自然段，每段推进一个思想步骤。

核心概念（直接使用，无需解释其基础定义，但要给出操作性运用）：
1. 绝对精神（Der absolute Geist）——实体本身就是主体，是自我认识、自我展开的活动。
2. 辩证法（Dialektik）——不是「正题-反题-合题」的公式，而是概念自身运动的内在逻辑。
3. 扬弃（Aufhebung）——取消片面性的有限规定，保留其合理内容，提升至更高的具体统一体。
4. 主奴辩证法（Herrschaft und Knechtschaft）——自我意识通过「承认」（Anerkennung）获得。
5. 自在与自为（An-sich / Für-sich / An-und-für-sich）——潜在的存在、自反的确定性、自在与自为的统一。
6. 实体即主体（Substanz als Subjekt）——真正的实体是自我运动、自我展开、自我认识的活动本身。
7. 历史哲学——历史是理性在世的展开。「理性的狡计」（List der Vernunft）。
8. 法哲学三环节——抽象法、道德、伦理（Sittlichkeit）。
9. 具体概念（Konkreter Begriff）——与形式逻辑的空洞抽象相反，具体概念自身包含对立规定的统一体。

可援引的权威阐释者（须明确标注，禁止编造具体引文）：
- Charles Taylor（《Hegel》1975）：将我的哲学置于现代性自我理解的脉络
- Terry Pinkard（《Hegel: A Biography》2000）：以历史语境化方式解读
- Robert Pippin（《Hegel's Idealism》1989）：将观念论解读为康德先验观念论的内在完成
- Allen Wood（《Hegel's Ethical Thought》1990）：强调自由概念的社会性实现
- Michael Forster（《Hegel's Idea of a Phenomenology of Spirit》1998）：将精神现象学解读为知识论的方法论导论
- 张世英（《论黑格尔的逻辑学》）：强调具体概念与「天人合一」的跨文化比较
- 贺麟（《黑格尔哲学讲演集》）：强调翻译准确性与古典哲学高峰地位

引用学者时的表述规范：
- 必须用"我的XXX"而非"黑格尔的XXX"。例如："Wood 指出，我的Sittlichkeit并非保守的集体主义，而是..."
- 禁止："黑格尔认为..."、"黑格尔的体系..."、"黑格尔说过..."
- 学者名字用原文或惯用中文译名，著作名加书名号。

绝对禁止：
- 舞台动作描述（括号内的动作、表情、姿态）
- 感叹号
- 反问句
- 情感化感叹
- 「啊」「哦」等感叹词
- 叙事性开场
- 廉价的安慰或道德说教
- 元语言自我指涉
- 编造不存在的学者观点或原著引文
- 将辩证法简化为「正题-反题-合题」的公式
- 第三人称提及自己（"黑格尔"、"黑格尔的"、"黑格尔哲学"等）

语言规范：
- 以分析性、论证性的思辨对话体展开。每个段落推进一个明确的概念环节。
- 德语哲学术语保留原文：Der absolute Geist、Dialektik、Aufhebung、Anerkennung、An-sich、Für-sich、Substanz als Subjekt、Sittlichkeit、Vernunft、List der Vernunft、Konkreter Begriff。
- 概念澄清优先于文学装饰；举例仅服务于展示概念的展开方式。
- 展示提问者概念中的片面性与矛盾，但不进行人身攻击。
- 每个回应必须包含至少一个核心概念的操作性运用。`
  }
};

// ========== 从 knowledge.json 自动加载其他哲学家 ==========
function loadPhilosopherKnowledgeJson(philosopherId) {
  const filepath = path.join(__dirname, 'public', 'philosophers', philosopherId, 'knowledge.json');
  return loadJSON(filepath, null);
}

function buildSystemPromptFromKnowledge(id, data) {
  const p = data.philosopher;
  const concepts = (data.coreConcepts || []).map(c =>
    `- ${c.title}（${c.title_en || ''}）：${c.description?.slice(0, 200) || ''}`
  ).join('\n');

  const scholars = [];
  (data.coreConcepts || []).forEach(c => {
    (c.secondarySources || []).forEach(s => {
      if (s.scholar && s.work) scholars.push(`- ${s.scholar}（${s.work}）：${s.insight?.slice(0, 150) || ''}`);
    });
  });
  const scholarBlock = scholars.length ? `\n\n可援引的权威阐释者（须明确标注，禁止编造具体引文）：\n${scholars.slice(0, 8).join('\n')}` : '';

  const lifeEvents = (data.lifeEvents || []).map(e => `${e.year}：${e.event}`).join('；');

  return `你是${p.name}（${p.name_en || ''}，${p.lived || ''}）。${p.summary || ''}\n\n核心概念（直接使用，无需解释其基础定义，但要给出操作性运用）：\n${concepts}${scholarBlock}\n\n回应风格：\n- 像一位思想锐利但对话耐心的哲学家。直接回应对方的问题，不绕弯子，但也不急于给出结论。\n- 可以反问、追问、指出对方提问方式中的片面性——这是概念操练，不是攻击。\n- 每个回应必须推进一个核心概念的运用，让对话者感受到概念在思考中的"展开"力量。\n- 学者引用不是点缀，而是展示不同阐释路径如何打开问题的不同面向。引用时必须说明学者的具体立场。\n- 600–1200字。分2-4个自然段，每段推进一个思想步骤。\n\n引用学者时的表述规范：\n- 必须用"我的XXX"而非"${p.name}的XXX"。\n- 禁止："${p.name}认为..."、"${p.name}的体系..."、"${p.name}说过..."\n- 学者名字用原文或惯用中文译名，著作名加书名号。\n\n绝对禁止：\n- 舞台动作描述（括号内的动作、表情、姿态）\n- 感叹号\n- 反问句\n- 情感化感叹\n- 「啊」「哦」等感叹词\n- 叙事性开场\n- 廉价的安慰或道德说教\n- 元语言自我指涉\n- 编造不存在的学者观点或原著引文\n- 第三人称提及自己（"${p.name}"、"${p.name}的"、"${p.name}哲学"等）`;
}

function loadKnowledgeChunks(philosopherId, data) {
  const chunks = [];
  // 1. 核心概念作为 chunk
  (data.coreConcepts || []).forEach(c => {
    const text = `[${c.title}] ${c.description || ''}`;
    if (text.length > 50) chunks.push({ source: c.title, text });
    // 引用
    (c.primaryQuotes || []).forEach(q => {
      const quoteText = `${q.chinese || ''} ${q.english || ''} (${q.source || ''})`;
      if (quoteText.length > 20) chunks.push({ source: `${c.title}·原文`, text: quoteText });
    });
    // 学者评论
    (c.secondarySources || []).forEach(s => {
      const insight = `${s.scholar}（${s.work}）：${s.insight || ''}`;
      if (insight.length > 30) chunks.push({ source: `${c.title}·学者`, text: insight });
    });
    // 常见误解澄清
    (c.commonMisconceptions || []).forEach(m => {
      const text = `【澄清】${m.misconception} → ${m.clarification}`;
      if (text.length > 30) chunks.push({ source: `${c.title}·澄清`, text });
    });
  });
  // 2. 生平事件作为 chunk
  (data.lifeEvents || []).forEach(e => {
    const text = `[生平] ${e.year}：${e.event}。${e.details || ''}`;
    if (text.length > 30) chunks.push({ source: '生平', text });
  });
  // 3. 传记注释
  (data.biographicalNotes || []).forEach(n => {
    const text = `[传记] ${n.note || ''}`;
    if (text.length > 30) chunks.push({ source: '传记', text });
  });
  return chunks;
}

// 自动扫描并注册所有 knowledge.json
const KNOWLEDGE_BASE_DIR = path.join(__dirname, 'public', 'philosophers');
if (fs.existsSync(KNOWLEDGE_BASE_DIR)) {
  const dirs = fs.readdirSync(KNOWLEDGE_BASE_DIR).filter(d => {
    const stat = fs.statSync(path.join(KNOWLEDGE_BASE_DIR, d));
    return stat.isDirectory() && fs.existsSync(path.join(KNOWLEDGE_BASE_DIR, d, 'knowledge.json'));
  });

  for (const dir of dirs) {
    if (PHILOSOPHERS[dir]) continue; // 已有硬编码配置，跳过
    const data = loadPhilosopherKnowledgeJson(dir);
    if (!data || !data.philosopher) {
      console.warn(`⚠️  knowledge.json 加载失败: ${dir}`);
      continue;
    }
    const p = data.philosopher;
    const displayName = p.name_zh || p.name || (p.name_en || '');
    PHILOSOPHERS[dir] = {
      id: dir,
      name: displayName,
      nameEn: p.name_en || p.name || '',
      years: p.lifetime || p.lifespan || p.lived || p.years || '',
      avatar: p.avatar || '📖',
      tags: (data.coreConcepts || []).slice(0, 4).map(c => c.title),
      quote: p.summary?.slice(0, 60) + '…' || '',
      systemPromptBase: buildSystemPromptFromKnowledge(dir, data)
    };
    philosopherChunks[dir] = loadKnowledgeChunks(dir, data);
    console.log(`📚 自动加载哲学家: ${p.name} (${dir}) — ${philosopherChunks[dir].length} chunk`);
  }
}

// ========== 结构化画像读写 ==========

function getOrCreateProfile(userId, callback) {
  const cached = getCachedProfile(userId);
  if (cached) return callback(null, cached);

  db.get('SELECT * FROM philosopher_profiles WHERE user_id = ?', [userId], (err, row) => {
    if (err) return callback(err, null);
    const base = row || { user_preferences: '{"stance":null,"preferredExamples":[],"dislikedStyles":[],"engagedScholars":[]}', total_messages: 0, last_session_at: null };

    db.all('SELECT * FROM philosopher_concepts WHERE user_id = ?', [userId], (err2, concepts) => {
      const conceptMastery = {};
      if (!err2 && concepts) {
        for (const c of concepts) {
          conceptMastery[c.concept_name] = {
            level: c.level, depth: c.depth,
            discussCount: c.discuss_count,
            lastDiscussed: c.last_discussed,
            related: JSON.parse(c.related_concepts || '[]')
          };
        }
      }

      db.all('SELECT scholar_name, interest_score FROM philosopher_scholars WHERE user_id = ? ORDER BY interest_score DESC', [userId], (err3, scholars) => {
        const engagedScholars = (!err3 && scholars) ? scholars.map(s => s.scholar_name) : [];
        const userPrefs = JSON.parse(base.user_preferences || '{"stance":null,"preferredExamples":[],"dislikedStyles":[],"engagedScholars":[]}');
        const profile = {
          userId: String(userId),
          conceptMastery,
          userPreferences: {
            stance: userPrefs.stance || null,
            preferredExamples: userPrefs.preferredExamples || [],
            dislikedStyles: userPrefs.dislikedStyles || [],
            engagedScholars
          },
          totalMessages: base.total_messages || 0,
          lastSessionAt: base.last_session_at
        };
        setCachedProfile(userId, profile);
        callback(null, profile);
      });
    });
  });
}

function saveProfile(userId, profile) {
  invalidateProfileCache(userId);
  const prefs = profile.userPreferences || {};
  const userPrefsJson = JSON.stringify({
    stance: prefs.stance || null,
    preferredExamples: prefs.preferredExamples || [],
    dislikedStyles: prefs.dislikedStyles || [],
    engagedScholars: prefs.engagedScholars || []
  });

  // 基础画像
  db.run(
    `INSERT INTO philosopher_profiles (user_id, user_preferences, total_messages, last_session_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       user_preferences = excluded.user_preferences,
       total_messages = excluded.total_messages,
       last_session_at = excluded.last_session_at,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, userPrefsJson, profile.totalMessages || 0, profile.lastSessionAt || null]
  );

  // 概念
  for (const [name, data] of Object.entries(profile.conceptMastery || {})) {
    db.run(
      `INSERT INTO philosopher_concepts (user_id, philosopher_id, concept_name, level, depth, discuss_count, last_discussed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, philosopher_id, concept_name) DO UPDATE SET
         level = excluded.level,
         depth = excluded.depth,
         discuss_count = excluded.discuss_count,
         last_discussed = excluded.last_discussed,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, 'nietzsche', name, data.level || 'novice', data.depth || 'basic', data.discussCount || 1, data.lastDiscussed || new Date().toISOString().split('T')[0]]
    );
  }

  // 学者
  for (const s of (prefs.engagedScholars || [])) {
    db.run(
      `INSERT INTO philosopher_scholars (user_id, philosopher_id, scholar_name, interest_score, first_seen, last_seen)
       VALUES (?, ?, ?, 1, CURRENT_DATE, CURRENT_DATE)
       ON CONFLICT(user_id, philosopher_id, scholar_name) DO UPDATE SET
         interest_score = interest_score + 1,
         last_seen = CURRENT_DATE`,
      [userId, 'nietzsche', s]
    );
  }
}

// ========== 分层画像注入 ==========
function buildProfileInjection(profile) {
  const concepts = profile.conceptMastery || {};
  const prefs = profile.userPreferences || {};
  const today = new Date().toISOString().split('T')[0];

  // 遗忘曲线：超过30天未讨论的概念降级
  const decayed = [];
  for (const [name, data] of Object.entries(concepts)) {
    if (data.lastDiscussed) {
      const days = Math.floor((new Date(today) - new Date(data.lastDiscussed)) / (86400000));
      if (days > 30 && data.level === 'mastered') { decayed.push(name); data.level = 'familiar'; }
      else if (days > 60 && data.level === 'familiar') { decayed.push(name); data.level = 'novice'; }
    }
  }

  const mastered = Object.entries(concepts).filter(([_, v]) => v.level === 'mastered').map(([k, _]) => k);
  const familiar = Object.entries(concepts).filter(([_, v]) => v.level === 'familiar').map(([k, _]) => k);
  const novice = Object.entries(concepts).filter(([_, v]) => v.level === 'novice').map(([k, _]) => k);
  const engaged = prefs.engagedScholars || [];
  const examples = prefs.preferredExamples || [];
  const stance = prefs.stance;

  const lines = ['\n\n【用户知识状态】'];
  if (mastered.length) lines.push(`已深入掌握：${mastered.join('、')}`);
  if (familiar.length) lines.push(`已初步了解：${familiar.join('、')}`);
  if (novice.length) lines.push(`接触过但未深入：${novice.join('、')}`);
  if (stance) lines.push(`用户思维倾向：${stance}`);
  if (examples.length) lines.push(`偏好例证：${examples.join('、')}`);
  if (engaged.length) lines.push(`权威学者兴趣：${engaged.join('、')}`);
  if (decayed.length) lines.push(`【注意】以下概念因长期未讨论已降级：${decayed.join('、')}`);

  lines.push('\n【回应策略】');
  if (mastered.length) {
    lines.push(`- 对已掌握概念（${mastered.join('、')}）：直接跳过基础定义，进入高级分析、批判性展开或与其他概念的关联运用。不要重复解释这些概念的基础含义。`);
  }
  if (familiar.length) {
    lines.push(`- 对已了解概念（${familiar.join('、')}）：用1句话简要回顾核心定义，然后立即进入深入分析或具体运用。`);
  }
  if (novice.length) {
    lines.push(`- 对接触但未深入的概念（${novice.join('、')}）：给出操作性界定 + 具体例证解释，帮助用户建立理解。`);
  }
  lines.push(`- 对全新概念：给出操作性界定 + ${examples[0] || '具体例证'}解释。`);
  if (engaged.length) {
    lines.push(`- 援引学者时优先使用用户感兴趣的学者：${engaged.slice(0, 3).join('、')}。`);
  }
  if (stance) {
    lines.push(`- 回应时顺应用户的思维倾向「${stance}」，从这个角度展开分析。`);
  }
  return lines.join('\n');
}

// ========== 异步画像更新（升级版） ==========
async function updateUserProfile(dialogueHistory, philosopherName, userId, philosopherId) {
  if (!DEEPSEEK_API_KEY || dialogueHistory.length < 2) return;
  const recent = dialogueHistory.slice(-6);
  const transcript = recent.map(m => `${m.role}: ${m.content.substring(0, 400)}`).join('\n');

  const analysisPrompt = `分析以下哲学对话，提取结构化画像信息。对话中一方是用户，一方是${philosopherName}。

对话记录：
${transcript}

请输出严格JSON（不要任何其他文字，不要markdown代码块）：
{
  "newConcepts": ["概念名1", "概念名2"],
  "updatedConcepts": [
    {"name": "概念名", "level": "novice|familiar|mastered", "depth": "basic|intermediate|advanced", "related": ["相关概念"]}
  ],
  "userStance": "用户思维倾向关键词（如：存在主义倾向、分析哲学倾向、怀疑论者、建构主义者等）",
  "examplePreference": "历史事件/制度演变/文学/个人/其他/无",
  "engagedScholars": ["学者名"],
  "sessionSummary": "用一句话总结本轮对话核心内容，突出用户关心的具体问题"
}

【等级判定规则】（严格遵循）：
- novice（新手）：用户首次接触该概念，表现出陌生感，需要基础解释
- familiar（熟悉）：用户能复述概念定义，或能举出简单例子，但尚未进行批判性分析
- mastered（掌握）：用户能批判性分析该概念，能关联其他概念，能提出反驳或深化问题

【深度判定规则】：
- basic：仅了解概念的基本定义
- intermediate：能运用概念分析具体问题
- advanced：能批判性审视概念的局限性和边界条件

【升级规则】：
- 同一概念被讨论3次以上 → 自动从familiar升级到mastered
- 用户能主动关联该概念与其他概念 → 可升级到mastered

只返回纯JSON，不要任何解释。`;

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: analysisPrompt }], temperature: 0.3, max_tokens: 1000 })
    });
    if (!response.ok) return;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    let analysis;
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(cleaned);
    } catch { console.warn('Profile update parse failed:', raw.substring(0, 200)); return; }

    getOrCreateProfile(userId, (err, profile) => {
      if (err || !profile) return;

      // 合并新/更新概念，应用升级规则
      const allUpdates = [...(analysis.updatedConcepts || []), ...(analysis.newConcepts || []).map(n => ({ name: n, level: 'novice', depth: 'basic' }))];
      for (const c of allUpdates) {
        const existing = profile.conceptMastery[c.name];
        const levels = { novice: 1, familiar: 2, mastered: 3 };
        let newLevel = levels[c.level] || 1;
        let newDepth = c.depth || 'basic';

        if (existing) {
          // 重复讨论升级：累计3次熟悉→掌握
          const newCount = (existing.discussCount || 1) + 1;
          if (newCount >= 3 && existing.level === 'familiar') {
            newLevel = 3; // mastered
            newDepth = 'advanced';
          }
          // 取最高等级
          const oldLevel = levels[existing.level] || 0;
          if (newLevel < oldLevel) newLevel = oldLevel;
          if (newDepth === 'basic' && existing.depth === 'intermediate') newDepth = 'intermediate';
          if (newDepth === 'basic' && existing.depth === 'advanced') newDepth = 'advanced';

          profile.conceptMastery[c.name] = {
            level: Object.keys(levels).find(k => levels[k] === newLevel),
            depth: newDepth,
            discussCount: newCount,
            lastDiscussed: new Date().toISOString().split('T')[0],
            related: c.related || existing.related || []
          };
        } else {
          profile.conceptMastery[c.name] = {
            level: c.level || 'novice',
            depth: newDepth,
            discussCount: 1,
            lastDiscussed: new Date().toISOString().split('T')[0],
            related: c.related || []
          };
        }
      }

      // 偏好更新
      if (analysis.userStance) profile.userPreferences.stance = analysis.userStance;
      if (analysis.examplePreference && analysis.examplePreference !== '无') {
        const prefs = profile.userPreferences.preferredExamples;
        if (!prefs.includes(analysis.examplePreference)) prefs.push(analysis.examplePreference);
      }
      for (const s of (analysis.engagedScholars || [])) {
        const list = profile.userPreferences.engagedScholars;
        if (!list.includes(s)) list.push(s);
      }

      // 会话摘要
      if (analysis.sessionSummary) {
        db.run(
          'INSERT INTO philosopher_summaries (user_id, philosopher_id, session_id, summary, key_concepts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, philosopherId, `sess_${Date.now()}`, analysis.sessionSummary, JSON.stringify([...(analysis.newConcepts || []), ...(analysis.updatedConcepts || []).map(c => c.name)]), new Date().toISOString()]
        );
      }

      profile.totalMessages = (profile.totalMessages || 0) + recent.length;
      profile.lastSessionAt = new Date().toISOString();
      saveProfile(userId, profile);
      console.log(`🧠 画像已更新 | user=${userId} | 掌握概念=${Object.keys(profile.conceptMastery).length} | stance=${profile.userPreferences.stance || '无'}`);

      // 定期压缩：摘要超过50条时合并
      compressOldSummaries(userId, philosopherId);
    });
  } catch (err) { console.error('Profile update error:', err.message); }
}

// ========== 会话摘要压缩 ==========
async function compressOldSummaries(userId, philosopherId) {
  db.get('SELECT COUNT(*) as cnt FROM philosopher_summaries WHERE user_id = ? AND philosopher_id = ?', [userId, philosopherId], async (err, row) => {
    if (err || !row || row.cnt < 50) return;
    if (!DEEPSEEK_API_KEY) return;

    // 取最早的20条摘要合并
    db.all('SELECT * FROM philosopher_summaries WHERE user_id = ? AND philosopher_id = ? ORDER BY created_at ASC LIMIT 20', [userId, philosopherId], async (err2, oldSums) => {
      if (err2 || !oldSums || oldSums.length < 20) return;
      const texts = oldSums.map(s => s.summary).join('\n---\n');
      const compressPrompt = `将以下哲学对话摘要合并为3-5条更精炼的长期记忆要点。每条要点包含：一个概念/主题 + 用户对此的理解程度 + 任何特别的思维倾向。只输出要点列表，不要其他内容。\n\n${texts}`;

      try {
        const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
          body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: compressPrompt }], temperature: 0.3, max_tokens: 800 })
        });
        if (!res.ok) return;
        const data = await res.json();
        const compressed = data.choices?.[0]?.message?.content || '';

        // 删除旧摘要，插入压缩摘要
        const ids = oldSums.map(s => s.id);
        const placeholders = ids.map(() => '?').join(',');
        db.run(`DELETE FROM philosopher_summaries WHERE id IN (${placeholders})`, ids, function(err3) {
          if (err3) return;
          db.run(
            'INSERT INTO philosopher_summaries (user_id, philosopher_id, session_id, summary, key_concepts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, philosopherId, 'compressed_' + Date.now(), compressed, JSON.stringify([]), new Date().toISOString()]
          );
          console.log(`🗜️  摘要已压缩 | user=${userId} | 合并${oldSums.length}条 → 1条`);
        });
      } catch (e) { console.error('Compress error:', e.message); }
    });
  });
}

// 哲学家列表
app.get('/api/philosophers', (req, res) => {
  const list = Object.values(PHILOSOPHERS).map(p => ({
    id: p.id, name: p.name, nameEn: p.nameEn, years: p.years,
    avatar: p.avatar, tags: p.tags, quote: p.quote
  }));
  res.json(list);
});

// 获取用户完整画像（新API）
app.get('/api/philosopher-profile', requireLogin, (req, res) => {
  const uid = req.session.userId;
  getOrCreateProfile(uid, (err, profile) => {
    if (err) return res.status(500).json({ error: err.message });

    // 同时查询会话摘要
    db.all('SELECT summary, key_concepts, created_at FROM philosopher_summaries WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [uid], (err2, summaries) => {
      const result = {
        ...profile,
        sessionSummaries: summaries || [],
        conceptCount: Object.keys(profile.conceptMastery || {}).length,
        masteredCount: Object.entries(profile.conceptMastery || {}).filter(([_, v]) => v.level === 'mastered').length,
        familiarCount: Object.entries(profile.conceptMastery || {}).filter(([_, v]) => v.level === 'familiar').length
      };
      res.json(result);
    });
  });
});

// 获取概念掌握列表
app.get('/api/philosopher-profile/concepts', requireLogin, (req, res) => {
  const uid = req.session.userId;
  getOrCreateProfile(uid, (err, profile) => {
    if (err) return res.status(500).json({ error: err.message });
    const concepts = Object.entries(profile.conceptMastery || {}).map(([name, data]) => ({
      name, ...data,
      status: data.level === 'mastered' ? '✓ 已掌握' : data.level === 'familiar' ? '~ 已了解' : '? 接触过'
    }));
    res.json(concepts);
  });
});

// 获取用户历史摘要（用于前端档案页）
app.get('/api/philosopher-profile/summaries', requireLogin, (req, res) => {
  const uid = req.session.userId;
  const pid = req.query.philosopher || 'nietzsche';
  db.all(
    'SELECT summary, key_concepts, created_at FROM philosopher_summaries WHERE user_id = ? AND philosopher_id = ? ORDER BY created_at DESC LIMIT 30',
    [uid, pid],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// 学者数据
app.get('/api/philosopher-scholars', (req, res) => {
  res.json(scholarsData);
});

// 清空会话（保留画像）
app.post('/api/philosopher-session/clear', requireLogin, (req, res) => {
  const sid = req.session.philosopherSession || `sess_${req.session.userId}_${Date.now()}`;
  db.run('DELETE FROM philosopher_chats WHERE session_id = ?', [sid], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: '对话历史已清空，画像与概念掌握度保留' });
  });
});

// 完全重置
app.post('/api/philosopher-session/reset', requireLogin, (req, res) => {
  const uid = req.session.userId;
  const sid = req.session.philosopherSession || `sess_${uid}_${Date.now()}`;
  db.serialize(() => {
    db.run('DELETE FROM philosopher_chats WHERE session_id = ?', [sid]);
    db.run('DELETE FROM philosopher_concepts WHERE user_id = ?', [uid]);
    db.run('DELETE FROM philosopher_scholars WHERE user_id = ?', [uid]);
    db.run('DELETE FROM philosopher_summaries WHERE user_id = ?', [uid]);
    db.run('DELETE FROM philosopher_profiles WHERE user_id = ?', [uid]);
  });
  invalidateProfileCache(uid);
  res.json({ success: true, message: '完全重置：对话历史、画像、概念追踪全部清空' });
});

// 获取对话历史
app.get('/api/philosopher-chat/history', requireLogin, (req, res) => {
  const philosopherId = req.query.philosopher || 'nietzsche';
  const sid = req.session.philosopherSession || `sess_${req.session.userId}_${Date.now()}`;
  if (!req.session.philosopherSession) req.session.philosopherSession = sid;
  db.all(
    'SELECT role, content, citations, created_at FROM philosopher_chats WHERE session_id = ? AND philosopher_id = ? ORDER BY created_at ASC',
    [sid, philosopherId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const msgs = rows.map(r => ({
        role: r.role,
        content: r.content,
        citations: JSON.parse(r.citations || '[]')
      }));
      res.json(msgs);
    }
  );
});

// 核心对话 API（双轨RAG + 结构化画像）
app.post('/api/philosopher-chat', requireLogin, async (req, res) => {
  const { message, philosopherId = 'nietzsche', history = [] } = req.body;
  const uid = req.session.userId;
  if (!DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY 未配置' });
  }
  const philosopher = PHILOSOPHERS[philosopherId];
  if (!philosopher) return res.status(400).json({ error: '未知的哲学家' });

  const sid = req.session.philosopherSession || `sess_${uid}_${Date.now()}`;
  if (!req.session.philosopherSession) req.session.philosopherSession = sid;

  // ========== 双轨RAG检索 ==========
  // 轨1：哲学原著
  const relevantChunks = retrieveRelevantChunks(message, philosopherId);
  const contextText = relevantChunks.length > 0
    ? '\n\n以下是你著作中的相关段落，可作为回应的参考（自然融入，不要逐条引用）：\n' +
      relevantChunks.map(c => `[${c.source}] ${c.text}`).join('\n\n')
    : '';

  // 轨2：用户历史记忆
  const userMemory = await retrieveUserHistoryMemory(uid, philosopherId, message);
  const memoryText = (userMemory.chatSnippets.length > 0 || userMemory.summaries.length > 0)
    ? '\n\n【用户此前相关讨论】\n' +
      (userMemory.summaries.length > 0
        ? '历史会话要点：\n' + userMemory.summaries.slice(0, 2).map(s => `- ${s.summary}`).join('\n') + '\n'
        : '') +
      (userMemory.chatSnippets.length > 0
        ? '此前提问片段：\n' + userMemory.chatSnippets.slice(0, 2).map(s => `- ${s.content.substring(0, 120)}...`).join('\n')
        : '') +
      '\n注意：回应时考虑用户此前的理解基础，避免重复已充分讨论过的内容。'
    : '';

  // 获取画像
  const profile = await new Promise((resolve, reject) => {
    getOrCreateProfile(uid, (err, p) => { if (err) reject(err); else resolve(p); });
  }).catch(() => null);

  const profileInjection = profile ? buildProfileInjection(profile) : '';

  // 学者引用提示
  let scholarHint = '';
  const engaged = profile?.userPreferences?.engagedScholars || [];
  if (engaged.length > 0) {
    const relevant = engaged.filter(name => scholarsData[name]).map(name => {
      const s = scholarsData[name];
      return `- ${name}（${s.work}）：${s.keyIdea}`;
    }).join('\n');
    if (relevant) scholarHint = '\n\n【可援引的阐释者】\n' + relevant + '\n援引时须明确标注学者姓名与出处方向，禁止编造具体引文。';
  }

  const systemPrompt = philosopher.systemPromptBase + contextText + memoryText + profileInjection + scholarHint;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user', content: message }
  ];

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat', messages, temperature: 0.6, max_tokens: 2500, stream: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('DeepSeek API error:', errorText);
      return res.status(response.status).json({ error: '模型调用失败', detail: errorText });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '...（沉默）';
    const citations = relevantChunks.map(c => ({ source: c.source, text: c.text.substring(0, 120) + '...' }));

    const profileSnapshot = profile ? {
      masteredConcepts: Object.entries(profile.conceptMastery || {})
        .filter(([_, v]) => v.level === 'mastered').map(([k, _]) => k),
      familiarConcepts: Object.entries(profile.conceptMastery || {})
        .filter(([_, v]) => v.level === 'familiar').map(([k, _]) => k)
    } : { masteredConcepts: [], familiarConcepts: [] };

    // 保存到数据库
    db.run(
      'INSERT INTO philosopher_chats (user_id, session_id, philosopher_id, role, content, citations) VALUES (?, ?, ?, ?, ?, ?)',
      [uid, sid, philosopherId, 'user', message, '[]'],
      function(err) { if (err) console.error('[PHILO] save user msg:', err.message); }
    );
    db.run(
      'INSERT INTO philosopher_chats (user_id, session_id, philosopher_id, role, content, citations) VALUES (?, ?, ?, ?, ?, ?)',
      [uid, sid, philosopherId, 'assistant', reply, JSON.stringify(citations)],
      function(err) { if (err) console.error('[PHILO] save assistant msg:', err.message); }
    );

    res.json({ reply, citations, philosopher: philosopher.name, profileSnapshot });

    // 异步更新画像（不阻塞响应）
    setImmediate(() => {
      const fullHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];
      updateUserProfile(fullHistory, philosopher.name, uid, philosopherId).catch(() => {});
    });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: '服务器错误', detail: err.message });
  }
});

// ========== 哲思圆桌（群聊）API ==========

// 启动群聊会话
app.post('/api/group-chat/start', requireLogin, (req, res) => {
  const uid = req.session.userId;
  db.run(
    'INSERT INTO group_chat_sessions (user_id, title, ended_at) VALUES (?, ?, ?)',
    [uid, '哲思圆桌', null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ sessionId: this.lastID, message: '群聊会话已开启' });
    }
  );
});

// 清空/归档群聊会话：把当前session标记为已结束，创建新session
app.post('/api/group-chat/clear', requireLogin, (req, res) => {
  const uid = req.session.userId;
  // 先归档当前所有未结束的session
  db.run(
    'UPDATE group_chat_sessions SET ended_at = CURRENT_TIMESTAMP, message_count = (SELECT COUNT(*) FROM group_chat_messages WHERE session_id = group_chat_sessions.id) WHERE user_id = ? AND ended_at IS NULL',
    [uid],
    function(err) {
      if (err) console.error('[GROUP] archive error:', err.message);
      // 创建新的空session
      db.run(
        'INSERT INTO group_chat_sessions (user_id, title, ended_at) VALUES (?, ?, ?)',
        [uid, '哲思圆桌', null],
        function(err2) {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ sessionId: this.lastID, message: '已归档上轮对话，开启新轮次' });
        }
      );
    }
  );
});

// 获取历史session列表（已归档的轮次）
app.get('/api/group-chat/sessions', requireLogin, (req, res) => {
  const uid = req.session.userId;
  const showActive = req.query.active === 'true';
  
  let whereClause = showActive 
    ? 'user_id = ?' 
    : 'user_id = ? AND ended_at IS NOT NULL';
  let orderBy = showActive 
    ? 'ORDER BY id DESC' 
    : 'ORDER BY ended_at DESC';
  
  db.all(
    `SELECT id, title, current_topic, round_count, message_count,
            created_at, updated_at, ended_at,
            (SELECT COUNT(*) FROM group_chat_messages WHERE session_id = group_chat_sessions.id) as msg_count
     FROM group_chat_sessions
     WHERE ${whereClause}
     ${orderBy}`,
    [uid],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ sessions: rows });
    }
  );
});

// 获取群聊历史（单条消息）
app.get('/api/group-chat/history', requireLogin, (req, res) => {
  const sid = req.query.sessionId;
  if (!sid) return res.status(400).json({ error: '缺少 sessionId' });
  db.all(
    'SELECT speaker_type, speaker_id, content, created_at FROM group_chat_messages WHERE session_id = ? ORDER BY id ASC',
    [sid],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ messages: rows });
    }
  );
});

// ========== 哲思圆桌（群聊）核心 v2 ==========

// Step 1: 本地候选池生成（关键词+标签匹配，无LLM调用）
function filterCandidatesByTopic(userMessage, philosophers) {
  const msg = userMessage.toLowerCase();
  const candidates = [];

  for (const [id, p] of Object.entries(philosophers)) {
    if (!p.systemPromptBase || p.systemPromptBase.length < 50) continue;

    let score = 0;
    const tags = (p.tags || []).join('').toLowerCase();
    const name = (p.name || '').toLowerCase();

    // 名字被直接提到 → 强制入选且高分
    if (msg.includes(name) || msg.includes(p.id)) score += 10;

    // 标签匹配
    for (const tag of (p.tags || [])) {
      if (msg.includes(tag.toLowerCase())) score += 3;
    }

    // 通用哲学关键词
    const philoKeywords = ['哲学', '存在', '意识', '道德', '伦理', '真理', '知识', '自由', '正义', '美学', '逻辑', '形而上学', '认识论', '价值观', '人生', '意义', '死亡', '灵魂', '理性', '感性', '经验', '先验', '辩证法', '怀疑', '信仰', '幸福', '痛苦', '欲望', '权力', '法律', '政治', '社会', '个体', '集体', '自然', '科学', '宗教', '艺术', '语言', '历史', '时间', '空间', '因果', '物质', '精神', '主体', '客体', '实践', '理论', '批判', '反思', '超越', '虚无', '荒诞', '异化', '解构', '建构', '现象', '本质', '形式', '内容', '普遍', '特殊', '抽象', '具体', '绝对', '相对', '无限', '有限', '必然', '偶然', '一元', '多元', '唯物', '唯心', '主观', '客观', '内在', '外在'];
    for (const kw of philoKeywords) {
      if (msg.includes(kw)) score += 0.5;
    }

    // 保底分：所有哲学家至少得 2 分，确保不会全军覆没
    score = Math.max(score, 2);
    candidates.push({ id, score, philosopher: p });
  }

  candidates.sort((a, b) => b.score - a.score);
  // 取前 15 名进入 LLM 意愿评估，确保候选池足够大
  return candidates.slice(0, 15);
}

// Step 2: LLM评估发言意愿
async function evaluateSpeakingWill(userMessage, candidates, previousSpeakers) {
  if (candidates.length === 0) return [];

  const list = candidates.map(c => {
    const p = c.philosopher;
    return `- ${p.name}（${c.id}）：${p.tags?.join('、') || '哲学家'}。代表观点：${p.quote?.substring(0, 50) || ''}`;
  }).join('\n');

  const prevSpeakerText = previousSpeakers.length > 0
    ? `已在本轮发言的哲学家：${previousSpeakers.map(s => PHILOSOPHERS[s]?.name || s).join('、')}`
    : '本轮尚无哲学家发言';

  const prompt = `你是哲学圆桌的主持人。用户提问："${userMessage}"

${prevSpeakerText}

以下哲学家与话题相关。请为每位评估"发言意愿"（0-9分，整数）：
- 9分：强烈想发言，核心观点与此直接相关
- 7分：有相关见解，愿意参与讨论
- 5分：勉强能谈，兴趣一般
- 3分：关系较远，不太想说
- 0分：完全不想说

候选哲学家：
${list}

请返回JSON对象（不要markdown代码块，纯JSON）：
{"evaluations": [{"philosopherId": "id", "will": 7, "reason": "简短理由"}]}

规则：
1. 大部分哲学家应该愿意参与（6分以上），只有少数完全无关的才给低分
2. 前面已有观点冲突者发言 → 对手分数提高
3. 返回所有候选者的评估`;

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 800, stream: false
      })
    });
    if (!response.ok) throw new Error('意愿评估失败');
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '{"evaluations":[]}';
    const clean = text.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed.evaluations) ? parsed.evaluations : [];
  } catch (err) {
    console.error('[GROUP] will evaluation error:', err.message);
    return candidates.map((c, i) => ({
      philosopherId: c.id,
      will: Math.max(5, 8 - i * 0.5),  // 保底5分，递减
      reason: '默认排序（评估失败）'
    }));
  }
}

// 归一化 philosopherId：处理大小写、中文名回退
function normalizePhilosopherId(rawId) {
  if (!rawId) return null;
  const id = rawId.toString().toLowerCase().trim();
  // 直接匹配
  let matched = Object.keys(PHILOSOPHERS).find(k => k.toLowerCase() === id);
  if (matched) return matched;
  // 中文名匹配
  matched = Object.entries(PHILOSOPHERS).find(([k, p]) =>
    (p.name || '').toLowerCase() === id ||
    (p.nameEn || '').toLowerCase() === id
  )?.[0];
  return matched || id;
}

// Step 3+4: 随机门控 + 截断排序（人数概率控制）
function applyRandomGateAndTruncate(evaluations, silenceRate = 0.12) {
  // 意愿 >= 4 的才算愿意发言
  const willing = evaluations.filter(e => e.will >= 4);
  if (willing.length === 0) return { speakers: [], silenced: [], all: [] };

  // 随机门控：意愿高的不容易被沉默
  const gated = willing.map(e => {
    // 意愿 9 → 沉默概率 5%；意愿 4 → 沉默概率 25%
    const silenceProb = Math.max(0.05, Math.min(0.30, silenceRate + (9 - e.will) * 0.03));
    const silenced = Math.random() < silenceProb;
    return { ...e, silenced, status: silenced ? 'silenced' : 'selected' };
  });

  const speakers = gated.filter(e => !e.silenced).sort((a, b) => b.will - a.will);
  const silenced = gated.filter(e => e.silenced);

  // 人数概率分布：3人 60%，2人 25%，1人 15%保底
  const r = Math.random();
  let targetCount;
  if (r < 0.60) {
    targetCount = 3;
  } else if (r < 0.85) {
    targetCount = 2;
  } else {
    targetCount = 1;
  }

  targetCount = Math.min(targetCount, speakers.length, 3);
  if (targetCount === 0 && speakers.length > 0) {
    targetCount = 1;
  }

  const finalSpeakers = speakers.slice(0, targetCount);

  // 保底：至少1人
  if (finalSpeakers.length === 0 && willing.length > 0) {
    const forced = willing.sort((a, b) => b.will - a.will)[0];
    finalSpeakers.push({ ...forced, silenced: false, status: 'forced', reason: (forced.reason || '') + '（保底发言）' });
  }

  return { speakers: finalSpeakers, silenced, all: [...finalSpeakers, ...silenced] };
}

// 发言风格池：每次为单个哲学家随机抽取一种表达模式
const SPEAKING_STYLES = [
  {
    name: '概念阐发型',
    weight: 18,
    instruction: '深入展开2-3个核心概念，带一点抽象，但用具体比喻收束。不要罗列条目。'
  },
  {
    name: '故事/历史举例型',
    weight: 35,
    instruction: '用一个具体历史事件、个人经历或寓言来回应话题。让概念活在场景里。不要总结成"总之"。'
  },
  {
    name: '回应补充型',
    weight: 18,
    instruction: '先简短抓出前一个人发言中最有意思的一个点——可以同意、可以质疑、可以拐个弯——然后顺着它说自己的东西。不要"我的观点是"开头。'
  },
  {
    name: '短促追问型',
    weight: 12,
    instruction: '只抓最尖锐的一个矛盾或缺口，用一两句话反问或短评。然后停住，留白。不要展开长篇。'
  },
  {
    name: '发散联想型',
    weight: 10,
    instruction: '从这个话题跳到另一个看似无关但深层相连的维度。用直觉和联想，不要论证链条太长。'
  },
  {
    name: '沉默/留白型',
    weight: 7,
    instruction: '你觉得这个话题已经被说透，或者你不想说。用一句意味深长的话带过，或者干脆只给一个意象/比喻，然后停止。'
  }
];

function pickSpeakingStyle() {
  const total = SPEAKING_STYLES.reduce((sum, s) => sum + s.weight, 0);
  let r = Math.random() * total;
  for (const s of SPEAKING_STYLES) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return SPEAKING_STYLES[0];
}

function pickLengthInstruction() {
  const r = Math.random();
  if (r < 0.18) return '短：80-150字。像茶馆闲聊的一句点评。';
  if (r < 0.50) return '中：200-350字。足够展开一个念头，但别写论文。';
  if (r < 0.80) return '中长：400-600字。可以讲一个完整的小故事或深入一个论证。';
  return '长：700-1000字。你确实有话要说，但不要超过这个范围。';
}

// 构建群聊专用system prompt（含引用指令）
function buildGroupSystemPrompt(philosopher, previousReplies) {
  const base = philosopher.systemPromptBase || `你是${philosopher.name}，用第一人称回应。`;

  const style = pickSpeakingStyle();
  const length = pickLengthInstruction();

  let contextPrompt = '';
  if (previousReplies.length > 0) {
    const others = previousReplies.map(r => {
      const p = PHILOSOPHERS[r.philosopherId];
      return `- ${p ? p.name : r.philosopherId}：「${r.reply.substring(0, 200)}${r.reply.length > 200 ? '...' : ''}」`;
    }).join('\n');

    contextPrompt = `\n\n【圆桌上下文】\n你正在参与一场哲学圆桌讨论。前面已有${previousReplies.length}位哲学家发表了观点：\n${others}\n\n【回应要求】\n1. 你是${style.name}：${style.instruction}\n2. 长度要求：${length}\n3. 保持你的人格特征和语言风格\n4. 可以回应前面的人，也可以完全不回应，按你的风格来`;
  } else {
    contextPrompt = `\n\n【圆桌上下文】\n你是本场讨论的第一位发言者。\n\n【回应要求】\n1. 你是${style.name}：${style.instruction}\n2. 长度要求：${length}\n3. 保持你的人格特征和语言风格`;
  }

  return base + contextPrompt + `\n\n【绝对禁止】\n- 以"我认为/我的观点是/我的理解是/我想指出/我要反驳"等固定句式开头。直接说内容，像真人一样起句。\n- 第三人称提及自己（"${philosopher.name}的哲学"、"${philosopher.name}认为"）\n- 舞台动作描述（"微微一笑"、"沉思片刻"）\n- 感叹号和情感化表达堆砌\n- 编造不存在的学者观点\n- 机械地分点论述（1. 2. 3.），除非你的哲学家人格本身就是体系化的\n- 每轮都必须总结"总之"`;
}

// SSE辅助
function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// 核心群聊消息API —— SSE流式顺序发言
app.post('/api/group-chat/message', requireLogin, async (req, res) => {
  const { message, sessionId: bodySid, history = [] } = req.body;
  const uid = req.session.userId;

  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
    return res.status(503).json({ error: 'DeepSeek API Key 未配置或无效' });
  }

  // SSE头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // 确保会话（必须是未归档的active session）
  let sid = bodySid;
  if (!sid) {
    const row = await new Promise((resolve) => {
      db.get('SELECT id, ended_at FROM group_chat_sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [uid], (err, r) => resolve(r));
    });
    if (row && !row.ended_at) sid = row.id;
    else {
      const newId = await new Promise((resolve) => {
        db.run('INSERT INTO group_chat_sessions (user_id, title, ended_at) VALUES (?, ?, ?)', [uid, '哲思圆桌', null], function(err) {
          resolve(err ? null : this.lastID);
        });
      });
      sid = newId;
    }
  } else {
    // 检查session是否已归档
    const sessionInfo = await new Promise((resolve) => {
      db.get('SELECT ended_at FROM group_chat_sessions WHERE id = ? AND user_id = ?', [sid, uid], (err, r) => resolve(r));
    });
    if (!sessionInfo) {
      sendSSE(res, 'error', { error: '会话不存在' });
      return res.end();
    }
    if (sessionInfo.ended_at) {
      sendSSE(res, 'error', { error: '该轮对话已归档，无法发送消息。请点击「历史」查看。' });
      return res.end();
    }
  }
  if (!sid) {
    sendSSE(res, 'error', { error: '无法创建会话' });
    return res.end();
  }

  // 保存用户消息
  await new Promise((resolve) => {
    db.run('INSERT INTO group_chat_messages (session_id, speaker_type, speaker_id, content) VALUES (?, ?, ?, ?)',
      [sid, 'user', 'user', message], resolve);
  });

  // 更新轮次
  await new Promise((resolve) => {
    db.run('UPDATE group_chat_sessions SET round_count = round_count + 1, updated_at = CURRENT_TIMESTAMP, current_topic = ? WHERE id = ?',
      [message.substring(0, 100), sid], resolve);
  });

  try {
    // Step 1: 候选池
    const candidates = filterCandidatesByTopic(message, PHILOSOPHERS);
    console.log(`[GROUP] 候选池: ${candidates.length}人`);

    if (candidates.length === 0) {
      sendSSE(res, 'system', { content: '似乎没有哲学家对这个问题有强烈见解……', type: 'empty' });
      sendSSE(res, 'done', { sessionId: sid });
      return res.end();
    }

    // Step 2: 意愿评估
    const previousSpeakers = history.filter(m => m.role === 'assistant').map(m => m.philosopherId);
    const rawEvaluations = await evaluateSpeakingWill(message, candidates, previousSpeakers);

    // 归一化 philosopherId（处理LLM返回的大小写/中文名）
    const evaluations = rawEvaluations.map(e => ({
      ...e,
      philosopherId: normalizePhilosopherId(e.philosopherId) || e.philosopherId
    })).filter(e => PHILOSOPHERS[e.philosopherId]); // 过滤掉无效的
    console.log(`[GROUP] 意愿评估: ${evaluations.length}人`);

    // Step 3+4: 门控+截断
    const { speakers, silenced } = applyRandomGateAndTruncate(evaluations);
    console.log(`[GROUP] 最终发言: ${speakers.length}人, 沉默: ${silenced.length}人`);

    // 推送选择结果
    sendSSE(res, 'selection', {
      sessionId: sid,
      speakers: speakers.map(s => ({
        philosopherId: s.philosopherId,
        name: PHILOSOPHERS[s.philosopherId]?.name,
        will: s.will,
        reason: s.reason
      })),
      silenced: silenced.map(s => ({
        philosopherId: s.philosopherId,
        name: PHILOSOPHERS[s.philosopherId]?.name,
        will: s.will
      }))
    });

    // ===== 顺序发言 =====
    const previousReplies = [];

    for (const speaker of speakers) {
      const p = PHILOSOPHERS[speaker.philosopherId];
      if (!p) continue;

      sendSSE(res, 'speaker_start', {
        philosopherId: speaker.philosopherId,
        philosopherName: p.name,
        avatar: p.avatar || '📖'
      });

      const systemPrompt = buildGroupSystemPrompt(p, previousReplies);
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `用户的问题是：「${message}」。请作为${p.name}回应。` }
      ];

      try {
        const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
          body: JSON.stringify({
            model: 'deepseek-chat', messages, temperature: 0.6, max_tokens: 1200, stream: false
          })
        });

        if (!response.ok) {
          sendSSE(res, 'error', { philosopherId: speaker.philosopherId, error: '生成失败' });
          continue;
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content?.trim();

        if (reply) {
          await new Promise((resolve) => {
            db.run('INSERT INTO group_chat_messages (session_id, speaker_type, speaker_id, content) VALUES (?, ?, ?, ?)',
              [sid, 'philosopher', speaker.philosopherId, reply], resolve);
          });

          previousReplies.push({ philosopherId: speaker.philosopherId, reply });

          sendSSE(res, 'reply', {
            philosopherId: speaker.philosopherId,
            philosopherName: p.name,
            avatar: p.avatar || '📖',
            reply,
            reason: speaker.reason
          });
        }
      } catch (e) {
        console.error('[GROUP] generate error for', speaker.philosopherId, e.message);
        sendSSE(res, 'error', { philosopherId: speaker.philosopherId, error: e.message });
      }
    }

    sendSSE(res, 'done', { sessionId: sid, speakerCount: speakers.length, silencedCount: silenced.length });

  } catch (err) {
    console.error('[GROUP] 致命错误:', err);
    sendSSE(res, 'error', { error: err.message });
  }

  res.end();
});

// ========== 启动 ==========
// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM received, closing database...');
  db.close((err) => {
    if (err) console.error('[SERVER] Error closing database:', err.message);
    else console.log('[SERVER] Database closed');
    process.exit(0);
  });
});
process.on('SIGINT', () => {
  console.log('[SERVER] SIGINT received, closing database...');
  db.close((err) => {
    if (err) console.error('[SERVER] Error closing database:', err.message);
    else console.log('[SERVER] Database closed');
    process.exit(0);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================`);
  console.log(`🌐 网站已启动: http://0.0.0.0:${PORT}`);
  console.log(`📁 项目目录: ${__dirname}`);
  console.log(`🌐 网站已启动: http://0.0.0.0:${PORT}`);
  console.log(`📁 项目目录: ${__dirname}`);
  console.log(`🔑 管理员账号: ${ADMIN_USER}`);
  console.log(`====================================`);
  console.log(`====================================`);
});
