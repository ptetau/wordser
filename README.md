# wordser

N-player scrabble on an infinite plain. Words never run out of room, letters
can be stolen, words can be rewritten under your opponents' feet, and every
day crowns a winner.

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

Tap a placed tile to steal or mutate its word. Drag to pan the infinite
board; pinch or scroll to zoom; arrow keys pan and `+`/`-` zoom from the
keyboard.

```sh
npm test           # engine + API test suite (node --test, no dependencies)
```

## The rules

- **Infinite board.** No edges, no centre star. The first word can be played
  anywhere; every later word must connect to what's on the board.
- **Classic premiums, tiled forever.** The premium squares are the actual
  classic scrabble layout — triple-word corners, double-word diagonal X's,
  the triple/double-letter diamonds — tiled seamlessly across the plane
  (the symmetric 15×15 board reduces to a 14×14 tile). A premium counts
  only when the letter on it changed that move.
- **Play after a friend.** You may only move after another player has moved —
  nobody plays twice in a row (waived while you're alone in the game).
- **Placing** works like scrabble: one row or column, no gaps, all resulting
  words must be real. Racks refill to 7 tiles from a bottomless bag; placing
  7+ tiles earns a 50-point bingo.
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
- **Bonus fruits.** Pac-man style, fruits appear on empty cells near the
  action (most moves spawn one; at most five at a time). Cover one with a
  newly placed letter to
  eat it: 🍋 lemon feeds you two extra letters, 🌶️ chilli hands you a
  high-scoring letter (J/Q/X/Z), 🍒 cherry lets you keep one letter from a
  choice of seven. Eating a cherry's choice doesn't use your turn.
- **Daily stars.** Scores reset every day (UTC). The player(s) with the top
  score of the day get a permanent ★ by their name.

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
compare-and-set on a sequence number. On Vercel, add the **Upstash for
Redis** integration (Storage tab) — the function picks up the
`KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) env vars
automatically. Without them the endpoint answers 501 and the site still
works as a hot-seat game. Games expire after 90 days of inactivity.
Clients poll every 3 seconds; the "you can only play after a friend" rule
keeps a polling cadence perfectly adequate.

The engine is UI-agnostic and deterministic (injectable RNG and clock), so a
networked server for real n-player play can sit on top of `Game` without
changes to the rules code.
