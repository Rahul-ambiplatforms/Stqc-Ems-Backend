/*
 * controllers/provisioningAdminController.js
 *
 * Admin-only endpoints that feed the EMS Create-Batch UI:
 *   GET  /api/provision/admin/product-models      — SKU dropdown source
 *   GET  /api/provision/admin/macs/stats          — per-type pool counters
 *   POST /api/provision/admin/macs/import         — bulk add MACs (top-up)
 *
 * The bulk-import path is for adding new ranges purchased in the future.
 * The original 1M-row import was done offline via scripts/import-mac-list.js.
 */

const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ProductModel = require('../models/productModel');
const MacPool = require('../models/macPool');
const ProvisionedDevice = require('../models/provisionedDevice');
const ProvisionBatch = require('../models/provisionBatch');

// ── GET /api/provision/admin/product-models ───────────────────────────
exports.listProductModels = catchAsyncErrors(async (req, res) => {
    // Only show active SKUs in the dropdown by default; pass ?includeInactive=1 to see all.
    const filter = req.query.includeInactive === '1' ? {} : { active: true };
    const models = await ProductModel.find(filter)
        .sort({ sku: 1 })
        .select('sku description family connectionTypes macsPerDevice soc defaultFirmware active')
        .lean();
    res.json({ models, count: models.length });
});

// ── GET /api/provision/admin/macs/stats ───────────────────────────────
// Returns counts grouped by (status, type). Used for the live counter
// next to the Connection Type radio.
exports.getMacStats = catchAsyncErrors(async (req, res) => {
    const agg = await MacPool.aggregate([
        { $group: { _id: { status: '$status', type: '$type' }, count: { $sum: 1 } } },
    ]);

    // Reshape to { Eth: { available: N, assigned: M, burned: K }, WIFI: {...}, 4G: {...}, null: {...} }
    const byType = { Eth: {}, WIFI: {}, '4G': {}, null: {} };
    let total = 0;
    for (const row of agg) {
        const t = row._id.type === null ? 'null' : row._id.type;
        const s = row._id.status;
        if (!byType[t]) byType[t] = {};
        byType[t][s] = (byType[t][s] || 0) + row.count;
        total += row.count;
    }
    res.json({ total, byType });
});

// ── POST /api/provision/admin/macs/import ─────────────────────────────
// Body: { macs: [ { mac: "80:77:86:...", type: "Eth"|"WIFI"|"4G" }, ... ], batchTag?: "..." }
// Idempotent — upserts by normalized mac.
exports.importMacs = catchAsyncErrors(async (req, res) => {
    const { macs, batchTag } = req.body;
    if (!Array.isArray(macs) || !macs.length) {
        return res.status(400).json({ success: false, message: 'macs[] required (non-empty)' });
    }
    if (macs.length > 100000) {
        return res.status(400).json({
            success: false,
            message: 'macs[] capped at 100k per request — split into batches',
        });
    }
    const tag = batchTag || `api-${new Date().toISOString().slice(0, 10)}-${req.user?.email || 'unknown'}`;
    const importedBy = `api:${req.user?.email || 'unknown'}`;

    let malformed = 0;
    const ops = [];
    for (const entry of macs) {
        const raw = entry?.mac;
        if (!raw) { malformed++; continue; }
        const cleaned = String(raw).trim().replace(/[:\-\s.]/g, '').toUpperCase();
        if (!/^[0-9A-F]{12}$/.test(cleaned)) { malformed++; continue; }
        const type = ['Eth', 'WIFI', '4G'].includes(entry.type) ? entry.type : null;

        ops.push({
            updateOne: {
                filter: { mac: cleaned },
                update: {
                    $set: {
                        oui: cleaned.slice(0, 6),
                        type,
                        importBatch: tag,
                        importedAt: new Date(),
                        importedBy,
                    },
                    // Don't clobber status/deviceId on existing rows — only set on insert
                    $setOnInsert: { mac: cleaned, status: 'available' },
                },
                upsert: true,
            },
        });
    }

    if (!ops.length) {
        return res.status(400).json({ success: false, message: `All ${macs.length} entries malformed`, malformed });
    }

    const r = await MacPool.bulkWrite(ops, { ordered: false });
    res.json({
        ok: true,
        submitted: macs.length,
        malformed,
        upserted: r.upsertedCount || 0,
        modified: r.modifiedCount || 0,
        importBatch: tag,
    });
});

