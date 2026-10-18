import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3030;

app.use(cors());
app.use(express.json());

// Base de datos Enigma SQLite para compatibilidad
const enigmaDbPath = path.join(process.env.HOME || os.homedir(), '.local/share/enigma/enigma_core.db');

// Estado interno del puente
let isReady = false;
let qrRaw = null;
let qrCodeBase64 = null;
let currentStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'open'
let userNumber = null;

// ==========================================
// 1. INICIALIZACIÓN DE WHATSAPP-WEB.JS CON LOCALAUTH
// ==========================================
const authPath = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(authPath)) {
  fs.mkdirSync(authPath, { recursive: true });
}

console.log('[WhatsApp Web] Inicializando cliente WhatsApp Web (Puppeteer)...');
console.log('[WhatsApp Web] Carpeta de sesión persistente:', authPath);

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: authPath
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

// ==========================================
// EVENTOS DE CICLO DE VIDA DE WHATSAPP
// ==========================================

client.on('qr', async (qr) => {
  isReady = false;
  qrRaw = qr;
  currentStatus = 'qr_ready';
  console.log('\n[WhatsApp Web] ==========================================');
  console.log('[WhatsApp Web] NUEVO CÓDIGO QR GENERADO:');
  qrcodeTerminal.generate(qr, { small: true });
  console.log('[WhatsApp Web] Escanea este código QR con WhatsApp en tu móvil.');
  console.log('[WhatsApp Web] ==========================================\n');

  qrcodeTerminal.generate(qr, { small: true }, (ascii) => {
    try {
      fs.writeFileSync(path.join(__dirname, 'latest_qr.txt'), ascii);
    } catch (_) {}
  });

  try {
    qrCodeBase64 = await QRCode.toDataURL(qr, {
      margin: 2,
      scale: 8,
      color: { dark: '#000000', light: '#ffffff' }
    });
  } catch (err) {
    console.error('[WhatsApp Web] Error generando base64 del código QR:', err);
  }
});

client.on('authenticated', () => {
  console.log('[WhatsApp Web] Sesión autenticada con éxito.');
  currentStatus = 'authenticated';
  qrRaw = null;
  qrCodeBase64 = null;
});

client.on('auth_failure', (msg) => {
  console.error('[WhatsApp Web] Error de autenticación en sesión previa:', msg);
  isReady = false;
  currentStatus = 'auth_failure';
});

client.on('loading_screen', (percent, message) => {
  console.log(`[WhatsApp Web] Cargando WhatsApp Web: ${percent}% - ${message}`);
  currentStatus = 'connecting';
});

client.on('ready', async () => {
  isReady = true;
  currentStatus = 'open';
  qrRaw = null;
  qrCodeBase64 = null;
  userNumber = client.info?.wid?.user || 'Usuario conectado';

  console.log('\n==================================================');
  console.log(`[WhatsApp Web] PUENTE 100% OPERATIVO Y LISTO.`);
  console.log(`[WhatsApp Web] Conectado como: ${userNumber}`);
  console.log('==================================================\n');

  console.log('[WhatsApp Web] Contactos listos. Sincronización automática en reposo.');
});

client.on('disconnected', (reason) => {
  console.log('[WhatsApp Web] Cliente desconectado. Motivo:', reason);
  isReady = false;
  currentStatus = 'disconnected';
});

// Limpiar bloqueos residuales de Chromium en caso de reinicio imprevisto
try {
  const sessionPath = path.join(authPath, 'session');
  if (fs.existsSync(sessionPath)) {
    for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const fullLock = path.join(sessionPath, lockFile);
      if (fs.existsSync(fullLock)) {
        try { fs.unlinkSync(fullLock); } catch (_) {}
      }
    }
  }
} catch (_) {}

// Arrancar cliente de WhatsApp
client.initialize().catch((err) => {
  console.error('[WhatsApp Web] Error fatal inicializando cliente Puppeteer:', err);
});

