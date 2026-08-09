# wordser

N-player scrabble on an infinite plain. Words never run out of room, letters
can be stolen, words can be rewritten under your opponents' feet, and every
day crowns a winner.

## Play it

```sh
npm start          # then open http://localhost:8080/
```

Hot-seat multiplayer: add a player per friend, click an empty cell, type a
word, press Enter. Click a placed tile to steal or mutate its word. Drag to
pan the infinite board, scroll to zoom.

```sh
npm test           # engine test suite (node --test, no dependencies)
```

## The rules

- **Infinite board.** No edges, no centre star. The first word can be played
  anywhere; every later word must connect to what's on the board.
- **Criss-cross premiums.** Double/triple letter and word squares recur
  forever in a diagonal criss-cross lattice (period 8 in both directions).
  Word premiums dot one family of diagonals, letter premiums the family in
  between. A premium counts only when the letter on it changed that move.
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
public/          canvas UI for hot-seat play (no build step, plain ES modules)
public/data/     bundled word list
test/            node:test suite
server.js        tiny static server for local play
```

The `public/` directory is a self-contained static site, so it deploys
anywhere static files go (Vercel picks it up with zero configuration).

The engine is UI-agnostic and deterministic (injectable RNG and clock), so a
networked server for real n-player play can sit on top of `Game` without
changes to the rules code.
