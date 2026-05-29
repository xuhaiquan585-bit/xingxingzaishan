const loginPanel = document.getElementById('loginPanel');
const adminShell = document.getElementById('adminShell');
const navItems = Array.from(document.querySelectorAll('[data-admin-section]'));
const adminPanels = Array.from(document.querySelectorAll('[data-admin-panel]'));
const loginMsg = document.getElementById('loginMsg');
const batchMsg = document.getElementById('batchMsg');
const opMsg = document.getElementById('opMsg');
const productMsg = document.getElementById('productMsg');
const recordMsg = document.getElementById('recordMsg');
const miniappContentMsg = document.getElementById('miniappContentMsg');
const systemMsg = document.getElementById('systemMsg');
const tableBody = document.getElementById('recordTable');
const contentRecordTableBody = document.getElementById('contentRecordTable');
const batchTableBody = document.getElementById('batchTable');
const operatorTableBody = document.getElementById('operatorTable');
const productTableBody = document.getElementById('productTable');
const selectedCount = document.getElementById('selectedCount');
const selectAll = document.getElementById('selectAll');

let adminToken = localStorage.getItem('adminToken') || '';
let activeSection = localStorage.getItem('adminActiveSection') || 'dashboard';
let currentRecords = [];
let batchList = [];
let productList = [];
let editingProductId = '';
const selectedIds = new Set();
const REQUEST_TIMEOUT_MS = 15000;
const EXPORT_TIMEOUT_MS = 60000;

function authHeaders() {
  return {
    Authorization: `Bearer ${adminToken}`
  };
}

async function request(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const json = await parseJsonResponse(response);
  if (!response.ok || json.status !== 'success') {
    throw new Error(json.message || '请求失败，请稍后重试');
  }
  return json.data;
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, signal: externalSignal, ...fetchOptions } = options;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
  } catch (_error) {
    if (controller.signal.aborted && !(externalSignal && externalSignal.aborted)) {
      throw new Error('请求超时，请检查网络后重试');
    }
    throw new Error('网络连接失败，请检查网络后重试');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function parseJsonResponse(response) {
  try {
    return await response.json();
  } catch (_error) {
    throw new Error('服务器暂时繁忙，请稍后再试');
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function showPanelsAfterLogin() {
  loginPanel.classList.add('hidden');
  adminShell.classList.remove('hidden');
  activateAdminSection(activeSection);
}

function activateAdminSection(section) {
  activeSection = section || 'dashboard';
  localStorage.setItem('adminActiveSection', activeSection);
  navItems.forEach((item) => {
    item.classList.toggle('active', item.dataset.adminSection === activeSection);
  });
  adminPanels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.adminPanel !== activeSection);
  });
  loadActiveSection().catch((error) => {
    if (error.message === '请先登录后台账号。') {
      localStorage.removeItem('adminToken');
      location.reload();
      return;
    }
    const targetMsg = {
      dashboard: loginMsg,
      bottles: batchMsg,
      records: recordMsg,
      miniappContent: miniappContentMsg,
      products: productMsg,
      operators: opMsg,
      settings: systemMsg
    }[activeSection];
    if (targetMsg) targetMsg.textContent = error.message || '加载失败';
  });
}

async function loadActiveSection() {
  if (activeSection === 'dashboard') {
    await loadDashboard();
    return;
  }
  if (activeSection === 'bottles') {
    await loadBatches();
    await loadRecords();
    return;
  }
  if (activeSection === 'records') {
    if (batchList.length === 0) await loadBatches();
    await loadContentRecords();
    return;
  }
  if (activeSection === 'miniappContent') {
    await loadMiniappContent();
    return;
  }
  if (activeSection === 'products') {
    await loadProducts();
    return;
  }
  if (activeSection === 'operators') {
    await loadOperators();
    return;
  }
  if (activeSection === 'settings') {
    await loadSystemStatus();
  }
}

function updateSelectedUI() {
  selectedCount.textContent = `已选 ${selectedIds.size} 条`;
  const currentIds = currentRecords.map((item) => item.id);
  const allSelected = currentIds.length > 0 && currentIds.every((id) => selectedIds.has(id));
  selectAll.checked = allSelected;
}

