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

  copyBuyLink() {
    const url = this.data.product && this.data.product.buy_url;
    if (!url) {
      wx.showToast({ title: '暂无购买链接', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '购买链接已复制', icon: 'success' })
    });
  }
});
