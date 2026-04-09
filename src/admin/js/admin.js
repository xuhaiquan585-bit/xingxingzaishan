const loginPanel = document.getElementById('loginPanel');
const dashboardPanel = document.getElementById('dashboardPanel');
const recordsPanel = document.getElementById('recordsPanel');
const loginMsg = document.getElementById('loginMsg');
const tableBody = document.getElementById('recordTable');

let adminToken = localStorage.getItem('adminToken') || '';

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
  tableBody.innerHTML = records
    .map((item) => {
      const actionLabel = item.hidden ? '显示' : '隐藏';
      const actionFn = item.hidden ? 'show' : 'hide';
      return `<tr>
        <td>${item.id}</td>
        <td>${item.activation_status}</td>
        <td>${item.hidden ? '隐藏' : '显示'}</td>
        <td>${item.phone || '-'}</td>
        <td>${item.activated_at || item.created_at}</td>
        <td><button data-id="${item.id}" data-action="${actionFn}">${actionLabel}</button></td>
      </tr>`;
    })
    .join('');
}

async function loadRecords() {
  const activationStatus = document.getElementById('activationStatus').value;
  const hiddenStatus = document.getElementById('hiddenStatus').value;
  const query = new URLSearchParams({ page: '1', limit: '20' });
  if (activationStatus) query.set('activation_status', activationStatus);
  if (hiddenStatus !== '') query.set('hidden', hiddenStatus);

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
document.getElementById('filterBtn').addEventListener('click', loadRecords);

tableBody.addEventListener('click', async (event) => {
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
