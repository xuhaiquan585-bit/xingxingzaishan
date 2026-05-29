const { extractQrKey, parseTokenFromUrl } = require('../../utils/qr');
const { request, resolveAssetUrl } = require('../../utils/request');

Page({
  data: {
    content: {
      home_title: '把此刻，记在这瓶酒里',
      home_subtitle: '让故事与时间一同酝酿，区块链存证，一经封存，不可篡改。',
      project_title: '星星在闪',
      project_body: '把值得记住的时刻，存在这瓶酒里。',
      consult_label: '咨询购买',
      consult_url: '',
      share_title: '记在星上，闪到永远',
      share_description: '让故事与时间一同酝酿，区块链存证，一经封存，不可篡改。'
    },
    bannerImage: '',
    hasBanner: false,
    hasConsultUrl: false
  },

  onLoad(options) {
    const key = extractQrKey(options);
    if (key) {
      wx.redirectTo({ url: `/pages/record/record?key=${encodeURIComponent(key)}` });
      return;
    }
    this.loadContent();
  },

  onShareAppMessage() {
    return {
      title: this.data.content.share_title,
      path: '/pages/home/home'
    };
  },

  loadContent() {
    request({
      url: '/api/miniapp/content',
      auth: false
    }).then((data) => {
      const bannerImage = resolveAssetUrl(data.home_banner_image);
      this.setData({
        content: data,
        bannerImage,
        hasBanner: !!bannerImage,
        hasConsultUrl: !!data.consult_url
      });
    }).catch(() => {});
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

  goProject() {
    wx.navigateTo({ url: '/pages/project/project' });
  },

  copyConsultLink() {
    const url = this.data.content.consult_url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '咨询链接已复制', icon: 'success' })
    });
  },

  goMe() {
    wx.navigateTo({ url: '/pages/me/me' });
  }
});
