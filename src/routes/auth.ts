import { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { generateToken } from '../auth/tokens';
import { generateUlid } from '../utils/ulid';

export async function authRoutes(app: FastifyInstance) {
    // POST /auth/register
    app.post('/auth/register', async (request, reply) => {
        const { username, email, password } = request.body as any;

        if (!username || !email || !password) {
            return reply.status(400).send({ error: 'Missing required fields: username, email, password' });
        }

        const db = (app as any).db;
        const id = generateUlid();
        const passwordHash = await hashPassword(password);

        try {
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [id, username, email, passwordHash]
            );
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'Username or email already taken' });
            }
            throw err;
        }

        const token = generateToken({ userId: id }, (app as any).jwtSecret);

        return reply.status(201).send({
            user: { id, username },
            accessToken: token,
        });
    });

    // POST /auth/login
    app.post('/auth/login', async (request, reply) => {
        const { email, password } = request.body as any;
        const db = (app as any).db;

        const result = await db.query(
            'SELECT id, username, password_hash FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return reply.status(401).send({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const valid = await verifyPassword(password, user.password_hash);

        if (!valid) {
            return reply.status(401).send({ error: 'Invalid credentials' });
        }

        const token = generateToken({ userId: user.id }, (app as any).jwtSecret);

        return reply.status(200).send({
            user: { id: user.id, username: user.username },
            accessToken: token,
        });
    });
}