function getBatchNote(batchId) {
  if (!batchId) return '-';
  const batch = batchList.find((b) => b.id === batchId);
  return batch && batch.note ? batch.note : '-';
}

function formatIssueStatus(status) {
  const map = {
    issued: '待记录',
    unissued: '未生成'
  };
  return map[status] || status || '-';
}

function formatActivationStatus(status) {
  const map = {
    activated: '已记录',
    co_creating: '共创中',
    unactivated: '待记录',
    content: '有内容记录'
  };
  return map[status] || status || '-';
}

function formatConfigured(value) {
  return value ? '已配置' : '未配置';
}

function renderBatchOptions() {
  const batchOptions = batchList
    .map((batch) => `<option value="${escapeHtml(batch.id)}">${escapeHtml(batch.name)} (${escapeHtml(batch.id)})</option>`)
    .join('');

  document.getElementById('batchFilter').innerHTML = `<option value="">批次（全部）</option>${batchOptions}`;
  document.getElementById('recordBatchFilter').innerHTML = `<option value="">批次（全部）</option>${batchOptions}`;
  document.getElementById('assignBatchSelect').innerHTML = `<option value="">选择批次后可绑定</option>${batchOptions}`;
  document.getElementById('qrBatchSelect').innerHTML = `<option value="">选择批次（选填）</option>${batchOptions}`;
}

function renderBatchRows() {
  batchTableBody.innerHTML = batchList
    .map((batch) => `<tr>
      <td>${escapeHtml(batch.id)}</td>
      <td>${escapeHtml(batch.name)}</td>
      <td>${escapeHtml(batch.brand_name || '-')}</td>
      <td>${escapeHtml(batch.note || '-')}</td>
      <td>${Number(batch.total_codes || 0)}</td>
      <td>${Number(batch.activation_rate || 0)}%</td>
      <td><button data-batch-export="${escapeHtml(batch.id)}">导出批次CSV</button></td>
    </tr>`)
    .join('');
}

async function loadBatches() {
  const data = await request('/api/admin/batches', { headers: authHeaders() });
  batchList = data.batches || [];
  renderBatchOptions();
  renderBatchRows();
}

async function createBatch() {
  const name = document.getElementById('batchName').value.trim();
  const brandName = document.getElementById('batchBrand').value.trim();
  const note = document.getElementById('batchNote').value.trim();
  const disclosureText = document.getElementById('batchDisclosureText').value.trim();
  const disclosureDefault = document.getElementById('batchDisclosureDefault').checked;

  if (!name) {
    batchMsg.textContent = '批次名称不能为空。';
    return;
  }

  await request('/api/admin/batches', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name,
      brand_name: brandName,
      note,
      brand_disclosure_text: disclosureText,
      brand_disclosure_default: disclosureDefault
    })
  });

  batchMsg.textContent = '批次创建成功。';
  document.getElementById('batchName').value = '';
  document.getElementById('batchBrand').value = '';
  document.getElementById('batchNote').value = '';
  document.getElementById('batchDisclosureText').value = '';
  document.getElementById('batchDisclosureDefault').checked = false;
  await loadBatches();
}

async function generateQRCodes() {
  const prefix = document.getElementById('qrPrefix').value.trim();
  const count = parseInt(document.getElementById('qrCount').value, 10);
  const batchId = document.getElementById('qrBatchSelect').value;

  if (!prefix) {
    batchMsg.textContent = '请输入二维码前缀。';
    return;
  }

  if (!count || count < 1) {
    batchMsg.textContent = '生成数量必须大于0。';
    return;
  }

  try {
    await request('/api/admin/qr/generate', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefix, count, batch_id: batchId || undefined })
    });
    batchMsg.textContent = `成功生成 ${count} 个二维码（前缀：${prefix}）。`;
    document.getElementById('qrPrefix').value = '';
    document.getElementById('qrCount').value = '10';
    await loadBatches();
    await loadRecords();
  } catch (error) {
    batchMsg.textContent = error.message || '二维码生成失败。';
  }
}

