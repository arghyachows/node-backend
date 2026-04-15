const { getCachedCommentary, setCachedCommentary } = require('./redis');
const logger = require('../utils/logger');
const axios = require('axios');

/**
 * Hybrid cricket commentary engine:
 * - Ollama AI for key events (wickets, fours, sixes)
 * - Rich templates for everything else (dot balls, singles, etc.)
 * - Redis + in-memory caching
 * - Timeout + fallback to templates if Ollama is slow/down
 */

const OLLAMA_URL = process.env.OLLAMA_URL || 'https://api.ollama.com';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT || '3000', 10);
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const AI_EVENTS = new Set(['wicket', 'six', 'four']); // Only generate AI for these

const commentaryCache = new Map();

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function generateAICommentary(context) {
  const {
    eventType,
    innings,
    currentScore,
    currentWickets,
    target,
    wicketType,
    isSuperOver,
    batsmanName,
    bowlerName,
    fielderName,
  } = context;

  const cacheKey = buildCacheKey(eventType, innings, currentScore, currentWickets, target, wicketType, isSuperOver);

  // Check in-memory cache
  if (commentaryCache.has(cacheKey)) {
    return personalizeCommentary(commentaryCache.get(cacheKey), context);
  }

  // Check Redis cache
  try {
    const cached = await getCachedCommentary(cacheKey);
    if (cached) {
      commentaryCache.set(cacheKey, cached);
      return personalizeCommentary(cached, context);
    }
  } catch (e) {
    // Redis unavailable — proceed to generate
  }

  let commentary;

  // Use Ollama AI for key events, templates for everything else
  if (AI_EVENTS.has(eventType)) {
    try {
      commentary = await generateOllamaCommentary(context);
    } catch (err) {
      logger.warn(`Ollama commentary failed for ${eventType}: ${err.message}`);
      commentary = null;
    }
  }

  // Fallback to template if Ollama didn't produce anything
  if (!commentary) {
    commentary = generateTemplateCommentary(context);
  }

  // Cache a generic (depersonalized) version
  const escBat = batsmanName ? batsmanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const escBowl = bowlerName ? bowlerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const escField = fielderName ? fielderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';

  let generic = commentary;
  if (escBat) generic = generic.replace(new RegExp(escBat, 'g'), 'BATSMAN');
  if (escBowl) generic = generic.replace(new RegExp(escBowl, 'g'), 'BOWLER');
  if (escField) generic = generic.replace(new RegExp(escField, 'g'), 'FIELDER');

  try {
    await setCachedCommentary(cacheKey, generic);
  } catch (e) {
    // Redis unavailable — non-fatal
  }
  commentaryCache.set(cacheKey, generic);

  // Limit in-memory cache
  if (commentaryCache.size > 100) {
    const firstKey = commentaryCache.keys().next().value;
    commentaryCache.delete(firstKey);
  }

  return commentary;
}

// ─── Ollama AI Commentary ─────────────────────────────────────────

async function generateOllamaCommentary(context) {
  const { eventType, batsmanName, bowlerName, fielderName, wicketType, innings,
    overNumber, ballNumber, currentScore, currentWickets, target, isSuperOver, isFreeHit } = context;

  const situation = getSituation(context);
  const chaseInfo = innings === 2 && target > 0
    ? ` Chasing ${target + 1}, currently ${currentScore}/${currentWickets}.`
    : ` Score: ${currentScore}/${currentWickets}.`;
  const overInfo = `Over ${overNumber}.${ballNumber}`;
  const superOverTag = isSuperOver ? ' SUPER OVER!' : '';

  let eventDesc;
  switch (eventType) {
    case 'six':
      eventDesc = `${batsmanName} hits a SIX off ${bowlerName}!`;
      break;
    case 'four':
      eventDesc = `${batsmanName} hits a FOUR off ${bowlerName}!`;
      break;
    case 'wicket':
      eventDesc = `WICKET! ${batsmanName} is out ${wicketType || 'dismissed'}${fielderName ? ` by ${fielderName}` : ''}, bowled by ${bowlerName}!`;
      break;
    default:
      eventDesc = `${bowlerName} to ${batsmanName}.`;
  }

  const prompt = `You are an exciting cricket TV commentator. Generate ONE short commentary line (max 25 words) for this event.${superOverTag}
${overInfo}.${chaseInfo} ${eventDesc}
Reply with ONLY the commentary line, no quotes or explanation.`;

  const headers = { 'Content-Type': 'application/json' };
  if (OLLAMA_API_KEY) {
    headers['Authorization'] = `Bearer ${OLLAMA_API_KEY}`;
  }

  const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: {
      temperature: 0.8,
      top_p: 0.9,
      num_predict: 60,
    },
  }, {
    timeout: OLLAMA_TIMEOUT,
    headers,
  });

  const text = response.data?.response?.trim();
  if (!text || text.length < 5 || text.length > 200) {
    return null; // Bad response, fall back to template
  }

  return text;
}

