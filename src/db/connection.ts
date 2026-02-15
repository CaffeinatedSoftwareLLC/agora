import { Pool } from 'pg';
import { config } from '../config';

export function createPool(connectionString?: string): Pool {
    return new Pool({
        connectionString: connectionString ?? config.dbUrl,
    });
}