function renderOperators(operators) {
  operatorTableBody.innerHTML = operators
    .map((op) => {
      const action = op.enabled ? 'disable' : 'enable';
      const actionLabel = op.enabled ? '禁用' : '启用';
      return `<tr>
        <td>${escapeHtml(op.id)}</td>
        <td>${escapeHtml(op.name || '-')}</td>
        <td>${escapeHtml(op.username)}</td>
        <td>${escapeHtml(op.role)}</td>
        <td>${op.enabled ? '启用' : '禁用'}</td>
        <td>
          <button data-op-id="${escapeHtml(op.id)}" data-op-action="${action}">${actionLabel}</button>
          <button data-op-id="${escapeHtml(op.id)}" data-op-action="change-password">改密码</button>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadOperators() {
  const data = await request('/api/admin/operators', { headers: authHeaders() });
  renderOperators(data.operators || []);
}

function clearProductForm() {
  editingProductId = '';
  document.getElementById('productTitle').value = '';
  document.getElementById('productSubtitle').value = '';
  document.getElementById('productCover').value = '';
  document.getElementById('productPrice').value = '';
  document.getElementById('productBuyUrl').value = '';
  document.getElementById('productSort').value = '0';
  document.getElementById('productStatus').value = 'draft';
  document.getElementById('productImages').value = '';
  document.getElementById('productDescription').value = '';
  document.getElementById('saveProductBtn').textContent = '新增商品';
  document.getElementById('cancelProductEditBtn').classList.add('hidden');
}

function readProductForm() {
  return {
    title: document.getElementById('productTitle').value.trim(),
    subtitle: document.getElementById('productSubtitle').value.trim(),
    cover_image: document.getElementById('productCover').value.trim(),
    price_text: document.getElementById('productPrice').value.trim(),
    buy_url: document.getElementById('productBuyUrl').value.trim(),
    sort_order: Number(document.getElementById('productSort').value || 0),
    status: document.getElementById('productStatus').value,
    images: document.getElementById('productImages').value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
    description: document.getElementById('productDescription').value.trim()
  };
}

function renderProducts(products) {
  productTableBody.innerHTML = products
    .map((product) => `<tr>
      <td>${Number(product.sort_order || 0)}</td>
      <td>${escapeHtml(product.title)}<br /><small>${escapeHtml(product.subtitle || '')}</small></td>
      <td>${escapeHtml(product.price_text || '-')}</td>
      <td>${escapeHtml(product.status)}</td>
      <td>${product.buy_url ? `<a href="${escapeHtml(product.buy_url)}" target="_blank" rel="noreferrer">查看链接</a>` : '-'}</td>
      <td>${escapeHtml(product.updated_at || product.created_at || '-')}</td>
      <td><button data-product-edit="${escapeHtml(product.id)}">编辑</button></td>
    </tr>`)
    .join('');
}

async function loadProducts() {
  const data = await request('/api/admin/products', { headers: authHeaders() });
  productList = data.products || [];
  renderProducts(productList);
}

async function saveProduct() {
  const payload = readProductForm();
  if (!payload.title) {
    productMsg.textContent = '商品名称不能为空。';
    return;
  }

  const url = editingProductId
    ? `/api/admin/products/${encodeURIComponent(editingProductId)}`
    : '/api/admin/products';

  await request(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  productMsg.textContent = editingProductId ? '商品已更新。' : '商品已新增。';
  clearProductForm();
  await loadProducts();
}

function editProduct(productId) {
  const product = productList.find((item) => item.id === productId);
  if (!product) return;
  editingProductId = product.id;
  document.getElementById('productTitle').value = product.title || '';
  document.getElementById('productSubtitle').value = product.subtitle || '';
  document.getElementById('productCover').value = product.cover_image || '';
  document.getElementById('productPrice').value = product.price_text || '';
  document.getElementById('productBuyUrl').value = product.buy_url || '';
  document.getElementById('productSort').value = Number(product.sort_order || 0);
  document.getElementById('productStatus').value = product.status || 'draft';
  document.getElementById('productImages').value = Array.isArray(product.images) ? product.images.join('\n') : '';
  document.getElementById('productDescription').value = product.description || '';
  document.getElementById('saveProductBtn').textContent = '保存修改';
  document.getElementById('cancelProductEditBtn').classList.remove('hidden');
  productMsg.textContent = `正在编辑：${product.title}`;
}

async function createOperator() {
  const name = document.getElementById('opName').value.trim();
  const username = document.getElementById('opUsername').value.trim();
  const password = document.getElementById('opPassword').value.trim();
  const role = document.getElementById('opRole').value;

  if (!username || !password) {
    opMsg.textContent = '账号和密码不能为空。';
    return;
  }

  await request('/api/admin/operators', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name, username, password, role })
  });

  opMsg.textContent = '账号创建成功。';
  document.getElementById('opName').value = '';
  document.getElementById('opUsername').value = '';
  document.getElementById('opPassword').value = '';
  await loadOperators();
}

async function loadDashboard() {
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;
  const query = new URLSearchParams();
  if (from) query.set('date_from', from);
  if (to) query.set('date_to', to);

  const data = await request(`/api/admin/dashboard?${query.toString()}`, {
    headers: authHeaders()
  });

  setText('totalIssued', data.total_issued);
  setText('totalActivated', data.total_activated);
  setText('pendingCount', data.circulating_pending);
  setText('coCreatingCount', data.total_co_creating);
  setText('todayNewRecords', data.today_new_records);
  setText('publishedProducts', data.published_products);
  setText('hiddenRecords', data.hidden_records);
  setText('qualityAbnormal', data.today_quality_abnormal);
  setText('activationRate', `${data.period_activation_rate}%`);
}

function renderRows(records) {
  currentRecords = records;
  tableBody.innerHTML = records
    .map((item) => {
      const actionLabel = item.hidden ? '显示' : '隐藏';
      const actionFn = item.hidden ? 'show' : 'hide';
      const checked = selectedIds.has(item.id) ? 'checked' : '';
      return `<tr>
        <td><input type="checkbox" data-row-id="${escapeHtml(item.id)}" ${checked} /></td>
        <td>${escapeHtml(item.id)}</td>
        <td>${item.qr_access_token ? `<a href="/api/qr/image/${escapeHtml(item.qr_access_token)}" target="_blank" download="${escapeHtml(item.id)}.png">查看</a>` : '-'}</td>
        <td>${escapeHtml(item.batch_id || '-')}</td>
        <td>${escapeHtml(getBatchNote(item.batch_id))}</td>
        <td>${escapeHtml(formatIssueStatus(item.issue_status))}</td>
        <td>${escapeHtml(formatActivationStatus(item.activation_status))}</td>
        <td>${item.hidden ? '隐藏' : '显示'}</td>
        <td>${escapeHtml(item.phone || '-')}</td>
        <td>${escapeHtml(item.activated_at || item.co_creation_started_at || item.created_at || '-')}</td>
        <td><button data-id="${escapeHtml(item.id)}" data-action="${actionFn}">${actionLabel}</button></td>
      </tr>`;
    })
    .join('');

  updateSelectedUI();
}

async function loadRecords() {
  const batchId = document.getElementById('batchFilter').value;
  const issueStatus = document.getElementById('issueStatus').value;
  const activationStatus = document.getElementById('activationStatus').value;
  const hiddenStatus = document.getElementById('hiddenStatus').value;
  const idSearch = document.getElementById('idSearch').value.trim();
  const query = new URLSearchParams({ page: '1', limit: '20' });
  if (batchId) query.set('batch_id', batchId);
  if (issueStatus) query.set('issue_status', issueStatus);
  if (activationStatus) query.set('activation_status', activationStatus);
  if (hiddenStatus !== '') query.set('hidden', hiddenStatus);
  if (idSearch) query.set('id_prefix', idSearch);

  const data = await request(`/api/admin/records?${query.toString()}`, {
    headers: authHeaders()
  });

  renderRows(data.records || []);
}

function activeCommentCount(item) {
  const comments = Array.isArray(item.co_creation_comments) ? item.co_creation_comments : [];
  return comments.filter((comment) => comment.status !== 'deleted').length;
}

function renderContentRows(records) {
  contentRecordTableBody.innerHTML = records
    .map((item) => {
      const actionLabel = item.hidden ? '显示' : '隐藏';
      const actionFn = item.hidden ? 'show' : 'hide';
      const image = item.image_url
        ? `<img class="record-thumb" src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.id)}" />`
        : '-';
      const credential = item.blockchain_hash
        ? `已生成<br /><small>${escapeHtml(String(item.blockchain_hash).slice(0, 16))}...</small>`
        : '-';
      return `<tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${image}</td>
        <td><div class="text-clip">${escapeHtml(item.content || '（未填写留言）')}</div></td>
        <td>${escapeHtml(formatActivationStatus(item.activation_status))}</td>
        <td>${activeCommentCount(item)}</td>
        <td>${credential}</td>
        <td>${item.hidden ? '隐藏' : '显示'}</td>
        <td>${escapeHtml(item.phone || '-')}</td>
        <td>${escapeHtml(item.activated_at || item.co_creation_started_at || item.created_at || '-')}</td>
        <td><button data-record-id="${escapeHtml(item.id)}" data-record-action="${actionFn}">${actionLabel}</button></td>
      </tr>`;
    })
    .join('');
}

