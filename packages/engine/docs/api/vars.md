# engine.vars (Vars) — engine.vars: story flags and counters (autosaved)

- `vars.flag(key: string) → any` — Read a flag
- `vars.setFlag(key: string, value?: any)` — Set a flag (default true)
- `vars.counter(key: string) → number` — Read a counter (0 if none)
- `vars.bump(key: string, n?: number) → number` — Counter +n (default 1), returns the new value
- Properties:
  - `flags: Record<string, any>` All flags
  - `counters: Record<string, number>` All counters
