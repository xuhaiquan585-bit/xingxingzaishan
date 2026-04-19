const phoneInput = document.getElementById('phone');
const agreeInput = document.getElementById('agree');
const registerBtn = document.getElementById('registerBtn');
const messageEl = document.getElementById('message');

const urlParams = new URLSearchParams(window.location.search);
const qrId = urlParams.get('qr');

function updateButtonState() {
  const validPhone = /^1\d{10}$/.test(phoneInput.value.trim());
  registerBtn.disabled = !(validPhone && agreeInput.checked);
}

phoneInput.addEventListener('input', updateButtonState);
agreeInput.addEventListener('change', updateButtonState);

registerBtn.addEventListener('click', async () => {
  try {
    registerBtn.disabled = true;
    const phone = phoneInput.value.trim();
    const result = await apiRequest('/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });

    localStorage.setItem('userPhone', result.data.phone);
    messageEl.textContent = '注册成功，正在返回点亮页面...';
    window.location.href = `/record.html?qr=${encodeURIComponent(qrId || 'STAR0001')}`;
  } catch (error) {
    messageEl.textContent = error.message || '注册失败，请检查网络后重试';
    updateButtonState();
  }
});
