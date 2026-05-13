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
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function renderRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    emptySection.classList.remove('hidden');
    recordsSection.classList.add('hidden');
    recordsSection.replaceChildren();
    return;
  }

  emptySection.classList.add('hidden');
  recordsSection.classList.remove('hidden');
  recordsSection.replaceChildren();

  records.forEach((item) => {
    const isCoCreating = item.activation_status === 'co_creating';
    const displayTime = item.display_at || item.activated_at;

    const article = document.createElement('article');
    article.className = 'card record-item';

    const image = document.createElement('img');
    image.className = 'record-cover';
    image.alt = '保存的照片';
    image.src = item.image_url || '';

    const body = document.createElement('div');
    body.className = 'record-body';

    const content = document.createElement('p');
    content.className = 'record-content';
    content.textContent = item.content || '（未填写留言）';

    const timeHint = document.createElement('p');
    timeHint.className = 'qr-id-hint';
    timeHint.textContent = `保存时间：${formatTime(displayTime)}`;

    const statusHint = document.createElement('p');
    statusHint.className = 'qr-id-hint record-status-hint';
    statusHint.textContent = isCoCreating ? '状态：共创中' : '';

    const idHint = document.createElement('p');
    idHint.className = 'qr-id-hint';
    idHint.textContent = '二维码编号：';
    const idStrong = document.createElement('strong');
    idStrong.textContent = item.id || '';
    idHint.appendChild(idStrong);

    const detailLink = document.createElement('a');
    detailLink.className = 'btn btn-secondary';
    if (isCoCreating) {
      detailLink.textContent = '继续共创';
      detailLink.href = `/record.html?t=${encodeURIComponent(item.id || '')}`;
    } else {
      detailLink.textContent = '查看详情';
      detailLink.href = `/me-detail.html?id=${encodeURIComponent(item.id || '')}`;
    }

    body.appendChild(content);
    body.appendChild(timeHint);
    if (isCoCreating) {
      body.appendChild(statusHint);
    }
    body.appendChild(idHint);
    body.appendChild(detailLink);
    article.appendChild(image);
    article.appendChild(body);
    recordsSection.appendChild(article);
  });
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
    const confirmed = window.confirm('确认更换手机号吗？更换后会退出当前设备登录状态，需要重新验证手机号。');
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
