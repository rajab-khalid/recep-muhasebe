'use strict';

module.exports = (app) => {
  const { db, uuid, U } = app;

  function makes() {
    return db.all(`SELECT mk.*, (SELECT COUNT(*) FROM vehicle_models m WHERE m.make_id = mk.id) AS model_count
      FROM vehicle_makes mk ORDER BY mk.name COLLATE NOCASE`);
  }
  function models(makeId) {
    if (makeId) return db.all('SELECT * FROM vehicle_models WHERE make_id = ? ORDER BY name COLLATE NOCASE', [makeId]);
    return db.all(`SELECT m.*, mk.name AS make_name FROM vehicle_models m JOIN vehicle_makes mk ON mk.id = m.make_id ORDER BY mk.name, m.name`);
  }
  function ensureMake(name) {
    const n = U.str(name, 60);
    if (!n) return null;
    const r = db.get('SELECT id FROM vehicle_makes WHERE lower(name) = lower(?)', [n]);
    if (r) return r.id;
    const id = uuid();
    db.insert('vehicle_makes', { id, name: n });
    return id;
  }
  function ensureModel(makeId, name) {
    const n = U.str(name, 60);
    if (!n || !makeId) return null;
    const r = db.get('SELECT id FROM vehicle_models WHERE make_id = ? AND lower(name) = lower(?)', [makeId, n]);
    if (r) return r.id;
    const id = uuid();
    db.insert('vehicle_models', { id, make_id: makeId, name: n });
    return id;
  }
  function saveMake(d, ctx) {
    const name = U.str(d.name, 60);
    U.assert(name, 'name_required', 'Name is required');
    if (d.id) {
      const dup = db.get('SELECT id FROM vehicle_makes WHERE lower(name) = lower(?) AND id <> ?', [name, d.id]);
      U.assert(!dup, 'duplicate', 'Already exists');
      db.update('vehicle_makes', d.id, { name });
    } else d.id = ensureMake(name);
    app.audit(ctx, 'save', 'vehicle_make', d.id, name);
    return d.id;
  }
  function saveModel(d, ctx) {
    const name = U.str(d.name, 60);
    U.assert(name && d.make_id, 'name_required', 'Name is required');
    if (d.id) {
      const dup = db.get('SELECT id FROM vehicle_models WHERE make_id = ? AND lower(name) = lower(?) AND id <> ?', [d.make_id, name, d.id]);
      U.assert(!dup, 'duplicate', 'Already exists');
      db.update('vehicle_models', d.id, { name, make_id: d.make_id });
    } else d.id = ensureModel(d.make_id, name);
    app.audit(ctx, 'save', 'vehicle_model', d.id, name);
    return d.id;
  }
  function deleteModel(id, ctx) {
    const used = db.val('SELECT COUNT(*) FROM product_fitments WHERE model_id = ?', [id]) + db.val('SELECT COUNT(*) FROM vehicles WHERE model_id = ?', [id]);
    U.assert(!used, 'in_use', 'This model is used by products or vehicles');
    db.run('DELETE FROM vehicle_models WHERE id = ?', [id]);
    app.audit(ctx, 'delete', 'vehicle_model', id);
  }
  function deleteMake(id, ctx) {
    const used = db.val('SELECT COUNT(*) FROM product_fitments WHERE make_id = ?', [id]) + db.val('SELECT COUNT(*) FROM vehicles WHERE make_id = ?', [id]);
    U.assert(!used, 'in_use', 'This make is used by products or vehicles');
    db.tx(() => {
      db.run('DELETE FROM vehicle_models WHERE make_id = ?', [id]);
      db.run('DELETE FROM vehicle_makes WHERE id = ?', [id]);
    });
    app.audit(ctx, 'delete', 'vehicle_make', id);
  }

  function describe(v) {
    if (!v) return '';
    return [v.make_name || v.make_text, v.model_name || v.model_text, v.year, v.engine].filter(Boolean).join(' ');
  }

  const SELECT = `SELECT v.*, mk.name AS make_name, md.name AS model_name, p.name AS partner_name, p.phone AS partner_phone
    FROM vehicles v LEFT JOIN vehicle_makes mk ON mk.id = v.make_id LEFT JOIN vehicle_models md ON md.id = v.model_id
    LEFT JOIN partners p ON p.id = v.partner_id`;

  function list(f = {}) {
    const where = ['v.active = 1'];
    const params = [];
    if (f.partner_id) { where.push('v.partner_id = ?'); params.push(f.partner_id); }
    if (f.q) {
      const plate = U.normPlate(f.q);
      const terms = U.searchTerms(f.q);
      const ors = ['v.plate_norm LIKE ?'];
      params.push(`%${plate}%`);
      if (terms.length) {
        const ands = terms.map(() => `(lower(COALESCE(mk.name,'') || ' ' || COALESCE(md.name,'') || ' ' || COALESCE(v.make_text,'') || ' ' || COALESCE(v.model_text,'') || ' ' || COALESCE(p.name,'') || ' ' || COALESCE(v.vin,'')) LIKE ?)`);
        ors.push(`(${ands.join(' AND ')})`);
        params.push(...terms.map((t) => `%${t}%`));
      }
      where.push(`(${ors.join(' OR ')})`);
    }
    const rows = db.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY v.updated_at DESC LIMIT ?`, [...params, Math.min(Number(f.limit) || 200, 2000)]);
    for (const r of rows) {
      r.description = describe(r);
      const last = db.get(`SELECT date FROM docs WHERE vehicle_id = ? AND status <> 'cancelled' ORDER BY date DESC LIMIT 1`, [r.id]);
      r.last_visit = last ? last.date : null;
    }
    return rows;
  }

  function get(id) {
    const v = db.get(`${SELECT} WHERE v.id = ?`, [id]);
    U.assert(v, 'not_found', 'Vehicle not found', 404);
    v.description = describe(v);
    v.history = history(id);
    return v;
  }

  /** all documents (sales, service orders, quotes, returns) for a vehicle, with their lines */
  function history(vehicleId) {
    const v = db.get('SELECT id, plate_norm FROM vehicles WHERE id = ?', [vehicleId]);
    if (!v) return [];
    const docs = db.all(`SELECT d.id, d.type, d.no, d.date, d.status, d.currency, d.total, d.km, d.complaint, d.work_done,
        COALESCE(p.name, d.partner_name) AS partner_name, u.full_name AS staff_name, t.full_name AS technician_name
      FROM docs d LEFT JOIN partners p ON p.id = d.partner_id LEFT JOIN users u ON u.id = d.staff_id LEFT JOIN users t ON t.id = d.technician_id
      WHERE d.vehicle_id = ? AND d.type IN ('sale', 'service', 'quote', 'sale_return')
      ORDER BY d.date DESC, d.created_at DESC`, [vehicleId]);
    const today = U.today();
    for (const d of docs) {
      d.lines = db.all(`SELECT l.kind, l.description, l.qty, l.unit_price, l.line_total, l.warranty_until, pr.code
        FROM doc_lines l LEFT JOIN products pr ON pr.id = l.product_id WHERE l.doc_id = ? ORDER BY l.line_no`, [d.id]);
      for (const l of d.lines) l.warranty_active = l.warranty_until ? l.warranty_until >= today : null;
    }
    return docs;
  }

  function findByPlate(plate) {
    const n = U.normPlate(plate);
    if (!n) return null;
    return db.get(`${SELECT} WHERE v.plate_norm = ? AND v.active = 1 ORDER BY v.updated_at DESC LIMIT 1`, [n]) || null;
  }

  function save(d, ctx) {
    return db.tx(() => {
      const now = U.nowIso();
      let makeId = d.make_id || null;
      let modelId = d.model_id || null;
      if (!makeId && d.make_text) makeId = ensureMake(d.make_text);
      if (!modelId && d.model_text && makeId) modelId = ensureModel(makeId, d.model_text);
      if (modelId && !makeId) makeId = db.val('SELECT make_id FROM vehicle_models WHERE id = ?', [modelId]);
      const plate = U.str(d.plate, 30);
      const fields = {
        partner_id: d.partner_id || null, plate, plate_norm: plate ? U.normPlate(plate) : null,
        make_id: makeId, model_id: modelId,
        make_text: makeId ? null : U.str(d.make_text, 60), model_text: modelId ? null : U.str(d.model_text, 60),
        year: d.year ? Math.round(U.num(d.year)) : null, engine: U.str(d.engine, 60), color: U.str(d.color, 40),
        vin: U.str(d.vin, 40), km: d.km ? Math.round(U.num(d.km)) : null, notes: U.str(d.notes, 2000),
        active: d.active === false ? 0 : 1, updated_at: now,
      };
      U.assert(fields.plate || fields.make_id || fields.make_text || fields.model_text, 'vehicle_required', 'Enter a plate or make/model');
      if (d.id) {
        U.assert(db.get('SELECT 1 FROM vehicles WHERE id = ?', [d.id]), 'not_found', 'Vehicle not found', 404);
        db.update('vehicles', d.id, fields);
        app.audit(ctx, 'update', 'vehicle', d.id, plate);
        return d.id;
      }
      const id = uuid();
      db.insert('vehicles', { id, ...fields, created_at: now });
      app.audit(ctx, 'create', 'vehicle', id, plate);
      return id;
    });
  }

  /** used by document saving: resolve vehicle by id or plate, create it if new */
  function resolveForDoc({ vehicle_id, vehicle_plate, vehicle_desc, partner_id, km, vehicle }, ctx) {
    if (vehicle_id) {
      const v = db.get('SELECT * FROM vehicles WHERE id = ?', [vehicle_id]);
      if (v) {
        const patch = {};
        if (km && (!v.km || Number(km) > v.km)) patch.km = Math.round(U.num(km));
        if (partner_id && !v.partner_id) patch.partner_id = partner_id;
        if (Object.keys(patch).length) db.update('vehicles', v.id, { ...patch, updated_at: U.nowIso() });
        return v.id;
      }
    }
    const plate = U.str(vehicle_plate, 30);
    if (!plate && !(vehicle && (vehicle.make_id || vehicle.model_id || vehicle.make_text))) return null;
    if (plate) {
      const ex = findByPlate(plate);
      if (ex) {
        const patch = { updated_at: U.nowIso() };
        if (km && (!ex.km || Number(km) > ex.km)) patch.km = Math.round(U.num(km));
        if (partner_id && !ex.partner_id) patch.partner_id = partner_id;
        db.update('vehicles', ex.id, patch);
        return ex.id;
      }
    }
    return save({ ...(vehicle || {}), plate, partner_id, km, model_text: (vehicle && vehicle.model_text) || (vehicle_desc && !vehicle ? vehicle_desc : undefined) }, ctx);
  }

  return { makes, models, ensureMake, ensureModel, saveMake, saveModel, deleteMake, deleteModel, list, get, history, findByPlate, save, resolveForDoc, describe };
};
