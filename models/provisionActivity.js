const mongoose = require('mongoose');

// provision_activity — append-only burn event log written by stations
// (replaces the station-side `efuse_events` collection). One row per
// significant event during a device's burn lifecycle.
//
// Examples of `type`:
//   reserve / release / burn-start / burn-step / burn-ok / burn-fail /
//   verify-sent / verify-acked / power-cycle / relay-test
//
// Queryable per-station for STQC audit ("show me every burn STATION-AHM-01
// did in March") and per-device ("full timeline for ATPL-900042-SECOS").

const provisionActivitySchema = new mongoose.Schema({
    station:  { type: String, required: true, index: true },
    deviceId: { type: String, index: true },
    batchId:  { type: String, index: true },
    slot:     { type: Number },
    type:     { type: String, required: true, index: true },
    message:  { type: String },
    payload:  { type: mongoose.Schema.Types.Mixed },     // free-form details
    operator: { type: String },                          // user email if known
    ts:       { type: Date, default: Date.now, index: true },
}, { timestamps: false });

// Compound index for the most common audit query
provisionActivitySchema.index({ station: 1, ts: -1 });

module.exports = mongoose.model('ProvisionActivity', provisionActivitySchema, 'provision_activity');
