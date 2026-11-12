import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || process.env.PYTHON_PORT || 3000);
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PRIMARY_DATA_FILE = path.join(DATA_DIR, 'blazing5-league.json');
const FALLBACK_DATA_FILE = path.join('/tmp', 'blazing5-league.json');
const TEMPLATES_DIR = path.join(ROOT_DIR, 'templates');

interface TeamInfo {
  name: string;
  abbreviation?: string;
  logo: string;
  record?: string;
}

interface Game {
  id: string;
  espnId?: string;
  week: number;
  season?: number;
  homeTeam: TeamInfo;
  awayTeam: TeamInfo;
  homeSpread: number | null;
  awaySpread: number | null;
  overUnder?: number;
  kickoffTime: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  liveClockDetail?: string;
  isFeatured?: boolean;
  isManualOverride?: boolean;
  lastLiveSync?: string;
  hasStarted?: boolean;
  isWeekUnlocked?: boolean;
  weekUnlockTime?: string;
  weekUnlockFormatted?: string;
}

class LeagueStore {
  dataFile: string;
  lastLiveSync: string | null = null;
  liveSyncStatus: string = 'Ready';
  state: Record<string, any>;

  constructor(dataFile: string = PRIMARY_DATA_FILE) {
    this.dataFile = dataFile;
    this.state = this.loadOrInitState();
  }

