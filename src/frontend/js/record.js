const pageIntro = document.getElementById('pageIntro');
const formSection = document.getElementById('formSection');
const coCreateSection = document.getElementById('coCreateSection');
const resultSection = document.getElementById('resultSection');
const qrIdText = document.getElementById('qrIdText');
const uploadArea = document.getElementById('uploadArea');
const imageInput = document.getElementById('imageInput');
const preview = document.getElementById('preview');
const uploadFeedback = document.getElementById('uploadFeedback');
const uploadFeedbackText = document.getElementById('uploadFeedbackText');
const uploadActionText = document.getElementById('uploadActionText');
const contentInput = document.getElementById('content');
const countEl = document.getElementById('count');
const showBrandDisclosureInput = document.getElementById('showBrandDisclosure');
const saveModeInputs = Array.from(document.querySelectorAll('input[name="saveMode"]'));
const brandSection = document.getElementById('brandSection');
const brandPreviewText = document.getElementById('brandPreviewText');
const submitBtn = document.getElementById('submitBtn');
const formMessage = document.getElementById('formMessage');
const currentPhoneText = document.getElementById('currentPhoneText');
const switchPhoneBtn = document.getElementById('switchPhoneBtn');

const shareBtn = document.getElementById('shareBtn');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmOverlayTitle = confirmOverlay ? confirmOverlay.querySelector('.overlay-title') : null;
const confirmSubmitBtn = document.getElementById('confirmSubmitBtn');
const cancelSubmitBtn = document.getElementById('cancelSubmitBtn');
const confirmPreviewImage = document.getElementById('confirmPreviewImage');
const confirmPreview = confirmPreviewImage ? confirmPreviewImage.closest('.confirm-preview') : null;
const confirmPreviewContent = document.getElementById('confirmPreviewContent');
const confirmOverlaySubtitle = document.getElementById('confirmOverlaySubtitle');
const stageHint = document.getElementById('stageHint');

const resultImage = document.getElementById('resultImage');
const resultContent = document.getElementById('resultContent');
const resultHashToggle = document.getElementById('resultHashToggle');
const resultHash = document.getElementById('resultHash');
const resultHashValue = document.getElementById('resultHashValue');
const resultTime = document.getElementById('resultTime');
const resultBrandDisclosure = document.getElementById('resultBrandDisclosure');
const resultBrandName = document.getElementById('resultBrandName');
const resultBrandSeparator = document.getElementById('resultBrandSeparator');
const resultBrandDisclosureText = document.getElementById('resultBrandDisclosureText');
const resultComments = document.getElementById('resultComments');

const coCreateImage = document.getElementById('coCreateImage');
const coCreateContent = document.getElementById('coCreateContent');
const coCreateShareBtn = document.getElementById('coCreateShareBtn');
const coCreateOwnerActions = document.getElementById('coCreateOwnerActions');
const finalizeCoCreateBtn = document.getElementById('finalizeCoCreateBtn');
const coCreateStatusMessage = document.getElementById('coCreateStatusMessage');
const commentFormCard = document.getElementById('commentFormCard');
const commentAuthor = document.getElementById('commentAuthor');
const commentContent = document.getElementById('commentContent');
const commentCount = document.getElementById('commentCount');
const submitCommentBtn = document.getElementById('submitCommentBtn');
const coCreateMessage = document.getElementById('coCreateMessage');
const commentsOwnerHint = document.getElementById('commentsOwnerHint');
const commentsList = document.getElementById('commentsList');

const params = new URLSearchParams(window.location.search);
const qrId = params.get('t') || params.get('qr');
let userPhone = '';

let uploadedImageUrl = '';
let uploadedImageObjectKey = '';
let uploadedStorageMode = '';
let currentResult = null;
let currentCoCreate = null;
let submitting = false;
let hashExpanded = false;
let confirmOverlayMode = 'record';

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function showError(message) {
  formMessage.textContent = message;
}

