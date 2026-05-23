const { setMatchState, publishMatchUpdate } = require('./redis');
const logger = require('../utils/logger');
const { generateAICommentary } = require('./aiCommentary');

class MatchEngine {
  constructor(matchId, config, io) {
    this.matchId = matchId;
    this.io = io;
    this.homeXI = config.homeXI;
    this.awayXI = config.awayXI;
    this.homeChemistry = config.homeChemistry;
    this.awayChemistry = config.awayChemistry;
    this.maxOvers = config.maxOvers;
    this.pitchCondition = config.pitchCondition;
    this.homeTeamName = config.homeTeamName;
    this.awayTeamName = config.awayTeamName;
    this.homeBatsFirst = config.homeBatsFirst;
    this.useAICommentary = config.useAICommentary === true; // Default to false

    this.innings = 1;
    this.overNumber = 0;
    this.ballNumber = 0;
    this.score1 = 0;
    this.wickets1 = 0;
    this.score2 = 0;
    this.wickets2 = 0;
    this.target = 0;
    this.matchComplete = false;
    this.isSuperOver = false;
    this.freeHitNext = false;

    this.currentBatsmanIndex = 0;
    this.nonStrikerIndex = 1;
    this.nextBatsmanIndex = 2;
    this.currentBowlerIndex = 0;

    this.battingOrder1 = [...(this.homeBatsFirst ? this.homeXI : this.awayXI)];
    
    const getBowlingOrder = (xi) => {
      let bowlers = xi.filter(p => p.role === 'bowler' || p.role === 'all_rounder');
      if (bowlers.length === 0) bowlers = [...xi];
      
      // Sort so isBowler1 is first, isBowler2 is second
      bowlers.sort((a, b) => {
        if (a.isBowler1) return -1;
        if (b.isBowler1) return 1;
        if (a.isBowler2) return -1;
        if (b.isBowler2) return 1;
        return 0;
      });
      return bowlers;
    };

    this.bowlingOrder1 = getBowlingOrder(this.homeBatsFirst ? this.homeXI : this.awayXI);
    this.battingOrder2 = [...(this.homeBatsFirst ? this.awayXI : this.homeXI)];
    this.bowlingOrder2 = getBowlingOrder(this.homeBatsFirst ? this.awayXI : this.homeXI);

    this.currentBatting = this.battingOrder1;
    this.currentBowling = this.bowlingOrder2;

    this.batsmanStats = {};
    this.bowlerStats = {};
    this.commentaryLog = [];
    
    this.isRunning = false;
    this.timer = null;
  }

  get isFirstInnings() {
    return this.innings === 1;
  }

  get currentWickets() {
    return this.isFirstInnings ? this.wickets1 : this.wickets2;
  }

  get currentBatsman() {
    return this.currentBatting[this.currentBatsmanIndex];
  }

  get nonStriker() {
    return this.currentBatting[this.nonStrikerIndex];
  }

  get currentBowler() {
    return this.currentBowling[this.currentBowlerIndex % this.currentBowling.length];
  }

  async start() {
    if (this.isRunning) {
      logger.warn(`Match ${this.matchId} already running`);
      return;
    }

    this.isRunning = true;
    logger.info(`🏏 Match ${this.matchId} started`);
    await this.loop();
  }

  async loop() {
    if (!this.isRunning || this.matchComplete) {
      await this.onMatchComplete();
      return;
    }

    try {
      const result = await this.simulateNextBall();
      
      if (!result) {
        await this.onMatchComplete();
        return;
      }

      // Add to commentary log (keep all balls for match history)
      this.commentaryLog.push({
        commentary: result.commentary,
        eventType: result.eventType,
        runs: result.runs,
        innings: result.innings,
        overNumber: result.overNumber,
        ballNumber: result.ballNumber,
      });

      // Emit to WebSocket room
      this.io.to(this.matchId).emit('ballUpdate', {
        matchId: this.matchId,
        result,
        state: this.getState(),
        commentaryLog: this.commentaryLog,
      });

      // Save state to Redis (non-fatal)
      try {
        await setMatchState(this.matchId, this.serialize());
      } catch (redisErr) {
        logger.warn(`Redis save failed for match ${this.matchId}: ${redisErr.message}`);
      }

      // Publish to Redis pub/sub
      try {
        await publishMatchUpdate(this.matchId, { result, state: this.getState() });
      } catch (pubErr) {
        logger.warn(`Redis publish failed for match ${this.matchId}: ${pubErr.message}`);
      }

      // Schedule next ball (2.5s gives WatsonX AI time to generate commentary)
      this.timer = setTimeout(() => this.loop(), 2500);
    } catch (error) {
      logger.error(`Match ${this.matchId} simulation error:`, error);
      this.stop();
    }
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info(`⏹️ Match ${this.matchId} stopped`);
  }

