const mongoose = require('mongoose');

const provisionBatchSchema = new mongoose.Schema({
    batchId: {
        type: String,
        required: true,
        unique: true,
    },
    family: {
        type: String,
        required: true,
        enum: ['SECOS', 'AUGEN', '4GBDP', 'WFBDP'],
    },
    productModel: {
        type: String,
        required: true,
    },
    firmwareVersion: {
        type: String,
        required: true,
    },
    // Operator picks one of the SKU's supported connection types at batch creation;
    // drives which MAC type the allocator pulls from mac_pool.
    connectionType: {
        type: String,
        enum: ['Eth', 'WIFI', '4G'],
        required: true,
    },
    // How many MACs were allocated per device (1 for single-interface SKUs,
    // potentially 2 for 4G+Eth dual-interface in the future).
    macsPerDevice: {
        type: Number,
        default: 1,
        min: 1,
        max: 4,
    },
    firmwarePath: {
        type: String,
    },
    firmwareSha256: {
        type: String,
    },
    count: {
        type: Number,
        required: true,
    },
    startDeviceId: {
        type: String,
        required: true,
        match: [/^ATPL-\d{6}$/, 'Start device ID must match ATPL-NNNNNN'],
    },
    endDeviceId: {
        type: String,
        required: true,
        match: [/^ATPL-\d{6}$/, 'End device ID must match ATPL-NNNNNN'],
    },
    serialStart: {
        type: Number,
        required: true,
    },
    serialEnd: {
        type: Number,
        required: true,
    },
    hsmKeyRef: {
        type: String,
        default: 'arcisai-intermediate-ca-hsm',
    },
    rootCaHash: {
        algorithm: { type: String, default: 'SHA-256-truncated-96' },
        hex: { type: String, required: true },
        words: [{ type: Number }],
    },
    rotpkHex: {
        type: String,
    },
    zipPath: {
        type: String,
    },
    zipSha256: {
        type: String,
    },
    zipSizeBytes: {
        type: Number,
    },
    status: {
        type: String,
        enum: ['allocated', 'generating', 'ready', 'in_progress', 'completed', 'cancelled', 'failed'],
        default: 'allocated',
    },
    error: {
        type: String,
    },
    generatedAt: {
        type: Date,
    },
    firstDownloadedAt: {
        type: Date,
    },
    downloadCount: {
        type: Number,
        default: 0,
    },
    createdBy: {
        type: String,
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('ProvisionBatch', provisionBatchSchema);
