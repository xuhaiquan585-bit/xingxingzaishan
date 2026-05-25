const { API_BASE_URL } = require('./config');

function absoluteUrl(url) {
  if (/^https?:\/\//.test(url)) return url;
  return `${API_BASE_URL}${url}`;
}

function resolveAssetUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//.test(url)) return url;
  return `${API_BASE_URL}${url}`;
}

function getToken() {
  return wx.getStorageSync('miniapp_token') || '';
}

function setToken(token) {
  wx.setStorageSync('miniapp_token', token || '');
}

function setPhoneBound(value) {
  wx.setStorageSync('phone_bound', value === true);
}

function clearAuthState() {
  wx.removeStorageSync('miniapp_token');
  wx.removeStorageSync('phone_bound');
}

function isPhoneBound() {
  return wx.getStorageSync('phone_bound') === true;
}

function request(options) {
  const { url, method = 'GET', data = {}, auth = true } = options;
  const token = getToken();
  const header = {
    'Content-Type': 'application/json',
    ...(options.header || {})
  };
  if (auth && token) {
    header.Authorization = `Bearer ${token}`;
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: absoluteUrl(url),
      method,
      data,
      header,
      success(res) {
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300 && body.status === 'success') {
          resolve(body.data);
          return;
        }
        const error = new Error(body.message || '请求失败，请稍后重试');
        error.code = body.code || 'REQUEST_FAILED';
        if (error.code === 'UNAUTHORIZED') {
          clearAuthState();
        }
        reject(error);
      },
      fail() {
        const error = new Error('网络连接失败，请检查网络后重试');
        error.code = 'NETWORK_ERROR';
        reject(error);
      }
    });
  });
}

function uploadImage({ filePath, qrId }) {
  const token = getToken();
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: absoluteUrl('/api/miniapp/upload'),
      filePath,
      name: 'image',
      formData: {
        qr_id: qrId || 'unbound'
      },
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(res) {
        let body = null;
        try {
          body = JSON.parse(res.data || '{}');
        } catch (error) {
          reject(error);
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && body.status === 'success') {
          resolve(body.data);
          return;
        }
        const error = new Error(body.message || '上传失败，请重新选择图片');
        error.code = body.code || 'UPLOAD_FAILED';
        if (error.code === 'UNAUTHORIZED') {
          clearAuthState();
        }
        reject(error);
      },
      fail() {
        const error = new Error('上传失败，请检查网络后重试');
        error.code = 'NETWORK_ERROR';
        reject(error);
      }
    });
  });
}

module.exports = {
  API_BASE_URL,
  request,
  uploadImage,
  resolveAssetUrl,
  getToken,
  setToken,
  isPhoneBound,
  setPhoneBound,
  clearAuthState
};
