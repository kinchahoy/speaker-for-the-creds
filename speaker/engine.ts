// The approval engine. Everything anyone asks the owner for is an Approval: an item of one kind for one subject (an
// agent, or a sandbox host registering), moving through one lifecycle (approvalTable in lifecycle.ts). Asking,
// deciding, extending, revoking, expiry, the three-denials lock, reconcile, cards and the audit lines are written here
// once and never look at the kind; what an item means comes from its kind's adapter (Kind), all in one registry.
import { randomBytes } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { durationNames, durations } from './items.ts'
import { type ApprovalEvent, type ApprovalState, approvalTable, transition } from './lifecycle.ts'

export type Duration = (typeof durationNames)[number] | 'permanent'
export const allDurations: readonly Duration[] = [...durationNames, 'permanent']
export type SubjectType = 'agent' | 'host'
// What asking for an item leads to: a card for the owner, granted without one (an open service read), denied at once
// (the owner's rule), or denied at once and logged because it cannot be delivered.
export type Admission = { to: 'ask' } | { to: 'open' } | { to: 'never' } | { to: 'unavailable'; why: string }
// The card's line for an item: what it is, what approving opens (`reach`, kept with the grant: a grant ends when its
// reach widens), a warning, and a risk badge for items that can change things or carry a credential.
export type Description = { text: string; reach: string[]; warning?: string; risk?: 'read/write' | 'secret' | 'SSH' }
// Why a name cannot be asked for: the whole request fails with this, before anything reaches the owner.
export type Refusal = { message: string; next: string }

// One kind of item. Every kind implements every function; most are one line.
export type Kind = {
  // Who asks for it.
  subject: SubjectType
  // Who enforces a grant for a sandboxed agent: speaker alone, the sandbox host (in force once it reports it applied),
  // or speaker while the sandbox host also hears it. The sandbox host hears every grant not enforced by speaker alone.
  where: 'speaker' | 'host' | 'both'
  validate(item: string, subject: string): Refusal | undefined
  admission(item: string, subject: string): Admission
  describe(item: string, subject: string): Description
  // What the sandbox host is told with the grant besides the item.
  snapshot(item: string): Record<string, unknown>
  // Effects once granted (awaited before the decision is reported) and once ended in any way.
  granted(approval: Approval): unknown
  ended(approval: Approval): void
}
// Who asks, for the card: the agent's claims and speaker's own facts.
export type Who = { label: string; says?: string; via?: string; source: string; key?: string; at?: number }
export type SubjectRules = {
  // The spans the owner may grant; a decision naming another gets the first.
  durations: readonly Duration[]
  // How long a request waits for the owner before it expires.
  wait: number
  // The audit field that names the subject.
  field: 'agent' | 'host'
  exists(id: string): boolean
  who(id: string): Who
  count(id: string, field: 'requests' | 'granted' | 'denied', n: number): void
}

