const formSection = document.getElementById('formSection');
const resultSection = document.getElementById('resultSection');
const qrIdText = document.getElementById('qrIdText');
const imageInput = document.getElementById('imageInput');
const preview = document.getElementById('preview');
const contentInput = document.getElementById('content');
const countEl = document.getElementById('count');
const showBrandDisclosureInput = document.getElementById('showBrandDisclosure');
const brandSection = document.getElementById('brandSection');
const brandPreviewText = document.getElementById('brandPreviewText');
const submitBtn = document.getElementById('submitBtn');
const formMessage = document.getElementById('formMessage');
const downloadBtn = document.getElementById('downloadBtn');
const shareBtn = document.getElementById('shareBtn');

const resultImage = document.getElementById('resultImage');
const resultContent = document.getElementById('resultContent');
const resultHash = document.getElementById('resultHash');
const resultTime = document.getElementById('resultTime');
const resultBrandDisclosure = document.getElementById('resultBrandDisclosure');
const resultBrandName = document.getElementById('resultBrandName');
const resultBrandDisclosureText = document.getElementById('resultBrandDisclosureText');

const params = new URLSearchParams(window.location.search);
const qrId = params.get('t') || params.get('qr');
const userPhone = localStorage.getItem('userPhone');

let uploadedImageUrl = '';
let uploadedImageObjectKey = '';
let uploadedStorageMode = '';
let currentResult = null;

function showError(message) {
  formMessage.textContent = message;
}

function renderResult(data) {
  currentResult = data;
  formSection.classList.add('hidden');
  resultSection.classList.remove('hidden');

  resultImage.src = data.image_url;
  resultContent.textContent = data.content || '（未填写文字）';
  resultHash.textContent = data.blockchain_hash;
  resultTime.textContent = new Date(data.activated_at).toLocaleString('zh-CN', { hour12: false });

  // 品牌露出：品牌名称 + 品牌文案作为一组，用户勾选了且有快照文案时一起显示
  if (data.show_brand_disclosure && data.brand_disclosure_text_snapshot) {
    resultBrandName.textContent = data.brand_name || '';
    resultBrandDisclosureText.textContent = data.brand_disclosure_text_snapshot;
    resultBrandDisclosure.classList.remove('hidden');
  } else {
    resultBrandDisclosure.classList.add('hidden');
  }
}

async function loadQRStatus() {
  if (!qrId) {
    formSection.classList.remove('hidden');
    showError('未找到星星编号，请重新扫码。');
    return;
  }

  qrIdText.textContent = qrId;

  try {
    const res = await apiRequest(`/api/qr/${encodeURIComponent(qrId)}`);
    // 用真实的序号 ID（如 OSSC00001）替换 token 显示
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
      });
      return;
    }

    // 根据 batch 的 brand_disclosure_text 决定是否显示品牌露出开关
    if (res.data.batch_id && res.data.batch_brand_disclosure_text) {
      brandSection.classList.remove('hidden');
      showBrandDisclosureInput.checked = !!res.data.batch_brand_disclosure_default;
      // 显示品牌名称 + 品牌文案预览
      const previewParts = [];
      if (res.data.batch_brand_name) previewParts.push(res.data.batch_brand_name);
      previewParts.push(res.data.batch_brand_disclosure_text);
      brandPreviewText.textContent = previewParts.join(' - ');
    }

    formSection.classList.remove('hidden');
  } catch (error) {
    formSection.classList.remove('hidden');
    showError(error.message || '加载失败，请重新扫码或检查网络');
  }
}

if (!userPhone) {
  window.location.href = `/register.html?t=${encodeURIComponent(qrId || '')}`;
} else {
  loadQRStatus();
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

    uploadedImageUrl = res.data.url; // cloud 模式下为 null，local 模式下为本地路径
    uploadedImageObjectKey = res.data.object_key || '';
    uploadedStorageMode = res.data.storage_mode || 'local';

    const previewSrc = res.data.preview_url || '';
    if (previewSrc) {
      preview.src = previewSrc;
      preview.classList.remove('hidden');
    }
    showError('图片上传成功。');
  } catch (error) {
    showError(error.message || '上传失败，请换张图片试试');
  }
});

contentInput.addEventListener('input', () => {
  countEl.textContent = `${contentInput.value.length} / 200`;
});

submitBtn.addEventListener('click', async () => {
  const content = contentInput.value.trim();

  if (!uploadedImageObjectKey && !uploadedImageUrl) {
    showError('请先上传一张照片再点亮。');
    return;
  }

  submitBtn.disabled = true;
  showError('正在点亮，请稍候...');

  try {
    const res = await apiRequest(`/api/qr/${encodeURIComponent(qrId)}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        image_url: uploadedStorageMode === 'cloud' ? null : uploadedImageUrl,
        image_object_key: uploadedImageObjectKey,
        phone: userPhone,
        show_brand_disclosure: showBrandDisclosureInput ? showBrandDisclosureInput.checked : false
      })
    });

    renderResult(res.data);
  } catch (error) {
    showError(error.message || '提交失败，请检查网络后重试');
    submitBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', async () => {
  if (!currentResult || !currentResult.qr_id) {
    alert('请先完成点亮后再下载。');
    return;
  }

  try {
    const res = await apiRequest(`/api/nft/${encodeURIComponent(currentResult.qr_id)}/download`);
    if (res.data && res.data.download_url) {
      window.open(res.data.download_url, '_blank');
      return;
    }
    alert('暂未生成可下载链接，请稍后再试。');
  } catch (error) {
    alert(error.message || '下载失败，请稍后再试。');
  }
});

shareBtn.addEventListener('click', async () => {
  if (!currentResult || !currentResult.qr_id) {
    alert('请先完成点亮后再分享。');
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

    await navigator.clipboard.writeText(payload.url);
    alert('分享链接已复制，快发给朋友吧！');
  } catch (error) {
    alert(error.message || '分享失败，请稍后重试。');
  }
});
