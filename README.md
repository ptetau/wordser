# wordser

N-player scrabble on a looping 120×120 world. Letters can be stolen, words
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
along the line), and mutations pick from a letter grid. The ✓ button shows
the points a play will score before you commit. Drag to pan; pinch or
scroll to zoom. The arrow keys drive a board cursor (the viewport follows):
type to start a word at the cursor, press Enter on a tile to steal/mutate
it, and `+`/`-` zoom. Drag rack tiles to rearrange them (or ⇄ shuffle). Your name
is remembered between visits, and a fresh game starts with the cursor
already on the ★. **Add CPU player 🤖** works in both modes: local games
run the CPU in the browser, online games run it server-side — it takes its
turn in the same request that applies yours, using the same rules-engine
search. The game wears the Parlour look (mahogany tiles on green baize);
alternative themes live in `public/themes/` for anyone who wants to swap.

```sh
npm test           # engine + API test suite (node --test, no dependencies)
```

## The rules

- **A looping world.** The board is a 120×120 torus: walk off one edge and
  you come back on the other, and words may wrap around the seam. The first
  word must cover the ★ start cell (always on a double-word star); every
  later word must connect to what's on the board.
- **Classic premiums, tiled forever.** The premium squares are the actual
  classic scrabble layout — triple-word corners, double-word diagonal X's,
  the triple/double-letter diamonds — stretched to double scale and tiled
  seamlessly around the torus (period 30 divides the 120-cell world). A
  premium counts only when the letter on it changed that move.
- **Play after a friend.** You may only move after another player has moved —
  nobody plays twice in a row (waived while you're alone in the game).
- **Placing** works like scrabble: one row or column, no gaps, all resulting
  words must be real. Racks refill to 7 tiles from a real scrabble bag —
  **one standard 100-tile set per day**, drawn without replacement. When
  the day's bag runs dry there are no more draws until tomorrow (steals
  and mutations still work — board letters become the economy). Placing
  7+ tiles earns a 50-point bingo.
- **Exchanging.** Instead of playing a word, swap 1–7 rack letters back
  into the bag for fresh ones. It uses your turn, and needs the bag to
  hold at least as many tiles as you give back. A stuck CPU exchanges
  rather than passing when it can.
- **Stealing.** Replace any word on the board with your own word laid along
  the same line (it may be shorter or longer, and must overlap the word it
  replaces; every resulting word must be real). Old letters you reuse stay on
  the board; the leftovers are stolen into your rack up to a maximum of
  **12 rack tiles — the rest are discarded**.
- **Mutating.** Swap a single letter of a board word for one of yours if
  every word through that cell stays real. The ousted letter joins your rack
  (space permitting).
- **Wildcard redefinition.** A blank on the board may be redefined to a
  different letter to fit the word you are playing, provided every word
  through it stays real. Blanks always score 0.
- **Bonus fruits.** Pac-man style: a fresh world starts with a dozen fruits
  scattered widely across it, and most moves spawn another near the action
  (never bunched together, twelve at most). Cover one with a newly placed
  letter to eat it: 🍋 lemon feeds you two extra letters, 🌶️ chilli hands
  you a high-scoring letter (J/Q/X/Z), 🍒 cherry lets you keep one letter
  from a choice of seven (choosing doesn't use your turn), 🍇 grape is
  worth 10 bonus points, 🍌 banana deals you a completely fresh rack, and
  🥝 kiwi hands you a wildcard.
- **Daily stars.** Scores reset every day (UTC), everyone is dealt a fresh
  rack, and the ★ start cell wanders to a different double-word star. The
  player(s) with the top score of the day get a permanent ★ by their name.

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
