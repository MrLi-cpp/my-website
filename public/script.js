// ========== CSRF Token ==========
let csrfToken = null;

async function fetchCsrfToken() {
  try {
    const res = await fetch('/api/csrf-token', { credentials: 'include' });
    const data = await res.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  } catch (e) {
    console.warn('获取 CSRF token 失败:', e);
    return null;
  }
}

// 页面加载时预获取
try { fetchCsrfToken(); } catch(e) {}

// ========== 通用工具 ==========
const API_BASE = '';

async function get(url) {
  const res = await fetch(API_BASE + url, { credentials: 'include' });
  const contentType = res.headers.get('content-type') || '';
  // 健壮解析：如果不是 JSON，尝试读文本提示
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(text?.includes('DOCTYPE') ? '服务器返回了网页而非数据，请检查网络或刷新重试' : (text || '请求失败'));
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '请求失败');
  }
  return res.json();
}

async function post(url, data) {
  if (!csrfToken) await fetchCsrfToken();
  const isFormData = data instanceof FormData;
  const headers = {};
  if (!isFormData) headers['Content-Type'] = 'application/json';
  if (csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(API_BASE + url, {
    method: 'POST',
    headers,
    body: isFormData ? data : JSON.stringify(data),
    credentials: 'include'
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '请求失败');
  }
  return res.json();
}

async function put(url, data) {
  if (!csrfToken) await fetchCsrfToken();
  const headers = { 'Content-Type': 'application/json' };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(API_BASE + url, {
    method: 'PUT',
    headers,
    body: JSON.stringify(data),
    credentials: 'include'
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '请求失败');
  }
  return res.json();
}

async function del(url) {
  if (!csrfToken) await fetchCsrfToken();
  const headers = {};
  if (csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(API_BASE + url, {
    method: 'DELETE',
    headers,
    credentials: 'include'
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '请求失败');
  }
  return res.json();
}

// ========== 用户状态 ==========
let currentUser = null;

async function loadUser() {
  try {
    currentUser = await get('/api/me');
    updateUserBar();
    return currentUser;
  } catch (e) {
    currentUser = null;
    updateUserBar();
    return null;
  }
}

function updateUserBar() {
  const bar = document.getElementById('userBar');
  if (!bar) return;
  if (currentUser) {
    let html = `你好, ${escapeHtml(currentUser.username)}`;
    if (currentUser.is_admin) {
      html += ` | <a href="/admin.html">后台</a>`;
    }
    html += ` | <a href="#" onclick="logout()">退出</a>`;
    bar.innerHTML = html;
  } else {
    bar.innerHTML = `<a href="/login.html">登录 / 注册</a>`;
  }
}

async function logout() {
  try {
    await post('/api/logout');
    currentUser = null;
    location.reload();
  } catch (e) {
    alert('退出失败');
  }
}

// ========== 工具函数 ==========
function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// 安全 URL 校验：只允许 http/https/相对路径图片
function isSafeImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' || (url.startsWith('/') && !url.startsWith('//'));
  } catch {
    return url.startsWith('/') && !url.startsWith('//');
  }
}

// ========== 全局加载用户 ==========
loadUser();
