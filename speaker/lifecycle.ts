// Explicit lifecycles: one approval (every kind of item, for an agent or a sandbox host), one relay session and one
// browser site. A state change goes through transition(); a move missing from a table throws.

export type Table<S extends string, E extends string> = Readonly<Record<S, Readonly<Partial<Record<E, S>>>>>

export class IllegalTransition extends Error {
  constructor(machine: string, from: string, event: string) {
    super(`${machine} cannot ${event} while ${from}`)
  }
}

export function transition<S extends string, E extends string>(machine: string, table: Table<S, E>, from: S, event: E) {
  const to = table[from][event]
  if (to === undefined) throw new IllegalTransition(machine, from, event)
  return to
}

// One approval: waiting for the owner, then granted or denied. The rules may answer at once: open (an open read, not a
// grant) or denied. A pending one expires or is revoked; a granted one expires, is extended, or is revoked.
export const approvalStates = ['pending', 'open', 'granted', 'denied', 'expired', 'revoked'] as const
export type ApprovalState = (typeof approvalStates)[number]
export type ApprovalEvent = 'open' | 'grant' | 'deny' | 'extend' | 'expire' | 'revoke'
export const approvalTable: Table<ApprovalState, ApprovalEvent> = {
  pending: { open: 'open', grant: 'granted', deny: 'denied', expire: 'expired', revoke: 'revoked' },
  open: {},
  granted: { extend: 'granted', expire: 'expired', revoke: 'revoked' },
  denied: {},
  expired: {},
  revoked: {},
}

// One relay connection: it opens once it names a granted target or share, and closes once.
export type SessionState = 'connecting' | 'open' | 'closed'
export const sessionTable: Table<SessionState, 'begin' | 'close'> = {
  connecting: { begin: 'open', close: 'closed' },
  open: { close: 'closed' },
  closed: {},
}

// One logged-in browser site: off, or live (a Chromium session the owner opened) until the owner closes it, its lifetime
// runs out, its setup changes, or speaker stops.
export type BrowserState = 'off' | 'live'
export const browserTable: Table<BrowserState, 'open' | 'close'> = {
  off: { open: 'live' },
  live: { close: 'off' },
}
