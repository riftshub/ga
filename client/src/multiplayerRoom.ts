/**
 * Client side of the custom multiplayer room hosted by server.js at /room.
 *
 * The world itself (blocks, chat, player avatars) travels over the normal Minecraft protocol
 * through the /mc bridge. This side channel carries what the vanilla protocol can't:
 * gun shots, hit confirmations and car positions, as plain JSON.
 *
 * It connects to wss://trueelement.shop/room (see gameServer.ts) only while you're playing on
 * that server's world, so joining any other server never sends room traffic anywhere.
 */
import { lastConnectOptions } from './appStatus'
import { getGameRoomUrl, isOurGameServer } from './gameServer'

export interface V3 { x: number, y: number, z: number }

export interface CarState extends V3 {
  heading: number
  steer: number
  speed: number
  driving: boolean
}

export interface RoomPlayer {
  id: string
  username: string
  position: V3 | null
  rotation: { yaw: number, pitch: number } | null
  heldItem: string | null
  car: CarState | null
}

export type RoomMessage =
  | { type: 'WELCOME', id: string, players: RoomPlayer[] }
  | { type: 'PLAYER_JOIN', player: RoomPlayer }
  | { type: 'PLAYER_LEAVE', id: string }
  | { type: 'PLAYER_STATE', id: string, position: V3 | null, rotation: RoomPlayer['rotation'], heldItem: string | null }
  | { type: 'PLAYER_SHOOT', id: string, username: string, weapon: string, origin: V3, direction: V3, distance: number, hit: 'block' | 'player' | null }
  | { type: 'CAR_STATE', id: string, car: CarState | null }
  | { type: 'HIT_CONFIRM', target: string, damage: number, killed: boolean }
  | { type: 'HIT_TAKEN', by: string, damage: number, killed: boolean }
  | { type: 'PONG', t: number }

type Handler<T extends RoomMessage['type']> = (msg: Extract<RoomMessage, { type: T }>) => void

const handlers = new Map<string, Set<(msg: any) => void>>()

export const room = {
  /** Our session id, assigned by the server */
  id: null as string | null,
  connected: false,
  players: new Map<string, RoomPlayer>(),
}

let ws: WebSocket | null = null
let wantConnected = false
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectDelay = 1000
let stateTimer: ReturnType<typeof setInterval> | undefined
let lastSentState = ''
let lastStateSentAt = 0

export const onRoomMessage = <T extends RoomMessage['type']>(type: T, handler: Handler<T>) => {
  let set = handlers.get(type)
  if (!set) {
    set = new Set()
    handlers.set(type, set)
  }
  set.add(handler)
  return () => set.delete(handler)
}

const emit = (msg: RoomMessage) => {
  for (const h of handlers.get(msg.type) ?? []) {
    try {
      h(msg)
    } catch (err) {
      console.error('[room] handler error', err)
    }
  }
}

const send = (msg: Record<string, unknown>) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

/**
 * Room address while we're playing on our game server's world (wss://trueelement.shop/mc),
 * otherwise undefined so no room traffic goes to other servers. Address set in gameServer.ts.
 */
export const getRoomUrl = (): string | undefined => {
  const server = (lastConnectOptions.value as { server?: string } | null)?.server
  return isOurGameServer(server) ? getGameRoomUrl() : undefined
}

const roundTo = (n: number, p = 100) => Math.round(n * p) / p

const sendStateIfChanged = () => {
  const b = (globalThis as any).bot as typeof bot | undefined
  if (!b?.entity || !room.connected) return
  const p = b.entity.position
  const state = {
    type: 'STATE',
    position: { x: roundTo(p.x), y: roundTo(p.y), z: roundTo(p.z) },
    rotation: { yaw: roundTo(b.entity.yaw), pitch: roundTo(b.entity.pitch) },
    heldItem: b.heldItem?.name ?? null,
  }
  const key = JSON.stringify(state)
  const now = Date.now()
  if (key === lastSentState && now - lastStateSentAt < 1000) return
  lastSentState = key
  lastStateSentAt = now
  send(state)
}

const open = () => {
  const url = getRoomUrl()
  if (!url || !wantConnected) return
  const b = (globalThis as any).bot as typeof bot | undefined
  const socket = new WebSocket(url)
  ws = socket

  socket.addEventListener('open', () => {
    reconnectDelay = 1000
    send({ type: 'HELLO', username: b?.username ?? '' })
  })

  socket.addEventListener('message', event => {
    let msg: RoomMessage
    try {
      msg = JSON.parse(String(event.data))
    } catch {
      return
    }
    switch (msg.type) {
      case 'WELCOME':
        room.id = msg.id
        room.connected = true
        room.players.clear()
        for (const p of msg.players) room.players.set(p.id, p)
        lastSentState = ''
        break
      case 'PLAYER_JOIN':
        room.players.set(msg.player.id, msg.player)
        break
      case 'PLAYER_LEAVE':
        room.players.delete(msg.id)
        break
      case 'PLAYER_STATE': {
        const p = room.players.get(msg.id)
        if (p) Object.assign(p, { position: msg.position, rotation: msg.rotation, heldItem: msg.heldItem })
        break
      }
      case 'CAR_STATE': {
        const p = room.players.get(msg.id)
        if (p) p.car = msg.car
        break
      }
    }
    emit(msg)
  })

  socket.addEventListener('close', () => {
    if (ws === socket) ws = null
    const wasConnected = room.connected
    room.connected = false
    room.id = null
    for (const id of room.players.keys()) emit({ type: 'PLAYER_LEAVE', id })
    room.players.clear()
    if (wantConnected) {
      clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(open, reconnectDelay)
      reconnectDelay = Math.min(15_000, reconnectDelay * 2)
      if (wasConnected) console.warn('[room] disconnected, reconnecting...')
    }
  })

  socket.addEventListener('error', () => {
    // 'close' follows and handles reconnecting
  })
}

export const connectRoom = () => {
  disconnectRoom()
  if (!getRoomUrl()) return
  wantConnected = true
  open()
  stateTimer = setInterval(sendStateIfChanged, 100)
}

export const disconnectRoom = () => {
  wantConnected = false
  clearTimeout(reconnectTimer)
  clearInterval(stateTimer)
  if (ws) {
    const old = ws
    ws = null
    old.close()
  }
  room.connected = false
  room.id = null
  room.players.clear()
}

/** Gun fired: clean JSON straight to our server, outside the Minecraft protocol. */
export const sendShoot = (origin: V3, direction: V3, localDistance: number, localHit: 'block' | 'player' | null) => {
  send({
    type: 'PLAYER_SHOOT',
    origin: { x: roundTo(origin.x, 1000), y: roundTo(origin.y, 1000), z: roundTo(origin.z, 1000) },
    direction: { x: roundTo(direction.x, 1e5), y: roundTo(direction.y, 1e5), z: roundTo(direction.z, 1e5) },
    distance: roundTo(localDistance),
    hit: localHit,
  })
}

export const sendCarState = (car: CarState | null) => {
  send({ type: 'CAR_STATE', car })
}

customEvents.on('gameLoaded', () => {
  connectRoom()
  ;(globalThis as any).bot?.once('end', disconnectRoom)
})

;(window as any).multiplayerRoom = { room, connectRoom, disconnectRoom, getRoomUrl }
