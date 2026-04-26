const currentPhoneText = document.getElementById('currentPhoneText');
const switchPhoneBtn = document.getElementById('switchPhoneBtn');
const detailMessage = document.getElementById('detailMessage');

const detailSection = document.getElementById('detailSection');
const detailImage = document.getElementById('detailImage');
const detailContent = document.getElementById('detailContent');
const detailTime = document.getElementById('detailTime');
const detailId = document.getElementById('detailId');
const detailHash = document.getElementById('detailHash');
const detailBrand = document.getElementById('detailBrand');

const params = new URLSearchParams(window.location.search);
const recordId = params.get('id') || '';

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

function renderDetail(record) {
  detailImage.src = record.image_url || '';
  detailContent.textContent = record.content || '（未填写文字）';
  detailTime.textContent = formatTime(record.activated_at);
  detailId.textContent = record.id || '';
  detailHash.textContent = record.blockchain_hash || '-';

  if (record.show_brand_disclosure && record.brand_disclosure_text_snapshot) {
    const brandName = record.brand_name || '';
    detailBrand.textContent = brandName
      ? `${brandName} - ${record.brand_disclosure_text_snapshot}`
      : record.brand_disclosure_text_snapshot;
    detailBrand.classList.remove('hidden');
  } else {
    detailBrand.classList.add('hidden');
  }
  detailSection.classList.remove('hidden');
}

async function loadDetail() {
  if (!recordId) {
    detailMessage.textContent = '缺少记录编号，请返回重试。';
    return;
  }

  try {
    const me = await apiRequest('/api/user/me');
    currentPhoneText.textContent = maskPhone(me.data.phone || '');

    const detailRes = await apiRequest(`/api/user/records/${encodeURIComponent(recordId)}`);
    renderDetail(detailRes.data || {});
    detailMessage.textContent = '';
  } catch (error) {
    if (error.code === 'UNAUTHORIZED') {
      window.location.href = '/register.html';
      return;
    }
    if (error.code === 'RECORD_NOT_FOUND') {
      detailMessage.textContent = '未找到该记录，或你无权查看。';
      return;
    }
    detailMessage.textContent = error.message || '加载失败，请稍后重试';
  }
}

if (switchPhoneBtn) {
  switchPhoneBtn.addEventListener('click', async () => {
    const confirmed = window.confirm('确认更换手机号吗？更换后会退出当前设备登录状态，需要重新验证手机号。');
    if (!confirmed) return;

    try {
      await apiRequest('/api/user/logout', { method: 'POST' });
    } catch (_error) {
      // 忽略退出失败，直接跳转注册
    }
    window.location.href = '/register.html';
  });
}

loadDetail();
