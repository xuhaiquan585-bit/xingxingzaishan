const pageIntro = document.getElementById('pageIntro');
const formSection = document.getElementById('formSection');
const resultSection = document.getElementById('resultSection');
const qrIdText = document.getElementById('qrIdText');
const uploadArea = document.getElementById('uploadArea');
const imageInput = document.getElementById('imageInput');
const preview = document.getElementById('preview');
const changePhotoBtn = document.getElementById('changePhotoBtn');
const uploadFeedback = document.getElementById('uploadFeedback');
const uploadFeedbackText = document.getElementById('uploadFeedbackText');
const uploadActionText = document.getElementById('uploadActionText');
const contentInput = document.getElementById('content');
const countEl = document.getElementById('count');
const showBrandDisclosureInput = document.getElementById('showBrandDisclosure');
const brandSection = document.getElementById('brandSection');
const brandPreviewText = document.getElementById('brandPreviewText');
const submitBtn = document.getElementById('submitBtn');
const formMessage = document.getElementById('formMessage');
const currentPhoneText = document.getElementById('currentPhoneText');
const switchPhoneBtn = document.getElementById('switchPhoneBtn');

const shareBtn = document.getElementById('shareBtn');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmSubmitBtn = document.getElementById('confirmSubmitBtn');
const cancelSubmitBtn = document.getElementById('cancelSubmitBtn');
const confirmPreviewImage = document.getElementById('confirmPreviewImage');
const confirmPreviewContent = document.getElementById('confirmPreviewContent');
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

const params = new URLSearchParams(window.location.search);
const qrId = params.get('t') || params.get('qr');
let userPhone = '';

let uploadedImageUrl = '';
let uploadedImageObjectKey = '';
let uploadedStorageMode = '';
let currentResult = null;
let submitting = false;
let hashExpanded = false;

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
    resultSection.classList.remove('hidden');
    return;
  }

  if (pageIntro) pageIntro.classList.remove('hidden');
  resultSection.classList.add('hidden');
  formSection.classList.remove('hidden');
}

function renderResult(data, { justSaved = false } = {}) {
  currentResult = data;
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
  hashExpanded = false;
  const blockchainHash = String(data.blockchain_hash || '').trim();
  resultHashValue.textContent = blockchainHash;
  resultHash.classList.add('hidden');
  resultHashToggle.disabled = !blockchainHash;
  resultHashToggle.textContent = blockchainHash
    ? '查看永久记录凭证'
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

function openConfirmOverlay() {
  if (!confirmOverlay) return;

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
        show_brand_disclosure: res.data.show_brand_disclosure,
        brand_disclosure_text_snapshot: res.data.brand_disclosure_text_snapshot,
        brand_name: res.data.batch_brand_name || ''
      }, { justSaved: false });
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

if (uploadArea) {
  uploadArea.addEventListener('click', () => {
    if (submitting) return;
    imageInput.click();
  });
}

if (changePhotoBtn) {
  changePhotoBtn.addEventListener('click', () => {
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
    if (uploadArea) {
      uploadArea.classList.add('hidden');
    }
    if (changePhotoBtn) {
      changePhotoBtn.classList.remove('hidden');
    }
    uploadFeedbackText.textContent = '已选择照片';
    if (uploadActionText) {
      uploadActionText.textContent = '添加照片';
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
    if (changePhotoBtn) {
      changePhotoBtn.classList.add('hidden');
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
    resultHashToggle.textContent = '查看永久记录凭证';
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
  submitting = true;
  confirmSubmitBtn.classList.add('btn-glow');
  window.setTimeout(() => confirmSubmitBtn.classList.remove('btn-glow'), 220);
  closeConfirmOverlay();

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
      renderResult(res.data, { justSaved: true });
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
  confirmSubmitBtn.addEventListener('click', submitRecord);
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
