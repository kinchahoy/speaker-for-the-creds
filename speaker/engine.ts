// The approval engine. Everything asked of the owner is an Approval (one item, one kind, one subject: an agent, or a
// sandbox host registering) in one lifecycle (approvalTable). This file never looks at the kind; each kind's adapter
// (Kind) is in the registry in core.ts.
import { randomBytes } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { durationNames, durations } from './items.ts'
import { type ApprovalEvent, type ApprovalState, approvalTable, transition } from './lifecycle.ts'

export type Duration = (typeof durationNames)[number] | 'permanent'
export type SubjectType = 'agent' | 'host'
// What asking for an item leads to: a card for the owner, or an answer at once: open (an open service read), never (the
// owner's rule), unavailable (denied and logged: it cannot be delivered).
export type Admission = { to: 'ask' } | { to: 'open' } | { to: 'never' } | { to: 'unavailable'; why: string }
// `reach` is kept with the grant: a grant ends when its reach widens.
export type Description = {
  text: string
  reach: string[]
  warning?: string
  // The warning's longer explanation, shown as its tooltip.
  hint?: string
  // Not pre-ticked on the card.
  wider?: boolean
  risk?: 'read/write' | 'secret' | 'SSH'
}
export type Refusal = { message: string; next: string }

export type Kind = {
  subject: SubjectType
  // Who enforces a grant for a sandboxed agent: speaker, the sandbox host (in force once it reports it applied), or
  // both. The sandbox host hears every grant not enforced by speaker alone.
  where: 'speaker' | 'host' | 'both'
  validate(item: string, subject: string): Refusal | undefined
  admission(item: string, subject: string): Admission
  describe(item: string, subject: string): Description
  snapshot(item: string): Record<string, unknown>
  granted(approval: Approval): unknown
  ended(approval: Approval): void
}
export type SubjectRules = {
  // The spans the owner may grant; a decision naming another gets the first.
  durations: readonly Duration[]
  wait: number
  field: 'agent' | 'host'
  exists(id: string): boolean
  who(id: string): { label: string; agent?: string; via?: string; source: string; key?: string; at?: number }
}

export type Approval = {
  id: string
  kind: string
  subject: string
  item: string
  state: ApprovalState
  requestId: string
  // Once granted: the end (null: until revoked), the span Extend adds again, and what it reached when granted.
  expiresAt: string | null
  grantedMs?: number
  grantedAt?: number
  reach: string[]
  // Granted only because another item of the same request brought it: it ends with the last of these grants.
  with?: string[]
  uses: number
  lastUsedAt: number | null
}
export type RequestStatus = 'pending' | 'decided' | 'expired'
export type Request = {
  id: string
  subject: string
  type: SubjectType
  want: string[]
  reason: string
  duration: Duration
  trigger?: string
  // Items that came only with another item of this request (item -> the item that brought it).
  bundled?: Record<string, string>
  approvals: string[]
  createdAt: number
  decidedAt?: number
}

// Three denials of the same item for the same subject within this window lock it: it is answered as denied, without
// asking the owner, until the window after the third denial has passed.
const denialLimit = 3
const denialWindow = 15 * 60_000
const keepDecided = 86_400_000

