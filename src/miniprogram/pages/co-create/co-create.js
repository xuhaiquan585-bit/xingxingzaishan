const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl, isPhoneBound } = require('../../utils/request');
const { extractQrKey } = require('../../utils/qr');

Page({
  data: {
    key: '',
    qr: null,
    canComment: false,
    authorName: '',
    commentContent: '',
    message: '加载中...'
  },

  onLoad(options) {
    const key = extractQrKey(options);
    this.setData({ key });
    login().then(() => this.loadStatus()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  onShareAppMessage() {
    return {
      title: '邀请你共创这瓶酒的记录',
      path: `/pages/co-create/co-create?key=${encodeURIComponent(this.data.key)}`
    };
  },

  loadStatus() {
    request({
      url: `/api/miniapp/qr/${encodeURIComponent(this.data.key)}`
    }).then((data) => {
      if (data.activation_status === 'activated') {
        wx.redirectTo({ url: `/pages/result/result?key=${encodeURIComponent(this.data.key)}` });
        return;
      }
      this.setData({
        qr: {
          ...data,
          image_url: resolveAssetUrl(data.image_url),
          display_content: data.content || '（未填写留言）'
        },
        canComment: !data.is_co_creation_owner && !data.has_my_co_creation_comment,
        message: ''
      });
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone(`/pages/co-create/co-create?key=${encodeURIComponent(this.data.key)}`);
        return;
      }
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  onAuthorInput(event) {
    this.setData({ authorName: event.detail.value });
  },

  onCommentInput(event) {
    this.setData({ commentContent: event.detail.value });
  },

  submitComment() {
    if (!isPhoneBound()) {
      redirectToBindPhone(`/pages/co-create/co-create?key=${encodeURIComponent(this.data.key)}`);
      return;
    }
    request({
      url: `/api/miniapp/qr/${encodeURIComponent(this.data.key)}/comments`,
      method: 'POST',
      data: {
        author_name: this.data.authorName,
        content: this.data.commentContent
      }
    }).then(() => {
      this.setData({ authorName: '', commentContent: '', message: '留言已保存。' });
      this.loadStatus();
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone(`/pages/co-create/co-create?key=${encodeURIComponent(this.data.key)}`);
        return;
      }
      this.setData({ message: error.message || '留言失败，请稍后重试' });
    });
  },

  deleteComment(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: '删除留言',
      content: '确认删除这条共创留言吗？',
      success: (res) => {
        if (!res.confirm) return;
        request({
          url: `/api/miniapp/qr/${encodeURIComponent(this.data.key)}/comments/${encodeURIComponent(id)}`,
          method: 'DELETE'
        }).then((data) => {
          this.setData({
            qr: {
              ...data,
              image_url: resolveAssetUrl(data.image_url),
              display_content: data.content || '（未填写留言）'
            },
            canComment: !data.is_co_creation_owner && !data.has_my_co_creation_comment,
            message: '留言已删除。'
          });
        }).catch((error) => {
          this.setData({ message: error.message || '删除失败，请稍后重试' });
        });
      }
    });
  },

  finalize() {
    wx.showModal({
      title: '确认封存共创记录',
      content: '封存后，这张照片、这句话和保留的共创留言，将保存到这瓶酒的记录里。以后扫码只能查看，不能修改。',
      confirmText: '确认封存',
      cancelText: '再检查一下',
      success: (res) => {
        if (!res.confirm) return;
        request({
          url: `/api/miniapp/qr/${encodeURIComponent(this.data.key)}/finalize`,
          method: 'POST'
        }).then(() => {
          wx.redirectTo({ url: `/pages/result/result?key=${encodeURIComponent(this.data.key)}&just_saved=1` });
        }).catch((error) => {
          this.setData({ message: error.message || '封存失败，请稍后重试' });
        });
      }
    });
  }
});
