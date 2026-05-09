/* 朋友圈核心逻辑 — 被 index.html 和 moments.html 共享 */
let allPosts = [];
let currentPostId = null;
let currentCommentId = null;
let currentCommentUser = null;
let currentCommentIsSelf = false;
let currentEditCommentId = null;
let profileAvatar = null;  // 全局头像缓存

async function initMoments() {
  await loadUser();
  // 同时加载 profile 头像
  try {
    const p = await get('/api/profile');
    profileAvatar = p.avatar || null;
  } catch(e) {}

  const feed = document.getElementById('momentsFeed');
  if (!feed) return;
  try {
    const posts = await get('/api/posts');
    allPosts = posts;
    if (!posts.length) {
      feed.innerHTML = '<div class="empty-state"><div class="empty-sep">— · —</div><div class="empty-title">暂无内容</div><div class="empty-desc">生活点滴，静待花开</div></div>';
      return;
    }
    feed.innerHTML = posts.map(post => renderMoment(post)).join('');
    attachEventHandlers();
  } catch (err) {
    feed.innerHTML = '<p style="text-align:center;color:var(--accent-red);padding:40px;">加载失败</p>';
  }
}

function getAvatarHtml(size = 44) {
  if (profileAvatar) {
    return `<img src="${profileAvatar}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block;" alt="">`;
  }
  return '<div class="moment-avatar">我</div>';
}

function renderMoment(post) {
  const dateStr = formatDate(post.display_date);
  const isDiary = post.type === 'diary';
  const diaryTag = isDiary ? '<span class="diary-tag">日记</span>' : '';

  let imagesHtml = '';
  if (post.video) {
    imagesHtml = `<div class="moment-video-wrap">
      <video src="${post.video}" controls preload="metadata" style="width:100%;border-radius:8px;display:block;max-height:480px;object-fit:cover;background:var(--bg-secondary);"></video>
    </div>`;
  } else if (post.images && post.images.length > 0) {
    const count = Math.min(post.images.length, 9);
    imagesHtml = `<div class="moment-images grid-${count}">
      ${post.images.slice(0, 9).map(src => `<img src="${src}" loading="lazy">`).join('')}
    </div>`;
  }

  const likedClass = post.user_liked ? 'liked' : '';

  let likersHtml = '';
  if (post.likers && post.likers.length > 0) {
    const names = post.likers.map(n => escapeHtml(n)).join('、');
    likersHtml = `<div class="likers-bar">❤️ ${names}</div>`;
  }

  // 评论树
  let commentsHtml = '';
  if (post.comments_list && post.comments_list.length > 0) {
    const topComments = post.comments_list.filter(c => !c.parent_id);
    commentsHtml = `<div class="comments-inline">
      ${topComments.map(c => renderCommentTree(c, post.comments_list, post.id)).join('')}
    </div>`;
  }

  return `
    <div class="moment-card">
      <div class="moment-header">
        ${getAvatarHtml()}
        <div class="moment-meta">
          <div class="moment-author">霁光${diaryTag}</div>
          <div class="moment-time">${dateStr}</div>
        </div>
      </div>
      <div class="moment-body">${escapeHtml(post.content).replace(/\n/g, '<br>')}</div>
      ${post.location ? `<div class="moment-location">📍 ${escapeHtml(post.location)}</div>` : ''}
      ${imagesHtml}
      <div class="moment-actions">
        <button class="moment-action-btn ${likedClass}" data-id="${post.id}" onclick="toggleLike(${post.id})">
          <span>${post.user_liked ? '❤️' : '🤍'}</span>
          <span>${post.user_liked ? '已赞' : '赞'} ${post.likes_count > 0 ? post.likes_count : ''}</span>
        </button>
      </div>
      ${likersHtml}
      ${commentsHtml}
      <form class="comment-form-inline" data-id="${post.id}" onsubmit="submitComment(event, ${post.id})">
        <input type="text" name="content" placeholder="写评论..." required autocomplete="off">
        <button type="submit">发送</button>
      </form>
    </div>
  `;
}

function renderCommentTree(comment, allComments, postId) {
  const isSelf = currentUser && comment.user_id == currentUser.id;
  const replyTo = allComments.find(c => c.id === comment.parent_id);
  const replyTag = replyTo ? `<span class="reply-tag">回复 ${escapeHtml(replyTo.username)}</span>` : '';

  // 点赞区域：如果有赞，在评论下方显示 ❤️ 用户名列表
  let likersLine = '';
  if (comment.likers) {
    likersLine = `<div class="comment-likers-line"><span class="comment-likers-heart">❤️</span> ${escapeHtml(comment.likers)}</div>`;
  }

  let html = `<div class="comment-line" onclick="openCommentSheet(${postId}, ${comment.id}, '${escapeJs(comment.content)}', '${escapeJs(comment.username)}', ${comment.user_id}, ${isSelf})">
    <span class="comment-author">${escapeHtml(comment.username)}</span>: ${escapeHtml(comment.content)}${replyTag}
  </div>${likersLine}`;

  // 追评
  const replies = allComments.filter(c => c.parent_id === comment.id);
  if (replies.length > 0) {
    html += `<div class="comment-reply-indent">
      ${replies.map(r => renderCommentTree(r, allComments, postId)).join('')}
    </div>`;
  }
  return html;
}

