const { extractQrKey, parseTokenFromUrl } = require('../../utils/qr');
const { request, resolveAssetUrl } = require('../../utils/request');

const SCENE_OPTIONS = [
  { key: 'lover', label: '恋人', desc: '把说不出口的话，贴在这一瓶酒上。' },
  { key: 'elder', label: '长辈', desc: '把感谢和祝福，认真留给重要的人。' },
  { key: 'birthday', label: '生日', desc: '把今天的祝福，留到以后还能看见。' },
  { key: 'wedding', label: '婚礼', desc: '把承诺和祝福，留在共同举杯时。' },
  { key: 'party', label: '聚会', desc: '让一桌人的话，一起留在这瓶酒里。' }
];

Page({
  data: {
    content: {
      home_title: '给这瓶酒，贴上一颗星',
      home_subtitle: '贴上酒瓶星贴，上传一张照片，写下一句话。',
      project_title: '星星在闪',
      project_body: '把值得记住的时刻，存在这瓶酒里。',
      consult_label: '咨询购买',
      consult_url: '',
      share_title: '记在星上，闪到永远',
      share_description: '让故事与时间一同酝酿，区块链存证，一经封存，不可篡改。'
    },
    bannerImage: '',
    hasBanner: false,
    hasConsultUrl: false,
    sceneOptions: SCENE_OPTIONS
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

  onShareTimeline() {
    return {
      title: this.data.content.share_title
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

  focusScenes() {
    wx.pageScrollTo({
      selector: '.home-commerce-section',
      duration: 320
    });
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

  goSceneProducts(event) {
    const scene = event.currentTarget.dataset.scene || 'free';
    getApp().globalData.selectedProductScene = scene;
    wx.setStorageSync('selectedProductScene', scene);
    wx.switchTab({ url: '/pages/products/products' });
  },

  goProducts() {
    getApp().globalData.selectedProductScene = 'free';
    wx.setStorageSync('selectedProductScene', 'free');
    wx.switchTab({ url: '/pages/products/products' });
  },

  goProject() {
    wx.switchTab({ url: '/pages/project/project' });
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
    wx.switchTab({ url: '/pages/me/me' });
  }
});
