/*
 * routes/v2Routes.js — endpoints for the v2 offline manufacturing station.
 *
 * All routes are gated by stationOrUser middleware (Bearer STATION_API_KEY
 * for the offline station, OR admin cookie for human ops in EMS UI).
 *
 * Mounted at /api/v2 in app.js. v1 routes (/api/provision/*) are NOT touched.
 */

const express = require('express');
const {
    issueCertificate,
    getFirmwarePubkey,
    listFirmwares,
    getFirmwareManifest,
    downloadFirmware,
} = require('../controllers/v2StationController');
const { stationOrUser } = require('../middleware/stationAuth');

const router = express.Router();

router.post('/cert/issue', stationOrUser, issueCertificate);
router.get( '/pubkey',     stationOrUser, getFirmwarePubkey);
router.get( '/firmwares',  stationOrUser, listFirmwares);
router.get( '/firmwares/:version/manifest',       stationOrUser, getFirmwareManifest);
router.get( '/firmwares/:version/file/:filename', stationOrUser, downloadFirmware);

module.exports = router;