function buildCacheKey(eventType, innings, currentScore, currentWickets, target, wicketType, isSuperOver) {
  let situation = '';
  if (isSuperOver) {
    situation = 'SO';
  } else if (innings === 1) {
    if (currentScore >= 150) situation = 'I1_BIG';
    else if (currentScore >= 80) situation = 'I1_MID';
    else situation = 'I1_EARLY';
  } else {
    const runsNeeded = (target || 0) + 1 - (currentScore || 0);
    if (runsNeeded <= 6) situation = 'LASTHIT';
    else if (runsNeeded <= 15) situation = 'NAIL';
    else if (runsNeeded <= 30) situation = 'CLOSE';
    else if (runsNeeded <= 60) situation = 'CHASE';
    else situation = 'I2_EARLY';
  }
  const wicketSituation = currentWickets >= 8 ? 'TAIL' : currentWickets >= 5 ? 'MID' : currentWickets <= 1 ? 'TOP' : 'SET';
  return `${eventType}_${situation}_${wicketSituation}_${wicketType || 'none'}_${Math.floor(Math.random() * 3)}`;
}

// ─── Situation helper ─────────────────────────────────────────────

function getSituation(ctx) {
  const { innings, currentScore, currentWickets, target, isSuperOver, overNumber } = ctx;
  if (isSuperOver) return 'super_over';
  if (innings === 2) {
    const needed = (target || 0) + 1 - (currentScore || 0);
    if (needed <= 6) return 'last_hit';
    if (needed <= 15) return 'nail_biter';
    if (needed <= 30) return 'close_chase';
    return 'chase';
  }
  if (overNumber >= 15) return 'death_overs';
  if (overNumber >= 6) return 'middle_overs';
  return 'powerplay';
}

// ─── Main template dispatcher ─────────────────────────────────────

function generateTemplateCommentary(ctx) {
  const { eventType, batsmanName, bowlerName, fielderName, wicketType, isFreeHit } = ctx;
  const situation = getSituation(ctx);

  switch (eventType) {
    case 'four': return generateFourCommentary(batsmanName, bowlerName, situation, ctx);
    case 'six': return generateSixCommentary(batsmanName, bowlerName, situation, ctx);
    case 'wicket': return generateWicketCommentary(batsmanName, bowlerName, fielderName, wicketType, situation, isFreeHit, ctx);
    case 'dot_ball': return generateDotCommentary(batsmanName, bowlerName, situation, ctx);
    case 'single': return generateRunCommentary(batsmanName, bowlerName, 1, situation);
    case 'double': return generateRunCommentary(batsmanName, bowlerName, 2, situation);
    case 'triple': return generateRunCommentary(batsmanName, bowlerName, 3, situation);
    case 'wide': return generateWideCommentary(bowlerName, situation);
    case 'no_ball': return generateNoBallCommentary(bowlerName, batsmanName, situation);
    default: return `${bowlerName} to ${batsmanName}.`;
  }
}

// ─── FOUR templates ───────────────────────────────────────────────