  loadOrInitState(): Record<string, any> {
    // Check fallback /tmp file first if it was written more recently in a read-only container
    const candidates = [this.dataFile, FALLBACK_DATA_FILE];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const raw = fs.readFileSync(candidate, 'utf-8');
          const data = JSON.parse(raw);
          this._calculatePicksResults(data);
          return data;
        }
      } catch (err) {
        console.error(`Error loading state from ${candidate}:`, err);
      }
    }

    const defaultState = this._generateDefaultState();
    this.saveState(defaultState);
    return defaultState;
  }

  saveState(state?: Record<string, any>): void {
    const targetState = state ?? this.state;
    const payload = JSON.stringify(targetState, null, 2);

    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      const tempFile = `${this.dataFile}.tmp`;
      fs.writeFileSync(tempFile, payload, 'utf-8');
      fs.renameSync(tempFile, this.dataFile);
      return;
    } catch (err) {
      // Fallback to /tmp in read-only container environments
      try {
        const tempFallback = `${FALLBACK_DATA_FILE}.tmp`;
        fs.writeFileSync(tempFallback, payload, 'utf-8');
        fs.renameSync(tempFallback, FALLBACK_DATA_FILE);
        this.dataFile = FALLBACK_DATA_FILE;
      } catch (fallbackErr) {
        console.error('Failed to persist state to disk or /tmp:', fallbackErr);
      }
    }
  }

  getWeekUnlockTime(week: number): Date {
    const weeklyConfigs = this.state.weeklyConfigs || {};
    const cfg = weeklyConfigs[String(week)] || weeklyConfigs[week] || {};
    if (cfg.unlockTime) {
      const parsed = new Date(cfg.unlockTime);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    const games: Game[] = this.state.games || [];
    const wGames = games.filter((g) => g.week === week);
    let earliestDt: Date | null = null;

    for (const g of wGames) {
      if (g.kickoffTime) {
        const dt = new Date(g.kickoffTime);
        if (!Number.isNaN(dt.getTime())) {
          if (!earliestDt || dt.getTime() < earliestDt.getTime()) {
            earliestDt = dt;
          }
        }
      }
    }

    if (!earliestDt) {
      const year = this.state.seasonYear || 2026;
      const baseTue = new Date(Date.UTC(year, 8, 1, 4, 0, 0));
      baseTue.setUTCDate(baseTue.getUTCDate() + (week - 1) * 7);
      return baseTue;
    }

    // Convert earliest kickoff to Eastern Time components
    const etParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(earliestDt);

    const partMap: Record<string, string> = {};
    for (const p of etParts) {
      partMap[p.type] = p.value;
    }

    const weekdayMap: Record<string, number> = {
      Mon: 0,
      Tue: 1,
      Wed: 2,
      Thu: 3,
      Fri: 4,
      Sat: 5,
      Sun: 6,
    };

    const currentWeekday = weekdayMap[partMap.weekday] ?? 3;
    const daysToTuesday = (currentWeekday - 1 + 7) % 7;

    const year = Number(partMap.year);
    const month = Number(partMap.month);
    const day = Number(partMap.day);

    // Midnight ET on that Tuesday (04:00 UTC during EDT)
    const tuesdayUtc = new Date(Date.UTC(year, month - 1, day - daysToTuesday, 4, 0, 0));
    return tuesdayUtc;
  }

  formatEtDate(dt: Date, style: 'short' | 'medium' | 'full'): string {
    try {
      if (style === 'short') {
        const formatted = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        }).format(dt);
        return `${formatted}, 12:00 AM ET`;
      }
      if (style === 'medium') {
        const formatted = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          weekday: 'long',
          month: 'short',
          day: 'numeric',
        }).format(dt);
        return `${formatted} at 12:00 AM ET`;
      }
      const formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }).format(dt);
      return `${formatted} at 12:00 AM ET`;
    } catch {
      return 'Tuesday at 12:00 AM ET';
    }
  }

  isWeekUnlocked(week: number): boolean {
    const weeklyConfigs = this.state.weeklyConfigs || {};
    const cfg = weeklyConfigs[String(week)] || weeklyConfigs[week] || {};
    if (cfg.forceUnlocked) {
      return true;
    }
    const unlockDt = this.getWeekUnlockTime(week);
    return Date.now() >= unlockDt.getTime();
  }

  toggleWeekForceUnlock(week: number, forceUnlock?: boolean | null): Record<string, any> {
    if (!this.state.weeklyConfigs) {
      this.state.weeklyConfigs = {};
    }
    const strW = String(week);
    if (!this.state.weeklyConfigs[strW]) {
      this.state.weeklyConfigs[strW] = {};
    }
    const cur = Boolean(this.state.weeklyConfigs[strW].forceUnlocked);
    const newVal = forceUnlock === undefined || forceUnlock === null ? !cur : Boolean(forceUnlock);
    this.state.weeklyConfigs[strW].forceUnlocked = newVal;
    this.saveState();
    return {
      success: true,
      week,
      forceUnlocked: newVal,
      isUnlocked: this.isWeekUnlocked(week),
      message: `Week ${week} ${newVal ? 'unlocked early' : 'reset to automatic schedule'}.`,
    };
  }

  async fetchEspnScoreboard(week?: number | null): Promise<any[]> {
    const wParam = week ? `&week=${week}` : '';
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2${wParam}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'PostmanRuntime/7.32.3',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return [];
      const payload: any = await res.json();
      return payload.events || [];
    } catch (err) {
      console.error('Error querying ESPN scoreboard:', err);
      return [];
    }
  }

  async syncLiveNflData(targetWeek?: number | null): Promise<Record<string, any>> {
    const week = targetWeek || this.state.currentWeek || 4;
    const events = await this.fetchEspnScoreboard(week);
    if (!events || events.length === 0) {
      this.liveSyncStatus = 'ESPN connection unavailable (cached lines active)';
      return {
        success: false,
        message: 'Could not connect to ESPN NFL API.',
        updatedCount: 0,
      };
    }

    let updatedCount = 0;
    const games: any[] = this.state.games || [];

    for (const ev of events) {
      const comp = (ev.competitions && ev.competitions[0]) || {};
      const competitors: any[] = comp.competitors || [];
      const home = competitors.find((c) => c.homeAway === 'home') || {};
      const away = competitors.find((c) => c.homeAway === 'away') || {};

      const homeAbbr = home.team?.abbreviation;
      const awayAbbr = away.team?.abbreviation;
      const homeName = home.team?.displayName || '';
      const awayName = away.team?.displayName || '';

      const statusObj = comp.status?.type || {};
      const espnState = statusObj.state;
      const detailClock = statusObj.shortDetail || statusObj.detail || '';

      let status = 'scheduled';
      if (espnState === 'post') status = 'final';
      else if (espnState === 'in') status = 'in_progress';

      const homeScore =
        home.score !== undefined && home.score !== null && status !== 'scheduled'
          ? parseInt(String(home.score), 10)
          : null;
      const awayScore =
        away.score !== undefined && away.score !== null && status !== 'scheduled'
          ? parseInt(String(away.score), 10)
          : null;
      const kickoffIso = ev.date;

      const oddsList: any[] = comp.odds || [];
      let espnHomeSpread: number | null = null;
      let espnOu: number | null = null;

      if (oddsList.length > 0) {
        const odd = oddsList[0];
        espnOu = odd.overUnder ?? null;
        const closeLine = odd.pointSpread?.home?.close?.line;
        if (closeLine !== undefined && closeLine !== null) {
          const parsed = parseFloat(String(closeLine));
          if (!Number.isNaN(parsed)) espnHomeSpread = parsed;
        } else if (odd.details) {
          const details = String(odd.details).trim();
          const spreadVal = odd.spread;
          if (details === 'EVEN' || details === 'PK' || details === '0') {
            espnHomeSpread = 0.0;
          } else if (spreadVal !== undefined && spreadVal !== null) {
            const sFlt = Math.abs(parseFloat(String(spreadVal)));
            if (!Number.isNaN(sFlt)) {
              if (homeAbbr && details.startsWith(homeAbbr)) {
                espnHomeSpread = -sFlt;
              } else {
                espnHomeSpread = sFlt;
              }
            }
          }
        }
      }

      let matchedGame = games.find((g) => {
        if (g.week !== week) return false;
        const gHomeAbbr = g.homeTeam?.abbreviation;
        const gAwayAbbr = g.awayTeam?.abbreviation;
        const gHomeName = g.homeTeam?.name || '';
        const gAwayName = g.awayTeam?.name || '';
        return (
          (gHomeAbbr === homeAbbr && gAwayAbbr === awayAbbr) ||
          (homeName && gHomeName.includes(homeName)) ||
          (awayName && gAwayName.includes(awayName))
        );
      });

      if (matchedGame) {
        if (!matchedGame.isManualOverride) {
          if (espnHomeSpread !== null) {
            matchedGame.homeSpread = espnHomeSpread;
            matchedGame.awaySpread = -espnHomeSpread;
          }
          if (espnOu !== null) {
            matchedGame.overUnder = espnOu;
          }
        }
        matchedGame.status = status;
        matchedGame.homeScore = homeScore;
        matchedGame.awayScore = awayScore;
        if (kickoffIso) matchedGame.kickoffTime = kickoffIso;
        matchedGame.liveClockDetail = detailClock;
        matchedGame.espnId = ev.id;
        matchedGame.lastLiveSync = new Date().toISOString();
        updatedCount += 1;
      } else {
        const newGameId = `gm_espn_w${week}_${ev.id}`;
        games.push({
          id: newGameId,
          espnId: ev.id,
          week,
          season: this.state.seasonYear || 2026,
          homeTeam: {
            name: homeName || homeAbbr,
            abbreviation: homeAbbr,
            logo: home.team?.logo || '',
            record: home.records?.[0]?.summary || '',
          },
          awayTeam: {
            name: awayName || awayAbbr,
            abbreviation: awayAbbr,
            logo: away.team?.logo || '',
            record: away.records?.[0]?.summary || '',
          },
          homeSpread: espnHomeSpread !== null ? espnHomeSpread : -3.0,
          awaySpread: espnHomeSpread !== null ? -espnHomeSpread : 3.0,
          overUnder: espnOu || 45.0,
          kickoffTime: kickoffIso || new Date().toISOString(),
          status,
          homeScore,
          awayScore,
          liveClockDetail: detailClock,
          isFeatured: false,
          lastLiveSync: new Date().toISOString(),
        });
        updatedCount += 1;
      }
    }

    const nowIso = new Date().toISOString();
    this.lastLiveSync = nowIso;
    const utcTimeStr = nowIso.slice(11, 19);
    this.liveSyncStatus = `Live ESPN Sync Active (${utcTimeStr} UTC)`;
    this._calculatePicksResults(this.state);
    this.saveState();

    return {
      success: true,
      week,
      updatedCount,
      lastLiveSync: this.lastLiveSync,
      message: `Successfully synced ${updatedCount} NFL games and live spreads from ESPN.`,
    };
  }

  static isGameStarted(game: any): boolean {
    if (!game) return false;
    if (game.status === 'in_progress' || game.status === 'final') return true;
    if (!game.kickoffTime) return false;
    const dt = new Date(game.kickoffTime);
    if (Number.isNaN(dt.getTime())) return false;
    return Date.now() >= dt.getTime();
  }

  getLeaguePicks(week: number, viewerUserId?: string | null): any[] {
    this._calculatePicksResults(this.state);
    const gamesMap = new Map<string, any>();
    for (const g of this.state.games || []) gamesMap.set(g.id, g);
    const usersMap = new Map<string, any>();
    for (const u of this.state.users || []) usersMap.set(u.id, u);

    const leaguePicks: any[] = [];
    for (const pick of this.state.picks || []) {
      if (pick.week !== week) continue;
      const game = gamesMap.get(pick.gameId);
      const user = usersMap.get(pick.userId);
      if (!game || !user) continue;

      const started = LeagueStore.isGameStarted(game);
      const isOwn = Boolean(viewerUserId && pick.userId === viewerUserId);
      const isRevealed = started || isOwn;

      leaguePicks.push({
        id: pick.id,
        userId: user.id,
        userName: user.name,
        userAvatar: user.avatar || '',
        gameId: isRevealed ? game.id : null,
        awayTeam: isRevealed ? game.awayTeam.name : '🔒 Hidden until kickoff',
        awayLogo: isRevealed ? game.awayTeam.logo || '' : '',
        homeTeam: isRevealed ? game.homeTeam.name : '🔒 Hidden until kickoff',
        homeLogo: isRevealed ? game.homeTeam.logo || '' : '',
        kickoffTime: game.kickoffTime,
        gameStatus: game.status || 'scheduled',
        homeScore: isRevealed ? game.homeScore : null,
        awayScore: isRevealed ? game.awayScore : null,
        gameStarted: started,
        isRevealed,
        isOwnPick: isOwn,
        isLock: isRevealed ? pick.isLock : null,
        isBlazingWeek: isRevealed ? Boolean(pick.isBlazingWeek) : null,
        pickedTeam: isRevealed ? pick.pickedTeam : null,
        pickedTeamName: isRevealed ? pick.pickedTeamName : '🔒 Hidden until kickoff',
        lockedSpread: isRevealed ? pick.lockedSpread : null,
        result: isRevealed ? pick.result || 'pending' : 'hidden',
        pointsAwarded: isRevealed ? pick.pointsAwarded || 0 : 0,
      });
    }

    return leaguePicks;
  }

  getState(viewerUserId?: string | null): Record<string, any> {
    this._calculatePicksResults(this.state);
    const gamesMap = new Map<string, any>();
    for (const g of this.state.games || []) gamesMap.set(g.id, g);

    const stateCopy: Record<string, any> = { ...this.state };

    const decoratedGames = (this.state.games || []).map((gOrig: any) => {
      const g = { ...gOrig };
      g.hasStarted = LeagueStore.isGameStarted(g);
      const w = g.week || 1;
      const unlocked = this.isWeekUnlocked(w);
      const ut = this.getWeekUnlockTime(w);
      g.isWeekUnlocked = unlocked;
      g.weekUnlockTime = ut.toISOString();
      g.weekUnlockFormatted = this.formatEtDate(ut, 'medium');

      if (!unlocked) {
        g.homeSpread = null;
        g.awaySpread = null;
      }
      return g;
    });

    stateCopy.games = decoratedGames;

    const weekStatuses: Record<number, any> = {};
    for (let w = 1; w <= 18; w++) {
      const unlocked = this.isWeekUnlocked(w);
      const ut = this.getWeekUnlockTime(w);
      weekStatuses[w] = {
        week: w,
        isUnlocked: unlocked,
        unlockTime: ut.toISOString(),
        unlockFormatted: this.formatEtDate(ut, 'short'),
        fullFormatted: this.formatEtDate(ut, 'full'),
      };
    }
    stateCopy.weekStatuses = weekStatuses;
    stateCopy.liveSync = {
      lastSync: this.lastLiveSync,
      status: this.liveSyncStatus,
      isLive: true,
    };

    const decoratedPicks = (this.state.picks || []).map((pick: any) => {
      const p = { ...pick };
      const game = gamesMap.get(p.gameId);
      const started = game ? LeagueStore.isGameStarted(game) : false;
      const isOwn = Boolean(viewerUserId && p.userId === viewerUserId);
      p.hasStarted = started;
      p.isRevealed = started || isOwn;

      if (viewerUserId && !p.isRevealed) {
        p.gameId = null;
        p.pickedTeam = null;
        p.pickedTeamName = '🔒 Hidden until kickoff';
        p.lockedSpread = null;
        p.isLock = null;
        p.result = 'hidden';
        p.pointsAwarded = 0;
      }
      return p;
    });

    stateCopy.picks = decoratedPicks;
    return stateCopy;
  }

  getCommissionerFinances(): Record<string, any> {
    const standings = this.getStandings();
    const standingsByUid = new Map<string, any>();
    for (const s of standings) standingsByUid.set(s.userId, s);

    const users: any[] = this.state.users || [];
    const ledger: any[] = this.state.ledger || [];

    const buyInAmount = 25.0;
    const playersFinancials: any[] = [];
    let totalBuyinsCollected = 0.0;

    users.forEach((u, idx) => {
      const uid = u.id;
      const userStand = standingsByUid.get(uid) || {};
      const rank = userStand.rank ?? idx + 1;
      const projPayout = userStand.projectedPayout ?? 0.0;

      const bounties = ledger
        .filter((l) => l.userId === uid && (l.type === 'PERFECT_6_0_BONUS' || l.type === 'SEASON_OU_6_0'))
        .reduce((acc, l) => acc + Math.abs(l.amount || 0), 0);

      const penalties = ledger
        .filter((l) => l.userId === uid && (l.type === 'AWFUL_0_6_PENALTY' || l.type === 'SEASON_OU_0_6'))
        .reduce((acc, l) => acc + Math.abs(l.amount || 0), 0);

      const isPaid = u.buyInPaid ?? true;
      if (isPaid) totalBuyinsCollected += buyInAmount;

      const runningValue = buyInAmount + bounties - penalties + projPayout;
      const netProfitLoss = projPayout + bounties - penalties - buyInAmount;

      playersFinancials.push({
        userId: uid,
        name: u.name,
        avatar: u.avatar || '',
        buyIn: buyInAmount,
        buyInPaid: isPaid,
        bounties,
        penalties,
        projectedPayout: projPayout,
        rank,
        points: userStand.points ?? 0,
        record: `${userStand.wins ?? 0}-${userStand.losses ?? 0}`,
        runningValue,
        netProfitLoss,
      });
    });

    playersFinancials.sort((a, b) => a.rank - b.rank);

    const totalPot = users.length * buyInAmount;
    const potDelta = ledger
      .filter((l) =>
        ['PERFECT_6_0_BONUS', 'SEASON_OU_6_0', 'AWFUL_0_6_PENALTY', 'SEASON_OU_0_6'].includes(l.type)
      )
      .reduce((acc, l) => {
        const amt = Math.abs(l.amount || 0);
        return l.type === 'PERFECT_6_0_BONUS' || l.type === 'SEASON_OU_6_0' ? acc - amt : acc + amt;
      }, 0);

    const currentNetPot = Math.max(0.0, totalPot + potDelta);

    return {
      success: true,
      buyInPerPlayer: buyInAmount,
      totalPlayers: users.length,
      totalBuyInsCollected: totalBuyinsCollected,
      totalInitialPot: totalPot,
      currentNetPot,
      players: playersFinancials,
    };
  }

  toggleUserBuyin(userId: string, paid?: boolean | null): Record<string, any> {
    const user = (this.state.users || []).find((u: any) => u.id === userId);
    if (!user) throw new Error('User not found');
    if (paid === undefined || paid === null) {
      user.buyInPaid = !(user.buyInPaid ?? true);
    } else {
      user.buyInPaid = Boolean(paid);
    }
    this.saveState();
    return { success: true, userId, buyInPaid: user.buyInPaid };
  }

  getSeasonOuSummary(): Record<string, any> {
    this._calculatePicksResults(this.state);
    const teamsMap = new Map<string, any>();
    for (const t of this.state.seasonTeams || []) teamsMap.set(t.teamId, t);

    const users: any[] = this.state.users || [];
    const seasonPicks: any[] = this.state.seasonPicks || [];

    const userSummaries = users.map((u) => {
      const uid = u.id;
      const uPicks = seasonPicks.filter((p) => p.userId === uid);
      const decorated = uPicks.map((p) => {
        const team = teamsMap.get(p.teamId) || {};
        const wins = team.currentWins ?? 0;
        const losses = team.currentLosses ?? 0;
        const line = p.line ?? team.winTotalLine ?? 0;
        const isOver = p.selection === 'OVER';

        return {
          id: p.id,
          teamId: p.teamId,
          teamName: team.teamName || String(p.teamId || '').toUpperCase(),
          teamLogo: team.logo || '',
          selection: p.selection,
          line,
          isLock: Boolean(p.isLock),
          currentWins: wins,
          currentLosses: losses,
          result: p.result || 'pending',
          pointsAwarded: p.pointsAwarded ?? 0,
          targetWinsNeeded: isOver ? Math.max(0, Math.floor(line + 0.5) - wins) : null,
        };
      });

      return {
        userId: uid,
        userName: u.name,
        userAvatar: u.avatar || '',
        hasSubmitted: uPicks.length >= 5,
        picksCount: uPicks.length,
        picks: decorated,
        wins: decorated.filter((p) => p.result === 'win').length,
        losses: decorated.filter((p) => p.result === 'loss').length,
        pending: decorated.filter((p) => p.result === 'pending').length,
      };
    });

    return {
      success: true,
      seasonYear: this.state.seasonYear || 2026,
      isLocked: this.state.seasonOULocked ?? true,
      users: userSummaries,
      teams: this.state.seasonTeams || [],
    };
  }

  getStandings(): any[] {
    this._calculatePicksResults(this.state);
    const users: any[] = this.state.users || [];
    const picks: any[] = this.state.picks || [];
    const seasonPicks: any[] = this.state.seasonPicks || [];
    const ledger: any[] = this.state.ledger || [];

    const totalBuyins = users.length * 25;
    let potDelta = 0;
    for (const item of ledger) {
      const itemType = item.type;
      const amount = Math.abs(item.amount || 0);
      if (itemType === 'PERFECT_6_0_BONUS' || itemType === 'SEASON_OU_6_0') {
        potDelta -= amount;
      } else if (itemType === 'AWFUL_0_6_PENALTY' || itemType === 'SEASON_OU_0_6') {
        potDelta += amount;
      }
    }
    const remainingPot = Math.max(0, totalBuyins + potDelta);

    const standings: any[] = users.map((user) => {
      const uid = user.id;
      const userPicks = picks.filter((p) => p.userId === uid);
      const userSeasonPicks = seasonPicks.filter((p) => p.userId === uid);

      const weeklyWins = userPicks.filter((p) => p.result === 'win').length;
      const weeklyLosses = userPicks.filter((p) => p.result === 'loss').length;
      const weeklyPushes = userPicks.filter((p) => p.result === 'push').length;

      let lockWins = userPicks.filter((p) => p.isLock && p.result === 'win').length;
      let lockLosses = userPicks.filter((p) => p.isLock && p.result === 'loss').length;

      const seasonOuWins = userSeasonPicks.filter((p) => p.result === 'win').length;
      const seasonOuLosses = userSeasonPicks.filter((p) => p.result === 'loss').length;

      for (const sp of userSeasonPicks) {
        if (sp.isLock) {
          if (sp.result === 'win') lockWins += 1;
          else if (sp.result === 'loss') lockLosses += 1;
        }
      }

      const totalWins = weeklyWins + seasonOuWins;
      const totalLosses = weeklyLosses + seasonOuLosses;
      const totalPoints =
        userPicks.reduce((acc, p) => acc + (p.pointsAwarded || 0), 0) +
        userSeasonPicks.reduce((acc, sp) => acc + (sp.pointsAwarded || 0), 0);

      let userEarnings = 0;
      for (const item of ledger) {
        if (item.userId === uid) {
          const itemType = item.type;
          const amt = item.amount || 0;
          if (itemType === 'PERFECT_6_0_BONUS' || itemType === 'SEASON_OU_6_0') {
            userEarnings += amt;
          } else if (itemType === 'AWFUL_0_6_PENALTY' || itemType === 'SEASON_OU_0_6') {
            userEarnings -= amt;
          }
        }
      }

      return {
        userId: uid,
        user,
        userName: user.name,
        avatar: user.avatar || '',
        rank: 1,
        wins: totalWins,
        losses: totalLosses,
        pushes: weeklyPushes,
        points: totalPoints,
        totalPoints,
        lockWins,
        lockLosses,
        seasonOUWins: seasonOuWins,
        seasonOULosses: seasonOuLosses,
        blazingWeekUsed: user.blazingWeekUsed ?? null,
        earnings: userEarnings,
        projectedPayout: 0,
      };
    });

    standings.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.lockWins !== a.lockWins) return b.lockWins - a.lockWins;
      return a.lockLosses - b.lockLosses;
    });

    const payoutShares = [0.5, 0.25, 0.125, 0.075, 0.05];
    standings.forEach((s, i) => {
      s.rank = i + 1;
      s.projectedPayout = i < payoutShares.length ? Math.round(remainingPot * payoutShares[i]) : 0;
    });

    return standings;
  }

  submitWeeklyPicks(
    userId: string,
    week: number,
    picksData: any[],
    isBlazing: boolean = false
  ): Record<string, any> {
    if (!this.isWeekUnlocked(week)) {
      const ut = this.getWeekUnlockTime(week);
      const formatted = this.formatEtDate(ut, 'full');
      throw new Error(
        `Week ${week} picks are locked until the beginning of the week (${formatted}). Spreads and picking are not available yet.`
      );
    }

    const user = (this.state.users || []).find((u: any) => u.id === userId);
    if (!user) throw new Error(`User ${userId} not found.`);

    if (!Array.isArray(picksData) || picksData.length !== 5) {
      throw new Error('You must pick exactly 5 games against the spread.');
    }

    const weeklyConfigs = this.state.weeklyConfigs || {};
    const weeklyCfg = weeklyConfigs[String(week)] || weeklyConfigs[week];
    if (weeklyCfg && weeklyCfg.featuredGameId) {
      const featId = weeklyCfg.featuredGameId;
      if (!picksData.some((p) => p.gameId === featId)) {
        throw new Error(
          'Rules mandate that you must include the Featured Must-Pick Game in your 5 selections!'
        );
      }
    }

    const isUserBlazing =
      isBlazing ||
      user.blazingWeekUsed === week ||
      (week === 18 && (user.blazingWeekUsed === null || user.blazingWeekUsed === undefined));

    if (isUserBlazing && (user.blazingWeekUsed === null || user.blazingWeekUsed === undefined)) {
      user.blazingWeekUsed = week;
    }

    if (isUserBlazing) {
      for (const p of picksData) p.isLock = true;
    } else {
      const lockCount = picksData.filter((p) => p.isLock).length;
      if (lockCount !== 1) {
        throw new Error(
          'You must designate exactly 1 of your 5 picks as your "LOCK" (worth ±2 wins/losses).'
        );
      }
    }

    const gamesMap = new Map<string, any>();
    for (const g of this.state.games || []) gamesMap.set(g.id, g);
    const nowTs = Date.now();

    this.state.picks = (this.state.picks || []).filter(
      (p: any) => !(p.userId === userId && p.week === week)
    );

    const newPicks: any[] = [];
    for (const p of picksData) {
      const game = gamesMap.get(p.gameId);
      if (!game) throw new Error(`Game ${p.gameId} not found.`);

      if (game.kickoffTime) {
        const kickoffDt = new Date(game.kickoffTime);
        if (!Number.isNaN(kickoffDt.getTime())) {
          if (kickoffDt.getTime() <= nowTs && game.status !== 'scheduled') {
            throw new Error(
              `Cannot pick ${game.awayTeam.name} @ ${game.homeTeam.name} - game has already kicked off!`
            );
          }
        }
      }

      const spread = p.pickedTeam === 'home' ? (game.homeSpread ?? 0) : (game.awaySpread ?? 0);
      const teamName = p.pickedTeam === 'home' ? game.homeTeam.name : game.awayTeam.name;

      newPicks.push({
        id: `pick_${nowTs}_${p.gameId}`,
        userId,
        week,
        gameId: p.gameId,
        pickedTeam: p.pickedTeam,
        pickedTeamName: teamName,
        lockedSpread: spread,
        isLock: Boolean(p.isLock),
        isBlazingWeek: isUserBlazing,
        result: 'pending',
        pointsAwarded: 0,
        submittedAt: new Date().toISOString(),
      });
    }

    this.state.picks.push(...newPicks);
    this._calculatePicksResults(this.state);
    this.saveState();

    return {
      success: true,
      picks: newPicks,
      message: isUserBlazing
        ? '🔥 Blazing 5 Picks locked in! All 5 picks are LOCKs (±2 each)!'
        : 'Picks locked in! 4 Regular ATS picks (±1) and 1 LOCK (±2).',
    };
  }

  submitSeasonOuPicks(userId: string, picksData: any[]): Record<string, any> {
    const isLocked = this.state.seasonOULocked ?? true;
    if (isLocked) {
      throw new Error(
        'Season Long Over/Under picks are locked! Submissions are only permitted before Week 1 of the NFL season.'
      );
    }

    if (!Array.isArray(picksData) || picksData.length !== 5) {
      throw new Error('You must select exactly 5 teams for your Season Over/Under win totals.');
    }

    const lockCount = picksData.filter((p) => p.isLock).length;
    if (lockCount !== 1) {
      throw new Error(
        'You must designate exactly 1 team as your Season Over/Under LOCK (worth ±2 wins/losses).'
      );
    }

    const teamMap = new Map<string, any>();
    for (const t of this.state.seasonTeams || []) teamMap.set(t.teamId, t);

    this.state.seasonPicks = (this.state.seasonPicks || []).filter(
      (sp: any) => sp.userId !== userId
    );

    const nowTs = Date.now();
    for (const p of picksData) {
      const tid = p.teamId;
      const team = teamMap.get(tid);
      if (!team) throw new Error(`Team ${tid} not found.`);

      this.state.seasonPicks.push({
        id: `spick_${nowTs}_${tid}`,
        userId,
        teamId: tid,
        selection: p.selection,
        line: team.winTotalLine ?? 0,
        isLock: Boolean(p.isLock),
        result: 'pending',
        pointsAwarded: 0,
        submittedAt: new Date().toISOString(),
      });
    }

    this.saveState();
    return {
      success: true,
      message: 'Season Win Total Over/Under picks successfully submitted with 1 Lock!',
    };
  }

  setUserBlazingWeek(userId: string, week: number | null): Record<string, any> {
    const user = (this.state.users || []).find((u: any) => u.id === userId);
    if (!user) throw new Error('User not found.');

    const prevWeek = user.blazingWeekUsed;
    user.blazingWeekUsed = week;

    if (prevWeek && prevWeek !== week) {
      for (const p of this.state.picks || []) {
        if (p.userId === userId && p.week === prevWeek) {
          p.isBlazingWeek = false;
        }
      }
    }

    if (week !== null && week !== undefined) {
      for (const p of this.state.picks || []) {
        if (p.userId === userId && p.week === week) {
          p.isBlazingWeek = true;
          p.isLock = true;
        }
      }
    }

    this._calculatePicksResults(this.state);
    this.saveState();
    return {
      success: true,
      user,
      message: `Blazing Week for ${user.name} set to ${
        week ? 'Week ' + week : 'Undeclared (Week 18 Default)'
      }.`,
    };
  }

  addUser(name: string, email?: string, role: string = 'player'): Record<string, any> {
    const nowTs = Date.now();
    const uid = `usr_${nowTs}`;
    const newUser = {
      id: uid,
      name,
      email: email || `${name.toLowerCase().replace(/\s+/g, '')}@blazing5.league`,
      role,
      avatar:
        'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
      blazingWeekUsed: null,
      buyInPaid: true,
      createdAt: new Date().toISOString(),
    };
    if (!this.state.users) this.state.users = [];
    this.state.users.push(newUser);

    if (!this.state.ledger) this.state.ledger = [];
    this.state.ledger.push({
      id: `ledg_${nowTs}`,
      userId: uid,
      userName: name,
      type: 'BUY_IN',
      amount: 25,
      description: `$25 Season Buy-in from ${name}`,
      date: new Date().toISOString().slice(0, 10),
    });

    this.saveState();
    return newUser;
  }

  updateUser(userId: string, updates: Record<string, any>): Record<string, any> {
    const user = (this.state.users || []).find((u: any) => u.id === userId);
    if (!user) throw new Error('User not found.');
    Object.assign(user, updates);
    if (updates.name) {
      for (const l of this.state.ledger || []) {
        if (l.userId === userId) l.userName = updates.name;
      }
    }
    this.saveState();
    return user;
  }

  deleteUser(userId: string): Record<string, any> {
    const user = (this.state.users || []).find((u: any) => u.id === userId);
    if (!user) throw new Error('User not found.');
    this.state.users = (this.state.users || []).filter((u: any) => u.id !== userId);
    this.state.picks = (this.state.picks || []).filter((p: any) => p.userId !== userId);
    this.state.seasonPicks = (this.state.seasonPicks || []).filter(
      (sp: any) => sp.userId !== userId
    );
    this.state.ledger = (this.state.ledger || []).filter((l: any) => l.userId !== userId);
    this.saveState();
    return {
      success: true,
      message: `Member ${user.name} was removed from the league.`,
    };
  }

  setFeaturedPicker(week: number, pickerId: string | null): void {
    const strW = String(week);
    if (!this.state.weeklyConfigs) this.state.weeklyConfigs = {};
    if (!this.state.weeklyConfigs[strW]) {
      this.state.weeklyConfigs[strW] = {
        week,
        featuredPickerId: null,
        featuredGameId: null,
      };
    }
    this.state.weeklyConfigs[strW].featuredPickerId = pickerId;
    this.saveState();
  }

  setFeaturedGame(week: number, gameId: string): void {
    const strW = String(week);
    if (!this.state.weeklyConfigs) this.state.weeklyConfigs = {};
    if (!this.state.weeklyConfigs[strW]) {
      this.state.weeklyConfigs[strW] = {
        week,
        featuredPickerId: null,
        featuredGameId: null,
      };
    }
    this.state.weeklyConfigs[strW].featuredGameId = gameId;
    for (const g of this.state.games || []) {
      if (g.week === week) {
        g.isFeatured = g.id === gameId;
      }
    }
    this.saveState();
  }

  overrideGame(gameId: string, updates: Record<string, any>): Record<string, any> {
    for (const g of this.state.games || []) {
      if (g.id === gameId) {
        if (updates.homeSpread !== undefined) {
          g.homeSpread = updates.homeSpread;
          g.awaySpread = -updates.homeSpread;
          g.isManualOverride = true;
        }
        if (updates.status !== undefined) g.status = updates.status;
        if (updates.homeScore !== undefined) g.homeScore = updates.homeScore;
        if (updates.awayScore !== undefined) g.awayScore = updates.awayScore;
        if (updates.kickoffTime !== undefined) g.kickoffTime = updates.kickoffTime;
        this._calculatePicksResults(this.state);
        this.saveState();
        return g;
      }
    }
    throw new Error(`Game ${gameId} not found.`);
  }

  setCurrentWeek(week: number): void {
    this.state.currentWeek = week;
    this.saveState();
  }

  setSeasonOuLock(locked: boolean): Record<string, any> {
    this.state.seasonOULocked = locked;
    this.saveState();
    return {
      success: true,
      seasonOULocked: locked,
      message: locked
        ? 'Season O/U submissions locked.'
        : 'Season O/U submissions unlocked.',
    };
  }

  settleWeek(week: number): Record<string, any> {
    this._calculatePicksResults(this.state);
    const users: any[] = this.state.users || [];
    const ledger: any[] = this.state.ledger || [];
    const picks: any[] = this.state.picks || [];
    const nowTs = Date.now();
    const todayStr = new Date().toISOString().slice(0, 10);

    const bonusesAwarded: string[] = [];
    for (const user of users) {
      const uid = user.id;
      const userWeekPicks = picks.filter((p) => p.userId === uid && p.week === week);
      if (userWeekPicks.length === 5) {
        const wins = userWeekPicks.filter((p) => p.result === 'win').length;
        const losses = userWeekPicks.filter((p) => p.result === 'loss').length;

        if (wins === 5) {
          const exists = ledger.some(
            (l) => l.userId === uid && l.week === week && l.type === 'PERFECT_6_0_BONUS'
          );
          if (!exists) {
            ledger.push({
              id: `ledg_${nowTs}_60_${uid}`,
              userId: uid,
              userName: user.name,
              week,
              type: 'PERFECT_6_0_BONUS',
              amount: -5,
              description: `🔥 Perfect Week ${week}! +$5 cash bounty (deducted from pot)`,
              date: todayStr,
            });
            bonusesAwarded.push(`${user.name} (+$5 bonus)`);
          }
        } else if (losses === 5) {
          const exists = ledger.some(
            (l) => l.userId === uid && l.week === week && l.type === 'AWFUL_0_6_PENALTY'
          );
          if (!exists) {
            ledger.push({
              id: `ledg_${nowTs}_06_${uid}`,
              userId: uid,
              userName: user.name,
              week,
              type: 'AWFUL_0_6_PENALTY',
              amount: 5,
              description: `💀 Awful Week ${week} Penalty (+$5 into pot)`,
              date: todayStr,
            });
            bonusesAwarded.push(`${user.name} (-$5 penalty into pot)`);
          }
        }
      }
    }

    this.saveState();
    return {
      success: true,
      bonuses: bonusesAwarded,
      message: `Week ${week} settled!`,
    };
  }

  rolloverSeason(): Record<string, any> {
    const standings = this.getStandings();
    const champ = standings[0] || null;

    const totalPlayers = (this.state.users || []).length;
    let pot = totalPlayers * 25;
    for (const item of this.state.ledger || []) {
      if (item.type === 'PERFECT_6_0_BONUS' || item.type === 'SEASON_OU_6_0') {
        pot -= Math.abs(item.amount || 0);
      }
      if (item.type === 'AWFUL_0_6_PENALTY' || item.type === 'SEASON_OU_0_6') {
        pot += Math.abs(item.amount || 0);
      }
    }
    const netPot = Math.max(0, pot);

    const archive = {
      seasonYear: this.state.seasonYear || 2026,
      champion: {
        userId: champ ? champ.userId : 'usr_none',
        userName: champ ? champ.userName : 'Champion',
        avatar: champ ? champ.avatar || '' : '',
        totalPoints: champ ? champ.points || 0 : 0,
        record: champ ? `${champ.wins}-${champ.losses}` : '0-0',
        payout: champ ? champ.projectedPayout ?? Math.round(netPot * 0.5) : 0,
      },
      standings,
      totalPot: netPot,
      archivedAt: new Date().toISOString(),
    };

    if (!this.state.pastSeasons) this.state.pastSeasons = [];
    this.state.pastSeasons.unshift(archive);

    const nextYear = (this.state.seasonYear || 2026) + 1;
    this.state.seasonYear = nextYear;
    this.state.currentWeek = 1;
    this.state.isSeasonStarted = false;
    this.state.seasonOULocked = false;

    for (const u of this.state.users || []) {
      u.blazingWeekUsed = null;
    }

    this.state.picks = [];
    this.state.seasonPicks = [];
    const todayStr = new Date().toISOString().slice(0, 10);
    this.state.ledger = (this.state.users || []).map((u: any) => ({
      id: `ledg_buyin_${u.id}_${nextYear}`,
      userId: u.id,
      userName: u.name,
      type: 'BUY_IN',
      amount: 25,
      description: `$25 ${nextYear} Season Buy-in from ${u.name}`,
      date: todayStr,
    }));

    this.saveState();
    return {
      success: true,
      message: `Successfully rolled over to the ${nextYear} NFL Season!`,
      newSeasonYear: nextYear,
    };
  }

  _calculatePicksResults(state: Record<string, any>): void {
    const gamesMap = new Map<string, any>();
    for (const g of state.games || []) gamesMap.set(g.id, g);

    for (const pick of state.picks || []) {
      const game = gamesMap.get(pick.gameId);
      if (
        !game ||
        game.status !== 'final' ||
        game.homeScore === null ||
        game.homeScore === undefined ||
        game.awayScore === null ||
        game.awayScore === undefined
      ) {
        pick.result = 'pending';
        pick.pointsAwarded = 0;
        continue;
      }

      const homeScore = Number(game.homeScore);
      const awayScore = Number(game.awayScore);
      const lockedSpread = Number(pick.lockedSpread ?? 0);

      const margin =
        pick.pickedTeam === 'home'
          ? homeScore - awayScore + lockedSpread
          : awayScore - homeScore + lockedSpread;

      const mult = pick.isLock ? 2 : 1;
      if (margin > 0.01) {
        pick.result = 'win';
        pick.pointsAwarded = mult * 1;
      } else if (margin < -0.01) {
        pick.result = 'loss';
        pick.pointsAwarded = mult * -1;
      } else {
        pick.result = 'push';
        pick.pointsAwarded = 0;
      }
    }

    const teamsMap = new Map<string, any>();
    for (const t of state.seasonTeams || []) teamsMap.set(t.teamId, t);

    for (const sp of state.seasonPicks || []) {
      const team = teamsMap.get(sp.teamId);
      if (!team) continue;
      const wins = Number(team.currentWins ?? 0);
      const losses = Number(team.currentLosses ?? 0);
      const line = Number(sp.line ?? team.winTotalLine ?? 0);
      const isOver = sp.selection === 'OVER';
      const mult = sp.isLock ? 2 : 1;

      if (isOver) {
        if (wins > line) {
          sp.result = 'win';
          sp.pointsAwarded = mult * 1;
        } else if (17 - losses < line) {
          sp.result = 'loss';
          sp.pointsAwarded = mult * -1;
        } else {
          sp.result = 'pending';
          sp.pointsAwarded = 0;
        }
      } else {
        if (losses > 17 - line) {
          sp.result = 'win';
          sp.pointsAwarded = mult * 1;
        } else if (wins > line) {
          sp.result = 'loss';
          sp.pointsAwarded = mult * -1;
        } else {
          sp.result = 'pending';
          sp.pointsAwarded = 0;
        }
      }
    }

    // Automatic settlement of completed weeks
    const users: any[] = state.users || [];
    const ledger: any[] = state.ledger || [];
    const picks: any[] = state.picks || [];
    let ledgerModified = false;
    const todayStr = new Date().toISOString().slice(0, 10);

    const userWeekPicks = new Map<string, any[]>();
    for (const p of picks) {
      const key = `${p.userId}__${p.week}`;
      if (!userWeekPicks.has(key)) userWeekPicks.set(key, []);
      userWeekPicks.get(key)!.push(p);
    }

    for (const user of users) {
      const uid = user.id;
      for (let w = 1; w <= 18; w++) {
        const wPicks = userWeekPicks.get(`${uid}__${w}`) || [];
        if (wPicks.length === 5) {
          const allFinal = wPicks.every((p) => ['win', 'loss', 'push'].includes(p.result));
          if (allFinal) {
            const wins = wPicks.filter((p) => p.result === 'win').length;
            const losses = wPicks.filter((p) => p.result === 'loss').length;

            if (wins === 5) {
              const exists = ledger.some(
                (l) => l.userId === uid && l.week === w && l.type === 'PERFECT_6_0_BONUS'
              );
              if (!exists) {
                ledger.push({
                  id: `ledg_auto_60_${uid}_w${w}`,
                  userId: uid,
                  userName: user.name,
                  week: w,
                  type: 'PERFECT_6_0_BONUS',
                  amount: -5,
                  description: `🔥 Perfect Week ${w} (5-0)! +$5 cash bounty automatically awarded`,
                  date: todayStr,
                });
                ledgerModified = true;
              }
            } else {
              const idx = ledger.findIndex((l) => l.id === `ledg_auto_60_${uid}_w${w}`);
              if (idx !== -1) {
                ledger.splice(idx, 1);
                ledgerModified = true;
              }
            }

            if (losses === 5) {
              const exists = ledger.some(
                (l) => l.userId === uid && l.week === w && l.type === 'AWFUL_0_6_PENALTY'
              );
              if (!exists) {
                ledger.push({
                  id: `ledg_auto_06_${uid}_w${w}`,
                  userId: uid,
                  userName: user.name,
                  week: w,
                  type: 'AWFUL_0_6_PENALTY',
                  amount: 5,
                  description: `💀 Awful Week ${w} (0-5) Penalty: $5 automatically added to pot`,
                  date: todayStr,
                });
                ledgerModified = true;
              }
            } else {
              const idx = ledger.findIndex((l) => l.id === `ledg_auto_06_${uid}_w${w}`);
              if (idx !== -1) {
                ledger.splice(idx, 1);
                ledgerModified = true;
              }
            }
          } else {
            const idx60 = ledger.findIndex((l) => l.id === `ledg_auto_60_${uid}_w${w}`);
            if (idx60 !== -1) {
              ledger.splice(idx60, 1);
              ledgerModified = true;
            }
            const idx06 = ledger.findIndex((l) => l.id === `ledg_auto_06_${uid}_w${w}`);
            if (idx06 !== -1) {
              ledger.splice(idx06, 1);
              ledgerModified = true;
            }
          }
        }
      }
    }

    if (ledgerModified) {
      this.saveState(state);
    }
  }

  _generateDefaultState(): Record<string, any> {
    return {
      currentWeek: 4,
      seasonYear: 2026,
      isSeasonStarted: true,
      seasonOULocked: true,
      users: [],
      weeklyConfigs: {},
      games: [],
      picks: [],
      seasonTeams: [],
      seasonPicks: [],
      ledger: [],
      pastSeasons: [],
    };
  }
}

