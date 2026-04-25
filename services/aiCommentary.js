const logger = require('../utils/logger');
const axios = require('axios');

/**
 * Hybrid cricket commentary engine:
 * - Ollama AI for key events (wickets, fours, sixes)
 * - Rich templates for everything else (dot balls, singles, etc.)
 * - Redis + in-memory caching
 * - Timeout + fallback to templates if Ollama is slow/down
 */

const { WatsonXAI } = require('@ibm-cloud/watsonx-ai');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');
const WATSONX_PROJECT_ID = process.env.WATSONX_PROJECT_ID || '';
const IBM_CLOUD_API_KEY = process.env.IBM_CLOUD_API_KEY || '';
const WATSONX_URL = process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com';
const WATSONX_MODEL = process.env.WATSONX_MODEL || 'meta-llama/llama-4-maverick-17b-128e-instruct-fp8';
const AI_EVENTS = new Set(['wicket', 'six', 'four']); // Only generate AI for these

// Track recently used templates to avoid repeats
const recentCommentary = [];
const MAX_RECENT = 30;

function pick(arr) {
  // Filter out recently used commentary
  const unused = arr.filter(item => !recentCommentary.includes(item));
  const pool = unused.length > 0 ? unused : arr; // fallback to full list if all used
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  
  recentCommentary.push(chosen);
  if (recentCommentary.length > MAX_RECENT) {
    recentCommentary.shift();
  }
  return chosen;
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

  let commentary;

  // Use WatsonX AI for key events only when useAI is explicitly enabled
  const shouldCallAI = context.useAI !== false && AI_EVENTS.has(eventType) && IBM_CLOUD_API_KEY && WATSONX_PROJECT_ID;
  if (shouldCallAI) {
    logger.info(`[AI Commentary] Calling WatsonX for ${eventType} | ${WATSONX_MODEL} | useAI=${context.useAI}`);
    try {
      commentary = await generateWatsonxCommentary(context);
      if (commentary) {
        logger.info(`[AI Commentary] ✓ WatsonX generated: "${commentary.substring(0, 60)}..."`);
      } else {
        logger.info(`[AI Commentary] ✗ WatsonX returned empty/invalid — using template`);
      }
    } catch (err) {
      logger.info(`[AI Commentary] ✗ WatsonX failed: ${err.message} — using template`);
      commentary = null;
    }
  } else {
    logger.info(`[AI Commentary] Template mode | event=${eventType} | useAI=${context.useAI} | hasKey=${!!IBM_CLOUD_API_KEY}`);
  }

  // Always generate fresh template commentary (no caching — ensures uniqueness)
  if (!commentary) {
    commentary = generateTemplateCommentary(context);
  }

  return commentary;
}

// ─── WatsonX AI Commentary ─────────────────────────────────────────

