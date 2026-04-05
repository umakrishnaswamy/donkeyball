# 🫏 Donkeyball Tournament App

A self-contained tournament management web app built for Uma's donkeyball tournaments. Handles player signups, team generation, and a live bracket display designed to be Chromecast'd to a TV.

## What's in here

| File | Purpose |
|------|---------|
| `server.js` | The entire app — Node.js HTTP server, all HTML/CSS/JS served inline, no build step |
| `Dockerfile` | Containerizes the app for Render deployment |
| `fly.toml` | Fly.io config (not currently used — Render is live instead) |
| `render.yaml` | Render deployment config |
| `package.json` | Minimal metadata, no npm dependencies |
| `notes.txt` | Running list of improvements for next tourney |

Data is stored in **Upstash Redis** (free tier) — survives server restarts, sleep cycles, and redeployments.

---

## The three pages

### `/signup` — Player registration
Share this link in your Partiful invite. People enter their name and hit submit. Works on mobile, no account needed. The page auto-refreshes every 4 minutes to keep the server alive while people are signing up.

### `/admin` — Your control panel
Run everything from here. Three tabs:

- **Players** — See everyone who signed up. Add or remove people manually.
- **Teams** — Click "Auto-Generate Teams" to randomly pair players into teams of 2. Use the "Move to..." dropdown next to any player to swap them to a different team.
- **Bracket** — Click "Generate Bracket" to seed the tournament. With 4+ teams it splits into Table 1 and Table 2 automatically. Click the winner buttons after each game to advance teams.

### `/tv` — Live bracket display
Put this on the TV (Chromecast or just mirror your screen). Auto-refreshes every 3 seconds. Shows both table brackets side by side with active matches highlighted. Pops a champion banner when a table is won.

---

## How to run the next tournament

### Before the event
1. Clear old data: go to `/admin` → Players tab → remove everyone
2. Share `/signup` in the Partiful invite
3. Watch signups roll in at `/admin`

### Day of
1. Wake the server: visit `/signup` yourself first so Render spins up
2. **Admin → Teams** → "Auto-Generate Teams"
3. Swap anyone around using "Move to..." if needed
4. **Admin → Bracket** → "Generate Bracket"
5. Chromecast `/tv` to the TV

### During the tournament
After each game, go to **Admin → Bracket** and click the winner. The TV updates within 3 seconds.

---

## Infrastructure

- **Hosting**: [Render](https://render.com) free tier — `https://donkeyball.onrender.com`
- **Database**: [Upstash Redis](https://console.upstash.com) free tier — database named `donkeyball`
- **Code**: [github.com/umakrishnaswamy/donkeyball](https://github.com/umakrishnaswamy/donkeyball)

To redeploy after changes: push to `main` on GitHub → Render auto-deploys. Or hit "Manual Deploy" in the Render dashboard.

> **Note**: Render free tier sleeps after 15 min of inactivity. First request after idle takes ~30-50 seconds to wake up. During the actual event this isn't an issue since people are actively using it.

---

## Next steps (from notes.txt)

- [ ] **Draggable team cards in admin** — right now swapping players uses a dropdown ("Move to..."). Would be smoother as drag-and-drop between team cards.
- [x] ~~TV display color scheme~~ — done (deep navy/purple bg, orange-pink gradient, emerald winners)

### Other ideas for next time
- Score tracking within a match (not just win/loss)
- Seeding by previous tournament results
- QR code on the TV display pointing to the signup link
- Notification when a team's match is "UP NEXT"
- button to clear participants
