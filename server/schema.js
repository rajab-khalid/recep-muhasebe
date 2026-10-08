'use strict';
/*
 * Database schema (SQLite). Written to stay portable to PostgreSQL later:
 *  - TEXT UUID primary keys, no AUTOINCREMENT
 *  - ISO dates as TEXT (YYYY-MM-DD) and timestamps as TEXT (ISO 8601)
 *  - money as REAL rounded by the application to the currency's decimals
 *
 * Conventions
 *  - Nothing financial is ever DELETEd. Documents are cancelled; their ledger rows are
 *    marked voided = 1 (kept for history). Balances always sum WHERE voided = 0.
 *  - rate     = units of the row currency per 1 USD at the time of the row (USD = 1, IQD = e.g. 1520)
 *  - usd_iqd  = IQD per 1 USD at the time of the row (to show historical IQD equivalents)
 *  - amount_usd = amount / rate (the base-currency equivalent, stored)
 *  - partner_moves.amount: + = the partner owes us (debit), - = we owe the partner (credit)
 *  - money_moves.amount:   + = money in, - = money out (in the money account's currency)
 *  - stock_moves.qty:      + = in, - = out
 */

const MIGRATIONS = [
  // ---------------------------------------------------------------- v1
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE files (
    id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, data BLOB, created_at TEXT
  );

  CREATE TABLE currencies (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT, decimals INTEGER NOT NULL DEFAULT 2,
    rate REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, updated_at TEXT
  );
  CREATE TABLE rate_history (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, currency TEXT NOT NULL, rate REAL NOT NULL, source TEXT, user_id TEXT
  );
  CREATE INDEX rate_history_ts ON rate_history(currency, ts);

  CREATE TABLE sequences (
    key TEXT PRIMARY KEY, last_no INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE roles (
    id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]',
    builtin INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE, full_name TEXT NOT NULL, role_id TEXT REFERENCES roles(id),
    password_hash TEXT, pin_hash TEXT, phone TEXT,
    can_login INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
    max_discount_pct REAL, commission_sales_pct REAL NOT NULL DEFAULT 0, commission_labor_pct REAL NOT NULL DEFAULT 0,
    default_warehouse_id TEXT, lang TEXT, notes TEXT,
    created_at TEXT, updated_at TEXT, last_login_at TEXT
  );
  CREATE TABLE sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    last_seen TEXT, expires_at TEXT, ip TEXT, agent TEXT, remember INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, user_id TEXT, user_name TEXT, action TEXT NOT NULL,
    entity TEXT, entity_id TEXT, summary TEXT, data TEXT, ip TEXT
  );
  CREATE INDEX audit_ts ON audit_log(ts);
  CREATE INDEX audit_entity ON audit_log(entity, entity_id);

  -- ---------------------------------------------------------- master data
  CREATE TABLE warehouses (
    id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, address TEXT,
    is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
    legacy_id TEXT, created_at TEXT
  );
  CREATE TABLE categories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE brands (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX brands_name ON brands(name);
  CREATE TABLE price_lists (
    id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE products (
    id TEXT PRIMARY KEY, no INTEGER, code TEXT, barcode TEXT, name TEXT NOT NULL, name2 TEXT,
    type TEXT NOT NULL DEFAULT 'product',
    category_id TEXT REFERENCES categories(id), brand_id TEXT REFERENCES brands(id), unit TEXT,
    currency TEXT NOT NULL DEFAULT 'IQD',
    cost_price REAL NOT NULL DEFAULT 0,
    avg_cost_usd REAL NOT NULL DEFAULT 0,
    min_stock REAL NOT NULL DEFAULT 0, max_stock REAL,
    shelf TEXT, color TEXT, size TEXT, oem_no TEXT, warranty_months INTEGER NOT NULL DEFAULT 0,
    photo_id TEXT, notes TEXT, track_stock INTEGER NOT NULL DEFAULT 1,
    last_supplier_id TEXT, last_purchase_date TEXT, last_sale_date TEXT,
    active INTEGER NOT NULL DEFAULT 1, search TEXT,
    legacy_id TEXT, created_at TEXT, updated_at TEXT
  );
  CREATE INDEX products_barcode ON products(barcode);
  CREATE INDEX products_code ON products(code);
  CREATE INDEX products_active ON products(active, name);
  CREATE TABLE product_prices (
    product_id TEXT NOT NULL REFERENCES products(id), price_list_id TEXT NOT NULL REFERENCES price_lists(id),
    price REAL NOT NULL, PRIMARY KEY (product_id, price_list_id)
  );
  CREATE TABLE product_codes (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), code TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'alt', note TEXT
  );
  CREATE INDEX product_codes_code ON product_codes(code);
  CREATE INDEX product_codes_product ON product_codes(product_id);

  CREATE TABLE vehicle_makes (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE UNIQUE INDEX vehicle_makes_name ON vehicle_makes(name);
  CREATE TABLE vehicle_models (
    id TEXT PRIMARY KEY, make_id TEXT NOT NULL REFERENCES vehicle_makes(id), name TEXT NOT NULL
  );
  CREATE UNIQUE INDEX vehicle_models_name ON vehicle_models(make_id, name);
  CREATE TABLE product_fitments (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
    make_id TEXT REFERENCES vehicle_makes(id), model_id TEXT REFERENCES vehicle_models(id),
    year_from INTEGER, year_to INTEGER, engine TEXT, note TEXT
  );
  CREATE INDEX product_fitments_product ON product_fitments(product_id);
  CREATE INDEX product_fitments_model ON product_fitments(model_id);

  CREATE TABLE partners (
    id TEXT PRIMARY KEY, no INTEGER, kind TEXT NOT NULL DEFAULT 'customer',
    name TEXT NOT NULL, company TEXT, phone TEXT, phone2 TEXT, email TEXT, address TEXT, city TEXT, tax_no TEXT,
    price_list_id TEXT REFERENCES price_lists(id), credit_limit REAL, credit_currency TEXT,
    payment_days INTEGER, due_date TEXT, notes TEXT,
    is_walkin INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, search TEXT,
    legacy_id TEXT, created_at TEXT, updated_at TEXT
  );
  CREATE INDEX partners_kind ON partners(kind, active);

  CREATE TABLE vehicles (
    id TEXT PRIMARY KEY, partner_id TEXT REFERENCES partners(id), plate TEXT, plate_norm TEXT,
    make_id TEXT REFERENCES vehicle_makes(id), model_id TEXT REFERENCES vehicle_models(id),
    make_text TEXT, model_text TEXT, year INTEGER, engine TEXT, color TEXT, vin TEXT, km INTEGER,
    notes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT
  );
  CREATE INDEX vehicles_plate ON vehicles(plate_norm);
  CREATE INDEX vehicles_partner ON vehicles(partner_id);

  -- ---------------------------------------------------------- documents
  CREATE TABLE docs (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, no TEXT NOT NULL, date TEXT NOT NULL,
    due_date TEXT, valid_until TEXT, status TEXT NOT NULL,
    channel TEXT,
    partner_id TEXT REFERENCES partners(id), partner_name TEXT, partner_phone TEXT,
    warehouse_id TEXT REFERENCES warehouses(id), to_warehouse_id TEXT REFERENCES warehouses(id),
    currency TEXT NOT NULL, rate REAL NOT NULL DEFAULT 1, usd_iqd REAL NOT NULL DEFAULT 1,
    price_list_id TEXT,
    subtotal REAL NOT NULL DEFAULT 0, line_discount REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0,
    extra_cost REAL NOT NULL DEFAULT 0, extra_account_id TEXT, total REAL NOT NULL DEFAULT 0, total_usd REAL NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0, paid REAL NOT NULL DEFAULT 0, payment_status TEXT,
    payment_method TEXT,
    vehicle_id TEXT REFERENCES vehicles(id), vehicle_plate TEXT, vehicle_desc TEXT, km INTEGER,
    complaint TEXT, work_done TEXT,
    staff_id TEXT, technician_id TEXT, ref_doc_id TEXT,
    reason TEXT, notes TEXT, internal_note TEXT,
    rev INTEGER NOT NULL DEFAULT 1,
    created_by TEXT, created_at TEXT, updated_by TEXT, updated_at TEXT, posted_at TEXT,
    cancelled_by TEXT, cancelled_at TEXT, cancel_reason TEXT,
    legacy_id TEXT
  );
  CREATE UNIQUE INDEX docs_type_no ON docs(type, no);
  CREATE INDEX docs_type_date ON docs(type, date);
  CREATE INDEX docs_partner ON docs(partner_id, type);
  CREATE INDEX docs_vehicle ON docs(vehicle_id);
  CREATE INDEX docs_ref ON docs(ref_doc_id);

  CREATE TABLE doc_lines (
    id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id), line_no INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'product', product_id TEXT REFERENCES products(id),
    code TEXT, description TEXT, qty REAL NOT NULL DEFAULT 1, unit TEXT,
    unit_price REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, discount_pct REAL,
    line_total REAL NOT NULL DEFAULT 0, unit_cost_usd REAL, extra_usd REAL,
    staff_id TEXT, ref_line_id TEXT, received_qty REAL, warranty_until TEXT, note TEXT
  );
  CREATE INDEX doc_lines_doc ON doc_lines(doc_id, line_no);
  CREATE INDEX doc_lines_product ON doc_lines(product_id);
  CREATE INDEX doc_lines_ref ON doc_lines(ref_line_id);

  -- ---------------------------------------------------------- stock ledger
  CREATE TABLE stock_moves (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, date TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id), warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
    qty REAL NOT NULL, unit_cost_usd REAL NOT NULL DEFAULT 0, cost_fixed INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL,
    doc_id TEXT, line_id TEXT, rev INTEGER NOT NULL DEFAULT 1, voided INTEGER NOT NULL DEFAULT 0,
    note TEXT, user_id TEXT, created_at TEXT
  );
  CREATE INDEX stock_moves_product ON stock_moves(product_id, voided, date, seq);
  CREATE INDEX stock_moves_doc ON stock_moves(doc_id);
  CREATE TABLE stock_levels (
    product_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, qty REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, warehouse_id)
  );
  CREATE TRIGGER stock_moves_ins AFTER INSERT ON stock_moves WHEN NEW.voided = 0
  BEGIN
    INSERT INTO stock_levels (product_id, warehouse_id, qty) VALUES (NEW.product_id, NEW.warehouse_id, NEW.qty)
    ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty = qty + NEW.qty;
  END;
  CREATE TRIGGER stock_moves_void AFTER UPDATE OF voided ON stock_moves WHEN NEW.voided <> OLD.voided
  BEGIN
    INSERT INTO stock_levels (product_id, warehouse_id, qty)
      VALUES (NEW.product_id, NEW.warehouse_id, CASE WHEN NEW.voided = 1 THEN -NEW.qty ELSE NEW.qty END)
    ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty = qty + (CASE WHEN NEW.voided = 1 THEN -NEW.qty ELSE NEW.qty END);
  END;

  CREATE TABLE stock_counts (
    id TEXT PRIMARY KEY, no TEXT, date TEXT NOT NULL, warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
    status TEXT NOT NULL DEFAULT 'draft', scope TEXT, note TEXT, adjust_doc_id TEXT,
    created_by TEXT, created_at TEXT, posted_by TEXT, posted_at TEXT
  );
  CREATE TABLE stock_count_lines (
    id TEXT PRIMARY KEY, count_id TEXT NOT NULL REFERENCES stock_counts(id), product_id TEXT NOT NULL REFERENCES products(id),
    expected REAL NOT NULL DEFAULT 0, counted REAL, note TEXT
  );
  CREATE UNIQUE INDEX stock_count_lines_u ON stock_count_lines(count_id, product_id);

  -- ---------------------------------------------------------- partner (cari) ledger
  CREATE TABLE partner_moves (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, date TEXT NOT NULL, partner_id TEXT NOT NULL REFERENCES partners(id),
    currency TEXT NOT NULL, amount REAL NOT NULL, rate REAL, usd_iqd REAL, amount_usd REAL,
    kind TEXT NOT NULL, doc_id TEXT, payment_id TEXT, entry_id TEXT, description TEXT, due_date TEXT,
    rev INTEGER NOT NULL DEFAULT 1, voided INTEGER NOT NULL DEFAULT 0, user_id TEXT, created_at TEXT
  );
  CREATE INDEX partner_moves_partner ON partner_moves(partner_id, voided, currency, date);
  CREATE INDEX partner_moves_doc ON partner_moves(doc_id);
  CREATE INDEX partner_moves_payment ON partner_moves(payment_id);

  -- ---------------------------------------------------------- money (kasa / banka)
  CREATE TABLE money_accounts (
    id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'cash', name TEXT NOT NULL, currency TEXT NOT NULL,
    bank_name TEXT, branch TEXT, account_no TEXT, iban TEXT, opening_balance REAL NOT NULL DEFAULT 0, opening_date TEXT,
    is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
    notes TEXT, legacy_id TEXT, created_at TEXT
  );
  CREATE TABLE money_moves (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, date TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES money_accounts(id),
    amount REAL NOT NULL, currency TEXT NOT NULL, rate REAL, usd_iqd REAL, amount_usd REAL,
    kind TEXT NOT NULL, method TEXT, doc_id TEXT, payment_id TEXT, entry_id TEXT, transfer_id TEXT, count_id TEXT,
    partner_id TEXT, description TEXT,
    rev INTEGER NOT NULL DEFAULT 1, voided INTEGER NOT NULL DEFAULT 0, user_id TEXT, created_at TEXT
  );
  CREATE INDEX money_moves_account ON money_moves(account_id, voided, date, seq);
  CREATE INDEX money_moves_payment ON money_moves(payment_id);
  CREATE INDEX money_moves_doc ON money_moves(doc_id);

  CREATE TABLE payments (
    id TEXT PRIMARY KEY, no TEXT, date TEXT NOT NULL, direction TEXT NOT NULL,
    partner_id TEXT REFERENCES partners(id), account_id TEXT REFERENCES money_accounts(id), method TEXT,
    currency TEXT NOT NULL, amount REAL NOT NULL, rate REAL, usd_iqd REAL, amount_usd REAL,
    applied_currency TEXT NOT NULL, applied_amount REAL NOT NULL, applied_rate REAL,
    doc_id TEXT, purpose TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'posted',
    created_by TEXT, created_at TEXT, cancelled_by TEXT, cancelled_at TEXT, cancel_reason TEXT, legacy_id TEXT
  );
  CREATE INDEX payments_partner ON payments(partner_id, date);
  CREATE INDEX payments_doc ON payments(doc_id);
  CREATE INDEX payments_date ON payments(date);
  CREATE TABLE payment_allocations (
    id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id), doc_id TEXT NOT NULL REFERENCES docs(id),
    amount REAL NOT NULL, voided INTEGER NOT NULL DEFAULT 0, created_at TEXT
  );
  CREATE INDEX payment_allocations_doc ON payment_allocations(doc_id, voided);
  CREATE INDEX payment_allocations_payment ON payment_allocations(payment_id);

  CREATE TABLE transfers (
    id TEXT PRIMARY KEY, no TEXT, date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'transfer',
    from_account_id TEXT NOT NULL REFERENCES money_accounts(id), to_account_id TEXT NOT NULL REFERENCES money_accounts(id),
    from_amount REAL NOT NULL, to_amount REAL NOT NULL, rate REAL, usd_iqd REAL, fee REAL NOT NULL DEFAULT 0,
    description TEXT, status TEXT NOT NULL DEFAULT 'posted',
    created_by TEXT, created_at TEXT, cancelled_by TEXT, cancelled_at TEXT, cancel_reason TEXT
  );

  CREATE TABLE cash_counts (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES money_accounts(id),
    system_balance REAL NOT NULL, counted REAL NOT NULL, diff REAL NOT NULL, details TEXT,
    posted INTEGER NOT NULL DEFAULT 0, note TEXT, created_by TEXT, created_at TEXT
  );

  -- ---------------------------------------------------------- income / expense
  CREATE TABLE finance_categories (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, code TEXT, name TEXT NOT NULL,
    in_pl INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE finance_entries (
    id TEXT PRIMARY KEY, no TEXT, kind TEXT NOT NULL, date TEXT NOT NULL,
    category_id TEXT REFERENCES finance_categories(id), description TEXT,
    currency TEXT NOT NULL, amount REAL NOT NULL, rate REAL, usd_iqd REAL, amount_usd REAL,
    account_id TEXT REFERENCES money_accounts(id), partner_id TEXT REFERENCES partners(id), staff_id TEXT,
    recurring_id TEXT, status TEXT NOT NULL DEFAULT 'posted',
    created_by TEXT, created_at TEXT, updated_by TEXT, updated_at TEXT,
    cancelled_by TEXT, cancelled_at TEXT, cancel_reason TEXT, legacy_id TEXT
  );
  CREATE INDEX finance_entries_date ON finance_entries(kind, date);
  CREATE TABLE recurring_entries (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'expense', category_id TEXT, description TEXT,
    currency TEXT NOT NULL, amount REAL NOT NULL, day_of_month INTEGER NOT NULL DEFAULT 1,
    account_id TEXT, active INTEGER NOT NULL DEFAULT 1, legacy_id TEXT, created_at TEXT
  );

  CREATE TABLE notifications_read (user_id TEXT NOT NULL, key TEXT NOT NULL, ts TEXT, PRIMARY KEY (user_id, key));
  `,
  // ---------------------------------------------------------------- v2: audit entries carry a translatable message
  `ALTER TABLE audit_log ADD COLUMN msg TEXT;`,
  // ---------------------------------------------------------------- v3: returns settle their invoice; sign-in lockout survives restarts
  `
  CREATE TABLE doc_credits (
    id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id), credit_doc_id TEXT NOT NULL REFERENCES docs(id),
    amount REAL NOT NULL, credit_amount REAL NOT NULL, voided INTEGER NOT NULL DEFAULT 0, created_at TEXT
  );
  CREATE INDEX doc_credits_doc ON doc_credits(doc_id, voided);
  CREATE INDEX doc_credits_credit ON doc_credits(credit_doc_id, voided);
  ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN locked_until TEXT;
  CREATE TABLE login_failures (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, first_at TEXT, locked_until TEXT);
  `,
];

module.exports = { MIGRATIONS };
