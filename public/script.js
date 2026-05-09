// ========== 通用工具 ==========
const API_BASE = '';

async function get(url) {
  const res = await fetch(API_BASE + url, { credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '请求失败');
  }
  return res.json();
}

async function post(url, data) {
  const res = await fetch(API_BASE + url, {
    method: 'POST',
    headers: data instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: data instanceof FormData ? data : JSON.stringify(data),
    credentials: 'include'
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '请求失败');
  }
  return res.json();
}

async function put(url, data) {
  const res = await fetch(API_BASE + url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await fetch(API_BASE + url, {
    method: 'DELETE',
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

// ========== 全局加载用户 ==========
loadUser();
