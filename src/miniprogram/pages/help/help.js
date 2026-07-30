Page({
  openPrivacy() {
    if (!wx.openPrivacyContract) {
      wx.showToast({ title: '请在微信中查看隐私保护指引', icon: 'none' });
      return;
    }
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: '暂时无法打开，请稍后重试', icon: 'none' })
    });
  },

  goProducts() {
    wx.switchTab({ url: '/pages/products/products' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});
