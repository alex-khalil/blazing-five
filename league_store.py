"""
Blazing 5 NFL Pick'em - League Store & Rules Engine (Pure Python)
Zero TypeScript / Zero npm required.
"""

import json
import os
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Any

DATA_DIR = os.path.join(os.getcwd(), 'data')
DATA_FILE = os.path.join(DATA_DIR, 'blazing5-league.json')

class LeagueStore:
    def __init__(self, data_file: str = DATA_FILE):
        self.data_file = data_file
        self.last_live_sync: Optional[str] = None
        self.live_sync_status: str = "Ready"
        self.state = self.load_or_init_state()

    def load_or_init_state(self) -> Dict[str, Any]:
        """Loads league state from JSON file or initializes defaults."""
        os.makedirs(os.path.dirname(self.data_file), exist_ok=True)
        if os.path.exists(self.data_file):
            try:
                with open(self.data_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    self._calculate_picks_results(data)
                    return data
            except Exception as e:
                print(f"Error loading state from {self.data_file}: {e}")

        # Initialize default state
        state = self._generate_default_state()
        self.save_state(state)
        return state

    def save_state(self, state: Optional[Dict[str, Any]] = None):
        """Saves league state to disk atomically."""
        if state is None:
            state = self.state
        os.makedirs(os.path.dirname(self.data_file), exist_ok=True)
        temp_file = f"{self.data_file}.tmp"
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2)
        os.replace(temp_file, self.data_file)

    @staticmethod
    def get_eastern_timezone():
        try:
            import zoneinfo
            return zoneinfo.ZoneInfo("America/New_York")
        except Exception:
            return timezone(timedelta(hours=-4))

    def get_week_unlock_time(self, week: int) -> datetime:
        """Returns the Tuesday midnight Eastern (00:00:00 ET) opening datetime for a given week."""
        cfg = self.state.get("weeklyConfigs", {}).get(str(week)) or self.state.get("weeklyConfigs", {}).get(week) or {}
        if cfg.get("unlockTime"):
            try:
                return datetime.fromisoformat(cfg["unlockTime"].replace('Z', '+00:00'))
            except Exception:
                pass

        et = self.get_eastern_timezone()
        w_games = [g for g in self.state.get("games", []) if g.get("week") == week]
        earliest_dt = None
        for g in w_games:
            kt = g.get("kickoffTime")
            if kt:
                try:
                    dt = datetime.fromisoformat(kt.replace('Z', '+00:00'))
                    if earliest_dt is None or dt < earliest_dt:
                        earliest_dt = dt
                except Exception:
                    pass

        if not earliest_dt:
            year = self.state.get("seasonYear", 2026)
            base_tue = datetime(year, 9, 1, 0, 0, 0, tzinfo=et) + timedelta(weeks=week - 1)
            return base_tue

        et_dt = earliest_dt.astimezone(et)
        days_to_tuesday = (et_dt.weekday() - 1) % 7
        tuesday_date = et_dt.date() - timedelta(days=days_to_tuesday)
        return datetime(tuesday_date.year, tuesday_date.month, tuesday_date.day, 0, 0, 0, tzinfo=et)

    def is_week_unlocked(self, week: int) -> bool:
        """Checks if a week's spreads and picks are unlocked (Tuesday midnight ET)."""
        cfg = self.state.get("weeklyConfigs", {}).get(str(week)) or self.state.get("weeklyConfigs", {}).get(week) or {}
        if cfg.get("forceUnlocked"):
            return True
        unlock_dt = self.get_week_unlock_time(week)
        return datetime.now(timezone.utc) >= unlock_dt.astimezone(timezone.utc)

    def toggle_week_force_unlock(self, week: int, force_unlock: Optional[bool] = None) -> Dict[str, Any]:
        """Allows commissioner to toggle force unlock status for testing or early lines."""
        if "weeklyConfigs" not in self.state:
            self.state["weeklyConfigs"] = {}
        str_w = str(week)
        if str_w not in self.state["weeklyConfigs"]:
            self.state["weeklyConfigs"][str_w] = {}

        cur = bool(self.state["weeklyConfigs"][str_w].get("forceUnlocked", False))
        new_val = not cur if force_unlock is None else bool(force_unlock)
        self.state["weeklyConfigs"][str_w]["forceUnlocked"] = new_val
        self.save_state()
        return {
            "success": True,
            "week": week,
            "forceUnlocked": new_val,
            "isUnlocked": self.is_week_unlocked(week),
            "message": f"Week {week} {'unlocked early' if new_val else 'reset to automatic schedule'}."
        }

    def fetch_espn_scoreboard(self, week: Optional[int] = None) -> List[Dict[str, Any]]:
        """Fetches live NFL scores, game clock, and spreads from ESPN's public scoreboard API."""
        w_param = f"&week={week}" if week else ""
        url = f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2{w_param}"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "PostmanRuntime/7.32.3",
                "Accept": "application/json"
            }
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as response:
                payload = json.loads(response.read().decode("utf-8"))
                return payload.get("events", [])
        except Exception as e:
            print(f"Error querying ESPN scoreboard: {e}")
            return []

    def sync_live_nfl_data(self, target_week: Optional[int] = None) -> Dict[str, Any]:
        """Synchronizes live NFL scores, game clocks, and betting odds from ESPN into league state."""
        week = target_week or self.state.get("currentWeek", 4)
        events = self.fetch_espn_scoreboard(week)
        if not events:
            self.live_sync_status = "ESPN connection unavailable (cached lines active)"
            return {"success": False, "message": "Could not connect to ESPN NFL API.", "updatedCount": 0}

        updated_count = 0
        games = self.state.get("games", [])

        # Match ESPN events with existing games by team abbreviation or name
        for ev in events:
            comp = ev.get("competitions", [{}])[0]
            competitors = comp.get("competitors", [])
            home = next((c for c in competitors if c.get("homeAway") == "home"), {})
            away = next((c for c in competitors if c.get("homeAway") == "away"), {})

            home_abbr = home.get("team", {}).get("abbreviation")
            away_abbr = away.get("team", {}).get("abbreviation")
            home_name = home.get("team", {}).get("displayName", "")
            away_name = away.get("team", {}).get("displayName", "")

            # ESPN game status
            status_obj = comp.get("status", {}).get("type", {})
            espn_state = status_obj.get("state")  # 'pre', 'in', 'post'
            detail_clock = status_obj.get("shortDetail") or status_obj.get("detail") or ""

            if espn_state == "post":
                status = "final"
            elif espn_state == "in":
                status = "in_progress"
            else:
                status = "scheduled"

            home_score = int(home.get("score", 0)) if home.get("score") is not None and status != "scheduled" else None
            away_score = int(away.get("score", 0)) if away.get("score") is not None and status != "scheduled" else None
            kickoff_iso = ev.get("date")

            # Extract Vegas / DraftKings point spread from ESPN
            odds_list = comp.get("odds", [])
            espn_home_spread = None
            espn_ou = None
            if odds_list:
                odd = odds_list[0]
                espn_ou = odd.get("overUnder")
                ps = odd.get("pointSpread", {})
                if ps.get("home", {}).get("close", {}).get("line"):
                    try:
                        espn_home_spread = float(ps["home"]["close"]["line"])
                    except Exception:
                        pass
                elif odd.get("details"):
                    details = str(odd.get("details", "")).strip()
                    spread_val = odd.get("spread")
                    if details in ("EVEN", "PK", "0"):
                        espn_home_spread = 0.0
                    elif spread_val is not None:
                        try:
                            s_flt = abs(float(spread_val))
                            if home_abbr and details.startswith(home_abbr):
                                espn_home_spread = -s_flt
                            else:
                                espn_home_spread = s_flt
                        except Exception:
                            pass

            # Find matching game in existing league games for this week
            matched_game = None
            for g in games:
                if g.get("week") == week:
                    g_home_abbr = g.get("homeTeam", {}).get("abbreviation")
                    g_away_abbr = g.get("awayTeam", {}).get("abbreviation")
                    g_home_name = g.get("homeTeam", {}).get("name", "")
                    g_away_name = g.get("awayTeam", {}).get("name", "")

                    if (g_home_abbr == home_abbr and g_away_abbr == away_abbr) or \
                       (home_name and home_name in g_home_name) or (away_name and away_name in g_away_name):
                        matched_game = g
                        break

            if matched_game:
                # Update live game properties (unless manually overridden by commissioner)
                if not matched_game.get("isManualOverride"):
                    if espn_home_spread is not None:
                        matched_game["homeSpread"] = espn_home_spread
                        matched_game["awaySpread"] = -espn_home_spread
                    if espn_ou is not None:
                        matched_game["overUnder"] = espn_ou

                matched_game["status"] = status
                matched_game["homeScore"] = home_score
                matched_game["awayScore"] = away_score
                if kickoff_iso:
                    matched_game["kickoffTime"] = kickoff_iso
                matched_game["liveClockDetail"] = detail_clock
                matched_game["espnId"] = ev.get("id")
                matched_game["lastLiveSync"] = datetime.now(timezone.utc).isoformat()
                updated_count += 1
            else:
                # If game doesn't exist yet, insert it from ESPN
                new_game_id = f"gm_espn_w{week}_{ev.get('id')}"
                new_game = {
                    "id": new_game_id,
                    "espnId": ev.get("id"),
                    "week": week,
                    "season": self.state.get("seasonYear", 2026),
                    "homeTeam": {
                        "name": home_name or home_abbr,
                        "abbreviation": home_abbr,
                        "logo": home.get("team", {}).get("logo", ""),
                        "record": home.get("records", [{}])[0].get("summary", "")
                    },
                    "awayTeam": {
                        "name": away_name or away_abbr,
                        "abbreviation": away_abbr,
                        "logo": away.get("team", {}).get("logo", ""),
                        "record": away.get("records", [{}])[0].get("summary", "")
                    },
                    "homeSpread": espn_home_spread if espn_home_spread is not None else -3.0,
                    "awaySpread": -espn_home_spread if espn_home_spread is not None else 3.0,
                    "overUnder": espn_ou or 45.0,
                    "kickoffTime": kickoff_iso or datetime.now(timezone.utc).isoformat(),
                    "status": status,
                    "homeScore": home_score,
                    "awayScore": away_score,
                    "liveClockDetail": detail_clock,
                    "isFeatured": False,
                    "lastLiveSync": datetime.now(timezone.utc).isoformat()
                }
                games.append(new_game)
                updated_count += 1

        self.last_live_sync = datetime.now(timezone.utc).isoformat()
        self.live_sync_status = f"Live ESPN Sync Active ({datetime.now(timezone.utc).strftime('%H:%M:%S UTC')})"
        self._calculate_picks_results(self.state)
        self.save_state()

        return {
            "success": True,
            "week": week,
            "updatedCount": updated_count,
            "lastLiveSync": self.last_live_sync,
            "message": f"Successfully synced {updated_count} NFL games and live spreads from ESPN."
        }

    @staticmethod
    def is_game_started(game: Dict[str, Any]) -> bool:
        if not game:
            return False
        if game.get("status") in ("in_progress", "final"):
            return True
        kickoff_str = game.get("kickoffTime", "")
        if not kickoff_str:
            return False
        try:
            kickoff_dt = datetime.fromisoformat(kickoff_str.replace('Z', '+00:00'))
            return datetime.now(timezone.utc) >= kickoff_dt
        except Exception:
            return False

    def get_league_picks(self, week: int, viewer_user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        self._calculate_picks_results(self.state)
        games_map = {g["id"]: g for g in self.state.get("games", [])}
        users_map = {u["id"]: u for u in self.state.get("users", [])}

        league_picks = []
        for pick in self.state.get("picks", []):
            if pick.get("week") != week:
                continue
            game = games_map.get(pick.get("gameId"))
            user = users_map.get(pick.get("userId"))
            if not game or not user:
                continue

            started = self.is_game_started(game)
            is_own = bool(viewer_user_id and pick.get("userId") == viewer_user_id)
            is_revealed = started or is_own

            league_picks.append({
                "id": pick.get("id"),
                "userId": user["id"],
                "userName": user["name"],
                "userAvatar": user.get("avatar", ""),
                "gameId": game["id"] if is_revealed else None,
                "awayTeam": game["awayTeam"]["name"] if is_revealed else "🔒 Hidden until kickoff",
                "awayLogo": game["awayTeam"].get("logo", "") if is_revealed else "",
                "homeTeam": game["homeTeam"]["name"] if is_revealed else "🔒 Hidden until kickoff",
                "homeLogo": game["homeTeam"].get("logo", "") if is_revealed else "",
                "kickoffTime": game.get("kickoffTime"),
                "gameStatus": game.get("status", "scheduled"),
                "homeScore": game.get("homeScore") if is_revealed else None,
                "awayScore": game.get("awayScore") if is_revealed else None,
                "gameStarted": started,
                "isRevealed": is_revealed,
                "isOwnPick": is_own,
                "isLock": pick.get("isLock") if is_revealed else None,
                "isBlazingWeek": pick.get("isBlazingWeek", False) if is_revealed else None,
                "pickedTeam": pick.get("pickedTeam") if is_revealed else None,
                "pickedTeamName": pick.get("pickedTeamName") if is_revealed else "🔒 Hidden until kickoff",
                "lockedSpread": pick.get("lockedSpread") if is_revealed else None,
                "result": pick.get("result", "pending") if is_revealed else "hidden",
                "pointsAwarded": pick.get("pointsAwarded", 0) if is_revealed else 0,
            })

        return league_picks

    def get_state(self, viewer_user_id: Optional[str] = None) -> Dict[str, Any]:
        self._calculate_picks_results(self.state)
        games_map = {g["id"]: g for g in self.state.get("games", [])}

        state_copy = dict(self.state)

        # Annotate games with hasStarted and isWeekUnlocked (Tuesday midnight ET)
        decorated_games = []
        for g_orig in self.state.get("games", []):
            g = dict(g_orig)
            g["hasStarted"] = self.is_game_started(g)
            w = g.get("week", 1)
            unlocked = self.is_week_unlocked(w)
            ut = self.get_week_unlock_time(w)
            g["isWeekUnlocked"] = unlocked
            g["weekUnlockTime"] = ut.isoformat()
            g["weekUnlockFormatted"] = ut.strftime("%A, %b %-d at 12:00 AM ET")

            if not unlocked:
                # Spreads and picking locked until Tuesday midnight Eastern
                g["homeSpread"] = None
                g["awaySpread"] = None

            decorated_games.append(g)

        state_copy["games"] = decorated_games

        # Week unlock statuses for all 18 weeks
        week_statuses = {}
        for w in range(1, 19):
            unlocked = self.is_week_unlocked(w)
            ut = self.get_week_unlock_time(w)
            week_statuses[w] = {
                "week": w,
                "isUnlocked": unlocked,
                "unlockTime": ut.isoformat(),
                "unlockFormatted": ut.strftime("%a, %b %-d, 12:00 AM ET"),
                "fullFormatted": ut.strftime("%A, %B %-d at 12:00 AM ET"),
            }
        state_copy["weekStatuses"] = week_statuses
        state_copy["liveSync"] = {
            "lastSync": self.last_live_sync,
            "status": self.live_sync_status,
            "isLive": True
        }

        # If a viewer_user_id is provided, enforce pick privacy on unstarted games
        decorated_picks = []
        for pick in self.state.get("picks", []):
            p = dict(pick)
            game = games_map.get(p.get("gameId"))
            started = self.is_game_started(game) if game else False
            is_own = bool(viewer_user_id and p.get("userId") == viewer_user_id)
            p["hasStarted"] = started
            p["isRevealed"] = started or is_own

            if viewer_user_id and not p["isRevealed"]:
                p["gameId"] = None
                p["pickedTeam"] = None
                p["pickedTeamName"] = "🔒 Hidden until kickoff"
                p["lockedSpread"] = None
                p["isLock"] = None
                p["result"] = "hidden"
                p["pointsAwarded"] = 0

            decorated_picks.append(p)

        state_copy["picks"] = decorated_picks
        return state_copy

    def get_commissioner_finances(self) -> Dict[str, Any]:
        standings = self.get_standings()
        standings_by_uid = {s["userId"]: s for s in standings}
        users = self.state.get("users", [])
        ledger = self.state.get("ledger", [])

        buy_in_amount = 25.0
        players_financials = []
        total_buyins_collected = 0.0

        for idx, u in enumerate(users):
            uid = u["id"]
            user_stand = standings_by_uid.get(uid, {})
            rank = user_stand.get("rank", idx + 1)
            proj_payout = user_stand.get("projectedPayout", 0.0)

            # Bonuses (bounties) and penalties from settled weeks
            bounties = sum(abs(l.get("amount", 0)) for l in ledger if l.get("userId") == uid and l.get("type") in ("PERFECT_6_0_BONUS", "SEASON_OU_6_0"))
            penalties = sum(abs(l.get("amount", 0)) for l in ledger if l.get("userId") == uid and l.get("type") in ("AWFUL_0_6_PENALTY", "SEASON_OU_0_6"))

            is_paid = u.get("buyInPaid", True)
            if is_paid:
                total_buyins_collected += buy_in_amount

            # Running view: Buy-in plus earnings / minus losses
            running_value = buy_in_amount + bounties - penalties + proj_payout
            net_profit_loss = (proj_payout + bounties - penalties) - buy_in_amount

            players_financials.append({
                "userId": uid,
                "name": u["name"],
                "avatar": u.get("avatar", ""),
                "buyIn": buy_in_amount,
                "buyInPaid": is_paid,
                "bounties": bounties,
                "penalties": penalties,
                "projectedPayout": proj_payout,
                "rank": rank,
                "points": user_stand.get("points", 0),
                "record": f"{user_stand.get('wins', 0)}-{user_stand.get('losses', 0)}",
                "runningValue": running_value,
                "netProfitLoss": net_profit_loss,
            })

        players_financials.sort(key=lambda x: x["rank"])

        total_pot = len(users) * buy_in_amount
        pot_delta = sum(
            (-abs(l.get("amount", 0)) if l.get("type") in ("PERFECT_6_0_BONUS", "SEASON_OU_6_0") else abs(l.get("amount", 0)))
            for l in ledger if l.get("type") in ("PERFECT_6_0_BONUS", "SEASON_OU_6_0", "AWFUL_0_6_PENALTY", "SEASON_OU_0_6")
        )
        current_net_pot = max(0.0, total_pot + pot_delta)

        return {
            "success": True,
            "buyInPerPlayer": buy_in_amount,
            "totalPlayers": len(users),
            "totalBuyInsCollected": total_buyins_collected,
            "totalInitialPot": total_pot,
            "currentNetPot": current_net_pot,
            "players": players_financials,
        }

    def toggle_user_buyin(self, user_id: str, paid: Optional[bool] = None) -> Dict[str, Any]:
        user = next((u for u in self.state.get("users", []) if u["id"] == user_id), None)
        if not user:
            raise ValueError("User not found")
        if paid is None:
            user["buyInPaid"] = not user.get("buyInPaid", True)
        else:
            user["buyInPaid"] = bool(paid)
        self.save_state()
        return {"success": True, "userId": user_id, "buyInPaid": user["buyInPaid"]}

    def get_season_ou_summary(self) -> Dict[str, Any]:
        self._calculate_picks_results(self.state)
        teams_map = {t["teamId"]: t for t in self.state.get("seasonTeams", [])}
        users = self.state.get("users", [])
        season_picks = self.state.get("seasonPicks", [])

        user_summaries = []
        for u in users:
            uid = u["id"]
            u_picks = [p for p in season_picks if p.get("userId") == uid]
            decorated = []
            for p in u_picks:
                team = teams_map.get(p.get("teamId"), {})
                wins = team.get("currentWins", 0)
                losses = team.get("currentLosses", 0)
                line = p.get("line", team.get("winTotalLine", 0))
                is_over = p.get("selection") == "OVER"

                decorated.append({
                    "id": p.get("id"),
                    "teamId": p.get("teamId"),
                    "teamName": team.get("teamName", p.get("teamId", "").upper()),
                    "teamLogo": team.get("logo", ""),
                    "selection": p.get("selection"),
                    "line": line,
                    "isLock": p.get("isLock", False),
                    "currentWins": wins,
                    "currentLosses": losses,
                    "result": p.get("result", "pending"),
                    "pointsAwarded": p.get("pointsAwarded", 0),
                    "targetWinsNeeded": max(0, int(line + 0.5) - wins) if is_over else None,
                })

            user_summaries.append({
                "userId": uid,
                "userName": u["name"],
                "userAvatar": u.get("avatar", ""),
                "hasSubmitted": len(u_picks) >= 5,
                "picksCount": len(u_picks),
                "picks": decorated,
                "wins": sum(1 for p in decorated if p["result"] == "win"),
                "losses": sum(1 for p in decorated if p["result"] == "loss"),
                "pending": sum(1 for p in decorated if p["result"] == "pending"),
            })

        return {
            "success": True,
            "seasonYear": self.state.get("seasonYear", 2026),
            "isLocked": self.state.get("seasonOULocked", True),
            "users": user_summaries,
            "teams": self.state.get("seasonTeams", []),
        }

    def get_standings(self) -> List[Dict[str, Any]]:
        self._calculate_picks_results(self.state)
        users = self.state.get("users", [])
        picks = self.state.get("picks", [])
        season_picks = self.state.get("seasonPicks", [])
        ledger = self.state.get("ledger", [])

        # Pot calculations
        total_buyins = len(users) * 25
        pot_delta = 0
        for item in ledger:
            item_type = item.get("type")
            amount = abs(item.get("amount", 0))
            if item_type in ("PERFECT_6_0_BONUS", "SEASON_OU_6_0"):
                pot_delta -= amount
            elif item_type in ("AWFUL_0_6_PENALTY", "SEASON_OU_0_6"):
                pot_delta += amount
        remaining_pot = max(0, total_buyins + pot_delta)

        standings = []
        for user in users:
            uid = user["id"]
            user_picks = [p for p in picks if p.get("userId") == uid]
            user_season_picks = [p for p in season_picks if p.get("userId") == uid]

            weekly_wins = sum(1 for p in user_picks if p.get("result") == "win")
            weekly_losses = sum(1 for p in user_picks if p.get("result") == "loss")
            weekly_pushes = sum(1 for p in user_picks if p.get("result") == "push")

            # Lock records
            lock_wins = sum(1 for p in user_picks if p.get("isLock") and p.get("result") == "win")
            lock_losses = sum(1 for p in user_picks if p.get("isLock") and p.get("result") == "loss")

            season_ou_wins = sum(1 for p in user_season_picks if p.get("result") == "win")
            season_ou_losses = sum(1 for p in user_season_picks if p.get("result") == "loss")

            for sp in user_season_picks:
                if sp.get("isLock"):
                    if sp.get("result") == "win":
                        lock_wins += 1
                    elif sp.get("result") == "loss":
                        lock_losses += 1

            total_wins = weekly_wins + season_ou_wins
            total_losses = weekly_losses + season_ou_losses
            total_points = sum(p.get("pointsAwarded", 0) for p in user_picks) + sum(sp.get("pointsAwarded", 0) for sp in user_season_picks)

            # Earnings from ledger
            user_earnings = 0
            for item in ledger:
                if item.get("userId") == uid:
                    item_type = item.get("type")
                    amt = item.get("amount", 0)
                    if item_type in ("PERFECT_6_0_BONUS", "SEASON_OU_6_0"):
                        user_earnings += amt
                    elif item_type in ("AWFUL_0_6_PENALTY", "SEASON_OU_0_6"):
                        user_earnings -= amt

            standings.append({
                "userId": uid,
                "user": user,
                "userName": user["name"],
                "avatar": user.get("avatar", ""),
                "rank": 1,
                "wins": total_wins,
                "losses": total_losses,
                "pushes": weekly_pushes,
                "points": total_points,
                "totalPoints": total_points,
                "lockWins": lock_wins,
                "lockLosses": lock_losses,
                "seasonOUWins": season_ou_wins,
                "seasonOULosses": season_ou_losses,
                "blazingWeekUsed": user.get("blazingWeekUsed"),
                "earnings": user_earnings,
                "projectedPayout": 0,
            })

        # Sort: Primary by Points/Wins, First Tiebreaker by Lock Wins, then lowest Lock Losses
        standings.sort(key=lambda s: (s["points"], s["lockWins"], -s["lockLosses"]), reverse=True)

        # Assign ranks & projected payouts (50%, 25%, 12.5%, 7.5%, 5%)
        payout_shares = [0.50, 0.25, 0.125, 0.075, 0.05]
        for i, s in enumerate(standings):
            s["rank"] = i + 1
            if i < len(payout_shares):
                s["projectedPayout"] = round(remaining_pot * payout_shares[i])
            else:
                s["projectedPayout"] = 0

        return standings

    def submit_weekly_picks(self, user_id: str, week: int, picks_data: List[Dict[str, Any]], is_blazing: bool = False) -> Dict[str, Any]:
        """Validates and records 5 Against-The-Spread picks for a week."""
        if not self.is_week_unlocked(week):
            ut = self.get_week_unlock_time(week)
            formatted = ut.strftime("%A, %B %-d at 12:00 AM ET (Tuesday midnight)")
            raise ValueError(f"Week {week} picks are locked until the beginning of the week ({formatted}). Spreads and picking are not available yet.")

        user = next((u for u in self.state.get("users", []) if u["id"] == user_id), None)
        if not user:
            raise ValueError(f"User {user_id} not found.")

        if len(picks_data) != 5:
            raise ValueError("You must pick exactly 5 games against the spread.")

        # Must-pick game check
        weekly_cfg = self.state.get("weeklyConfigs", {}).get(str(week)) or self.state.get("weeklyConfigs", {}).get(week)
        if weekly_cfg and weekly_cfg.get("featuredGameId"):
            feat_id = weekly_cfg["featuredGameId"]
            if not any(p.get("gameId") == feat_id for p in picks_data):
                raise ValueError("Rules mandate that you must include the Featured Must-Pick Game in your 5 selections!")

        # Blazing week handling
        is_user_blazing = is_blazing or (user.get("blazingWeekUsed") == week) or (week == 18 and user.get("blazingWeekUsed") is None)
        if is_user_blazing and user.get("blazingWeekUsed") is None:
            user["blazingWeekUsed"] = week

        if is_user_blazing:
            for p in picks_data:
                p["isLock"] = True
        else:
            lock_count = sum(1 for p in picks_data if p.get("isLock"))
            if lock_count != 1:
                raise ValueError('You must designate exactly 1 of your 5 picks as your "LOCK" (worth ±2 wins/losses).')

        games_map = {g["id"]: g for g in self.state.get("games", [])}
        now_ts = time.time() * 1000

        # Filter out existing picks for user/week
        self.state["picks"] = [p for p in self.state.get("picks", []) if not (p.get("userId") == user_id and p.get("week") == week)]

        new_picks = []
        for p in picks_data:
            game = games_map.get(p.get("gameId"))
            if not game:
                raise ValueError(f"Game {p.get('gameId')} not found.")

            # Kickoff enforcement
            kickoff_str = game.get("kickoffTime", "")
            try:
                kickoff_dt = datetime.fromisoformat(kickoff_str.replace('Z', '+00:00'))
                if (kickoff_dt.timestamp() * 1000) <= now_ts and game.get("status") != "scheduled":
                    raise ValueError(f"Cannot pick {game['awayTeam']['name']} @ {game['homeTeam']['name']} - game has already kicked off!")
            except Exception:
                pass

            spread = game.get("homeSpread", 0) if p.get("pickedTeam") == "home" else game.get("awaySpread", 0)
            team_name = game["homeTeam"]["name"] if p.get("pickedTeam") == "home" else game["awayTeam"]["name"]

            new_picks.append({
                "id": f"pick_{int(now_ts)}_{p.get('gameId')}",
                "userId": user_id,
                "week": week,
                "gameId": p.get("gameId"),
                "pickedTeam": p.get("pickedTeam"),
                "pickedTeamName": team_name,
                "lockedSpread": spread,
                "isLock": bool(p.get("isLock")),
                "isBlazingWeek": is_user_blazing,
                "result": "pending",
                "pointsAwarded": 0,
                "submittedAt": datetime.now(timezone.utc).isoformat(),
            })

        self.state["picks"].extend(new_picks)
        self._calculate_picks_results(self.state)
        self.save_state()

        return {
            "success": True,
            "picks": new_picks,
            "message": "🔥 Blazing 5 Picks locked in! All 5 picks are LOCKs (±2 each)!" if is_user_blazing else "Picks locked in! 4 Regular ATS picks (±1) and 1 LOCK (±2)."
        }

    def submit_season_ou_picks(self, user_id: str, picks_data: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Submits 5 season win total Over/Under selections with 1 Lock."""
        is_locked = self.state.get("seasonOULocked", True)
        if is_locked:
            raise ValueError("Season Long Over/Under picks are locked! Submissions are only permitted before Week 1 of the NFL season.")

        if len(picks_data) != 5:
            raise ValueError("You must select exactly 5 teams for your Season Over/Under win totals.")

        lock_count = sum(1 for p in picks_data if p.get("isLock"))
        if lock_count != 1:
            raise ValueError('You must designate exactly 1 team as your Season Over/Under LOCK (worth ±2 wins/losses).')

        team_map = {t["teamId"]: t for t in self.state.get("seasonTeams", [])}

        # Clear old season picks for user
        self.state["seasonPicks"] = [sp for sp in self.state.get("seasonPicks", []) if sp.get("userId") != user_id]

        for p in picks_data:
            tid = p.get("teamId")
            team = team_map.get(tid)
            if not team:
                raise ValueError(f"Team {tid} not found.")

            self.state["seasonPicks"].append({
                "id": f"spick_{int(time.time() * 1000)}_{tid}",
                "userId": user_id,
                "teamId": tid,
                "selection": p.get("selection"),
                "line": team.get("winTotalLine", 0),
                "isLock": bool(p.get("isLock")),
                "result": "pending",
                "pointsAwarded": 0,
                "submittedAt": datetime.now(timezone.utc).isoformat(),
            })

        self.save_state()
        return {"success": True, "message": "Season Win Total Over/Under picks successfully submitted with 1 Lock!"}

    def set_user_blazing_week(self, user_id: str, week: Optional[int]) -> Dict[str, Any]:
        """Commissioner or player assignment of Blazing Week."""
        user = next((u for u in self.state.get("users", []) if u["id"] == user_id), None)
        if not user:
            raise ValueError("User not found.")

        prev_week = user.get("blazingWeekUsed")
        user["blazingWeekUsed"] = week

        if prev_week and prev_week != week:
            for p in self.state.get("picks", []):
                if p.get("userId") == user_id and p.get("week") == prev_week:
                    p["isBlazingWeek"] = False

        if week is not None:
            for p in self.state.get("picks", []):
                if p.get("userId") == user_id and p.get("week") == week:
                    p["isBlazingWeek"] = True
                    p["isLock"] = True

        self._calculate_picks_results(self.state)
        self.save_state()
        return {
            "success": True,
            "user": user,
            "message": f"Blazing Week for {user['name']} set to {'Week ' + str(week) if week else 'Undeclared (Week 18 Default)'}."
        }

    def add_user(self, name: str, email: str, role: str = "player") -> Dict[str, Any]:
        """Invites a new player to the league."""
        uid = f"usr_{int(time.time() * 1000)}"
        new_user = {
            "id": uid,
            "name": name,
            "email": email or f"{name.lower().replace(' ', '')}@blazing5.league",
            "role": role,
            "avatar": "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80",
            "blazingWeekUsed": None,
            "buyInPaid": True,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        self.state.get("users", []).append(new_user)
        self.state.get("ledger", []).append({
            "id": f"ledg_{int(time.time() * 1000)}",
            "userId": uid,
            "userName": name,
            "type": "BUY_IN",
            "amount": 25,
            "description": f"$25 Season Buy-in from {name}",
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        })
        self.save_state()
        return new_user

    def update_user(self, user_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        user = next((u for u in self.state.get("users", []) if u["id"] == user_id), None)
        if not user:
            raise ValueError("User not found.")
        user.update(updates)
        if "name" in updates:
            for l in self.state.get("ledger", []):
                if l.get("userId") == user_id:
                    l["userName"] = updates["name"]
        self.save_state()
        return user

    def delete_user(self, user_id: str) -> Dict[str, Any]:
        user = next((u for u in self.state.get("users", []) if u["id"] == user_id), None)
        if not user:
            raise ValueError("User not found.")
        self.state["users"] = [u for u in self.state.get("users", []) if u["id"] != user_id]
        self.state["picks"] = [p for p in self.state.get("picks", []) if p.get("userId") != user_id]
        self.state["seasonPicks"] = [sp for sp in self.state.get("seasonPicks", []) if sp.get("userId") != user_id]
        self.state["ledger"] = [l for l in self.state.get("ledger", []) if l.get("userId") != user_id]
        self.save_state()
        return {"success": True, "message": f"Member {user['name']} was removed from the league."}

    def set_featured_picker(self, week: int, picker_id: Optional[str]):
        str_w = str(week)
        if "weeklyConfigs" not in self.state:
            self.state["weeklyConfigs"] = {}
        if str_w not in self.state["weeklyConfigs"]:
            self.state["weeklyConfigs"][str_w] = {"week": week, "featuredPickerId": None, "featuredGameId": None}
        self.state["weeklyConfigs"][str_w]["featuredPickerId"] = picker_id
        self.save_state()

    def set_featured_game(self, week: int, game_id: str):
        str_w = str(week)
        if "weeklyConfigs" not in self.state:
            self.state["weeklyConfigs"] = {}
        if str_w not in self.state["weeklyConfigs"]:
            self.state["weeklyConfigs"][str_w] = {"week": week, "featuredPickerId": None, "featuredGameId": None}
        self.state["weeklyConfigs"][str_w]["featuredGameId"] = game_id
        for g in self.state.get("games", []):
            if g.get("week") == week:
                g["isFeatured"] = (g.get("id") == game_id)
        self.save_state()

    def override_game(self, game_id: str, updates: Dict[str, Any]):
        for g in self.state.get("games", []):
            if g.get("id") == game_id:
                if "homeSpread" in updates:
                    g["homeSpread"] = updates["homeSpread"]
                    g["awaySpread"] = -updates["homeSpread"]
                    g["isManualOverride"] = True
                if "status" in updates:
                    g["status"] = updates["status"]
                if "homeScore" in updates:
                    g["homeScore"] = updates["homeScore"]
                if "awayScore" in updates:
                    g["awayScore"] = updates["awayScore"]
                if "kickoffTime" in updates:
                    g["kickoffTime"] = updates["kickoffTime"]
                self._calculate_picks_results(self.state)
                self.save_state()
                return g
        raise ValueError(f"Game {game_id} not found.")

    def set_current_week(self, week: int):
        self.state["currentWeek"] = week
        self.save_state()

    def set_season_ou_lock(self, locked: bool) -> Dict[str, Any]:
        self.state["seasonOULocked"] = locked
        self.save_state()
        return {"success": True, "seasonOULocked": locked, "message": "Season O/U submissions locked." if locked else "Season O/U submissions unlocked."}

    def settle_week(self, week: int) -> Dict[str, Any]:
        self._calculate_picks_results(self.state)
        users = self.state.get("users", [])
        ledger = self.state.get("ledger", [])
        picks = self.state.get("picks", [])

        bonuses_awarded = []
        for user in users:
            uid = user["id"]
            user_week_picks = [p for p in picks if p.get("userId") == uid and p.get("week") == week]
            if len(user_week_picks) == 5:
                wins = sum(1 for p in user_week_picks if p.get("result") == "win")
                losses = sum(1 for p in user_week_picks if p.get("result") == "loss")

                # Perfect week: 5-0 (credited +$5)
                if wins == 5:
                    if not any(l.get("userId") == uid and l.get("week") == week and l.get("type") == "PERFECT_6_0_BONUS" for l in ledger):
                        ledger.append({
                            "id": f"ledg_{int(time.time()*1000)}_60_{uid}",
                            "userId": uid,
                            "userName": user["name"],
                            "week": week,
                            "type": "PERFECT_6_0_BONUS",
                            "amount": -5,
                            "description": f"🔥 Perfect Week {week}! +$5 cash bounty (deducted from pot)",
                            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                        })
                        bonuses_awarded.append(f"{user['name']} (+$5 bonus)")
                elif losses == 5:
                    if not any(l.get("userId") == uid and l.get("week") == week and l.get("type") == "AWFUL_0_6_PENALTY" for l in ledger):
                        ledger.append({
                            "id": f"ledg_{int(time.time()*1000)}_06_{uid}",
                            "userId": uid,
                            "userName": user["name"],
                            "week": week,
                            "type": "AWFUL_0_6_PENALTY",
                            "amount": 5,
                            "description": f"💀 Awful Week {week} Penalty (+$5 into pot)",
                            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                        })
                        bonuses_awarded.append(f"{user['name']} (-$5 penalty into pot)")

        self.save_state()
        return {"success": True, "bonuses": bonuses_awarded, "message": f"Week {week} settled!"}

    def rollover_season(self) -> Dict[str, Any]:
        """Archives current year and rolls over to next NFL year."""
        standings = self.get_standings()
        champ = standings[0] if standings else None

        total_players = len(self.state.get("users", []))
        pot = total_players * 25
        for item in self.state.get("ledger", []):
            if item.get("type") in ("PERFECT_6_0_BONUS", "SEASON_OU_6_0"):
                pot -= abs(item.get("amount", 0))
            if item.get("type") in ("AWFUL_0_6_PENALTY", "SEASON_OU_0_6"):
                pot += abs(item.get("amount", 0))
        net_pot = max(0, pot)

        archive = {
            "seasonYear": self.state.get("seasonYear", 2026),
            "champion": {
                "userId": champ["userId"] if champ else "usr_none",
                "userName": champ["userName"] if champ else "Champion",
                "avatar": champ.get("avatar", "") if champ else "",
                "totalPoints": champ.get("points", 0) if champ else 0,
                "record": f"{champ['wins']}-{champ['losses']}" if champ else "0-0",
                "payout": champ.get("projectedPayout", round(net_pot * 0.5)) if champ else 0,
            },
            "standings": standings,
            "totalPot": net_pot,
            "archivedAt": datetime.now(timezone.utc).isoformat(),
        }

        if "pastSeasons" not in self.state:
            self.state["pastSeasons"] = []
        self.state["pastSeasons"].insert(0, archive)

        next_year = self.state.get("seasonYear", 2026) + 1
        self.state["seasonYear"] = next_year
        self.state["currentWeek"] = 1
        self.state["isSeasonStarted"] = False
        self.state["seasonOULocked"] = False

        for u in self.state.get("users", []):
            u["blazingWeekUsed"] = None

        self.state["picks"] = []
        self.state["seasonPicks"] = []
        self.state["ledger"] = [{
            "id": f"ledg_buyin_{u['id']}_{next_year}",
            "userId": u["id"],
            "userName": u["name"],
            "type": "BUY_IN",
            "amount": 25,
            "description": f"$25 {next_year} Season Buy-in from {u['name']}",
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        } for u in self.state.get("users", [])]

        self.save_state()
        return {"success": True, "message": f"Successfully rolled over to the {next_year} NFL Season!", "newSeasonYear": next_year}

    def _calculate_picks_results(self, state: Dict[str, Any]):
        games_map = {g["id"]: g for g in state.get("games", [])}
        for pick in state.get("picks", []):
            game = games_map.get(pick.get("gameId"))
            if not game or game.get("status") != "final" or game.get("homeScore") is None or game.get("awayScore") is None:
                pick["result"] = "pending"
                pick["pointsAwarded"] = 0
                continue

            home_score = game["homeScore"]
            away_score = game["awayScore"]
            locked_spread = pick.get("lockedSpread", 0)

            if pick.get("pickedTeam") == "home":
                margin = (home_score - away_score) + locked_spread
            else:
                margin = (away_score - home_score) + locked_spread

            mult = 2 if pick.get("isLock") else 1
            if margin > 0.01:
                pick["result"] = "win"
                pick["pointsAwarded"] = mult * 1
            elif margin < -0.01:
                pick["result"] = "loss"
                pick["pointsAwarded"] = mult * -1
            else:
                pick["result"] = "push"
                pick["pointsAwarded"] = 0

        # Season O/U picks calculation
        teams_map = {t["teamId"]: t for t in state.get("seasonTeams", [])}
        for sp in state.get("seasonPicks", []):
            team = teams_map.get(sp.get("teamId"))
            if not team:
                continue
            wins = team.get("currentWins", 0)
            losses = team.get("currentLosses", 0)
            line = sp.get("line", team.get("winTotalLine", 0))
            is_over = sp.get("selection") == "OVER"
            mult = 2 if sp.get("isLock") else 1

            if is_over:
                if wins > line:
                    sp["result"] = "win"
                    sp["pointsAwarded"] = mult * 1
                elif (17 - losses) < line:
                    sp["result"] = "loss"
                    sp["pointsAwarded"] = mult * -1
                else:
                    sp["result"] = "pending"
                    sp["pointsAwarded"] = 0
            else:
                if losses > (17 - line):
                    sp["result"] = "win"
                    sp["pointsAwarded"] = mult * 1
                elif wins > line:
                    sp["result"] = "loss"
                    sp["pointsAwarded"] = mult * -1
                else:
                    sp["result"] = "pending"
                    sp["pointsAwarded"] = 0

        # Automatic Settlement of completed weeks for bounties & penalties
        users = state.get("users", [])
        ledger = state.get("ledger", [])
        picks = state.get("picks", [])
        ledger_modified = False

        user_week_picks = {}
        for p in picks:
            key = (p.get("userId"), p.get("week"))
            if key not in user_week_picks:
                user_week_picks[key] = []
            user_week_picks[key].append(p)

        for user in users:
            uid = user["id"]
            for w in range(1, 19):
                w_picks = user_week_picks.get((uid, w), [])
                if len(w_picks) == 5:
                    all_final = all(p.get("result") in ("win", "loss", "push") for p in w_picks)
                    if all_final:
                        wins = sum(1 for p in w_picks if p.get("result") == "win")
                        losses = sum(1 for p in w_picks if p.get("result") == "loss")

                        # Perfect week: 5-0 (+$5 cash bounty)
                        if wins == 5:
                            if not any(l.get("userId") == uid and l.get("week") == w and l.get("type") == "PERFECT_6_0_BONUS" for l in ledger):
                                ledger.append({
                                    "id": f"ledg_auto_60_{uid}_w{w}",
                                    "userId": uid,
                                    "userName": user["name"],
                                    "week": w,
                                    "type": "PERFECT_6_0_BONUS",
                                    "amount": -5,
                                    "description": f"🔥 Perfect Week {w} (5-0)! +$5 cash bounty automatically awarded",
                                    "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                })
                                ledger_modified = True
                        else:
                            auto_item = next((l for l in ledger if l.get("id") == f"ledg_auto_60_{uid}_w{w}"), None)
                            if auto_item:
                                ledger.remove(auto_item)
                                ledger_modified = True

                        # Awful week: 0-5 (-$5 penalty into pot)
                        if losses == 5:
                            if not any(l.get("userId") == uid and l.get("week") == w and l.get("type") == "AWFUL_0_6_PENALTY" for l in ledger):
                                ledger.append({
                                    "id": f"ledg_auto_06_{uid}_w{w}",
                                    "userId": uid,
                                    "userName": user["name"],
                                    "week": w,
                                    "type": "AWFUL_0_6_PENALTY",
                                    "amount": 5,
                                    "description": f"💀 Awful Week {w} (0-5) Penalty: $5 automatically added to pot",
                                    "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                })
                                ledger_modified = True
                        else:
                            auto_item = next((l for l in ledger if l.get("id") == f"ledg_auto_06_{uid}_w{w}"), None)
                            if auto_item:
                                ledger.remove(auto_item)
                                ledger_modified = True
                    else:
                        # If not all games are final, ensure auto items for this week are removed
                        auto_60 = next((l for l in ledger if l.get("id") == f"ledg_auto_60_{uid}_w{w}"), None)
                        if auto_60:
                            ledger.remove(auto_60)
                            ledger_modified = True
                        auto_06 = next((l for l in ledger if l.get("id") == f"ledg_auto_06_{uid}_w{w}"), None)
                        if auto_06:
                            ledger.remove(auto_06)
                            ledger_modified = True

        if ledger_modified:
            self.save_state()

    def _generate_default_state(self) -> Dict[str, Any]:
        return {
            "currentWeek": 4,
            "seasonYear": 2026,
            "isSeasonStarted": True,
            "seasonOULocked": True,
            "users": [],
            "weeklyConfigs": {},
            "games": [],
            "picks": [],
            "seasonTeams": [],
            "seasonPicks": [],
            "ledger": [],
            "pastSeasons": [],
        }
