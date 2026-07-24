const {
  bindPhoneBySms,
  isPhoneBound,
  login,
  normalizeBindPhoneSource,
  sendSmsCode
} = require('../../utils/auth');

const TAB_PAGES = new Set([
  '/pages/home/home',
  '/pages/products/products',
  '/pages/me/me',
  '/pages/project/project'
]);

const PHONE_PATTERN = /^1\d{10}$/;
const VERIFY_CODE_PATTERN = /^\d{6}$/;
const BOUND_MESSAGE = '当前微信账号已绑定手机号，更换手机号功能暂未开放。';

const SMS_ERROR_MESSAGES = {
  INVALID_PHONE: '请输入正确的手机号。',
  SMS_SEND_TOO_FREQUENT: '操作太频繁，请稍后再试。',
  INVALID_VERIFY_CODE: '验证码不正确或已过期，请重新获取。',
  SMS_SERVICE_UNAVAILABLE: '暂时无法完成手机号验证，请稍后重试。',
  PHONE_ALREADY_BOUND_TO_OTHER_WECHAT: '这个手机号已关联其他微信账号，暂时无法绑定。',
  MINIAPP_PHONE_REPLACE_REQUIRED: BOUND_MESSAGE,
  MINIAPP_ACCOUNT_CONFLICT: '账号状态异常，暂时无法绑定手机号，请联系客服处理。',
  MINIAPP_SMS_BIND_FAILED: '暂时无法完成手机号验证，请稍后重试。',
  UNAUTHORIZED: '请重新进入小程序后再试。'
};

function normalizePhoneInput(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 11);
}

function normalizeCodeInput(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 6);
}

function safeDecodeRedirect(value) {
  try {
    return decodeURIComponent(value || '/pages/home/home');
  } catch (_error) {
    return '/pages/home/home';
  }
}

function safeMessage(error, fallback) {
  return SMS_ERROR_MESSAGES[error && error.code] || fallback;
}

function goAfterBind(redirect) {
  const target = redirect || '/pages/home/home';
  const path = String(target).split('?')[0];
  if (TAB_PAGES.has(path)) {
    wx.switchTab({ url: path });
    return;
  }
  wx.redirectTo({ url: target });
}

Page({
  data: {
    redirect: '/pages/home/home',
    source: '',
    phone: '',
    code: '',
    message: '',
    sending: false,
    binding: false,
    blocked: false,
    countdown: 0,
    sendCodeText: '获取验证码'
  },

  onLoad(options) {
    this.setData({
      redirect: safeDecodeRedirect(options.redirect),
      source: normalizeBindPhoneSource(options.source)
    });
    login().then((data) => {
      if (data.phone_bound === true || isPhoneBound()) {
        this.setData({
          blocked: true,
          message: BOUND_MESSAGE
        });
      }
    }).catch(() => {
      this.setData({ message: '请重新进入小程序后再试。' });
    });
  },

  onUnload() {
    this.clearCountdown();
  },

  clearCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  },

  startCountdown(seconds) {
    this.clearCountdown();
    const total = Math.max(1, Number(seconds || 60));
    this.setData({
      countdown: total,
      sendCodeText: `${total}s`
    });
    this.countdownTimer = setInterval(() => {
      const next = this.data.countdown - 1;
      if (next <= 0) {
        this.clearCountdown();
        this.setData({
          countdown: 0,
          sendCodeText: '获取验证码'
        });
        return;
      }
      this.setData({
        countdown: next,
        sendCodeText: `${next}s`
      });
    }, 1000);
  },

  onPhoneInput(event) {
    this.setData({
      phone: normalizePhoneInput(event.detail.value),
      message: ''
    });
  },

  onCodeInput(event) {
    this.setData({
      code: normalizeCodeInput(event.detail.value),
      message: ''
    });
  },

  onSendCode() {
    if (this.data.blocked || this.data.sending || this.data.countdown > 0) return;
    if (!PHONE_PATTERN.test(this.data.phone)) {
      this.setData({ message: '请输入正确的手机号。' });
      return;
    }
    this.setData({
      sending: true,
      message: ''
    });
    sendSmsCode(this.data.phone).then((data) => {
      this.setData({
        sending: false,
        message: '验证码已发送，请留意短信。'
      });
      this.startCountdown(data.cooldown_in_seconds || 60);
    }).catch((error) => {
      this.setData({
        sending: false,
        message: safeMessage(error, '暂时无法完成手机号验证，请稍后重试。')
      });
    });
  },

  onSubmit() {
    if (this.data.blocked || this.data.binding) return;
    if (!PHONE_PATTERN.test(this.data.phone)) {
      this.setData({ message: '请输入正确的手机号。' });
      return;
    }
    if (!VERIFY_CODE_PATTERN.test(this.data.code)) {
      this.setData({ message: '验证码不正确或已过期，请重新获取。' });
      return;
    }
    this.setData({
      binding: true,
      message: '正在验证手机号...'
    });
    bindPhoneBySms(this.data.phone, this.data.code).then(() => {
      goAfterBind(this.data.redirect);
    }).catch((error) => {
      this.setData({
        binding: false,
        message: safeMessage(error, '暂时无法完成手机号验证，请稍后重试。')
      });
    });
  }
});
