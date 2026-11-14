// The secrets proxy: agents send HTTPS through it with HTTP CONNECT, authenticated by their speaker token. For a host
// covered by one of the agent's active `secret:` grants, speaker terminates TLS with its own certificate authority,
// swaps the agent's placeholder for the real value in the Authorization header (also inside HTTP Basic credentials)
// and forwards the request to the real host. Any other host is refused. Built on Node's http, https and tls with
// @peculiar/x509 for certificates; the grants and the store stay in server.ts and reach this module through hooks.
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import { isIP, type Socket } from 'node:net'
import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import { coversAny } from './items.ts'

const { subtle } = globalThis.crypto
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
const pem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString('base64')
    .match(/.{1,64}/g)
    ?.join('\n')}\n-----END ${label}-----\n`
const exportKey = async (key: CryptoKey) => pem('PRIVATE KEY', await subtle.exportKey('pkcs8', key))
const year = 365 * 86_400_000

export type Ca = { cert: string; key: string }
export type ProxySecret = { value: string; hosts: string[]; placeholder: string }
export class Refusal extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
// What the proxy needs from speaker. `authenticate` and `ca` throw Refusal (for example while speaker is locked).
export type ProxyHooks = {
  authenticate(token: string, source: string | undefined): { agent: string }
  // The agent's active `secret:` grants right now, with values; empty once revoked, expired or the agent ended.
  secrets(agent: string): ProxySecret[]
  ca(): Promise<Ca>
  log(event: string, fields: Record<string, unknown>): void
}

export async function createCa(): Promise<Ca> {
  const keys = await subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Speaker secrets proxy CA',
    notBefore: new Date(Date.now() - 3600_000),
    notAfter: new Date(Date.now() + 10 * year),
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  })
  return { cert: cert.toString('pem'), key: await exportKey(keys.privateKey) }
}

const swap = (text: string, secrets: ProxySecret[]) =>
  secrets.reduce((result, { placeholder, value }) => result.replaceAll(placeholder, value), text)
// Replaces placeholders in an Authorization value, including inside HTTP Basic credentials.
const insert = (value: string, secrets: ProxySecret[]) => {
  const basic = /^Basic +(\S+)$/i.exec(value)?.[1]
  return basic === undefined
    ? swap(value, secrets)
    : `Basic ${Buffer.from(swap(Buffer.from(basic, 'base64').toString('utf8'), secrets)).toString('base64')}`
}

const refuse = (socket: Socket, status: number, message: string) =>
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message) + 1}\r\nconnection: close\r\n${
      status === 407 ? 'proxy-authenticate: Basic realm="speaker"\r\n' : ''
    }\r\n${message}\n`,
  )

