# wordser

N-player scrabble on a looping 448×448 world. Letters can be stolen, words
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
  Friends open it, pick a name, and join from their own phones or laptops,
  and everyone already at the table is told the moment somebody new arrives.
  The server validates every move with the same rules engine, so nobody can
  cheat their rack. (Locally `npm start` serves the API from memory; the
  deployed site stores games in Redis.)

Two things belong to you rather than to the table, and both live as menus in
the masthead: **👤 your account** (sign in, or make one; change your
passphrase; switch turn alerts on) and **🎲 your games** (every table you're
at, whose turn it is at each, and a badge counting the ones waiting on you).
Turn on 🔔 *Tell me when it's my turn* and the browser taps you on the
shoulder when a game is yours to move — including games in other tabs, which
are polled once a minute in the background.

Tap a placed tile to steal or mutate its word — a steal is spelled right
over the old word (its letters are yours to reuse; arrows slide your word
along the line), and a mutation tells you which tile the swap puts in your
rack, since that is all it pays: it costs no points and no turn. Tapping an empty cell guesses which way the word should run from the
letters around it — a slot between two tiles, a neighbour on one side, or
the roomier axis at a corner — and when nothing is touching it points at
the nearest word instead, along the axis that word lies on, so spelling and
then sliding with the arrow keys walks you into it. Space or the direction
button overrides it. The placement controls are labelled (**✕ cancel · → dir · ⌫ undo ·
✓ play**), and ✓ carries the score, greying out with the reason when the
word won't do. Whose go it is is on a plaque in the top-left corner of the board — the
current player's name, large enough to settle an argument across a table —
and every seat in the players list is tagged **to play** or **waiting**. The view stays where you
put it; switch on *Glide the view to each new word* under the table's rules
if you would rather it follow the play. Drag to
pan; pinch or scroll to zoom, or use the **＋ －** buttons on the board.
**⌖** returns you to the last word played — handy on a 448-cell world.
The last word always wears a halo: light spilling onto the board around it,
never over the letters, so somebody else's move is obvious the moment you
look.
Once the first word is down, the setup controls (adding players, the share
link, ending the day) fold away under *Players & setup* so the panel is
mostly the game; open the fold any time and it stays open. The arrow keys drive a board cursor (the viewport follows):
type to start a word at the cursor, press Enter on a tile to steal/mutate
it, and `+`/`-` zoom. The tray is twelve addressable slots rather than a packed row:
drag a tile into any of them, including the empty ones, and it stays where
you put it — slots are addresses, so two tiles trade places rather than the
row shuffling along. Laying out `C _ T` with a hole in the middle is how you
see the play before you make it. A tile can also be dragged **out of the
tray and onto the board**, where it starts a word on that cell or carries on
the one you're spelling. Dragging works mid-word, and a letter already
placed leaves its slot open rather than closing the tray up. ⇄ shuffle
rearranges the lot. Your name
is remembered between visits, and a fresh game starts with the cursor
already on the ★. Controls you have never used carry a slow glint until you
try them once. **Add CPU player 🤖** works in both modes: local games
run the CPU in the browser, online games run it server-side — it takes its
turn in the same request that applies yours, using the same rules-engine
search. The game wears the Parlour look (mahogany tiles on green baize);
alternative themes live in `public/themes/` for anyone who wants to swap. The
bonus fruit are drawn with canvas paths rather than emoji (`public/fruit.js`),
so they look the same on every device and match the board's own palette.
They fidget, too: one fruit at a time, every few seconds, does a single
cheeky thing — a shimmy, a hop, a roll — and then sits still, so the board
has some life in it without turning into a screensaver or a permanent frame
loop.

```sh
npm test           # engine + API test suite (node --test, no dependencies)
```

## The rules

- **A looping world.** The board is a 448×448 torus: walk off one edge and
  you come back on the other, and words may wrap around the seam. The
  opening word on an empty board must cover the ★ start cell (always on a
  double-word star); every later word must connect to what's on the board.
  The ★ moves each day, but the letters stay, so from day two the action
  carries on where the words already are.
- **Classic premiums, tiled forever.** The premium squares are the real
  scrabble board — triple-word corners, the double-word diagonal X, the
  triple/double-letter diamonds — tiled edge to edge at its own scale. The
  board's last row and column repeat its first, so the tile is 14 squares
  rather than 15: neighbouring boards share a single triple-word rim
  instead of each bringing their own and doubling it at the join. 14
  divides the 448-cell world exactly 32 times, so the pattern meets itself
  at the seam too.