  async onMatchComplete() {
    this.matchComplete = true;
    this.isRunning = false;
    
    const matchResult = this.getMatchResult();
    logger.info(`✅ Match ${this.matchId} completed: ${matchResult}`);

    // Emit completion
    this.io.to(this.matchId).emit('matchComplete', {
      matchId: this.matchId,
      result: matchResult,
      state: this.getState(),
      commentaryLog: this.commentaryLog,
    });

    // Save final state
    await setMatchState(this.matchId, this.serialize());
  }

  getState() {
    return {
      matchId: this.matchId,
      innings: this.innings,
      overNumber: this.overNumber,
      ballNumber: this.ballNumber,
      score1: this.score1,
      wickets1: this.wickets1,
      score2: this.score2,
      wickets2: this.wickets2,
      target: this.target,
      matchOvers: this.maxOvers,
      matchComplete: this.matchComplete,
      isSuperOver: this.isSuperOver,
      homeBatsFirst: this.homeBatsFirst,
      batsmanStats: this.batsmanStats,
      bowlerStats: this.bowlerStats,
      currentBatsman: this.currentBatsman?.name,
      nonStriker: this.nonStriker?.name,
      currentBowler: this.currentBowler?.name,
      currentCommentary: this.commentaryLog.length > 0 ? this.commentaryLog[this.commentaryLog.length - 1].commentary : null,
      commentaryLog: this.commentaryLog,
    };
  }

  async simulateNextBall() {
    if (this.matchComplete) return null;

    this.ballNumber++;
    if (this.ballNumber > 6) {
      this.ballNumber = 1;
      this.overNumber++;
      this.currentBowlerIndex++;
      this.swapStrike();
    }

    const maxOversForInnings = this.isSuperOver ? 1 : this.maxOvers;
    const maxWicketsForInnings = this.isSuperOver ? 2 : 10;
    
    if (this.overNumber >= maxOversForInnings || this.currentWickets >= maxWicketsForInnings) {
      if (this.isFirstInnings) {
        return this.endInnings();
      } else {
        if (this.score1 === this.score2 && !this.isSuperOver) {
          return this.startSuperOver();
        }
        this.matchComplete = true;
        return null;
      }
    }

    if (!this.isFirstInnings && this.score2 > this.target) {
      this.matchComplete = true;
      return null;
    }

    const batsman = this.currentBatsman;
    const bowler = this.currentBowler;
    const chemistry = this.isFirstInnings
      ? (this.homeBatsFirst ? this.homeChemistry : this.awayChemistry)
      : (this.homeBatsFirst ? this.awayChemistry : this.homeChemistry);

    const outcome = this.calculateOutcome(batsman.batting, bowler.bowling, chemistry, batsman, bowler);

    const batsmanName = batsman.name;
    const bowlerName = bowler.name;

    let runs = 0;
    let isWicket = false;
    let isBoundary = false;
    let eventType;
    let commentary;
    let wicketType = null;
    let fielderName = null;
    const isFreeHit = this.freeHitNext;

    switch (outcome) {
      case 'dot':
        runs = 0;
        eventType = 'dot_ball';
        break;
      case 'single':
        runs = 1;
        eventType = 'single';
        this.swapStrike();
        break;
      case 'double':
        runs = 2;
        eventType = 'double';
        break;
      case 'triple':
        runs = 3;
        eventType = 'triple';
        this.swapStrike();
        break;
      case 'four':
        runs = 4;
        isBoundary = true;
        eventType = 'four';
        break;
      case 'six':
        runs = 6;
        isBoundary = true;
        eventType = 'six';
        break;
      case 'wicket':
        if (isFreeHit) {
          runs = 0;
          eventType = 'dot_ball';
          isWicket = false;
        } else {
          runs = 0;
          isWicket = true;
          eventType = 'wicket';
          wicketType = this.randomWicketType();
          const fielder = this.pickFielder(wicketType, bowler);
          fielderName = fielder?.name;
        }
        break;
      case 'wide':
        runs = 1;
        eventType = 'wide';
        this.ballNumber--;
        break;
      case 'no_ball':
        runs = 1;
        eventType = 'no_ball';
        this.ballNumber--;
        this.freeHitNext = true;
        break;
      default:
        runs = 0;
        eventType = 'dot_ball';
    }

    // Generate commentary — always use rich template engine (+ optional AI for key events)
    try {
      commentary = await generateAICommentary({
        eventType,
        runs,
        batsmanName,
        bowlerName,
        innings: this.innings,
        overNumber: this.overNumber,
        ballNumber: this.ballNumber,
        currentScore: this.isFirstInnings ? this.score1 : this.score2,
        currentWickets: this.currentWickets,
        target: this.target,
        wicketType,
        fielderName,
        isFreeHit,
        isSuperOver: this.isSuperOver,
        useAI: this.useAICommentary, // only call Ollama when true
      });
    } catch (error) {
      logger.info(`[AI Commentary] Engine error, using basic fallback: ${error.message}`);
      commentary = this.getFallbackCommentary(eventType, batsmanName, bowlerName, wicketType, fielderName, isFreeHit);
    }

    // Update score
    if (this.isFirstInnings) {
      this.score1 += runs;
      if (isWicket) {
        this.wickets1++;
        this.advanceBatsman();
      }
    } else {
      this.score2 += runs;
      if (isWicket) {
        this.wickets2++;
        this.advanceBatsman();
      }
    }

    if (eventType !== 'no_ball' && eventType !== 'wide') {
      this.freeHitNext = false;
    }

    if (!this.isFirstInnings && this.score2 > this.target) {
      this.matchComplete = true;
    }

    const result = {
      innings: this.innings,
      overNumber: this.overNumber,
      ballNumber: this.ballNumber,
      eventType,
      runs,
      isBoundary,
      isWicket,
      wicketType,
      commentary,
      scoreAfter: this.isFirstInnings ? this.score1 : this.score2,
      wicketsAfter: this.isFirstInnings ? this.wickets1 : this.wickets2,
    };

    this.updateStats(result, batsmanName, bowlerName, batsman.userCardId, bowler.userCardId);

    return result;
  }