function maskPhone(phone) {
  const value = String(phone || '').trim();
  if (!/^1\d{10}$/.test(value)) {
    return value || '未登录';
  }
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function formatMinuteTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function setPageMode(mode) {
  if (mode === 'result') {
    if (pageIntro) pageIntro.classList.add('hidden');
    formSection.classList.add('hidden');
    if (coCreateSection) coCreateSection.classList.add('hidden');
    resultSection.classList.remove('hidden');
    return;
  }

  if (mode === 'co_create') {
    if (pageIntro) pageIntro.classList.add('hidden');
    formSection.classList.add('hidden');
    resultSection.classList.add('hidden');
    if (coCreateSection) coCreateSection.classList.remove('hidden');
    return;
  }

  if (pageIntro) pageIntro.classList.remove('hidden');
  resultSection.classList.add('hidden');
  if (coCreateSection) coCreateSection.classList.add('hidden');
  formSection.classList.remove('hidden');
}

function getSaveMode() {
  const checked = saveModeInputs.find((input) => input.checked);
  return checked ? checked.value : 'direct';
}

function syncSaveModeStyles() {
  saveModeInputs.forEach((input) => {
    const option = input.closest('.mode-option');
    if (option) {
      option.classList.toggle('selected', input.checked);
    }
  });
}

function formatComments(comments = []) {
  return (Array.isArray(comments) ? comments : [])
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function renderComments(container, comments, { canDelete = false } = {}) {
  if (!container) return;
  container.textContent = '';
  const visible = formatComments(comments);
  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'field-hint';
    empty.textContent = '还没有共创留言。';
    container.appendChild(empty);
    return;
  }

  visible.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'comment-item';

    const head = document.createElement('div');
    head.className = 'comment-head';
    const author = document.createElement('strong');
    author.textContent = item.author_name || '匿名';
    const time = document.createElement('span');
    time.textContent = formatMinuteTime(item.created_at);
    head.append(author, time);

    const content = document.createElement('p');
    content.textContent = item.content || '';
    row.append(head, content);

    if (canDelete) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'comment-delete';
      remove.textContent = '删除';
      remove.dataset.commentId = item.id;
      row.appendChild(remove);
    }

    container.appendChild(row);
  });
}

function renderResult(data, { justSaved = false } = {}) {
  currentResult = data;
  currentCoCreate = null;
  setPageMode('result');
  resultSection.classList.remove('result-animate');
  resultSection.classList.remove('show-actions');
  // force reflow for replay animation
  // eslint-disable-next-line no-unused-expressions
  resultSection.offsetHeight;
  resultSection.classList.add('result-animate');
  window.setTimeout(() => {
    resultSection.classList.add('show-actions');
  }, 900);

  const resultSuccessTitle = document.querySelector('.result-success-title');
  if (resultSuccessTitle) {
    resultSuccessTitle.textContent = justSaved ? '✨ 保存成功' : '这瓶酒里的记录';
  }

  resultImage.src = data.image_url || '';
  resultContent.textContent = data.content || '（未填写留言）';
  const comments = formatComments(data.co_creation_comments);
  if (resultComments) {
    resultComments.textContent = '';
    if (comments.length > 0) {
      const title = document.createElement('p');
      title.className = 'section-title';
      title.textContent = '共创留言';
      resultComments.appendChild(title);
      const list = document.createElement('div');
      list.className = 'comments-list';
      resultComments.appendChild(list);
      renderComments(list, comments);
      resultComments.classList.remove('hidden');
    } else {
      resultComments.classList.add('hidden');
    }
  }
  hashExpanded = false;
  const blockchainHash = String(data.blockchain_hash || '').trim();
  resultHashValue.textContent = blockchainHash;
  resultHash.classList.add('hidden');
  resultHashToggle.disabled = !blockchainHash;
  resultHashToggle.textContent = blockchainHash
    ? '查看区块链永久凭证'
    : '正在生成永久记录…';
  resultTime.textContent = formatMinuteTime(data.activated_at);

  const brandName = String(data.brand_name || '').trim();
  const brandDisclosureText = String(data.brand_disclosure_text_snapshot || '').trim();
  if (data.show_brand_disclosure && brandDisclosureText) {
    resultBrandName.textContent = brandName;
    resultBrandSeparator.textContent = brandName ? ' · ' : '';
    resultBrandDisclosureText.textContent = brandDisclosureText;
    resultBrandDisclosure.classList.remove('hidden');
  } else {
    resultBrandName.textContent = '';
    resultBrandSeparator.textContent = '';
    resultBrandDisclosureText.textContent = '';
    resultBrandDisclosure.classList.add('hidden');
  }
}

