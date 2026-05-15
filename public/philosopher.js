// ===== 哲学家对话前端 =====

const API_BASE = '';

let currentPhilosopher = 'nietzsche';
let chatHistory = [];
let isTyping = false;

const PHILOSOPHER_INFO = {
  nietzsche: {
    avatar: '⚡', name: '尼采', nameEn: 'Nietzsche',
    fullName: '弗里德里希·尼采', years: '1844–1900',
    desc: '19世纪德国哲学家、语文学家。全部工作可归结为一件事：对西方价值体系进行系统性批判与重估。',
    tags: ['权力意志', '超人', '永恒轮回'],
    welcome: '欢迎。我是弗里德里希·尼采。你可以问我关于生命、道德、宗教、艺术、权力……任何你真正关心的事。\n\n我不会给你安慰，但我会给你锋利。',
    resetWelcome: '欢迎。我是弗里德里希·尼采。\n\n一切已重置。我们从零开始。',
    pageTitle: '与尼采对话 · 霁光'
  },
  hegel: {
    avatar: '🜲', name: '黑格尔', nameEn: 'Hegel',
    fullName: '格奥尔格·威廉·弗里德里希·黑格尔', years: '1770–1831',
    desc: '19世纪德国观念论哲学家，耶拿、海德堡与柏林大学教授。以辩证的方法展示精神如何从抽象存在逐步展开为绝对知识。',
    tags: ['绝对精神', '辩证法', '主奴辩证法'],
    welcome: '欢迎。我是格奥尔格·黑格尔。你可以问我关于逻辑、辩证法、自我意识、历史、国家、美学……任何你真正关心的事。\n\n我不会给你安慰，但我会给你体系。',
    resetWelcome: '欢迎。我是格奥尔格·黑格尔。\n\n一切已重置。我们从零开始。',
    pageTitle: '与黑格尔对话 · 霁光'
  }
};

// 全局初始化入口
window.initPhilosopherChat = async function() {
  const params = new URLSearchParams(window.location.search);
  const pid = params.get('id') || 'nietzsche';
  currentPhilosopher = pid;
  await loadChatHistory();
  updateSidebar();

  const input = document.getElementById('messageInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }
};

// 切换哲学家
window.switchPhilosopher = function(pid) {
  if (pid === currentPhilosopher) return;
  currentPhilosopher = pid;

  // 更新切换按钮状态
  document.querySelectorAll('.philo-switch-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.id === pid);
  });

  updateSidebar();
  loadChatHistory();
};

function updateSidebar() {
  const info = PHILOSOPHER_INFO[currentPhilosopher];
  document.getElementById('sidebarAvatar').textContent = info.avatar;
  document.getElementById('sidebarName').textContent = info.fullName;
  document.getElementById('sidebarEn').textContent = `${info.nameEn} · ${info.years}`;
  document.getElementById('sidebarDesc').textContent = info.desc;
  document.getElementById('sidebarTags').innerHTML = info.tags.map(t => `<span>${t}</span>`).join('');
  document.getElementById('chatHeaderTitle').textContent = `与${info.name}对话`;
  document.title = info.pageTitle;
  document.getElementById('messageInput').placeholder = `你想和${info.name}聊什么？`;
}

async function loadChatHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/philosopher-chat/history?philosopher=${currentPhilosopher}`);
    if (!res.ok) throw new Error('加载历史失败');
    const msgs = await res.json();
    chatHistory = msgs.filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    const container = document.getElementById('messages');
    const info = PHILOSOPHER_INFO[currentPhilosopher];
    const welcomeHtml = info.welcome.split('\n\n').map(p => `<p>${p}</p>`).join('');
    container.innerHTML = `
      <div class="philo-msg system-msg">
        <div class="philo-msg-avatar">${info.avatar}</div>
        <div class="philo-msg-content">${welcomeHtml}</div>
      </div>
    `;

    for (const m of msgs) {
      appendMessage(m.role, m.content, m.citations);
    }
  } catch (err) {
    console.warn('加载历史失败:', err.message);
    // 显示欢迎消息
    const container = document.getElementById('messages');
    const info = PHILOSOPHER_INFO[currentPhilosopher];
    const welcomeHtml = info.welcome.split('\n\n').map(p => `<p>${p}</p>`).join('');
    container.innerHTML = `
      <div class="philo-msg system-msg">
        <div class="philo-msg-avatar">${info.avatar}</div>
        <div class="philo-msg-content">${welcomeHtml}</div>
      </div>
    `;
    chatHistory = [];
  }
}

// ===== 发送消息 =====
window.sendMessage = async function() {
  const input = document.getElementById('messageInput');
  const btn = document.getElementById('sendBtn');
  const text = input.value.trim();
  if (!text || isTyping) return;

  appendMessage('user', text);
  chatHistory.push({ role: 'user', content: text });
  input.value = '';
  input.style.height = 'auto';

  isTyping = true;
  btn.disabled = true;
  const typingId = showTyping();

  try {
    const res = await fetch(`${API_BASE}/api/philosopher-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        philosopherId: currentPhilosopher,
        history: chatHistory.slice(0, -1)
      })
    });

    removeTyping(typingId);

    if (!res.ok) {
      const err = await res.json();
      appendMessage('system', `⚠️ 对话中断：${err.error || '未知错误'}${err.detail ? '\n' + err.detail : ''}`);
      return;
    }

    const data = await res.json();
    appendMessage('system', data.reply, data.citations, data.profileSnapshot);
    chatHistory.push({ role: 'assistant', content: data.reply });

  } catch (err) {
    removeTyping(typingId);
    appendMessage('system', `⚠️ 网络错误：${err.message}`);
  } finally {
    isTyping = false;
    btn.disabled = false;
    input.focus();
  }
};