// ── GET /api/provision/admin/devices?q=&limit=50 ──────────────────────
// Cross-batch device search. Matches:
//   - deviceId (prefix or contains, case-insensitive)
//   - certHash (case-insensitive)
//   - certSerial (case-insensitive)
//   - metadata.macAddress (colon-formatted or normalized hex — both work)
//
// Returns up to `limit` devices with their parent batch's IWON for context.
exports.searchDevices = catchAsyncErrors(async (req, res) => {
    const qRaw = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    if (!qRaw) {
        return res.json({ devices: [], count: 0, query: '' });
    }

    // Build a permissive query — try every reasonable interpretation of qRaw.
    // Operator might paste a colon-formatted MAC, a fingerprint, an IWON, etc.
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const q = escape(qRaw);
    const macHexCandidate = qRaw.replace(/[:\-\s.]/g, '').toUpperCase();

    const or = [
        { deviceId:                { $regex: q, $options: 'i' } },
        { certHash:                { $regex: `^${q}`, $options: 'i' } },
        { certSerial:              { $regex: `^${q}`, $options: 'i' } },
        { 'metadata.macAddress':   { $regex: q, $options: 'i' } },
    ];
    if (/^[0-9A-F]{6,12}$/i.test(macHexCandidate)) {
        or.push({ 'metadata.macAddress': { $regex: macHexCandidate, $options: 'i' } });
    }

    const devices = await ProvisionedDevice.find({ $or: or })
        .sort('-updatedAt')
        .limit(limit)
        .lean();

    // Attach parent batch metadata (productModel, family, firmwareVersion, status)
    // for context — operator wants to see "which batch did this device come from".
    const batchIds = [...new Set(devices.map((d) => d.batchId).filter(Boolean))];
    const batches = batchIds.length
        ? await ProvisionBatch.find({ batchId: { $in: batchIds } })
            .select('batchId productModel family firmwareVersion status connectionType').lean()
        : [];
    const byBatch = Object.fromEntries(batches.map((b) => [b.batchId, b]));
    const enriched = devices.map((d) => ({ ...d, batch: byBatch[d.batchId] || null }));

    res.json({ devices: enriched, count: enriched.length, query: qRaw, limit });
});

// ── GET /api/provision/admin/activity?limit=50 ────────────────────────
// Recent events feed — derived from existing data, no new collection.
// Combines:
//   - ProvisionBatch.createdAt   → "batch created"
//   - ProvisionBatch.generatedAt → "batch ready"
//   - ProvisionBatch.firstDownloadedAt → "batch downloaded"
//   - ProvisionedDevice.verifiedAt → "device verified"
//   - ProvisionedDevice updates with status='failed' → "device failed"
//
// Sorted by event time descending. Frontend renders in a header dropdown.
exports.getActivityFeed = catchAsyncErrors(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const horizon = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30); // last 30 days

    const events = [];

    // Batches — created, ready, downloaded
    const batches = await ProvisionBatch.find({
        $or: [
            { createdAt:        { $gte: horizon } },
            { generatedAt:      { $gte: horizon } },
            { firstDownloadedAt:{ $gte: horizon } },
        ],
    }).sort('-createdAt').limit(limit * 2).lean();

    for (const b of batches) {
        if (b.createdAt) {
            events.push({
                type: 'batch.created', at: b.createdAt,
                title: `Batch ${b.batchId} created`,
                subtitle: `${b.count} devices · ${b.productModel} · ${b.family}`,
                actor: b.createdBy,
                batchId: b.batchId,
            });
        }
        if (b.generatedAt) {
            events.push({
                type: b.status === 'failed' ? 'batch.failed' : 'batch.ready',
                at: b.generatedAt,
                title: `Batch ${b.batchId} ${b.status === 'failed' ? 'failed' : 'ready'}`,
                subtitle: b.status === 'failed' ? (b.error || 'generation failed').slice(0, 120) : `${b.count} devices generated`,
                batchId: b.batchId,
            });
        }
        if (b.firstDownloadedAt) {
            events.push({
                type: 'batch.downloaded', at: b.firstDownloadedAt,
                title: `Batch ${b.batchId} downloaded`,
                subtitle: `${b.downloadCount || 0} download(s)`,
                batchId: b.batchId,
            });
        }
    }

    // Devices — verified + failed
    const recentDevices = await ProvisionedDevice.find({
        $or: [
            { verifiedAt: { $gte: horizon } },
            { status: 'failed', updatedAt: { $gte: horizon } },
        ],
    }).sort('-updatedAt').limit(limit * 2).select('deviceId batchId status verifiedAt updatedAt metadata').lean();

    for (const d of recentDevices) {
        if (d.status === 'verified' && d.verifiedAt) {
            events.push({
                type: 'device.verified', at: d.verifiedAt,
                title: `Device ${d.deviceId} verified`,
                subtitle: d.metadata?.station ? `at station ${d.metadata.station}` : `batch ${d.batchId}`,
                deviceId: d.deviceId,
                batchId: d.batchId,
            });
        } else if (d.status === 'failed') {
            events.push({
                type: 'device.failed', at: d.updatedAt,
                title: `Device ${d.deviceId} failed`,
                subtitle: d.metadata?.station ? `at station ${d.metadata.station}` : `batch ${d.batchId}`,
                deviceId: d.deviceId,
                batchId: d.batchId,
            });
        }
    }

    events.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ events: events.slice(0, limit), count: events.length });
});
