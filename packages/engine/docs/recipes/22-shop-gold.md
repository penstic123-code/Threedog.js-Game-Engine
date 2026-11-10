# Shop and gold: buy, sell / consign, gold HUD, saving

> **Covers:** gold as an item, buying and selling as two ops, a gold counter, saving.
> **Use when:** a shop, a trader, a currency.
> **Shortest:** `gold: { name: 'Gold', stack: 99999 }` in the items content.
> **Sections:** 1 Where to keep · 2 Data · 3 Buy, sell / · 4 Gold HUD · 5 Saving

Requires modules `inventory()` + `dialogue()` + `content()` (the gold HUD needs `hud()`). The engine has no "shop"
module: gold is an ordinary item, a shelf is an ordinary container, and buying and selling are two small ops that dialogue choices (or your own shop
window) run.

## 1. Where to keep gold (pick one)
| Form | Fits | Trade-off |
|---|---|---|
| **A. An item `gold` (recommended)** | Most games | `has / take / give` in content work directly; dialogue choice `if`, quest rewards, pickups and chests all understand it; saved with the inventory; **write `stack: 99999`** so it stays in one slot (by default 99 per slot; more spill into further slots, which only matters when the bag has a `capacity`) |
| B. A counter in `engine.vars` | Very large amounts, no slot wanted, must not be stolen / dropped | `vars.bump('gold', 50)` adds, `vars.counter('gold')` reads, saved with the game; the content `counter` condition can check "enough?", but the content `bump` effect only does +1, so charge money inside an op (`vars.bump('gold', -5)` in its `run`); it cannot be `transfer`red and does not appear in the inventory window |

The rest is written for A.

## 2. Data
`content/items.js`:
```js
export default {
  gold: { name: 'Gold', icon: '🪙', stack: 99999 },  // currency: one slot however much
  medkit: { name: 'Medkit', price: 5 },  // price: read by the shop ops below
};
export const startItems = { gold: 12 };
```
`content/containers.js` (the shelf. `items` is the initial stock, placed only the first time; a shelf that was emptied by looting / selling stays
empty after loading, see recipe 03):
```js
export default { 'shop-trader': { capacity: 6, items: { medkit: 3 } } };
```
Import it in `content/index.js` and put it in the exported object (`containers`).

## 3. Buy, sell / consign (two ops + dialogue choices)
Buying and selling are things the player decides to do, so they are ops (`recipes/23-ops.md`): define them once in `main.js`, and every caller
(dialogue choice, a shop window button, the dev bridge, a test) runs the same `can` / `run`. A trade is one whole step, so both are `atomic: true` (recipe 23 section 12): `run` frees room
first, and when the other side cannot take its part it returns `{ ok: false, code }` and the engine puts the bag and the shelf back. **Buy** needs stock on the shelf and the money.
**Consign**: the player puts something on the shelf, and the shelf pays when it accepts it.
```js
// main.js (after engine.use(...inventory()...))
const price = (e, item) => e.inventory.item(item).price ?? 1;
const payout = (e, item) => Math.max(1, Math.floor(price(e, item) * 0.6));  // add and remove take 1 or more, never 0
engine.ops.define('shop.buy', {
  atomic: true,
  args: { shop: 'string', item: 'string' },
  can(e, { shop, item }, ctx) {
    if (!e.inventory.container(shop).has(item)) return 'soldOut';
    if (!e.inventory.container(ctx.actor).has('gold', price(e, item))) return 'noMoney';
    return true;
  },
  run(e, { shop, item }, ctx) {
    e.inventory.container(ctx.actor).remove('gold', price(e, item));  // first: the last coins free their slot for the goods
    return e.inventory.transfer(shop, ctx.actor, item, 1) || { ok: false, code: 'bagFull' };
  },
  reasons: { soldOut: 'Shelf is empty', noMoney: 'Not enough gold', bagFull: 'No room in the bag' },
});
engine.ops.define('shop.sell', {
  atomic: true,
  args: { shop: 'string', item: 'string' },
  can(e, { shop, item }, ctx) {
    if (!e.inventory.container(ctx.actor).has(item)) return 'notInBag';
    return e.inventory.container(shop).room(item) > 0 || 'shelfFull';
  },
  run(e, { shop, item }, ctx) {
    const bag = e.inventory.container(ctx.actor), pay = payout(e, item);
    e.inventory.transfer(ctx.actor, shop, item, 1);  // first: the last piece frees its slot for the gold
    if (bag.room('gold') < pay) return { ok: false, code: 'bagFull' };
    bag.add('gold', pay, { silent: true });
    return 1;
  },
  reasons: { notInBag: 'Nothing to sell', shelfFull: 'The shelf is full', bagFull: 'No room for the gold' },
});
```
In the dialogue, `if: { can: [...] }` shows a choice only when `can` passes, and `do: { op: [...] }` runs it. `bagFull` comes back from `run`
(`r.code`), not `can`: it is only known once the goods have moved:
```js
// content/dialogues.js
const buyKit = ['shop.buy', { shop: 'shop-trader', item: 'medkit' }];
const sellKit = ['shop.sell', { shop: 'shop-trader', item: 'medkit' }];
export default {
  trader: {
    speaker: 'Trader',
    nodes: {
      start: {
        text: 'What do you need?',
        choices: [
          { text: 'Buy a medkit (5 gold)', next: 'start', if: { can: buyKit }, do: { op: buyKit } },
          { text: 'Sell a medkit (3 gold)', next: 'start', if: { can: sellKit }, do: { op: sellKit } },
          { text: 'Bye', next: 'end' },
        ],
      },
    },
  },
};
```
- The shelf id (`'shop-trader'`: a market stall, a ship's store, a vending machine) is any string, and the shelf contents are saved. A "shop window" is your own UI drawn from `shelf.list()`; its
  buttons call `engine.ops.run('shop.buy', { shop, item })` and grey out with `engine.ops.can(...)`.
- Prices live on the item (`price` in items.js above), read with `e.inventory.item('medkit').price`; an item without one costs 1 here. A price is a whole number of 1 or more.
- Items with their own data (a used sword with `durability`, recipe 03): pass the entry key as `item` (`'sword#3'`, from `shelf.list()[i].key`);
  `transfer` moves exactly that piece with its data, and `e.inventory.container(shop).get(item)` reads the data for a price
  (`def.price * data.durability / 100`).
- Show a failure reason to the player through your own i18n string (`e.t('shop.' + r.code)`); the engine shows nothing itself.
- `threedog ops` lists what can be bought right now if you add `offers` (see recipe 23); `threedog op shop.buy shop=shop-trader item=medkit`
  buys from the terminal.

## 4. Gold HUD
Calling `hud.addCounter` again with the same id = update, and it leaves the DOM alone when the value is unchanged, so calling it every frame is cheap:
```js
engine.onFrame(() => engine.hud.addCounter('gold', { icon: '🪙', label: 'Gold', value: engine.inventory.count('gold') }));
```
Loading a save replaces the whole inventory, and refreshing every frame follows naturally; no event listener is needed.

## 5. Saving
The inventory (gold included) and every container with contents are saved automatically; a shelf that was sold out is remembered too (`{}`), and
loading does not restock it. You write nothing.
