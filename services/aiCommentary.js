const axios = require('axios');
const { getCachedCommentary, setCachedCommentary } = require('./redis');
const logger = require('../utils/logger');

const commentaryCache = new Map();

async function generateAICommentary(context) {
  const {
    eventType,
    innings,
    currentScore,
    currentWickets,
    target,
    wicketType,
    isSuperOver,
  } = context;

  // Build cache key
  const cacheKey = buildCacheKey(eventType, innings, currentScore, currentWickets, target, wicketType, isSuperOver);
  
  // Check in-memory cache
  if (commentaryCache.has(cacheKey)) {
    return personalizeCommentary(commentaryCache.get(cacheKey), context);
  }

  // Check Redis cache
  const cached = await getCachedCommentary(cacheKey);
  if (cached) {
    commentaryCache.set(cacheKey, cached);
    return personalizeCommentary(cached, context);
  }

  // Generate new commentary via Cloudflare AI
  try {
    const prompt = buildPrompt(eventType, context);
    
    const response = await axios.post(
      `${process.env.CLOUDFLARE_AI_WORKER_URL}/ai/commentary`,
      { prompt },
      { timeout: 3000 }
    );

    let commentary = response.data.commentary || getFallbackCommentary(eventType, context);
    
    // Cache generic version
    await setCachedCommentary(cacheKey, commentary);
    commentaryCache.set(cacheKey, commentary);
    
    // Limit in-memory cache size
    if (commentaryCache.size > 50) {
      const firstKey = commentaryCache.keys().next().value;
      commentaryCache.delete(firstKey);
    }

    return personalizeCommentary(commentary, context);
  } catch (error) {
    logger.error('AI commentary generation failed:', error.message);
    return getFallbackCommentary(eventType, context);
  }
}

function buildCacheKey(eventType, innings, currentScore, currentWickets, target, wicketType, isSuperOver) {
  let situation = '';
  
  if (isSuperOver) {
    situation = 'SO';
  } else if (innings === 1) {
    situation = 'I1';
  } else {
    const runsNeeded = target + 1 - currentScore;
    if (runsNeeded <= 10) {
      situation = 'CLOSE';
    } else if (runsNeeded <= 30) {
      situation = 'CHASE';
    } else {
      situation = 'I2';
    }
  }
  
  const wicketSituation = currentWickets >= 7 ? 'TAIL' : currentWickets <= 2 ? 'TOP' : 'MID';
  
  return `${eventType}_${situation}_${wicketSituation}_${wicketType || 'none'}`;
}

function buildPrompt(eventType, context) {
  const matchContext = buildMatchContext(context);
  
  switch (eventType) {
    case 'four':
      return `${matchContext}. BATSMAN hits a FOUR off BOWLER! Commentary:`;
    case 'six':
      return `${matchContext}. BATSMAN smashes a SIX off BOWLER! Commentary:`;
    case 'wicket':
      return `${matchContext}. WICKET! BATSMAN is out off BOWLER. Commentary:`;
    case 'no_ball':
      return `${matchContext}. NO BALL by BOWLER! Free hit next. Commentary:`;
    default:
      return `${matchContext}. BOWLER to BATSMAN. Commentary:`;
  }
}

function buildMatchContext(context) {
  const { innings, overNumber, ballNumber, currentScore, currentWickets, target, isSuperOver } = context;
  
  let situation = '';
  
  if (isSuperOver) {
    situation = 'SUPER OVER';
  } else if (innings === 1) {
    situation = 'First innings';
  } else {
    const runsNeeded = target + 1 - currentScore;
    if (runsNeeded <= 10) {
      situation = `${runsNeeded} runs needed to win`;
    } else if (runsNeeded <= 30) {
      situation = 'Chasing the target';
    } else {
      situation = 'Second innings';
    }
  }
  
  return `${situation}. Score: ${currentScore}/${currentWickets}. Over ${overNumber}.${ballNumber}`;
}

function personalizeCommentary(commentary, context) {
  const { batsmanName, bowlerName, fielderName, isFreeHit, eventType } = context;
  
  let personalized = commentary
    .replace(/BATSMAN/g, batsmanName)
    .replace(/BOWLER/g, bowlerName)
    .replace(/FIELDER/g, fielderName || 'fielder');
  
  if (isFreeHit && eventType !== 'no_ball') {
    personalized += ' (Free Hit)';
  }
  
  return personalized;
}

function getFallbackCommentary(eventType, context) {
  const { batsmanName, bowlerName } = context;
  
  switch (eventType) {
    case 'four':
      return `FOUR! ${batsmanName} drives beautifully!`;
    case 'six':
      return `SIX! ${batsmanName} launches it into the stands!`;
    case 'wicket':
      return `OUT! ${bowlerName} strikes! ${batsmanName} has to walk back.`;
    case 'no_ball':
      return `NO BALL! ${bowlerName} oversteps! FREE HIT next!`;
    default:
      return `${bowlerName} to ${batsmanName}.`;
  }
}

module.exports = { generateAICommentary };
