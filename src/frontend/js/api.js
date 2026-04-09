async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const json = await response.json();
  if (!response.ok || json.status !== 'success') {
    const error = new Error(json.message || '请求失败');
    error.code = json.code;
    throw error;
  }
  return json;
}
