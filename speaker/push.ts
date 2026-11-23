// Web Push notifications for the /admin PWA (iOS 16.4+ Home Screen and desktop browsers). VAPID keys and device
// subscriptions live inside the encrypted vault in store.json, so endpoint credentials never sit in plain config.
import { generateVAPIDKeys, sendNotification } from 'web-push'
import { z } from 'zod'
import type { PushSubscriptionRecord, Store } from './store.ts'

export const pushSubscriptionSchema = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})

export type PushPayload = { title: string; body: string; url: string; tag: string }

const vapidSubject = (publicUrl: string) =>
  publicUrl.startsWith('https://') ? publicUrl : 'mailto:owner@speaker.local'

export async function vapidKeys(store: Store) {
  if (!store.vault.vapid) {
    store.vault.vapid = generateVAPIDKeys()
    await store.save()
  }
  return store.vault.vapid
}

export async function addSubscription(store: Store, sub: PushSubscriptionRecord) {
  const list = store.vault.pushSubscriptions ?? []
  const next = list.filter((s) => s.endpoint !== sub.endpoint)
  next.push(sub)
  store.vault.pushSubscriptions = next
  await store.save()
}

export async function removeSubscription(store: Store, endpoint: string) {
  const list = store.vault.pushSubscriptions
  if (!list?.length) return
  const next = list.filter((s) => s.endpoint !== endpoint)
  if (next.length === list.length) return
  store.vault.pushSubscriptions = next
  await store.save()
}

export async function sendPush(
  store: Store,
  publicUrl: string,
  payload: PushPayload,
  onError: (endpoint: string, error: string) => void,
) {
  const subs = store.vault.pushSubscriptions
  if (!subs?.length) return
  const { publicKey, privateKey } = await vapidKeys(store)
  const options = {
    vapidDetails: { subject: vapidSubject(publicUrl), publicKey, privateKey },
    urgency: 'high' as const,
    TTL: 300,
  }
  const body = JSON.stringify(payload)
  const expired = new Set<string>()
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await sendNotification(sub, body, options)
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) expired.add(sub.endpoint)
        else onError(sub.endpoint, error instanceof Error ? error.message : String(error))
      }
    }),
  )
  if (expired.size) {
    store.vault.pushSubscriptions = (store.vault.pushSubscriptions ?? []).filter((s) => !expired.has(s.endpoint))
    await store.save()
  }
}
