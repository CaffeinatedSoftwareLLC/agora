import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * A software passkey for tests: an ES256 key pair that answers WebAuthn
 * registration ("none" attestation) and authentication requests the way a browser
 * plus platform authenticator would, so the server's real @simplewebauthn/server
 * verification runs end to end. Test-only; the product never builds these.
 */

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface SoftPasskeyOptions {
    origin: string;
    /** Report user verification (PIN/biometric). Default true. */
    userVerified?: boolean;
    /** Synced passkey (backup eligible + backed up). Default true. */
    backedUp?: boolean;
}

export class SoftPasskey {
    readonly credentialId = randomBytes(32);
    private readonly privateKey: KeyObject;
    private readonly publicJwk: { x: string; y: string };
    counter = 0;
    userHandle: string | null = null;

    constructor(readonly opts: SoftPasskeyOptions) {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        this.privateKey = privateKey;
        const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
        this.publicJwk = { x: jwk.x, y: jwk.y };
    }

    get id(): string { return b64url(this.credentialId); }

    private flags(extra = 0): number {
        let f = FLAG_UP | extra;
        if (this.opts.userVerified !== false) f |= FLAG_UV;
        if (this.opts.backedUp !== false) f |= FLAG_BE | FLAG_BS;
        return f;
    }

    private authData(rpID: string, flags: number, attested?: Buffer): Buffer {
        const count = Buffer.alloc(4);
        count.writeUInt32BE(this.counter);
        return Buffer.concat([sha256(rpID), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
    }

    private clientData(type: string, challenge: string, origin = this.opts.origin): Buffer {
        return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    }

    /** navigator.credentials.create() for the given server options. */
    register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, overrides: { origin?: string; rpID?: string } = {}) {
        const rpID = overrides.rpID ?? options.rp.id!;
        this.userHandle = options.user.id;
        const coseKey = new Map<number, number | Uint8Array>([
            [1, 2],   // kty: EC2
            [3, -7],  // alg: ES256
            [-1, 1],  // crv: P-256
            [-2, Buffer.from(this.publicJwk.x, 'base64url')],
            [-3, Buffer.from(this.publicJwk.y, 'base64url')],
        ]);
        const idLen = Buffer.alloc(2);
        idLen.writeUInt16BE(this.credentialId.length);
        const attested = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, Buffer.from(isoCBOR.encode(coseKey as any))]);
        const authData = this.authData(rpID, this.flags(FLAG_AT), attested);
        const attestationObject = isoCBOR.encode(new Map<string, unknown>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData],
        ]) as any);
        return {
            id: this.id,
            rawId: this.id,
            type: 'public-key',
            clientExtensionResults: {},
            response: {
                clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, overrides.origin)),
                attestationObject: b64url(attestationObject),
                transports: ['internal'],
            },
        };
    }

    /** navigator.credentials.get() for the given server options. */
    authenticate(options: { challenge: string; rpId?: string }, overrides: { origin?: string; counter?: number; userHandle?: string | null } = {}) {
        this.counter = overrides.counter ?? this.counter + 1;
        const authData = this.authData(options.rpId!, this.flags());
        const clientDataJSON = this.clientData('webauthn.get', options.challenge, overrides.origin);
        const signer = createSign('SHA256');
        signer.update(Buffer.concat([authData, sha256(clientDataJSON)]));
        const signature = signer.sign(this.privateKey);
        const userHandle = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
        return {
            id: this.id,
            rawId: this.id,
            type: 'public-key',
            clientExtensionResults: {},
            response: {
                clientDataJSON: b64url(clientDataJSON),
                authenticatorData: b64url(authData),
                signature: b64url(signature),
                ...(userHandle ? { userHandle } : {}),
            },
        };
    }
}
