const { login, bindPhone } = require('../../utils/auth');

const TAB_PAGES = new Set([
  '/pages/home/home',
  '/pages/products/products',
  '/pages/me/me',
  '/pages/project/project'
]);

function goAfterBind(redirect) {
  const path = String(redirect || '/pages/home/home').split('?')[0];
  if (TAB_PAGES.has(path)) {
    wx.switchTab({ url: path });
    return;
  }
  wx.redirectTo({ url: redirect || '/pages/home/home' });
}

Page({
  data: {
    redirect: '/pages/home/home',
    message: '',
    binding: false
  },

  onLoad(options) {
    this.setData({
      redirect: decodeURIComponent(options.redirect || '/pages/home/home')
    });
    login().catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  onGetPhoneNumber(event) {
    const code = event.detail && event.detail.code;
    if (!code) {
      this.setData({ message: '需要授权手机号后继续。' });
      return;
    }
    this.setData({
      binding: true,
      message: '正在登录...'
    });
    bindPhone(code).then(() => {
      goAfterBind(this.data.redirect);
    }).catch((error) => {
      this.setData({
        binding: false,
        message: error.message || '手机号绑定失败，请稍后重试'
      });
    });
  }
});
