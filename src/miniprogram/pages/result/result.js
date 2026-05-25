const { login } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');
const { extractQrKey } = require('../../utils/qr');

Page({
  data: {
    key: '',
    record: null,
    hashVisible: false,
    hashButtonText: '查看区块链凭证',
    message: '加载中...'
  },

  onLoad(options) {
    this.setData({ key: extractQrKey(options) });
    login().then(() => this.loadRecord()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  onShareAppMessage() {
    return {
      title: '记在星上，闪到永远',
      path: `/pages/result/result?key=${encodeURIComponent(this.data.key)}`
    };
  },

  loadRecord() {
    request({
      url: `/api/miniapp/qr/${encodeURIComponent(this.data.key)}`
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
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  toggleHash() {
    const hashVisible = !this.data.hashVisible;
    this.setData({
      hashVisible,
      hashButtonText: hashVisible ? '收起凭证' : '查看区块链凭证'
    });
  },

  goMe() {
    wx.navigateTo({ url: '/pages/me/me' });
  }
});
