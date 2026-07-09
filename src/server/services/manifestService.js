const { sha256Hex } = require('./hashService');

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObject(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

function activeComments(record) {
  return (Array.isArray(record.co_creation_comments) ? record.co_creation_comments : [])
    .filter((comment) => comment.status !== 'deleted')
    .map((comment) => ({
      id: comment.id,
      author_name: comment.author_name || '',
      content: comment.content || '',
      created_at: comment.created_at || ''
    }));
}

function buildRecordManifest(record) {
  return {
    version: 'record_manifest_v1',
    record: {
      star_id: record.id,
      activation_status: record.activation_status,
      sealed_at: record.activated_at || null,
      content: record.content || '',
      image: {
        object_key: record.image_object_key || null,
        url: record.image_url || null
      },
      co_creation: {
        enabled: record.co_creation_enabled === true,
        comments: activeComments(record)
      },
      brand: {
        show_brand_disclosure: record.show_brand_disclosure === true,
        disclosure_text: record.brand_disclosure_text_snapshot || '',
        batch_id: record.batch_id || null
      }
    },
    generated_at: new Date().toISOString()
  };
}

function hashManifest(manifest) {
  return sha256Hex(stableStringify(manifest));
}

module.exports = {
  stableStringify,
  buildRecordManifest,
  hashManifest
};