async function loadContentRecords() {
  const batchId = document.getElementById('recordBatchFilter').value;
  const activationStatus = document.getElementById('recordActivationStatus').value;
  const hiddenStatus = document.getElementById('recordHiddenStatus').value;
  const idSearch = document.getElementById('recordIdSearch').value.trim();
  const query = new URLSearchParams({ page: '1', limit: '50' });
  if (batchId) query.set('batch_id', batchId);
  if (activationStatus) query.set('activation_status', activationStatus);
  if (hiddenStatus !== '') query.set('hidden', hiddenStatus);
  if (idSearch) query.set('id_prefix', idSearch);

  const data = await request(`/api/admin/records?${query.toString()}`, {
    headers: authHeaders()
  });

  renderContentRows(data.records || []);
  recordMsg.textContent = data.total ? `共 ${data.total} 条内容记录，当前显示 ${data.records.length} 条。` : '暂无内容记录。';
}

async function toggleHiddenStatus(qrId, action) {
  await request(`/api/admin/records/${encodeURIComponent(qrId)}/${action}`, {
    method: 'POST',
    headers: authHeaders()
  });
  if (activeSection === 'records') {
    await loadContentRecords();
  } else {
    await loadRecords();
  }
}

async function batchUpdate(action) {
  if (selectedIds.size === 0) {
    alert('请先勾选至少一条记录。');
    return;
  }

  const endpoint = action === 'hide' ? '/api/admin/records/batch-hide' : '/api/admin/records/batch-show';
  await request(endpoint, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ids: [...selectedIds] })
  });

  await loadRecords();
}

