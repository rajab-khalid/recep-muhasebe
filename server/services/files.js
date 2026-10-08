'use strict';
/* Binary files (logo, product photos) stored inside the database so a single backup file has everything. */
module.exports = (app) => {
  const { db, uuid, U } = app;

  function saveBuffer(buf, { name, mime } = {}) {
    U.assert(buf && buf.length, 'empty_file', 'File is empty');
    U.assert(buf.length <= 12 * 1024 * 1024, 'file_too_large', 'File is larger than 12 MB');
    const id = uuid();
    db.insert('files', { id, name: name || null, mime: mime || 'application/octet-stream', size: buf.length, data: buf, created_at: U.nowIso() });
    return id;
  }

  function saveDataUrl(dataUrl, name) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
    U.assert(m, 'bad_data_url', 'Invalid image data');
    const mime = m[1] || 'application/octet-stream';
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    U.assert(/^image\//.test(mime), 'not_image', 'Only images are allowed');
    return saveBuffer(buf, { name, mime });
  }

  function get(id) {
    if (!id) return null;
    return db.get('SELECT id, name, mime, size, data FROM files WHERE id = ?', [id]) || null;
  }

  function toDataUrl(id) {
    const f = get(id);
    if (!f) return null;
    return `data:${f.mime};base64,${Buffer.from(f.data).toString('base64')}`;
  }

  function remove(id) {
    if (id) db.run('DELETE FROM files WHERE id = ?', [id]);
  }

  return { saveBuffer, saveDataUrl, get, toDataUrl, remove };
};
