const { extractQrKey, parseTokenFromUrl } = require('../../utils/qr');

Page({
  data: {},

  onLoad(options) {
    const key = extractQrKey(options);
    if (key) {
      wx.redirectTo({ url: `/pages/record/record?key=${encodeURIComponent(key)}` });
    }
  },

  scanCode() {
    wx.scanCode({
      success: (res) => {
        const key = parseTokenFromUrl(res.result) || res.result;
        if (!key) {
          wx.showToast({ title: '未识别到二维码', icon: 'none' });
          return;
        }
        wx.navigateTo({ url: `/pages/record/record?key=${encodeURIComponent(key)}` });
      },
      fail: () => wx.showToast({ title: '扫码取消', icon: 'none' })
    });
  },

  goProducts() {
    wx.navigateTo({ url: '/pages/products/products' });
  },

  goMe() {
    wx.navigateTo({ url: '/pages/me/me' });
  }
});
