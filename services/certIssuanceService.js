/*
 * services/certIssuanceService.js
 *
 * Node port of /home/rahul/HSM-Tool/Certificates-Tool/new_certficate.sh.
 *
 * For each device:
 *   1. Generate ECDSA P-256 keypair locally (Node `crypto`).
 *   2. Issue a cert from GCP Certificate Authority Service via the official
 *      @google-cloud/security-private-ca SDK — no shell-out, no gcloud CLI.
 *   3. Read back the cert chain.
 *   4. Compute SHA-256 of the DER cert (the "cert hash" used elsewhere).
 *
 * Auth: relies on Application Default Credentials (ADC). On the platform
 * server the EMS systemd unit runs as root on a GCE VM, so the SDK picks up
 * the GCE compute service account automatically — same auth path as
 * `gcloud privateca certificates create` was using.
 */

const crypto = require('crypto');
const { CertificateAuthorityServiceClient } = require('@google-cloud/security-private-ca');

const PROJECT     = process.env.GCP_PROJECT_ID || 'arcisai-iot-platform';
const REGION      = process.env.GCP_REGION     || 'asia-south1';
const CA_POOL     = process.env.CAS_CA_POOL    || 'arcisai-iot-ca-pool';
const CA_NAME     = process.env.CAS_CA_NAME    || 'arcisai-intermediate-ca-hsm';
const ROOT_CA     = process.env.CAS_ROOT_CA_NAME || 'arcisai-root-ca-hsm';
const VALIDITY_DAYS = parseInt(process.env.CERT_VALIDITY_DAYS, 10) || 1095;

const client = new CertificateAuthorityServiceClient();

function caPoolPath() { return client.caPoolPath(PROJECT, REGION, CA_POOL); }
function caPath(name) { return client.certificateAuthorityPath(PROJECT, REGION, CA_POOL, name); }

/**
 * Issue one device cert. Returns:
 *   { keyPem, certPem, chainPem, certHash, certGcpName,
 *     serialNumber, notBefore, notAfter, fingerprint }
 */
async function issueCertificate(deviceId, opts = {}) {
    const validityDays = opts.validityDays || VALIDITY_DAYS;

    // 1. Local keypair (matches `openssl ecparam -genkey -name prime256v1`)
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // 2. GCP CAS issue — config-based (no CSR; SDK signs the public key with
    //    the subject + extensions we specify). Equivalent to
    //    `gcloud privateca certificates create --csr=... ` minus the CSR step.
    const certId = `${deviceId}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const [certificate] = await client.createCertificate({
        parent: caPoolPath(),
        certificateId: certId,
        certificate: {
            lifetime: { seconds: validityDays * 24 * 3600 },
            config: {
                subjectConfig: {
                    subject: {
                        commonName: `${deviceId}.devices.arcisai.io`,
                        organization: 'Adiance Technologies Private Limited',
                        organizationalUnit: 'IoT Smart Cameras',
                        countryCode: 'IN',
                        province:    'Gujarat',
                        locality:    'Ahmedabad',
                    },
                    subjectAltName: {
                        dnsNames: [`${deviceId}.devices.arcisai.io`],
                        uris:     [`urn:arcisai:device:${deviceId}`],
                    },
                },
                x509Config: {
                    keyUsage: {
                        baseKeyUsage:      { digitalSignature: true, keyEncipherment: true },
                        extendedKeyUsage:  { clientAuth: true, serverAuth: true },
                    },
                    caOptions: { isCa: false },
                },
                publicKey: { format: 'PEM', key: Buffer.from(publicKey) },
            },
        },
        issuingCertificateAuthorityId: CA_NAME,
    });

    const certPem  = certificate.pemCertificate;
    const chainPem = (certificate.pemCertificateChain || []).join('\n');

    // 3. Parse with Node's built-in X509Certificate — handles EC certs
    //    natively (node-forge can't). DER comes free as `.raw`.
    const x509     = new crypto.X509Certificate(certPem);
    const derBytes = x509.raw;
    const certHash = crypto.createHash('sha256').update(derBytes).digest('hex');
    const fingerprint = x509.fingerprint256.toUpperCase(); // already colon-separated

    return {
        keyPem:        privateKey,
        certPem,
        chainPem,
        certHash,
        certGcpName:   certificate.name,
        serialNumber:  x509.serialNumber,
        notBefore:     new Date(x509.validFrom),
        notAfter:      new Date(x509.validTo),
        fingerprint,
    };
}

/**
 * Download the CA chain once per batch (root + intermediate).
 */
async function getCAChain() {
    const [intermediate] = await client.getCertificateAuthority({ name: caPath(CA_NAME) });
    const [root]         = await client.getCertificateAuthority({ name: caPath(ROOT_CA) });
    return {
        intermediatePem: (intermediate.pemCaCertificates || []).join('\n'),
        rootPem:         (root.pemCaCertificates || []).join('\n'),
        chainPem: [
            ...(intermediate.pemCaCertificates || []),
            ...(root.pemCaCertificates || []),
        ].join('\n'),
    };
}

module.exports = { issueCertificate, getCAChain };
