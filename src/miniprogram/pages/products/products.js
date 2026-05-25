const { request, resolveAssetUrl } = require('../../utils/request');

Page({
  data: {
    products: [],
    message: '加载中...'
  },

  onLoad() {
    this.loadProducts();
  },

  loadProducts() {
    request({
      url: '/api/miniapp/products',
      auth: false
    }).then((data) => {
      const products = (data.products || []).map((item) => ({
        ...item,
        cover_image: resolveAssetUrl(item.cover_image)
      }));
      this.setData({
        products,
        message: products.length ? '' : '暂无上架商品'
      });
    }).catch((error) => {
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  openProduct(event) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/product-detail/product-detail?id=${encodeURIComponent(id)}` });
  }
});
