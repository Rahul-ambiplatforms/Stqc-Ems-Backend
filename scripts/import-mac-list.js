/**
 * import-mac-list.js — bulk-import Adiance's purchased MAC range.
 *
 * Usage:
 *   node scripts/import-mac-list.js [path/to/ADIANCE_MAC_LIST.xlsx]
 *
 * Default path: /home/rahulvadhiya.vmukti/PreData/ADIANCE_MAC_LIST.xlsx
 *
 * Spreadsheet columns (header row 1):
 *   A: MAC Address           (e.g. "80:77:86:50:00:00")
 *   B: MAC Use In UID        (deviceId — null if unallocated)
 *   C: Date                  (when assigned, may be Excel serial or null)
 *   D: Type                  ("Eth" | "WIFI" | "4G" | null)
 *
 * Behaviour:
 *   - Empty / unallocated rows → status='available'
 *   - Rows with deviceId       → status='burned' (already shipped); deviceId stored
 *   - Idempotent: upserts by mac. Re-running keeps existing burned rows
 *     untouched if the spreadsheet still shows the same deviceId for them.
 *
 * Performance: 1M rows in batches of 5000 via bulkWrite — ~30 seconds total.
 *
 * Side effect (--create-devices): if a MAC row has an ATPL- deviceId, also
 * upsert a matching ProvisionedDevice row so EMS knows about that device.
 * Pass --no-create-devices to skip this.
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const xlsx = require('xlsx');
const MacPool = require('../models/macPool');
const ProvisionedDevice = require('../models/provisionedDevice');

const SHEET_PATH = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : '/home/rahulvadhiya.vmukti/PreData/ADIANCE_MAC_LIST.xlsx';
const args = new Set(process.argv.slice(2));
const createDevices = !args.has('--no-create-devices');

const FAMILY_CODES = { SECOS: 0, AUGEN: 1, '4GBDP': 2, WFBDP: 3 };

function normalizeMac(s) {
  if (!s) return null;
  const cleaned = String(s).trim().replace(/[:\-\s.]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(cleaned)) return null;
  return cleaned;
}

function ouiOf(mac) { return mac.slice(0, 6); }

function importBatchTag() {
  return `xlsx-${new Date().toISOString().slice(0, 10)}-${process.pid}`;
}

async function main() {
  if (!fs.existsSync(SHEET_PATH)) {
    console.error(`✗ sheet not found: ${SHEET_PATH}`);
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('✗ MONGO_URI not set in .env'); process.exit(1); }

  console.log(`[import-macs] reading ${SHEET_PATH}`);
  const t0 = Date.now();
  const wb = xlsx.readFile(SHEET_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null });
  console.log(`[import-macs] read ${rows.length} rows in ${Date.now() - t0}ms`);

  console.log(`[import-macs] connecting to mongo: ${uri.replace(/\/\/[^@]+@/, '//***@')}`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  await MacPool.init();   // wait for indexes

  const tag = importBatchTag();
  console.log(`[import-macs] importBatch tag: ${tag}`);
  console.log(`[import-macs] createDevices=${createDevices}`);

  let processed = 0, malformed = 0, available = 0, burned = 0;
  const macOps = [];
  const deviceOps = [];
  const BATCH_SIZE = 5000;
  let totalDevicesUpserted = 0;

  async function flush() {
    if (macOps.length) {
      const r = await MacPool.bulkWrite(macOps, { ordered: false });
      // r.upsertedCount + r.modifiedCount tell us how much landed
    }
    macOps.length = 0;
    if (createDevices && deviceOps.length) {
      try {
        const r = await ProvisionedDevice.bulkWrite(deviceOps, { ordered: false });
        totalDevicesUpserted += (r.upsertedCount || 0) + (r.modifiedCount || 0);
      } catch (e) {
        // Some rows may fail validation (legacy VSPL- format) — keep going
        console.warn(`  device bulkWrite partial: ${e.message?.slice(0, 200)}`);
      }
    }
    deviceOps.length = 0;
  }

  // Skip header row (index 0)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const [macRaw, devidRaw, dateRaw, typeRaw] = row;
    const mac = normalizeMac(macRaw);
    if (!mac) { malformed++; continue; }

    const deviceId = devidRaw && String(devidRaw).trim() ? String(devidRaw).trim().toUpperCase() : null;
    const type = typeRaw && String(typeRaw).trim() ? String(typeRaw).trim().toUpperCase().replace(/^WIFI$/, 'WIFI') : null;
    // Normalize "Eth", "WIFI", "4G" — anything else null
    const typeOk = (type === 'ETH' ? 'Eth' : (type === 'WIFI' ? 'WIFI' : (type === '4G' ? '4G' : null)));

    let status, assignedAt = null, burnedAt = null;
    if (deviceId) {
      status = 'burned';
      // Excel date can be a serial number (days since 1900) or a Date object
      if (dateRaw instanceof Date) burnedAt = dateRaw;
      else if (typeof dateRaw === 'number') {
        burnedAt = new Date(Math.round((dateRaw - 25569) * 86400 * 1000));
      }
      assignedAt = burnedAt;
      burned++;
    } else {
      status = 'available';
      available++;
    }

    macOps.push({
      updateOne: {
        filter: { mac },
        update: {
          $set: {
            mac,
            oui: ouiOf(mac),
            type: typeOk,
            status,
            deviceId,
            assignedAt,
            burnedAt,
            importBatch: tag,
            importedAt: new Date(),
            importedBy: 'script:import-mac-list.js',
          },
        },
        upsert: true,
      },
    });

    // ATPL-NNNNNN-FAMILY → also upsert a ProvisionedDevice
    if (createDevices && deviceId && /^ATPL-\d{6}-(SECOS|AUGEN|4GBDP|WFBDP)$/.test(deviceId)) {
      const m = deviceId.match(/^ATPL-(\d{6})-(SECOS|AUGEN|4GBDP|WFBDP)$/);
      const serial = parseInt(m[1], 10);
      const family = m[2];
      deviceOps.push({
        updateOne: {
          filter: { deviceId },
          update: {
            $set: {
              deviceId,
              serialNumber: serial,
              suffix: family,
              family,
              familyCode: FAMILY_CODES[family],
              productModel: 'IMPORTED',                // placeholder; admin can fix
              status: 'verified',                       // historical — already shipped
              mac,
            },
            $setOnInsert: { batchId: 'IMPORTED-LEGACY' },
          },
          upsert: true,
        },
      });
    }

    processed++;
    if (macOps.length >= BATCH_SIZE) await flush();
    if (processed % 100000 === 0) {
      console.log(`  ... ${processed} rows processed (${available} avail / ${burned} burned)`);
    }
  }
  await flush();

  // Stats
  const totalInDb = await MacPool.countDocuments();
  const availInDb = await MacPool.countDocuments({ status: 'available' });
  const burnedInDb = await MacPool.countDocuments({ status: 'burned' });
  const ethBurned = await MacPool.countDocuments({ status: 'burned', type: 'Eth' });
  const wifiBurned = await MacPool.countDocuments({ status: 'burned', type: 'WIFI' });

  console.log('');
  console.log(`[import-macs] ✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  rows in sheet:        ${rows.length - 1}`);
  console.log(`  processed:            ${processed}`);
  console.log(`  malformed (skipped):  ${malformed}`);
  console.log(`  available (sheet):    ${available}`);
  console.log(`  burned (sheet):       ${burned}`);
  console.log('');
  console.log(`  mac_pool count:       ${totalInDb}`);
  console.log(`    └ available:        ${availInDb}`);
  console.log(`    └ burned:           ${burnedInDb} (Eth=${ethBurned}, WIFI=${wifiBurned})`);
  if (createDevices) {
    const devCount = await ProvisionedDevice.countDocuments({ batchId: 'IMPORTED-LEGACY' });
    console.log(`  legacy ATPL devices upserted: ${devCount}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(`[import-macs] FAILED:`, e.message); process.exit(1); });
