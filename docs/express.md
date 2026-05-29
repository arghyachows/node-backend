# Express.js backend Reference Guide

This document contains key setup procedures, routing configuration, and security practices for the **node-backend** project.

---

## 1. Installation

```bash
npm install express express-rate-limit helmet cors dotenv winston
```

---

## 2. Basic Server Setup (with security & logging)

```javascript
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Setup Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// Middlewares
app.use(helmet()); // Sets HTTP headers for security
app.use(cors({ origin: '*' })); // Enable CORS
app.use(express.json()); // JSON body parser

// Rate Limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Basic Route
app.get('/health', (req, res) => {
  logger.info('Healthcheck hit');
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// Error handling Middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(port, () => {
  logger.info(`Express server running on port ${port}`);
});
```

---

## 3. Router Configuration

To keep routing organized:

### Routing File (`routes/match.js`)
```javascript
const express = require('express');
const router = express.Router();

router.get('/simulate', (req, res) => {
  res.json({ status: 'Simulation started' });
});

router.post('/scorecard', (req, res) => {
  const { matchId, score } = req.body;
  res.status(201).json({ matchId, score, updated: true });
});

module.exports = router;
```

### Server integration (`app.js`)
```javascript
const matchRouter = require('./routes/match');
app.use('/api/match', matchRouter);
```
