/*
 * middleware/stationAuth.js
 *
 * Service-to-service auth for EMS endpoints called by the manufacturing
 * station (NOT a human operator's browser). Station sends:
 *
 *   Authorization: Bearer <STATION_API_KEY>
 *
 * If the bearer matches `process.env.STATION_API_KEY`, the request is
 * allowed and `req.user` is populated with a synthetic station identity so
 * downstream handlers don't need a special code path. Otherwise we fall
 * back to the standard cookie-JWT auth so a human admin can still hit
 * the same routes from the EMS UI.
 *
 * Used on:
 *   GET  /api/provision/batch/:id/download
 *   POST /api/provision/verify
 */

const { isAuthenticatedUser } = require('./authMiddleware');

module.exports.stationOrUser = (req, res, next) => {
    const expected = process.env.STATION_API_KEY;
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

    if (expected && token && token === expected) {
        req.user = {
            email: 'station-service@arcisai',
            role:  ['station', 'admin'],
            isStation: true,
            stationId: req.headers['x-station-id'] || 'station-01',
        };
        return next();
    }
    // No (or wrong) station key → fall back to cookie-JWT auth.
    return isAuthenticatedUser(req, res, next);
};
