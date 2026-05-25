const loginPanel = document.getElementById('loginPanel');
const qcPanel = document.getElementById('qcPanel');
const loginMsg = document.getElementById('loginMsg');
const checkMsg = document.getElementById('checkMsg');
const logBody = document.getElementById('logBody');

let qcToken = localStorage.getItem('qcToken') || '';
const REQUEST_TIMEOUT_MS = 15000;

function authHeaders() {
  return {
    Authorization: `Bearer ${qcToken}`
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
