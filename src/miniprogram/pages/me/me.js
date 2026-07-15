const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');

Page({
  data: {
    records: [],
    message: '加载中...'
  },

  onLoad() {
    login().then(() => this.loadRecords()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  loadRecords() {
    request({
      url: '/api/miniapp/user/records'
    }).then((data) => {
      const records = (data.records || []).map((item) => ({
        ...item,
        image_url: resolveAssetUrl(item.image_url),
        display_content: item.content || '（未填写留言）',
        status_label: item.activation_status === 'co_creating' ? '共创中' : '已保存'
      }));
      this.setData({
        records,
        message: records.length ? '' : '还没有记录。'
      });
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone('/pages/me/me');
        return;
      }
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  openRecord(event) {
    const item = this.data.records.find((record) => record.id === event.currentTarget.dataset.id);
    if (item && item.activation_status === 'co_creating') {
      wx.navigateTo({ url: `/pages/co-create/co-create?key=${encodeURIComponent(item.id)}` });
      return;
    }
    wx.navigateTo({ url: `/pages/record-detail/record-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' });
  }
});