async function batchAssignToBatch() {
  if (selectedIds.size === 0) {
    alert('请先勾选至少一条记录。');
    return;
  }

  const batchId = document.getElementById('assignBatchSelect').value;
  if (!batchId) {
    alert('请先选择一个批次。');
    return;
  }

  await request(`/api/admin/batches/${encodeURIComponent(batchId)}/assign`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ids: [...selectedIds] })
  });

  await loadBatches();
  await loadRecords();
}

async function downloadFromResponse(response, fallbackName) {
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function batchExport() {
  if (selectedIds.size === 0) {
    alert('请先勾选至少一条记录。');
    return;
  }

  const response = await fetchWithTimeout('/api/admin/records/export', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ids: [...selectedIds] }),
    timeoutMs: EXPORT_TIMEOUT_MS
  });

  if (!response.ok) {
    const data = await parseJsonResponse(response);
    throw new Error(data.message || '导出失败');
  }

  await downloadFromResponse(response, `records-export-${Date.now()}.csv`);
}

async function exportBatch(batchId) {
  const response = await fetchWithTimeout(`/api/admin/batches/${encodeURIComponent(batchId)}/export`, {
    headers: authHeaders(),
    timeoutMs: EXPORT_TIMEOUT_MS
  });

  if (!response.ok) {
    const data = await parseJsonResponse(response);
    throw new Error(data.message || '批次导出失败');
  }

  await downloadFromResponse(response, `batch-${batchId}-${Date.now()}.csv`);
}

