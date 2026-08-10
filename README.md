# wordser

N-player scrabble on a looping 512×512 world. Letters can be stolen, words
can be rewritten under your opponents' feet, bonus fruits dot the plain,
and every day crowns a winner.

## Play it

```sh
npm start          # then open http://localhost:8080/
```

Two ways to play:

- **Hot-seat**: add a player per friend on one screen. Tap an empty cell,
  spell a word by tapping rack tiles (or typing), hit ✓/Enter.
- **Over the internet**: press *Create online game* and share the link.
  Friends open it, pick a name, and join from their own phones or laptops.
  The server validates every move with the same rules engine, so nobody can
  cheat their rack. (Locally `npm start` serves the API from memory; the
  deployed site stores games in Redis.)

Tap a placed tile to steal or mutate its word — a steal is spelled right
over the old word (its letters are yours to reuse; arrows slide your word
along the line), and mutations pick from a letter grid. Tapping an empty cell
guesses which way the word should run from the letters around it — a slot
between two tiles, a neighbour on one side, or the roomier axis at a corner
— and Space or the direction button overrides it. The ✓ button shows
the points a play will score before you commit. When a word is played and
it isn't already on screen, the camera glides over to it, so you always see
what just happened — touch the board and the view is yours again. Drag to
pan; pinch or scroll to zoom. The arrow keys drive a board cursor (the viewport follows):
type to start a word at the cursor, press Enter on a tile to steal/mutate
it, and `+`/`-` zoom. Drag rack tiles to rearrange them (or ⇄ shuffle). Your name
is remembered between visits, and a fresh game starts with the cursor
already on the ★. Controls you have never used carry a slow glint until you
try them once. **Add CPU player 🤖** works in both modes: local games
run the CPU in the browser, online games run it server-side — it takes its
turn in the same request that applies yours, using the same rules-engine
search. The game wears the Parlour look (mahogany tiles on green baize);
alternative themes live in `public/themes/` for anyone who wants to swap.

```sh
npm test           # engine + API test suite (node --test, no dependencies)
```

## The rules

- **A looping world.** The board is a 512×512 torus: walk off one edge and
  you come back on the other, and words may wrap around the seam. The
  opening word on an empty board must cover the ★ start cell (always on a
  double-word star); every later word must connect to what's on the board.
  The ★ moves each day, but the letters stay, so from day two the action
  carries on where the words already are.
- **Classic premiums, tiled forever.** The premium squares are the actual
  classic scrabble layout — triple-word corners, double-word diagonal X's,
  the triple/double-letter diamonds — stretched to double scale and tiled
  seamlessly around the torus. Each board carries a one-square gutter of
  plain cells along two sides, making the tile 16 squares (32 cells) so it
  divides the 512-cell world exactly: 16 boards across, 256 in all, and the
  pattern meets itself perfectly at the seam. The gutter reads as the margin
  between boards laid side by side. A premium counts only when the letter on
  it changed that move.
- **Play after a friend.** You may only move after somebody else has moved.
  Nobody takes two turns in a row — not across a day boundary, and not even
  when you are the only player at the table, in which case the game tells
  you to invite a friend or add a CPU player 🤖. Eating a fruit's choice of
  letter, proposing the end of the day and voting on it are not turns, so
  they never unblock you.
- **One name each.** Two players in the same game can't share a name —
  case and stray spacing are ignored when comparing, so `Ada` and `  aDA `
  collide. Up to 16 players may sit at one online game.
- **Placing** works like scrabble: one row or column, no gaps, all resulting
  words must be real. Racks refill to 7 tiles from a real scrabble bag —
  **one standard 100-tile set per day**, drawn without replacement. When
  the day's bag runs dry there are no more draws until tomorrow (steals
  and mutations still work — board letters become the economy). Placing
  7+ tiles earns a 50-point bingo.
- **Every letter comes from the bag.** Nothing in the game mints a tile:
  fruits draw theirs from the day's set like everything else, and letters
  that leave a rack without reaching the board — steal leftovers, cherry
  offers you turn down, the rack of a player who is removed — fall back
  into the bag for someone else to draw. Within a day the hundred tiles
  are only ever moved between bag, racks and board. A new day is the one
  exception: it opens a brand-new set, and only the letters already on the
  board carry over.
