# Co-op multiplayer: net() (host authority + state sync)

> **Covers:** co-op over the network: host authority, actors, what is synced, security.
> **Use when:** two or more players in one game.
> **Shortest:** `engine.use(net({ role: 'host', transport: webSocket(room, { host: true }) }))`.
> **Sections:** 1 Install · 2 Mark the ops · 3 Who is who · 4 What is synced · 5 Write the UI · 6 Security notes

**What it is**: co-op, host-authoritative, not for competitive play. An optional module for slow, cooperative games (a shared base, a co-op
puzzle, a turn-based board, trading). One player's browser is the **host** and
owns the game state; friends are **clients** that mirror it and ask for changes through ops. Not installed = no cost.
**What it is not (yet)**: action netcode. There is no client prediction or rollback, so a client's attack / roll / shot waits one round trip.

## 1. Install
The same game code runs on every machine; only `role` and the transport differ.
```js
import { net, webSocket } from 'threedog';

const room = 'ws://192.168.1.5:8787/my-game';
const hosting = new URLSearchParams(location.search).has('host');
engine.use(net(hosting
  ? { role: 'host', transport: webSocket(room, { host: true }) }
  : { role: 'client', transport: webSocket(room) }));
```
Run the relay on any machine both can reach: `threedog relay 8787` (no dependencies). The relay only forwards; it assigns peer ids
and a reconnect key.
For tests and offline demos use the in-process network instead (latency, jitter and loss adjustable; `manual: true` delivers only on `advance(ms)`):
```js
import { createEngine, fakeNetwork, net } from 'threedog';
const [host, guest] = [1, 2].map(() => createEngine({ canvas: document.createElement('canvas') }));  // two games on one page
const wire = fakeNetwork({ latency: 80, jitter: 30, loss: 0.05 });
host.use(net({ role: 'host', transport: wire.host() }));
guest.use(net({ role: 'client', transport: wire.connect() }));
```
Other carriers (Colyseus room, WebRTC data channel, your own server) only need `send(msg, to?)`, `on(type, fn)` and `close()`; see the top of
`modules/net/transports.js`.
Example: the co-op test page in the engine repository, tests/coop/ (host + two guests in one page, shared chest, shop, plots; open
/tests/coop/index.html with `npm run dev`).

## 2. Mark the ops friends may request: `net: 'peer'`
Default deny: a client may only request ops defined with `net: 'peer'`. Everything else is refused with `'notAllowed'`, on the client at once and
again on the host.
```js
engine.ops.define('chest.take', {
  net: 'peer',  // friends may ask for this
  args: { chest: 'id', item: 'string', n: 'int?' },  // the host always checks peers' args against this shape ('badArgs')
  can: (e, { chest, item, n = 1 }) => e.inventory.container(chest).has(item, n) || 'empty',
  run: (e, { chest, item, n = 1 }, ctx) => e.inventory.transfer(chest, ctx.actor, item, n),
});
engine.ops.define('plot.water', {
  net: 'peer', args: { id: 'id' },
  owner: a => a.id,  // the record a.id must have owner === the requesting actor, else 'notOwner'
  run: (e, { id }) => e.world.set(id, { water: (e.world.get(id)?.water ?? 0) + 1 }),
});
engine.ops.define('cheat.gold', { args: { n: 'int' }, run: (e, { n }, ctx) => e.inventory.container(ctx.actor).add('gold', n) });  // host only
```
| Mark | Who can run it | Use for |
|---|---|---|
| (nothing) | host only | cheats, debug, admin, anything a friend must not trigger |
| `net: 'peer'` | host, and clients by request | buy, sell, give, take, build, water, talk choices that change state |
| `net: 'local'` | every machine on its own | ops that only touch this machine (UI, dialogue, camera); peer ops they call are still sent to the host |

## 3. Who is who: actors
- On the host, a friend is an **actor** id taken from the connection (`'guest-1'`, change with `net({ actorFor: peerId => ... })`), never from the
  message. Ops see it as `ctx.actor`; that is why ops must use `ctx.actor`, not `engine.player`.
