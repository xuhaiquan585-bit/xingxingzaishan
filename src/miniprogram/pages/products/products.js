const { request, resolveAssetUrl } = require('../../utils/request');

const SCENE_OPTIONS = [
  { key: 'lover', label: '恋人' },
  { key: 'elder', label: '长辈' },
  { key: 'birthday', label: '生日' },
  { key: 'wedding', label: '婚礼' },
  { key: 'party', label: '聚会' },
  { key: 'free', label: '随心' }
];

Page({
  data: {
    sceneOptions: SCENE_OPTIONS,
    activeScene: 'free',
    activeSceneLabel: '随心',
    allProducts: [],
    products: [],
    message: '加载中...'
  },

  onLoad() {
    this.loadProducts();
  },

  onShow() {
    const app = getApp();
    const selected = (app.globalData && app.globalData.selectedProductScene)
      || wx.getStorageSync('selectedProductScene')
      || 'free';
    this.setActiveScene(selected);
  },

  onShareAppMessage() {
    return {
      title: '封存这一刻，先贴上一颗星',
      path: '/pages/products/products'
    };
  },

  loadProducts() {
    request({
      url: '/api/miniapp/products',
      auth: false
    }).then((data) => {
      const products = (data.products || []).map((item) => ({
        ...item,
        cover_image: resolveAssetUrl(item.cover_image),
        scene_tags: Array.isArray(item.scene_tags) ? item.scene_tags : []
      }));
      this.setData({
        allProducts: products
      }, () => this.filterProducts());
    }).catch((error) => {
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  setActiveScene(scene) {
    const matched = SCENE_OPTIONS.find((item) => item.key === scene) || SCENE_OPTIONS[5];
    const app = getApp();
    app.globalData.selectedProductScene = matched.key;
    wx.setStorageSync('selectedProductScene', matched.key);
    this.setData({
      activeScene: matched.key,
      activeSceneLabel: matched.label
    }, () => this.filterProducts());
  },

  filterProducts() {
    const { activeScene, allProducts } = this.data;
    const products = activeScene === 'free'
      ? allProducts
      : allProducts.filter((item) => Array.isArray(item.scene_tags) && item.scene_tags.includes(activeScene));
    this.setData({
      products,
      message: products.length ? '' : (allProducts.length ? '当前场景暂无推荐，看看随心里的全部选择。' : '暂无上架商品')
    });
  },

  changeScene(event) {
    this.setActiveScene(event.currentTarget.dataset.scene || 'free');
  },

  openProduct(event) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/product-detail/product-detail?id=${encodeURIComponent(id)}` });
  }
});