  updateStats(result, batsmanName, bowlerName, batsmanId, bowlerId) {
    if (result.eventType === 'innings_break') return;

    const isExtra = result.eventType === 'wide' || result.eventType === 'no_ball';
    const batKey = `${result.innings}_${batsmanId}`;
    const bowlKey = `${result.innings}_${bowlerId}`;

    if (!this.batsmanStats[batKey]) {
      const battingArr = result.innings === 1 ? this.battingOrder1 : this.battingOrder2;
      const battingPos = battingArr.findIndex(p => p.userCardId === batsmanId);
      this.batsmanStats[batKey] = {
        name: batsmanName,
        innings: result.innings,
        battingOrder: battingPos >= 0 ? battingPos + 1 : 99,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        isOut: false,
        dismissalType: null,
      };
    }
    const bat = this.batsmanStats[batKey];
    if (result.eventType !== 'wide') bat.balls++;
    bat.runs += result.runs;
    if (result.runs === 4) bat.fours++;
    if (result.runs === 6) bat.sixes++;
    if (result.isWicket) {
      bat.isOut = true;
      bat.dismissalType = `b ${bowlerName}`;
    }

    if (!this.bowlerStats[bowlKey]) {
      this.bowlerStats[bowlKey] = {
        name: bowlerName,
        innings: result.innings,
        balls: 0,
        runs: 0,
        wickets: 0,
        maidens: 0,
        dotBalls: 0,
      };
    }
    const bowl = this.bowlerStats[bowlKey];
    if (!isExtra) bowl.balls++;
    bowl.runs += result.runs;
    if (result.isWicket) bowl.wickets++;
    if (result.runs === 0 && !result.isWicket && !isExtra) bowl.dotBalls++;
  }