function renderCoCreate(data) {
  currentCoCreate = data;
  currentResult = null;
  setPageMode('co_create');

  coCreateImage.src = data.image_url || '';
  coCreateContent.textContent = data.content || '（未填写留言）';
  const isOwner = data.is_co_creation_owner === true;
  const commentCountValue = Number(data.co_creation_comment_count || 0);
  const commentLimit = Number(data.co_creation_comment_limit || 12);
  const hasMyComment = data.has_my_co_creation_comment === true;
  const isCommentFull = commentCountValue >= commentLimit;

  coCreateShareBtn.classList.toggle('hidden', !isOwner);
  coCreateOwnerActions.classList.toggle('hidden', !isOwner);
  commentsOwnerHint.classList.toggle('hidden', !isOwner);
  renderComments(commentsList, data.co_creation_comments, {
    canDelete: isOwner
  });

  commentFormCard.classList.toggle('hidden', isOwner || hasMyComment || isCommentFull);
  if (coCreateStatusMessage) {
    coCreateStatusMessage.classList.add('hidden');
    coCreateStatusMessage.textContent = '';
    if (!isOwner && hasMyComment) {
      coCreateStatusMessage.textContent = '你已留下见证，等待发起人确认封存。';
      coCreateStatusMessage.classList.remove('hidden');
    } else if (!isOwner && isCommentFull) {
      coCreateStatusMessage.textContent = '共创留言已满，等待发起人确认封存。';
      coCreateStatusMessage.classList.remove('hidden');
    }
  }

  if (coCreateMessage) {
    coCreateMessage.textContent = '';
  }
}

function openConfirmOverlay(mode = 'record') {
  if (!confirmOverlay) return;
  confirmOverlayMode = mode;

  if (confirmSubmitBtn) {
    confirmSubmitBtn.disabled = false;
  }
  if (confirmOverlayTitle) {
    confirmOverlayTitle.textContent = mode === 'finalize'
      ? '确认封存共创记录'
      : '确认保存这一刻';
  }
  if (confirmSubmitBtn) {
    confirmSubmitBtn.textContent = mode === 'finalize' ? '确认封存' : '确认提交';
  }
  if (cancelSubmitBtn) {
    cancelSubmitBtn.textContent = mode === 'finalize' ? '再检查一下' : '返回修改';
  }

  if (mode === 'finalize') {
    if (confirmPreview) confirmPreview.classList.add('hidden');
    if (confirmPreviewImage) {
      confirmPreviewImage.removeAttribute('src');
      confirmPreviewImage.classList.add('hidden');
    }
    if (confirmPreviewContent) {
      confirmPreviewContent.textContent = '';
      confirmPreviewContent.classList.remove('empty');
    }
    if (confirmOverlaySubtitle) {
      confirmOverlaySubtitle.textContent = '';
      confirmOverlaySubtitle.append(
        document.createTextNode('封存后，这张照片、这句话和保留的共创留言，将生成这瓶酒的'),
        Object.assign(document.createElement('strong'), { textContent: '区块链永久记录' }),
        document.createTextNode('。'),
        document.createElement('br'),
        document.createTextNode('以后扫码只能查看，'),
        Object.assign(document.createElement('strong'), { textContent: '不能修改' }),
        document.createTextNode('。')
      );
    }

    confirmOverlay.classList.remove('hidden');
    requestAnimationFrame(() => {
      confirmOverlay.classList.add('show');
    });
    return;
  }

  const saveMode = getSaveMode();
  if (confirmPreview) confirmPreview.classList.remove('hidden');

  const previewSrc = preview.getAttribute('src') || '';
  if (confirmPreviewImage && previewSrc) {
    confirmPreviewImage.src = previewSrc;
    confirmPreviewImage.classList.remove('hidden');
  } else if (confirmPreviewImage) {
    confirmPreviewImage.removeAttribute('src');
    confirmPreviewImage.classList.add('hidden');
  }

  if (confirmPreviewContent) {
    const content = contentInput.value.trim();
    confirmPreviewContent.textContent = content || '未填写留言';
    confirmPreviewContent.classList.toggle('empty', !content);
  }

  if (confirmOverlaySubtitle) {
    if (saveMode === 'co_create') {
      confirmOverlaySubtitle.textContent = '';
      confirmOverlaySubtitle.append(
        document.createTextNode('提交后，这张照片和这句话将先保存为共创记录。'),
        document.createElement('br'),
        document.createTextNode('其他人可以扫码留言，最后由你确认封存。')
      );
    } else {
      confirmOverlaySubtitle.textContent = '';
      confirmOverlaySubtitle.append(
        document.createTextNode('提交后，这张照片和这句话，将生成这瓶酒的'),
        Object.assign(document.createElement('strong'), { textContent: '区块链永久记录' }),
        document.createTextNode('。'),
        document.createElement('br'),
        document.createTextNode('以后扫码只能查看，'),
        Object.assign(document.createElement('strong'), { textContent: '不能修改' }),
        document.createTextNode('。')
      );
    }
  }

  confirmOverlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    confirmOverlay.classList.add('show');
  });
}