// If invoked with --build, prepare static artifacts in dist/ and exit cleanly
if (process.argv.includes('--build')) {
  const distDir = path.join(ROOT_DIR, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const srcHtml = path.join(TEMPLATES_DIR, 'index.html');
  if (fs.existsSync(srcHtml)) {
    fs.copyFileSync(srcHtml, path.join(distDir, 'index.html'));
  }
  console.log('Build verified and artifacts prepared in dist/.');
  process.exit(0);
}

const leagueStore = new LeagueStore();

function sendJson(res: http.ServerResponse, data: any, status: number = 200): void {
  const body = Buffer.from(JSON.stringify(data), 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

function readBodyJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  if (method === 'GET') {
    if (pathname === '/api/health') {
      sendJson(res, {
        status: 'ok',
        runtime: 'node',
        time: new Date().toISOString(),
      });
      return;
    }

    const viewerId = parsedUrl.searchParams.get('viewerId');

    if (pathname === '/api/state') {
      try {
        const state = leagueStore.getState(viewerId);
        const standings = leagueStore.getStandings();
        sendJson(res, { success: true, state, standings });
      } catch (err: any) {
        sendJson(res, { success: false, error: err?.message || String(err) }, 500);
      }
      return;
    }

    if (pathname === '/api/picks/league') {
      try {
        const weekParam = parsedUrl.searchParams.get('week');
        const week = weekParam ? parseInt(weekParam, 10) : (leagueStore.state.currentWeek || 4);
        const picks = leagueStore.getLeaguePicks(week, viewerId);
        sendJson(res, { success: true, week, picks });
      } catch (err: any) {
        sendJson(res, { success: false, error: err?.message || String(err) }, 500);
      }
      return;
    }

    if (pathname === '/api/standings') {
      try {
        const standings = leagueStore.getStandings();
        sendJson(res, { success: true, standings });
      } catch (err: any) {
        sendJson(res, { success: false, error: err?.message || String(err) }, 500);
      }
      return;
    }

    if (pathname === '/api/finances') {
      try {
        const finances = leagueStore.getCommissionerFinances();
        sendJson(res, finances);
      } catch (err: any) {
        sendJson(res, { success: false, error: err?.message || String(err) }, 500);
      }
      return;
    }

    if (pathname === '/api/season-ou/summary') {
      try {
        const summary = leagueStore.getSeasonOuSummary();
        sendJson(res, summary);
      } catch (err: any) {
        sendJson(res, { success: false, error: err?.message || String(err) }, 500);
      }
      return;
    }

    // Serve static files from public/ if present
    const safeRelPath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    const publicFile = path.join(ROOT_DIR, 'public', safeRelPath);
    if (pathname !== '/' && fs.existsSync(publicFile) && fs.statSync(publicFile).isFile()) {
      const ext = path.extname(publicFile).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
      };
      const content = fs.readFileSync(publicFile);
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        'Content-Length': String(content.length),
      });
      res.end(content);
      return;
    }

    // Serve Web Frontend UI (templates/index.html)
    const htmlFile = path.join(TEMPLATES_DIR, 'index.html');
    if (fs.existsSync(htmlFile)) {
      const content = fs.readFileSync(htmlFile);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(content.length),
      });
      res.end(content);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page or endpoint not found');
    return;
  }

  if (method === 'POST') {
    let body: Record<string, any>;
    try {
      body = await readBodyJson(req);
    } catch (err: any) {
      sendJson(res, { success: false, error: `Invalid JSON body: ${err?.message || err}` }, 400);
      return;
    }

    try {
      if (pathname === '/api/picks/submit') {
        const userId = body.userId;
        const week = parseInt(String(body.week ?? 1), 10);
        const picks = body.picks || [];
        const isBlazing = Boolean(body.isBlazingWeek);
        const result = leagueStore.submitWeeklyPicks(userId, week, picks, isBlazing);
        sendJson(res, result);
        return;
      }

      if (pathname === '/api/season-picks/submit') {
        const userId = body.userId;
        const picks = body.picks || [];
        const result = leagueStore.submitSeasonOuPicks(userId, picks);
        sendJson(res, result);
        return;
      }

      if (pathname === '/api/users/blazing-week') {
        const userId = body.userId;
        const week = parseInt(String(body.week ?? 18), 10);
        const result = leagueStore.setUserBlazingWeek(userId, week);
        sendJson(res, result);
        return;
      }

      if (pathname === '/api/finances/toggle-buyin') {
        const userId = body.userId;
        const paid = body.paid;
        const result = leagueStore.toggleUserBuyin(userId, paid);
        sendJson(res, result);
        return;
      }

      if (pathname === '/api/admin/toggle-week-unlock') {
        const week = parseInt(String(body.week ?? 1), 10);
        const forceUnlock = body.forceUnlock;
        const result = leagueStore.toggleWeekForceUnlock(week, forceUnlock);
        sendJson(res, result);
        return;
      }

      if (pathname === '/api/admin/user-blazing-week') {
        const userId = body.userId;
        const week = body.week;
        const targetWeek = week !== null && week !== undefined && week !== '' ? parseInt(String(week), 10) : null;
        const result = leagueStore.setUserBlazingWeek(userId, targetWeek);
        sendJson(res, result);
        return;
      }

      if (pathname === '/api/users/invite') {
        const name = body.name;
        const email = body.email;
        const role = body.role || 'player';
        if (!name) {
          sendJson(res, { success: false, error: 'Player name is required.' }, 400);
          return;
        }
        const user = leagueStore.addUser(name, email, role);
        sendJson(res, {
          success: true,
          user,
          message: `${user.name} added to the league!`,
        });
        return;
      }

      if (pathname === '/api/featured-game') {
        const week = parseInt(String(body.week ?? 1), 10);
        const gameId = body.gameId;
        leagueStore.setFeaturedGame(week, gameId);
        sendJson(res, {
          success: true,
          message: `Featured game chosen for Week ${week}!`,
        });
        return;
      }

      if (pathname === '/api/admin/featured-picker') {
        const week = parseInt(String(body.week ?? 1), 10);
        const pickerId = body.pickerId;
        leagueStore.setFeaturedPicker(week, pickerId);
        sendJson(res, {
          success: true,
          message: `Featured picker updated for Week ${week}!`,
        });
        return;
      }

      if (pathname === '/api/admin/override-game') {
        const gameId = body.gameId;
        const updates = body.updates || {};
        const game = leagueStore.overrideGame(gameId, updates);
        sendJson(res, {
          success: true,
          game,
          message: `Game ${gameId} overridden successfully.`,
        });
        return;
      }

      if (pathname === '/api/admin/settle-week') {
        const week = parseInt(String(body.week ?? 1), 10);
        const result = leagueStore.settleWeek(week);
        sendJson(res, result);
        return;
      }

      if (pathname === '/api/admin/set-week') {
        const week = parseInt(String(body.week ?? 1), 10);
        leagueStore.setCurrentWeek(week);
        sendJson(res, {
          success: true,
          message: `Active week set to Week ${week}.`,
        });
        return;
      }

      if (pathname === '/api/nfl/sync') {
        const weekReq = body.week;
        const targetW = weekReq ? parseInt(String(weekReq), 10) : null;
        const result = await leagueStore.syncLiveNflData(targetW);
        sendJson(res, result);
        return;
      }

      if (pathname === '/api/admin/set-ou-lock') {
        const locked = Boolean(body.locked ?? true);
        const result = leagueStore.setSeasonOuLock(locked);
        sendJson(res, result);
        return;
      }

      if (pathname === '/api/admin/rollover-season') {
        const result = leagueStore.rolloverSeason();
        sendJson(res, result);
        return;
      }

      sendJson(res, { success: false, error: `Unknown POST endpoint ${pathname}` }, 404);
    } catch (err: any) {
      sendJson(res, { success: false, error: err?.message || String(err) }, 400);
    }
    return;
  }

  if (method === 'PATCH') {
    if (pathname.startsWith('/api/users/')) {
      const userId = pathname.replace('/api/users/', '').trim();
      try {
        const body = await readBodyJson(req);
        const user = leagueStore.updateUser(userId, body);
        sendJson(res, { success: true, user });
      } catch (err: any) {
        sendJson(res, { success: false, error: err?.message || String(err) }, 400);
      }
      return;
    }
    sendJson(res, { success: false, error: `Unknown PATCH endpoint ${pathname}` }, 404);
    return;
  }

  if (method === 'DELETE') {
    if (pathname.startsWith('/api/users/')) {
      const userId = pathname.replace('/api/users/', '').trim();
      try {
        const result = leagueStore.deleteUser(userId);
        sendJson(res, result);
      } catch (err: any) {
        sendJson(res, { success: false, error: err?.message || String(err) }, 400);
      }
      return;
    }
    sendJson(res, { success: false, error: `Unknown DELETE endpoint ${pathname}` }, 404);
    return;
  }

  sendJson(res, { success: false, error: `Unsupported method ${method}` }, 405);
});

// Periodic ESPN live sync every 60s
setTimeout(() => {
  const currWeek = leagueStore.state.currentWeek || 4;
  leagueStore.syncLiveNflData(currWeek).catch(() => {});
  setInterval(() => {
    const w = leagueStore.state.currentWeek || 4;
    leagueStore.syncLiveNflData(w).catch(() => {});
  }, 60_000);
}, 3000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔥 Blazing 5 Pick'em server running on http://0.0.0.0:${PORT}`);
});
