const mongoose = require('mongoose');

// productModel — Adiance product catalog. Drives the Create-Batch form's
// SKU dropdown + decides which MAC types to allocate per device.
// Sourced from /home/rahulvadhiya.vmukti/PreData/STQC_APPLIED_SKU.xlsx
// via scripts/import-product-models.js.

const productModelSchema = new mongoose.Schema({
  // Product code, e.g. "AD-90ARWFBDP"
  sku: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
  },
  // SoC / chipset family — informational, drives which firmware can run
  soc: { type: String, default: null },           // e.g. "Augentix HC1705K", "Novatek NT98566"
  // Default firmware version for this SKU (override at batch creation OK)
  defaultFirmware: { type: String, default: null }, // e.g. "6_0_13_0"
  // Human-readable description from the SKU sheet
  description: { type: String, default: null },
  // Product family — the 5-char suffix used in device IDs (ATPL-NNNNNN-FAMILY).
  // Inferred from SKU name on import: SECOS / AUGEN / 4GBDP / WFBDP.
  family: {
    type: String,
    enum: ['SECOS', 'AUGEN', '4GBDP', 'WFBDP', null],
    default: null,
  },
  // Connection types this product supports. The Create-Batch form lets the
  // operator pick one — that decides which MAC type the allocator pulls.
  // Inferred from SKU name on import; admin can edit later.
  connectionTypes: {
    type: [{ type: String, enum: ['Eth', 'WIFI', '4G'] }],
    default: ['Eth'],
  },
  // How many MACs this product needs per device. Most cameras = 1 (one
  // primary interface). 4G models may need 2 (4G modem + Eth fallback).
  macsPerDevice: { type: Number, default: 1, min: 1, max: 4 },
  // Active in catalog? Allow soft-deprecation without losing history.
  active: { type: Boolean, default: true },
  // Provenance
  importedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('ProductModel', productModelSchema, 'product_models');
