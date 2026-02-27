import { Client } from 'minio';
import { config } from '../config';

const url = new URL(config.minioEndpoint);

export const minioClient = new Client({
    endPoint: url.hostname,
    port: parseInt(url.port) || 9000,
    useSSL: url.protocol === 'https:',
    accessKey: config.minioRootUser,
    secretKey: config.minioRootPassword,
});

export const BUCKET_NAME = 'agora-files';

export async function ensureBucket(): Promise<void> {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
        await minioClient.makeBucket(BUCKET_NAME);
    }
}
