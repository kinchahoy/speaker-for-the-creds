// Explicit lifecycles: one approval (every kind of item, for an agent or a sandbox host) and one relay session. A state
// change goes through transition(); a move missing from a table throws.

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

// One approval: waiting for the owner, then granted or denied. A pending one expires when nobody decides in time, or is
// revoked when what it asks for goes away; a granted one expires at its end, is extended by the owner, or is revoked.
export const approvalStates = ['pending', 'granted', 'denied', 'expired', 'revoked'] as const
export type ApprovalState = (typeof approvalStates)[number]
export type ApprovalEvent = 'grant' | 'deny' | 'extend' | 'expire' | 'revoke'
export const approvalTable: Table<ApprovalState, ApprovalEvent> = {
  pending: { grant: 'granted', deny: 'denied', expire: 'expired', revoke: 'revoked' },
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
