const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, uploadImage, resolveAssetUrl, isPhoneBound } = require('../../utils/request');
const { extractQrKey } = require('../../utils/qr');

Page({
  data: {
    key: '',
    displayKey: '',
    qr: null,
    imageUrl: '',
    imageObjectKey: '',
    previewUrl: '',
    imageButtonText: '添加照片',
    content: '',
    contentCount: 0,
    saveMode: 'direct',
    isDirectMode: true,
    isCoCreateMode: false,
    message: '加载中...'
  },

  onLoad(options) {
    const key = extractQrKey(options);
    this.setData({ key });
    login().then(() => this.loadStatus()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  loadStatus() {
    if (!this.data.key) {
      this.setData({ message: '未找到星星编号，请重新扫码。' });
      return;
    }
    request({
      url: `/api/miniapp/qr/${encodeURIComponent(this.data.key)}`,
      auth: true
    }).then((data) => {
      if (data.activation_status === 'activated') {
        wx.redirectTo({ url: `/pages/result/result?key=${encodeURIComponent(this.data.key)}` });
        return;
      }
      if (data.activation_status === 'co_creating') {
        wx.redirectTo({ url: `/pages/co-create/co-create?key=${encodeURIComponent(this.data.key)}` });
        return;
      }
      this.setData({ qr: data, displayKey: data.id || this.data.key, message: '' });
    }).catch((error) => {
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
        if (!filePath) return;
        this.setData({ message: '图片上传中...' });
        uploadImage({ filePath, qrId: this.data.key }).then((data) => {
          this.setData({
            imageUrl: data.url || '',
            imageObjectKey: data.object_key || '',
            previewUrl: resolveAssetUrl(data.preview_url || data.url),
            imageButtonText: '更换照片',
            message: ''
          });
        }).catch((error) => {
          if (error.code === 'PHONE_NOT_BOUND') {
            redirectToBindPhone(`/pages/record/record?key=${encodeURIComponent(this.data.key)}`);
            return;
          }
          this.setData({ message: error.message || '上传失败，请重新选择图片' });
        });
      }
    });
  },

  onContentInput(event) {
    const content = event.detail.value || '';
    this.setData({
      content,
      contentCount: content.length
    });
  },

  onModeChange(event) {
    const saveMode = event.detail.value;
    this.setData({
      saveMode,
      isDirectMode: saveMode === 'direct',
      isCoCreateMode: saveMode === 'co_create'
    });
  },

  submitRecord() {
    if (!isPhoneBound()) {
      redirectToBindPhone(`/pages/record/record?key=${encodeURIComponent(this.data.key)}`);
      return;
    }
    if (!this.data.imageObjectKey && !this.data.imageUrl) {
      this.setData({ message: '请先添加一张照片。' });
      return;
    }

    wx.showModal({
      title: '确认保存这一刻',
      content: '提交后，这张照片和这句话将保存到这瓶酒的记录里，以后扫码可查看，不能修改',
      confirmText: '确认提交',
      cancelText: '返回修改',
      success: (res) => {
        if (!res.confirm) return;
        this.doSubmitRecord();
      }
    });
  },

  doSubmitRecord() {
    this.setData({ message: this.data.saveMode === 'co_create' ? '正在开启共创...' : '正在保存...' });
    request({
      url: `/api/miniapp/qr/${encodeURIComponent(this.data.key)}/record`,
      method: 'POST',
      data: {
        content: this.data.content,
        mode: this.data.saveMode,
        image_url: this.data.imageUrl,
        image_object_key: this.data.imageObjectKey
      }
    }).then((data) => {
      if (data.activation_status === 'co_creating') {
        wx.redirectTo({ url: `/pages/co-create/co-create?key=${encodeURIComponent(this.data.key)}` });
        return;
      }
      wx.redirectTo({ url: `/pages/result/result?key=${encodeURIComponent(this.data.key)}` });
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone(`/pages/record/record?key=${encodeURIComponent(this.data.key)}`);
        return;
      }
      this.setData({ message: error.message || '提交失败，请稍后重试' });
    });
  }
});
