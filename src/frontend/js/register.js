const phoneInput = document.getElementById('phone');
const smsCodeInput = document.getElementById('smsCode');
const sendCodeBtn = document.getElementById('sendCodeBtn');
const agreeInput = document.getElementById('agree');
const registerBtn = document.getElementById('registerBtn');
const messageEl = document.getElementById('message');
const wechatLoginHint = document.getElementById('wechatLoginHint');
const authMethodTitle = document.getElementById('authMethodTitle');
const authMethodSubtitle = document.getElementById('authMethodSubtitle');

const urlParams = new URLSearchParams(window.location.search);
const qrId = urlParams.get('t') || urlParams.get('qr');
const SUPPORTED_UI_THEMES = new Set(['dark', 'dawn']);
const uiTheme = SUPPORTED_UI_THEMES.has(urlParams.get('ui')) ? urlParams.get('ui') : '';
const SUPPORTED_BG_THEMES = new Set(['mist', 'paper', 'blue']);
const bgTheme = SUPPORTED_BG_THEMES.has(urlParams.get('bg')) ? urlParams.get('bg') : '';
const SUPPORTED_DRAFT_SOURCES = new Set(['upload', 'replace-photo', 'submit']);
const draftSource = SUPPORTED_DRAFT_SOURCES.has(urlParams.get('source')) ? urlParams.get('source') : '';

if (/MicroMessenger/i.test(window.navigator.userAgent) && wechatLoginHint) {
  wechatLoginHint.classList.remove('hidden');
}

function renderTextLines(element, lines) {
  if (!element) return;
  element.textContent = '';
  lines.forEach((line, index) => {
    if (index > 0) {
      element.appendChild(document.createElement('br'));
    }
    element.appendChild(document.createTextNode(line));
  });
}

function renderAuthCopy() {
  if (!authMethodTitle || !authMethodSubtitle) return;

  if (draftSource === 'upload' || draftSource === 'replace-photo') {
    authMethodTitle.textContent = '验证手机号，继续添加照片';
    renderTextLines(authMethodSubtitle, [
      '刚才填写的文字和选项已为你保留。',
      '验证后，这条记录会与你的手机号关联，方便以后查看和管理。',
      '验证完成后，请继续选择照片。'
    ]);
    return;
  }

  if (draftSource === 'submit') {
    authMethodTitle.textContent = '验证手机号，继续保存记录';
    renderTextLines(authMethodSubtitle, [
      '刚才填写的内容已为你保留。',
      '验证后，这条记录会与你的手机号关联，方便以后查看和管理。',
      '验证完成后，会回到记录页继续确认。'
    ]);
    return;
  }

  authMethodTitle.textContent = '验证手机号，继续完成这条记录';
  renderTextLines(authMethodSubtitle, [
    '刚才填写的内容已为你保留。',
    '验证后，这条记录会与你的手机号关联，方便以后查看和管理。'
  ]);
}

renderAuthCopy();

function updateButtonState() {
  const validPhone = /^1\d{10}$/.test(phoneInput.value.trim());
  const validCode = /^\d{6}$/.test(smsCodeInput.value.trim());
  sendCodeBtn.disabled = !validPhone || sendCodeBtn.dataset.cooldown === '1';
  registerBtn.disabled = !(validPhone && validCode && agreeInput.checked);
}

phoneInput.addEventListener('input', updateButtonState);
smsCodeInput.addEventListener('input', updateButtonState);
agreeInput.addEventListener('change', updateButtonState);

function showMessage(message) {
  messageEl.textContent = message;
}

function startCooldown(seconds) {
  let remain = Number(seconds) || 60;
  sendCodeBtn.dataset.cooldown = '1';
  sendCodeBtn.disabled = true;
  sendCodeBtn.textContent = `${remain}s后重试`;
  const timer = window.setInterval(() => {
    remain -= 1;
    if (remain <= 0) {
      window.clearInterval(timer);
      delete sendCodeBtn.dataset.cooldown;
      sendCodeBtn.textContent = '获取验证码';
      updateButtonState();
      return;
    }
    sendCodeBtn.textContent = `${remain}s后重试`;
  }, 1000);
}

sendCodeBtn.addEventListener('click', async () => {
  const phone = phoneInput.value.trim();
  if (!/^1\d{10}$/.test(phone)) {
    showMessage('请输入正确的手机号');
    return;
  }

  try {
    sendCodeBtn.disabled = true;
    showMessage('验证码发送中...');
    const result = await apiRequest('/api/user/sms/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const cooldown = result.data && result.data.cooldown_in_seconds ? result.data.cooldown_in_seconds : 60;
    startCooldown(cooldown);
    showMessage('验证码已发送，请注意查收短信');
    if (result.data && result.data.verification_code) {
      showMessage(`测试验证码：${result.data.verification_code}（仅开发环境可见）`);
    }
  } catch (error) {
    showMessage(error.message || '验证码发送失败，请稍后再试');
    updateButtonState();
  }
});

registerBtn.addEventListener('click', async () => {
  try {
    registerBtn.disabled = true;
    const phone = phoneInput.value.trim();
    const code = smsCodeInput.value.trim();
    await apiRequest('/api/user/sms/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code })
    });

    showMessage('验证成功，正在返回填写页面...');
    const next = new URLSearchParams();
    next.set('t', qrId || '');
    if (uiTheme) {
      next.set('ui', uiTheme);
    }
    if (bgTheme) {
      next.set('bg', bgTheme);
    }
    if (draftSource) {
      next.set('source', draftSource);
    }
    window.location.href = `/record.html?${next.toString()}`;
  } catch (error) {
    showMessage(error.message || '验证失败，请稍后重试');
    updateButtonState();
  }
});