function closeConfirmOverlay() {
  if (!confirmOverlay) return;
  confirmOverlay.classList.remove('show');
  window.setTimeout(() => {
    if (!confirmOverlay.classList.contains('show')) {
      confirmOverlay.classList.add('hidden');
    }
  }, 250);
}

async function loadQRStatus() {
  if (!qrId) {
    setPageMode('form');
    showError('未找到星星编号，请重新扫码。');
    return;
  }

  qrIdText.textContent = qrId;

  try {
    const res = await apiRequest(`/api/qr/${encodeURIComponent(qrId)}`);
    if (res.data && res.data.id) {
      qrIdText.textContent = res.data.id;
    }

    if (res.data.activation_status === 'activated') {
      renderResult({
        qr_id: res.data.id,
        image_url: res.data.image_url,
        content: res.data.content,
        blockchain_hash: res.data.blockchain_hash,
        activated_at: res.data.activated_at,
        co_creation_comments: res.data.co_creation_comments || [],
        show_brand_disclosure: res.data.show_brand_disclosure,
        brand_disclosure_text_snapshot: res.data.brand_disclosure_text_snapshot,
        brand_name: res.data.batch_brand_name || ''
      }, { justSaved: false });
      return;
    }

    if (res.data.activation_status === 'co_creating') {
      if (!userPhone) {
        window.location.href = `/register.html?t=${encodeURIComponent(qrId)}`;
        return;
      }

      renderCoCreate({
        qr_id: res.data.id,
        image_url: res.data.image_url,
        content: res.data.content,
        co_creation_comments: res.data.co_creation_comments || [],
        is_co_creation_owner: res.data.is_co_creation_owner,
        has_my_co_creation_comment: res.data.has_my_co_creation_comment,
        co_creation_comment_count: res.data.co_creation_comment_count,
        co_creation_comment_limit: res.data.co_creation_comment_limit
      });
      return;
    }

    if (!userPhone) {
      window.location.href = `/register.html?t=${encodeURIComponent(qrId)}`;
      return;
    }

    const batchBrandDisclosureText = String(res.data.batch_brand_disclosure_text || '').trim();
    if (res.data.batch_id && batchBrandDisclosureText) {
      brandSection.classList.remove('hidden');
      showBrandDisclosureInput.checked = !!res.data.batch_brand_disclosure_default;
      const previewParts = [];
      const batchBrandName = String(res.data.batch_brand_name || '').trim();
      if (batchBrandName) previewParts.push(batchBrandName);
      previewParts.push(batchBrandDisclosureText);
      brandPreviewText.textContent = previewParts.join(' - ');
    } else {
      brandSection.classList.add('hidden');
      showBrandDisclosureInput.checked = false;
      brandPreviewText.textContent = '';
    }

    setPageMode('form');
  } catch (error) {
    setPageMode('form');
    showError(error.message || '加载失败，请重新扫码或检查网络');
  }
}

async function syncSessionUser() {
  try {
    const res = await apiRequest('/api/user/me');
    userPhone = res.data.phone || '';
  } catch (_error) {
    userPhone = '';
  }

  if (currentPhoneText) {
    currentPhoneText.textContent = maskPhone(userPhone);
  }
}

async function initPage() {
  await syncSessionUser();
  await loadQRStatus();
}

initPage();

if (switchPhoneBtn) {
  switchPhoneBtn.addEventListener('click', async () => {
    const confirmed = window.confirm('确认更换手机号吗？更换后会退出当前设备登录状态，需要重新验证手机号。');
    if (!confirmed) {
      return;
    }

    try {
      await apiRequest('/api/user/logout', {
        method: 'POST'
      });
    } catch (_error) {
      // 忽略退出失败，继续跳转注册页
    }

    userPhone = '';
    window.location.href = `/register.html?t=${encodeURIComponent(qrId || '')}`;
  });
}

saveModeInputs.forEach((input) => {
  input.addEventListener('change', syncSaveModeStyles);
});
syncSaveModeStyles();

if (uploadArea) {
  uploadArea.addEventListener('click', () => {
    if (submitting) return;
    imageInput.click();
  });
}

