#!/usr/bin/env node
/**
 * Filtros_Panasa — API Backend
 * Puerto: 3010
 * Base de datos: SQLite (archivo local)
 * Dominio: panasa.gmnodo.com
 */

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3010;
const DB_PATH = '/srv/filtros-panasa/api/filtros_panasa.db';

// Middleware
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Inicializar base de datos
let db;
function initDb() {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.run(`PRAGMA journal_mode=WAL`);
      createTables().then(() => resolve(db)).catch(reject);
    });
  });
}

function createTables() {
  return new Promise((resolve, reject) => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS licenses (
        id TEXT PRIMARY KEY,
        device_id TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'pending',
        activated_at_ts TEXT,
        expires_at_ts TEXT,
        signature TEXT,
        public_key_hash TEXT,
        created_at_ts TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at_ts TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        installation_id TEXT UNIQUE NOT NULL,
        name TEXT,
        last_seen_ts TEXT,
        created_at_ts TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS employees (
        payroll_code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at_ts TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS grilles (
        grille_code TEXT PRIMARY KEY,
        name TEXT,
        position INTEGER,
        created_at_ts TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS filters (
        id TEXT PRIMARY KEY,
        grille_code TEXT NOT NULL,
        filter_number INTEGER NOT NULL,
        position TEXT NOT NULL,
        created_at_ts TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(grille_code) REFERENCES grilles(grille_code),
        UNIQUE(grille_code, filter_number),
        UNIQUE(grille_code, position)
      )`,
      `CREATE TABLE IF NOT EXISTS filter_events (
        id TEXT PRIMARY KEY,
        event_id TEXT UNIQUE NOT NULL,
        event_type TEXT DEFAULT 'filter_replacement',
        grille_code TEXT NOT NULL,
        filter_number INTEGER NOT NULL,
        payroll_code TEXT NOT NULL,
        occurred_at_ts TEXT NOT NULL,
        device_installation_id TEXT,
        server_received_at_ts TEXT DEFAULT CURRENT_TIMESTAMP,
        notes TEXT,
        synced INTEGER DEFAULT 0,
        created_at_ts TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(grille_code) REFERENCES grilles(grille_code)
      )`,
      `CREATE TABLE IF NOT EXISTS sync_outbox (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        next_retry_at_ts TEXT,
        status TEXT DEFAULT 'pending',
        created_at_ts TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at_ts TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(event_id)
      )`,
      `CREATE TABLE IF NOT EXISTS sync_cursor (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at_ts TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor TEXT,
        action TEXT,
        target TEXT,
        details TEXT,
        created_at_ts TEXT DEFAULT CURRENT_TIMESTAMP
      )`
    ];
    let i = 0;
    function next() {
      if (i >= stmts.length) return resolve();
      db.run(stmts[i], (err) => {
        if (err) return reject(err);
        i++;
        next();
      });
    }
    next();
  });
}

// UUID v4
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Middleware de logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'filtros-panasa-api', port: PORT, db: 'connected' });
});

// ==================== LICENCIA ====================

app.post('/api/license/activate', (req, res) => {
  const { licenseKey, deviceId, deviceName } = req.body;
  if (!licenseKey || !deviceId) {
    return res.status(400).json({ error: 'licenseKey y deviceId requeridos' });
  }
  // Simulación: clave gratuita válida si comienza con PAN-
  const valid = licenseKey.startsWith('PAN-');
  const activationId = uuidv4();
  const signature = crypto.createHmac('sha256', 'panasa-secret-2026')
    .update(`${deviceId}:${activationId}:${Date.now()}`)
    .digest('hex');
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const stmt = db.prepare(`INSERT OR REPLACE INTO licenses (id, device_id, status, activated_at_ts, expires_at_ts, signature, updated_at_ts) VALUES (?, ?, 'active', ?, ?, ?, CURRENT_TIMESTAMP)`);
  stmt.run(activationId, deviceId, new Date().toISOString(), expiresAt, signature, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    stmt.finalize();
    // Registrar dispositivo
    const devStmt = db.prepare(`INSERT OR REPLACE INTO devices (id, installation_id, name, last_seen_ts, created_at_ts) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    devStmt.run(deviceId, deviceId, deviceName || 'Dispositivo', new Date().toISOString(), (err2) => {
      devStmt.finalize();
      if (err2) return res.status(500).json({ error: err2.message });
      // Auditoría
      const auditStmt = db.prepare(`INSERT INTO audit_events (id, actor, action, target, details, created_at_ts) VALUES (?, 'system', 'license_activate', ?, ?, CURRENT_TIMESTAMP)`);
      auditStmt.run(uuidv4(), 'license', JSON.stringify({ deviceId, valid }), (err3) => {
        auditStmt.finalize();
        if (err3) console.error('Audit error:', err3.message);
      });
      res.json({
        success: valid,
        activationId,
        expiresAt,
        signature,
        message: valid ? 'Licencia activada' : 'Clave inválida'
      });
    });
  });
});

app.get('/api/license/status/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  db.get(`SELECT * FROM licenses WHERE device_id = ?`, [deviceId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.json({ active: false, message: 'Sin activación' });
    const now = new Date();
    const expires = new Date(row.expires_at_ts);
    const days = Math.ceil((expires - now) / (1000 * 60 * 60 * 24));
    res.json({
      active: row.status === 'active' && days > 0,
      deviceId: row.device_id,
      activatedAt: row.activated_at_ts,
      expiresAt: row.expires_at_ts,
      daysUntilExpiry: days,
      signature: row.signature
    });
  });
});