function fillMiniappContentForm(data) {
  document.getElementById('contentHomeTitle').value = data.home_title || '';
  document.getElementById('contentHomeSubtitle').value = data.home_subtitle || '';
  document.getElementById('contentHomeBanner').value = data.home_banner_image || '';
  document.getElementById('contentProjectTitle').value = data.project_title || '';
  document.getElementById('contentProjectBody').value = data.project_body || '';
  document.getElementById('contentBrandTitle').value = data.brand_story_title || '';
  document.getElementById('contentBrandBody').value = data.brand_story_body || '';
  document.getElementById('contentConsultLabel').value = data.consult_label || '';
  document.getElementById('contentConsultUrl').value = data.consult_url || '';
  document.getElementById('contentShareTitle').value = data.share_title || '';
  document.getElementById('contentShareDescription').value = data.share_description || '';
  document.getElementById('miniappContentUpdated').textContent = data.updated_at ? `上次更新：${data.updated_at}` : '';
}

function readMiniappContentForm() {
  return {
    home_title: document.getElementById('contentHomeTitle').value.trim(),
    home_subtitle: document.getElementById('contentHomeSubtitle').value.trim(),
    home_banner_image: document.getElementById('contentHomeBanner').value.trim(),
    project_title: document.getElementById('contentProjectTitle').value.trim(),
    project_body: document.getElementById('contentProjectBody').value.trim(),
    brand_story_title: document.getElementById('contentBrandTitle').value.trim(),
    brand_story_body: document.getElementById('contentBrandBody').value.trim(),
    consult_label: document.getElementById('contentConsultLabel').value.trim(),
    consult_url: document.getElementById('contentConsultUrl').value.trim(),
    share_title: document.getElementById('contentShareTitle').value.trim(),
    share_description: document.getElementById('contentShareDescription').value.trim()
  };
}

async function loadMiniappContent() {
  const data = await request('/api/admin/miniapp-content', { headers: authHeaders() });
  fillMiniappContentForm(data);
}

async function saveMiniappContent() {
  const data = await request('/api/admin/miniapp-content', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(readMiniappContentForm())
  });
  fillMiniappContentForm(data);
  miniappContentMsg.textContent = '小程序内容已保存。';
}

async function loadSystemStatus() {
  const data = await request('/api/admin/system-status', { headers: authHeaders() });
  setText('systemStorageMode', data.storage.mode);
  setText('systemOssConfigured', formatConfigured(data.storage.configured));
  setText('systemMiniappConfigured', formatConfigured(data.miniapp.configured));
  setText('systemSafetyConfigured', `${formatConfigured(data.content_safety.configured)}（${data.content_safety.mode}）`);
  setText('systemDomain', data.domain.base_url || data.domain.expected_domain);
  setText('systemPrivacy', formatConfigured(data.agreements.privacy_url_configured));
  setText('systemService', formatConfigured(data.agreements.service_url_configured));
  systemMsg.textContent = '';
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();

  try {
    const data = await request('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    adminToken = data.token;
    localStorage.setItem('adminToken', adminToken);
    showPanelsAfterLogin();
  } catch (error) {
    loginMsg.textContent = error.message || '登录失败';
  }
});

navItems.forEach((item) => {
  item.addEventListener('click', () => activateAdminSection(item.dataset.adminSection));
});

