# Socket.IO Backend Reference Guide

This document covers implementation patterns for WebSocket events, namespaces, rooms, and clustering using **Socket.IO** in the node-backend.

---

## 1. Installation

```bash
npm install socket.io
# Optional for clustering/multiple nodes:
npm install @socket.io/sticky @socket.io/cluster-adapter
```

---

## 2. Basic Server Initialization

```javascript
const http = require('http');
const { Server } = require('socket.io');
const express = require('express');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join a matchmaking room
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  // Emitting events inside a specific room
  socket.on('match_action', (data) => {
    const { roomId, action } = data;
    io.to(roomId).emit('match_update', {
      sender: socket.id,
      action: action,
      time: new Date()
    });
  });

  // Volatile events (High frequency events where only the latest values matter)
  socket.on('ping_state', (data) => {
    socket.volatile.emit('ping_state_response', data);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

httpServer.listen(3000, () => {
  console.log('Socket.IO server running on port 3000');
});
```

---

## 3. Custom Parsers (MessagePack for Binary Efficiency)

Useful for high-frequency multiplayer updates (e.g., real-time cricket run simulation details):

```javascript
const { Server } = require("socket.io");
const customParser = require("socket.io-msgpack-parser");

const io = new Server(httpServer, {
  parser: customParser
});
```

---

## 4. Multi-Node Clustering (Master/Worker Thread Configuration)

To scale Socket.IO servers across multiple CPU cores, use sticky sessions and the cluster adapter:

```javascript
const cluster = require("cluster");
const http = require("http");
const { Server } = require("socket.io");
const numCPUs = require("os").cpus().length;
const { setupMaster, setupWorker } = require("@socket.io/sticky");
const { createAdapter, setupPrimary } = require("@socket.io/cluster-adapter");

if (cluster.isMaster) {
  console.log(`Master process ${process.pid} is running`);
  const httpServer = http.createServer();

  // Setup sticky sessions on Master
  setupMaster(httpServer, {
    loadBalancingMethod: "least-connection",
  });

  setupPrimary();

  cluster.setupMaster({
    serialization: "advanced",
  });

  httpServer.listen(3000);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker) => {
    console.log(`Worker ${worker.process.pid} died. Respawning...`);
    cluster.fork();
  });
} else {
  console.log(`Worker process ${process.pid} started`);
  const httpServer = http.createServer();
  const io = new Server(httpServer);

  // Bind the cluster adapter
  io.adapter(createAdapter());
  setupWorker(io);

  io.on("connection", (socket) => {
    socket.on("message", (msg) => {
      io.emit("message", msg);
    });
  });
}
```
