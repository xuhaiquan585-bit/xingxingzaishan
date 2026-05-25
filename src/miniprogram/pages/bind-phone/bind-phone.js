const { login, bindPhone } = require('../../utils/auth');

Page({
  data: {
    redirect: '/pages/home/home',
    message: ''
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
    bindPhone(code).then(() => {
      wx.redirectTo({ url: this.data.redirect });
    }).catch((error) => {
      this.setData({ message: error.message || '手机号绑定失败，请稍后重试' });
    });
  }
});