  endInnings() {
    this.target = this.score1;
    this.innings = 2;
    this.overNumber = 0;
    this.ballNumber = 0;
    this.currentBatting = this.battingOrder2;
    this.currentBowling = this.bowlingOrder1;
    this.currentBatsmanIndex = 0;
    this.nonStrikerIndex = 1;
    this.nextBatsmanIndex = 2;
    this.currentBowlerIndex = 0;
    this.freeHitNext = false;

    const commentary = this.isSuperOver
      ? `End of Super Over first innings. Score: ${this.score1}/${this.wickets1}. Target: ${this.target + 1}`
      : `End of first innings. Score: ${this.score1}/${this.wickets1}. Target: ${this.target + 1}`;

    return {
      innings: 1,
      overNumber: this.overNumber,
      ballNumber: 0,
      eventType: 'innings_break',
      runs: 0,
      isBoundary: false,
      isWicket: false,
      wicketType: null,
      commentary,
      scoreAfter: this.score1,
      wicketsAfter: this.wickets1,
    };
  }

  startSuperOver() {
    this.isSuperOver = true;
    this.innings = 1;
    this.overNumber = 0;
    this.ballNumber = 0;
    this.score1 = 0;
    this.wickets1 = 0;
    this.score2 = 0;
    this.wickets2 = 0;
    this.target = 0;
    this.freeHitNext = false;

    this.currentBatting = this.battingOrder1;
    this.currentBowling = this.bowlingOrder2;
    this.currentBatsmanIndex = 0;
    this.nonStrikerIndex = 1;
    this.nextBatsmanIndex = 2;
    this.currentBowlerIndex = 0;

    return {
      innings: 2,
      overNumber: 0,
      ballNumber: 0,
      eventType: 'super_over',
      runs: 0,
      isBoundary: false,
      isWicket: false,
      wicketType: null,
      commentary: `Match tied! SUPER OVER to decide the winner!`,
      scoreAfter: 0,
      wicketsAfter: 0,
    };
  }

  getMatchResult() {
    const battingFirstName = this.homeBatsFirst ? this.homeTeamName : this.awayTeamName;
    const battingSecondName = this.homeBatsFirst ? this.awayTeamName : this.homeTeamName;
    
    if (this.isSuperOver) {
      if (this.score2 > this.score1) {
        return `${battingSecondName} wins the Super Over by ${10 - this.wickets2} wickets!`;
      } else if (this.score1 > this.score2) {
        return `${battingFirstName} wins the Super Over by ${this.score1 - this.score2} runs!`;
      }
      return `${battingSecondName} wins the Super Over!`;
    }
    
    if (this.score2 > this.score1) {
      return `${battingSecondName} wins by ${10 - this.wickets2} wickets!`;
    } else if (this.score1 > this.score2) {
      return `${battingFirstName} wins by ${this.score1 - this.score2} runs!`;
    }
    return 'Match tied!';
  }