export type Approval = {
  id: string
  kind: string
  subject: string
  item: string
  state: ApprovalState
  // The request (card) it came from; empty for a sandbox host restored from disk.
  requestId: string
  // Once granted: the end (null: until revoked), the span Extend adds again, and what it reached when granted.
  expiresAt: string | null
  grantedMs?: number
  grantedAt?: number
  reach: string[]
  // Granted only because another item of the same request brought it: the grants it ends with (when the last does).
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
  // The call that filed it, if any.
  trigger?: string
  // Items that came only with another item of this request (item -> the item that brought it).
  bundled?: Record<string, string>
  // Items answered without the owner (open reads, never, unavailable, locked).
  answered: Record<string, 'granted' | 'denied'>
  approvals: string[]
  createdAt: number
  decidedAt?: number
}
export type CardItem = Description & { item: string; kind: string; with?: string }
export type Card = {
  id: string
  subject: string
  type: SubjectType
  who: Who
  reason: string
  trigger?: string
  duration: Duration
  durations: readonly Duration[]
  want: string[]
  items: CardItem[]
  createdAt: number
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
  // After any change: tell the sandbox hosts and the jump server.
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
  // The first live grant of the subject among `items` (a call names every item that would cover it).
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
  // Per item: granted (now or earlier, by the owner or the rules), denied (or dropped), or still pending.
  const outcomeOf = (request: Request) => {
    const answered = (outcome: string) => Object.keys(request.answered).filter((i) => request.answered[i] === outcome)
    const approved = of(request).filter((a) => a.grantedAt !== undefined)
    const ends = approved.map((a) => (a.expiresAt === null ? Infinity : Date.parse(a.expiresAt)))
    return {
      granted: [...answered('granted'), ...approved.map((a) => a.item)],
      denied: [
        ...answered('denied'),
        ...of(request)
          .filter((a) => a.grantedAt === undefined && ['denied', 'revoked'].includes(a.state))
          .map((a) => a.item),
      ],
      pending: pendingOf(request).map((a) => a.item),
      approved,
      // When the granted items end: null until revoked, undefined when nothing was granted by the owner.
      expiresAt: ends.length ? (Math.max(...ends) === Infinity ? null : Math.max(...ends)) : undefined,
    }
  }

  // Serialize decisions; a failed one reaches its caller without poisoning the queue.
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = queue.then(operation)
    queue = result.catch(() => undefined)
    return result
  }

  const strikeKey = (subject: string, item: string) => `${subject}\n${item}`
  const recentStrikes = (key: string) => (strikes.get(key) ?? []).filter((at) => Date.now() - at < denialWindow)
  // When asking the owner works again for an item denied three times (a time in ms), else undefined.
  const lockedUntil = (subject: string, item: string) => {
    const struck = recentStrikes(strikeKey(subject, item))
    return struck.length >= denialLimit ? struck[struck.length - 1] + denialWindow : undefined
  }
  const retryAfter = (subject: string, items: string[]) => {
    const until = Math.max(0, ...items.map((item) => lockedUntil(subject, item) ?? 0))
    return until ? new Date(until).toISOString() : undefined
  }

  // A request ends once, from pending: decided when its last item is answered, expired when nobody answered in time.
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
  // Every end of an approval: expiry, revocation, denial. Grants that came with it end with the last they came with.
  function end(approval: Approval, event: Exclude<ApprovalEvent, 'grant' | 'extend'>, why?: string) {
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
  function grant(approval: Approval, duration: Duration, bundle?: string[]) {
    const replaced = grants(approval.subject).filter((old) => old.item === approval.item)
    const old = replaced[0]
    // A grant held on its own is not tied to an extension by this one, and keeps the later end.
    const keep = old && !old.with && bundle ? old : undefined
    const until = duration === 'permanent' ? null : new Date(Date.now() + durations[duration]).toISOString()
    const later = keep && (keep.expiresAt === null || (until !== null && keep.expiresAt > until))
    Object.assign(approval, {
      expiresAt: later ? keep.expiresAt : until,
      grantedMs: later ? keep.grantedMs : duration === 'permanent' ? undefined : durations[duration],
      grantedAt: Date.now(),
      reach: kindOf(approval).describe(approval.item, approval.subject).reach,
      ...(bundle?.length && !keep ? { with: bundle } : {}),
    })
    approval.state = transition('approval', approvalTable, approval.state, 'grant')
    // A later approval of the same item replaces the earlier grant; what came with the earlier one follows this one.
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

  // Asks for items on a subject's behalf: each is answered at once by its kind's rules or the denial lock, or becomes a
  // pending approval on one card. Asking for exactly the items of a pending request joins it.
  function request(
    type: SubjectType,
    subject: string,
    items: string[],
    input: { want?: string[]; reason: string; duration: Duration; trigger?: string; bundled?: Record<string, string> },
  ) {
    const itemsOf = (r: Request) => [...Object.keys(r.answered), ...of(r).map((a) => a.item)]
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
      answered: {},
      approvals: [],
      createdAt: Date.now(),
    }
    for (const item of items) {
      const admission = lockedUntil(subject, item)
        ? ({ to: 'never' } as const)
        : env.kinds[env.kindOf(item)].admission(item, subject)
      if (admission.to === 'unavailable')
        env.audit('request_unavailable', { [env.subjects[type].field]: subject, item, why: admission.why })
      if (admission.to !== 'ask') request.answered[item] = admission.to === 'open' ? 'granted' : 'denied'
      else {
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
        approvals.set(approval.id, approval)
        request.approvals.push(approval.id)
      }
    }
    requests.set(request.id, request)
    const rules = env.subjects[type]
    const { granted, denied, pending } = outcomeOf(request)
    if (pending.length) rules.count(subject, 'requests', 1)
    rules.count(subject, 'granted', granted.length)
    rules.count(subject, 'denied', denied.length)
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

  // The owner's decision on what the card showed: grants the ticked items and denies the other shown ones. An item
  // added to the request after the card was rendered stays pending, and so does the request.
  function decide(id: string, approved: string[], shown: string[], duration: Duration) {
    return serial(async () => {
      const request = requests.get(id)
      if (!request) throw new HTTPException(404, { message: 'Request not found' })
      if (statusOf(request) !== 'pending')
        throw new HTTPException(409, { message: `Request is already ${statusOf(request)}` })
      const rules = env.subjects[request.type]
      if (!rules.exists(request.subject)) throw new HTTPException(409, { message: 'Its subject was removed' })
      const span = rules.durations.includes(duration) ? duration : rules.durations[0]
      const pending = pendingOf(request).filter((a) => shown.includes(a.item))
      const yes = pending.filter((a) => approved.includes(a.item))
      const no = pending.filter((a) => !approved.includes(a.item))
      if (!pending.length) throw new HTTPException(409, { message: 'None of the shown items are pending' })
      // Items first, then what they brought: a bundled item binds to the grant just made.
      const bringer = (a: Approval) => {
        const by = request.bundled?.[a.item]
        return by && yes.some((other) => other.item === by) ? by : undefined
      }
      for (const a of yes.filter((a) => !bringer(a))) grant(a, span)
      for (const a of yes.filter(bringer)) {
        const by = grants(request.subject).find((g) => g.item === bringer(a))
        const before = grants(request.subject).find((g) => g.item === a.item)?.with ?? []
        grant(a, span, by ? [...new Set([...before, by.id])] : undefined)
      }
      for (const a of no) {
        strikes.set(strikeKey(a.subject, a.item), [...recentStrikes(strikeKey(a.subject, a.item)), Date.now()])
        end(a, 'deny')
      }
      // The subject is told "granted" only once each grant is in place (the jump server listening, for SSH).
      await Promise.all(yes.map((a) => kindOf(a).granted(a)))
      rules.count(request.subject, 'granted', yes.length)
      rules.count(request.subject, 'denied', no.length)
      settle(request)
      env.changed()
    })
  }
  const grantById = (id: string) => {
    const approval = approvals.get(id)
    if (!approval || !live(approval)) throw new HTTPException(404, { message: 'Grant not found' })
    return approval
  }
  // Extending moves the end to max(current end, now) + the span the owner originally granted.
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
  // A subject that ends (an agent revoked or removed with its sandbox host): its grants and requests go with it.
  function endSubject(subject: string) {
    for (const a of [...approvals.values()])
      if (a.subject === subject && ['pending', 'granted'].includes(a.state)) end(a, 'revoke')
    for (const [id, r] of requests) if (r.subject === subject) requests.delete(id)
    env.changed()
  }
  // A sandbox host the owner approved before a restart: its grant comes back from the settings file.
  function restore(kind: string, subject: string, item: string) {
    const approval: Approval = {
      id: rid(),
      kind,
      subject,
      item,
      state: 'granted',
      requestId: '',
      expiresAt: null,
      grantedAt: Date.now(),
      reach: env.kinds[kind].describe(item, subject).reach,
      uses: 0,
      lastUsedAt: null,
    }
    approvals.set(approval.id, approval)
  }

  // After any Setup change: a grant or pending request whose item is no longer available ends, and so does a grant
  // whose reach grew beyond what the owner approved (a secret sent to a new host, a service moved).
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
  // Clock-driven transitions: grants past their end, requests nobody decided in time, old decided requests.
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

  // The cards waiting for the owner, oldest first, each item described by its kind.
  const cards = (): Card[] =>
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
    pendingOf,
    lockedUntil,
    retryAfter,
    request,
    decide,
    extend,
    revoke,
    endSubject,
    restore,
    reconcile,
    sweep,
    cards,
    describe: (a: Approval) => kindOf(a).describe(a.item, a.subject),
    whoOf: (a: Approval) => rulesOf(a).who(a.subject),
    kindOf,
  }
}
export type Engine = ReturnType<typeof createEngine>
