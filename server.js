// Team Goals & Performance CRM — entry point.
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { initDb } = require('./src/db');
const { authRouter, requireAuth } = require('./src/auth');
const apiRouter = require('./src/routes');

const db = initDb();
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Public auth endpoints, then everything else behind auth.
app.use('/api', authRouter(db));
app.use('/api', requireAuth(db), apiRouter(db));

// 404 for unknown API routes (before static fallback)
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// JSON error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Team Goals CRM running on http://localhost:${PORT}`));