  calculateOutcome(battingRating, bowlingRating, chemistry, batsman, bowler) {
    // Extract all player attributes with defaults
    const batAggression  = batsman.aggression  ?? battingRating;
    const batTechnique   = batsman.technique   ?? battingRating;
    const batPower       = batsman.power       ?? battingRating;
    const batConsistency = batsman.consistency ?? battingRating;
    const batStamina     = batsman.stamina     ?? battingRating;
    const batTemperament= batsman.temperament ?? battingRating;
    const batShotMaking  = batsman.shot_making ?? battingRating;
    const batRunning     = batsman.running     ?? battingRating;

    const bowlPace       = bowler.pace         ?? bowlingRating;
    const bowlAccuracy   = bowler.accuracy     ?? bowlingRating;
    const bowlVariations = bowler.variations   ?? bowlingRating;
    const bowlSpin       = bowler.spin         ?? bowlingRating;
    const bowlYorkers    = bowler.yorkers      ?? bowlingRating;
    const bowlBouncer    = bowler.bouncer       ?? bowlingRating;

    // Base probability distribution
    let probs = {
      dot: 0.28, single: 0.28, double: 0.10, triple: 0.02,
      four: 0.15, six: 0.08, wicket: 0.06, wide: 0.015, no_ball: 0.015,
    };

    // ── 1. BATSMAN vs BOWLER MATCHUP (biggest factor) ──────────────────────────
    const matchupScore = battingRating - bowlingRating;
    const matchupNorm  = matchupScore / 100; // -1 to +1 roughly

    // Batting advantage → more boundaries, fewer wickets
    probs.four   += 0.12 * matchupNorm;
    probs.six    += 0.09 * matchupNorm;
    probs.dot    -= 0.10 * matchupNorm;
    probs.wicket -= 0.06 * matchupNorm;
    probs.single += 0.03 * matchupNorm;

    // Bowling advantage → more dots, more wickets
    if (matchupNorm < -0.2) {
      probs.dot    += 0.08;
      probs.wicket += 0.05;
      probs.four   -= 0.06;
      probs.six    -= 0.04;
    }

    // ── 2. BATTING ATTRIBUTES ─────────────────────────────────────────────────
    // Aggression: more risk, more boundaries, more wickets
    probs.six    += (batAggression / 1000) * 1.5;
    probs.four   += (batAggression / 1000) * 1.0;
    probs.wicket += (batAggression / 1000) * 0.8;
    probs.dot    -= (batAggression / 1000) * 1.2;

    // Technique: reduces wickets, more singles/doubles
    probs.wicket -= (batTechnique / 1000) * 1.2;
    probs.single += (batTechnique / 1000) * 0.8;
    probs.double += (batTechnique / 1000) * 0.5;
    probs.triple += (batTechnique / 1000) * 0.2;

    // Power: more sixes and fours, slightly more wickets
    probs.six    += (batPower / 1000) * 1.5;
    probs.four   += (batPower / 1000) * 1.0;
    probs.wicket += (batPower / 1000) * 0.3;

    // Consistency: reduces dot balls, reduces wickets
    probs.dot    -= (batConsistency / 1000) * 1.0;
    probs.wicket -= (batConsistency / 1000) * 1.0;
    probs.single += (batConsistency / 1000) * 0.6;

    // Stamina: affects late overs performance
    const oversRemaining = this.maxOvers - this.overNumber;
    if (oversRemaining <= 5) {
      const staminaFactor = batStamina / 100;
      probs.six    += 0.03 * staminaFactor;
      probs.four   += 0.02 * staminaFactor;
      probs.wicket -= 0.02 * staminaFactor;
    }

    // Temperament: handles pressure situations (chase, death overs)
    if (!this.isFirstInnings && this.target > 0) {
      const pressure = this.getChasePressure();
      if (pressure > 0.5) {
        probs.wicket += (1 - batTemperament / 100) * pressure * 0.1;
        probs.dot    += (1 - batTemperament / 100) * pressure * 0.05;
      }
    }

    // Shot Making: more boundaries, fewer dots
    probs.four   += (batShotMaking / 1000) * 0.8;
    probs.six    += (batShotMaking / 1000) * 0.6;
    probs.dot    -= (batShotMaking / 1000) * 0.8;

    // Running: affects singles and doubles
    probs.single += (batRunning / 1000) * 0.5;
    probs.double += (batRunning / 1000) * 0.3;
    probs.triple += (batRunning / 1000) * 0.2;

    // ── 3. BOWLING ATTRIBUTES ─────────────────────────────────────────────────
    // Pace: more wickets, more dot balls (bounce/speed)
    probs.wicket += (bowlPace / 1000) * 1.0;
    probs.dot    += (bowlPace / 1000) * 0.5;
    probs.six    -= (bowlPace / 1000) * 0.4;

    // Accuracy: fewer wides/no-balls, more dots, more wickets
    probs.dot    += (bowlAccuracy / 1000) * 1.2;
    probs.wicket += (bowlAccuracy / 1000) * 0.8;
    probs.wide   -= (bowlAccuracy / 1000) * 0.5;
    probs.no_ball -= (bowlAccuracy / 1000) * 0.4;

    // Variations: more wickets, fewer easy runs
    probs.wicket += (bowlVariations / 1000) * 0.8;
    probs.four   -= (bowlVariations / 1000) * 0.3;
    probs.six    -= (bowlVariations / 1000) * 0.2;

    // Spin: affects dot balls and wickets on turning tracks
    if (this.pitchCondition === 'spin_friendly' || this.pitchCondition === 'dusty') {
      probs.wicket += (bowlSpin / 1000) * 1.5;
      probs.dot    += (bowlSpin / 1000) * 1.0;
      probs.six    -= (bowlSpin / 1000) * 0.5;
    }

    // Yorkers: reduces boundaries, increases wickets
    probs.four   -= (bowlYorkers / 1000) * 0.8;
    probs.six    -= (bowlYorkers / 1000) * 0.6;
    probs.wicket += (bowlYorkers / 1000) * 0.8;
    probs.dot    += (bowlYorkers / 1000) * 0.4;

    // Bouncer: more wickets, fewer singles
    probs.wicket += (bowlBouncer / 1000) * 0.6;
    probs.single -= (bowlBouncer / 1000) * 0.4;
    probs.six    += (bowlBouncer / 1000) * 0.3;

    // ── 4. OVERS SITUATION ─────────────────────────────────────────────────────
    const powerplayEnd  = Math.min(10, Math.floor(this.maxOvers * 0.3));
    const middleEnd     = Math.floor(this.maxOvers * 0.7);
    const deathEnd      = Math.floor(this.maxOvers * 0.9);

    if (this.overNumber >= deathEnd) {
      // Death overs: more boundaries, more wickets, fewer dots
      probs.six    += 0.06; probs.four += 0.04; probs.wicket += 0.04;
      probs.dot    -= 0.06; probs.single -= 0.03;
    } else if (this.overNumber >= middleEnd) {
      // Middle/death transition
      probs.six    += 0.03; probs.four += 0.02;
      probs.wicket += 0.02; probs.dot -= 0.03;
    } else if (this.overNumber < powerplayEnd) {
      // Powerplay: more boundaries, fewer wickets
      probs.four   += 0.04; probs.six += 0.03;
      probs.wicket -= 0.02; probs.dot -= 0.02;
    } else {
      // Middle overs: more singles, more dots
      probs.single += 0.06; probs.double += 0.02;
      probs.dot    += 0.03; probs.six    -= 0.02;
    }

    // ── 5. CHASE PRESSURE ─────────────────────────────────────────────────────
    if (!this.isFirstInnings && this.target > 0) {
      const pressure = this.getChasePressure();
      if (pressure > 0.6) {
        probs.six    += 0.08; probs.four += 0.05;
        probs.wicket += 0.06; probs.dot  -= 0.10;
      } else if (pressure > 0.3) {
        probs.six    += 0.04; probs.four += 0.03;
        probs.wicket += 0.03; probs.dot  -= 0.05;
      } else if (pressure < -0.3) {
        // Comfortable chase
        probs.single += 0.06; probs.dot  += 0.04;
        probs.six    -= 0.03; probs.wicket -= 0.02;
      }
    }

    // ── 6. WICKETS IN HAND ─────────────────────────────────────────────────────
    const wicketsLeft = 10 - this.currentWickets;
    if (wicketsLeft <= 2) {
      probs.wicket += 0.06; probs.dot += 0.06;
      probs.six    -= 0.04; probs.four -= 0.03;
    } else if (wicketsLeft <= 4) {
      probs.wicket += 0.03; probs.dot += 0.03;
    }

    // ── 7. PITCH CONDITIONS ────────────────────────────────────────────────────
    switch (this.pitchCondition) {
      case 'batting_friendly': case 'flat':
        probs.four   += 0.06; probs.six += 0.06;
        probs.wicket -= 0.04; probs.dot -= 0.04;
        break;
      case 'bowling_friendly': case 'green':
        probs.wicket += 0.06; probs.dot += 0.06;
        probs.four   -= 0.04; probs.six -= 0.04;
        break;
      case 'spin_friendly': case 'dusty':
        probs.wicket += 0.04; probs.dot += 0.05;
        probs.six    -= 0.03;
        break;
    }

    // ── 8. TEAM CHEMISTRY ─────────────────────────────────────────────────────
    const chemMod = chemistry / 500;
    probs.four   += chemMod * 0.03;
    probs.six    += chemMod * 0.015;
    probs.wicket -= chemMod * 0.03;

    // ── 9. NORMALIZE & CLAMP ───────────────────────────────────────────────────
    probs.dot    = clamp(probs.dot,    0.03, 0.55);
    probs.single = clamp(probs.single, 0.08, 0.42);
    probs.double = clamp(probs.double, 0.02, 0.18);
    probs.triple = clamp(probs.triple,  0.003, 0.06);
    probs.four   = clamp(probs.four,   0.01, 0.28);
    probs.six    = clamp(probs.six,    0.005, 0.18);
    probs.wicket = clamp(probs.wicket, 0.01, 0.22);
    probs.wide   = clamp(probs.wide,   0.003, 0.06);
    probs.no_ball= clamp(probs.no_ball, 0.003, 0.04);

    const total = Object.values(probs).reduce((a, b) => a + b, 0);
    for (const key in probs) probs[key] /= total;

    const roll = Math.random();
    let cum = 0;
    for (const [outcome, prob] of Object.entries(probs)) {
      cum += prob;
      if (roll < cum) return outcome;
    }
    return 'dot';
  }

