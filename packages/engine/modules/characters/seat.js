// The seat: one relation { rider, vehicle, id, seat } between a character and anything with the vehicle contract. Owned here, so it holds whoever the control slot's holder is:
// a holder only says what the driver wants. The rider's world record keeps the vehicle id and the seat, written when the relation changes and read back on a load.
// Vehicles are found through one registry, not through the module that built them: rigid joins its cars, a game joins its own (characters.addVehicle), and enter joins whatever has an id.
// Why a vehicle that joins answers the records: a car built after the load is the same case as a car built before it, so the rider sits and the record never lies.
// Per engine, like the supports (movers/support.js): a hand-built Character has a seat with no module around it.
const books = new WeakMap();

/** @param {any} e @returns {{ rides: Set<any>, vehicles: Set<any> }} */
export function seatsOf(e) {
  let s = books.get(e);
  if (!s) books.set(e, s = { rides: new Set(), vehicles: new Set() });
  return s;
}

/** The vehicle a record names. A number is a save from before vehicles had ids: the place in the registry, as it was in rigid.vehicles */
export function vehicleById(e, ref) {
  const list = [...seatsOf(e).vehicles].filter(v => !v.gone);
  return ref == null ? null : typeof ref === 'number' ? list[ref] ?? null : list.find(v => v.id === ref) ?? null;
}

/** Back on the seat a record names. Whoever sits there now is from the state being replaced: it goes without touching its record, which its own turn reads */
export function seatFromRecord(c, v, seat) {
  if (seat == null) return c.enter(v);   // a save from before the seat was saved
  const other = seat === 0 ? v.driver : v.passengers?.find(r => r.seat === seat);
  if (other && other !== c) { const id = other.recordId; other.recordId = null; other.exit({ force: true }); other.recordId = id; }
  v.passengers ??= [];
  c._sit(v, seat);
}

/** The records that name this vehicle. A far NPC has no model, so only its record knows */
const ridersOf = (e, v) => (v.id == null ? [] : e.world.query({}).filter(r => r.vehicle === v.id));

/** characters.addVehicle: join the registry, and seat the riders whose record is waiting for this id. A far NPC is seated by its next build (npcView.js). A vehicle gone for good answers those records too: nothing will come for them */
export function addVehicle(e, v) {
  const book = seatsOf(e).vehicles;
  book.add(v);
  for (const rec of ridersOf(e, v)) { const c = e.control.characterOf(rec.id); if (c && !c.vehicle) seatFromRecord(c, v, rec.seat); }
  return { remove() { book.delete(v); if (v.gone) for (const { id } of ridersOf(e, v)) e.ops.allow(() => e.world.set(id, { vehicle: null, seat: null })); } };
}

/** Every fixed step, after the holders: a rider stays on its seat, and the pedal goes up when no one in charge is pressing it */
export function stepSeats(e) {
  for (const ride of [...seatsOf(e).rides]) {
    const { rider: c, vehicle: v, seat } = ride;
    c.root.position.copy(v.seatPosition(seat));
    // a visible rider turns with the vehicle (a hidden one only needs the position: saves, interactions, trigger zones measure from it)
    if (c.root.visible) { v.object.getWorldQuaternion(c.root.quaternion); c.facing = c.root.rotation.y; }
    c.moveAmount = Math.abs(v.speed); c.state = c.stateMark = 'drive';
    if (seat === 0) {
      const want = c._pedal?.();
      if (want) { v.drive(...want); ride.pedal = true; }
      else if (ride.pedal) { v.drive(0, 0, 0); ride.pedal = false; }   // only on the change: a game driving the car itself is not overwritten
    }
    c._store();
  }
}
