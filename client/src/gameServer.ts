/**
 * Where the game's own server lives. Change GAME_SERVER_ORIGIN to move the whole game
 * to another address (for example 'wss://play.trueelement.shop').
 *
 *   wss://trueelement.shop/mc    the shared world (Minecraft protocol over WebSocket)
 *   wss://trueelement.shop/room  the multiplayer room (shots, hits, cars)
 *
 * When the page itself is opened on localhost (testing with `npm start` or `pnpm start`),
 * it uses your local server instead, so you can test without touching the live site.
 */
export const GAME_SERVER_ORIGIN = 'wss://trueelement.shop'

const origin = () => {
  const { hostname, host, protocol } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    // Dev server (pnpm start) runs on its own port; the game server is on 8080.
    // Production build served by server.js: same address as the page.
    if (process.env.NODE_ENV === 'development') return `ws://${hostname}:8080`
    return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`
  }
  return GAME_SERVER_ORIGIN
}

/** World address players join */
export const getGameWorldUrl = () => `${origin()}/mc`

/** Multiplayer room address */
export const getGameRoomUrl = () => `${origin()}/room`

const hostOf = (url: string) => {
  try {
    return new URL(url.replace(/^ws/i, 'http')).host.toLowerCase()
  } catch {
    return ''
  }
}

/** True when a server address points at our game server's world */
export const isOurGameServer = (address: string | undefined) => {
  if (!address) return false
  const trimmed = address.trim()
  if (!/^wss?:\/\//i.test(trimmed)) return false
  let pathname = ''
  try {
    pathname = new URL(trimmed.replace(/^ws/i, 'http')).pathname.replace(/\/+$/, '')
  } catch {
    return false
  }
  return pathname === '/mc' && hostOf(trimmed) === hostOf(getGameWorldUrl())
}
