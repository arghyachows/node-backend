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
    this.useAICommentary = config.useAICommentary !== false;

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
    this.bowlingOrder1 = (this.homeBatsFirst ? this.homeXI : this.awayXI).filter(
      p => p.role === 'bowler' || p.role === 'all_rounder'
    );
    if (this.bowlingOrder1.length === 0) {
      this.bowlingOrder1 = [...(this.homeBatsFirst ? this.homeXI : this.awayXI)];
    }

    this.battingOrder2 = [...(this.homeBatsFirst ? this.awayXI : this.homeXI)];
    this.bowlingOrder2 = (this.homeBatsFirst ? this.awayXI : this.homeXI).filter(
      p => p.role === 'bowler' || p.role === 'all_rounder'
    );
    if (this.bowlingOrder2.length === 0) {
      this.bowlingOrder2 = [...(this.homeBatsFirst ? this.awayXI : this.homeXI)];
    }

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

      // Add to commentary log (last 20 balls)
      this.commentaryLog.push({
        commentary: result.commentary,
        eventType: result.eventType,
        runs: result.runs,
        innings: result.innings,
        overNumber: result.overNumber,
        ballNumber: result.ballNumber,
      });
      if (this.commentaryLog.length > 20) {
        this.commentaryLog.shift();
      }

      // Emit to WebSocket room
      this.io.to(this.matchId).emit('ballUpdate', {
        matchId: this.matchId,
        result,
        state: this.getState(),
        commentaryLog: this.commentaryLog,
      });

      // Save state to Redis
      await setMatchState(this.matchId, this.serialize());

      // Publish to Redis pub/sub
      await publishMatchUpdate(this.matchId, { result, state: this.getState() });

      // Schedule next ball
      this.timer = setTimeout(() => this.loop(), 1000);
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
      matchComplete: this.matchComplete,
      isSuperOver: this.isSuperOver,
      batsmanStats: this.batsmanStats,
      bowlerStats: this.bowlerStats,
      currentBatsman: this.currentBatsman?.name,
      nonStriker: this.nonStriker?.name,
      currentBowler: this.currentBowler?.name,
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

    // Generate commentary (AI for important events only)
    const useAI = this.useAICommentary && ['wicket', 'four', 'six', 'no_ball'].includes(eventType);
    
    if (useAI) {
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
        });
      } catch (error) {
        logger.error('AI commentary failed:', error);
        commentary = this.getFallbackCommentary(eventType, batsmanName, bowlerName, wicketType, fielderName, isFreeHit);
      }
    } else {
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
    let probs = {
      dot: 0.30, single: 0.30, double: 0.10, triple: 0.02,
      four: 0.15, six: 0.08, wicket: 0.05, wide: 0.015, no_ball: 0.015,
    };

    const matchupScore = battingRating - bowlingRating;
    const normalized = matchupScore / 100;

    probs.four += 0.1 * normalized;
    probs.six += 0.08 * normalized;
    probs.dot -= 0.1 * normalized;
    probs.wicket -= 0.05 * normalized;
    probs.single += 0.03 * normalized;

    const total = Object.values(probs).reduce((a, b) => a + b, 0);
    for (const key in probs) {
      probs[key] /= total;
    }

    const roll = Math.random();
    let cum = 0;
    for (const [outcome, prob] of Object.entries(probs)) {
      cum += prob;
      if (roll < cum) return outcome;
    }
    return 'dot';
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
    
    switch (eventType) {
      case 'dot_ball':
        commentary = pick([
          `${bowlerName} keeps it tight, dot ball.`,
          `Good length from ${bowlerName}, ${batsmanName} defends.`,
        ]);
        break;
      case 'single':
        commentary = `${batsmanName} pushes for a quick single.`;
        break;
      case 'double':
        commentary = `${batsmanName} drives through the gap for two.`;
        break;
      case 'triple':
        commentary = `${batsmanName} finds the gap, they run three!`;
        break;
      case 'four':
        commentary = `FOUR! ${batsmanName} drives beautifully!`;
        break;
      case 'six':
        commentary = `SIX! ${batsmanName} launches it into the stands!`;
        break;
      case 'wicket':
        commentary = isFreeHit 
          ? `${batsmanName} misses but it's a FREE HIT! No wicket!`
          : `OUT! ${bowlerName} strikes! ${batsmanName} has to walk back.`;
        break;
      case 'wide':
        commentary = `Wide ball from ${bowlerName}. Extra run.`;
        break;
      case 'no_ball':
        commentary = `NO BALL! ${bowlerName} oversteps! FREE HIT next!`;
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

module.exports = MatchEngine;