imageInput.addEventListener('change', async () => {
  if (!imageInput.files || imageInput.files.length === 0) {
    return;
  }

  const file = imageInput.files[0];
  const formData = new FormData();
  formData.append('image', file);
  if (qrId) {
    formData.append('qr_id', qrId);
  }

  try {
    const res = await apiRequest('/api/upload', {
      method: 'POST',
      body: formData
    });

    uploadedImageUrl = res.data.url;
    uploadedImageObjectKey = res.data.object_key || '';
    uploadedStorageMode = res.data.storage_mode || 'local';

    const previewSrc = res.data.preview_url || '';
    if (previewSrc) {
      preview.src = previewSrc;
      preview.classList.remove('hidden');
    }
    uploadFeedbackText.textContent = '已选择照片';
    if (uploadActionText) {
      uploadActionText.textContent = '更换照片';
    }
    imageInput.value = '';
    uploadFeedback.classList.remove('hidden');
    showError('');
  } catch (error) {
    uploadedImageUrl = '';
    uploadedImageObjectKey = '';
    uploadedStorageMode = '';
    preview.src = '';
    preview.classList.add('hidden');
    if (uploadArea) {
      uploadArea.classList.remove('hidden');
    }
    imageInput.value = '';
    uploadFeedback.classList.add('hidden');
    if (uploadActionText) {
      uploadActionText.textContent = '添加照片';
    }
    showError(error.message || '上传失败，请换张图片试试');
  }
});

if (resultHashToggle) {
  resultHashToggle.addEventListener('click', () => {
    if (!resultHashValue.textContent) return;
    hashExpanded = !hashExpanded;
    if (hashExpanded) {
      resultHash.classList.remove('hidden');
      resultHashToggle.textContent = '收起凭证';
      return;
    }
    resultHash.classList.add('hidden');
    resultHashToggle.textContent = '查看区块链永久凭证';
  });
}

contentInput.addEventListener('input', () => {
  countEl.textContent = `${contentInput.value.length} / 200`;
});

submitBtn.addEventListener('click', async () => {
  if (submitting) return;

  if (!uploadedImageObjectKey && !uploadedImageUrl) {
    showError('请先添加一张照片。');
    return;
  }

  openConfirmOverlay();
});

if (cancelSubmitBtn) {
  cancelSubmitBtn.addEventListener('click', () => {
    if (submitting) return;
    closeConfirmOverlay();
  });
}

if (confirmOverlay) {
  confirmOverlay.addEventListener('click', (event) => {
    if (event.target === confirmOverlay || event.target.classList.contains('overlay-mask')) {
      if (submitting) return;
      closeConfirmOverlay();
    }
  });
}

async function submitRecord() {
  if (submitting) return;
  const content = contentInput.value.trim();
  const saveMode = getSaveMode();
  submitting = true;
  confirmSubmitBtn.classList.add('btn-glow');
  window.setTimeout(() => confirmSubmitBtn.classList.remove('btn-glow'), 220);
  closeConfirmOverlay();

  stageHint.textContent = saveMode === 'co_create' ? '正在开启共创…' : '正在保存这一刻…';
  stageHint.classList.remove('hidden');
  formSection.classList.add('content-fade-out');

  const startAt = Date.now();
  const minimumDelayMs = 650;

  submitBtn.disabled = true;
  submitBtn.textContent = '正在保存...';
  showError('');

  try {
    const res = await apiRequest(`/api/qr/${encodeURIComponent(qrId)}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        mode: saveMode,
        image_url: uploadedStorageMode === 'cloud' ? null : uploadedImageUrl,
        image_object_key: uploadedImageObjectKey,
        show_brand_disclosure: showBrandDisclosureInput ? showBrandDisclosureInput.checked : false
      })
    });

    const elapsed = Date.now() - startAt;
    const remain = Math.max(0, minimumDelayMs - elapsed);
    window.setTimeout(() => {
      stageHint.classList.add('hidden');
      formSection.classList.remove('content-fade-out');
      if (res.data.activation_status === 'co_creating') {
        renderCoCreate(res.data);
      } else {
        renderResult(res.data, { justSaved: true });
      }
      submitting = false;
    }, remain);
  } catch (error) {
    stageHint.classList.add('hidden');
    formSection.classList.remove('content-fade-out');
    showError(error.message || '提交失败，请检查网络后重试');
    submitBtn.disabled = false;
    submitBtn.textContent = '预览并确认';
    submitting = false;
  }
}

if (confirmSubmitBtn) {
  confirmSubmitBtn.addEventListener('click', () => {
    if (confirmOverlayMode === 'finalize') {
      finalizeCoCreate();
      return;
    }
    submitRecord();
  });
}

if (commentContent) {
  commentContent.addEventListener('input', () => {
    commentCount.textContent = `${commentContent.value.length} / 50`;
  });
}

if (submitCommentBtn) {
  submitCommentBtn.addEventListener('click', async () => {
    const authorName = commentAuthor.value.trim();
    const content = commentContent.value.trim();
    if (!authorName) {
      coCreateMessage.textContent = '请填写姓名或身份。';
      return;
    }
    if (!content) {
      coCreateMessage.textContent = '请写一句留言。';
      return;
    }

    submitCommentBtn.disabled = true;
    coCreateMessage.textContent = '';
    try {
      await apiRequest(`/api/qr/${encodeURIComponent(qrId)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author_name: authorName,
          content
        })
      });
      commentContent.value = '';
      commentCount.textContent = '0 / 50';
      coCreateMessage.textContent = '留言已保存，等待发起人确认封存。';
      await loadQRStatus();
    } catch (error) {
      coCreateMessage.textContent = error.message || '提交失败，请稍后重试。';
    } finally {
      submitCommentBtn.disabled = false;
    }
  });
}