function generateFourCommentary(bat, bowl, situation, ctx) {
  const base = pick([
    `FOUR! ${bat} times it to perfection, the ball races to the boundary!`,
    `FOUR! Exquisite shot from ${bat}! ${bowl} can only watch it go.`,
    `FOUR! ${bat} finds the gap and the ball speeds away!`,
    `FOUR! That's a cracking drive from ${bat}!`,
    `FOUR! ${bat} leans into that one, effortless timing!`,
    `FOUR! ${bat} threads the needle through the off side!`,
    `FOUR! Short from ${bowl} and ${bat} pulls it away!`,
    `FOUR! ${bat} gets on the front foot and drives through covers!`,
    `FOUR! ${bat} flicks off the pads, races away to the fence!`,
    `FOUR! Too full from ${bowl}, ${bat} dispatches it!`,
    `FOUR! ${bat} cuts hard, that's a boundary!`,
    `FOUR! Uppish but safe! ${bat} finds the gap in the deep!`,
    `FOUR! ${bat} goes inside out over cover — class!`,
    `FOUR! A late cut from ${bat}, placed perfectly!`,
    `FOUR! ${bat} plays a gorgeous square drive!`,
    `FOUR! ${bat} opens the face and guides it past point!`,
    `FOUR! ${bowl} errs in length and ${bat} pounces!`,
  ]);

  if (situation === 'nail_biter' || situation === 'last_hit') {
    return base + pick([' The pressure is easing!', ' That could be the turning point!', ' Crucial boundary in the chase!', ' The crowd erupts!']);
  }
  if (situation === 'death_overs') {
    return base + pick([' Maximizing the end overs!', ' Great acceleration!', '']);
  }
  if (situation === 'super_over') {
    return base + ' Big boundary in the Super Over!';
  }
  return base;
}

// ─── SIX templates ────────────────────────────────────────────────

function generateSixCommentary(bat, bowl, situation, ctx) {
  const base = pick([
    `SIX! ${bat} launches it into the stands! Massive hit!`,
    `SIX! That's gone miles! ${bat} with an almighty swing!`,
    `SIX! ${bat} clears the rope with ease! What a shot!`,
    `SIX! ${bat} steps down the track and deposits ${bowl} into the crowd!`,
    `SIX! Incredible power from ${bat}! That's out of the ground!`,
    `SIX! ${bat} gets under it and sends it soaring!`,
    `SIX! ${bowl} goes short and ${bat} makes it pay! Over long-on!`,
    `SIX! A slog sweep from ${bat}, that's in the second tier!`,
    `SIX! ${bat} stands tall and lofts it over extra cover!`,
    `SIX! ${bat} picks the length early and smashes it downtown!`,
    `SIX! Top edge but it carries all the way! ${bat} won't mind!`,
    `SIX! ${bat} dances down and clears mid-wicket! Pure entertainment!`,
    `SIX! Flat bat from ${bat}! The ball disappears into the crowd!`,
    `SIX! ${bat} creams it over point! Audacious shot!`,
    `SIX! Maximum! ${bat} dispatches ${bowl} with authority!`,
    `SIX! ${bat} muscles it over long-off! Brute force!`,
    `SIX! ${bat} reverse sweeps for six! Outrageous!`,
  ]);

  if (situation === 'super_over') return base + ' Every run counts in the Super Over!';
  if (situation === 'nail_biter' || situation === 'last_hit') {
    return base + pick([' That brings the equation right down!', ' Game-changing hit!', ' The fielding side look shaken!']);
  }
  return base;
}

// ─── WICKET templates ─────────────────────────────────────────────

