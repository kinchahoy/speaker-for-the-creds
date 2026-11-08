// Explicit lifecycles for approval requests and identities (enforcers, sessions).
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

export const requestStates = ['pending', 'approved', 'denied', 'expired', 'revoked', 'superseded'] as const
export type RequestState = (typeof requestStates)[number]
export type RequestEvent = 'approve' | 'deny' | 'expire' | 'revoke' | 'supersede'
// expire: a pending request waited 15 minutes, or an approval's window ended.
// revoke: the owner removed a lease the approval created. supersede: a later approval replaced it.
export const requestTable: Table<RequestState, RequestEvent> = {
  pending: { approve: 'approved', deny: 'denied', expire: 'expired' },
  approved: { expire: 'expired', revoke: 'revoked', supersede: 'superseded' },
  denied: {},
  expired: {},
  revoked: {},
  superseded: {},
}

export const identityStates = ['pending', 'approved', 'denied', 'expired'] as const
export type IdentityState = (typeof identityStates)[number]
export type IdentityEvent = 'approve' | 'deny' | 'expire'
// Enforcers never expire; sessions expire when their approved duration ends. deny also revokes an approved identity.
export const identityTable: Table<IdentityState, IdentityEvent> = {
  pending: { approve: 'approved', deny: 'denied' },
  approved: { deny: 'denied', expire: 'expired' },
  denied: {},
  expired: {},
}
