// Explicit lifecycles for sandbox hosts and relay sessions. Requests have none: their status is derived (statusOf in
// core.ts), and grants exist only while in force. A status change goes through transition(); a move missing from a
// table throws.

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

export const hostStates = ['pending', 'approved'] as const
export type HostState = (typeof hostStates)[number]
export type HostEvent = 'approve'
// A sandbox host stays approved until the owner removes it (which deletes it).
export const hostTable: Table<HostState, HostEvent> = {
  pending: { approve: 'approved' },
  approved: {},
}

// One relay connection: it opens once it names a granted target or share, and closes once.
export type SessionState = 'connecting' | 'open' | 'closed'
export const sessionTable: Table<SessionState, 'begin' | 'close'> = {
  connecting: { begin: 'open', close: 'closed' },
  open: { close: 'closed' },
  closed: {},
}
