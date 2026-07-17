const { extractQrKey, parseTokenFromUrl } = require('../../utils/qr');
const { request, resolveAssetUrl } = require('../../utils/request');

const SCENE_OPTIONS = [
  { key: 'lover', label: '恋人', title: '恋人', description: '把说不出口的话，贴在这一瓶酒上。', image: '', button_text: '查看恋人星贴' },
  { key: 'elder', label: '长辈', title: '长辈', description: '把感谢和祝福，认真留给重要的人。', image: '', button_text: '查看长辈星贴' },
  { key: 'birthday', label: '生日', title: '生日', description: '把今天的祝福，留到以后还能看见。', image: '', button_text: '查看生日星贴' },
  { key: 'wedding', label: '婚礼', title: '婚礼', description: '把承诺和祝福，留在共同举杯时。', image: '', button_text: '查看婚礼星贴' },
  { key: 'party', label: '聚会', title: '聚会', description: '让一桌人的话，一起留在这瓶酒里。', image: '', button_text: '查看聚会星贴' }
];

const DEFAULT_SLIDES = [
  {
    image: '',
    title: '给这瓶酒，贴上一颗星',
    subtitle: '一张照片，一句话，让这瓶酒有自己的故事。',
    button_text: '去封存',
    action_type: 'products',
    scene_key: 'free'
  },
  {
    image: '',
    title: '已有星贴，直接扫码记录',
    subtitle: '拿到酒瓶星贴后，扫码上传照片和一句话。',
    button_text: '扫码记录',
    action_type: 'scan',
    scene_key: 'free'
  }
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
    logoImage: '',
    hasLogo: false,
    slides: DEFAULT_SLIDES,
    sceneCards: SCENE_OPTIONS
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
      const logoImage = resolveAssetUrl(data.logo_image);
      const slides = this.normalizeSlides(data.home_slides, bannerImage);
      const sceneCards = this.normalizeSceneCards(data.scene_cards);
      this.setData({
        content: data,
        logoImage,
        hasLogo: !!logoImage,
        slides,
        sceneCards
      });
    }).catch(() => {});
  },

  onLogoError() {
    this.setData({
      logoImage: '',
      hasLogo: false
    });
  },

  normalizeSlides(slides, bannerImage) {
    const source = Array.isArray(slides) && slides.length ? slides : DEFAULT_SLIDES;
    return source.slice(0, 5).map((item, index) => ({
      image: resolveAssetUrl(item.image) || (index === 0 ? bannerImage : ''),
      title: item.title || DEFAULT_SLIDES[index % DEFAULT_SLIDES.length].title,
      subtitle: item.subtitle || DEFAULT_SLIDES[index % DEFAULT_SLIDES.length].subtitle,
      button_text: item.button_text || DEFAULT_SLIDES[index % DEFAULT_SLIDES.length].button_text,
      action_type: item.action_type || 'products',
      scene_key: item.scene_key || 'free'
    }));
  },

  normalizeSceneCards(cards) {
    const source = Array.isArray(cards) && cards.length ? cards : SCENE_OPTIONS;
    return source.map((item, index) => {
      const fallback = SCENE_OPTIONS[index % SCENE_OPTIONS.length];
      return {
        key: item.key || fallback.key,
        label: item.label || fallback.label,
        title: item.title || fallback.title,
        description: item.description || fallback.description,
        image: resolveAssetUrl(item.image),
        button_text: item.button_text || fallback.button_text
      };
    });
  },

  handleSlideAction(event) {
    const action = event.currentTarget.dataset.action || 'products';
    const scene = event.currentTarget.dataset.scene || 'free';
    if (action === 'scan') {
      this.scanCode();
      return;
    }
    if (action === 'scene') {
      this.goScene(scene);
      return;
    }
    this.goProducts();
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
    this.goScene(scene);
  },

  goScene(scene) {
    getApp().globalData.selectedProductScene = scene;
    wx.setStorageSync('selectedProductScene', scene);
    wx.switchTab({ url: '/pages/products/products' });
  },

  goProducts() {
    getApp().globalData.selectedProductScene = 'free';
    wx.setStorageSync('selectedProductScene', 'free');
    wx.switchTab({ url: '/pages/products/products' });
  }
});
