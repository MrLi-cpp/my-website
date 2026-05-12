const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = 3000;

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

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    images TEXT DEFAULT '[]',
    video TEXT,
    type TEXT DEFAULT 'moment',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    display_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    likes_count INTEGER DEFAULT 0
  )`);
  // 兼容旧表：添加 video 字段
  db.run(`ALTER TABLE posts ADD COLUMN video TEXT`, (err) => {});

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

  // 初始化管理员（lijiguang）
  const adminHash = bcrypt.hashSync('ljgljg2006', 10);
  db.run('UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id NOT IN (3, 4) AND deleted_at IS NULL', [], function(err) {
    if (err) console.error('[INIT] soft-delete old accounts:', err.message);
    else console.log('[INIT] soft-deleted old accounts:', this.changes);
  });
  db.run('INSERT OR IGNORE INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)', ['lijiguang', adminHash], function() {
    if (this.changes) console.log('[INIT] 管理员账号已创建: lijiguang / ljgljg2006');
    else console.log('[INIT] 管理员账号已存在');
  });
});

// ========== 中间件 ==========
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new FileStore({ path: './sessions', logFn: () => {} }),
  secret: 'mywebsite-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: false
  }
}));
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
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
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传图片或视频'), false);
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
app.post('/api/posts', requireAdmin, upload.fields([{ name: 'images', maxCount: 9 }, { name: 'video', maxCount: 1 }]), (req, res) => {
  const { content, type, display_date, location } = req.body;
  const images = req.files && req.files['images'] ? req.files['images'].map(f => '/uploads/' + f.filename) : [];
  const videoFile = req.files && req.files['video'] ? req.files['video'][0] : null;
  const video = videoFile ? '/uploads/' + videoFile.filename : null;
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO posts (content, images, video, type, display_date, location) VALUES (?, ?, ?, ?, ?, ?)',
    [content, JSON.stringify(images), video, type || 'moment', display_date || now, location || null],
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
app.put('/api/posts/:id', requireAdmin, upload.fields([{ name: 'images', maxCount: 9 }, { name: 'video', maxCount: 1 }]), (req, res) => {
  const { content, type, location } = req.body;
  const images = req.files && req.files['images'] ? JSON.stringify(req.files['images'].map(f => '/uploads/' + f.filename)) : null;
  const videoFile = req.files && req.files['video'] ? req.files['video'][0] : null;
  const video = videoFile ? '/uploads/' + videoFile.filename : null;

  // 动态构建 UPDATE 语句
  const fields = ['content = ?', 'type = ?', 'location = ?'];
  const values = [content, type, location || null];

  if (images) { fields.push('images = ?'); values.push(images); }
  if (video) { fields.push('video = ?'); values.push(video); }

  values.push(req.params.id);
  const sql = 'UPDATE posts SET ' + fields.join(', ') + ' WHERE id = ?';

  db.run(sql, values, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: '已更新' });
  });
});

// ========== 用户系统 ==========

// 注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '缺少用户名或密码' });
  if (username.length < 2 || password.length < 4) return res.status(400).json({ error: '用户名至少2位，密码至少4位' });

  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash], function(err) {
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

// 点赞/取消点赞
app.post('/api/posts/:id/like', requireLogin, (req, res) => {
  const postId = req.params.id;
  const userId = req.session.userId;

  db.get('SELECT id FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId], (err, existing) => {
    if (existing) {
      db.run('DELETE FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE posts SET likes_count = likes_count - 1 WHERE id = ?', [postId]);
        res.json({ liked: false });
      });
    } else {
      db.run('INSERT INTO likes (post_id, user_id) VALUES (?, ?)', [postId, userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?', [postId]);
        res.json({ liked: true });
      });
    }
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

// 评论点赞
app.post('/api/comments/:id/like', requireLogin, (req, res) => {
  const commentId = req.params.id;
  const userId = req.session.userId;
  db.get('SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?', [commentId, userId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) {
      db.run('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?', [commentId, userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ liked: false });
      });
    } else {
      db.run('INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)', [commentId, userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ liked: true });
      });
    }
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

// 删除评论（仅自己或管理员）
// 修改评论（仅自己）
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
    SELECT b.*, 'lijiguang' as author_name
    FROM blogs b
    ORDER BY b.display_date DESC
  `, [], (err, blogs) => {
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

// 博客点赞/取消点赞
app.post('/api/blogs/:id/like', requireLogin, (req, res) => {
  const blogId = req.params.id;
  const userId = req.session.userId;
  db.get('SELECT id FROM blog_likes WHERE blog_id = ? AND user_id = ?', [blogId, userId], (err, existing) => {
    if (existing) {
      db.run('DELETE FROM blog_likes WHERE blog_id = ? AND user_id = ?', [blogId, userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE blogs SET likes_count = likes_count - 1 WHERE id = ?', [blogId]);
        res.json({ liked: false });
      });
    } else {
      db.run('INSERT INTO blog_likes (blog_id, user_id) VALUES (?, ?)', [blogId, userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE blogs SET likes_count = likes_count + 1 WHERE id = ?', [blogId]);
        res.json({ liked: true });
      });
    }
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
  db.get("SELECT id FROM users WHERE username = 'lijiguang' LIMIT 1", [], (err, row) => {
    if (err || !row) return callback(null);
    callback(row.id);
  });
}

function getAdminIdAsync() {
  return new Promise((resolve) => {
    db.get("SELECT id FROM users WHERE username = 'lijiguang' LIMIT 1", [], (err, row) => {
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
app.post('/api/messages', requireLogin, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
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
  if (req.files && req.files['image'] && req.files['image'][0]) {
    fileUrl = '/uploads/' + req.files['image'][0].filename;
  } else if (req.files && req.files['video'] && req.files['video'][0]) {
    fileUrl = '/uploads/' + req.files['video'][0].filename;
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
  console.log(`🔑 管理员账号: lijiguang / ljgljg2006`);
  console.log(`====================================`);
});