  getChasePressure() {
    if (this.target <= 0) return 0;
    const ballsRemaining = (this.maxOvers * 6) - (this.overNumber * 6 + this.ballNumber);
    if (ballsRemaining <= 0) return 1;
    const runsNeeded  = this.target + 1 - this.score2;
    const requiredRR  = (runsNeeded / ballsRemaining) * 6;
    const currentRR   = this.overNumber > 0 ? (this.score2 / this.overNumber) : 0;
    const diff        = requiredRR - currentRR;
    return clamp(diff / 6, -1, 1); // -1 = very comfortable, +1 = very pressured
  }

  swapStrike() {
    const temp = this.currentBatsmanIndex;
    this.currentBatsmanIndex = this.nonStrikerIndex;
    this.nonStrikerIndex = temp;
  }

  advanceBatsman() {
    if (this.nextBatsmanIndex < this.currentBatting.length) {
      this.currentBatsmanIndex = this.nextBatsmanIndex;
      this.nextBatsmanIndex++;
    }
  }

  randomWicketType() {
    return pick(['bowled', 'caught', 'lbw', 'run_out', 'stumped', 'caught_behind']);
  }

  pickFielder(wicketType, bowler) {
    if (wicketType === 'bowled' || wicketType === 'lbw') return null;
    const allFielders = this.isFirstInnings
      ? (this.homeBatsFirst ? this.awayXI : this.homeXI)
      : (this.homeBatsFirst ? this.homeXI : this.awayXI);
    if (wicketType === 'caught_behind' || wicketType === 'stumped') {
      const keepers = allFielders.filter(p => p.role === 'wicket_keeper');
      if (keepers.length > 0) return keepers[Math.floor(Math.random() * keepers.length)];
    }
    const candidates = allFielders.filter(p => p.userCardId !== bowler.userCardId);
    if (candidates.length === 0) return allFielders[Math.floor(Math.random() * allFielders.length)];
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  getFallbackCommentary(eventType, batsmanName, bowlerName, wicketType, fielderName, isFreeHit) {
    let commentary;
    const f = fielderName || 'the fielder';
    
    switch (eventType) {
      case 'dot_ball':
        commentary = pick([
          `${bowlerName} keeps it tight, dot ball.`,
          `Good length from ${bowlerName}, ${batsmanName} defends.`,
          `${bowlerName} on the mark, ${batsmanName} can't find a gap.`,
          `Tight line from ${bowlerName}. No run.`,
          `${batsmanName} pushes at it but can't beat the field.`,
          `${bowlerName} darts it in, ${batsmanName} blocks.`,
          `Nothing doing. ${bowlerName} keeps it outside off.`,
        ]);
        break;
      case 'single':
        commentary = pick([
          `${batsmanName} pushes for a quick single.`,
          `${batsmanName} works it to the on side, easy single.`,
          `${batsmanName} dabs it and rotates the strike.`,
          `Single taken. ${batsmanName} keeps the scoreboard ticking.`,
          `${batsmanName} flicks off the pads for one.`,
        ]);
        break;
      case 'double':
        commentary = pick([
          `${batsmanName} drives through the gap for two.`,
          `Placed well by ${batsmanName}! Two runs.`,
          `${batsmanName} punches it through cover — two!`,
          `${batsmanName} works it into the deep — hustled two!`,
        ]);
        break;
      case 'triple':
        commentary = pick([
          `${batsmanName} finds the gap, they run three!`,
          `Three runs! Excellent running between the wickets!`,
          `${batsmanName} drives and they take three!`,
        ]);
        break;
      case 'four':
        commentary = pick([
          `FOUR! ${batsmanName} drives beautifully!`,
          `FOUR! ${batsmanName} times it to perfection!`,
          `FOUR! ${batsmanName} finds the gap, races to the boundary!`,
          `FOUR! Cracking shot from ${batsmanName}!`,
          `FOUR! ${batsmanName} threads it through the off side!`,
          `FOUR! Short from ${bowlerName} and ${batsmanName} pulls it away!`,
        ]);
        break;
      case 'six':
        commentary = pick([
          `SIX! ${batsmanName} launches it into the stands!`,
          `SIX! Massive hit from ${batsmanName}!`,
          `SIX! ${batsmanName} clears the rope with ease!`,
          `SIX! ${batsmanName} steps down and deposits it into the crowd!`,
          `SIX! ${batsmanName} picks the length and smashes it downtown!`,
        ]);
        break;
      case 'wicket':
        if (isFreeHit) {
          commentary = pick([
            `${batsmanName} misses but it's a FREE HIT! No wicket!`,
            `That would have been out! But free hit saves ${batsmanName}!`,
          ]);
        } else {
          switch (wicketType) {
            case 'bowled':
              commentary = pick([
                `BOWLED! ${bowlerName} knocks back the stumps! ${batsmanName} is stunned!`,
                `TIMBER! The stump is cartwheeling! ${batsmanName} has to go!`,
                `Clean bowled! Brilliant from ${bowlerName}!`,
              ]);
              break;
            case 'caught':
              commentary = pick([
                `CAUGHT! ${f} takes a sharp catch! ${batsmanName} is gone!`,
                `OUT! ${batsmanName} holes out to ${f}!`,
                `CAUGHT! Taken cleanly by ${f}! ${bowlerName} strikes!`,
              ]);
              break;
            case 'lbw':
              commentary = pick([
                `LBW! Trapped in front! ${batsmanName} is plumb!`,
                `OUT! LBW! Dead straight from ${bowlerName}!`,
              ]);
              break;
            case 'run_out':
              commentary = pick([
                `RUN OUT! ${batsmanName} is short of the crease!`,
                `RUN OUT! Direct hit! ${batsmanName} has to go!`,
              ]);
              break;
            case 'stumped':
              commentary = pick([
                `STUMPED! ${batsmanName} charges down and misses!`,
                `STUMPED! Lightning quick work behind the stumps!`,
              ]);
              break;
            case 'caught_behind':
              commentary = pick([
                `CAUGHT BEHIND! Thin edge and ${f} takes it!`,
                `OUT! Feather edge! ${batsmanName} is dismissed!`,
              ]);
              break;
            default:
              commentary = `OUT! ${bowlerName} strikes! ${batsmanName} has to walk back.`;
          }
        }
        break;
      case 'wide':
        commentary = pick([
          `Wide ball from ${bowlerName}. Extra run.`,
          `Too wide! ${bowlerName} strays down the leg side.`,
          `Wide called. ${bowlerName} needs to tighten up.`,
        ]);
        break;
      case 'no_ball':
        commentary = pick([
          `NO BALL! ${bowlerName} oversteps! FREE HIT next!`,
          `NO BALL! ${bowlerName} has overstepped! Free hit coming!`,
          `That's a no ball! Free hit for ${batsmanName}!`,
        ]);
        break;
      default:
        commentary = 'Dot ball.';
    }
    
    if (isFreeHit && eventType !== 'no_ball' && eventType !== 'wicket') {
      commentary += ' (Free Hit)';
    }
    
    return commentary;
  }

  serialize() {
    return {
      matchId: this.matchId,
      homeXI: this.homeXI,
      awayXI: this.awayXI,
      homeChemistry: this.homeChemistry,
      awayChemistry: this.awayChemistry,
      maxOvers: this.maxOvers,
      pitchCondition: this.pitchCondition,
      homeTeamName: this.homeTeamName,
      awayTeamName: this.awayTeamName,
      homeBatsFirst: this.homeBatsFirst,
      innings: this.innings,
      overNumber: this.overNumber,
      ballNumber: this.ballNumber,
      score1: this.score1,
      wickets1: this.wickets1,
      score2: this.score2,
      wickets2: this.wickets2,
      target: this.target,
      matchComplete: this.matchComplete,
      isSuperOver: this.isSuperOver,
      freeHitNext: this.freeHitNext,
      batsmanStats: this.batsmanStats,
      bowlerStats: this.bowlerStats,
      commentaryLog: this.commentaryLog,
    };
  }
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

module.exports = MatchEngine;
