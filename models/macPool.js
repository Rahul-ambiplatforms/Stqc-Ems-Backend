const mongoose = require('mongoose');

// macPool — Adiance's purchased MAC inventory.
// Single source of truth for cross-station MAC allocation.
// Sourced initially from /home/rahulvadhiya.vmukti/PreData/ADIANCE_MAC_LIST.xlsx
// (OUI 80:77:86 + suffix range), subsequent additions via
// POST /api/admin/macs/import.

const macPoolSchema = new mongoose.Schema({
  // Normalized — uppercase hex, no separators (e.g. "807786500000")
  mac: {
    type: String,
    required: true,
    unique: true,
    match: [/^[0-9A-F]{12}$/, 'mac must be 12 uppercase hex chars'],
  },
  // First 3 bytes — useful for stats per OUI
  oui: {
    type: String,
    required: true,
    index: true,
    match: [/^[0-9A-F]{6}$/, 'oui must be 6 uppercase hex chars'],
  },
  // Connection type the MAC is intended for. Pulled from the spreadsheet's
  // "Type" column on import; null for unallocated rows.
  // Allocator filters on this when picking from the pool — a WiFi-only camera
  // won't be assigned an Eth MAC.
  type: {
    type: String,
    enum: ['Eth', 'WIFI', '4G', null],
    default: null,
  },
  status: {
    type: String,
    enum: ['available', 'assigned', 'burned', 'returned'],
    default: 'available',
    index: true,
  },
  // When status='assigned' or 'burned'. Format: ATPL-NNNNNN-FAMILY (or VSPL- legacy)
  deviceId: { type: String, index: true, sparse: true },
  // Batch this MAC was allocated for (IWON)
  iwon: { type: String, index: true, sparse: true },
  assignedAt: { type: Date },
  burnedAt:   { type: Date },
  returnedAt: { type: Date },
  returnReason: { type: String },
  // Provenance — which import batch this row came from
  importBatch: { type: String, index: true },
  importedAt:  { type: Date, default: Date.now },
  importedBy:  { type: String },
}, { timestamps: true });

// Composite index for the most common query: "find an available MAC of type T"
macPoolSchema.index({ status: 1, type: 1 });

module.exports = mongoose.model('MacPool', macPoolSchema, 'mac_pool');
