# Cricket Match Simulation Backend

Node.js backend that replaces Cloudflare Durable Objects + Workers for cricket match simulation.

## Architecture

```
Flutter App
   ↓
Node.js Backend
   ├── WebSocket Server (Socket.IO)
   ├── Match Engine (simulation loop)
   ├── Tournament Scheduler (node-cron)
   ↓
Redis (state + pub/sub)
   ↓
Supabase (auth + DB)
   ↓
Cloudflare AI (optional, for commentary)
```

## Features

- ✅ Real-time match simulation (ball-by-ball)
- ✅ WebSocket rooms for live updates
- ✅ Redis state management
- ✅ AI commentary (Cloudflare AI + caching)
- ✅ Tournament scheduler
- ✅ Rate limiting & security
- ✅ Graceful shutdown

## Installation

```bash
cd node-backend
npm install
```

## Configuration

Create `.env` file:

```env
PORT=3000
REDIS_URL=redis://localhost:6379
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
CLOUDFLARE_AI_WORKER_URL=https://cricket-match-simulator.arghyachowdhury2610.workers.dev
NODE_ENV=development
CORS_ORIGIN=*
```

## Running

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

## API Endpoints

### Start Match
```http
POST /api/match/start
Content-Type: application/json

{
  "matchId": "uuid",
  "config": {
    "homeXI": [...],
    "awayXI": [...],
    "homeChemistry": 50,
    "awayChemistry": 50,
    "maxOvers": 20,
    "pitchCondition": "balanced",
    "homeTeamName": "Team A",
    "awayTeamName": "Team B",
    "homeBatsFirst": true,
    "useAICommentary": true
  }
}
```

### Stop Match
```http
POST /api/match/stop
Content-Type: application/json

{
  "matchId": "uuid"
}
```

### Get Match State
```http
GET /api/match/:matchId
```

### Get Active Matches
```http
GET /api/match/active/list
```

### Health Check
```http
GET /health
```

## WebSocket Events

### Client → Server

```javascript
// Join match room
socket.emit('joinMatch', matchId);

// Leave match room
socket.emit('leaveMatch', matchId);
```

### Server → Client

```javascript
// Ball update
socket.on('ballUpdate', (data) => {
  // data.result - ball outcome
  // data.state - current match state
  // data.commentaryLog - last 20 balls
});

// Match complete
socket.on('matchComplete', (data) => {
  // data.result - match result string
  // data.state - final match state
});

// Joined confirmation
socket.on('joined', (data) => {
  // data.matchId
});
```

## Flutter Integration

### Install Socket.IO Client

```yaml
dependencies:
  socket_io_client: ^2.0.3+1
```

### Connect to Backend

```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

final socket = IO.io(
  'http://your-server:3000',
  IO.OptionBuilder()
    .setTransports(['websocket'])
    .disableAutoConnect()
    .build(),
);

socket.connect();

socket.on('connect', (_) {
  print('Connected to backend');
  socket.emit('joinMatch', matchId);
});

socket.on('ballUpdate', (data) {
  print('Ball update: $data');
  // Update UI
});

socket.on('matchComplete', (data) {
  print('Match complete: ${data['result']}');
  // Navigate to result screen
});

socket.on('disconnect', (_) {
  print('Disconnected');
});
```

### Start Match via HTTP

```dart
final response = await http.post(
  Uri.parse('http://your-server:3000/api/match/start'),
  headers: {'Content-Type': 'application/json'},
  body: jsonEncode({
    'matchId': matchId,
    'config': {
      'homeXI': homeXI,
      'awayXI': awayXI,
      'homeChemistry': 50,
      'awayChemistry': 50,
      'maxOvers': 20,
      'pitchCondition': 'balanced',
      'homeTeamName': 'Team A',
      'awayTeamName': 'Team B',
      'homeBatsFirst': true,
      'useAICommentary': true,
    },
  }),
);
```

## Redis Setup

### Install Redis

**Windows:**
```bash
# Using WSL
wsl --install
sudo apt update
sudo apt install redis-server
sudo service redis-server start
```

**macOS:**
```bash
brew install redis
brew services start redis
```

**Linux:**
```bash
sudo apt install redis-server
sudo systemctl start redis
```

### Test Redis
```bash
redis-cli ping
# Should return: PONG
```

## Deployment

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "app.js"]
```

### Docker Compose

```yaml
version: '3.8'
services:
  backend:
    build: .
    ports:
      - "3000:3000"
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
  
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

## Migration from Cloudflare

### Step 1: Parallel Run
- Keep Cloudflare running
- Deploy Node backend
- Test with new matches

### Step 2: Switch Simulation API
- Update Flutter app to use Node backend URL
- Keep WebSocket on Cloudflare initially

### Step 3: Switch WebSockets
- Update Flutter to use Socket.IO
- Remove Supabase realtime subscriptions

### Step 4: Remove Cloudflare
- Stop Cloudflare Worker
- Keep Cloudflare AI (optional)

## Performance

- **Match simulation**: 1 ball per second
- **WebSocket latency**: <50ms
- **Redis operations**: <5ms
- **AI commentary**: Cached (instant for repeated situations)

## Monitoring

```bash
# Check active matches
curl http://localhost:3000/api/match/active/list

# Health check
curl http://localhost:3000/health
```

## Troubleshooting

### Redis Connection Failed
```bash
# Check Redis is running
redis-cli ping

# Check Redis URL in .env
REDIS_URL=redis://localhost:6379
```

### WebSocket Not Connecting
- Check CORS settings
- Verify port is open
- Check firewall rules

### Match Not Starting
- Check logs: `npm start`
- Verify config format
- Check Redis connection

## License

MIT