- By default the host gives each friend a world record `{ id: actor, kind: 'player' }` (not saved) and a container with the actor id (their bag,
  `inventory.of(actor)`). Pickups land in the bag of whoever takes them: a client's E press runs `pickup.take` (net: `'peer'`) on the host as that
  friend, and the host walks every friend into auto pickups (`pickups.takers`); `item:add` names the container and the actor on every machine.
  `onJoin(e, peer)` / `onLeave(e, peer)` add your own setup (starting gold, spawn point). `avatar: false` turns the defaults off.
- **Every machine calls itself `'player'`.** A client's own record and bag are `'player'` locally (so characters, inventory windows and interactions
  work unchanged), and the host's own avatar and bag show up as `'host'`. String args equal to `'player'` / `'host'` are translated on the way to the
  host. Record fields that hold actor ids are translated too when listed in `actorFields` (default `['owner']`).
- Draw other players with one presenter that skips yourself: `engine.world.present('player', { show: r => r.id !== 'player', build: ... })`.

## 4. What is synced
The host sends a full snapshot when a client joins (or after a lost message), then diffs every `syncEvery` fixed steps (default 3, 20 per second):
world records, containers, `vars`, and every other save part (quests, clock, sky, weather...) except `random`, `level` and `rigid`. Choose explicitly with
`sync: ['world', 'containers', 'vars', 'quests']`. Physics runs on each machine and is not synced, and machines need not agree on it
(why: [11-vehicles.md, Determinism](11-vehicles.md#3-rigid-bodies-saves-joints-determinism)).
On a client the mirror is applied at the next fixed step; `world.simulate` does not run there (the host simulates). Other players glide between
updates (kinds in `interpolate`, default `['player']`). The client moves its own avatar and reports its position; the host clamps it to `maxSpeed`
(m/s, default 15).
A character another machine drives is held by net for good: a local `walkTo`, cutscene or `engine.control.take` on one is `[control-net]` ([57-control](57-control.md)).

## 5. Write the UI from state, not from run's return value
On a client `engine.ops.run` returns `{ ok: true, pending: true, seq }` after the local `can` passed (so a "no money" refusal is still instant). The
real result comes later:
```js
engine.events.on('net:sync', () => redrawBag());  // state changed (snapshot or diff)
engine.events.on('net:result', r => { if (!r.ok) hint(engine.t('op.' + r.name + '.' + r.code)); });  // after the state it caused
```
Single-player gets the same events from your own domain events, so writing "react to state" now means nothing changes when net() is added. Other
events: `net:join` / `net:leave` (host), `net:open` / `net:close` (client). `engine.net.reconnect(webSocket(url, { key }))` reconnects with the same
actor (read `transport.key` after `open` and keep it, e.g. in localStorage).

## 6. Security notes
- The host checks, in order: rate (`rate` requests per second per peer, default 20, burst `burst`) -> op exists -> `net: 'peer'` -> args shape
  (always, also in production) -> `owner` -> the op's `can`. Refusals are logged in `engine.ops.recent()` with `source: 'net'` and the actor.
- `can` is the real gate. Anything a friend must not do (take from someone else's chest, buy without gold) must be refused in `can` or by `owner`; the
  client-side `can` is only for instant feedback and a hacked client can skip it.
- Ops get plain JSON args; never `eval` or index into functions with them. Return values sent back are plain data.
- Client guard (dev): on a client, writing shared state anywhere except the host's sync (a UI callback calling `inventory.add`, a module's fixed step)
  prints `[engine] net client changed shared state locally`. Turn it into an op request.
- The relay has no accounts or TLS; put it behind `wss://` for anything public. The room name is the only secret. Own-avatar movement is client-driven
  (only speed is clamped), which is fine for co-op and not for competitive games.
- Perf: the host compares JSON of every synced entry each sync. Hundreds of records are fine; for tens of thousands raise `syncEvery` or narrow `sync`.