document.getElementById('refreshBtn').addEventListener('click', loadDashboard);
document.getElementById('createBatchBtn').addEventListener('click', () => createBatch().catch((e) => {
  batchMsg.textContent = e.message || '创建失败';
}));
document.getElementById('refreshBatchBtn').addEventListener('click', () => loadBatches().catch(() => {}));
document.getElementById('generateQrBtn').addEventListener('click', () => generateQRCodes());
document.getElementById('createOpBtn').addEventListener('click', () => createOperator().catch((e) => { opMsg.textContent = e.message || '创建失败'; }));
document.getElementById('refreshOpBtn').addEventListener('click', () => loadOperators().catch(() => {}));
document.getElementById('saveProductBtn').addEventListener('click', () => saveProduct().catch((e) => { productMsg.textContent = e.message || '保存失败'; }));
document.getElementById('refreshProductBtn').addEventListener('click', () => loadProducts().catch(() => {}));
document.getElementById('cancelProductEditBtn').addEventListener('click', () => {
  clearProductForm();
  productMsg.textContent = '';
});
document.getElementById('refreshMiniappContentBtn').addEventListener('click', () => loadMiniappContent().catch((e) => {
  miniappContentMsg.textContent = e.message || '刷新失败';
}));
document.getElementById('saveMiniappContentBtn').addEventListener('click', () => saveMiniappContent().catch((e) => {
  miniappContentMsg.textContent = e.message || '保存失败';
}));
document.getElementById('refreshSystemBtn').addEventListener('click', () => loadSystemStatus().catch((e) => {
  systemMsg.textContent = e.message || '刷新失败';
}));
document.getElementById('filterBtn').addEventListener('click', async () => {
  selectedIds.clear();
  await loadRecords();
});
document.getElementById('recordFilterBtn').addEventListener('click', () => loadContentRecords().catch((e) => {
  recordMsg.textContent = e.message || '加载失败';
}));

document.getElementById('assignBatchBtn').addEventListener('click', () => batchAssignToBatch().catch((e) => alert(e.message || '绑定失败')));
document.getElementById('batchHideBtn').addEventListener('click', () => batchUpdate('hide'));
document.getElementById('batchShowBtn').addEventListener('click', () => batchUpdate('show'));
document.getElementById('batchExportBtn').addEventListener('click', async () => {
  try {
    await batchExport();
  } catch (error) {
    alert(error.message || '导出失败');
  }
});

selectAll.addEventListener('change', () => {
  currentRecords.forEach((item) => {
    if (selectAll.checked) {
      selectedIds.add(item.id);
    } else {
      selectedIds.delete(item.id);
    }
  });

  renderRows(currentRecords);
});

tableBody.addEventListener('click', async (event) => {
  const checkbox = event.target.closest('input[type="checkbox"][data-row-id]');
  if (checkbox) {
    const rowId = checkbox.getAttribute('data-row-id');
    if (checkbox.checked) {
      selectedIds.add(rowId);
    } else {
      selectedIds.delete(rowId);
    }
    updateSelectedUI();
    return;
  }

  const btn = event.target.closest('button[data-id]');
  if (!btn) return;
  await toggleHiddenStatus(btn.getAttribute('data-id'), btn.getAttribute('data-action'));
});

contentRecordTableBody.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-record-id]');
  if (!btn) return;
  await toggleHiddenStatus(btn.getAttribute('data-record-id'), btn.getAttribute('data-record-action'));
});

batchTableBody.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-batch-export]');
  if (!btn) return;
  try {
    await exportBatch(btn.getAttribute('data-batch-export'));
  } catch (error) {
    alert(error.message || '导出失败');
  }
});

operatorTableBody.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-op-id]');
  if (!btn) return;
  const opId = btn.getAttribute('data-op-id');
  const action = btn.getAttribute('data-op-action');

  if (action === 'change-password') {
    const newPassword = prompt('请输入新密码：');
    if (!newPassword || !newPassword.trim()) {
      return;
    }
    try {
      await request(`/api/admin/operators/${encodeURIComponent(opId)}/change-password`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: newPassword.trim() })
      });
      opMsg.textContent = '密码修改成功。';
    } catch (error) {
      opMsg.textContent = error.message || '密码修改失败。';
    }
    return;
  }

  try {
    await request(`/api/admin/operators/${encodeURIComponent(opId)}/${action}`, {
      method: 'POST',
      headers: authHeaders()
    });
    await loadOperators();
  } catch (error) {
    opMsg.textContent = error.message || '操作失败';
  }
});

productTableBody.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-product-edit]');
  if (!btn) return;
  editProduct(btn.getAttribute('data-product-edit'));
});

if (adminToken) {
  showPanelsAfterLogin();
}
