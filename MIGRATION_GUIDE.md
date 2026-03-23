# Migration Guide: Cloudflare → Node.js Backend

## Overview

This guide walks you through migrating from Cloudflare Durable Objects + Workers to a Node.js backend.

## What's Being Replaced

| Cloudflare | Node.js Replacement |
|------------|---------------------|
| Durable Objects | MatchEngine class + Redis |
| Workers API | Express.js REST API |
| Workers AI | Cloudflare AI (keep) + Redis cache |
| WebSocket (implicit) | Socket.IO |
| KV Storage | Redis |
| Cron Triggers | node-cron |

## Migration Steps

### Phase 1: Setup Node Backend (Parallel)

#### 1.1 Install Redis

**Windows (WSL):**
```bash
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

**Test:**
```bash
redis-cli ping  # Should return PONG
```

#### 1.2 Configure Node Backend

```bash
cd node-backend
cp .env.example .env
```

Edit `.env`:
```env
PORT=3000
REDIS_URL=redis://localhost:6379
SUPABASE_URL=https://kollxlzqqgznfiutpqjz.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
CLOUDFLARE_AI_WORKER_URL=https://cricket-match-simulator.arghyachowdhury2610.workers.dev
```

#### 1.3 Start Node Backend

```bash
npm install
npm start
```

Verify:
```bash
curl http://localhost:3000/health
# Should return: {"status":"ok","timestamp":"..."}
```

### Phase 2: Update Flutter App

#### 2.1 Add Socket.IO Dependency

`pubspec.yaml`:
```yaml
dependencies:
  socket_io_client: ^2.0.3+1
```

#### 2.2 Create Node Backend Service

`lib/core/node_backend_service.dart`:
```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:http/http.dart' as http;
import 'dart:convert';

class NodeBackendService {
  static const String baseUrl = 'http://localhost:3000';
  static IO.Socket? _socket;

  static void initSocket() {
    _socket = IO.io(
      baseUrl,
      IO.OptionBuilder()
        .setTransports(['websocket'])
        .disableAutoConnect()
        .build(),
    );

    _socket!.connect();

    _socket!.on('connect', (_) {
      print('✅ Connected to Node backend');
    });

    _socket!.on('disconnect', (_) {
      print('❌ Disconnected from Node backend');
    });
  }

  static void joinMatch(String matchId, Function(dynamic) onBallUpdate, Function(dynamic) onMatchComplete) {
    _socket!.emit('joinMatch', matchId);

    _socket!.on('ballUpdate', onBallUpdate);
    _socket!.on('matchComplete', onMatchComplete);
  }

  static void leaveMatch(String matchId) {
    _socket!.emit('leaveMatch', matchId);
    _socket!.off('ballUpdate');
    _socket!.off('matchComplete');
  }

  static Future<Map<String, dynamic>> startMatch(String matchId, Map<String, dynamic> config) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/match/start'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'matchId': matchId,
        'config': config,
      }),
    );

    return jsonDecode(response.body);
  }

  static Future<Map<String, dynamic>> stopMatch(String matchId) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/match/stop'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'matchId': matchId}),
    );

    return jsonDecode(response.body);
  }

  static Future<Map<String, dynamic>> getMatchState(String matchId) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/match/$matchId'),
    );

    return jsonDecode(response.body);
  }

  static void dispose() {
    _socket?.disconnect();
    _socket?.dispose();
  }
}
```

#### 2.3 Update Match Provider

`lib/providers/match_provider.dart`:
```dart
import 'package:cricket_ultimate_manager/core/node_backend_service.dart';

class MatchProvider extends StateNotifier<AsyncValue<MatchState>> {
  // ... existing code ...

