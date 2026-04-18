const loginPanel = document.getElementById('loginPanel');
const dashboardPanel = document.getElementById('dashboardPanel');
const batchPanel = document.getElementById('batchPanel');
const recordsPanel = document.getElementById('recordsPanel');
const operatorPanel = document.getElementById('operatorPanel');
const loginMsg = document.getElementById('loginMsg');
const batchMsg = document.getElementById('batchMsg');
const opMsg = document.getElementById('opMsg');
const tableBody = document.getElementById('recordTable');
const batchTableBody = document.getElementById('batchTable');
const operatorTableBody = document.getElementById('operatorTable');
const selectedCount = document.getElementById('selectedCount');
const selectAll = document.getElementById('selectAll');

let adminToken = localStorage.getItem('adminToken') || '';
let currentRecords = [];
let batchList = [];
const selectedIds = new Set();

function authHeaders() {
  return {
    Authorization: `Bearer ${adminToken}`
  };
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const json = await response.json();
  if (!response.ok || json.status !== 'success') {
    throw new Error(json.message || '请求失败');
  }
  return json.data;
}

function showPanelsAfterLogin() {
  loginPanel.classList.add('hidden');
  dashboardPanel.classList.remove('hidden');
  batchPanel.classList.remove('hidden');
  recordsPanel.classList.remove('hidden');
  operatorPanel.classList.remove('hidden');
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

function renderBatchOptions() {
  const options = ['<option value="">批次（全部）</option>']
    .concat(batchList.map((batch) => `<option value="${batch.id}">${batch.name} (${batch.id})</option>`))
    .join('');
  document.getElementById('batchFilter').innerHTML = options;

  const assignOptions = ['<option value="">选择批次后可绑定</option>']
    .concat(batchList.map((batch) => `<option value="${batch.id}">${batch.name} (${batch.id})</option>`))
    .join('');
  document.getElementById('assignBatchSelect').innerHTML = assignOptions;

  const qrBatchOptions = ['<option value="">选择批次（选填）</option>']
    .concat(batchList.map((batch) => `<option value="${batch.id}">${batch.name} (${batch.id})</option>`))
    .join('');
  document.getElementById('qrBatchSelect').innerHTML = qrBatchOptions;
}

function renderBatchRows() {
  batchTableBody.innerHTML = batchList
    .map((batch) => `<tr>
      <td>${batch.id}</td>
      <td>${batch.name}</td>
      <td>${batch.brand_name || '-'}</td>
      <td>${batch.note || '-'}</td>
      <td>${batch.total_codes}</td>
      <td>${batch.activation_rate}%</td>
      <td><button data-batch-export="${batch.id}">导出批次CSV</button></td>
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
    body: JSON.stringify({ name, brand_name: brandName, note, brand_disclosure_text: disclosureText, brand_disclosure_default: disclosureDefault })
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
        <td>${op.id}</td>
        <td>${op.name || '-'}</td>
        <td>${op.username}</td>
        <td>${op.role}</td>
        <td>${op.enabled ? '启用' : '禁用'}</td>
        <td>
          <button data-op-id="${op.id}" data-op-action="${action}">${actionLabel}</button>
          <button data-op-id="${op.id}" data-op-action="change-password">改密码</button>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadOperators() {
  const data = await request('/api/admin/operators', { headers: authHeaders() });
  renderOperators(data.operators || []);
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

  document.getElementById('totalIssued').textContent = data.total_issued;
  document.getElementById('totalActivated').textContent = data.total_activated;
  document.getElementById('pendingCount').textContent = data.circulating_pending;
  document.getElementById('activationRate').textContent = `${data.period_activation_rate}%`;
}

function renderRows(records) {
  currentRecords = records;
  tableBody.innerHTML = records
    .map((item) => {
      const actionLabel = item.hidden ? '显示' : '隐藏';
      const actionFn = item.hidden ? 'show' : 'hide';
      const checked = selectedIds.has(item.id) ? 'checked' : '';
      return `<tr>
        <td><input type="checkbox" data-row-id="${item.id}" ${checked} /></td>
        <td>${item.id}</td>
        <td>${item.qr_image_url ? `<a href="${item.qr_image_url}" target="_blank" download="${item.id}.png">查看</a>` : '-'}</td>
        <td>${item.batch_id || '-'}</td>
        <td>${getBatchNote(item.batch_id)}</td>
        <td>${item.issue_status}</td>
        <td>${item.activation_status}</td>
        <td>${item.hidden ? '隐藏' : '显示'}</td>
        <td>${item.phone || '-'}</td>
        <td>${item.activated_at || item.created_at}</td>
        <td><button data-id="${item.id}" data-action="${actionFn}">${actionLabel}</button></td>
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

async function toggleHiddenStatus(qrId, action) {
  await request(`/api/admin/records/${encodeURIComponent(qrId)}/${action}`, {
    method: 'POST',
    headers: authHeaders()
  });
  await loadRecords();
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

  const response = await fetch('/api/admin/records/export', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ids: [...selectedIds] })
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.message || '导出失败');
  }

  await downloadFromResponse(response, `records-export-${Date.now()}.csv`);
}

async function exportBatch(batchId) {
  const response = await fetch(`/api/admin/batches/${encodeURIComponent(batchId)}/export`, {
    headers: authHeaders()
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.message || '批次导出失败');
  }

  await downloadFromResponse(response, `batch-${batchId}-${Date.now()}.csv`);
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
    await loadDashboard();
    await loadBatches();
    await loadRecords();
    await loadOperators();
  } catch (error) {
    loginMsg.textContent = error.message || '登录失败';
  }
});

document.getElementById('refreshBtn').addEventListener('click', loadDashboard);
document.getElementById('createBatchBtn').addEventListener('click', () => createBatch().catch((e) => {
  batchMsg.textContent = e.message || '创建失败';
}));
document.getElementById('refreshBatchBtn').addEventListener('click', () => loadBatches().catch(() => {}));
document.getElementById('generateQrBtn').addEventListener('click', () => generateQRCodes());
document.getElementById('createOpBtn').addEventListener('click', () => createOperator().catch((e) => { opMsg.textContent = e.message || '创建失败'; }));
document.getElementById('refreshOpBtn').addEventListener('click', () => loadOperators().catch(() => {}));
document.getElementById('filterBtn').addEventListener('click', async () => {
  selectedIds.clear();
  await loadRecords();
});

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

if (adminToken) {
  showPanelsAfterLogin();
  Promise.all([loadDashboard(), loadBatches(), loadRecords(), loadOperators()]).catch(() => {
    localStorage.removeItem('adminToken');
    location.reload();
  });
}
