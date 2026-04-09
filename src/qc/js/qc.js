const loginPanel = document.getElementById('loginPanel');
const qcPanel = document.getElementById('qcPanel');
const loginMsg = document.getElementById('loginMsg');
const checkMsg = document.getElementById('checkMsg');
const logBody = document.getElementById('logBody');

let qcToken = localStorage.getItem('qcToken') || '';

function authHeaders() {
  return {
    Authorization: `Bearer ${qcToken}`
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

function showQCPanel() {
  loginPanel.classList.add('hidden');
  qcPanel.classList.remove('hidden');
}

function renderResultStyle(result) {
  if (result === 'pass') return { cls: 'pass', label: '✅ 通过' };
  if (result === 'duplicate') return { cls: 'fail', label: '❌ 重复' };
  return { cls: 'warn', label: '⚠️ 已绑定' };
}

function renderLogs(logs) {
  logBody.innerHTML = logs
    .map((item) => {
      const style = renderResultStyle(item.result);
      return `<tr>
        <td>${item.qr_id}</td>
        <td class="${style.cls}">${style.label}</td>
        <td>${item.checked_by}</td>
        <td>${item.checked_at}</td>
      </tr>`;
    })
    .join('');
}

async function refreshStats() {
  const stats = await request('/api/qc/stats', { headers: authHeaders() });
  document.getElementById('todayChecked').textContent = stats.today_checked;
  document.getElementById('todayAbnormal').textContent = stats.today_abnormal;
  document.getElementById('totalChecked').textContent = stats.total_checked;
}

async function refreshLogs() {
  const data = await request('/api/qc/logs?page=1&limit=10', { headers: authHeaders() });
  renderLogs(data.logs || []);
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

    qcToken = data.token;
    localStorage.setItem('qcToken', qcToken);
    showQCPanel();
    await refreshStats();
    await refreshLogs();
  } catch (error) {
    loginMsg.textContent = error.message || '登录失败';
  }
});

document.getElementById('checkBtn').addEventListener('click', async () => {
  const qrId = document.getElementById('qrInput').value.trim();
  if (!qrId) {
    checkMsg.textContent = '请输入二维码ID。';
    return;
  }

  try {
    const data = await request('/api/qc/check', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ qr_id: qrId })
    });

    const style = renderResultStyle(data.result);
    checkMsg.className = `msg ${style.cls}`;
    checkMsg.textContent = `${style.label} ${data.message}`;
    await refreshStats();
    await refreshLogs();
  } catch (error) {
    checkMsg.className = 'msg fail';
    checkMsg.textContent = error.message || '质检失败';
  }
});

if (qcToken) {
  showQCPanel();
  refreshStats().catch(() => {
    localStorage.removeItem('qcToken');
    location.reload();
  });
  refreshLogs().catch(() => {});
}
