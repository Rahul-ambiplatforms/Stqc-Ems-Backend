/*
 * controllers/v2StationController.js
 *
 * Endpoints for the v2 offline station — a standalone manufacturing PC that
 * stores everything locally (SQLite) and only reaches out to EMS for the
 * three operations that genuinely need cloud resources:
 *
 *   1. POST /api/v2/cert/issue   — get a GCP CAS-signed device cert
 *   2. GET  /api/v2/pubkey       — fetch the firmware-signing pubkey
 *   3. GET  /api/v2/firmwares    — list available firmware versions
 *
 * Auth: same STATION_API_KEY Bearer token v1 station already uses
 * (stationOrUser middleware). v2 station should send:
 *
 *     Authorization: Bearer <STATION_API_KEY>
 *
 * NOTE: v1 controllers and routes are NOT touched. This controller is
 * isolated so v2 evolution doesn't risk breaking v1 production.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const certIssuance = require('../services/certIssuanceService');

const PUBKEY_DIR = process.env.PUBKEY_DIR
    || '/home/rahul/HSM-Tool/Sign-Tool/firmware-signing-key-raw-pubkeys';

const FIRMWARE_ROOT = process.env.FIRMWARE_ROOT
    || '/home/rahul/augentix-mqtt/firmware';

// ── POST /api/v2/cert/issue ──────────────────────────────────
// Body: { deviceId, validityDays? }
// Returns: { certPem, keyPem, chainPem, certHash, certSerial, certGcpName,
//            certNotBefore, certNotAfter, fingerprint, issuer, algorithm }
//
// The station passes a deviceId like "ATPL-900001-SECOS"; CSR-equivalent
// subject is built from it. Same code path as v1's batch generation, just
// exposed one-cert-at-a-time so the offline station can call it during
// its local batch creation flow.
exports.issueCertificate = catchAsyncErrors(async (req, res) => {
    const { deviceId, validityDays } = req.body || {};
    if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ ok: false, message: 'deviceId is required' });
    }
    if (!/^ATPL-\d{6}-(SECOS|AUGEN|4GBDP|WFBDP)$/.test(deviceId)) {
        return res.status(400).json({
            ok: false,
            message: `deviceId '${deviceId}' must match ATPL-NNNNNN-FAMILY`,
        });
    }

    try {
        const cert = await certIssuance.issueCertificate(deviceId, { validityDays });
        res.json({
            ok: true,
            deviceId,
            certPem:        cert.certPem,
            keyPem:         cert.keyPem,
            chainPem:       cert.chainPem,
            certHash:       cert.certHash,
            certSerial:     cert.serialNumber,
            certGcpName:    cert.certGcpName,
            certNotBefore:  cert.notBefore,
            certNotAfter:   cert.notAfter,
            fingerprint:    cert.fingerprint,
            issuer:         process.env.CAS_CA_NAME || 'arcisai-intermediate-ca-hsm',
            algorithm:      'EC_SIGN_P256_SHA256',
        });
    } catch (e) {
        return res.status(502).json({
            ok: false,
            message: `cert issuance failed: ${e.message}`,
        });
    }
});

// ── GET /api/v2/pubkey ───────────────────────────────────────
// Returns the firmware-signing-key-raw pubkey in every format the v2 station
// might need. Avoids station having to re-export from KMS or carry copies.
exports.getFirmwarePubkey = catchAsyncErrors(async (req, res) => {
    if (!fs.existsSync(PUBKEY_DIR)) {
        return res.status(500).json({
            ok: false,
            message: `PUBKEY_DIR not found: ${PUBKEY_DIR}`,
        });
    }
    const v = process.env.KMS_FIRMWARE_KEY_VERSION || '1';
    const read = (name) => {
        const p = path.join(PUBKEY_DIR, name);
        return fs.existsSync(p) ? fs.readFileSync(p) : null;
    };
    const readText = (name) => {
        const b = read(name);
        return b ? b.toString('utf8').trim() : null;
    };

    const pem = readText(`pubkey_v${v}.pem`);
    const der = read(`pubkey_v${v}.der`);
    const modBin = read(`pubkey_modulus_v${v}.bin`);
    const modHex = readText(`pubkey_modulus_v${v}.hex`);
    const rotpkBin = read(`rotpk_v${v}.bin`);
    const rotpkHex = readText(`rotpk_v${v}.txt`);
    const ubootDtb = read(`u-boot_pubkey_v${v}.dtb`);
    const ubootDts = readText(`u-boot_pubkey_v${v}.dts`);

    const sha256OfDer = der ? crypto.createHash('sha256').update(der).digest('hex') : null;

    res.json({
        ok: true,
        version: v,
        keyName: process.env.KMS_FIRMWARE_KEY || 'firmware-signing-key-raw',
        algorithm: 'RSA-2048-SHA256-PKCS1v15',
        pem,
        der_b64:        der      ? der.toString('base64')      : null,
        modulus_b64:    modBin   ? modBin.toString('base64')   : null,
        modulus_hex:    modHex,
        rotpk_b64:      rotpkBin ? rotpkBin.toString('base64') : null,
        rotpk_sha224:   rotpkHex,
        sha256_of_der:  sha256OfDer,
        uboot_dtb_b64:  ubootDtb ? ubootDtb.toString('base64') : null,
        uboot_dts:      ubootDts,
    });
});

// ── GET /api/v2/firmwares ────────────────────────────────────
// Lists firmware versions available under FIRMWARE_ROOT — same data shape
// as v1's /api/provision/firmwares, but exposed under v2 namespace so
// station auth can call it without conflicting with v1's admin-cookie auth.
exports.listFirmwares = catchAsyncErrors(async (req, res) => {
    if (!fs.existsSync(FIRMWARE_ROOT)) {
        return res.json({ ok: true, firmwareRoot: FIRMWARE_ROOT, firmwares: [] });
    }
    const entries = fs.readdirSync(FIRMWARE_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
            const dir = path.join(FIRMWARE_ROOT, e.name);
            const files = fs.readdirSync(dir).filter((f) => f.endsWith('.rom') || f.endsWith('.bin'));
            return { version: e.name, files };
        })
        .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

    res.json({ ok: true, firmwareRoot: FIRMWARE_ROOT, firmwares: entries });
});

// ── GET /api/v2/firmwares/:version/manifest ──────────────────
// Returns the JSON manifest for a firmware version. The v2 station
// downloads this at batch creation so the operator's batch_output dir
// is self-contained for offline burning.
exports.getFirmwareManifest = catchAsyncErrors(async (req, res) => {
    const version = req.params.version;
    if (!/^[a-zA-Z0-9._-]+$/.test(version)) {
        return res.status(400).json({ ok: false, message: 'invalid version' });
    }
    const manifestPath = path.join(FIRMWARE_ROOT, version, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        return res.status(404).json({ ok: false, message: `manifest.json not found for ${version}` });
    }
    res.sendFile(manifestPath);
});

// ── GET /api/v2/firmwares/:version/file/:filename ────────────
// Streams a single firmware file (.rom / .bin) to the station. Path
// traversal blocked via regex + path.resolve check. Restricted to
// .rom/.bin extensions so this can't be repurposed to disclose other
// files in FIRMWARE_ROOT.
exports.downloadFirmware = catchAsyncErrors(async (req, res) => {
    const { version, filename } = req.params;
    if (!/^[a-zA-Z0-9._-]+$/.test(version)) {
        return res.status(400).json({ ok: false, message: 'invalid version' });
    }
    if (!/^[a-zA-Z0-9._-]+\.(rom|bin)$/.test(filename)) {
        return res.status(400).json({ ok: false, message: 'filename must end in .rom or .bin' });
    }
    const filePath = path.join(FIRMWARE_ROOT, version, filename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(FIRMWARE_ROOT) + path.sep)) {
        return res.status(400).json({ ok: false, message: 'path traversal blocked' });
    }
    if (!fs.existsSync(resolved)) {
        return res.status(404).json({ ok: false, message: `${filename} not found in ${version}` });
    }
    res.download(resolved, filename);
});
