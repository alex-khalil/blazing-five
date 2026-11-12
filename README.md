# 🔥 Blazing 5 NFL Pick'em (100% Pure Python)

This entire application is written in **100% pure Python**. There is **no TypeScript required** to run, maintain, modify, or deploy this project.

---

## ⚡ How to Run Standalone (Zero Dependencies / Pure Python)

You can run this application anywhere with standard Python 3.10+ and **zero pip installs**:

```bash
python3 app.py
```

Open your browser to:
👉 **`http://localhost:3000`**

---

## 📂 Project Structure (All Python & Standard HTML)

- **`app.py`**: The main Python web server. Handles all HTTP routing, HTML page rendering, and JSON API requests (`/api/state`, `/api/standings`, `/api/picks/submit`, etc.) using Python's built-in `http.server`.
- **`league_store.py`**: The complete Python league rules and state engine:
  - 5 Against-The-Spread picks per week with 1 Lock (±2 wins/losses).
  - Blazing Week declarations (all 5 picks become LOCKs worth ±2 each).
  - Pre-season 5-team Over/Under win totals with 1 Lock.
  - Kickoff lockouts and mandatory must-pick featured game enforcement.
  - Standings calculation, tiebreaker ranking, and 50%/25%/12.5%/7.5%/5% pot payouts.
  - $5 cash bounty for perfect weeks (6-0/5-0) and $5 penalty for winless weeks (0-6/0-5).
  - Multi-year season rollovers.
- **`templates/index.html`**: The complete, modern dark-mode user interface. Styled with Tailwind CSS via CDN and vanilla JavaScript for dynamic UI updates (tab switching, bet slip, lock toggles, modals). No Node.js build step or TypeScript compiler required.
- **`data/blazing5-league.json`**: Plain JSON database storing all users, picks, spreads, scores, and the financial audit ledger.

---

## 🛠️ Commissioner & League Rules Included

1. **Must-Pick Game Chooser**:
   - Rotate or assign which member chooses the featured game each week.
   - Commissioner can change the chooser directly from the picks screen or from the 18-week rotation grid in the Commissioner tab.
2. **Blazing Week Overrides**:
   - Commissioner can view, assign, change, or reset any member's Blazing Week at any time.
3. **Official Vegas Spreads**:
   - No external polling dependencies; commissioner can override spreads, edit scores, or simulate game results anytime.
4. **Audit Ledger & Pot Math**:
   - $25 buy-in per player.
   - Payout structure: 1st (50%), 2nd (25%), 3rd (12.5%), 4th (7.5%), 5th (5%).

---

## 🚀 Deploying to Production (Render, Railway, Fly.io, or VPS)

To deploy to any cloud host:
1. Set the Start Command to: `python3 app.py`
2. Set the `PORT` environment variable if your host specifies one (default is `3000`).
3. (Optional) Mount a persistent volume at `/data` so `data/blazing5-league.json` persists across container restarts.
