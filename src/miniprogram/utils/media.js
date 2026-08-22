const IMAGE_SELECTION_CANCEL_PATTERN = /cancel/i;
const IMAGE_SELECTION_PRIVACY_PATTERN = /privacy|scope is not declared|permission|auth deny|authorize/i;

function requirePrivacyAuthorization(wxApi = wx) {
  if (!wxApi || typeof wxApi.requirePrivacyAuthorize !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    wxApi.requirePrivacyAuthorize({
      success: resolve,
      fail: reject
    });
  });
}

function chooseSingleImage(wxApi = wx) {
  return requirePrivacyAuthorization(wxApi).then(() => new Promise((resolve, reject) => {
    if (!wxApi || typeof wxApi.chooseMedia !== 'function') {
      reject(new Error('chooseMedia is unavailable'));
      return;
    }
    wxApi.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success(result) {
        const file = result && result.tempFiles && result.tempFiles[0];
        if (!file || !file.tempFilePath) {
          reject(new Error('No image was selected'));
          return;
        }
        resolve(file);
      },
      fail: reject
    });
  }));
}

function imageSelectionErrorText(error) {
  return String(error && (error.errMsg || error.message) || '');
}

function isImageSelectionCancelled(error) {
  return IMAGE_SELECTION_CANCEL_PATTERN.test(imageSelectionErrorText(error));
}

function imageSelectionErrorMessage(error) {
  const detail = imageSelectionErrorText(error);
  if (IMAGE_SELECTION_PRIVACY_PATTERN.test(detail)) {
    return '需要同意隐私保护指引并允许使用相册或相机，才能添加照片。';
  }
  return '暂时无法打开相册或相机，请检查微信和系统权限后重试。';
}

module.exports = {
  chooseSingleImage,
  imageSelectionErrorMessage,
  isImageSelectionCancelled,
  requirePrivacyAuthorization
};
