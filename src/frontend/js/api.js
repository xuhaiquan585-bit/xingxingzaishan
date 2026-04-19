/**
 * api.js — 统一网络请求封装，含友好错误提示
 */

/* 错误码 → 中文提示映射（后端未返回友好 message 时使用） */
const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请检查网络后重试',
  SERVER_ERROR: '服务器暂时繁忙，请稍后再试',
  UPLOAD_FAILED: '上传失败，请换张图片试试',
  OSS_UPLOAD_FAILED: '云存储暂时不可用，请稍后重试',
  OSS_CONFIG_ERROR: '上传服务暂时不可用，请联系客服',
  OSS_DEP_MISSING: '上传服务暂时不可用，请联系客服',
  QR_NOT_FOUND: '未找到这颗星，请确认二维码是否正确',
  QR_HIDDEN: '这颗星暂不可见',
  QR_ALREADY_ACTIVATED: '该星已被点亮，无法重复绑定',
  INVALID_PHONE: '手机号格式不正确，请检查后重试',
  VALIDATION_ERROR: '请先上传一张照片再点亮',
  UPLOAD_SIZE_EXCEEDED: '图片过大，请选择 5MB 以内的图片'
};

async function apiRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (_networkError) {
    // fetch 本身抛异常：网络断开、DNS 失败、超时等
    const error = new Error(ERROR_MESSAGES.NETWORK_ERROR);
    error.code = 'NETWORK_ERROR';
    throw error;
  }

  let json;
  try {
    json = await response.json();
  } catch (_parseError) {
    // 响应不是 JSON（如 Nginx 502 HTML 页面）
    const error = new Error(ERROR_MESSAGES.SERVER_ERROR);
    error.code = 'SERVER_ERROR';
    throw error;
  }

  if (!response.ok || json.status !== 'success') {
    // 优先用映射表，其次用后端 message，最后兜底
    const code = json.code || '';
    const message = ERROR_MESSAGES[code] || json.message || '请求失败，请稍后重试';
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  return json;
}
