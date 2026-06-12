/**
 * import-product-models.js — load Adiance SKU catalog into product_models.
 *
 * Usage:
 *   node scripts/import-product-models.js [path/to/STQC_APPLIED_SKU.xlsx]
 *
 * Default file path: /home/rahulvadhiya.vmukti/PreData/STQC_APPLIED_SKU.xlsx
 *
 * Spreadsheet columns (no header — data starts row 1):
 *   col A: serial #   (ignored)
 *   col B: SKU code   (e.g. AD-90ARWFBDP)
 *   col C: SoC        (Augentix HC1705K, Novatek NT98566, etc.)
 *   col D: default firmware version (e.g. 6_0_13_0)
 *   col E: description
 *
 * Idempotent — upserts by SKU. Re-running keeps existing fields and only
 * updates the imported-from-sheet ones.
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const xlsx = require('xlsx');     // npm i xlsx --save-dev
const ProductModel = require('../models/productModel');

const SHEET_PATH = process.argv[2] || '/home/rahulvadhiya.vmukti/PreData/STQC_APPLIED_SKU.xlsx';

// Infer family + connection types from SKU naming convention.
// AD-90AR**WF**BDP → WiFi (WFBDP family)
// AD-90AI**4G**BDP → 4G   (4GBDP family)
// AD-90NRP*…       → Eth (POE)
// AD-90NRE*…       → Eth (IP)
// AD-90AR…         → AUGEN family, default Eth
function inferFromSku(sku) {
  const u = sku.toUpperCase();
  let family = null;
  let connectionTypes = ['Eth'];
  let macsPerDevice = 1;

  if (u.includes('WF') || u.includes('WIFI')) {
    family = 'WFBDP';
    connectionTypes = ['WIFI'];
  } else if (u.includes('4G')) {
    family = '4GBDP';
    connectionTypes = ['4G', 'Eth'];   // 4G modem + Eth fallback / config
    macsPerDevice = 1;                 // primary is Eth MAC; 4G uses module's IMEI not MAC
  } else if (u.includes('AR') || u.includes('AUGEN')) {
    family = 'AUGEN';
  } else if (u.includes('SECOS')) {
    family = 'SECOS';
  } else if (u.includes('NR')) {
    // Novatek family — POE / Ethernet IP cameras
    family = 'AUGEN';   // not strictly a family code; admin can fix later
    connectionTypes = ['Eth'];
  }
  return { family, connectionTypes, macsPerDevice };
}

async function main() {
  if (!fs.existsSync(SHEET_PATH)) {
    console.error(`✗ sheet not found: ${SHEET_PATH}`);
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('✗ MONGO_URI not set in .env'); process.exit(1); }

  console.log(`[import-skus] reading ${SHEET_PATH}`);
  const wb = xlsx.readFile(SHEET_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null });
  console.log(`[import-skus] ${rows.length} rows in sheet`);

  console.log(`[import-skus] connecting to mongo: ${uri.replace(/\/\/[^@]+@/, '//***@')}`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    if (!row || row.length === 0) { skipped++; continue; }
    const [_serial, skuRaw, soc, defaultFirmware, description] = row;
    if (!skuRaw || typeof skuRaw !== 'string') { skipped++; continue; }
    const sku = skuRaw.trim().toUpperCase();
    if (!/^AD-/.test(sku)) { skipped++; continue; }

    const inferred = inferFromSku(sku);
    const fields = {
      sku,
      soc: soc ? String(soc).trim() : null,
      defaultFirmware: defaultFirmware ? String(defaultFirmware).trim() : null,
      description: description ? String(description).trim().replace(/\s+/g, ' ') : null,
      family: inferred.family,
      connectionTypes: inferred.connectionTypes,
      macsPerDevice: inferred.macsPerDevice,
      importedAt: new Date(),
    };

    const existing = await ProductModel.findOne({ sku });
    if (existing) {
      await ProductModel.updateOne({ sku }, { $set: fields });
      updated++;
    } else {
      await ProductModel.create(fields);
      inserted++;
    }
  }

  const total = await ProductModel.countDocuments();
  console.log(``);
  console.log(`[import-skus] ✓ done`);
  console.log(`  inserted: ${inserted}`);
  console.log(`  updated:  ${updated}`);
  console.log(`  skipped:  ${skipped} (empty / non-AD-* rows)`);
  console.log(`  total in product_models: ${total}`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error(`[import-skus] FAILED:`, e.message); process.exit(1); });
