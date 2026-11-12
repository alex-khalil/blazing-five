"""
Blazing 5 NFL Pick'em - Pure Python Web Application
Serves the complete HTML5 frontend and JSON API using Python's standard library.
Run standalone with: `python3 app.py` (Zero pip / Zero Node / Zero TypeScript required)
"""

import http.server
import json
import os
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from league_store import LeagueStore

PORT = int(os.environ.get("PYTHON_PORT", os.environ.get("PORT", 3000)))
league_store = LeagueStore()

def background_espn_syncer():
    """Background worker that periodically syncs live scores from ESPN every 60 seconds."""
    time.sleep(3)  # brief startup delay
    while True:
        try:
            curr_week = league_store.state.get("currentWeek", 4)
            league_store.sync_live_nfl_data(curr_week)
        except Exception as e:
            print(f"[ESPN Sync Worker] Error: {e}")
        time.sleep(60)

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")

class Blazing5Handler(http.server.BaseHTTPRequestHandler):
    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _read_body_json(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            return {}
        raw = self.rfile.read(content_length).decode("utf-8")
        return json.loads(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # --- Health & Diagnostic Endpoints ---
        if path == "/api/health":
            self._send_json({"status": "ok", "runtime": "python3", "time": datetime.now(timezone.utc).isoformat()})
            return

        # --- League State API ---
        query_params = urllib.parse.parse_qs(parsed.query)
        viewer_id = query_params.get("viewerId", [None])[0]

        if path == "/api/state":
            try:
                state = league_store.get_state(viewer_id)
                standings = league_store.get_standings()
                self._send_json({"success": True, "state": state, "standings": standings})
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, 500)
            return

        # --- League Picks for Week (Only revealed if game has started or own pick) ---
        if path == "/api/picks/league":
            try:
                week_param = query_params.get("week", [None])[0]
                week = int(week_param) if week_param else league_store.state.get("currentWeek", 4)
                picks = league_store.get_league_picks(week, viewer_id)
                self._send_json({"success": True, "week": week, "picks": picks})
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, 500)
            return

        # --- Standings API ---
        if path == "/api/standings":
            try:
                standings = league_store.get_standings()
                self._send_json({"success": True, "standings": standings})
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, 500)
            return

        # --- Commissioner Finances API ---
        if path == "/api/finances":
            try:
                finances = league_store.get_commissioner_finances()
                self._send_json(finances)
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, 500)
            return

        # --- Season O/U Summary API ---
        if path == "/api/season-ou/summary":
            try:
                summary = league_store.get_season_ou_summary()
                self._send_json(summary)
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, 500)
            return

        # --- Serve Web Frontend UI (templates/index.html) ---
        html_file = os.path.join(TEMPLATES_DIR, "index.html")
        if os.path.exists(html_file):
            with open(html_file, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return

        self.send_error(404, "Page or endpoint not found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            body = self._read_body_json()
        except Exception as e:
            self._send_json({"success": False, "error": f"Invalid JSON body: {e}"}, 400)
            return

        try:
            # Submit weekly 5 picks
            if path == "/api/picks/submit":
                user_id = body.get("userId")
                week = int(body.get("week", 1))
                picks = body.get("picks", [])
                is_blazing = bool(body.get("isBlazingWeek", False))
                res = league_store.submit_weekly_picks(user_id, week, picks, is_blazing)
                self._send_json(res)
                return

            # Submit season win totals
            if path == "/api/season-picks/submit":
                user_id = body.get("userId")
                picks = body.get("picks", [])
                res = league_store.submit_season_ou_picks(user_id, picks)
                self._send_json(res)
                return

            # Player self-declares blazing week
            if path == "/api/users/blazing-week":
                user_id = body.get("userId")
                week = int(body.get("week", 18))
                res = league_store.set_user_blazing_week(user_id, week)
                self._send_json(res)
                return

            # Commissioner toggles user buy-in status
            if path == "/api/finances/toggle-buyin":
                user_id = body.get("userId")
                paid = body.get("paid")
                res = league_store.toggle_user_buyin(user_id, paid)
                self._send_json(res)
                return

            # Commissioner toggles week unlock override
            if path == "/api/admin/toggle-week-unlock":
                week = int(body.get("week", 1))
                force_unlock = body.get("forceUnlock")
                res = league_store.toggle_week_force_unlock(week, force_unlock)
                self._send_json(res)
                return

            # Commissioner assigns/changes/resets blazing week
            if path == "/api/admin/user-blazing-week":
                user_id = body.get("userId")
                week = body.get("week")
                target_week = int(week) if week is not None and week != "" else None
                res = league_store.set_user_blazing_week(user_id, target_week)
                self._send_json(res)
                return

            # Player invited
            if path == "/api/users/invite":
                name = body.get("name")
                email = body.get("email")
                role = body.get("role", "player")
                if not name:
                    self._send_json({"success": False, "error": "Player name is required."}, 400)
                    return
                user = league_store.add_user(name, email, role)
                self._send_json({"success": True, "user": user, "message": f"{user['name']} added to the league!"})
                return

            # Set must-pick featured game
            if path == "/api/featured-game":
                week = int(body.get("week", 1))
                game_id = body.get("gameId")
                league_store.set_featured_game(week, game_id)
                self._send_json({"success": True, "message": f"Featured game chosen for Week {week}!"})
                return

            # Set must-pick chooser
            if path == "/api/admin/featured-picker":
                week = int(body.get("week", 1))
                picker_id = body.get("pickerId")
                league_store.set_featured_picker(week, picker_id)
                self._send_json({"success": True, "message": f"Featured picker updated for Week {week}!"})
                return

            # Override game spread or scores
            if path == "/api/admin/override-game":
                game_id = body.get("gameId")
                updates = body.get("updates", {})
                res = league_store.override_game(game_id, updates)
                self._send_json({"success": True, "game": res, "message": f"Game {game_id} overridden successfully."})
                return

            # Settle week bounties and penalties
            if path == "/api/admin/settle-week":
                week = int(body.get("week", 1))
                res = league_store.settle_week(week)
                self._send_json(res)
                return

            # Change active week
            if path == "/api/admin/set-week":
                week = int(body.get("week", 1))
                league_store.set_current_week(week)
                self._send_json({"success": True, "message": f"Active week set to Week {week}."})
                return

            # Trigger live ESPN NFL sync
            if path == "/api/nfl/sync":
                week_req = body.get("week")
                target_w = int(week_req) if week_req else None
                res = league_store.sync_live_nfl_data(target_w)
                self._send_json(res)
                return

            # Lock or unlock season O/U
            if path == "/api/admin/set-ou-lock":
                locked = bool(body.get("locked", True))
                res = league_store.set_season_ou_lock(locked)
                self._send_json(res)
                return

            # Annual rollover
            if path == "/api/admin/rollover-season":
                res = league_store.rollover_season()
                self._send_json(res)
                return

            self._send_json({"success": False, "error": f"Unknown POST endpoint {path}"}, 404)
        except Exception as e:
            self._send_json({"success": False, "error": str(e)}, 400)

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/users/"):
            user_id = path.replace("/api/users/", "").strip()
            try:
                body = self._read_body_json()
                user = league_store.update_user(user_id, body)
                self._send_json({"success": True, "user": user})
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, 400)
            return

        self._send_json({"success": False, "error": f"Unknown PATCH endpoint {path}"}, 404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/users/"):
            user_id = path.replace("/api/users/", "").strip()
            try:
                res = league_store.delete_user(user_id)
                self._send_json(res)
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, 400)
            return

        self._send_json({"success": False, "error": f"Unknown DELETE endpoint {path}"}, 404)

def run():
    # Start live ESPN polling thread
    sync_thread = threading.Thread(target=background_espn_syncer, daemon=True)
    sync_thread.start()

    server_address = ("0.0.0.0", PORT)
    httpd = http.server.ThreadingHTTPServer(server_address, Blazing5Handler)
    print(f"🔥 Blazing 5 Pick'em Python server running on http://0.0.0.0:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.server_close()

if __name__ == "__main__":
    run()
