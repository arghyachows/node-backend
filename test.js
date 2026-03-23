const axios = require('axios');
const IO = require('socket.io-client');

const BASE_URL = 'http://localhost:3000';
const matchId = `test-${Date.now()}`;

console.log('🧪 Testing Cricket Backend\n');

async function testHealthCheck() {
  console.log('1️⃣ Testing health check...');
  try {
    const response = await axios.get(`${BASE_URL}/health`);
    console.log('✅ Health check passed:', response.data);
  } catch (error) {
    console.log('❌ Health check failed:', error.message);
    process.exit(1);
  }
}

async function testWebSocket() {
  console.log('\n2️⃣ Testing WebSocket connection...');
  
  return new Promise((resolve, reject) => {
    const socket = IO.io(BASE_URL, {
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      console.log('✅ WebSocket connected');
      
      socket.emit('joinMatch', matchId);
      
      socket.on('joined', (data) => {
        console.log('✅ Joined match room:', data.matchId);
        socket.disconnect();
        resolve();
      });
    });

    socket.on('connect_error', (error) => {
      console.log('❌ WebSocket connection failed:', error.message);
      reject(error);
    });

    setTimeout(() => {
      reject(new Error('WebSocket timeout'));
    }, 5000);
  });
}

async function testStartMatch() {
  console.log('\n3️⃣ Testing match start...');
  
  const config = {
    homeXI: generateTeam('Home'),
    awayXI: generateTeam('Away'),
    homeChemistry: 50,
    awayChemistry: 50,
    maxOvers: 2, // Short match for testing
    pitchCondition: 'balanced',
    homeTeamName: 'Test Home',
    awayTeamName: 'Test Away',
    homeBatsFirst: true,
    useAICommentary: false, // Disable for testing
  };

  try {
    const response = await axios.post(`${BASE_URL}/api/match/start`, {
      matchId,
      config,
    });
    console.log('✅ Match started:', response.data);
  } catch (error) {
    console.log('❌ Match start failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

async function testGetMatchState() {
  console.log('\n4️⃣ Testing get match state...');
  
  // Wait a bit for match to progress
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  try {
    const response = await axios.get(`${BASE_URL}/api/match/${matchId}`);
    console.log('✅ Match state retrieved');
    console.log('   Score:', `${response.data.state.score1}/${response.data.state.wickets1} vs ${response.data.state.score2}/${response.data.state.wickets2}`);
    console.log('   Innings:', response.data.state.innings);
    console.log('   Over:', `${response.data.state.overNumber}.${response.data.state.ballNumber}`);
  } catch (error) {
    console.log('❌ Get match state failed:', error.response?.data || error.message);
  }
}

async function testStopMatch() {
  console.log('\n5️⃣ Testing match stop...');
  
  try {
    const response = await axios.post(`${BASE_URL}/api/match/stop`, {
      matchId,
    });
    console.log('✅ Match stopped:', response.data);
  } catch (error) {
    console.log('❌ Match stop failed:', error.response?.data || error.message);
  }
}

async function testActiveMatches() {
  console.log('\n6️⃣ Testing active matches list...');
  
  try {
    const response = await axios.get(`${BASE_URL}/api/match/active/list`);
    console.log('✅ Active matches:', response.data);
  } catch (error) {
    console.log('❌ Active matches failed:', error.response?.data || error.message);
  }
}

function generateTeam(name) {
  const roles = ['batsman', 'batsman', 'batsman', 'batsman', 'wicket_keeper', 'all_rounder', 'all_rounder', 'bowler', 'bowler', 'bowler', 'bowler'];
  const names = ['A. Smith', 'B. Kumar', 'C. Williams', 'D. Sharma', 'E. Jones', 'F. Singh', 'G. Taylor', 'H. Patel', 'I. Anderson', 'J. Khan', 'K. Brown'];
  
  return roles.map((role, i) => {
    const batting = role === 'bowler' ? 35 : role === 'all_rounder' ? 55 : 65;
    const bowling = role === 'batsman' ? 25 : role === 'all_rounder' ? 55 : 70;
    
    return {
      userCardId: `${name}-${i}`,
      name: `${name} ${names[i]}`,
      role,
      batting,
      bowling,
      fielding: 50,
      aggression: batting,
      technique: batting,
      power: batting,
      consistency: batting,
      pace: bowling,
      swing: bowling,
      accuracy: bowling,
      variations: bowling,
    };
  });
}

async function runTests() {
  try {
    await testHealthCheck();
    await testWebSocket();
    await testStartMatch();
    await testGetMatchState();
    await testStopMatch();
    await testActiveMatches();
    
    console.log('\n✅ All tests passed!\n');
    process.exit(0);
  } catch (error) {
    console.log('\n❌ Tests failed:', error.message);
    process.exit(1);
  }
}

runTests();