// ==========================================
// UTILIDADES: SINCRONIZACIÓN CON SQLITE
// ==========================================
async function syncContactsToSqlite() {
  if (!isReady || !fs.existsSync(enigmaDbPath)) return;
  try {
    const rawContacts = await client.getContacts();
    const valid = rawContacts
      .filter(c => !c.isGroup && !c.isBroadcast && c.id && c.id.server === 'c.us')
      .map(c => ({
        id: c.id._serialized,
        name: c.name || c.pushname || c.shortName || (c.number ? `+${c.number}` : c.id.user)
      }))
      .filter(c => c.id && c.name);

    execFileSync('sqlite3', [
      enigmaDbPath,
      'CREATE TABLE IF NOT EXISTS deleted_whatsapp_contacts (id TEXT PRIMARY KEY, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP);'
    ]);

    for (const c of valid) {
      const safeName = c.name.replace(/'/g, "''");
      execFileSync('sqlite3', [
        enigmaDbPath,
        `INSERT INTO whatsapp_contacts (id, name)
         SELECT '${c.id}', '${safeName}'
         WHERE '${c.id}' NOT IN (SELECT id FROM deleted_whatsapp_contacts)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name;`
      ]);
    }
    console.log(`[WhatsApp Web] Sincronizados ${valid.length} contactos en SQLite (enigma_core.db)`);
  } catch (err) {
    console.error('[WhatsApp Web] Error en syncContactsToSqlite:', err.message);
  }
}

// ==========================================
// 2. ENDPOINTS DE EXPRESS (COMPATIBILIDAD CON RUST / TAURI)
// ==========================================

// GET /status: Estado general de la conexión
app.get('/status', (req, res) => {
  res.json({
    connected: isReady,
    ready: isReady,
    status: currentStatus,
    user: userNumber,
    hasQr: !!qrCodeBase64
  });
});

// GET /qr: Devuelve el código QR para el frontend
app.get('/qr', (req, res) => {
  res.json({
    connected: isReady,
    status: currentStatus,
    qr: qrCodeBase64 || qrRaw,
    message: qrRaw ? 'Código QR disponible para escanear' : (isReady ? 'WhatsApp ya está conectado' : 'Cargando sesión...')
  });
});

// GET /contacts: Devuelve la lista limpia de contactos [{ id, name }]
app.get('/contacts', async (req, res) => {
  try {
    if (!isReady) {
      return res.status(200).json([]);
    }

    const rawContacts = await client.getContacts();
    const contacts = rawContacts
      .filter(c => !c.isGroup && !c.isBroadcast && c.id && c.id.server === 'c.us')
      .map(c => {
        const id = c.id._serialized;
        const name = c.name || c.pushname || c.shortName || (c.number ? `+${c.number}` : id.split('@')[0]);
        return { id, name };
      })
      .filter(c => c.id && c.name);

    res.json(contacts);
  } catch (err) {
    console.error('[WhatsApp Web] Error en GET /contacts:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /send: Envío de mensajes de WhatsApp
app.post('/send', async (req, res) => {
  try {
    if (!isReady) {
      return res.status(503).json({
        success: false,
        error: 'El puente de WhatsApp aún se está conectando. Por favor, espera a que esté listo.'
      });
    }

    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({
        success: false,
        error: 'Faltan parámetros requeridos: number y message'
      });
    }

    // Normalizar chatId con el sufijo @c.us estricto de whatsapp-web.js
    let target = String(number).trim();
    if (target.endsWith('@s.whatsapp.net')) {
      target = target.replace('@s.whatsapp.net', '@c.us');
    } else if (!target.includes('@')) {
      const cleanDigits = target.replace(/[^0-9]/g, '');
      target = `${cleanDigits}@c.us`;
    }

    // Intentar resolver JID oficial con getNumberId para máxima precisión
    try {
      const cleanDigits = target.split('@')[0].replace(/[^0-9]/g, '');
      const numberDetails = await client.getNumberId(cleanDigits);
      if (numberDetails?._serialized) {
        target = numberDetails._serialized;
      }
    } catch (_) {}

    console.log(`[WhatsApp Web] Enviando mensaje a ${target}: "${message.slice(0, 30)}..."`);
    const sentMsg = await client.sendMessage(target, message);

    const messageId = sentMsg?.id?._serialized || `msg_${Date.now()}`;

    res.json({
      success: true,
      messageId: messageId,
      to: target,
      message: message
    });
  } catch (err) {
    console.error('[WhatsApp Web] Error en POST /send:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /contacts/delete: Eliminar contacto permanentemente
app.post('/contacts/delete', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Falta parámetro id' });

    if (fs.existsSync(enigmaDbPath)) {
      try {
        const altId = id.includes('@c.us') ? id.replace('@c.us', '@s.whatsapp.net') : id.replace('@s.whatsapp.net', '@c.us');
        execFileSync('sqlite3', [
          enigmaDbPath,
          `CREATE TABLE IF NOT EXISTS deleted_whatsapp_contacts (id TEXT PRIMARY KEY, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP);
           INSERT OR IGNORE INTO deleted_whatsapp_contacts (id) VALUES ('${id}'), ('${altId}');
           DELETE FROM whatsapp_contacts WHERE id = '${id}' OR id = '${altId}';`
        ]);
        console.log(`[WhatsApp Web] Contacto eliminado permanentemente de SQLite: ${id}`);
      } catch (e) {
        console.warn('[WhatsApp Web] Error borrando de SQLite:', e.message);
      }
    }
    res.json({ success: true, deleted: id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /contacts/delete-batch: Eliminar múltiples contactos de forma permanente
app.post('/contacts/delete-batch', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Falta array de ids' });
    }

    if (fs.existsSync(enigmaDbPath)) {
      try {
        const allIds = [];
        for (const id of ids) {
          allIds.push(id);
          const altId = id.includes('@c.us') ? id.replace('@c.us', '@s.whatsapp.net') : id.replace('@s.whatsapp.net', '@c.us');
          allIds.push(altId);
        }

        const valuesClause = allIds.map(id => `('${id.replace(/'/g, "''")}')`).join(',');
        const inClause = allIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');

        const sql = `
          CREATE TABLE IF NOT EXISTS deleted_whatsapp_contacts (id TEXT PRIMARY KEY, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP);
          INSERT OR IGNORE INTO deleted_whatsapp_contacts (id) VALUES ${valuesClause};
          DELETE FROM whatsapp_contacts WHERE id IN (${inClause});
        `;

        execFileSync('sqlite3', [enigmaDbPath, sql]);
        console.log(`[WhatsApp Web] ${ids.length} contactos eliminados permanentemente de SQLite.`);
      } catch (e) {
        console.warn('[WhatsApp Web] Error en borrado por lote de SQLite:', e.message);
      }
    }
    res.json({ success: true, count: ids.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 3. APAGADO ELEGANTE (HTTP /shutdown & SEÑALES OS)
// ==========================================
app.get('/shutdown', async (req, res) => {
  console.log('[WhatsApp Web] Recibida orden de apagado de Tauri vía /shutdown. Cerrando cliente...');
  try {
    if (client) {
      await client.destroy();
      console.log('[WhatsApp Web] Cliente destruido y sesión cerrada limpiamente.');
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[WhatsApp Web] Error al destruir cliente en /shutdown:', err);
    res.status(500).send('ERROR');
  } finally {
    setTimeout(() => {
      console.log('[WhatsApp Web] Proceso finalizado.');
      process.exit(0);
    }, 150);
  }
});

process.on('SIGINT', async () => {
  console.log('[WhatsApp Web] SIGINT recibido. Cerrando cliente WhatsApp...');
  try {
    if (client) await client.destroy();
  } catch (_) {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[WhatsApp Web] SIGTERM recibido. Cerrando cliente WhatsApp...');
  try {
    if (client) await client.destroy();
  } catch (_) {}
  process.exit(0);
});

// Iniciar servidor Express en el puerto 3030
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[WhatsApp Web] Servidor Express activo en http://127.0.0.1:${PORT}`);
});