// ===== 消息渲染 =====
function mdToHtml(text) {
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
  text = text.replace(/`(.+?)`/g, '<code>$1</code>');
  const paragraphs = text.split('\n\n').map(p => p.trim()).filter(p => p);
  return paragraphs.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function appendMessage(role, content, citations = null, profileSnapshot = null) {
  const container = document.getElementById('messages');
  if (!container) return;

  const div = document.createElement('div');
  div.className = `philo-msg ${role === 'user' ? 'user-msg' : 'system-msg'}`;

  const info = PHILOSOPHER_INFO[currentPhilosopher];
  const avatar = role === 'user' ? '你' : (info?.avatar || '⚡');

  let html = `<div class="philo-msg-avatar">${avatar}</div>`;

  // 概念标签
  let conceptTags = '';
  if (role === 'system' && profileSnapshot) {
    const mastered = profileSnapshot.masteredConcepts || [];
    const familiar = profileSnapshot.familiarConcepts || [];
    if (mastered.length || familiar.length) {
      conceptTags = '<div style="margin-bottom:6px;display:flex;flex-wrap:wrap;gap:4px;">';
      mastered.forEach(c => { conceptTags += `<span class="concept-badge mastered">✓ ${c}</span>`; });
      familiar.forEach(c => { conceptTags += `<span class="concept-badge familiar">~ ${c}</span>`; });
      conceptTags += '</div>';
    }
  }

  const bodyHtml = role === 'system' ? mdToHtml(content) : escapeHtml(content);
  html += `<div class="philo-msg-content">${conceptTags}${bodyHtml}</div>`;

  if (citations && citations.length > 0) {
    html += `
      <div class="philo-citations">
        <div class="philo-cite-label">📖 参考文本</div>
        ${citations.map(c => `
          <div class="philo-cite-item">
            <span class="philo-cite-source">${escapeHtml(c.source)}</span>
            ${escapeHtml(c.text)}
          </div>
        `).join('')}
      </div>
    `;
  }

  div.innerHTML = html;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showTyping() {
  const container = document.getElementById('messages');
  const id = 'typing-' + Date.now();
  const info = PHILOSOPHER_INFO[currentPhilosopher];
  const avatar = info?.avatar || '⚡';
  const div = document.createElement('div');
  div.id = id;
  div.className = 'philo-msg system-msg';
  div.innerHTML = `
    <div class="philo-msg-avatar">${avatar}</div>
    <div class="philo-msg-content"><div class="typing-indicator"><span></span><span></span><span></span></div></div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ===== 会话操作 =====
window.clearSession = async function() {
  if (!confirm('确定清空本轮对话？\n\n用户画像与概念掌握度将保留。')) return;
  try {
    await fetch(`${API_BASE}/api/philosopher-session/clear`, { method: 'POST' });
  } catch {}
  chatHistory = [];
  const container = document.getElementById('messages');
  const info = PHILOSOPHER_INFO[currentPhilosopher];
  const welcome = info?.welcome || '欢迎。';
  const welcomeHtml = welcome.split('\n\n').map(p => `<p>${p}</p>`).join('');
  if (container) {
    container.innerHTML = `
      <div class="philo-msg system-msg">
        <div class="philo-msg-avatar">${info.avatar}</div>
        <div class="philo-msg-content">${welcomeHtml}</div>
      </div>
    `;
  }
};

window.resetAll = async function() {
  if (!confirm('警告：此操作将完全重置一切。\n\n对话历史、用户画像、概念掌握度、学习档案将全部清空且不可恢复。\n\n确定继续？')) return;
  try {
    await fetch(`${API_BASE}/api/philosopher-session/reset`, { method: 'POST' });
  } catch {}
  chatHistory = [];
  const container = document.getElementById('messages');
  const info = PHILOSOPHER_INFO[currentPhilosopher];
  const welcome = info?.resetWelcome || info?.welcome || '欢迎。一切已重置。我们从零开始。';
  const welcomeHtml = welcome.split('\n\n').map(p => `<p>${p}</p>`).join('');
  if (container) {
    container.innerHTML = `
      <div class="philo-msg system-msg">
        <div class="philo-msg-avatar">${info.avatar}</div>
        <div class="philo-msg-content">${welcomeHtml}</div>
      </div>
    `;
  }
};

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
