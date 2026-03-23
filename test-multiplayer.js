const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testMultiplayerEndpoint() {
  console.log('🧪 Testing Multiplayer Match Endpoint...\n');

  // Test 1: Health check
  try {
    console.log('1️⃣ Testing health endpoint...');
    const health = await axios.get(`${BASE_URL}/health`);
    console.log('✅ Health check passed:', health.data);
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    return;
  }

  // Test 2: Start multiplayer match
  try {
    console.log('\n2️⃣ Testing multiplayer match start...');
    const matchId = `test-match-${Date.now()}`;
    const config = {
      homeTeamId: 'test-home-team-id',
      awayTeamId: 'test-away-team-id',
      homeTeamName: 'Test Home Team',
      awayTeamName: 'Test Away Team',
      matchOvers: 5,
      matchFormat: 't20',
      homeBatsFirst: true,
    };

    console.log('📤 Sending request with config:', JSON.stringify(config, null, 2));
    
    const response = await axios.post(`${BASE_URL}/api/multiplayer/start`, {
      matchId,
      config,
    });

    console.log('✅ Match start response:', response.data);
    
    // Test 3: Get match state
    console.log('\n3️⃣ Testing match state retrieval...');
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    const state = await axios.get(`${BASE_URL}/api/multiplayer/${matchId}`);
    console.log('✅ Match state:', JSON.stringify(state.data, null, 2));

    // Test 4: Stop match
    console.log('\n4️⃣ Testing match stop...');
    const stopResponse = await axios.post(`${BASE_URL}/api/multiplayer/stop`, {
      matchId,
    });
    console.log('✅ Match stopped:', stopResponse.data);

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }

  // Test 5: Active matches list
  try {
    console.log('\n5️⃣ Testing active matches list...');
    const activeMatches = await axios.get(`${BASE_URL}/api/multiplayer/active/list`);
    console.log('✅ Active matches:', activeMatches.data);
  } catch (error) {
    console.error('❌ Active matches test failed:', error.message);
  }

  console.log('\n✅ All tests completed!');
}

testMultiplayerEndpoint().catch(console.error);
