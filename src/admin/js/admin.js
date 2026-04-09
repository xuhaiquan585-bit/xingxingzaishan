const loginPanel = document.getElementById('loginPanel');
const dashboardPanel = document.getElementById('dashboardPanel');
const recordsPanel = document.getElementById('recordsPanel');
const loginMsg = document.getElementById('loginMsg');
const tableBody = document.getElementById('recordTable');
const selectedCount = document.getElementById('selectedCount');
const selectAll = document.getElementById('selectAll');

let adminToken = localStorage.getItem('adminToken') || '';
let currentRecords = [];
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
  recordsPanel.classList.remove('hidden');
}

function updateSelectedUI() {
  selectedCount.textContent = `已选 ${selectedIds.size} 条`;
  const currentIds = currentRecords.map((item) => item.id);
  const allSelected = currentIds.length > 0 && currentIds.every((id) => selectedIds.has(id));
  selectAll.checked = allSelected;
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
  const issueStatus = document.getElementById('issueStatus').value;
  const activationStatus = document.getElementById('activationStatus').value;
  const hiddenStatus = document.getElementById('hiddenStatus').value;
  const idSearch = document.getElementById('idSearch').value.trim();
  const query = new URLSearchParams({ page: '1', limit: '20' });
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

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `records-export-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
    await loadRecords();
  } catch (error) {
    loginMsg.textContent = error.message || '登录失败';
  }
});

document.getElementById('refreshBtn').addEventListener('click', loadDashboard);
document.getElementById('filterBtn').addEventListener('click', async () => {
  selectedIds.clear();
  await loadRecords();
});

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

if (adminToken) {
  showPanelsAfterLogin();
  loadDashboard().catch(() => {
    localStorage.removeItem('adminToken');
    location.reload();
  });
  loadRecords().catch(() => {});
}