export function createEngine(env: {
  kinds: Record<string, Kind>
  kindOf(item: string): string
  subjects: Record<SubjectType, SubjectRules>
  audit(event: string, fields: Record<string, unknown>): void
  changed(): void
}) {
  const approvals = new Map<string, Approval>()
  const requests = new Map<string, Request>()
  const strikes = new Map<string, number[]>()
  const rid = () => randomBytes(16).toString('hex')
  const kindOf = (approval: { kind: string }) => env.kinds[approval.kind]
  const rulesOf = (approval: Approval) => env.subjects[kindOf(approval).subject]
  const named = (approval: Approval) => ({ [rulesOf(approval).field]: approval.subject })
  const live = (a: Approval) => a.state === 'granted' && (a.expiresAt === null || Date.parse(a.expiresAt) > Date.now())
  const grants = (subject?: string) =>
    [...approvals.values()].filter((a) => live(a) && (subject === undefined || a.subject === subject))
  const held = (subject: string, items: string[]) =>
    items.map((item) => grants(subject).find((a) => a.item === item)).find(Boolean)
  const of = (request: Request) => request.approvals.flatMap((id) => approvals.get(id) ?? [])
  const pendingOf = (request: Request) => of(request).filter((a) => a.state === 'pending')
  const statusOf = (request: Request): RequestStatus =>
    pendingOf(request).length
      ? 'pending'
      : of(request).some((a) => a.state === 'expired' && a.grantedAt === undefined)
        ? 'expired'
        : 'decided'
  const outcomeOf = (request: Request) => {
    const all = of(request)
    const approved = all.filter((a) => a.grantedAt !== undefined)
    const ends = approved.map((a) => (a.expiresAt === null ? Infinity : Date.parse(a.expiresAt)))
    const items = (keep: (a: Approval) => boolean) => all.filter(keep).map((a) => a.item)
    return {
      granted: items((a) => a.grantedAt !== undefined || a.state === 'open'),
      denied: items((a) => a.grantedAt === undefined && ['denied', 'revoked'].includes(a.state)),
      pending: items((a) => a.state === 'pending'),
      approved,
      expiresAt: ends.length ? (Math.max(...ends) === Infinity ? null : Math.max(...ends)) : undefined,
    }
  }

  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = queue.then(operation)
    queue = result.catch(() => undefined)
    return result
  }

  const strikeKey = (subject: string, item: string) => `${subject}\n${item}`
  const recentStrikes = (key: string) => (strikes.get(key) ?? []).filter((at) => Date.now() - at < denialWindow)
  const lockedUntil = (subject: string, item: string) => {
    const struck = recentStrikes(strikeKey(subject, item))
    return struck.length >= denialLimit ? struck[struck.length - 1] + denialWindow : undefined
  }
  const retryAfter = (subject: string, items: string[]) => {
    const until = Math.max(0, ...items.map((item) => lockedUntil(subject, item) ?? 0))
    return until ? new Date(until).toISOString() : undefined
  }

  function settle(request: Request) {
    if (request.decidedAt !== undefined || pendingOf(request).length) return
    request.decidedAt = Date.now()
    const { granted, denied } = outcomeOf(request)
    env.audit(`request_${statusOf(request)}`, {
      request: request.id,
      [env.subjects[request.type].field]: request.subject,
      from: 'pending',
      granted,
      denied,
    })
  }
  function end(approval: Approval, event: Exclude<ApprovalEvent, 'grant' | 'extend' | 'open'>, why?: string) {
    const was = approval.state
    approval.state = transition('approval', approvalTable, was, event)
    if (was === 'granted') {
      env.audit(`grant_${approval.state}`, {
        grant: approval.id,
        ...named(approval),
        item: approval.item,
        ...(why ? { why } : {}),
      })
      for (const follower of grants())
        if (follower.with?.includes(approval.id)) {
          follower.with = follower.with.filter((id) => id !== approval.id && approvals.get(id)?.state === 'granted')
          if (!follower.with.length) end(follower, event, why)
        }
    }
    kindOf(approval).ended(approval)
  }
  function grant(approval: Approval, duration: Duration, at: number, bundle?: string[]) {
    const replaced = grants(approval.subject).filter((old) => old.item === approval.item)
    const old = replaced[0]
    // A grant held on its own is not tied to an extension by this one, and keeps the later end.
    const keep = old && !old.with && bundle ? old : undefined
    const until = duration === 'permanent' ? null : new Date(at + durations[duration]).toISOString()
    const later = keep && (keep.expiresAt === null || (until !== null && keep.expiresAt > until))
    Object.assign(approval, {
      expiresAt: later ? keep.expiresAt : until,
      grantedMs: later ? keep.grantedMs : duration === 'permanent' ? undefined : durations[duration],
      grantedAt: at,
      reach: kindOf(approval).describe(approval.item, approval.subject).reach,
      ...(bundle?.length && !keep ? { with: bundle } : {}),
    })
    approval.state = transition('approval', approvalTable, approval.state, 'grant')
    // A later approval of the same item replaces the earlier grant; what came with it follows this one.
    for (const previous of replaced) {
      for (const follower of grants())
        if (follower.with?.includes(previous.id))
          follower.with = [...new Set(follower.with.map((id) => (id === previous.id ? approval.id : id)))]
      end(previous, 'revoke', 'replaced')
    }
    env.audit('grant_created', {
      grant: approval.id,
      ...named(approval),
      item: approval.item,
      expiresAt: approval.expiresAt,
    })
  }

  function request(
    type: SubjectType,
    subject: string,
    items: string[],
    input: { want?: string[]; reason: string; duration: Duration; trigger?: string; bundled?: Record<string, string> },
  ) {
    const itemsOf = (r: Request) => of(r).map((a) => a.item)
    const existing = [...requests.values()].find(
      (r) =>
        r.subject === subject &&
        statusOf(r) === 'pending' &&
        itemsOf(r).length === items.length &&
        items.every((i) => itemsOf(r).includes(i)),
    )
    if (existing) {
      if (input.reason) Object.assign(existing, { reason: input.reason, duration: input.duration })
      return existing
    }
    const request: Request = {
      id: rid(),
      subject,
      type,
      want: [...new Set(input.want ?? items)],
      reason: input.reason,
      duration: input.duration,
      trigger: input.trigger,
      ...(input.bundled && Object.keys(input.bundled).length ? { bundled: input.bundled } : {}),
      approvals: [],
      createdAt: Date.now(),
    }
    for (const item of items) {
      const admission = lockedUntil(subject, item)
        ? ({ to: 'never' } as const)
        : env.kinds[env.kindOf(item)].admission(item, subject)
      if (admission.to === 'unavailable')
        env.audit('request_unavailable', { [env.subjects[type].field]: subject, item, why: admission.why })
      const approval: Approval = {
        id: rid(),
        kind: env.kindOf(item),
        subject,
        item,
        state: 'pending',
        requestId: request.id,
        expiresAt: null,
        reach: [],
        uses: 0,
        lastUsedAt: null,
      }
      // The rules settle it without the owner: it is created in its final state, and no kind effect follows.
      if (admission.to !== 'ask')
        approval.state = transition('approval', approvalTable, 'pending', admission.to === 'open' ? 'open' : 'deny')
      approvals.set(approval.id, approval)
      request.approvals.push(approval.id)
    }
    requests.set(request.id, request)
    const rules = env.subjects[type]
    env.audit('request_created', {
      request: request.id,
      [rules.field]: subject,
      items,
      reason: input.reason,
      trigger: input.trigger,
    })
    settle(request)
    env.changed()
    return request
  }

  // Grants the ticked items and denies the other shown ones; an item added after the card was rendered stays pending.
  function decide(id: string, approved: string[], shown: string[], duration: Duration) {
    return serial(async () => {
      const request = requests.get(id)
      if (!request) throw new HTTPException(404, { message: 'Request not found' })
      if (statusOf(request) !== 'pending')
        throw new HTTPException(409, { message: `Request is already ${statusOf(request)}` })
      const rules = env.subjects[request.type]
      if (!rules.exists(request.subject)) throw new HTTPException(409, { message: 'Its subject was removed' })
      // A duration this subject does not offer falls back to its first (default) one.
      const span = z.enum(rules.durations).catch(rules.durations[0]).parse(duration)
      const pending = pendingOf(request).filter((a) => shown.includes(a.item))
      const yes = pending.filter((a) => approved.includes(a.item))
      const no = pending.filter((a) => !approved.includes(a.item))
      if (!pending.length) throw new HTTPException(409, { message: 'None of the shown items are pending' })
      // A bundled item binds to the grant of the item that brought it, made first.
      const bringer = (a: Approval) => {
        const by = request.bundled?.[a.item]
        return by && yes.some((other) => other.item === by) ? by : undefined
      }
      const at = Date.now()
      for (const a of yes.filter((a) => !bringer(a))) grant(a, span, at)
      for (const a of yes.filter(bringer)) {
        const by = grants(request.subject).find((g) => g.item === bringer(a))
        const before = grants(request.subject).find((g) => g.item === a.item)?.with ?? []
        grant(a, span, at, by ? [...new Set([...before, by.id])] : undefined)
      }
      for (const a of no) {
        strikes.set(strikeKey(a.subject, a.item), [...recentStrikes(strikeKey(a.subject, a.item)), Date.now()])
        end(a, 'deny')
      }
      // The subject is told "granted" only once each grant is in place (the jump server listening, for SSH).
      await Promise.all(yes.map((a) => kindOf(a).granted(a)))
      settle(request)
      env.changed()
    })
  }
  const grantById = (id: string) => {
    const approval = approvals.get(id)
    if (!approval || !live(approval)) throw new HTTPException(404, { message: 'Grant not found' })
    return approval
  }
  function extend(id: string) {
    const approval = grantById(id)
    if (approval.expiresAt === null || approval.grantedMs === undefined)
      throw new HTTPException(409, { message: 'Nothing to extend' })
    approval.state = transition('approval', approvalTable, approval.state, 'extend')
    approval.expiresAt = new Date(
      Math.max(Date.parse(approval.expiresAt), Date.now()) + approval.grantedMs,
    ).toISOString()
    for (const follower of grants()) if (follower.with?.includes(id)) follower.expiresAt = approval.expiresAt
    env.audit('grant_extended', { grant: id, ...named(approval), expiresAt: approval.expiresAt })
    env.changed()
  }
  function revoke(id: string) {
    end(grantById(id), 'revoke')
    env.changed()
  }
  function endSubject(subject: string) {
    for (const a of [...approvals.values()])
      if (a.subject === subject && ['pending', 'granted'].includes(a.state)) end(a, 'revoke')
    for (const [id, r] of requests) if (r.subject === subject) requests.delete(id)
    env.changed()
  }
  // After a Setup change, what is no longer available ends, and so does a grant whose reach grew beyond what the owner
  // approved (a secret sent to a new host, a service moved).
  function reconcile() {
    for (const a of [...approvals.values()]) {
      if (!['pending', 'granted'].includes(a.state)) continue
      const admission = kindOf(a).admission(a.item, a.subject)
      const reach = kindOf(a).describe(a.item, a.subject).reach
      const why =
        admission.to === 'unavailable'
          ? admission.why
          : admission.to === 'never'
            ? 'the owner never grants it now'
            : a.state === 'granted' && reach.some((r) => !a.reach.includes(r))
              ? `it now reaches ${reach.filter((r) => !a.reach.includes(r)).join(', ')}`
              : undefined
      if (!why) continue
      end(a, 'revoke', why)
      const request = requests.get(a.requestId)
      if (request) settle(request)
    }
    env.changed()
  }
  function sweep() {
    let ended = false
    for (const a of [...approvals.values()])
      if (a.state === 'granted' && !live(a)) {
        end(a, 'expire')
        ended = true
      }
    for (const [id, request] of requests) {
      if (statusOf(request) === 'pending') {
        if (Date.now() - request.createdAt < env.subjects[request.type].wait) continue
        for (const a of pendingOf(request)) end(a, 'expire')
        settle(request)
      } else if (Date.now() - (request.decidedAt ?? request.createdAt) >= keepDecided) {
        requests.delete(id)
        for (const a of of(request)) if (a.state !== 'granted') approvals.delete(a.id)
      }
    }
    if (ended) env.changed()
  }

  const cards = () =>
    [...requests.values()]
      .filter((r) => statusOf(r) === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({
        id: r.id,
        subject: r.subject,
        type: r.type,
        who: env.subjects[r.type].who(r.subject),
        reason: r.reason,
        trigger: r.trigger,
        duration: env.subjects[r.type].durations.includes(r.duration) ? r.duration : env.subjects[r.type].durations[0],
        durations: env.subjects[r.type].durations,
        want: r.want,
        items: pendingOf(r).map((a) => ({
          item: a.item,
          kind: a.kind,
          ...kindOf(a).describe(a.item, a.subject),
          ...(r.bundled?.[a.item] ? { with: r.bundled[a.item] } : {}),
        })),
        createdAt: r.createdAt,
      }))

  return {
    approvals,
    requests,
    serial,
    live,
    grants,
    held,
    statusOf,
    outcomeOf,
    lockedUntil,
    retryAfter,
    request,
    decide,
    extend,
    revoke,
    endSubject,
    reconcile,
    sweep,
    cards,
    describe: (a: Approval) => kindOf(a).describe(a.item, a.subject),
    whoOf: (a: Approval) => rulesOf(a).who(a.subject),
  }
}
export type Engine = ReturnType<typeof createEngine>