- **Exchanging and passing.** Instead of playing a word, swap 1–7 rack
  letters back into the bag for fresh ones (needs the bag to hold at
  least that many), or pass outright. Both use your turn. When the bag
  is empty and every player passes in a row, **the day ends early** —
  stars are awarded, a fresh bag arrives, racks are re-dealt, and the ★
  moves. A stuck CPU exchanges what the bag can cover, else passes.
- **Proposing the end of the day.** Once the bag is empty, any player can
  **🌙 propose ending the day** (it doesn't use a turn). A 2-minute timer
  starts: other players can agree — unanimous agreement ends the day
  immediately — or cancel the proposal outright, and playing letters
  (placing, stealing, mutating, exchanging) also cancels it. If the timer
  expires with no objection, the day ends. Passing leaves the proposal
  running, and CPU players always agree.
- **Stealing.** Replace any word on the board with your own word laid along
  the same line (it may be shorter or longer, and must overlap the word it
  replaces; every resulting word must be real). Old letters you reuse stay on
  the board; the leftovers are stolen into your rack up to a maximum of
  **12 rack tiles — anything over that drops back into the bag**.
- **Mutating.** Swap a single letter of a board word for one of yours if
  every word through that cell stays real. The ousted letter takes the place
  of the tile you spent, so it always joins your rack.
- **Wildcard redefinition.** A blank on the board may be redefined to a
  different letter to fit the word you are playing, provided every word
  through it stays real. Blanks always score 0.
- **Bonus fruits.** Pac-man style, and always worth chasing: **every day
  lays out ten fruits within reach of the action** — arranged in a ring
  3 to 9 cells from the ★ and from words already on the board, so getting
  one takes a move or two of deliberate play rather than luck. Yesterday's
  leftovers are cleared away with yesterday's bag. Most moves spawn another
  near where you just played (never bunched together, twelve at most).
  Cover one with a newly placed letter to eat it: 🍋 lemon feeds you two
  extra letters, 🌶️ chilli hands you a high-scoring letter (J/Q/X/Z, or the
  best the bag has left), 🍒 cherry lets you keep one letter from a choice
  of seven (choosing doesn't use your turn), 🍇 grape is worth 10 bonus
  points, 🍌 banana deals you a completely fresh rack, and 🥝 kiwi hands you
  a wildcard. Every one of those letters is drawn from the day's bag — a
  fruit whose letter has run out simply fizzles, and the six letters you
  turn down from a cherry go straight back in.
- **Running the table.** Whoever starts the game is its **admin 👑** (never
  a CPU seat — the first human to join takes it instead). The admin can
  **remove** any other player, whose letters go back into the day's bag and
  whose seat closes up behind them, and can **hand the admin rights** to
  another human. Handing over is one-way: only the new admin can give them
  back.
- **Daily stars.** Scores reset every day (UTC), everyone is dealt a fresh
  rack from a new bag, the ★ start cell wanders to a different double-word
  star, and a fresh crop of fruit is laid out within reach. The player(s)
  with the top score of the day get a permanent ★ by their name.

## Dictionary

The rules call for the Oxford English Dictionary. The OED has no freely
redistributable machine-readable form, so `data/words.txt` ships SOWPODS
(the international scrabble list, ~268k words) as a stand-in. The engine
takes any object with a `has(word)` method, so an adapter over the OED API
can be plugged in by deployments holding a licence — see
`src/engine/dictionary.js`.

## Layout

```
public/engine/   game rules: board, premiums, tiles, dictionary, moves, scoring
public/themes/   selectable skeuomorphic looks for the board and page chrome
public/          canvas UI, touch + keyboard friendly (no build step, ES modules)
public/data/     bundled word list
api/game.js      online play: serverless endpoint running the same engine
test/            node:test suite
server.js        local server: static files + the API against an in-memory store
```

The `public/` directory is a self-contained static site (Vercel serves it
with zero configuration) and `api/` deploys as a Vercel serverless function.

### Online play storage

The API stores each game as one JSON document in Redis, written with a
compare-and-set on a sequence number. Any of these credentials work:
`KV_REST_API_URL`+`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_*` (REST), or
a plain `REDIS_URL` connection string (spoken over TCP/TLS by the
dependency-free client in `api/resp.js`). Without credentials the store is
in-memory — fine locally, but games would vanish on a serverless runtime.
Games are stored with no TTL: they stay alive forever.
Clients poll every 3 seconds; the "you can only play after a friend" rule
keeps a polling cadence perfectly adequate.

The engine is UI-agnostic and deterministic (injectable RNG and clock), so a
networked server for real n-player play can sit on top of `Game` without
changes to the rules code.