  Future<void> startMatchWithNode() async {
    try {
      state = const AsyncValue.loading();

      // Initialize Socket.IO
      NodeBackendService.initSocket();

      // Join match room
      NodeBackendService.joinMatch(
        _matchId,
        _onBallUpdate,
        _onMatchComplete,
      );

      // Start match
      final config = {
        'homeXI': _homeXI.map((p) => p.toJson()).toList(),
        'awayXI': _awayXI.map((p) => p.toJson()).toList(),
        'homeChemistry': 50,
        'awayChemistry': 50,
        'maxOvers': 20,
        'pitchCondition': 'balanced',
        'homeTeamName': 'Home',
        'awayTeamName': 'Away',
        'homeBatsFirst': true,
        'useAICommentary': true,
      };

      await NodeBackendService.startMatch(_matchId, config);

      state = AsyncValue.data(MatchState.initial());
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  void _onBallUpdate(dynamic data) {
    final result = data['result'];
    final matchState = data['state'];
    final commentaryLog = data['commentaryLog'];

    // Update state
    state = AsyncValue.data(MatchState(
      score1: matchState['score1'],
      wickets1: matchState['wickets1'],
      score2: matchState['score2'],
      wickets2: matchState['wickets2'],
      innings: matchState['innings'],
      overNumber: matchState['overNumber'],
      ballNumber: matchState['ballNumber'],
      commentary: result['commentary'],
      commentaryLog: commentaryLog,
    ));
  }

  void _onMatchComplete(dynamic data) {
    final result = data['result'];
    final matchState = data['state'];

    // Navigate to result screen
    // ...
  }

  @override
  void dispose() {
    NodeBackendService.leaveMatch(_matchId);
    NodeBackendService.dispose();
    super.dispose();
  }
}
```

### Phase 3: Testing

#### 3.1 Test Quick Match

1. Start Node backend: `npm start`
2. Start Flutter app
3. Start a quick match
4. Verify WebSocket connection in logs
5. Verify ball-by-ball updates
6. Verify match completion

#### 3.2 Test Multiplayer Match

1. Start two Flutter instances
2. Create multiplayer match
3. Both clients join via WebSocket
4. Verify both receive updates
5. Verify match completion

### Phase 4: Production Deployment

#### 4.1 Deploy Node Backend

**Option A: VPS (DigitalOcean, AWS EC2)**
```bash
# SSH into server
ssh user@your-server

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Redis
sudo apt install redis-server
sudo systemctl start redis

# Clone repo
git clone your-repo
cd node-backend

# Install dependencies
npm ci --only=production

# Setup PM2
npm install -g pm2
pm2 start app.js --name cricket-backend
pm2 save
pm2 startup
```

**Option B: Docker**
```bash
docker-compose up -d
```

#### 4.2 Update Flutter App URLs

```dart
class NodeBackendService {
  static const String baseUrl = 'https://your-production-server.com';
  // ...
}
```

#### 4.3 Configure Nginx (Optional)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Phase 5: Remove Cloudflare

#### 5.1 Verify Node Backend Stability

- Monitor for 1 week
- Check error logs
- Verify all features work
- Test under load

#### 5.2 Stop Cloudflare Worker

```bash
cd cloudflare-worker
npx wrangler delete cricket-match-simulator
```

#### 5.3 Keep Cloudflare AI (Optional)

You can keep using Cloudflare AI for commentary:
- Node backend calls Cloudflare AI Worker
- Caching reduces API calls
- Fallback to template commentary

## Comparison

### Before (Cloudflare)

```
Flutter → Cloudflare Worker → Durable Object
                ↓
          Supabase (DB)
                ↓
          Workers AI
```

**Pros:**
- Serverless (no server management)
- Global edge network
- Auto-scaling

**Cons:**
- 50 subrequest limit
- Complex debugging
- Vendor lock-in
- Cold starts

### After (Node.js)

```
Flutter → Node.js Backend → Redis
              ↓
        Supabase (DB)
              ↓
        Cloudflare AI (optional)
```

**Pros:**
- No subrequest limits
- Full control
- Easy debugging
- Standard tech stack
- Better performance

**Cons:**
- Server management required
- Need to handle scaling
- Infrastructure costs

## Cost Comparison

### Cloudflare (Free Plan)
- Workers: 100,000 requests/day
- Durable Objects: 1M requests/month
- Workers AI: 10,000 neurons/day
- **Cost:** $0 (with limits)

### Node.js Backend
- VPS (2GB RAM): $12/month (DigitalOcean)
- Redis: Included
- **Cost:** $12/month (unlimited)

## Rollback Plan

If issues occur:

1. Keep Cloudflare code in repo
2. Switch Flutter back to Cloudflare URLs
3. Redeploy Cloudflare Worker
4. Debug Node backend offline

## Support

- Node backend logs: `pm2 logs cricket-backend`
- Redis logs: `sudo journalctl -u redis`
- Check health: `curl http://localhost:3000/health`

## Next Steps

1. ✅ Setup Node backend
2. ✅ Test locally
3. ✅ Update Flutter app
4. ✅ Deploy to production
5. ✅ Monitor for 1 week
6. ✅ Remove Cloudflare

## Questions?

Check README.md for detailed API documentation.
