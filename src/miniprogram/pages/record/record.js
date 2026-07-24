const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, uploadImage, resolveAssetUrl, isPhoneBound, getToken } = require('../../utils/request');
const { extractQrKey } = require('../../utils/qr');

const PREVIEW_WIDTH_RPX = 638;
const MIN_PREVIEW_HEIGHT_RPX = 320;
const MAX_PREVIEW_HEIGHT_RPX = 680;
const DEFAULT_PREVIEW_HEIGHT_RPX = 420;
const RECORD_DRAFT_VERSION = 1;
const RECORD_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const DRAFT_SOURCES = new Set(['upload', 'replace-photo', 'submit']);

const MISSING_QR_TITLE = '请通过星贴二维码进入';
const MISSING_QR_MESSAGE = '扫描星贴上的二维码，才能查看或留下这瓶酒的记录。';
const INVALID_QR_TITLE = '没有找到这张星贴';
const INVALID_QR_MESSAGE = '请重新扫描星贴上的二维码。';
const LOAD_FAILED_TITLE = '加载失败';
const LOAD_FAILED_MESSAGE = '加载失败，请稍后重试。';

function clampPreviewHeight(height) {
  return Math.max(MIN_PREVIEW_HEIGHT_RPX, Math.min(MAX_PREVIEW_HEIGHT_RPX, height));
}

function calculatePreviewHeight(width, height) {
  const numericWidth = Number(width);
  const numericHeight = Number(height);
  if (!numericWidth || !numericHeight) {
    return DEFAULT_PREVIEW_HEIGHT_RPX;
  }
  return clampPreviewHeight(Math.round((PREVIEW_WIDTH_RPX * numericHeight) / numericWidth));
}

function getImagePreviewHeight(file) {
  if (file && file.width && file.height) {
    return Promise.resolve(calculatePreviewHeight(file.width, file.height));
  }
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: file.tempFilePath,
      success: (info) => resolve(calculatePreviewHeight(info.width, info.height)),
      fail: () => resolve(DEFAULT_PREVIEW_HEIGHT_RPX)
    });
  });
}

function maskPhone(phone) {
  const value = String(phone || '').trim();
  if (!/^1\d{10}$/.test(value)) return value;
  return `${value.slice(0, 3)}****${value.slice(7)}`;
}

function getPhoneFromToken() {
  const token = getToken();
  const payload = token && token.split('.')[1];
  if (!payload || !wx.base64ToArrayBuffer) return '';
  try {
    let base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const bytes = new Uint8Array(wx.base64ToArrayBuffer(base64));
    let json = '';
    for (let index = 0; index < bytes.length; index += 1) {
      json += String.fromCharCode(bytes[index]);
    }
    const data = JSON.parse(json);
    return data && data.phone ? String(data.phone) : '';
  } catch (error) {
    return '';
  }
}

function formatCurrentPhone(data = {}) {
  const phone = maskPhone(data.phone || getPhoneFromToken());
  if (phone) return phone;
  return data.phone_bound || isPhoneBound() ? '已绑定手机号' : '';
}

function normalizeSaveMode(mode) {
  return mode === 'co_create' ? 'co_create' : 'direct';
}

function getValidDraftSource(source) {
  return DRAFT_SOURCES.has(source) ? source : '';
}

function getDraftKey(key) {
  return key ? `record_draft:${key}` : '';
}

function getPendingKey(key) {
  return key ? `record_draft:${key}:verify_pending` : '';
}

