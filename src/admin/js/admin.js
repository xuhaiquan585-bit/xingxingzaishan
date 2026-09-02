const loginPanel = document.getElementById('loginPanel');
const adminShell = document.getElementById('adminShell');
const navItems = Array.from(document.querySelectorAll('[data-admin-section]'));
const adminPanels = Array.from(document.querySelectorAll('[data-admin-panel]'));
const loginMsg = document.getElementById('loginMsg');
const batchMsg = document.getElementById('batchMsg');
const opMsg = document.getElementById('opMsg');
const productMsg = document.getElementById('productMsg');
const orderMsg = document.getElementById('orderMsg');
const recordMsg = document.getElementById('recordMsg');
const miniappContentMsg = document.getElementById('miniappContentMsg');
const labelTemplateMsg = document.getElementById('labelTemplateMsg');
const printBatchMsg = document.getElementById('printBatchMsg');
const systemMsg = document.getElementById('systemMsg');
const tableBody = document.getElementById('recordTable');
const contentRecordTableBody = document.getElementById('contentRecordTable');
const batchTableBody = document.getElementById('batchTable');
const operatorTableBody = document.getElementById('operatorTable');
const productTableBody = document.getElementById('productTable');
const orderTableBody = document.getElementById('orderTable');
const selectedCount = document.getElementById('selectedCount');
const selectAll = document.getElementById('selectAll');

let adminToken = localStorage.getItem('adminToken') || '';
let activeSection = localStorage.getItem('adminActiveSection') || 'dashboard';
let currentRecords = [];
let batchList = [];
let productList = [];
let orderList = [];
let orderPage = 1;
let orderTotalPages = 1;
let orderStatus = '';
let selectedOrder = null;
let shippingSaving = false;
let editingProductId = '';
let editingProductUpdatedAt = '';
let productDirty = false;
let productSaving = false;
const selectedIds = new Set();
const REQUEST_TIMEOUT_MS = 15000;
const EXPORT_TIMEOUT_MS = 60000;
const PRODUCT_SCENE_LABELS = {
  lover: '恋人',
  elder: '长辈',
  birthday: '生日',
  coming_of_age: '成人礼',
  wedding: '婚礼',
  party: '聚会',
  free: '随心'
};

function authHeaders() {
  return {
    Authorization: `Bearer ${adminToken}`
  };
}

