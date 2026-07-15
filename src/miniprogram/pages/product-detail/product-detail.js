const { request, resolveAssetUrl } = require('../../utils/request');

Page({
  data: {
    id: '',
    product: null,
    message: '加载中...'
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    this.loadProduct();
  },

  onShareAppMessage() {
    const product = this.data.product || {};
    return {
      title: product.title || '酒瓶星贴',
      path: `/pages/product-detail/product-detail?id=${encodeURIComponent(this.data.id)}`
    };
  },

  onShareTimeline() {
    const product = this.data.product || {};
    return {
      title: product.title || '酒瓶星贴',
      query: `id=${encodeURIComponent(this.data.id)}`
    };
  },

  loadProduct() {
    if (!this.data.id) {
      this.setData({ message: '缺少商品编号' });
      return;
    }
    request({
      url: `/api/miniapp/products/${encodeURIComponent(this.data.id)}`,
      auth: false
    }).then((data) => {
      this.setData({
        product: {
          ...data,
          cover_image: resolveAssetUrl(data.cover_image),
          images: (data.images || []).map(resolveAssetUrl)
        },
        message: ''
      });
    }).catch((error) => {
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  buyNow() {
    if (!this.data.product || !this.data.product.id) return;
    wx.navigateTo({
      url: `/pages/order-confirm/order-confirm?product_id=${encodeURIComponent(this.data.product.id)}`
    });
  }
});