// ==================== EMPLEADOS ====================

app.get('/api/employees', (req, res) => {
  db.all(`SELECT payroll_code, name, active FROM employees WHERE active = 1`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ employees: rows || [] });
  });
});

app.post('/api/employees', (req, res) => {
  const { payrollCode, name } = req.body;
  if (!payrollCode || !name) return res.status(400).json({ error: 'payrollCode y name requeridos' });
  const stmt = db.prepare(`INSERT OR REPLACE INTO employees (payroll_code, name, active, created_at_ts) VALUES (?, ?, 1, CURRENT_TIMESTAMP)`);
  stmt.run(payrollCode, name, (err) => {
    stmt.finalize();
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, payrollCode, name });
  });
});

// ==================== REJILLAS Y FILTROS ====================

app.get('/api/grilles', (req, res) => {
  db.all(`SELECT * FROM grilles ORDER BY grille_code`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ grilles: rows || [] });
  });
});

app.get('/api/filters/:grilleCode', (req, res) => {
  const { grilleCode } = req.params;
  db.all(`SELECT * FROM filters WHERE grille_code = ? ORDER BY filter_number`, [grilleCode], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ filters: rows || [] });
  });
});

// ==================== EVENTOS (REEMPLAZOS) ====================

app.post('/api/events', (req, res) => {
  const { eventId, grilleCode, filterNumber, payrollCode, occurredAt, deviceInstallationId, notes } = req.body;
  if (!eventId || !grilleCode || filterNumber == null || !payrollCode || !occurredAt) {
    return res.status(400).json({ error: 'Campos requeridos: eventId, grilleCode, filterNumber, payrollCode, occurredAt' });
  }
  // Idempotencia: verificar si ya existe
  db.get(`SELECT id FROM filter_events WHERE event_id = ?`, [eventId], (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });
    if (existing) {
      return res.status(200).json({ success: true, duplicate: true, eventId });
    }
    const id = uuidv4();
    const serverReceivedAt = new Date().toISOString();
    const stmt = db.prepare(`INSERT INTO filter_events (id, event_id, grille_code, filter_number, payroll_code, occurred_at_ts, device_installation_id, notes, server_received_at_ts, synced, created_at_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`);
    stmt.run(id, eventId, grilleCode, filterNumber, payrollCode, occurredAt, deviceInstallationId || null, notes || null, serverReceivedAt, (err) => {
      stmt.finalize();
      if (err) return res.status(500).json({ error: err.message });
      // Cola de salida
      const outboxStmt = db.prepare(`INSERT OR REPLACE INTO sync_outbox (id, event_id, payload, attempts, next_retry_at_ts, status, created_at_ts, updated_at_ts) VALUES (?, ?, ?, 0, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
      const payload = JSON.stringify({ eventId, grilleCode, filterNumber, payrollCode, occurredAt, deviceInstallationId, notes, serverReceivedAt });
      const nextRetry = new Date(Date.now() + 5000).toISOString();
      outboxStmt.run(uuidv4(), eventId, payload, nextRetry, (err2) => {
        outboxStmt.finalize();
        if (err2) console.error('Outbox error:', err2.message);
        // Auditoría
        const auditStmt = db.prepare(`INSERT INTO audit_events (id, actor, action, target, details, created_at_ts) VALUES (?, 'system', 'event_register', ?, ?, CURRENT_TIMESTAMP)`);
        auditStmt.run(uuidv4(), 'event', JSON.stringify({ eventId, grilleCode, filterNumber }), (err3) => {
          auditStmt.finalize();
          if (err3) console.error('Audit error:', err3.message);
        });
        res.json({ success: true, eventId, id, serverReceivedAt, message: 'Evento registrado' });
      });
    });
  });
});

app.get('/api/events', (req, res) => {
  const { grilleCode, from, to, synced } = req.query;
  let sql = `SELECT * FROM filter_events WHERE 1=1`;
  const params = [];
  if (grilleCode) { sql += ` AND grille_code = ?`; params.push(grilleCode); }
  if (from) { sql += ` AND occurred_at_ts >= ?`; params.push(from); }
  if (to) { sql += ` AND occurred_at_ts <= ?`; params.push(to); }
  if (synced !== undefined) { sql += ` AND synced = ?`; params.push(synced === 'true' ? 1 : 0); }
  sql += ` ORDER BY occurred_at_ts DESC`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ events: rows || [], count: (rows || []).length });
  });
});

app.get('/api/events/pending', (req, res) => {
  db.all(`SELECT * FROM sync_outbox WHERE status = 'pending' ORDER BY next_retry_at_ts ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ pending: rows || [], count: (rows || []).length });
  });
});