async function generateWatsonxCommentary(context) {
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

  const prompt = `You are a cricket TV commentator. Write ONE short, vivid commentary line (under 25 words) for this moment.${superOverTag}
${overInfo}.${chaseInfo} ${eventDesc}
Commentary:`;

  const watsonxAIService = WatsonXAI.newInstance({
    version: '2023-05-29',
    serviceUrl: WATSONX_URL,
    authenticator: new IamAuthenticator({
      apikey: IBM_CLOUD_API_KEY,
    }),
  });

  const response = await watsonxAIService.generateText({
    modelId: WATSONX_MODEL,
    projectId: WATSONX_PROJECT_ID,
    input: prompt,
    parameters: {
      max_new_tokens: 40,
      temperature: 0.7,
      repetition_penalty: 1.1,
      stop_sequences: ['\n', '"', 'Commentary:', '<|', 'Note:', 'Reply'],
    }
  });

  let text = response.result.results[0].generated_text.trim();
  logger.info(`[AI Commentary] Raw text from WatsonX: "${text}"`);

  // ── Clean LLM artifacts ──
  // Strip common LLM junk: quotes, markdown, meta-text, special tokens
  text = text
    .replace(/<\|.*?\|>/g, '')              // <|end_of_text|>, <|eot_id|>, etc.
    .replace(/<end of text>/gi, '')
    .replace(/<lend of text>/gi, '')
    .replace(/```[\s\S]*?```/g, '')         // code blocks
    .replace(/\*\*/g, '')                    // bold markdown
    .replace(/^\s*["'`]+|["'`]+\s*$/g, '')  // surrounding quotes
    .replace(/^\s*[-–—•]\s*/g, '')          // bullet points
    .replace(/\d+\s*min\s*read/gi, '')      // "2 min read"
    .replace(/i changed.*?for you/gi, '')   // "I changed it for you"
    .replace(/here'?s?\s*(the|a|your)?\s*commentary.*/gi, '') // "Here's the commentary:"
    .replace(/commentary\s*:/gi, '')        // leftover "Commentary:"
    .replace(/reply\s*:/gi, '')
    .replace(/note\s*:/gi, '')
    .replace(/\n.*/g, '')                   // everything after first newline
    .trim();

  // Add back trailing punctuation if stripped by stop_sequences
  if (text && !/[.!?]$/.test(text)) {
    text += '!';
  }

  if (!text || text.length < 5 || text.length > 200) {
    return null; // Bad response, fall back to template
  }

  return text;
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
    `Oh, that is glorious! ${bat} just caresses that through the covers and it races away — FOUR runs! What timing, what elegance!`,
    `FOUR! And ${bat} has absolutely middled that one! ${bowl}, I tell you, there was nothing wrong with the delivery, but ${bat} was just too good!`,
    `That's been dispatched! ${bat} leans into the drive and oh my, the ball just flies to the boundary! FOUR more!`,
    `Shot! Oh, what a shot! ${bat} picks up the length early, gets right to the pitch of it, and creams it past mid-off for FOUR!`,
    `FOUR! Now ${bat} is starting to find the rhythm here — that's a delightful flick off the pads, and nobody is stopping that!`,
    `There it is, threading the needle! ${bat} finds the tiniest of gaps on the off side and the ball beats everyone to the rope! Lovely stuff!`,
    `Short and punished! ${bowl} drops it short and ${bat} is onto it in a flash — pulled away for FOUR! You can't bowl there to ${bat}!`,
    `Oh, ${bat} has come alive! Driving on the up through the covers, that's textbook batting, and the fielders can only admire it — FOUR!`,
    `FOUR! Just a gentle flick off the pads from ${bat}, but the placement is exquisite — right in the gap, and it's four all the way!`,
    `Too full, too full from ${bowl}! And ${bat} makes no mistake, drives it straight back past the bowler — that's a boundary!`,
    `Cut away! ${bat} rocks back and absolutely crunches that through point for FOUR! ${bowl} won't want to see that again!`,
    `FOUR! It was in the air for a moment — hearts in mouths — but it's landed safely and raced away! ${bat} lives dangerously!`,
    `Inside out over cover! Now that is audacious from ${bat}! The wrists do all the work and the ball sails over for FOUR!`,
    `Late cut, and it's perfectly placed! ${bat} waited, waited, and just guided it past the keeper — FOUR runs, beautifully done!`,
    `What a square drive! ${bat} just rolls the wrists over it, and the ball scorches across the turf to the boundary! FOUR!`,
    `Opened the face and guided it past point — ${bat} barely had to try! That's the mark of a quality player — FOUR more!`,
    `That's a bad ball from ${bowl}, and ${bat} has absolutely pounced on it! No mercy shown — driven away for FOUR!`,
  ]);

  if (situation === 'nail_biter' || situation === 'last_hit') {
    return base + pick([' And you can feel the pressure lifting — that boundary could change everything!', ' The crowd is on its feet! That could be the shot that wins this match!', ' A crucial, crucial boundary in the context of this chase!', ' Listen to that roar from the crowd — they sense a finish here!']);
  }
  if (situation === 'death_overs') {
    return base + pick([' Making the most of these final overs — that\'s smart, aggressive cricket!', ' Great acceleration at just the right time!', '']);
  }
  if (situation === 'super_over') {
    return base + ' And in a Super Over, every boundary is worth its weight in gold!';
  }
  return base;
}

// ─── SIX templates ────────────────────────────────────────────────

function generateSixCommentary(bat, bowl, situation, ctx) {
  const base = pick([
    `That is MASSIVE! ${bat} has launched that right into the stands! The crowd is going absolutely wild — SIX runs!`,
    `Oh my word, that has gone miles! ${bat} just swings through the line and the ball disappears into the night sky — SIX!`,
    `SIX! And ${bat} makes it look so, so easy! Just a gentle swing of the bat and the ball clears the rope by twenty meters!`,
    `He's danced down the pitch! ${bat} gets to the pitch of the ball and deposits ${bowl} into the second tier! That is sensational hitting!`,
    `The power! The sheer, raw power from ${bat}! That ball is never coming back — it's gone out of the stadium! SIX!`,
    `Up, up, and away! ${bat} gets underneath it and sends it soaring into the sky — it comes down in the crowd! Maximum!`,
    `Short from ${bowl}, and that's been absolutely clobbered! ${bat} pulls it over long-on for a huge, huge SIX!`,
    `Slog sweep! And ${bat} has nailed it — that's sailed into the second tier of the stands! What a hit, what a player!`,
    `Standing tall and lofting it with supreme confidence — ${bat} clears extra cover for SIX! That is magnificent batting!`,
    `${bat} picked up the length early, planted the front foot, and smashed it straight down the ground for SIX! ${bowl} has no answers!`,
    `Top edge, but you know what — it's carried all the way into the crowd! ${bat} won't care one bit — SIX runs!`,
    `Dancing down the track like a man possessed! ${bat} clears mid-wicket with ease — SIX! This is pure entertainment, folks!`,
    `Flat bat, brute force! ${bat} just muscles this into the crowd at long-off! The ball disappears! SIX!`,
    `Over point?! Are you kidding me?! ${bat} has just creamed that over backward point for SIX! That is outrageous!`,
    `Maximum! ${bat} stands and delivers — ${bowl} is dispatched with utter authority! SIX more to the total!`,
    `Raw muscle from ${bat}! That's been belted over long-off, and the ball lands about fifteen rows back — SIX!`,
    `A reverse sweep for SIX?! ${bat} has just played the most audacious shot of the match! Unbelievable!`,
  ]);

  if (situation === 'super_over') return base + ' And in a Super Over, a six like that is absolutely priceless!';
  if (situation === 'nail_biter' || situation === 'last_hit') {
    return base + pick([' And suddenly the equation looks a whole lot different! The momentum has shifted!', ' That could be the match-winning blow! What a time to unleash that!', ' Look at the fielding captain\'s face — they know the game is slipping away!']);
  }
  return base;
}

// ─── WICKET templates ─────────────────────────────────────────────

function generateWicketCommentary(bat, bowl, fielder, wicketType, situation, isFreeHit, ctx) {
  if (isFreeHit) {
    return pick([
      `${bat} swings and misses, but hey — it's a FREE HIT! Can't get out off that one! No damage done at all!`,
      `Oh, that would have been out on any other delivery! But it's a free hit, and ${bat} lives to fight another ball! Lucky escape!`,
      `Big appeal from the fielding side, but the umpire reminds everyone — it's a free hit! ${bat} survives, and you can see the relief on his face!`,
    ]);
  }

  const f = fielder || 'the fielder';
  let dismissal;

  switch (wicketType) {
    case 'bowled':
      dismissal = pick([
        `BOWLED HIM! Oh, what a delivery! ${bowl} knocks back the stumps and ${bat} just stands there in disbelief — he has no idea what happened!`,
        `Through the gate! ${bowl} has cleaned him up — the off stump is leaning back, and ${bat} has to make that long walk! Brilliant bowling!`,
        `TIMBER! Look at that — the off stump goes cartwheeling out of the ground! ${bat} played all around that one! ${bowl} is pumping his fist!`,
        `Bowled him! ${bat} tried to play across the line and missed it completely! ${bowl} hits the top of middle stump — you cannot do better than that!`,
        `Clean bowled! ${bowl} gets one to nip back off the seam, and ${bat} is beaten all ends up! The stumps are in a mess — what a delivery!`,
        `Oh, ${bat} didn't get anywhere near that! ${bowl} fires one through, the bails go flying, and the bowler lets out an almighty roar! BOWLED!`,
        `The middle stump is pegged back! ${bowl} has produced an absolute peach, and ${bat} can only shake his head and walk off! Sensational bowling!`,
      ]);
      break;
    case 'caught':
      dismissal = pick([
        `CAUGHT! Up she goes, and ${f} gets underneath it — takes it cleanly! ${bat} knows straight away, he's gone! ${bowl} is over the moon!`,
        `In the air... is it going to carry? YES! ${f} takes it in the deep! ${bat} holes out, and the fielding side are absolutely ecstatic!`,
        `CAUGHT! ${bat} gets a thick edge, and ${f} makes no mistake — takes it at chest height! ${bowl} has his man! What a moment!`,
        `Gone! ${bat} tried to go big but didn't get enough on it — ${f} at the boundary takes a good catch moving to his left! That's a big wicket!`,
        `Oh, he's skied it! ${f} settles underneath it, keeps his eyes on the ball, and takes it safely! ${bat} is furious with himself — he had to walk!`,
        `What a grab! ${f} flings himself to his right and takes a one-handed screamer! ${bat} can't believe it — and honestly, neither can I! CAUGHT!`,
        `Straight to the fielder! ${bat} didn't time it at all — ${f} takes a simple catch, and ${bowl} strikes! That's the breakthrough they needed!`,
      ]);
      break;
    case 'lbw':
      dismissal = pick([
        `Trapped in front! ${bowl} gets one to nip back, hits ${bat} right on the pads — the umpire's finger goes up without hesitation! LBW, and that looked absolutely plumb!`,
        `GIVEN! LBW! ${bowl} fires it in straight, ${bat} misses the flick, and that's crashing into middle stump! The umpire didn't need long to think about that one!`,
        `LBW! Dead straight from ${bowl}! ${bat} was rooted to the crease, didn't get any bat on it, and that was hitting the stumps — no doubt about it!`,
        `He's trapped him! ${bowl} pins ${bat} right in front of all three stumps — the umpire raises the finger, and ${bat} has to go! Superb bowling!`,
        `LBW — that's out! ${bat} was playing across the line, missed it completely, and that was crashing into leg stump! ${bowl} wheels away in celebration!`,
      ]);
      break;
    case 'run_out':
      dismissal = pick([
        `RUN OUT! Oh, what fielding! A direct hit from the deep, and ${bat} is short of the crease by inches! The replays confirm it — he's got to go!`,
        `Direct hit! RUN OUT! ${bat} was ball-watching and never got going — the throw comes in flat and fast, and the stumps are broken! Brilliant work in the field!`,
        `Oh no, terrible mix-up! They're both stranded in the middle — the throw comes in, and ${bat} is run out! Communication is key, and that was a complete breakdown!`,
        `RUN OUT! ${f} picks up and fires — direct hit! ${bat} was miles out of the crease! That is absolutely outstanding fielding under pressure!`,
        `Hesitation, and it costs ${bat} dearly! The fielder swoops in, the throw is accurate, and ${bat} is well short — RUN OUT! That's a disaster!`,
      ]);
      break;
    case 'stumped':
      dismissal = pick([
        `STUMPED! ${bat} charges down the pitch, misses it completely, and ${f} whips off the bails in a flash! ${bat} is stranded — nowhere near the crease!`,
        `Lightning quick work behind the stumps! ${bat} lost balance for just a moment, and ${f} has the bails off in an instant — STUMPED! What reflexes!`,
        `Out! Stumped! ${bat} came dancing down the track, ${bowl} saw it coming and dragged it wide — ${f} does the rest! Clever, clever cricket!`,
        `STUMPED! ${bowl} outfoxes ${bat} completely — he's down the pitch, the ball turns past the bat, and ${f} has all the time in the world to break the stumps!`,
      ]);
      break;
    case 'caught_behind':
      dismissal = pick([
        `There's the edge! A thin nick, and ${f} dives to his right — takes it beautifully! ${bat} has to go! ${bowl} knew he had him the moment it left the bat!`,
        `CAUGHT BEHIND! Just a feather of an edge — you could barely hear it — but ${f} heard it alright! Dives full length and takes a stunner! ${bat} is out!`,
        `Nicked it! ${bowl} gets the ball to move away late, finds the outside edge, and ${f} makes no mistake! That's a huge wicket — ${bat} departs!`,
        `Caught behind! ${bowl} tempts ${bat} into a drive, gets it to shape away, and there's the edge! ${f} pouches it — brilliant combination between bowler and keeper!`,
      ]);
      break;
    default:
      dismissal = pick([
        `He's got him! ${bowl} strikes, and ${bat} has to make the long walk back to the pavilion! What a moment for the bowling side!`,
        `WICKET! ${bat} is dismissed, and ${bowl} is celebrating wildly! That's a big one — the fielding side needed that breakthrough desperately!`,
        `GOT HIM! ${bowl} pumps his fist and lets out a roar! ${bat} tucks the bat under his arm and walks off — the spell is broken!`,
      ]);
  }

  // Add situational flavor
  if (ctx.currentWickets >= 8) {
    dismissal += pick([' And the tail is well and truly exposed now — the batting side are in deep, deep trouble!', ' They are running out of recognized batters now — this could be the beginning of the end!', ' The lower order really needs to dig in and show some backbone here — tough times!']);
  } else if (situation === 'nail_biter' || situation === 'last_hit') {
    dismissal += pick([' What a time to claim a wicket! This match has just been turned on its head!', ' And suddenly everything changes! The pressure is immense now on the batting side!', ' The tension in this ground is absolutely electric — can you feel it?!']);
  } else if (situation === 'super_over') {
    dismissal += ' A wicket in the Super Over — that could well decide this entire match!';
  }

  return dismissal;
}

// ─── DOT BALL templates ──────────────────────────────────────────

function generateDotCommentary(bat, bowl, situation, ctx) {
  const templates = [
    `Good bowling, that — ${bowl} keeps it tight on a good length, and ${bat} can only defend. No run.`,
    `Nicely played by ${bat}, gets forward and blocks solidly, but no run to be had there.`,
    `${bowl} is right on the money here, and ${bat} simply cannot find a gap — another dot ball.`,
    `Ooh, plays and misses! ${bowl} got that one to jag away, and ${bat} gropes at thin air outside off stump!`,
    `Dot ball. ${bowl} is building pressure beautifully here — making ${bat} work for every single run.`,
    `${bat} pushes at it, but the fielding is sharp and there's no run. ${bowl} is in a great rhythm right now.`,
    `Fired in by ${bowl}, and ${bat} blocks it down the pitch. Good, disciplined batting though — biding time.`,
    `Outside off from ${bowl}, and ${bat} wisely lets that one go through to the keeper. No run.`,
    `${bat} shapes to drive, then thinks better of it — holds the bat close to the body. Good discipline there.`,
    `Probing line from ${bowl}, just testing the corridor of uncertainty. ${bat} opts to leave it alone.`,
    `${bowl} hits a nagging good length yet again — ${bat} can't get it off the square. Dot ball.`,
    `Back foot defense from ${bat}, nice and compact. Solid technique, but no run to show for it.`,
    `Cramped for room! ${bowl} tucks ${bat} up, and there's nowhere to score. Tight bowling.`,
    `Back of a length, rising on ${bat}, who sways out of the way. Uncomfortable delivery that.`,
    `Testing the outside edge again — ${bowl} is probing away, and ${bat} wisely leaves it alone. Patience.`,
    `Right on target from ${bowl}, and ${bat} just cannot get it away. Accurate, disciplined stuff.`,
  ];

  if (situation === 'nail_biter' || situation === 'last_hit') {
    templates.push(
      `Dot ball! And you can feel the pressure mounting — ${bat} desperately needs to find a way to score here!`,
      `No run! The required rate is climbing, and ${bowl} is loving every moment of this — what a spell!`,
      `Another dot! The crowd is on the edge of their seats — every ball without a run is agony for the batting side!`,
    );
  }
  if (situation === 'death_overs') {
    templates.push(
      `Yorker! ${bowl} absolutely nails the blockhole — there's nothing ${bat} can do with that! Superb death bowling!`,
      `Slower ball from ${bowl}, and ${bat} swings hard but misses everything! ${bowl} is mixing it up beautifully!`,
    );
  }
  return pick(templates);
}

// ─── RUNS (1, 2, 3) templates ────────────────────────────────────

function generateRunCommentary(bat, bowl, runs, situation) {
  if (runs === 1) {
    const templates = [
      `Nudged away by ${bat} into the leg side, and they pinch a quick single — good awareness.`,
      `${bat} works it off the hip to the on side, and there's an easy single there. Keeps the scoreboard moving.`,
      `Pushed into the gap by ${bat}, the fielder is slow to react, and they take one comfortably.`,
      `Just a dab and run from ${bat} — rotates the strike, and that's smart cricket. Keep the game ticking over.`,
      `Single taken. ${bat} isn't trying anything flashy right now — just milking the bowling and waiting for the bad ball.`,
      `${bat} taps it into the off side and sets off quickly — good calling, and they're home safely for one.`,
      `Flicked off the pads for a single. ${bat} is picking up ones and twos sensibly here.`,
      `Turned off the hips for one. ${bat} is keeping things moving nicely with these smart singles.`,
      `Dropped into the leg side by ${bat}, quick call, and they scamper through for a single.`,
      `Just the one, but ${bat} is playing the long game here — waiting for the loose ball to come.`,
    ];
    if (situation === 'nail_biter') templates.push('One run — and honestly, every single counts now! They need to keep chipping away at this target!');
    if (situation === 'last_hit') templates.push(`${bat} takes a single, and they're inching closer! Not long now — the crowd is getting louder!`);
    return pick(templates);
  }
  if (runs === 2) {
    const templates = [
      `Driven into the gap! ${bat} calls early and they come back for two — great running between the wickets!`,
      `Beautifully placed by ${bat} into the outfield, and there are two runs there all day long!`,
      `${bat} punches it through cover, the outfielder gives chase but they've already turned — two runs!`,
      `Two more to the total! ${bat} finds the space in the outfield, and they run hard between the wickets!`,
      `${bat} clips it into the deep, and they hustle through for two — sharp running, that!`,
      `Neat placement from ${bat}, splitting the fielders — comfortable two runs, no drama at all.`,
      `Clipped to midwicket, the ball races into the gap, and they scamper back for a well-judged two!`,
    ];
    return pick(templates);
  }
  // 3 runs
  const templates = [
    `${bat} finds the gap, they're running hard — one, two, and yes, they come back for THREE! Outstanding running!`,
    `Three runs! ${bat} threads it past the boundary rider, and by the time the ball comes back in, they've completed the third!`,
    `Excellent running between the wickets — these two are in tremendous touch! Three runs to ${bat}!`,
    `${bat} drives into the outfield, and there's a slight misfield — they seize the opportunity and take three! Every run matters!`,
    `Three! The running between the wickets has been absolutely electric — superb athleticism from both batters!`,
  ];
  return pick(templates);
}

// ─── WIDE templates ──────────────────────────────────────────────

function generateWideCommentary(bowl, situation) {
  const templates = [
    `Wide ball signaled by the umpire — ${bowl} drifts down the leg side, and that's an extra run gifted to the batting side.`,
    `Oh, that's too wide! ${bowl} has strayed down leg there — the umpire stretches both arms out. Free run.`,
    `Wide called. ${bowl} is losing the line a little bit here — needs to tighten things up quickly.`,
    `That's been called wide — ${bowl} will be frustrated with that. Discipline is everything in this situation.`,
    `Drifting wide again from ${bowl}, and the umpire signals it. Can't afford to be loose here — every extra hurts.`,
    `Wide! One run gifted away, just like that. ${bowl} shakes his head — he knows that's unacceptable.`,
    `Down the leg side, called wide! ${bowl} has lost his radar momentarily — needs to reset.`,
  ];
  if (situation === 'nail_biter' || situation === 'last_hit') {
    templates.push(
      `Wide! Oh, that is costly — you cannot afford to give away extras at this stage of the game! ${bowl} will be kicking himself!`,
      `Wide ball! And the pressure is getting to ${bowl} now — that's a gift to the chasing side when they needed it most!`
    );
  }
  return pick(templates);
}

// ─── NO BALL templates ───────────────────────────────────────────

function generateNoBallCommentary(bowl, bat, situation) {
  const templates = [
    `NO BALL! ${bowl} has overstepped the mark — and that means a FREE HIT is coming up! ${bat} will be licking his lips!`,
    `Oh dear, ${bowl} has overstepped! The umpire calls no ball, and the next delivery is a free hit — ${bat} can swing away without any worry!`,
    `That's a no ball! ${bowl} really can't afford that — not only is it a free run, but ${bat} gets a free hit next ball! Double punishment!`,
    `NO BALL called! ${bowl} will be absolutely fuming with himself — an extra run conceded and now a free hit coming up for ${bat}!`,
    `Overstep from ${bowl}! The umpire's arm goes out, and that means free hit! ${bat} can have a risk-free swing at the next one!`,
    `NO BALL! The umpire checks the crease and signals it — ${bat} gets a free hit, and the crowd buzz in anticipation!`,
  ];
  if (situation === 'nail_biter' || situation === 'last_hit') {
    templates.push(
      `NO BALL! What a gift for the chasing side! A free run AND a free hit — ${bowl} has just given them a lifeline!`,
      `NO BALL! And you can see the nerves getting to ${bowl} here — overstepping at the worst possible time! Free hit coming up!`
    );
  }
  return pick(templates);
}

module.exports = { generateAICommentary };
