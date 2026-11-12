export const ownerPassword = 'owner-password-for-tests'

// The `name=value` pair of the session cookie a sign-in or first-run response set.
export const sessionCookie = (response: Response) => {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('speaker_session='))
  if (!cookie) throw new Error('No session cookie in the response')
  return cookie.split(';')[0]
}

// Sets the owner password through the first-run form and returns the session cookie for later admin calls.
export async function setOwnerPassword(
  call: (path: string, init?: RequestInit) => Response | Promise<Response>,
  origin = 'http://localhost',
): Promise<string> {
  const response = await call('/admin/setup', {
    method: 'POST',
    headers: { origin },
    body: new URLSearchParams({ password: ownerPassword, confirm: ownerPassword }),
    redirect: 'manual',
  })
  if (response.status !== 303) throw new Error(`Setting the owner password answered ${response.status}`)
  return sessionCookie(response)
}