async function request(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const json = await parseJsonResponse(response);
  if (!response.ok || json.status !== 'success') {
    const error = new Error(json.message || '请求失败，请稍后重试');
    error.code = json.code || 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
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
      labelTemplates: labelTemplateMsg,
      printBatches: printBatchMsg,
      records: recordMsg,
      miniappContent: miniappContentMsg,
      products: productMsg,
      orders: orderMsg,
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
  if (activeSection === 'labelTemplates') {
    await window.LabelTemplateEditor.load();
    return;
  }
  if (activeSection === 'printBatches') {
    await window.PrintBatchAdmin.load();
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
  if (activeSection === 'orders') {
    await loadOrders();
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
  const eligibleCount = currentRecords.filter((item) => (
    selectedIds.has(item.id) && isQrAvailableForPrinting(item)
  )).length;
  selectedCount.textContent = `已选 ${selectedIds.size} 条，可生产 ${eligibleCount} 条`;
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

function formatPrintStatus(status) {
  const map = {
    legacy_unclassified: '历史未分类',
    available: '可用于生产',
    reserved: '已预留',
    artifact_generated: '文件已生成',
    printed: '已打印',
    voided: '已报废'
  };
  return map[status] || status || '状态未知';
}

function isQrAvailableForPrinting(item) {
  return item.issue_status === 'issued'
    && item.activation_status === 'unactivated'
    && item.print_status === 'available'
    && !item.print_batch_id;
}

function formatChainStatus(status) {
  const map = {
    not_started: '未开始',
    manifest_ready: '待提交',
    submitting: '提交中',
    submitted: '已提交',
    retrying: '重试中',
    confirmed: '已确认',
    failed: '失败'
  };
  return map[status] || status || '-';
}

function shortHash(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
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

function setProductDirty(dirty) {
  productDirty = dirty === true;
  document.getElementById('productDirtyState').classList.toggle('hidden', !productDirty);
}

function setProductSaving(saving) {
  productSaving = saving === true;
  ['saveProductDraftBtn', 'publishProductBtn', 'hideProductBtn', 'uploadProductImageBtn'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = productSaving;
  });
  document.getElementById('saveProductDraftBtn').textContent = productSaving ? '保存中...' : '保存草稿';
  document.getElementById('publishProductBtn').textContent = productSaving ? '保存中...' : '保存并上架';
}

function clearProductForm() {
  editingProductId = '';
  editingProductUpdatedAt = '';
  document.getElementById('productTitle').value = '';
  document.getElementById('productSubtitle').value = '';
  document.getElementById('productCover').value = '';
  document.getElementById('productPrice').value = '';
  document.getElementById('productPriceYuan').value = '';
  document.getElementById('productStickerCount').value = '1';
  document.getElementById('productInventoryCount').value = '0';
  document.getElementById('productStock').value = '0';
  document.getElementById('productType').value = 'wine_sticker';
  document.getElementById('productCustomizable').checked = false;
  document.getElementById('productBuyUrl').value = '';
  document.getElementById('productSort').value = '0';
  document.getElementById('productStatus').value = 'draft';
  setProductSceneTags([]);
  document.getElementById('productImages').value = '';
  document.getElementById('productDescription').value = '';
  document.getElementById('productShippingNote').value = '';
  document.getElementById('productAfterSaleNote').value = '';
  document.getElementById('productEditorTitle').textContent = '新增商品';
  document.getElementById('productEditorId').textContent = '保存后生成商品 ID';
  document.getElementById('productEditorUpdated').textContent = '';
  document.getElementById('hideProductBtn').classList.add('hidden');
  document.getElementById('productEditorMsg').textContent = '';
  renderProductMedia();
  setProductDirty(false);
}

function getProductSceneTags() {
  return Array.from(document.querySelectorAll('#productSceneTags input[type="checkbox"]:checked'))
    .map((item) => item.value);
}

function setProductSceneTags(tags = []) {
  const selected = new Set(Array.isArray(tags) ? tags : []);
  document.querySelectorAll('#productSceneTags input[type="checkbox"]').forEach((item) => {
    item.checked = selected.has(item.value);
  });
}

function formatProductScenes(tags = []) {
  if (!Array.isArray(tags) || tags.length === 0) return '随心';
  return tags.map((tag) => PRODUCT_SCENE_LABELS[tag] || tag).join('、');
}

function formatProductPriceText(priceCents) {
  const normalizedCents = Math.max(0, Math.round(Number(priceCents) || 0));
  return normalizedCents > 0 ? (normalizedCents / 100).toFixed(2) : '';
}

function updateProductPricePreview() {
  const priceYuan = document.getElementById('productPriceYuan').value.trim();
  const priceCents = priceYuan ? Math.round(Number(priceYuan) * 100) : 0;
  document.getElementById('productPrice').value = formatProductPriceText(priceCents);
}

function readProductForm() {
  const priceYuan = document.getElementById('productPriceYuan').value.trim();
  const priceCents = priceYuan ? Math.round(Number(priceYuan) * 100) : 0;
  const stickerCount = Number(document.getElementById('productStickerCount').value || 1);
  return {
    title: document.getElementById('productTitle').value.trim(),
    subtitle: document.getElementById('productSubtitle').value.trim(),
    cover_image: document.getElementById('productCover').value.trim(),
    price_text: formatProductPriceText(priceCents),
    price_cents: priceCents,
    sticker_count: stickerCount,
    inventory_count: Number(document.getElementById('productInventoryCount').value || 0),
    stock: Number(document.getElementById('productStock').value || 0),
    product_type: document.getElementById('productType').value,
    is_customizable: document.getElementById('productCustomizable').checked,
    buy_url: document.getElementById('productBuyUrl').value.trim(),
    sort_order: Number(document.getElementById('productSort').value || 0),
    status: document.getElementById('productStatus').value,
    scene_tags: getProductSceneTags(),
    images: document.getElementById('productImages').value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
    description: document.getElementById('productDescription').value.trim(),
    shipping_note: document.getElementById('productShippingNote').value.trim(),
    after_sale_note: document.getElementById('productAfterSaleNote').value.trim()
  };
}

function productStatusBadge(status) {
  const labels = { published: '已上架', draft: '草稿', hidden: '已隐藏' };
  return `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(labels[status] || status)}</span>`;
}

function renderProducts(products) {
  const keyword = document.getElementById('productSearch').value.trim().toLowerCase();
  const status = document.getElementById('productStatusFilter').value;
  const visibleProducts = products.filter((product) => {
    const matchesStatus = !status || product.status === status;
    const matchesKeyword = !keyword || [product.id, product.title]
      .some((value) => String(value || '').toLowerCase().includes(keyword));
    return matchesStatus && matchesKeyword;
  });
  document.getElementById('productEmptyState').classList.toggle('hidden', products.length > 0);
  document.getElementById('productTableWrap').classList.toggle('hidden', products.length === 0);
  productTableBody.innerHTML = products
    .filter((product) => visibleProducts.includes(product))
    .map((product) => `<tr data-product-open="${escapeHtml(product.id)}">
      <td><div class="product-cell">
        ${product.cover_image ? `<img class="product-thumb" src="${escapeHtml(product.cover_image)}" alt="" />` : '<div class="product-thumb product-thumb-empty">无图</div>'}
        <div><strong>${escapeHtml(product.title)}</strong><small>${escapeHtml(product.id)}</small></div>
      </div></td>
      <td>${productStatusBadge(product.status)}</td>
      <td><strong>${escapeHtml(formatProductPriceText(product.price_cents) || '未填写')}</strong></td>
      <td>${Number(product.inventory_count || 0) > 0 ? Number(product.inventory_count) : '<span class="status-badge status-hidden">售罄</span>'}</td>
      <td>${Number(product.stock || 0) || '不限'}</td>
      <td>${escapeHtml(formatProductScenes(product.scene_tags))}</td>
      <td>${escapeHtml(product.updated_at || product.created_at || '-')}</td>
      <td><button class="secondary" data-product-edit="${escapeHtml(product.id)}" type="button">编辑</button></td>
    </tr>`)
    .join('');
  if (products.length > 0 && visibleProducts.length === 0) {
    productTableBody.innerHTML = '<tr><td colspan="8" class="table-empty">没有符合筛选条件的商品。</td></tr>';
  }
}

async function loadProducts() {
  const data = await request('/api/admin/products', { headers: authHeaders() });
  productList = data.products || [];
  renderProducts(productList);
  productMsg.textContent = `共 ${data.total || productList.length} 个商品。`;
}

function showProductList() {
  if (productDirty && !window.confirm('当前商品有未保存修改，确定返回列表吗？')) return;
  document.getElementById('productEditorView').classList.add('hidden');
  document.getElementById('productListView').classList.remove('hidden');
  clearProductForm();
}

function showNewProductEditor() {
  clearProductForm();
  document.getElementById('productListView').classList.add('hidden');
  document.getElementById('productEditorView').classList.remove('hidden');
  document.getElementById('productTitle').focus();
}

function fillProductForm(product) {
  editingProductId = product.id;
  editingProductUpdatedAt = product.updated_at || '';
  document.getElementById('productTitle').value = product.title || '';
  document.getElementById('productSubtitle').value = product.subtitle || '';
  document.getElementById('productCover').value = product.cover_image || '';
  document.getElementById('productPrice').value = formatProductPriceText(product.price_cents);
  document.getElementById('productPriceYuan').value = product.price_cents
    ? (Number(product.price_cents) / 100).toFixed(2)
    : '';
  document.getElementById('productStickerCount').value = Number(product.sticker_count || 1);
  document.getElementById('productInventoryCount').value = Math.max(0, Number(product.inventory_count || 0));
  document.getElementById('productStock').value = Number(product.stock || 0);
  document.getElementById('productType').value = product.product_type || 'wine_sticker';
  document.getElementById('productCustomizable').checked = product.is_customizable === true;
  document.getElementById('productBuyUrl').value = product.buy_url || '';
  document.getElementById('productSort').value = Number(product.sort_order || 0);
  document.getElementById('productStatus').value = product.status || 'draft';
  setProductSceneTags(product.scene_tags || []);
  document.getElementById('productImages').value = Array.isArray(product.images) ? product.images.join('\n') : '';
  document.getElementById('productDescription').value = product.description || '';
  document.getElementById('productShippingNote').value = product.shipping_note || '';
  document.getElementById('productAfterSaleNote').value = product.after_sale_note || '';
  document.getElementById('productEditorTitle').textContent = product.title || '编辑商品';
  document.getElementById('productEditorId').textContent = product.id;
  document.getElementById('productEditorUpdated').textContent = product.updated_at ? ` · 更新于 ${product.updated_at}` : '';
  document.getElementById('hideProductBtn').classList.toggle('hidden', product.status === 'hidden');
  renderProductMedia();
  setProductDirty(false);
}

async function openProductEditor(productId) {
  document.getElementById('productListView').classList.add('hidden');
  document.getElementById('productEditorView').classList.remove('hidden');
  document.getElementById('productEditorMsg').textContent = '正在读取最新商品信息...';
  try {
    const product = await request(`/api/admin/products/${encodeURIComponent(productId)}`, {
      headers: authHeaders()
    });
    fillProductForm(product);
    document.getElementById('productEditorMsg').textContent = '';
  } catch (error) {
    document.getElementById('productEditorMsg').textContent = error.message || '读取商品失败。';
  }
}

async function saveProduct(targetStatus) {
  if (productSaving) return;
  const payload = readProductForm();
  payload.status = targetStatus;
  if (editingProductId) payload.expected_updated_at = editingProductUpdatedAt;
  if (!payload.title) {
    document.getElementById('productEditorMsg').textContent = '商品名称不能为空。';
    document.getElementById('productTitle').focus();
    return;
  }
  if (targetStatus === 'published' && payload.price_cents < 1) {
    document.getElementById('productEditorMsg').textContent = '上架前请填写有效价格。';
    document.getElementById('productPriceYuan').focus();
    return;
  }

  const url = editingProductId
    ? `/api/admin/products/${encodeURIComponent(editingProductId)}`
    : '/api/admin/products';

  setProductSaving(true);
  document.getElementById('productEditorMsg').textContent = '正在保存...';
  try {
    const saved = await request(url, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    fillProductForm(saved);
    document.getElementById('productEditorMsg').textContent = targetStatus === 'published'
      ? '商品已保存并上架。'
      : targetStatus === 'hidden'
        ? '商品已隐藏，不再对用户展示。'
        : '草稿已保存。';
    await loadProducts();
  } catch (error) {
    if (error.code === 'PRODUCT_UPDATE_CONFLICT') {
      document.getElementById('productEditorMsg').textContent = '保存失败：商品已在其他位置更新，请返回列表后重新打开。';
    } else {
      document.getElementById('productEditorMsg').textContent = error.message || '保存失败。';
    }
  } finally {
    setProductSaving(false);
  }
}

function productMediaValues() {
  const cover = document.getElementById('productCover').value.trim();
  const images = document.getElementById('productImages').value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
  return { cover, images: images.filter((item) => item !== cover) };
}

function renderProductMedia() {
  const container = document.getElementById('productMediaList');
  if (!container) return;
  const { cover, images } = productMediaValues();
  const all = [cover, ...images].filter(Boolean);
  container.innerHTML = all.length
    ? all.map((url, index) => `<div class="media-item">
        <img src="${escapeHtml(url)}" alt="" />
        <div><strong>${index === 0 ? '封面图' : `详情图 ${index}`}</strong><small>${escapeHtml(url)}</small></div>
        <div class="media-actions">
          ${index > 0 ? `<button class="secondary" data-media-action="cover" data-media-url="${escapeHtml(url)}" type="button">设为封面</button>` : ''}
          ${index > 1 ? `<button class="secondary" data-media-action="up" data-media-url="${escapeHtml(url)}" type="button">上移</button>` : ''}
          ${index > 0 && index < all.length - 1 ? `<button class="secondary" data-media-action="down" data-media-url="${escapeHtml(url)}" type="button">下移</button>` : ''}
          <button class="danger-button" data-media-action="remove" data-media-url="${escapeHtml(url)}" type="button">移除</button>
        </div>
      </div>`).join('')
    : '<div class="empty-media">尚未上传商品图片。</div>';
}

function updateProductMedia(action, url) {
  const { cover, images } = productMediaValues();
  let nextCover = cover;
  let nextImages = images.slice();
  const index = nextImages.indexOf(url);
  if (action === 'cover' && index !== -1) {
    nextImages.splice(index, 1);
    if (cover) nextImages.unshift(cover);
    nextCover = url;
  } else if (action === 'remove') {
    if (url === cover) {
      nextCover = nextImages.shift() || '';
    } else if (index !== -1) {
      nextImages.splice(index, 1);
    }
  } else if (action === 'up' && index > 0) {
    [nextImages[index - 1], nextImages[index]] = [nextImages[index], nextImages[index - 1]];
  } else if (action === 'down' && index !== -1 && index < nextImages.length - 1) {
    [nextImages[index + 1], nextImages[index]] = [nextImages[index], nextImages[index + 1]];
  }
  document.getElementById('productCover').value = nextCover;
  document.getElementById('productImages').value = nextImages.join('\n');
  renderProductMedia();
  setProductDirty(true);
}

async function uploadProductImage() {
  const input = document.getElementById('productImageUpload');
  if (!input.files || !input.files[0]) throw new Error('请先选择图片。');
  const formData = new FormData();
  formData.append('image', input.files[0]);
  formData.append('scope', 'product-media');
  setProductSaving(true);
  document.getElementById('productEditorMsg').textContent = '图片上传中...';
  try {
    const response = await fetchWithTimeout('/api/admin/upload-image', {
      method: 'POST',
      headers: authHeaders(),
      body: formData,
      timeoutMs: EXPORT_TIMEOUT_MS
    });
    const json = await parseJsonResponse(response);
    if (!response.ok || json.status !== 'success') throw new Error(json.message || '图片上传失败');
    const url = json.data && json.data.url;
    if (!url) throw new Error('图片上传成功，但未返回可用地址。');
    const { cover, images } = productMediaValues();
    if (!cover) document.getElementById('productCover').value = url;
    else document.getElementById('productImages').value = [...images, url].join('\n');
    input.value = '';
    renderProductMedia();
    setProductDirty(true);
    document.getElementById('productEditorMsg').textContent = '图片已上传，请保存商品。';
  } finally {
    setProductSaving(false);
  }
}

function renderOrders(orders) {
  orderTableBody.innerHTML = orders
    .map((order) => {
      const product = order.product_snapshot || {};
      const paymentLabel = order.payment_status === 'paid' ? '已支付' : '未支付';
      return `<tr data-order-open="${escapeHtml(order.id)}">
        <td><strong>${escapeHtml(order.order_no || order.id)}</strong><small>${escapeHtml(formatDateTime(order.created_at))}</small></td>
        <td><div class="order-product-cell">
          ${product.cover_image ? `<img src="${escapeHtml(product.cover_image)}" alt="" />` : ''}
          <span>${escapeHtml(product.title || '-')} × ${Number(order.quantity || 1)}</span>
        </div></td>
        <td>${escapeHtml(order.receiver_name_masked || '-')}<small>${escapeHtml(order.receiver_phone_masked || '')}</small><small>${escapeHtml(order.address_summary || '')}</small></td>
        <td><strong>${escapeHtml(order.amount_text || '-')}</strong></td>
        <td><span class="payment-state payment-${escapeHtml(order.payment_status || 'unpaid')}">${paymentLabel}</span></td>
        <td>${orderStatusBadge(order.status, order.status_text)}</td>
        <td><button class="secondary" data-order-detail="${escapeHtml(order.id)}" type="button">查看</button></td>
      </tr>`;
    })
    .join('');
  if (orders.length === 0) {
    orderTableBody.innerHTML = '<tr><td colspan="7" class="table-empty">当前筛选条件下没有订单。</td></tr>';
  }
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function orderStatusBadge(status, label) {
  return `<span class="status-badge order-status-${escapeHtml(status)}">${escapeHtml(label || status || '-')}</span>`;
}

async function loadOrders() {
  const query = new URLSearchParams({
    page: String(orderPage),
    page_size: '50'
  });
  const keyword = document.getElementById('orderSearch').value.trim();
  if (orderStatus) query.set('status', orderStatus);
  if (keyword) query.set('q', keyword);
  orderMsg.textContent = '正在加载订单...';
  const data = await request(`/api/admin/orders?${query.toString()}`, { headers: authHeaders() });
  orderList = data.orders || [];
  orderPage = data.page || 1;
  orderTotalPages = data.total_pages || 1;
  renderOrders(orderList);
  document.getElementById('orderPaginationSummary').textContent =
    `共 ${data.total || 0} 个订单 · 第 ${orderPage} / ${orderTotalPages} 页`;
  document.getElementById('previousOrderPageBtn').disabled = orderPage <= 1;
  document.getElementById('nextOrderPageBtn').disabled = orderPage >= orderTotalPages;
  orderMsg.textContent = '';
}

function orderDetailSection(title, rows) {
  return `<section class="drawer-section"><h3>${escapeHtml(title)}</h3><dl>${rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || '-')}</dd></div>`)
    .join('')}</dl></section>`;
}

function renderOrderDetail(order) {
  const product = order.product_snapshot || {};
  const timeline = (order.timeline || []).map((item) =>
    `<li><span></span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(formatDateTime(item.at))}</small></div></li>`
  ).join('');
  document.getElementById('orderDrawerTitle').textContent = order.order_no || order.id;
  document.getElementById('orderDrawerContent').innerHTML = `
    <div class="drawer-summary">
      ${orderStatusBadge(order.status, order.status_text)}
      <strong>${escapeHtml(order.amount_text || '-')}</strong>
      <span>共 ${Number(order.quantity || 1)} 件</span>
    </div>
    ${orderDetailSection('商品快照', [
      ['商品', product.title || '-'],
      ['商品 ID', order.product_id || product.id || '-'],
      ['单价', `¥${(Number(order.unit_price_cents || 0) / 100).toFixed(2)}`],
      ['数量', String(order.quantity || 1)]
    ])}
    ${orderDetailSection('支付信息', [
      ['支付状态', order.payment_status === 'paid' ? '已支付' : '未支付'],
      ['支付方式', order.payment_method || '-'],
      ['支付时间', formatDateTime(order.paid_at)],
      ['微信交易号', order.wechat_transaction_id || '-']
    ])}
    ${orderDetailSection('收货信息', [
      ['收件人', order.receiver_name || '-'],
      ['手机号', order.receiver_phone || '-'],
      ['地区', order.region || '-'],
      ['详细地址', order.address || '-'],
      ['用户备注', order.remark || '-']
    ])}
    ${orderDetailSection('物流信息', [
      ['快递公司', order.express_company || '未填写'],
      ['快递单号', order.express_no || '未填写'],
      ['发货时间', formatDateTime(order.shipped_at)],
      ['后台备注', order.admin_note || '-']
    ])}
    <section class="drawer-section"><h3>状态时间线</h3><ol class="order-timeline">${timeline}</ol></section>`;
  const shipButton = document.getElementById('drawerShipOrderBtn');
  shipButton.classList.toggle('hidden', !['paid', 'shipped'].includes(order.status));
  shipButton.textContent = order.status === 'shipped' ? '修改物流' : '确认发货';
}

async function openOrderDetail(orderId) {
  document.getElementById('orderDrawerBackdrop').classList.remove('hidden');
  document.getElementById('orderDrawer').classList.remove('hidden');
  document.getElementById('orderDrawerTitle').textContent = '加载中...';
  document.getElementById('orderDrawerContent').innerHTML = '<p class="muted">正在读取订单详情...</p>';
  try {
    selectedOrder = await request(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
      headers: authHeaders()
    });
    renderOrderDetail(selectedOrder);
  } catch (error) {
    selectedOrder = null;
    document.getElementById('orderDrawerContent').innerHTML =
      `<p class="msg">${escapeHtml(error.message || '订单详情加载失败。')}</p>`;
    document.getElementById('drawerShipOrderBtn').classList.add('hidden');
  }
}

function closeOrderDrawer() {
  document.getElementById('orderDrawerBackdrop').classList.add('hidden');
  document.getElementById('orderDrawer').classList.add('hidden');
  selectedOrder = null;
}

function openShippingModal() {
  if (!selectedOrder || !['paid', 'shipped'].includes(selectedOrder.status)) return;
  document.getElementById('shippingOrderLabel').textContent = selectedOrder.order_no || selectedOrder.id;
  document.getElementById('shippingCompany').value = selectedOrder.express_company || '';
  document.getElementById('shippingNumber').value = selectedOrder.express_no || '';
  document.getElementById('shippingAdminNote').value = selectedOrder.admin_note || '';
  document.getElementById('shippingMsg').textContent = '';
  document.getElementById('shippingModalBackdrop').classList.remove('hidden');
  document.getElementById('shippingCompany').focus();
}

function closeShippingModal(force = false) {
  if (shippingSaving && !force) return;
  document.getElementById('shippingModalBackdrop').classList.add('hidden');
}

function setShippingSaving(saving) {
  shippingSaving = saving === true;
  document.getElementById('saveShippingBtn').disabled = shippingSaving;
  document.getElementById('cancelShippingBtn').disabled = shippingSaving;
  document.getElementById('closeShippingModalBtn').disabled = shippingSaving;
  document.getElementById('saveShippingBtn').textContent = shippingSaving ? '保存中...' : '保存发货信息';
}

async function saveOrderShipment() {
  if (shippingSaving || !selectedOrder) return;
  const expressCompany = document.getElementById('shippingCompany').value.trim();
  const expressNo = document.getElementById('shippingNumber').value.trim();
  const adminNote = document.getElementById('shippingAdminNote').value.trim();
  if (!expressCompany || !expressNo) {
    document.getElementById('shippingMsg').textContent = '请填写快递公司和快递单号。';
    return;
  }
  setShippingSaving(true);
  document.getElementById('shippingMsg').textContent = '';
  try {
    await request(`/api/admin/orders/${encodeURIComponent(selectedOrder.id)}/ship`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        express_company: expressCompany,
        express_no: expressNo,
        admin_note: adminNote
      })
    });
    const orderId = selectedOrder.id;
    closeShippingModal(true);
    await loadOrders();
    await openOrderDetail(orderId);
    orderMsg.textContent = '发货信息已保存。';
  } catch (error) {
    document.getElementById('shippingMsg').textContent = error.message || '发货信息保存失败。';
  } finally {
    setShippingSaving(false);
  }
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
  setText('chainPending', data.chain_pending);
  setText('chainProcessing', data.chain_processing);
  setText('chainConfirmed', data.chain_confirmed);
  setText('chainFailed', data.chain_failed);
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
        <td>${escapeHtml(formatPrintStatus(item.print_status))}</td>
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
      const chainStatus = formatChainStatus(item.chain_status);
      const chainHash = item.manifest_hash || item.blockchain_hash || '';
      const certificateUrl = item.chain_certificate_object_url || item.chain_certificate_url || '';
      const credential = `<div>${escapeHtml(chainStatus)}</div>
        ${chainHash ? `<small>${escapeHtml(shortHash(chainHash))}</small>` : ''}
        ${item.chain_tx_hash ? `<br /><small>tx: ${escapeHtml(shortHash(item.chain_tx_hash))}</small>` : ''}
        ${item.manifest_object_key ? `<br /><small>manifest: ${escapeHtml(shortHash(item.manifest_object_key))}</small>` : ''}
        ${item.archive_index_object_key ? `<br /><small>索引: 已写入</small>` : ''}
        ${certificateUrl ? `<br /><a href="${escapeHtml(certificateUrl)}" target="_blank" rel="noreferrer">证书</a>` : ''}
        ${item.chain_certificate_object_key ? `<br /><small>证书归档: 已保存</small>` : ''}
        ${item.chain_last_error ? `<br /><small class="danger">${escapeHtml(shortHash(item.chain_last_error))}</small>` : ''}`;
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
        <td>
          <button data-record-id="${escapeHtml(item.id)}" data-record-action="${actionFn}">${actionLabel}</button>
          <button data-chain-id="${escapeHtml(item.id)}" data-chain-action="query">查存证</button>
          <button data-chain-id="${escapeHtml(item.id)}" data-chain-action="retry">重试</button>
          <button data-archive-id="${escapeHtml(item.id)}">重建档案</button>
        </td>
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
  document.getElementById('contentLogoImage').value = data.logo_image || '';
  document.getElementById('contentHomeBanner').value = data.home_banner_image || '';
  document.getElementById('contentHomeSlides').value = JSON.stringify(data.home_slides || [], null, 2);
  document.getElementById('contentSceneCards').value = JSON.stringify(data.scene_cards || [], null, 2);
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

function readJsonArrayField(id, label) {
  const value = document.getElementById(id).value.trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error(`${label} 必须是数组。`);
    }
    return parsed;
  } catch (error) {
    if (error.message && error.message.includes('必须是数组')) {
      throw error;
    }
    throw new Error(`${label} JSON 格式不正确。`);
  }
}

function readMiniappContentForm() {
  return {
    home_title: document.getElementById('contentHomeTitle').value.trim(),
    home_subtitle: document.getElementById('contentHomeSubtitle').value.trim(),
    logo_image: document.getElementById('contentLogoImage').value.trim(),
    home_banner_image: document.getElementById('contentHomeBanner').value.trim(),
    home_slides: readJsonArrayField('contentHomeSlides', '首页轮播'),
    scene_cards: readJsonArrayField('contentSceneCards', '场景卡片'),
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

async function uploadMiniappContentImage() {
  const fileInput = document.getElementById('contentImageUpload');
  if (!fileInput.files || !fileInput.files[0]) {
    throw new Error('请先选择图片。');
  }
  const formData = new FormData();
  formData.append('image', fileInput.files[0]);
  formData.append('scope', 'miniapp-content');

  miniappContentMsg.textContent = '图片上传中...';
  const response = await fetchWithTimeout('/api/admin/upload-image', {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
    timeoutMs: EXPORT_TIMEOUT_MS
  });
  const json = await parseJsonResponse(response);
  if (!response.ok || json.status !== 'success') {
    throw new Error(json.message || '图片上传失败');
  }

  const url = json.data && json.data.url ? json.data.url : '';
  const target = document.getElementById('contentImageUploadTarget').value;
  document.getElementById('contentImageUploadedUrl').value = url;
  if (target === 'logo') {
    document.getElementById('contentLogoImage').value = url;
  } else if (target === 'banner') {
    document.getElementById('contentHomeBanner').value = url;
  }
  fileInput.value = '';
  miniappContentMsg.textContent = '图片已上传，请保存小程序内容。';
}

async function loadSystemStatus() {
  const data = await request('/api/admin/system-status', { headers: authHeaders() });
  setText('systemStorageMode', data.storage.mode);
  setText('systemOssConfigured', formatConfigured(data.storage.configured));
  setText('systemMiniappConfigured', formatConfigured(data.miniapp.configured));
  setText('systemSafetyConfigured', `${formatConfigured(data.content_safety.configured)}（${data.content_safety.mode}）`);
  setText('systemChainEnv', data.chain.env || '-');
  setText('systemChainConfigured', `${formatConfigured(data.chain.ready_for_real_submit)}（${data.chain.enabled ? '已启用' : '未启用'} / 密钥${formatConfigured(data.chain.configured)} / 项目${formatConfigured(data.chain.project_id_configured)} / 主体${formatConfigured(data.chain.identity_configured)}）`);
  setText('systemChainCallback', formatConfigured(data.chain.callback_url_configured));
  setText('systemArchiveConfigured', `${formatConfigured(data.archive.configured)}（${data.archive.mode} / ${data.archive.object_prefix}）`);
  setText('systemArchiveIndex', data.archive.records_index_path || '-');
  setText('systemArchiveBackup', data.archive.db_backup_latest_path || '-');
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
  item.addEventListener('click', () => {
    if (activeSection === 'products' && productDirty && item.dataset.adminSection !== 'products') {
      if (!window.confirm('当前商品有未保存修改，确定离开吗？')) return;
      clearProductForm();
    }
    activateAdminSection(item.dataset.adminSection);
  });
});

document.getElementById('refreshBtn').addEventListener('click', loadDashboard);
document.getElementById('createBatchBtn').addEventListener('click', () => createBatch().catch((e) => {
  batchMsg.textContent = e.message || '创建失败';
}));
document.getElementById('refreshBatchBtn').addEventListener('click', () => loadBatches().catch(() => {}));
document.getElementById('generateQrBtn').addEventListener('click', () => generateQRCodes());
document.getElementById('createOpBtn').addEventListener('click', () => createOperator().catch((e) => { opMsg.textContent = e.message || '创建失败'; }));
document.getElementById('refreshOpBtn').addEventListener('click', () => loadOperators().catch(() => {}));
document.getElementById('refreshProductBtn').addEventListener('click', () => loadProducts().catch(() => {}));
document.getElementById('refreshOrderBtn').addEventListener('click', () => loadOrders().catch((e) => { orderMsg.textContent = e.message || '刷新失败'; }));
document.getElementById('searchOrderBtn').addEventListener('click', () => {
  orderPage = 1;
  loadOrders().catch((error) => { orderMsg.textContent = error.message || '查询失败'; });
});
document.getElementById('resetOrderSearchBtn').addEventListener('click', () => {
  document.getElementById('orderSearch').value = '';
  orderPage = 1;
  loadOrders().catch((error) => { orderMsg.textContent = error.message || '查询失败'; });
});
document.getElementById('orderSearch').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  orderPage = 1;
  loadOrders().catch((error) => { orderMsg.textContent = error.message || '查询失败'; });
});
document.querySelectorAll('[data-order-status]').forEach((button) => {
  button.addEventListener('click', () => {
    orderStatus = button.dataset.orderStatus;
    orderPage = 1;
    document.querySelectorAll('[data-order-status]').forEach((item) => {
      item.classList.toggle('active', item === button);
    });
    loadOrders().catch((error) => { orderMsg.textContent = error.message || '查询失败'; });
  });
});
document.getElementById('previousOrderPageBtn').addEventListener('click', () => {
  if (orderPage <= 1) return;
  orderPage -= 1;
  loadOrders().catch((error) => { orderMsg.textContent = error.message || '翻页失败'; });
});
document.getElementById('nextOrderPageBtn').addEventListener('click', () => {
  if (orderPage >= orderTotalPages) return;
  orderPage += 1;
  loadOrders().catch((error) => { orderMsg.textContent = error.message || '翻页失败'; });
});
document.getElementById('closeOrderDrawerBtn').addEventListener('click', closeOrderDrawer);
document.getElementById('orderDrawerBackdrop').addEventListener('click', closeOrderDrawer);
document.getElementById('drawerShipOrderBtn').addEventListener('click', openShippingModal);
document.getElementById('closeShippingModalBtn').addEventListener('click', () => closeShippingModal());
document.getElementById('cancelShippingBtn').addEventListener('click', () => closeShippingModal());
document.getElementById('saveShippingBtn').addEventListener('click', saveOrderShipment);
document.getElementById('shippingModalBackdrop').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeShippingModal();
});
document.getElementById('newProductBtn').addEventListener('click', showNewProductEditor);
document.getElementById('emptyNewProductBtn').addEventListener('click', showNewProductEditor);
document.getElementById('backToProductsBtn').addEventListener('click', showProductList);
document.getElementById('saveProductDraftBtn').addEventListener('click', () => saveProduct('draft'));
document.getElementById('publishProductBtn').addEventListener('click', () => saveProduct('published'));
document.getElementById('hideProductBtn').addEventListener('click', () => {
  if (window.confirm('隐藏后商品将不再对用户展示，确定继续吗？')) saveProduct('hidden');
});
document.getElementById('uploadProductImageBtn').addEventListener('click', () => uploadProductImage().catch((error) => {
  document.getElementById('productEditorMsg').textContent = error.message || '图片上传失败。';
}));
document.getElementById('productSearch').addEventListener('input', () => renderProducts(productList));
document.getElementById('productStatusFilter').addEventListener('change', () => renderProducts(productList));
document.getElementById('productPriceYuan').addEventListener('input', updateProductPricePreview);
document.querySelectorAll('[data-product-field]').forEach((field) => {
  field.addEventListener('input', () => {
    setProductDirty(true);
    if (field.id === 'productCover' || field.id === 'productImages') renderProductMedia();
  });
  field.addEventListener('change', () => setProductDirty(true));
});
window.addEventListener('beforeunload', (event) => {
  if (!productDirty) return;
  event.preventDefault();
  event.returnValue = '';
});
document.getElementById('refreshMiniappContentBtn').addEventListener('click', () => loadMiniappContent().catch((e) => {
  miniappContentMsg.textContent = e.message || '刷新失败';
}));
document.getElementById('saveMiniappContentBtn').addEventListener('click', () => saveMiniappContent().catch((e) => {
  miniappContentMsg.textContent = e.message || '保存失败';
}));
document.getElementById('uploadMiniappImageBtn').addEventListener('click', () => uploadMiniappContentImage().catch((e) => {
  miniappContentMsg.textContent = e.message || '上传失败';
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
document.getElementById('createPrintBatchFromSelectionBtn').addEventListener('click', () => {
  if (selectedIds.size === 0) {
    alert('请先勾选二维码。');
    return;
  }
  const selectedRecords = currentRecords.filter((item) => selectedIds.has(item.id));
  const eligibleIds = selectedRecords.filter(isQrAvailableForPrinting).map((item) => item.id);
  const excludedCount = selectedIds.size - eligibleIds.length;
  if (eligibleIds.length === 0) {
    alert('所选二维码均不可用于新印刷任务。历史未分类二维码需先确认可生产，已打印或已报废二维码不能重复使用。');
    return;
  }
  if (excludedCount > 0 && !window.confirm(
    `已排除 ${excludedCount} 个不可生产二维码，只带入 ${eligibleIds.length} 个可生产二维码。是否继续？`
  )) return;
  window.PrintBatchAdmin.openWithQrIds(eligibleIds);
  activateAdminSection('printBatches');
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
  const archiveBtn = event.target.closest('button[data-archive-id]');
  if (archiveBtn) {
    const qrId = archiveBtn.getAttribute('data-archive-id');
    try {
      await request(`/api/admin/records/${encodeURIComponent(qrId)}/archive/rebuild`, {
        method: 'POST',
        headers: authHeaders()
      });
      recordMsg.textContent = '已重建 OSS 档案索引。';
      await loadContentRecords();
    } catch (error) {
      recordMsg.textContent = error.message || '档案重建失败。';
    }
    return;
  }

  const chainBtn = event.target.closest('button[data-chain-id]');
  if (chainBtn) {
    const qrId = chainBtn.getAttribute('data-chain-id');
    const action = chainBtn.getAttribute('data-chain-action');
    try {
      await request(`/api/admin/records/${encodeURIComponent(qrId)}/chain/${action}`, {
        method: 'POST',
        headers: authHeaders()
      });
      recordMsg.textContent = action === 'retry' ? '已重新提交存证。' : '已刷新存证状态。';
      await loadContentRecords();
    } catch (error) {
      recordMsg.textContent = error.message || '存证操作失败。';
    }
    return;
  }

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
  const target = event.target.closest('[data-product-edit], [data-product-open]');
  if (!target) return;
  const productId = target.getAttribute('data-product-edit') || target.getAttribute('data-product-open');
  openProductEditor(productId);
});

document.getElementById('productMediaList').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-media-action]');
  if (!button) return;
  updateProductMedia(button.dataset.mediaAction, button.dataset.mediaUrl);
});

orderTableBody.addEventListener('click', (event) => {
  const target = event.target.closest('[data-order-detail], [data-order-open]');
  if (!target) return;
  const orderId = target.getAttribute('data-order-detail') || target.getAttribute('data-order-open');
  openOrderDetail(orderId);
});

if (adminToken) {
  showPanelsAfterLogin();
}
