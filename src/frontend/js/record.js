const formSection = document.getElementById('formSection');
const resultSection = document.getElementById('resultSection');
const qrIdText = document.getElementById('qrIdText');
const imageInput = document.getElementById('imageInput');
const preview = document.getElementById('preview');
const contentInput = document.getElementById('content');
const countEl = document.getElementById('count');
const submitBtn = document.getElementById('submitBtn');
const formMessage = document.getElementById('formMessage');

const resultImage = document.getElementById('resultImage');
const resultContent = document.getElementById('resultContent');
const resultHash = document.getElementById('resultHash');
const resultTime = document.getElementById('resultTime');

const params = new URLSearchParams(window.location.search);
const qrId = params.get('qr');
const userPhone = localStorage.getItem('userPhone');

let uploadedImageUrl = '';

function showError(message) {
  formMessage.textContent = message;
}

function renderResult(data) {
  formSection.classList.add('hidden');
  resultSection.classList.remove('hidden');

  resultImage.src = data.image_url;
  resultContent.textContent = data.content || '（未填写文字）';
  resultHash.textContent = data.blockchain_hash;
  resultTime.textContent = new Date(data.activated_at).toLocaleString('zh-CN', { hour12: false });
}

async function loadQRStatus() {
  if (!qrId) {
    showError('未找到星星编号，请重新扫码。');
    return;
  }

  qrIdText.textContent = qrId;

  try {
    const res = await apiRequest(`/api/qr/${encodeURIComponent(qrId)}`);
    if (res.data.activation_status === 'activated') {
      renderResult({
        image_url: res.data.image_url,
        content: res.data.content,
        blockchain_hash: res.data.blockchain_hash,
        activated_at: res.data.activated_at
      });
      return;
    }

    formSection.classList.remove('hidden');
  } catch (error) {
    showError(error.message || '加载失败，请稍后再试。');
  }
}

if (!userPhone) {
  window.location.href = `/register.html?qr=${encodeURIComponent(qrId || '')}`;
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

  try {
    const res = await apiRequest('/api/upload', {
      method: 'POST',
      body: formData
    });

    uploadedImageUrl = res.data.url;
    preview.src = uploadedImageUrl;
    preview.classList.remove('hidden');
    showError('图片上传成功。');
  } catch (error) {
    showError(error.message || '上传失败，请重试。');
  }
});

contentInput.addEventListener('input', () => {
  countEl.textContent = `${contentInput.value.length} / 200`;
});

submitBtn.addEventListener('click', async () => {
  const content = contentInput.value.trim();

  if (!uploadedImageUrl) {
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
        image_url: uploadedImageUrl,
        phone: userPhone
      })
    });

    renderResult(res.data);
  } catch (error) {
    showError(error.message || '提交失败，请稍后重试。');
    submitBtn.disabled = false;
  }
});
