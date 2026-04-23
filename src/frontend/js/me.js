const currentPhoneText = document.getElementById('currentPhoneText');
const switchPhoneBtn = document.getElementById('switchPhoneBtn');
const pageMessage = document.getElementById('pageMessage');
const emptySection = document.getElementById('emptySection');
const recordsSection = document.getElementById('recordsSection');

function maskPhone(phone) {
  const value = String(phone || '').trim();
  if (!/^1\d{10}$/.test(value)) {
    return value || '未登录';
  }
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    emptySection.classList.remove('hidden');
    recordsSection.classList.add('hidden');
    recordsSection.innerHTML = '';
    return;
  }

  emptySection.classList.add('hidden');
  recordsSection.classList.remove('hidden');
  recordsSection.innerHTML = records.map((item) => `
    <article class="card record-item">
      <img class="record-cover" src="${item.image_url || ''}" alt="点亮图片" />
      <div class="record-body">
        <p class="record-content">${item.content || '（未填写文字）'}</p>
        <p class="qr-id-hint">点亮时间：${formatTime(item.activated_at)}</p>
        <p class="qr-id-hint">二维码序号：<strong>${item.id || ''}</strong></p>
        <a class="btn btn-secondary" href="/me-detail.html?id=${encodeURIComponent(item.id || '')}">查看详情</a>
      </div>
    </article>
  `).join('');
}

async function loadMyRecords() {
  try {
    const me = await apiRequest('/api/user/me');
    const phone = me.data.phone || '';
    currentPhoneText.textContent = maskPhone(phone);

    const res = await apiRequest('/api/user/records');
    renderRecords(res.data.records || []);
    pageMessage.textContent = '';
  } catch (error) {
    if (error.code === 'UNAUTHORIZED') {
      window.location.href = '/register.html';
      return;
    }
    pageMessage.textContent = error.message || '加载失败，请稍后重试';
  }
}

if (switchPhoneBtn) {
  switchPhoneBtn.addEventListener('click', async () => {
    const confirmed = window.confirm('确认更换手机号吗？更换后需要重新注册。');
    if (!confirmed) return;

    try {
      await apiRequest('/api/user/logout', { method: 'POST' });
    } catch (_error) {
      // 忽略错误，直接跳转注册
    }
    window.location.href = '/register.html';
  });
}

loadMyRecords();