function generateWicketCommentary(bat, bowl, fielder, wicketType, situation, isFreeHit, ctx) {
  if (isFreeHit) {
    return pick([
      `${bat} swings and misses but it's a FREE HIT! No damage done!`,
      `That would have been out! But it's a free hit — ${bat} survives!`,
      `Big appeal but FREE HIT saves ${bat}!`,
    ]);
  }

  const f = fielder || 'the fielder';
  let dismissal;

  switch (wicketType) {
    case 'bowled':
      dismissal = pick([
        `BOWLED! ${bowl} knocks back the stumps! ${bat} is stunned!`,
        `BOWLED HIM! Through the gate! ${bowl} is fired up!`,
        `TIMBER! The off stump is cartwheeling! ${bat} has to go!`,
        `BOWLED! ${bat} plays all around it! What a delivery from ${bowl}!`,
        `Clean bowled! ${bowl} hits the top of middle stump!`,
        `BOWLED! ${bat} doesn't get anywhere near it! Brilliant from ${bowl}!`,
        `BOWLED! The middle stump is pegged back! ${bowl} roars!`,
      ]);
      break;
    case 'caught':
      dismissal = pick([
        `CAUGHT! ${f} takes a sharp catch! ${bat} is gone!`,
        `OUT! ${bat} holes out! ${f} in the deep takes it!`,
        `CAUGHT! In the air... and taken cleanly by ${f}! ${bowl} strikes!`,
        `OUT! ${bat} edges and ${f} gobbles it up!`,
        `GONE! ${bat} finds ${f} at the boundary! ${bowl} is delighted!`,
        `CAUGHT! Skied it! ${f} settles under it — ${bat} walks!`,
        `CAUGHT! What a grab by ${f}! ${bat} can't believe it!`,
      ]);
      break;
    case 'lbw':
      dismissal = pick([
        `LBW! Trapped in front! ${bowl} gets one to nip back and ${bat} is plumb!`,
        `OUT! LBW! Dead straight from ${bowl}! ${bat} is gone!`,
        `LBW! ${bat} misses the flick, that's hitting middle stump!`,
        `GIVEN! LBW! ${bowl} pins ${bat} right in front of the stumps!`,
        `LBW! No doubt about that one! ${bat} was rooted to the crease!`,
      ]);
      break;
    case 'run_out':
      dismissal = pick([
        `RUN OUT! Brilliant fielding! ${bat} is short of the crease!`,
        `RUN OUT! Direct hit! ${bat} was ball-watching and pays the price!`,
        `OUT! Run out! Terrible mix-up between the batsmen! ${bat} has to go!`,
        `RUN OUT! ${f} with a direct hit! ${bat} was miles out!`,
        `RUN OUT! Hesitation costs ${bat}! Great work in the field!`,
      ]);
      break;
    case 'stumped':
      dismissal = pick([
        `STUMPED! ${bat} charges down and misses — ${f} whips off the bails!`,
        `STUMPED! Lightning quick work behind the stumps! ${bat} is stranded!`,
        `OUT! Stumped! ${bat} overbalances and ${f} does the rest!`,
        `STUMPED! Too clever from ${bowl}! ${bat} was way out of the crease!`,
      ]);
      break;
    case 'caught_behind':
      dismissal = pick([
        `CAUGHT BEHIND! Thin edge and ${f} takes it! ${bat} has to go!`,
        `OUT! Feather edge! ${f} dives and takes a beauty!`,
        `CAUGHT! Nicked it! ${bowl} gets the outside edge and ${bat} is dismissed!`,
        `CAUGHT BEHIND! ${bowl} gets it to move away late — ${bat} couldn't resist!`,
      ]);
      break;
    default:
      dismissal = pick([
        `OUT! ${bowl} strikes! ${bat} has to walk back to the pavilion!`,
        `WICKET! ${bat} is dismissed! ${bowl} pumps his fist!`,
        `GOT HIM! ${bowl} gets the breakthrough! ${bat} departs!`,
      ]);
  }

  // Add situational flavor
  if (ctx.currentWickets >= 8) {
    dismissal += pick([' The tail is exposed now!', ' Deep trouble for the batting side!', ' The lower order needs to hold on!']);
  } else if (situation === 'nail_biter' || situation === 'last_hit') {
    dismissal += pick([' What a time to strike!', ' This changes everything!', ' The pressure just went through the roof!']);
  } else if (situation === 'super_over') {
    dismissal += ' Huge wicket in the Super Over!';
  }

  return dismissal;
}

// ─── DOT BALL templates ──────────────────────────────────────────

function generateDotCommentary(bat, bowl, situation, ctx) {
  const templates = [
    `${bowl} keeps it tight, dot ball.`,
    `Good length from ${bowl}, ${bat} defends solidly.`,
    `${bowl} on the mark, ${bat} can't find a gap.`,
    `Tight line from ${bowl}. ${bat} plays and misses.`,
    `Dot ball. ${bowl} keeping the pressure on.`,
    `${bat} pushes at it but can't beat the field. Good from ${bowl}.`,
    `${bowl} darts it in, ${bat} blocks.`,
    `Nothing doing. ${bowl} keeps it outside off.`,
    `${bat} shapes to drive but holds back. Good discipline.`,
    `Probing delivery from ${bowl}. ${bat} lets it go.`,
    `${bowl} hits a good length, no run.`,
    `${bat} defends off the back foot. Solid technique.`,
    `${bowl} cramps ${bat} for room. Dot ball.`,
    `Back of a length from ${bowl}. ${bat} ducks under.`,
    `${bowl} tests the outside edge. ${bat} leaves it alone.`,
    `Accurate from ${bowl}. ${bat} can't get it away.`,
  ];

  if (situation === 'nail_biter' || situation === 'last_hit') {
    templates.push(
      `Dot ball! The pressure is building on ${bat}!`,
      `No run! The asking rate climbs! ${bowl} is on fire!`,
      `Dot! The crowd holds its breath!`,
    );
  }
  if (situation === 'death_overs') {
    templates.push(
      `${bowl} nails the yorker! Can't score off that!`,
      `Slower ball from ${bowl}, ${bat} swings and misses!`,
    );
  }
  return pick(templates);
}

