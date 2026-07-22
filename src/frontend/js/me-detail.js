const currentPhoneText = document.getElementById('currentPhoneText');
const switchPhoneBtn = document.getElementById('switchPhoneBtn');
const detailMessage = document.getElementById('detailMessage');

const detailSection = document.getElementById('detailSection');
const detailHeaderId = document.getElementById('detailHeaderId');
const detailImage = document.getElementById('detailImage');
const detailContent = document.getElementById('detailContent');
const detailComments = document.getElementById('detailComments');
const detailTime = document.getElementById('detailTime');
const detailChainStatus = document.getElementById('detailChainStatus');
const detailHashGroup = document.getElementById('detailHashGroup');
const detailHash = document.getElementById('detailHash');
const copyHashBtn = document.getElementById('copyHashBtn');
const toggleHashBtn = document.getElementById('toggleHashBtn');
const detailCertificateLink = document.getElementById('detailCertificateLink');
const hashMessage = document.getElementById('hashMessage');
const detailBrandGroup = document.getElementById('detailBrandGroup');
const detailBrand = document.getElementById('detailBrand');

const params = new URLSearchParams(window.location.search);
const recordId = params.get('id') || '';
let currentHash = '';
let hashExpanded = false;
let hashMessageTimer = null;

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

function getRecordHash(record = {}) {
  return String(record.manifest_hash || record.blockchain_hash || '').trim();
}

function formatHashSummary(hash) {
  const value = String(hash || '').trim();
  if (!value) return '';
  if (value.length <= 24) return value;
  return `${value.slice(0, 12)}…${value.slice(-6)}`;
}

function getSafeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
  } catch (_error) {
    return '';
  }
}

function setHashExpanded(expanded) {
  hashExpanded = expanded === true;
  if (!detailHash || !toggleHashBtn) return;

  detailHash.textContent = hashExpanded ? currentHash : formatHashSummary(currentHash);
  detailHash.classList.toggle('is-expanded', hashExpanded);
  toggleHashBtn.textContent = hashExpanded ? '收起完整哈希' : '查看完整哈希';
  toggleHashBtn.classList.toggle('hidden', !currentHash || currentHash.length <= 24);
}

function showHashMessage(text) {
  if (!hashMessage) return;
  window.clearTimeout(hashMessageTimer);
  hashMessage.textContent = text || '';
  hashMessage.classList.toggle('hidden', !text);
  if (text) {
    hashMessageTimer = window.setTimeout(() => {
      hashMessage.textContent = '';
      hashMessage.classList.add('hidden');
    }, 2600);
  }
}

async function copyTextWithFallback(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_error) {
      // Fall through to the textarea copy path for embedded browsers.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
  if (!copied) {
    throw new Error('copy failed');
  }
}

function renderComments(comments = []) {
  detailComments.textContent = '';
  const visible = (Array.isArray(comments) ? comments : [])
    .filter((item) => item && item.content)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (visible.length === 0) {
    detailComments.classList.add('hidden');
    return;
  }

  const title = document.createElement('p');
  title.className = 'section-title';
  title.textContent = '共创留言';
  detailComments.appendChild(title);

  const list = document.createElement('div');
  list.className = 'comments-list';
  visible.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'comment-item';

    const head = document.createElement('div');
    head.className = 'comment-head';
    const author = document.createElement('strong');
    author.textContent = item.author_name || '匿名';
    const time = document.createElement('span');
    time.textContent = formatTime(item.created_at);
    head.append(author, time);

    const content = document.createElement('p');
    content.textContent = item.content || '';
    row.append(head, content);
    list.appendChild(row);
  });
  detailComments.appendChild(list);
  detailComments.classList.remove('hidden');
}

function renderDetail(record) {
  const displayId = record.id || recordId || '';
  detailHeaderId.textContent = displayId;
  detailImage.src = record.image_url || '';
  detailContent.textContent = record.content || '（未填写留言）';
  detailTime.textContent = formatTime(record.activated_at);
  detailChainStatus.textContent = record.chain_status_text || '存证生成中';
  renderComments(record.co_creation_comments || []);

  currentHash = getRecordHash(record);
  const certificateUrl = getSafeHttpUrl(record.chain_certificate_url);
  if (currentHash || certificateUrl) {
    detailHashGroup.classList.remove('hidden');
    if (currentHash) {
      detailHash.classList.remove('hidden');
      copyHashBtn.classList.remove('hidden');
      setHashExpanded(false);
    } else {
      detailHash.textContent = '';
      detailHash.classList.add('hidden');
      copyHashBtn.classList.add('hidden');
      toggleHashBtn.classList.add('hidden');
    }

    if (certificateUrl) {
      detailCertificateLink.href = certificateUrl;
      detailCertificateLink.classList.remove('hidden');
    } else {
      detailCertificateLink.removeAttribute('href');
      detailCertificateLink.classList.add('hidden');
    }
  } else {
    detailHash.textContent = '';
    detailHashGroup.classList.add('hidden');
    copyHashBtn.classList.add('hidden');
    toggleHashBtn.classList.add('hidden');
    detailCertificateLink.removeAttribute('href');
    detailCertificateLink.classList.add('hidden');
  }
  showHashMessage('');

  const brandDisclosureText = String(record.brand_disclosure_text_snapshot || '').trim();
  if (record.show_brand_disclosure && brandDisclosureText) {
    const brandName = String(record.brand_name || '').trim();
    detailBrand.textContent = brandName
      ? `${brandName} · ${brandDisclosureText}`
      : brandDisclosureText;
    detailBrandGroup.classList.remove('hidden');
  } else {
    detailBrand.textContent = '';
    detailBrandGroup.classList.add('hidden');
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

if (toggleHashBtn) {
  toggleHashBtn.addEventListener('click', () => {
    if (!currentHash) return;
    setHashExpanded(!hashExpanded);
  });
}

if (copyHashBtn) {
  copyHashBtn.addEventListener('click', async () => {
    if (!currentHash) return;
    try {
      await copyTextWithFallback(currentHash);
      showHashMessage('已复制存证哈希');
    } catch (_error) {
      showHashMessage('复制失败，请长按选择复制');
    }
  });
}

loadDetail();
