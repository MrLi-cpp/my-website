#!/usr/bin/env python3
"""
为 my-website 的 server.js 添加学习站 (learning) 后端 API。
"""
import re

path = '/Users/mrli/Desktop/my-website/server.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# ========== 1. 在数据库初始化部分添加 learning_items 表 ==========
db_insert = """  db.run(`CREATE TABLE IF NOT EXISTS blog_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // ===== 学习站资料表 =====
  db.run(`CREATE TABLE IF NOT EXISTS learning_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    cover_image TEXT,
    html_file TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    display_date DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
"""

old_db = """  db.run(`CREATE TABLE IF NOT EXISTS blog_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);"""

if old_db in content:
    content = content.replace(old_db, db_insert)
    print("✅ 1. learning_items 表已添加到数据库初始化")
else:
    print("❌ 1. 数据库插入点匹配失败")

# ========== 2. 在 app.listen 之前添加学习站路由 ==========
routes = """
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
    `INSERT INTO learning_items (title, cover_image, html_file, display_date) VALUES (?, ?, ?, ?)`,
    [title, coverPath, htmlPath, displayDate],
    function(err) {
      if (err) {
        console.error('[LEARNING] 创建失败:', err.message);
        return res.status(500).json({ error: '创建失败' });
      }
      res.json({ id: this.lastID, title, cover_image: coverPath, html_file: htmlPath });
    }
  );
});

// 获取学习资料列表
app.get('/api/learning', (req, res) => {
  db.all(
    `SELECT id, title, cover_image, html_file, created_at, display_date
     FROM learning_items ORDER BY display_date DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('[LEARNING] 查询失败:', err.message);
        return res.status(500).json({ error: '查询失败' });
      }
      res.json(rows || []);
    }
  );
});

// 获取单个学习资料
app.get('/api/learning/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 ID' });
  db.get(
    `SELECT id, title, cover_image, html_file, created_at, display_date
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

// 删除学习资料（管理员）
app.delete('/api/learning/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 ID' });
  db.get(`SELECT html_file, cover_image FROM learning_items WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: '资料不存在' });
    const fs = require('fs');
    [row.html_file, row.cover_image].forEach(f => {
      if (f) {
        const fp = path.join(__dirname, 'public', f);
        try { fs.unlinkSync(fp); } catch {}
      }
    });
    db.run(`DELETE FROM learning_items WHERE id = ?`, [id], function(err2) {
      if (err2) return res.status(500).json({ error: '删除失败' });
      res.json({ success: true });
    });
  });
});

"""

# 在 app.listen 之前插入
old_listen = "app.listen(PORT, '0.0.0.0', () => {"
if old_listen in content:
    content = content.replace(old_listen, routes + old_listen)
    print("✅ 2. 学习站 API 路由已添加")
else:
    print("❌ 2. app.listen 插入点匹配失败")

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done")