export function createProxy(hooks: ProxyHooks): Server {
  let signer: Promise<{ ca: x509.X509Certificate; key: CryptoKey }> | undefined
  const leaves = new Map<string, Promise<{ key: string; cert: string }>>()
  // One leaf certificate per host, generated on first use and kept in memory.
  const leaf = (host: string) => {
    let made = leaves.get(host)
    if (!made) {
      made = (async () => {
        signer ??= hooks.ca().then(async ({ cert, key }) => ({
          ca: new x509.X509Certificate(cert),
          key: await subtle.importKey(
            'pkcs8',
            Buffer.from(key.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64'),
            algorithm,
            false,
            ['sign'],
          ),
        }))
        const { ca, key } = await signer.catch((error) => {
          signer = undefined
          throw error
        })
        const keys = await subtle.generateKey(algorithm, true, ['sign', 'verify'])
        const cert = await x509.X509CertificateGenerator.create({
          serialNumber: Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex'),
          subject: `CN=${host}`,
          issuer: ca.subject,
          notBefore: new Date(Date.now() - 3600_000),
          notAfter: new Date(Date.now() + year),
          signingAlgorithm: algorithm,
          signingKey: key,
          publicKey: keys.publicKey,
          extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
            new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
            new x509.SubjectAlternativeNameExtension([{ type: isIP(host) ? 'ip' : 'dns', value: host }]),
          ],
        })
        return { key: await exportKey(keys.privateKey), cert: cert.toString('pem') }
      })()
      leaves.set(host, made)
      made.catch(() => leaves.delete(host))
    }
    return made
  }

  // Requests inside one tunnel: grants are checked again on every request, so revoking ends access at once.
  const tunnelHandler = (agent: string, host: string, port: string) => (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]
    const answer = (status: number, message: string, event = 'secret_proxy') => {
      hooks.log(event, { agent, host, method: req.method, path, status, reason: message })
      res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' }).end(`${message}\n`)
    }
    const secrets = hooks.secrets(agent).filter(({ hosts }) => coversAny(hosts, host))
    if (!secrets.length)
      return answer(
        403,
        `speaker: your access to ${host} ended (revoked or expired). Check GET /_speaker/catalog.`,
        'secret_proxy_refused',
      )
    const headers: OutgoingHttpHeaders = { ...req.headers, host: port === '443' ? host : `${host}:${port}` }
    for (const name of ['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'upgrade'])
      delete headers[name]
    if (headers.authorization) headers.authorization = insert(headers.authorization, secrets)
    const upstream = httpsRequest(
      {
        host,
        port: Number(port),
        method: req.method,
        path: req.url,
        headers,
        servername: isIP(host) ? undefined : host,
      },
      (reply) => {
        hooks.log('secret_proxy', { agent, host, method: req.method, path, status: reply.statusCode })
        const { connection, 'keep-alive': _, ...replyHeaders } = reply.headers
        res.writeHead(reply.statusCode ?? 502, replyHeaders)
        reply.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      if (res.headersSent) return void res.destroy()
      hooks.log('secret_proxy_upstream_failed', { agent, host, error: error.message })
      answer(502, `speaker: could not reach ${host}: ${error.message}`)
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }

  const proxy = createServer((_req, res) =>
    res.writeHead(405, { 'content-type': 'text/plain' }).end("speaker's proxy takes HTTPS CONNECT only\n"),
  )
  proxy.on('connect', async (req, socket: Socket, head) => {
    socket.on('error', () => undefined)
    let host = '',
      port = '',
      agent: string | undefined
    try {
      ;({ hostname: host, port } = new URL(`http://${req.url}`))
      host = host.replace(/^\[|\]$/g, '')
      port ||= '443'
      const password = /^Basic +(\S+)$/i.exec(req.headers['proxy-authorization'] ?? '')?.[1]
      const token = password && Buffer.from(password, 'base64').toString('utf8').split(':').slice(1).join(':')
      if (!token)
        throw new Refusal(
          407,
          'speaker: proxy credentials needed. Use http://agent:<your speaker token>@<speaker>:<proxy port>',
        )
      ;({ agent } = hooks.authenticate(token, socket.remoteAddress?.replace(/^::ffff:/, '')))
      if (!hooks.secrets(agent).some(({ hosts }) => coversAny(hosts, host)))
        throw new Refusal(
          403,
          `speaker: no secret grant of yours covers ${host}; speaker is not a general proxy. Ask the owner for the secret with POST /_speaker/requests (see GET /_speaker/catalog).`,
        )
      const { key, cert } = await leaf(host)
      const tunnel = createHttpsServer({ key, cert }, tunnelHandler(agent, host, port))
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) socket.unshift(head)
      tunnel.emit('connection', socket)
    } catch (error) {
      const refusal =
        error instanceof Refusal ? error : new Refusal(502, `speaker: proxy failed: ${(error as Error).message}`)
      hooks.log('secret_proxy_refused', { agent, host, status: refusal.status, reason: refusal.message })
      refuse(socket, refusal.status, refusal.message)
    }
  })
  return proxy
}
