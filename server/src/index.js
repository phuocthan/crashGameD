import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, Settings } from './db.js';
import { FairChain } from './fair.js';
import { GameEngine } from './game.js';
import { Hub } from './hub.js';
import { createApi } from './api.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 3001);
const DB_FILE = process.env.DB_FILE || join(root, 'data', 'nova-rush.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const db = openDb(DB_FILE);
const settings = new Settings(db);
const fair = new FairChain(db);
const engine = new GameEngine({ db, settings, fair });

const app = express();
const server = createServer(app);
const hub = new Hub({ server, db, engine, settings });

app.use('/api', createApi({ db, settings, fair, engine, hub, adminPassword: ADMIN_PASSWORD }));
app.use('/admin', express.static(join(root, 'public', 'admin'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// Serve the built PixiJS client in production (`npm run build` at repo root).
const clientDist = join(dirname(root), 'client', 'dist');
if (existsSync(clientDist)) app.use(express.static(clientDist));

engine.start();
server.listen(PORT, () => {
  console.log(`Nova Rush server on http://localhost:${PORT}`);
  console.log(`  admin:  http://localhost:${PORT}/admin   (password from ADMIN_PASSWORD, default "admin123")`);
  if (existsSync(clientDist)) console.log(`  game:   http://localhost:${PORT}/`);
});

const shutdown = () => {
  engine.stop();
  hub.close();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
