// Explicit lifecycles for requests, grants and sandbox hosts.
// Every status change goes through transition(); a move missing from a table throws.

export type Table<S extends string, E extends string> = Readonly<Record<S, Readonly<Partial<Record<E, S>>>>>

export class IllegalTransition extends Error {
  readonly machine: string
  readonly from: string
  readonly event: string
  constructor(machine: string, from: string, event: string) {
    super(`${machine} cannot ${event} while ${from}`)
    this.machine = machine
    this.from = from
    this.event = event
  }
}

export function transition<S extends string, E extends string>(machine: string, table: Table<S, E>, from: S, event: E) {
  const to = table[from][event]
  if (to === undefined) throw new IllegalTransition(machine, from, event)
  return to
}

export const requestStates = ['pending', 'decided', 'expired'] as const
export type RequestState = (typeof requestStates)[number]
export type RequestEvent = 'decide' | 'expire'
// decide: the owner answered every item (each is granted or denied). expire: nobody answered within 2 hours.
export const requestTable: Table<RequestState, RequestEvent> = {
  pending: { decide: 'decided', expire: 'expired' },
  decided: {},
  expired: {},
}

export const grantStates = ['active', 'expired', 'revoked'] as const
export type GrantState = (typeof grantStates)[number]
export type GrantEvent = 'expire' | 'revoke'
export const grantTable: Table<GrantState, GrantEvent> = {
  active: { expire: 'expired', revoke: 'revoked' },
  expired: {},
  revoked: {},
}

export const hostStates = ['pending', 'approved'] as const
export type HostState = (typeof hostStates)[number]
export type HostEvent = 'approve'
// A sandbox host stays approved until the owner removes it (which deletes it).
export const hostTable: Table<HostState, HostEvent> = {
  pending: { approve: 'approved' },
  approved: {},
}
