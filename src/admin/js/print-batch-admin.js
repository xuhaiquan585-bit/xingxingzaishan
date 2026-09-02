(function printBatchAdminModule() {
  'use strict';

  const state = {
    loaded: false,
    batches: [],
    detail: null,
    selectedQrIds: new Set(),
    legacyQrCodes: [],
    selectedLegacyQrIds: new Set()
  };
  const STATUS = {
    reserved: '已预留', generating: '生成中', generation_failed: '生成失败',
    artifact_ready: '文件已生成', printing: '印刷中', completed: '已完成',
    canceled: '已取消', voided: '已作废'
  };

  function el(id) { return document.getElementById(id); }

  function message(text, error = false) {
    const target = el('printBatchMsg');
    target.textContent = text || '';
    target.classList.toggle('error', error);
  }

  async function api(path, options = {}) {
    const timeout = options.timeout || 30000;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`/api/admin${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${localStorage.getItem('adminToken') || ''}`,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
      const data = await response.json().catch(() => ({ status: 'error' }));
      if (!response.ok || data.status !== 'success') {
        const error = new Error(data.message || '请求失败。');
        error.code = data.code || 'REQUEST_FAILED';
        throw error;
      }
      return data.data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('操作超时，请检查任务状态后再重试。');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function parseQrIds() {
    return [...new Set(String(el('printBatchQrIds').value || '')
      .split(/[\s,，]+/).map((value) => value.trim().toUpperCase()).filter(Boolean))];
  }

  function updateQrCount() {
    el('printBatchQrCount').textContent = `${parseQrIds().length} 个`;
  }

  async function loadTemplates() {
    const data = await api('/label-templates');
    const published = data.templates.filter((template) => (
      template.status === 'published' && template.current_published_version_id
    ));
    el('printBatchTemplate').innerHTML = '<option value="">选择已发布模板</option>'
      + published.map((template) => `<option value="${template.current_published_version_id}">${escapeHtml(template.name)} · v${template.current_published_version_number}</option>`).join('');
  }

  async function loadBatches() {
    const params = new URLSearchParams();
    const status = el('printBatchStatusFilter').value;
    const search = el('printBatchSearch').value.trim();
    if (status) params.set('status', status);
    if (search) params.set('search', search);
    const data = await api(`/print-batches?${params.toString()}`);
    state.batches = data.batches;
    renderBatches();
  }

  async function loadLegacyQrCodes() {
    const params = new URLSearchParams();
    const sourceBatchId = el('legacyPrintQrBatchFilter').value.trim();
    const idPrefix = el('legacyPrintQrIdFilter').value.trim().toUpperCase();
    if (sourceBatchId) params.set('source_batch_id', sourceBatchId);
    if (idPrefix) params.set('id_prefix', idPrefix);
    const data = await api(`/print-production/legacy-qr-codes?${params.toString()}`);
    state.legacyQrCodes = data.qr_codes;
    state.selectedLegacyQrIds.clear();
    renderLegacyQrCodes();
  }

  function renderLegacyQrCodes() {
    el('legacyPrintQrTable').innerHTML = state.legacyQrCodes.length
      ? state.legacyQrCodes.map((qr) => `
        <tr>
          <td><input type="checkbox" data-legacy-print-qr-id="${qr.id}" ${state.selectedLegacyQrIds.has(qr.id) ? 'checked' : ''} /></td>
          <td>${escapeHtml(qr.id)}</td>
          <td>${escapeHtml(qr.original_batch_id || '-')}</td>
          <td>${escapeHtml(qr.issue_status || '-')}</td>
          <td>${escapeHtml(qr.lifecycle_status || '-')}</td>
          <td>${formatDateTime(qr.created_at)}</td>
        </tr>
      `).join('') : '<tr><td colspan="6" class="muted">没有待分类的历史二维码</td></tr>';
    const ids = state.legacyQrCodes.map((qr) => qr.id);
    el('selectAllLegacyPrintQr').checked = ids.length > 0
      && ids.every((id) => state.selectedLegacyQrIds.has(id));
    el('legacyPrintQrSelectionCount').textContent = `已选 ${state.selectedLegacyQrIds.size} 个`;
  }

  async function classifyLegacyQrCodes(targetStatus) {
    const qrIds = [...state.selectedLegacyQrIds];
    if (!qrIds.length) throw new Error('请先选择需要分类的历史二维码。');
    const reason = el('legacyPrintQrVoidReason').value.trim();
    if (targetStatus === 'voided' && !reason) throw new Error('永久报废必须填写原因。');
    const label = targetStatus === 'available' ? '可用于生产' : '永久报废';
    if (!window.confirm(`将 ${qrIds.length} 个历史二维码确认为“${label}”，确定继续吗？`)) return;
    await api('/print-production/legacy-qr-codes/classify', {
      method: 'POST',
      body: JSON.stringify({ qr_ids: qrIds, target_status: targetStatus, reason })
    });
    await loadLegacyQrCodes();
    message(`已将 ${qrIds.length} 个历史二维码确认为“${label}”。`);
  }

  function renderBatches() {
    el('printBatchTable').innerHTML = state.batches.length ? state.batches.map((batch) => `
      <tr>
        <td><strong>${escapeHtml(batch.name)}</strong><br /><small>${escapeHtml(batch.id)}</small></td>
        <td>${escapeHtml(batch.template_name || '-')} ${batch.template_version_number ? `v${batch.template_version_number}` : ''}</td>
        <td>${batch.qr_count}</td>
        <td>${STATUS[batch.status] || batch.status}</td>
        <td>${batch.download_count}</td>
        <td>${formatDateTime(batch.created_at)}</td>
        <td><button data-print-batch-open="${batch.id}">查看</button></td>
      </tr>
    `).join('') : '<tr><td colspan="7" class="muted">暂无印刷任务</td></tr>';
  }

  async function createBatch() {
    const ids = parseQrIds();
    const name = el('printBatchName').value.trim();
    const versionId = el('printBatchTemplate').value;
    if (!name || !versionId || ids.length === 0) {
      throw new Error('请填写任务名称、选择模板并输入二维码 ID。');
    }
    if (ids.length > 500) throw new Error('单次印刷任务最多 500 个二维码。');
    const data = await api('/print-batches', {
      method: 'POST',
      body: JSON.stringify({
        name,
        template_version_id: versionId,
        vendor_name: el('printBatchVendor').value.trim(),
        note: el('printBatchNote').value.trim(),
        qr_ids: ids,
        idempotency_key: crypto.randomUUID()
      })
    });
    el('printBatchQrIds').value = '';
    updateQrCount();
    await loadBatches();
    await openBatch(data.id);
    message('印刷任务已创建，二维码已临时预留。');
  }

  async function openBatch(batchId) {
    state.detail = await api(`/print-batches/${batchId}`);
    state.selectedQrIds.clear();
    renderDetail();
  }

  function renderDetail() {
    const detail = state.detail;
    if (!detail) return;
    const batch = detail.batch;
    el('printBatchDetail').classList.remove('hidden');
    el('printBatchDetailName').textContent = batch.name;
    el('printBatchDetailMeta').textContent = `${batch.id} · ${STATUS[batch.status] || batch.status} · ${batch.qr_count} 个二维码`;
    const sourceBatchFilter = el('printQrSourceBatchFilter').value.trim();
    const idPrefixFilter = el('printQrIdPrefixFilter').value.trim().toUpperCase();
    const visibleQrCodes = detail.qr_codes.filter((qr) => (
      (!sourceBatchFilter || qr.original_batch_id === sourceBatchFilter)
      && (!idPrefixFilter || qr.id.startsWith(idPrefixFilter))
    ));
    el('printBatchQrTable').innerHTML = visibleQrCodes.map((qr) => `
      <tr>
        <td><input type="checkbox" data-print-qr-id="${qr.id}" ${state.selectedQrIds.has(qr.id) ? 'checked' : ''} ${qr.print_status === 'voided' ? 'disabled' : ''} /></td>
        <td>${escapeHtml(qr.id)}</td>
        <td>${escapeHtml(qr.original_batch_id || '-')}</td>
        <td>${printQrStatus(qr.print_status)}</td>
        <td>${escapeHtml(qr.print_void_reason || '-')}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="muted">没有符合筛选条件的二维码</td></tr>';
    renderActions();
    updateSelectionState();
  }

  function printQrStatus(status) {
    return {
      legacy_unclassified: '历史未分类', available: '未纳入印刷', reserved: '已预留',
      artifact_generated: '文件已生成', printed: '已打印', voided: '已报废'
    }[status] || status;
  }

  function actionButton(action, label, style = '') {
    return `<button data-print-action="${action}" class="${style}">${label}</button>`;
  }

  function renderActions() {
    const status = state.detail.batch.status;
    const actions = [];
    if (['reserved', 'generation_failed'].includes(status)) {
      actions.push(actionButton('generate', status === 'generation_failed' ? '重新生成文件' : '生成正式文件'));
      actions.push(actionButton('cancel', '取消并释放', 'secondary'));
    }
    if (['artifact_ready', 'printing', 'completed'].includes(status)) {
      actions.push(actionButton('download', '下载同一文件'));
    }
    if (status === 'artifact_ready') {
      actions.push(actionButton('start', '开始印刷'));
      actions.push(actionButton('void', '整单作废', 'danger'));
    }
    if (status === 'printing') {
      actions.push(actionButton('complete', '登记完成'));
      actions.push(actionButton('void', '整单作废', 'danger'));
    }
    if (status === 'completed' && state.selectedQrIds.size > 0) {
      actions.push(actionButton('scrap', '报废所选 ID', 'danger'));
    }
    el('printBatchActions').innerHTML = actions.join('');
  }

  function updateSelectionState() {
    const sourceBatchFilter = el('printQrSourceBatchFilter').value.trim();
    const idPrefixFilter = el('printQrIdPrefixFilter').value.trim().toUpperCase();
    const ids = state.detail ? state.detail.qr_codes.filter((qr) => (
      qr.print_status !== 'voided'
      && (!sourceBatchFilter || qr.original_batch_id === sourceBatchFilter)
      && (!idPrefixFilter || qr.id.startsWith(idPrefixFilter))
    )).map((qr) => qr.id) : [];
    el('selectAllPrintQr').checked = ids.length > 0 && ids.every((id) => state.selectedQrIds.has(id));
    const status = state.detail ? state.detail.batch.status : '';
    el('printVoidReasonRow').classList.toggle('hidden',
      state.selectedQrIds.size === 0 && !['artifact_ready', 'printing'].includes(status));
  }

  async function mutate(action) {
    const batch = state.detail.batch;
    if (action === 'download') {
      await downloadArtifact(batch.id);
      await openBatch(batch.id);
      return;
    }
    if (action === 'generate' && !window.confirm('生成后二维码将永久绑定此任务，只能使用或作废。确定生成正式文件吗？')) return;
    if (action === 'cancel' && !window.confirm('确定取消并释放这些二维码吗？')) return;
    let endpoint = action;
    let body = {};
    let timeout = 30000;
    if (action === 'generate') timeout = 10 * 60 * 1000;
    if (action === 'start') endpoint = 'start-printing';
    if (action === 'complete') {
      const voidIds = [...state.selectedQrIds];
      const reason = el('printVoidReason').value.trim();
      if (voidIds.length && !reason) throw new Error('选择报废二维码后必须填写报废原因。');
      body = { void_qr_ids: voidIds, void_reason: reason };
    }
    if (action === 'void') {
      const reason = el('printVoidReason').value.trim();
      if (!reason) throw new Error('整单作废必须填写原因。');
      if (!window.confirm('正式文件生成后整单作废不可恢复，确定继续吗？')) return;
      body = { reason };
    }
    if (action === 'scrap') {
      const qrIds = [...state.selectedQrIds];
      const reason = el('printVoidReason').value.trim();
      if (!qrIds.length || !reason) throw new Error('请选择具体二维码并填写报废原因。');
      if (!window.confirm(`将所选 ${qrIds.length} 个已打印二维码永久报废，确定继续吗？`)) return;
      endpoint = 'qr-codes/void';
      body = { qr_ids: qrIds, reason };
    }
    await api(`/print-batches/${batch.id}/${endpoint}`, {
      method: 'POST', body: JSON.stringify(body), timeout
    });
    await loadBatches();
    await openBatch(batch.id);
    message(action === 'generate' ? '正式文件已生成并永久锁定。' : '任务状态已更新。');
  }

  async function downloadArtifact(batchId) {
    const response = await fetch(`/api/admin/print-batches/${batchId}/artifact`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('adminToken') || ''}` }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || '下载失败。');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${batchId}.zip`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function bind() {
    if (state.loaded) return;
    state.loaded = true;
    el('printBatchQrIds').addEventListener('input', updateQrCount);
    el('createPrintBatchBtn').addEventListener('click', () => run(createBatch));
    el('refreshPrintBatchesBtn').addEventListener('click', () => run(loadBatches));
    el('filterPrintBatchesBtn').addEventListener('click', () => run(loadBatches));
    el('filterPrintQrBtn').addEventListener('click', () => {
      state.selectedQrIds.clear();
      renderDetail();
    });
    el('refreshLegacyPrintQrBtn').addEventListener('click', () => run(loadLegacyQrCodes));
    el('filterLegacyPrintQrBtn').addEventListener('click', () => run(loadLegacyQrCodes));
    el('classifyLegacyAvailableBtn').addEventListener('click', () => run(() => classifyLegacyQrCodes('available')));
    el('classifyLegacyVoidedBtn').addEventListener('click', () => run(() => classifyLegacyQrCodes('voided')));
    el('printBatchTable').addEventListener('click', (event) => {
      const button = event.target.closest('[data-print-batch-open]');
      if (button) run(() => openBatch(button.dataset.printBatchOpen));
    });
    el('printBatchActions').addEventListener('click', (event) => {
      const button = event.target.closest('[data-print-action]');
      if (button) run(() => mutate(button.dataset.printAction));
    });
    el('printBatchQrTable').addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-print-qr-id]');
      if (!checkbox) return;
      if (checkbox.checked) state.selectedQrIds.add(checkbox.dataset.printQrId);
      else state.selectedQrIds.delete(checkbox.dataset.printQrId);
      updateSelectionState();
      renderActions();
    });
    el('selectAllPrintQr').addEventListener('change', (event) => {
      state.selectedQrIds.clear();
      if (event.target.checked) {
        const sourceBatchFilter = el('printQrSourceBatchFilter').value.trim();
        const idPrefixFilter = el('printQrIdPrefixFilter').value.trim().toUpperCase();
        state.detail.qr_codes.filter((qr) => (
          qr.print_status !== 'voided'
          && (!sourceBatchFilter || qr.original_batch_id === sourceBatchFilter)
          && (!idPrefixFilter || qr.id.startsWith(idPrefixFilter))
        )).forEach((qr) => state.selectedQrIds.add(qr.id));
      }
      renderDetail();
    });
    el('legacyPrintQrTable').addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-legacy-print-qr-id]');
      if (!checkbox) return;
      if (checkbox.checked) state.selectedLegacyQrIds.add(checkbox.dataset.legacyPrintQrId);
      else state.selectedLegacyQrIds.delete(checkbox.dataset.legacyPrintQrId);
      renderLegacyQrCodes();
    });
    el('selectAllLegacyPrintQr').addEventListener('change', (event) => {
      state.selectedLegacyQrIds.clear();
      if (event.target.checked) {
        state.legacyQrCodes.forEach((qr) => state.selectedLegacyQrIds.add(qr.id));
      }
      renderLegacyQrCodes();
    });
  }

  async function run(callback) {
    try {
      message('');
      await callback();
    } catch (error) {
      message(error.message || '操作失败。', true);
    }
  }

  async function load() {
    bind();
    await run(async () => {
      await Promise.all([loadTemplates(), loadBatches(), loadLegacyQrCodes()]);
    });
  }

  function openWithQrIds(ids) {
    el('printBatchQrIds').value = [...new Set(ids)].join('\n');
    updateQrCount();
  }

  window.PrintBatchAdmin = Object.freeze({ load, openWithQrIds });
}());
