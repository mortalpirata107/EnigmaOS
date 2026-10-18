#!/usr/bin/env node
/**
 * Importador Universal de Contactos para Enigma (WhatsApp & SQLite)
 * Soporta archivos .vcf (vCard), .csv y .json
 * Uso:
 *   node import_contacts.js /ruta/a/mi_agenda.vcf
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const vcfArg = process.argv[2];
if (!vcfArg) {
  console.log(`
Uso del importador de contactos:
  node import_contacts.js <archivo.vcf | archivo.csv | archivo.json>

Ejemplo:
  node import_contacts.js ~/Descargas/contactos.vcf
`);
  process.exit(1);
}

const targetPath = path.resolve(process.cwd(), vcfArg);
if (!fs.existsSync(targetPath)) {
  console.error(`[Error] No se encontró el archivo: ${targetPath}`);
  process.exit(1);
}

function normalizePhoneNumber(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^0-9]/g, '');
  if (!digits || digits.length < 8) return null;
  if (digits.length === 9 && (digits.startsWith('6') || digits.startsWith('7'))) {
    digits = '34' + digits;
  }
  return `${digits}@s.whatsapp.net`;
}

function parseVcf(content) {
  const lines = content.split(/\r?\n/);
  let currentName = null;
  const contacts = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    if (line.startsWith('BEGIN:VCARD')) {
      currentName = null;
    } else if (line.startsWith('FN:') || line.startsWith('FN;')) {
      const parts = line.split(':');
      if (parts.length > 1) {
        currentName = parts.slice(1).join(':').trim();
      }
    } else if (!currentName && (line.startsWith('N:') || line.startsWith('N;'))) {
      const parts = line.split(':');
      if (parts.length > 1) {
        const nameParts = parts.slice(1).join(':').split(';');
        const last = (nameParts[0] || '').trim();
        const first = (nameParts[1] || '').trim();
        currentName = `${first} ${last}`.trim() || null;
      }
    } else if (line.startsWith('TEL')) {
      const parts = line.split(':');
      if (parts.length > 1) {
        const rawPhone = parts.slice(1).join(':').trim();
        const jid = normalizePhoneNumber(rawPhone);
        if (jid && currentName) {
          contacts.push({ id: jid, name: currentName });
        }
      }
    } else if (line.startsWith('END:VCARD')) {
      currentName = null;
    }
  }
  return contacts;
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/);
  const contacts = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || line.toLowerCase().startsWith('name') || line.toLowerCase().startsWith('nombre')) continue;
    const parts = line.split(/[,;\t]/);
    if (parts.length >= 2) {
      const name = parts[0].replace(/["']/g, '').trim();
      const phone = parts[1].replace(/["']/g, '').trim();
      const jid = normalizePhoneNumber(phone);
      if (jid && name) {
        contacts.push({ id: jid, name });
      }
    }
  }
  return contacts;
}

const fileContent = fs.readFileSync(targetPath, 'utf-8');
let contactsToImport = [];

if (targetPath.endsWith('.vcf') || fileContent.includes('BEGIN:VCARD')) {
  contactsToImport = parseVcf(fileContent);
} else if (targetPath.endsWith('.json')) {
  const parsed = JSON.parse(fileContent);
  const arr = Array.isArray(parsed) ? parsed : (parsed.contacts || []);
  for (const c of arr) {
    const jid = normalizePhoneNumber(c.phone || c.telefono || c.number || c.id);
    const name = c.name || c.nombre;
    if (jid && name) {
      contactsToImport.push({ id: jid, name });
    }
  }
} else {
  contactsToImport = parseCsv(fileContent);
}

console.log(`[Importador] Extraídos ${contactsToImport.length} contactos de: ${targetPath}`);

if (contactsToImport.length === 0) {
  console.log('[Aviso] No se pudieron extraer contactos del archivo proporcionado.');
  process.exit(0);
}

// 1. Guardar en Baileys Store JSON
const storePath = path.join(__dirname, 'baileys_store.json');
let store = { contacts: {} };
if (fs.existsSync(storePath)) {
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    if (!store.contacts) store.contacts = {};
  } catch (_) {}
}

for (const c of contactsToImport) {
  store.contacts[c.id] = { id: c.id, name: c.name };
}
fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
console.log(`[Store Baileys] Guardados en ${storePath}. Total en store: ${Object.keys(store.contacts).length}`);

// 2. Guardar en SQLite de Enigma
const dbPath = path.join(process.env.HOME || os.homedir(), '.local/share/enigma/enigma_core.db');
if (fs.existsSync(dbPath)) {
  try {
    const db = new Database(dbPath);
    const stmt = db.prepare('INSERT INTO whatsapp_contacts (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name');
    const insertMany = db.transaction((list) => {
      let count = 0;
      for (const item of list) {
        stmt.run(item.id, item.name);
        count++;
      }
      return count;
    });
    const inserted = insertMany(contactsToImport);
    console.log(`[SQLite Enigma] Insertados/actualizados con éxito ${inserted} contactos en SQLite: ${dbPath}`);
    db.close();
  } catch (err) {
    console.warn(`[Aviso SQLite] No se pudo escribir con better-sqlite3: ${err.message}. El store de Baileys fue actualizado.`);
  }
}

console.log(`
✅ ¡IMPORTACIÓN COMPLETADA CON ÉXITO!
Todos los contactos ahora están disponibles para Enigma y Tool Calling sin enviar ningún mensaje.
`);