// ─── RUNS (1, 2, 3) templates ────────────────────────────────────

function generateRunCommentary(bat, bowl, runs, situation) {
  if (runs === 1) {
    const templates = [
      `${bat} nudges it for a quick single.`,
      `${bat} works it to the on side, easy single.`,
      `Pushed into the gap by ${bat}, they take one.`,
      `${bat} dabs it and rotates the strike. Smart cricket.`,
      `Single taken. ${bat} keeps the scoreboard ticking.`,
      `${bat} taps and runs. Good awareness.`,
      `${bat} flicks off the pads for one.`,
      `Turned away for a single. ${bat} keeping it going.`,
      `${bat} drops it into the leg side, quick single.`,
      `Just a single. ${bat} waits for the loose ball.`,
    ];
    if (situation === 'nail_biter') templates.push('One run. Every single counts now!');
    if (situation === 'last_hit') templates.push(`${bat} takes one. Getting closer!`);
    return pick(templates);
  }
  if (runs === 2) {
    const templates = [
      `${bat} drives through the gap, they come back for two!`,
      `Placed well by ${bat}! Two runs to the pair.`,
      `${bat} punches it through cover, good running — two!`,
      `Two more! ${bat} finds the space in the outfield.`,
      `${bat} works it into the deep — hustled two!`,
      `Neat placement from ${bat}, comfortable two runs.`,
      `${bat} clips to midwicket and they scamper back for two.`,
    ];
    return pick(templates);
  }
  // 3 runs
  const templates = [
    `${bat} finds the gap, they run three! Great running!`,
    `Three runs! ${bat} threads it past the boundary rider!`,
    `Excellent running between the wickets! Three to ${bat}!`,
    `${bat} drives and there's a misfield — they take three!`,
    `Three! Outstanding athleticism between the wickets!`,
  ];
  return pick(templates);
}

// ─── WIDE templates ──────────────────────────────────────────────

function generateWideCommentary(bowl, situation) {
  const templates = [
    `Wide ball from ${bowl}. Extra run conceded.`,
    `Too wide! ${bowl} strays down the leg side.`,
    `That's a wide. ${bowl} loses the line there.`,
    `Wide called. ${bowl} needs to tighten up.`,
    `Drifting wide. ${bowl} can't afford to be loose here.`,
    `Wide! One run gifted to the batting side.`,
    `Wide! ${bowl} sprays it down leg.`,
  ];
  if (situation === 'nail_biter' || situation === 'last_hit') {
    templates.push(`Wide! A costly extra at this stage!`, `Wide ball! ${bowl} under pressure, losing control!`);
  }
  return pick(templates);
}

// ─── NO BALL templates ───────────────────────────────────────────

function generateNoBallCommentary(bowl, bat, situation) {
  const templates = [
    `NO BALL! ${bowl} oversteps! FREE HIT coming up!`,
    `NO BALL! ${bowl} has overstepped the mark! Free hit next!`,
    `That's a no ball! ${bowl} can't afford that! Free hit for ${bat}!`,
    `NO BALL! Extra run and a free hit! ${bowl} will be kicking himself!`,
    `Overstep from ${bowl}! Free hit next delivery!`,
    `NO BALL! The umpire signals — ${bat} gets a free hit!`,
  ];
  if (situation === 'nail_biter' || situation === 'last_hit') {
    templates.push(`NO BALL! Gift for the chasing side! Free hit too!`, `NO BALL! ${bowl} cracks under pressure! Free hit coming!`);
  }
  return pick(templates);
}

// ─── Personalization ─────────────────────────────────────────────

function personalizeCommentary(commentary, context) {
  const { batsmanName, bowlerName, fielderName, isFreeHit, eventType } = context;

  let personalized = commentary
    .replace(/BATSMAN/g, batsmanName || 'Batsman')
    .replace(/BOWLER/g, bowlerName || 'Bowler')
    .replace(/FIELDER/g, fielderName || 'the fielder');

  if (isFreeHit && eventType !== 'no_ball') {
    personalized += ' (Free Hit)';
  }
  return personalized;
}

module.exports = { generateAICommentary };