function attachEventHandlers() {
  document.querySelectorAll('.moment-images img').forEach(img => {
    img.onclick = e => { e.stopPropagation(); openLightbox(img.src); };
  });
}

async function toggleLike(postId) {
  try { await post('/api/posts/' + postId + '/like'); initMoments(); }
  catch (err) { alert(err.message || '请先登录'); }
}

async function submitComment(e, postId) {
  e.preventDefault();
  const input = e.target.querySelector('input');
  const content = input.value.trim();
  if (!content) return;
  try {
    await post('/api/posts/' + postId + '/comment', { content });
    input.value = '';
    initMoments();
  } catch (err) { alert(err.message || '请先登录'); }
}

// ===== 评论操作面板 =====
function openCommentSheet(postId, commentId, content, username, userId, isSelf) {
  currentPostId = postId;
  currentCommentId = commentId;
  currentCommentUser = username;
  currentCommentIsSelf = isSelf;

  const sheetText = document.getElementById('commentSheetText');
  const actions = document.getElementById('commentSheetActions');
  if (!sheetText || !actions) return;

  sheetText.textContent = content;
  actions.innerHTML = '';

  const replyBtn = document.createElement('button');
  replyBtn.className = 'comment-sheet-btn';
  replyBtn.textContent = '💬 回复';
  replyBtn.onclick = () => { closeCommentSheet(); openReplyModal(); };
  actions.appendChild(replyBtn);

  const isAdmin = currentUser && currentUser.is_admin;
  const canDelete = isSelf || isAdmin;
  const canEdit = isSelf;

  if (canEdit) {
    const editBtn = document.createElement('button');
    editBtn.className = 'comment-sheet-btn';
    editBtn.textContent = '✏️ 修改';
    editBtn.onclick = () => { closeCommentSheet(); editMomentComment(commentId, content); };
    actions.appendChild(editBtn);
  }

  if (canDelete) {
    const delBtn = document.createElement('button');
    delBtn.className = 'comment-sheet-btn danger';
    delBtn.textContent = '🗑 删除';
    delBtn.onclick = () => { closeCommentSheet(); deleteMomentComment(commentId); };
    actions.appendChild(delBtn);
  }

  const overlay = document.getElementById('commentSheetOverlay');
  if (overlay) overlay.classList.add('active');
}

// ===== 修改评论 =====
async function editMomentComment(commentId, oldContent) {
  const textarea = document.getElementById('momentCommentEditTextarea');
  if (!textarea) return;
  textarea.value = oldContent || '';
  document.getElementById('momentCommentEditOverlay').classList.add('active');
  textarea.focus();
  currentEditCommentId = commentId;
}

function closeMomentCommentEdit() {
  const overlay = document.getElementById('momentCommentEditOverlay');
  if (overlay) overlay.classList.remove('active');
  currentEditCommentId = null;
}

async function saveMomentCommentEdit() {
  const textarea = document.getElementById('momentCommentEditTextarea');
  if (!textarea || !currentEditCommentId) return;
  const content = textarea.value.trim();
  if (!content) return;
  try {
    await put('/api/comments/' + currentEditCommentId, { content });
    closeMomentCommentEdit();
    initMoments();
  } catch (err) { alert(err.message || '修改失败'); }
}

function closeCommentSheet() {
  const overlay = document.getElementById('commentSheetOverlay');
  if (overlay) overlay.classList.remove('active');
}

// ===== 回复弹窗 =====
function openReplyModal() {
  const targetText = document.getElementById('replyTargetText');
  const input = document.getElementById('replyInput');
  const overlay = document.getElementById('replyModalOverlay');
  if (!targetText || !input || !overlay) return;
  targetText.textContent = `回复 @${currentCommentUser}：`;
  input.value = '';
  overlay.classList.add('active');
  setTimeout(() => input.focus(), 100);
}

function closeReplyModal() {
  const overlay = document.getElementById('replyModalOverlay');
  if (overlay) overlay.classList.remove('active');
}

async function submitReply() {
  const input = document.getElementById('replyInput');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  try {
    await post('/api/posts/' + currentPostId + '/comment', {
      content,
      parent_id: currentCommentId
    });
    closeReplyModal();
    initMoments();
  } catch (err) { alert(err.message || '请先登录'); }
}

// ===== 评论点赞 =====
async function toggleCommentLike(commentId) {
  try {
    await post('/api/comments/' + commentId + '/like');
    initMoments();
  } catch (err) { alert(err.message || '请先登录'); }
}

// ===== 删除评论 =====
async function deleteMomentComment(commentId) {
  if (!confirm('确定删除这条评论？')) return;
  try {
    await del('/api/comments/' + commentId);
    initMoments();
  } catch (err) { alert(err.message || '删除失败'); }
}

function openLightbox(src) {
  const img = document.getElementById('lightboxImg');
  const box = document.getElementById('lightbox');
  if (img && box) { img.src = src; box.classList.add('active'); }
}
function closeLightbox() {
  const box = document.getElementById('lightbox');
  if (box) box.classList.remove('active');
}

// 辅助：JS 字符串转义
function escapeJs(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
