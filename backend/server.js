import http from 'http';
import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import Database from 'better-sqlite3';
import bcryptjs from 'bcryptjs';
import { createJSONToken, isValidPassword, validateJSONToken } from './utils/auth.js';
import { nanoid } from 'nanoid';
import cors from 'cors';

const SESSION_COOKIE_NAME = 'session_id';
const db = new Database('chat.db');

const sessions = {}; // TODO move it to DB

const corsMiddleware = cors({
    origin: 'http://localhost:3000',
    credentials: true,
});

const server = http.createServer((req, res) => {
    // Apply CORS middleware to handle preflight requests
    corsMiddleware(req, res, () => {
        if (req.method === 'POST' && req.url === '/signup') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });

            req.on('end', async () => {
                try {
                    const { username, password, repeatPassword } = JSON.parse(body);
                    const getQuery = db.prepare('SELECT * FROM users WHERE username = ?');
                    const user = getQuery.get(username);

                    let errors = {};

                    if (user) {
                        errors.username = 'Username already taken!';
                    }

                    if (password.length < 6) {
                        errors.password = 'Password must be at least 6 characters!';
                    }

                    if (password !== repeatPassword) {
                        errors.repeatPassword = 'Repeated password is different!';
                    }

                    
                    if (Object.keys(errors).length > 0) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({errors}));
                        return;
                    }

                    const newUserId = nanoid();
                    const hashedPw = await bcryptjs.hash(password, 12);

                    const createQuery = db.prepare('INSERT INTO users (id, username, password, rank) VALUES (?, ?, ?, ?)');
                    const newUser = createQuery.run(newUserId, username, hashedPw, 'user');

                    const sessionToken = createJSONToken(newUserId, username, false);
                    const sessionId = nanoid();
                    sessions[sessionId] = sessionToken;

                    res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, sessionId, {
                        httpOnly: true,
                        secure: true,
                        sameSite: 'strict',
                        maxAge: 3600,
                    }));

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Singup and logged in successfully' }));
                } catch (error) {
                    console.log('error: ', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid request body' }));
                }
            });
        } else if (req.method === 'POST' && req.url === '/logout') {
            const cookies = cookie.parse(req.headers.cookie || '');
            const sessionId = cookies[SESSION_COOKIE_NAME];
      
            if (sessionId && sessions[sessionId]) {
                delete sessions[sessionId];
      
                // Clear the session cookie
                res.setHeader(
                    'Set-Cookie',
                    cookie.serialize(SESSION_COOKIE_NAME, '', {
                        httpOnly: true,
                        secure: true,
                        sameSite: 'strict',
                        maxAge: 0, // Expire immediately
                    })
                );
      
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Logged out successfully' }));
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No active session' }));
            }
        } else if (req.method === 'POST' && req.url === '/login') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });

            req.on('end', async () => {
                try {
                    const { username, password } = JSON.parse(body);
                    const getQuery = db.prepare('SELECT * FROM users WHERE username = ?');
                    const user = getQuery.get(username);
                    if (!user) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({errors: {
                            username: 'Bad username or password!',
                            password: 'Bad username or password!'
                        }}));
                        return;
                    }

                    const pwIsValid = await isValidPassword(password, user.password);
                    if (!pwIsValid) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({errors: {
                            username: 'Bad username or password!',
                            password: 'Bad username or password!'
                        }}));                        return;
                    }

                    const sessionToken = createJSONToken(user.id, user.username, user.rank === 'admin');
                    const sessionId = nanoid();
                    sessions[sessionId] = sessionToken;

                    res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, sessionId, {
                        httpOnly: true,
                        secure: true,
                        sameSite: 'strict',
                        maxAge: 3600,
                    }));

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Logged in successfully' }));
                } catch (error) {
                    console.log('error: ', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid request body' }));
                }
            });
        } else {
            res.writeHead(404);
            res.end();
        }
    });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionId = cookies[SESSION_COOKIE_NAME];

    if (!sessionId || !sessions[sessionId]) {
        ws.close(401, 'Unauthorized: Invalid session');
        console.error('Connection denied: Invalid session');
        return;
    }

    const sessionToken = sessions[sessionId];
    const decoded = validateJSONToken(sessionToken);

    ws.user = decoded;
    console.log('Connection established with user:', decoded.username);

    // Fetch and send all previous messages to the new client
    try {
        const selectQuery = db.prepare(`
            SELECT
            messages.id,
            messages.message,
            messages.timestamp,
            users.username
            FROM messages
            JOIN users
            ON messages.userId = users.id
            ORDER BY messages.timestamp DESC
            LIMIT 5
        `);
        const previousMessages = selectQuery.all().reverse();
    
        // Send messages as an array or individually to the new client
        previousMessages.forEach((row) => {
            ws.send(JSON.stringify(row));
        });
    } catch (error) {
        console.error('Failed to retrieve messages:', error);
        ws.send('Error retrieving previous messages. Please try again later.');
    }

    ws.on('message', (message) => {
        const newId = nanoid();
        const userId = ws.user.userId;
        const decodedMessage = message.toString('utf8');
        console.log(`Received message from ${userId}:`, decodedMessage);

        try {
            const createQuery = db.prepare('INSERT INTO messages (id, message, userId) VALUES (?, ?, ?)');
            createQuery.run(newId, decodedMessage, userId);
        } catch (error) {
            console.log('error: ', error);
        }

        wss.clients.forEach((client) => {
            if (client.readyState === ws.OPEN) {
                client.send(JSON.stringify({
                    id: newId,
                    message: decodedMessage,
                    username: ws.user.username
                }));
            }
        });
    });
      
    ws.on('close', () => {
        console.log(`Connection closed with user: ${ws.user.username}`);
    });
});

server.listen(8080, () => {
    console.log('Server running on http://localhost:8080');
});