app.post('/api/events/ack', (req, res) => {
  const { eventId, serverReceivedAt } = req.body;
  if (!eventId) return res.status(400).json({ error: 'eventId requerido' });
  db.run(`UPDATE filter_events SET synced = 1 WHERE event_id = ?`, [eventId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.run(`UPDATE sync_outbox SET status = 'synced', updated_at_ts = CURRENT_TIMESTAMP WHERE event_id = ?`, [eventId], (err2) => {
      if (err2) console.error('Outbox update error:', err2.message);
      res.json({ success: true, eventId, acknowledged: true, serverReceivedAt });
    });
  });
});

// ==================== SINCRONIZACIÓN ====================

app.get('/api/sync/cursor', (req, res) => {
  db.get(`SELECT value FROM sync_cursor WHERE key = 'last_sync'`, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ lastSync: row ? row.value : null });
  });
});

app.post('/api/sync/cursor', (req, res) => {
  const { value } = req.body;
  if (!value) return res.status(400).json({ error: 'value requerido' });
  db.run(`INSERT OR REPLACE INTO sync_cursor (key, value, updated_at_ts) VALUES ('last_sync', ?, CURRENT_TIMESTAMP)`, [value], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, lastSync: value });
  });
});

app.post('/api/sync/download', (req, res) => {
  // Descarga cambios desde servidor central (simulado)
  const { since } = req.body;
  db.run(`INSERT OR REPLACE INTO sync_cursor (key, value, updated_at_ts) VALUES ('last_download', ?, CURRENT_TIMESTAMP)`, [since || new Date().toISOString()], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, downloaded: 0, message: 'Sincronización completada' });
  });
});

// ==================== SEED (inicialización) ====================

app.post('/api/seed', (req, res) => {
  // Crear rejillas R01-R22 y filtros 1-4
  const grilleStmt = db.prepare(`INSERT OR IGNORE INTO grilles (grille_code, name, position, created_at_ts) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`);
  const filterStmt = db.prepare(`INSERT OR IGNORE INTO filters (id, grille_code, filter_number, position, created_at_ts) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`);
  const positions = ['1-arriba-izquierda', '2-arriba-derecha', '3-abajo-derecha', '4-abajo-izquierda'];
  for (let i = 1; i <= 22; i++) {
    const code = `R${String(i).padStart(2, '0')}`;
    grilleStmt.run(code, `Rejilla ${code}`, i);
    for (let j = 1; j <= 4; j++) {
      filterStmt.run(uuidv4(), code, j, positions[j - 1]);
    }
  }
  grilleStmt.finalize();
  filterStmt.finalize((err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, grilles: 22, filters: 88, message: 'Seed completado' });
  });
});

// Iniciar
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Filtros_Panasa API escuchando en puerto ${PORT}`);
    console.log(`DB: ${DB_PATH}`);
    console.log(`Dominio: panasa.gmnodo.com`);
  });
}).catch((err) => {
  console.error('Error al iniciar:', err.message);
  process.exit(1);
});