if (commentsList) {
  commentsList.addEventListener('click', async (event) => {
    const button = event.target.closest('.comment-delete');
    if (!button || !currentCoCreate || !currentCoCreate.is_co_creation_owner) return;
    const confirmed = window.confirm('确认删除这条共创留言吗？');
    if (!confirmed) return;

    button.disabled = true;
    try {
      const res = await apiRequest(`/api/qr/${encodeURIComponent(qrId)}/comments/${encodeURIComponent(button.dataset.commentId)}`, {
        method: 'DELETE'
      });
      renderCoCreate(res.data);
    } catch (error) {
      coCreateMessage.textContent = error.message || '删除失败，请稍后重试。';
      button.disabled = false;
    }
  });
}

async function finalizeCoCreate() {
  if (submitting || !currentCoCreate || !currentCoCreate.is_co_creation_owner) return;

  submitting = true;
  if (confirmSubmitBtn) {
    confirmSubmitBtn.disabled = true;
    confirmSubmitBtn.textContent = '正在封存...';
  }
  if (finalizeCoCreateBtn) {
    finalizeCoCreateBtn.disabled = true;
    finalizeCoCreateBtn.textContent = '正在封存...';
  }
  closeConfirmOverlay();

  try {
    const res = await apiRequest(`/api/qr/${encodeURIComponent(qrId)}/finalize`, {
      method: 'POST'
    });
    renderResult(res.data, { justSaved: true });
    submitting = false;
  } catch (error) {
    coCreateMessage.textContent = error.message || '封存失败，请稍后重试。';
    if (finalizeCoCreateBtn) {
      finalizeCoCreateBtn.disabled = false;
      finalizeCoCreateBtn.textContent = '确认封存';
    }
    if (confirmSubmitBtn) {
      confirmSubmitBtn.disabled = false;
      confirmSubmitBtn.textContent = '确认封存';
    }
    submitting = false;
  }
}

if (finalizeCoCreateBtn) {
  finalizeCoCreateBtn.addEventListener('click', () => {
    if (!currentCoCreate || !currentCoCreate.is_co_creation_owner || submitting) return;
    openConfirmOverlay('finalize');
  });
}

if (coCreateShareBtn) {
  coCreateShareBtn.addEventListener('click', async () => {
    const payload = {
      title: '星星在闪｜邀请你共创这瓶酒的记录',
      text: '这瓶酒正在共创中，来留下一句话吧。',
      url: window.location.href
    };

    try {
      if (navigator.share) {
        await navigator.share(payload);
        return;
      }
      await copyText(payload.url);
      alert('链接已复制，可以发送给朋友');
    } catch (_error) {
      // 用户取消系统分享时不做打扰。
    }
  });
}

shareBtn.addEventListener('click', async () => {
  if (!currentResult || !currentResult.qr_id) {
    alert('请先完成保存后再分享。');
    return;
  }

  try {
    const res = await apiRequest(`/api/nft/${encodeURIComponent(currentResult.qr_id)}/share-meta`);
    const payload = {
      title: res.data.title,
      text: res.data.text,
      url: res.data.url
    };

    if (navigator.share) {
      await navigator.share(payload);
      return;
    }

    await copyText(payload.url);
    alert('链接已复制，可以发送给朋友');
  } catch (error) {
    alert(error.message || '分享失败，请稍后重试。');
  }
});
