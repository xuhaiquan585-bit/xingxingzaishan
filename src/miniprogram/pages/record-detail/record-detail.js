const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');

Page({
  data: {
    id: '',
    record: null,
    message: '加载中...'
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    login().then(() => this.loadDetail()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  loadDetail() {
    request({
      url: `/api/miniapp/user/records/${encodeURIComponent(this.data.id)}`
    }).then((data) => {
      this.setData({
        record: {
          ...data,
          image_url: resolveAssetUrl(data.image_url),
          display_content: data.content || '（未填写留言）',
          has_comments: Array.isArray(data.co_creation_comments) && data.co_creation_comments.length > 0
        },
        message: ''
      });
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone(`/pages/record-detail/record-detail?id=${encodeURIComponent(this.data.id)}`);
        return;
      }
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  }
});