function readStorageJson(key) {
  if (!key) return null;
  try {
    const raw = wx.getStorageSync(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    wx.removeStorageSync(key);
    return null;
  }
}

function writeStorageJson(key, value) {
  if (!key) return;
  try {
    wx.setStorageSync(key, JSON.stringify(value));
  } catch (error) {
    // Session draft is best-effort; form input remains on the current page.
  }
}

Page({
  data: {
    key: '',
    displayKey: '',
    qr: null,
    imageUrl: '',
    imageObjectKey: '',
    previewUrl: '',
    previewHeight: DEFAULT_PREVIEW_HEIGHT_RPX,
    imageButtonText: '添加照片',
    hasPhoto: false,
    content: '',
    contentCount: 0,
    saveMode: 'direct',
    isDirectMode: true,
    isCoCreateMode: false,
    showBrandSection: false,
    showBrandDisclosure: false,
    brandPreviewText: '',
    recordAvailable: false,
    pageState: 'loading',
    stateTitle: '',
    stateMessage: '',
    stateCanRetry: false,
    currentPhoneText: '',
    phoneBound: false,
    draftNotice: '',
    showPreview: false,
    submitting: false,
    message: '加载中...'
  },

  onLoad(options) {
    const key = extractQrKey(options);
    this.setData({ key });
    if (!key) {
      this.showState('missing', MISSING_QR_TITLE, MISSING_QR_MESSAGE, false);
      return;
    }
    login().then((data) => {
      const phoneBound = data.phone_bound === true || isPhoneBound();
      this.setData({
        phoneBound,
        currentPhoneText: phoneBound ? formatCurrentPhone(data) : ''
      });
      return this.loadStatus();
    }).catch((error) => {
      this.showState('error', LOAD_FAILED_TITLE, error.message || LOAD_FAILED_MESSAGE, true);
    });
  },

  showState(pageState, stateTitle, stateMessage, stateCanRetry) {
    this.setData({
      pageState,
      stateTitle,
      stateMessage,
      stateCanRetry: stateCanRetry === true,
      recordAvailable: false,
      message: ''
    });
  },

  loadStatus() {
    if (!this.data.key) {
      this.showState('missing', MISSING_QR_TITLE, MISSING_QR_MESSAGE, false);
      return;
    }
    this.setData({
      pageState: 'loading',
      stateTitle: '',
      stateMessage: '',
      stateCanRetry: false,
      message: '加载中...'
    });
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
      const batchBrandDisclosureText = String(data.batch_brand_disclosure_text || '').trim();
      const batchBrandName = String(data.batch_brand_name || '').trim();
      const brandPreviewText = [batchBrandName, batchBrandDisclosureText].filter(Boolean).join(' · ');
      const phoneBound = data.phone_bound === true || isPhoneBound();
      this.setData({
        qr: data,
        displayKey: data.id || this.data.key,
        phoneBound,
        currentPhoneText: phoneBound ? formatCurrentPhone(data) : '',
        showBrandSection: !!batchBrandDisclosureText,
        showBrandDisclosure: !!(batchBrandDisclosureText && data.batch_brand_disclosure_default),
        brandPreviewText,
        recordAvailable: true,
        pageState: 'ready',
        message: ''
      });
      const restoredDraft = this.restoreRecordDraft();
      this.showDraftRestoreNotice(restoredDraft);
    }).catch((error) => {
      if (error.code === 'QR_NOT_FOUND' || error.code === 'QR_HIDDEN') {
        this.showState('invalid', INVALID_QR_TITLE, INVALID_QR_MESSAGE, false);
        return;
      }
      this.showState('error', LOAD_FAILED_TITLE, error.message || LOAD_FAILED_MESSAGE, true);
    });
  },

  reloadStatus() {
    this.loadStatus();
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  readRecordDraft() {
    const key = getDraftKey(this.data.key);
    const draft = readStorageJson(key);
    if (!draft) return null;
    if (draft.version !== RECORD_DRAFT_VERSION || !draft.expiresAt || Date.now() > draft.expiresAt) {
      wx.removeStorageSync(key);
      return null;
    }
    return draft;
  },

  saveRecordDraft(source = '') {
    const key = getDraftKey(this.data.key);
    if (!key) return;
    const savedAt = Date.now();
    writeStorageJson(key, {
      version: RECORD_DRAFT_VERSION,
      source: getValidDraftSource(source),
      savedAt,
      expiresAt: savedAt + RECORD_DRAFT_TTL_MS,
      content: this.data.content,
      mode: normalizeSaveMode(this.data.saveMode),
      showBrandDisclosure: this.data.showBrandDisclosure === true
    });
  },

  restoreRecordDraft() {
    const draft = this.readRecordDraft();
    if (!draft) return null;
    const content = String(draft.content || '').slice(0, 200);
    const saveMode = normalizeSaveMode(draft.mode);
    this.setData({
      content,
      contentCount: content.length,
      saveMode,
      isDirectMode: saveMode === 'direct',
      isCoCreateMode: saveMode === 'co_create',
      showBrandDisclosure: this.data.showBrandSection && draft.showBrandDisclosure === true
    });
    return draft;
  },

  markVerificationPending(source = '') {
    const pendingKey = getPendingKey(this.data.key);
    if (!pendingKey) return;
    writeStorageJson(pendingKey, {
      source: getValidDraftSource(source),
      savedAt: Date.now()
    });
  },

  readVerificationPending() {
    const pendingKey = getPendingKey(this.data.key);
    const pending = readStorageJson(pendingKey);
    if (pendingKey) wx.removeStorageSync(pendingKey);
    return pending || null;
  },

  clearRecordDraft() {
    const draftKey = getDraftKey(this.data.key);
    const pendingKey = getPendingKey(this.data.key);
    if (draftKey) wx.removeStorageSync(draftKey);
    if (pendingKey) wx.removeStorageSync(pendingKey);
  },

  showDraftRestoreNotice(restoredDraft) {
    const pending = this.readVerificationPending();
    if (!pending) return;
    const pendingSource = getValidDraftSource(pending.source);
    let title = '验证成功，请继续完成这条记录。';
    if (restoredDraft) {
      title = pendingSource === 'submit'
        ? '已恢复刚才填写的内容，请继续预览确认。'
        : '已恢复刚才填写的内容，请继续选择照片。';
    }
    this.setData({ draftNotice: title });
    wx.showToast({ title, icon: 'none', duration: 2600 });
    setTimeout(() => {
      if (this.data.draftNotice === title) {
        this.setData({ draftNotice: '' });
      }
    }, 3600);
  },

  recordRedirectUrl() {
    return `/pages/record/record?key=${encodeURIComponent(this.data.key)}`;
  },

  requirePhoneBeforeProtectedAction(source) {
    if (this.data.phoneBound || isPhoneBound()) return true;
    const safeSource = getValidDraftSource(source);
    this.saveRecordDraft(safeSource);
    this.markVerificationPending(safeSource);
    redirectToBindPhone(this.recordRedirectUrl(), safeSource);
    return false;
  },

  chooseImage() {
    if (!this.data.recordAvailable) {
      wx.showToast({ title: this.data.stateMessage || INVALID_QR_MESSAGE, icon: 'none' });
      this.setData({ message: this.data.stateMessage || INVALID_QR_MESSAGE });
      return;
    }
    const source = this.data.hasPhoto ? 'replace-photo' : 'upload';
    if (!this.requirePhoneBeforeProtectedAction(source)) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        const filePath = file && file.tempFilePath;
        if (!filePath) return;
        this.setData({ message: '图片上传中...' });
        Promise.all([
          uploadImage({ filePath, qrId: this.data.key }),
          getImagePreviewHeight(file)
        ]).then(([data, previewHeight]) => {
          this.setData({
            imageUrl: data.url || '',
            imageObjectKey: data.object_key || '',
            previewUrl: resolveAssetUrl(data.preview_url || data.url),
            previewHeight,
            imageButtonText: '更换照片',
            hasPhoto: true,
            message: ''
          });
        }).catch((error) => {
          if (error.code === 'PHONE_NOT_BOUND') {
            this.saveRecordDraft(source);
            this.markVerificationPending(source);
            redirectToBindPhone(this.recordRedirectUrl(), source);
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
    this.saveRecordDraft();
  },

  onModeChange(event) {
    const saveMode = normalizeSaveMode(event.detail.value);
    this.setData({
      saveMode,
      isDirectMode: saveMode === 'direct',
      isCoCreateMode: saveMode === 'co_create'
    });
    this.saveRecordDraft();
  },

  onBrandDisclosureChange(event) {
    const values = event.detail.value || [];
    this.setData({
      showBrandDisclosure: values.includes('show')
    });
    this.saveRecordDraft();
  },

  changePhone() {
    if (!this.data.key) return;
    this.saveRecordDraft();
    redirectToBindPhone(this.recordRedirectUrl());
  },

  submitRecord() {
    if (!this.data.recordAvailable) {
      this.setData({ message: this.data.stateMessage || INVALID_QR_MESSAGE });
      return;
    }
    if (!this.data.imageObjectKey && !this.data.imageUrl) {
      this.setData({ message: '请先添加一张照片。' });
      return;
    }
    if (!this.requirePhoneBeforeProtectedAction('submit')) return;
    this.setData({ showPreview: true, message: '' });
  },

  closePreview() {
    if (this.data.submitting) return;
    this.setData({ showPreview: false });
  },

  confirmPreview() {
    if (this.data.submitting) return;
    this.doSubmitRecord();
  },

  doSubmitRecord() {
    this.setData({
      submitting: true,
      message: this.data.saveMode === 'co_create' ? '正在开启共创...' : '正在保存...'
    });
    request({
      url: `/api/miniapp/qr/${encodeURIComponent(this.data.key)}/record`,
      method: 'POST',
      data: {
        content: this.data.content,
        mode: this.data.saveMode,
        image_url: this.data.imageUrl,
        image_object_key: this.data.imageObjectKey,
        show_brand_disclosure: this.data.showBrandSection && this.data.showBrandDisclosure
      }
    }).then((data) => {
      this.clearRecordDraft();
      if (data.activation_status === 'co_creating') {
        wx.redirectTo({ url: `/pages/co-create/co-create?key=${encodeURIComponent(this.data.key)}` });
        return;
      }
      wx.redirectTo({ url: `/pages/result/result?key=${encodeURIComponent(this.data.key)}&just_saved=1` });
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        this.setData({ submitting: false });
        this.saveRecordDraft('submit');
        this.markVerificationPending('submit');
        redirectToBindPhone(this.recordRedirectUrl(), 'submit');
        return;
      }
      this.setData({
        submitting: false,
        message: error.message || '提交失败，请稍后重试'
      });
    });
  }
});