- **A premium pays once, ever.** The first letter to land on a premium
  square collects it, and the square is plain board from then on — a corner
  triple-word cannot be re-mined by writing over the same cell tomorrow.
  It follows that **adding to a word pays face value for the letters
  already down**: only what you put there this move can carry a bonus, and
  only if nobody has taken it. The world is 200,000 cells; the bonuses are
  out where the words aren't.
- **Turns, or a free-for-all.** New games rotate in seat order: the game
  says whose go it is and refuses anybody else. The admin can switch the
  table to **free-for-all**, where anyone may play so long as they don't go
  twice running. Either way nobody takes two turns in a row — not across a
  day boundary, and not when you're the only player, where the way on is to
  invite a friend or add a CPU.
- **Skipping idlers.** The admin can skip whoever is holding things up, and
  a seat that sits on its turn for **eight hours** is passed by
  automatically. The clock runs from when the turn arrived, not from your
  last move, so waiting all day for your go never costs you it. CPU seats
  are never skipped.
- **One payday per word.** A word pays a given player once a day. Flipping
  a letter back and forth to re-bank the same word scores nothing, and the
  log says so. The ledger is per player and clears with the new day.
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
  immediately — or cancel the proposal outright, and playing on (placing,
  stealing, overwriting, exchanging) also cancels it. If the timer
  expires with no objection, the day ends. Passing leaves the proposal
  running, and CPU players always agree.
- **Stealing.** Replace any word on the board with your own word laid along
  the same line (it may be shorter or longer, and must overlap the word it
  replaces; every resulting word must be real). Old letters you reuse stay on
  the board; the leftovers are stolen into your rack up to a maximum of
  **12 rack tiles — anything over that drops back into the bag**.
- **Overwriting.** Lay a word straight across letters already down. Every
  word it touches must still be real, it has to say something new, and the
  letters you cover are prised off the board and are yours. Letters that
  already fit are restated for free — COT over CAT spends only the O.
- **Mutating.** Swap a single letter of a board word for one of yours if
  every word through that cell stays real. The ousted letter takes the place
  of the tile you spent, so it always joins your rack. A mutation is a
  **trade, not a play**: it scores nothing, and it doesn't use your turn —
  the tile is the whole point of it. Fix your rack from the board, then play
  the word it sets up. (It follows that a mutation neither breaks a run of
  passes nor cancels a proposal to end the day; only playing does that.)
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
  turn down from a cherry go straight back in. Nothing announces what has
  appeared: the board shows a fruit, and what it gives is for the player who
  eats it to find out.
- **Running the table.** Whoever starts the game is its **admin 👑** (never
  a CPU seat — the first human to join takes it instead). The admin can
  **remove** any other player, whose letters go back into the day's bag and
  whose seat closes up behind them, and can **hand the admin rights** to
  another human. Handing over is one-way: only the new admin can give them
  back.
- **A new mark when the bag runs dry.** The moment the day's last letter is
  drawn, the ★ jumps at least twenty cells clear of where it was.
- **Accounts.** Sign in under **👤** with a name and a passphrase and your
  games follow you to any device: the seats you hold are tied to the
  account, so opening a game link on your phone puts you back in your own
  chair. The same menu holds your profile — the tables you're at, the stars
  you've won, and a passphrase change (which needs the old one, and leaves
  the sessions you already have open, so it can't sign you out mid-game).
  The passphrase is stretched with scrypt over a per-account salt and
  compared in constant time; it is never stored. Playing without an account
  works exactly as before.
- **Your games, in one place.** **🎲** lists every table you're at, newest
  first, with the day, your score and whose move it is; the ones waiting on
  you carry a ● and the button a badge. Signed in, the list comes from the
  server and is the same on every device. Signed out, it's whatever this
  browser has joined — the game itself is still there, it just can't follow
  you elsewhere.
- **Turn alerts.** Switch on 🔔 *Tell me when it's my turn* and a
  notification arrives when a game is yours to move. Nothing is ever sent
  for the game you're looking at — you can see the banner — and each table
  may only speak once per turn, so a phone that slept through three of your
  games wakes to three lines, not thirty. Games other than the one on
  screen are checked once a minute; turns take hours, so that's ample. The
  tab title carries a ● as well, for anyone who would rather not grant the
  permission.
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
