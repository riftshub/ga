/**
 * Drivable cars + item-based guns, synced through the site's multiplayer room.
 *
 * Wired into the client's existing systems:
 *  - Per-frame updates run from `beforeRenderFrame` (the main-thread rAF loop in appViewerLoad.ts).
 *  - Meshes live in the real Three.js scene of `globalThis.world` (WorldRendererThree) and are
 *    registered with its `sceneOrigin`, so they stay put when the floating origin rebases.
 *  - Guns are normal Minecraft items (the Rifle is an iron hoe the server hands out). Left-click
 *    with one fires: local Three.js Raycaster visuals immediately, plus a PLAYER_SHOOT JSON packet
 *    to the room, which checks the hit against the real world and applies damage.
 *  - Other players' shots arrive as PLAYER_SHOOT and are drawn as glowing tracers from their avatar.
 *  - Driving disables mineflayer physics and moves `bot.entity.position`; mineflayer keeps sending
 *    that position, so your avatar moves for everyone. Car body/heading syncs via CAR_STATE.
 *  - Steering reads `bot.controlState` (keyboard WASD, gamepad, touch joystick) plus the
 *    optional on-screen pad.
 *
 * Controls
 *  - Rifle (iron hoe): left-click to fire (hold for repeat, 0.5 s between shots), R to reload.
 *  - F near your car: get in / out. WASD: drive. Space: handbrake.
 *  - The round 🚗 button on the right edge shows/hides the on-screen controls.
 *
 * Console helpers: carsAndGuns.spawnCar(), carsAndGuns.weapons, carsAndGuns.config
 */
import * as THREE from 'three'
import { Vec3 } from 'vec3'
import type { WorldRendererThree } from 'minecraft-renderer/src/three/worldRendererThree'
import { beforeRenderFrame } from './beforeRenderFrame'
import { activeModalStack, isGameActive, miscUiState } from './globalState'
import { options } from './optionsStorage'
import { onRoomMessage, room, sendCarState, sendShoot, type CarState } from './multiplayerRoom'

// ───────────────────────────── Config ─────────────────────────────

const config = {
  car: {
    maxSpeed: 24, // blocks/s (~86 km/h)
    maxReverse: 8,
    accel: 15,
    brake: 34,
    drag: 3.5,
    handbrake: 45,
    maxSteer: 0.6, // radians
    steerSpeed: 3.2,
    wheelBase: 2.7,
    enterDistance: 4,
    gravity: 28,
    stepHeight: 1.05, // can drive up single blocks
    /** Camera sits this far below the player's feet while driving so the view is from inside the cabin */
    cameraDrop: 0.55,
    syncIntervalMs: 100,
  },
  bulletSpeed: 320, // blocks/s, visual only
}

interface Weapon {
  id: string
  label: string
  cooldownMs: number
  magazine: number
  reloadMs: number
  range: number
  /** Predicted damage for the floating number; the server applies the real amount */
  damage: number
}

/**
 * Item name → weapon. Keep in sync with WEAPONS in server/server.js (which owns damage).
 * The server gives every player a Rifle (iron hoe) on join; /rifle gives another.
 */
const weapons: Record<string, Weapon> = {
  iron_hoe: { id: 'rifle', label: 'RIFLE', cooldownMs: 500, magazine: 12, reloadMs: 1600, range: 128, damage: 5 },
}

const MOBILE_PREF_KEY = 'carsAndGuns.mobileControls'

// ───────────────────────────── State ─────────────────────────────

type World = WorldRendererThree
type V3 = { x: number, y: number, z: number }

let attachedWorld: World | undefined

interface CarParts {
  group: THREE.Group
  frontPivots: THREE.Object3D[]
  wheels: THREE.Object3D[]
  brakeLights: THREE.Mesh[]
}

const car = {
  parts: null as CarParts | null,
  x: 0,
  y: 0,
  z: 0,
  heading: 0, // same convention as bot.entity.yaw: 0 faces -Z, positive turns left
  speed: 0,
  vy: 0,
  steer: 0,
  wheelSpin: 0,
  spawned: false,
  driving: false,
  braking: false,
}

interface RemoteCar {
  parts: CarParts | null
  cur: { x: number, y: number, z: number, heading: number, steer: number }
  target: CarState
  spin: number
}
const remoteCars = new Map<string, RemoteCar>()

const touchInput = { gas: false, brake: false, left: false, right: false, handbrake: false }

const ammo = new Map<string, { rounds: number, reloadingUntil: number }>()

let pendingSpawn = false
let lastSpawnAttempt = 0
let triggerHeld = false
let lastShotAt = 0
let lastFrameAt = performance.now()
let lastWorldViewUpdate = 0
let lastCarSync = 0
let carSyncedAsGone = true

// ───────────────────────────── Helpers ─────────────────────────────

const getBot = () => (globalThis as any).bot as typeof bot | undefined

const forwardOf = (h: number) => ({ x: -Math.sin(h), z: -Math.cos(h) })
const rightOf = (h: number) => ({ x: Math.cos(h), z: -Math.sin(h) })

const scratchVec = new Vec3(0, 0, 0)
/** true = solid full-height collision, false = passable, null = chunk not loaded */
const isSolid = (x: number, y: number, z: number): boolean | null => {
  const b = getBot()
  if (!b) return null
  scratchVec.set(x, y, z)
  const block = b.blockAt(scratchVec)
  if (!block) return null
  return block.boundingBox === 'block'
}

/** Top surface Y of the first solid block at or below fromY. NaN = unloaded, -Infinity = void */
const groundHeight = (x: number, z: number, fromY: number, depth = 10): number => {
  const bx = Math.floor(x)
  const bz = Math.floor(z)
  const startY = Math.floor(fromY)
  for (let y = startY; y >= startY - depth; y--) {
    const s = isSolid(bx, y, bz)
    if (s === null) return Number.NaN
    if (s) return y + 1
  }
  return -Infinity
}

/** A wall too tall to step over (or an unloaded chunk) in this column for something standing at feetY */
const columnBlocked = (x: number, z: number, feetY: number): boolean => {
  const bx = Math.floor(x)
  const bz = Math.floor(z)
  for (let y = Math.floor(feetY + config.car.stepHeight + 0.01); y <= Math.floor(feetY + 1.4); y++) {
    const s = isSolid(bx, y, bz)
    if (s === null || s) return true
  }
  return false
}

const playerSpaceFree = (x: number, z: number, feetY: number) => {
  const bx = Math.floor(x)
  const bz = Math.floor(z)
  const fy = Math.floor(feetY + 0.01)
  return isSolid(bx, fy, bz) === false && isSolid(bx, fy + 1, bz) === false
}

/** Local car-space offsets (right, back) → world x/z */
const carLocalToWorld = (localRight: number, localBack: number, h = car.heading, cx = car.x, cz = car.z) => {
  const f = forwardOf(h)
  const r = rightOf(h)
  return { x: cx + r.x * localRight - f.x * localBack, z: cz + r.z * localRight - f.z * localBack }
}

const CAR_CORNERS = [[-0.95, -2.1], [0.95, -2.1], [-0.95, 2.1], [0.95, 2.1]] as const
const WHEEL_SPOTS = [[-1, -1.35], [1, -1.35], [-1, 1.35], [1, 1.35]] as const

const heldWeapon = (): Weapon | undefined => {
  const name = getBot()?.heldItem?.name
  return name ? weapons[name] : undefined
}

const ammoFor = (w: Weapon) => {
  let a = ammo.get(w.id)
  if (!a) {
    a = { rounds: w.magazine, reloadingUntil: 0 }
    ammo.set(w.id, a)
  }
  return a
}

const inGameForeground = () => !!getBot()?.entity && isGameActive(true)

const angleLerp = (a: number, b: number, t: number) => {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/** Ray vs axis-aligned box (slab method). Returns entry distance or null. */
const rayAabb = (o: V3, d: V3, min: V3, max: V3): number | null => {
  let tMin = -Infinity
  let tMax = Infinity
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(d[axis]) < 1e-9) {
      if (o[axis] < min[axis] || o[axis] > max[axis]) return null
      continue
    }
    let t1 = (min[axis] - o[axis]) / d[axis]
    let t2 = (max[axis] - o[axis]) / d[axis]
    if (t1 > t2) [t1, t2] = [t2, t1]
    tMin = Math.max(tMin, t1)
    tMax = Math.min(tMax, t2)
    if (tMin > tMax) return null
  }
  if (tMax < 0) return null
  return Math.max(tMin, 0)
}

// ───────────────────────────── Car model ─────────────────────────────

const materialCache = new Map<string, THREE.Material>()
const material = (color: number, glow = false) => {
  const key = `${color}-${glow}`
  let m = materialCache.get(key)
  if (!m) {
    m = glow ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshLambertMaterial({ color })
    materialCache.set(key, m)
  }
  return m
}

const addBox = (parent: THREE.Object3D, w: number, h: number, d: number, color: number, x: number, y: number, z: number, glow = false) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color, glow))
  mesh.position.set(x, y, z)
  parent.add(mesh)
  return mesh
}

/** Body colours: yours is red, other players' cars pick a colour from their id */
const PAINTS = [
  [0xd3121b, 0xa50e15],
  [0x1565d8, 0x0f4aa3],
  [0x1f9e45, 0x177434],
  [0xf2b705, 0xc79300],
  [0x8e24aa, 0x6a1b80],
  [0xef6c00, 0xbf5600],
] as const
const paintFor = (id: string) => {
  let h = 0
  for (const ch of id) h = Math.trunc(h * 31 + ch.charCodeAt(0))
  return PAINTS[1 + (Math.abs(h) % (PAINTS.length - 1))]
}

/** Blocky sports car, nose pointing -Z, wheels on y = 0. Units are blocks. */
const buildCarMesh = (paint: readonly [number, number] = PAINTS[0]): CarParts => {
  const [BODY, BODY_DARK] = paint
  const BLACK = 0x141414
  const WHITE = 0xf2f2f2
  const GLASS = 0x10233a

  const group = new THREE.Group()
  group.name = 'carsAndGuns:car'

  addBox(group, 2, 0.18, 3.6, BLACK, 0, 0.32, 0) // underbody / skirts
  addBox(group, 1.9, 0.5, 4.2, BODY, 0, 0.6, 0) // chassis
  addBox(group, 1.8, 0.14, 1.4, BODY_DARK, 0, 0.92, -1.35) // hood
  addBox(group, 1.8, 0.14, 1, BODY_DARK, 0, 0.92, 1.55) // rear deck
  addBox(group, 1.62, 0.46, 1.7, GLASS, 0, 1.08, 0.25) // cabin glass
  addBox(group, 1.5, 0.08, 1.15, BODY, 0, 1.35, 0.35) // roof

  for (const sx of [-0.25, 0.25]) {
    addBox(group, 0.22, 0.01, 1.4, WHITE, sx, 0.995, -1.35)
    addBox(group, 0.22, 0.01, 1.15, WHITE, sx, 1.395, 0.35)
    addBox(group, 0.22, 0.01, 1, WHITE, sx, 0.995, 1.55)
  }

  addBox(group, 2, 0.24, 0.2, BLACK, 0, 0.4, -2.15) // front bumper
  addBox(group, 0.8, 0.18, 0.05, 0x262626, 0, 0.62, -2.12) // grille
  for (const sx of [-0.65, 0.65]) addBox(group, 0.45, 0.16, 0.05, 0xfff3c4, sx, 0.7, -2.12, true) // headlights

  addBox(group, 2, 0.22, 0.2, BLACK, 0, 0.4, 2.15) // rear bumper
  const brakeLights: THREE.Mesh[] = []
  for (const sx of [-0.62, 0.62]) brakeLights.push(addBox(group, 0.5, 0.14, 0.05, 0x8a0d0d, sx, 0.72, 2.12, true))
  for (const sx of [-0.35, 0.35]) addBox(group, 0.14, 0.14, 0.22, 0x9a9a9a, sx, 0.32, 2.2) // exhausts

  for (const sx of [-0.6, 0.6]) addBox(group, 0.1, 0.32, 0.1, BLACK, sx, 1.13, 1.9) // spoiler posts
  addBox(group, 1.95, 0.07, 0.45, BLACK, 0, 1.3, 1.95) // spoiler wing
  for (const sx of [-1.02, 1.02]) addBox(group, 0.22, 0.12, 0.08, BODY, sx, 1.02, -0.5) // mirrors

  // Wheels: pivot (steering, Y axis) → wheel (rolling, X axis)
  const frontPivots: THREE.Object3D[] = []
  const wheels: THREE.Object3D[] = []
  for (const [wx, wz] of WHEEL_SPOTS) {
    const pivot = new THREE.Object3D()
    pivot.position.set(wx, 0.38, wz)
    const wheel = new THREE.Object3D()
    addBox(wheel, 0.34, 0.76, 0.76, 0x101010, 0, 0, 0) // tyre
    addBox(wheel, 0.36, 0.36, 0.36, 0xc4c4c4, 0, 0, 0) // rim
    pivot.add(wheel)
    group.add(pivot)
    wheels.push(wheel)
    if (wz < 0) frontPivots.push(pivot)
  }

  return { group, frontPivots, wheels, brakeLights }
}

const applyCarPose = (parts: CarParts, s: { x: number, y: number, z: number, heading: number, steer: number }, spin: number, braking: boolean) => {
  parts.group.position.set(s.x, s.y, s.z) // world coords, rebased by sceneOrigin's proxy
  parts.group.rotation.y = s.heading
  for (const p of parts.frontPivots) p.rotation.y = s.steer
  for (const w of parts.wheels) w.rotation.x = -spin
  const brakeColor = braking ? 0xff2323 : 0x8a0d0d
  for (const l of parts.brakeLights) l.material = material(brakeColor, true)
}

const disposeObject = (obj: THREE.Object3D, disposeMaterials = true) => {
  obj.traverse(child => {
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose?.()
    if (disposeMaterials) {
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
      for (const m of mats) {
        ;(m as THREE.MeshBasicMaterial).map?.dispose()
        m.dispose()
      }
    }
  })
}

const removeFromWorld = (obj: THREE.Object3D) => {
  try {
    attachedWorld?.sceneOrigin.removeAndUntrack(obj)
  } catch {
    obj.removeFromParent()
  }
}

const removeCarParts = (parts: CarParts | null) => {
  if (!parts) return
  removeFromWorld(parts.group)
  disposeObject(parts.group, false) // car materials are shared via materialCache
}

const ensureCarMesh = () => {
  if (!attachedWorld || !car.spawned || car.parts) return
  car.parts = buildCarMesh()
  attachedWorld.sceneOrigin.addAndTrack(car.parts.group)
  syncCarMesh()
}

const removeCarMesh = () => {
  removeCarParts(car.parts)
  car.parts = null
}

const syncCarMesh = () => {
  if (car.parts) applyCarPose(car.parts, car, car.wheelSpin, car.braking)
}

// ───────────────────────────── Remote cars ─────────────────────────────

const ensureRemoteCarMesh = (id: string, rc: RemoteCar) => {
  if (!attachedWorld || rc.parts) return
  rc.parts = buildCarMesh(paintFor(id))
  attachedWorld.sceneOrigin.addAndTrack(rc.parts.group)
  applyCarPose(rc.parts, rc.cur, rc.spin, false)
}

const removeRemoteCar = (id: string) => {
  const rc = remoteCars.get(id)
  if (!rc) return
  removeCarParts(rc.parts)
  remoteCars.delete(id)
}

const setRemoteCar = (id: string, state: CarState | null) => {
  if (!state) {
    removeRemoteCar(id)
    return
  }
  let rc = remoteCars.get(id)
  if (!rc) {
    rc = { parts: null, cur: { x: state.x, y: state.y, z: state.z, heading: state.heading, steer: state.steer }, target: state, spin: 0 }
    remoteCars.set(id, rc)
  }
  rc.target = state
  ensureRemoteCarMesh(id, rc)
}

const updateRemoteCars = (dt: number) => {
  const t = 1 - Math.exp(-dt * 12)
  for (const [id, rc] of remoteCars) {
    // Extrapolate a little along the reported speed so motion stays smooth between 10 Hz updates
    const f = forwardOf(rc.target.heading)
    const tx = rc.target.x + f.x * rc.target.speed * 0.05
    const tz = rc.target.z + f.z * rc.target.speed * 0.05
    const jump = Math.hypot(tx - rc.cur.x, tz - rc.cur.z)
    const snap = jump > 12 ? 1 : t
    rc.cur.x += (tx - rc.cur.x) * snap
    rc.cur.y += (rc.target.y - rc.cur.y) * snap
    rc.cur.z += (tz - rc.cur.z) * snap
    rc.cur.heading = angleLerp(rc.cur.heading, rc.target.heading, snap)
    rc.cur.steer += (rc.target.steer - rc.cur.steer) * t
    rc.spin += (rc.target.speed * dt) / 0.38
    ensureRemoteCarMesh(id, rc)
    if (rc.parts) applyCarPose(rc.parts, rc.cur, rc.spin, false)
  }
}

// ───────────────────────────── World attach / detach ─────────────────────────────

const detachWorld = () => {
  clearEffects()
  removeCarMesh()
  for (const rc of remoteCars.values()) {
    removeCarParts(rc.parts)
    rc.parts = null
  }
  attachedWorld = undefined
}

const attachWorld = (w: World) => {
  attachedWorld = w
  ensureCarMesh()
  for (const [id, rc] of remoteCars) ensureRemoteCarMesh(id, rc)
}

const checkWorld = () => {
  const w = (globalThis as any).world as World | undefined
  const usable = w?.sceneOrigin && w.realScene && w.camera ? w : undefined
  if (usable === attachedWorld) return
  detachWorld()
  if (usable) attachWorld(usable)
}

// ───────────────────────────── Spawning ─────────────────────────────

const footprintClear = (cx: number, cz: number, feetY: number, heading: number) => {
  for (const [r, b] of [...CAR_CORNERS, [0, 0]] as const) {
    const p = carLocalToWorld(r, b, heading, cx, cz)
    if (columnBlocked(p.x, p.z, feetY)) return false
    const g = groundHeight(p.x, p.z, feetY + config.car.stepHeight)
    if (!Number.isFinite(g) || feetY - g > 1.5) return false
  }
  return true
}

/** Parks your car next to you. Returns false if nearby chunks aren't loaded / no room. */
const spawnCar = (): boolean => {
  const b = getBot()
  if (!b?.entity || car.driving) return false
  const p = b.entity.position
  const yaw = b.entity.yaw
  const f = forwardOf(yaw)
  const r = rightOf(yaw)
  const spots = [
    [f.x * 5, f.z * 5], [f.x * 7, f.z * 7], [r.x * 4, r.z * 4],
    [-r.x * 4, -r.z * 4], [-f.x * 5, -f.z * 5], [f.x * 9, f.z * 9],
  ]
  const heading = yaw + Math.PI / 2 // parked side-on
  for (const [dx, dz] of spots) {
    const cx = p.x + dx
    const cz = p.z + dz
    const g = groundHeight(cx, cz, p.y + 3, 12)
    if (!Number.isFinite(g)) continue
    if (!footprintClear(cx, cz, g, heading)) continue
    Object.assign(car, { x: cx, y: g, z: cz, heading, speed: 0, vy: 0, steer: 0, spawned: true })
    removeCarMesh()
    ensureCarMesh()
    lastCarSync = 0
    return true
  }
  return false
}

// ───────────────────────────── Driving ─────────────────────────────

const distanceToCar = () => {
  const p = getBot()?.entity?.position
  if (!p || !car.spawned) return Infinity
  return Math.hypot(p.x - car.x, p.y - car.y, p.z - car.z)
}

const updateDrivingCamera = () => {
  const b = getBot()
  if (!b?.entity) return
  const p = b.entity.position
  appViewer.backend?.updateCamera(new Vec3(p.x, p.y - config.car.cameraDrop, p.z), b.entity.yaw, b.entity.pitch, { instant: true })
  const now = performance.now()
  if (now - lastWorldViewUpdate > 200) {
    lastWorldViewUpdate = now
    void appViewer.worldView?.updatePosition(p)
  }
}

const placeDriverInSeat = () => {
  const b = getBot()
  if (!b?.entity) return
  const seat = carLocalToWorld(-0.42, 0.2) // driver side
  b.entity.position.set(seat.x, car.y, seat.z)
  b.entity.velocity.set(0, 0, 0)
  b.entity.onGround = true
}

const enterCar = () => {
  const b = getBot()
  if (!b?.entity || !car.spawned || car.driving) return
  car.driving = true
  car.speed = 0
  b.clearControlStates()
  b.physicsEnabled = false
  b.entity.yaw = car.heading // face down the hood
  b.entity.pitch = 0
  placeDriverInSeat()
  updateDrivingCamera()
  lastCarSync = 0
}

const exitCar = () => {
  const b = getBot()
  car.driving = false
  car.braking = false
  Object.assign(touchInput, { gas: false, brake: false, left: false, right: false, handbrake: false })
  lastCarSync = 0
  if (!b?.entity) return

  let spot: V3 | undefined
  for (const side of [-1.8, 1.8, 0]) {
    const p = side === 0 ? carLocalToWorld(0, 3.2) : carLocalToWorld(side, 0)
    const g = groundHeight(p.x, p.z, car.y + 1.5, 6)
    if (Number.isFinite(g) && playerSpaceFree(p.x, p.z, g)) {
      spot = { x: p.x, y: g, z: p.z }
      break
    }
  }
  spot ??= { x: car.x, y: car.y + 1.45, z: car.z } // on the roof as a last resort

  b.entity.position.set(spot.x, spot.y, spot.z)
  b.entity.velocity.set(0, 0, 0)
  b.clearControlStates()
  b.physicsEnabled = true
  appViewer.backend?.updateCamera(b.entity.position, b.entity.yaw, b.entity.pitch, { instant: true })
  void appViewer.worldView?.updatePosition(b.entity.position)
}

const toggleCar = () => {
  if (car.driving) exitCar()
  else if (distanceToCar() <= config.car.enterDistance) enterCar()
}

const getDriveInput = () => {
  const cs = (getBot()?.controlState ?? {}) as Record<string, boolean>
  const gas = !!cs.forward || touchInput.gas
  const brake = !!cs.back || touchInput.brake
  const left = !!cs.left || touchInput.left
  const right = !!cs.right || touchInput.right
  return {
    throttle: (gas ? 1 : 0) - (brake ? 1 : 0),
    steer: (left ? 1 : 0) - (right ? 1 : 0),
    handbrake: !!cs.jump || touchInput.handbrake,
  }
}

const updateCarPhysics = (dt: number) => {
  const c = config.car
  const input = car.driving ? getDriveInput() : { throttle: 0, steer: 0, handbrake: false }

  const sign = Math.sign(car.speed)
  car.braking = false
  if (input.throttle > 0) {
    if (car.speed < -0.5) { car.speed += c.brake * dt; car.braking = true } else car.speed += c.accel * dt
  } else if (input.throttle < 0) {
    if (car.speed > 0.5) { car.speed -= c.brake * dt; car.braking = true } else car.speed -= c.accel * 0.6 * dt
  } else {
    car.speed -= sign * Math.min(Math.abs(car.speed), c.drag * dt)
  }
  if (input.handbrake) {
    car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), c.handbrake * dt)
    car.braking = true
  }
  car.speed = Math.max(-c.maxReverse, Math.min(c.maxSpeed, car.speed))
  if (!car.driving && Math.abs(car.speed) < 0.05) car.speed = 0

  // Steering (less lock at speed), bicycle model
  const steerLimit = c.maxSteer * (1 - 0.55 * Math.min(1, Math.abs(car.speed) / c.maxSpeed))
  const maxStep = c.steerSpeed * dt
  car.steer += Math.max(-maxStep, Math.min(maxStep, input.steer * steerLimit - car.steer))
  const dHeading = (car.speed / c.wheelBase) * Math.tan(car.steer) * dt

  if (car.speed !== 0) {
    const newHeading = car.heading + dHeading
    const f = forwardOf(newHeading)
    const nx = car.x + f.x * car.speed * dt
    const nz = car.z + f.z * car.speed * dt
    const lead = car.speed > 0 ? -2.15 : 2.15
    let blocked = false
    for (const r of [-0.9, 0, 0.9]) {
      const p = carLocalToWorld(r, lead, newHeading, nx, nz)
      if (columnBlocked(p.x, p.z, car.y)) { blocked = true; break }
    }
    if (blocked) {
      car.speed = -car.speed * 0.25 // bounce off the wall
    } else {
      car.x = nx
      car.z = nz
      car.heading = newHeading
      const b = getBot()
      if (car.driving && b?.entity) b.entity.yaw += dHeading // view turns with the car
    }
  }

  // Vertical: climb steps, fall with gravity
  let ground = -Infinity
  for (const [r, bk] of WHEEL_SPOTS) {
    const p = carLocalToWorld(r, bk)
    const g = groundHeight(p.x, p.z, car.y + c.stepHeight)
    if (Number.isNaN(g)) { ground = car.y; break } // unloaded chunk: hold height
    ground = Math.max(ground, g)
  }
  if (ground > car.y) {
    car.y += (ground - car.y) * Math.min(1, dt * 14)
    if (ground - car.y < 0.01) car.y = ground
    car.vy = 0
  } else if (ground < car.y) {
    car.vy -= c.gravity * dt
    car.y += car.vy * dt
    if (car.y <= ground) { car.y = ground; car.vy = 0 }
    if (car.y < -128) { car.y = -128; car.vy = 0 }
  }

  car.wheelSpin += (car.speed * dt) / 0.38
}

const syncCarToRoom = (now: number) => {
  if (!room.connected) return
  if (!car.spawned) {
    if (!carSyncedAsGone) {
      sendCarState(null)
      carSyncedAsGone = true
    }
    return
  }
  const moving = car.driving || Math.abs(car.speed) > 0.01 || car.vy !== 0
  const interval = moving ? config.car.syncIntervalMs : 1000
  if (now - lastCarSync < interval) return
  lastCarSync = now
  carSyncedAsGone = false
  sendCarState({ x: car.x, y: car.y, z: car.z, heading: car.heading, steer: car.steer, speed: car.speed, driving: car.driving })
}

// ───────────────────────────── Effects ─────────────────────────────

interface Effect {
  obj: THREE.Object3D
  age: number
  life: number
  update: (fx: Effect, dt: number) => void
  onEnd?: () => void
}
const effects: Effect[] = []

const addEffect = (obj: THREE.Object3D, at: V3, life: number, update: Effect['update'], onEnd?: () => void) => {
  if (!attachedWorld) return
  attachedWorld.sceneOrigin.addAndTrack(obj)
  obj.position.set(at.x, at.y, at.z)
  effects.push({ obj, age: 0, life, update, onEnd })
}

const clearEffects = () => {
  for (const fx of effects) {
    removeFromWorld(fx.obj)
    disposeObject(fx.obj)
  }
  effects.length = 0
}

const updateEffects = (dt: number) => {
  for (let i = effects.length - 1; i >= 0; i--) {
    const fx = effects[i]
    fx.age += dt
    fx.update(fx, dt)
    if (fx.age >= fx.life) {
      effects.splice(i, 1)
      removeFromWorld(fx.obj)
      disposeObject(fx.obj)
      fx.onEnd?.()
    }
  }
}

/** Glowing tracer: faint full-length line, soft glow, and a fast bright streak. */
const spawnTracer = (start: V3, end: V3, color: number, onArrive: () => void) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const dz = end.z - start.z
  const dist = Math.hypot(dx, dy, dz) || 0.001
  const dir = new THREE.Vector3(dx / dist, dy / dist, dz / dist)
  const along = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)

  const lineGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, dx, dy, dz], 3))
  const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false })
  addEffect(new THREE.Line(lineGeo, lineMat), start, 0.12, fx => { lineMat.opacity = 0.9 * (1 - fx.age / fx.life) })

  const glowHolder = new THREE.Object3D()
  const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending })
  const glow = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, dist), glowMat)
  glow.quaternion.copy(along)
  glow.position.copy(dir).multiplyScalar(dist / 2)
  glowHolder.add(glow)
  addEffect(glowHolder, start, 0.16, fx => { glowMat.opacity = 0.35 * (1 - fx.age / fx.life) })

  const streakLen = Math.min(2.2, dist)
  const holder = new THREE.Object3D()
  const streak = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, streakLen),
    new THREE.MeshBasicMaterial({ color: 0xfff6d0, transparent: true, opacity: 0.95, depthWrite: false })
  )
  streak.quaternion.copy(along)
  holder.add(streak)
  const travel = dist / config.bulletSpeed
  addEffect(holder, start, Math.max(travel, 0.016), fx => {
    const d = Math.min(dist, (fx.age / fx.life) * dist)
    streak.position.copy(dir).multiplyScalar(Math.max(0, d - streakLen / 2))
  }, onArrive)
}

const spawnMuzzleFlash = (at: V3) => {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 1, depthWrite: false })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), mat)
  addEffect(mesh, at, 0.06, fx => {
    const t = fx.age / fx.life
    mesh.scale.setScalar(1 + t * 1.5)
    mat.opacity = 1 - t
  })
}

const RED_SHADES = [[1, 0.08, 0.05], [0.85, 0, 0], [1, 0.35, 0.1], [0.6, 0, 0.02], [1, 0.2, 0.2]] as const

/** Red particle explosion where a bullet hits */
const spawnRedExplosion = (at: V3, normal: V3) => {
  const n = new THREE.Vector3(normal.x, normal.y, normal.z)
  const origin = { x: at.x + n.x * 0.03, y: at.y + n.y * 0.03, z: at.z + n.z * 0.03 }
  const randDir = () => new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize()
  const kick = (min: number, max: number) => n.clone().multiplyScalar(min + Math.random() * (max - min)).add(randDir().multiplyScalar(1 + Math.random() * 3.5))

  const COUNT = 48
  const positions = new Float32Array(COUNT * 3)
  const colors = new Float32Array(COUNT * 3)
  const velocities: THREE.Vector3[] = []
  for (let i = 0; i < COUNT; i++) {
    velocities.push(kick(1.5, 4.5))
    colors.set(RED_SHADES[Math.floor(Math.random() * RED_SHADES.length)], i * 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const pointsMat = new THREE.PointsMaterial({ size: 0.14, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true })
  addEffect(new THREE.Points(geo, pointsMat), origin, 0.75, (fx, dt) => {
    for (let i = 0; i < COUNT; i++) {
      const v = velocities[i]
      v.y -= 14 * dt
      v.multiplyScalar(1 - 1.6 * dt)
      positions[i * 3] += v.x * dt
      positions[i * 3 + 1] += v.y * dt
      positions[i * 3 + 2] += v.z * dt
    }
    geo.attributes.position.needsUpdate = true
    pointsMat.opacity = 1 - fx.age / fx.life
  })

  const debris = new THREE.Group()
  const cubeGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09)
  const cubeMat = new THREE.MeshBasicMaterial({ color: 0xc40c0c, transparent: true, depthWrite: false })
  const cubeVel: THREE.Vector3[] = []
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(cubeGeo, cubeMat)
    m.rotation.set(Math.random() * 3, Math.random() * 3, 0)
    debris.add(m)
    cubeVel.push(kick(2, 5))
  }
  addEffect(debris, origin, 0.9, (fx, dt) => {
    debris.children.forEach((m, i) => {
      const v = cubeVel[i]
      v.y -= 16 * dt
      m.position.addScaledVector(v, dt)
      m.rotation.x += dt * 8
      m.rotation.y += dt * 6
    })
    cubeMat.opacity = 1 - fx.age / fx.life
  })

  const flashMat = new THREE.MeshBasicMaterial({ color: 0xff3a1a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending })
  const flash = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), flashMat)
  addEffect(flash, origin, 0.14, fx => {
    const t = fx.age / fx.life
    flash.scale.setScalar(1 + t * 3)
    flashMat.opacity = 0.9 * (1 - t)
  })
}

/** Floating damage number that rises and fades */
const spawnDamageNumber = (at: V3, text: string) => {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.font = 'bold 44px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 6
  ctx.strokeStyle = '#000'
  ctx.strokeText(text, 64, 32)
  ctx.fillStyle = '#ff3b30'
  ctx.fillText(text, 64, 32)
  const texture = new THREE.CanvasTexture(canvas)
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(0.9, 0.45, 1)
  sprite.renderOrder = 999
  const holder = new THREE.Object3D()
  holder.add(sprite)
  addEffect(holder, { x: at.x, y: at.y + 0.3, z: at.z }, 0.9, fx => {
    const t = fx.age / fx.life
    sprite.position.y = t * 0.8
    mat.opacity = 1 - t * t
  })
}

// ───────────────────────────── Sound ─────────────────────────────

let audioCtx: AudioContext | undefined
let shotBuffer: AudioBuffer | undefined
const playShotSound = (gain = 1) => {
  try {
    const volume = ((options as any).volume ?? 50) / 100 * gain
    if (volume <= 0.01) return
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    if (!shotBuffer) {
      const len = Math.floor(audioCtx.sampleRate * 0.2)
      shotBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate)
      const data = shotBuffer.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3
    }
    const src = audioCtx.createBufferSource()
    src.buffer = shotBuffer
    const filter = audioCtx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 2400
    const g = audioCtx.createGain()
    g.gain.value = 0.45 * volume
    src.connect(filter).connect(g).connect(audioCtx.destination)
    src.start()
  } catch {
    // audio is cosmetic
  }
}

// ───────────────────────────── Shooting ─────────────────────────────

/** Amanatides–Woo voxel walk over the client's world. Skips the block the ray starts in. */
const voxelRaycast = (o: V3, d: V3, maxDist: number) => {
  let x = Math.floor(o.x)
  let y = Math.floor(o.y)
  let z = Math.floor(o.z)
  const stepX = Math.sign(d.x)
  const stepY = Math.sign(d.y)
  const stepZ = Math.sign(d.z)
  const tDeltaX = d.x === 0 ? Infinity : Math.abs(1 / d.x)
  const tDeltaY = d.y === 0 ? Infinity : Math.abs(1 / d.y)
  const tDeltaZ = d.z === 0 ? Infinity : Math.abs(1 / d.z)
  let tMaxX = d.x > 0 ? (x + 1 - o.x) / d.x : d.x < 0 ? (x - o.x) / d.x : Infinity
  let tMaxY = d.y > 0 ? (y + 1 - o.y) / d.y : d.y < 0 ? (y - o.y) / d.y : Infinity
  let tMaxZ = d.z > 0 ? (z + 1 - o.z) / d.z : d.z < 0 ? (z - o.z) / d.z : Infinity
  let t = 0
  const normal = { x: 0, y: 0, z: 0 }

  for (let i = 0; i < 1024; i++) {
    const solid = isSolid(x, y, z)
    if (solid === null) return undefined // unloaded or outside the world (e.g. sky)
    if (i > 0 && solid) return { t, normal: { ...normal } }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      t = tMaxX; tMaxX += tDeltaX; x += stepX
      normal.x = -stepX; normal.y = 0; normal.z = 0
    } else if (tMaxY < tMaxZ) {
      t = tMaxY; tMaxY += tDeltaY; y += stepY
      normal.x = 0; normal.y = -stepY; normal.z = 0
    } else {
      t = tMaxZ; tMaxZ += tDeltaZ; z += stepZ
      normal.x = 0; normal.y = 0; normal.z = -stepZ
    }
    if (t > maxDist) return undefined
  }
  return undefined
}

/** Nearest other player's hitbox along the ray (client-side prediction) */
const raycastPlayers = (o: V3, d: V3, maxDist: number) => {
  const b = getBot()
  if (!b) return undefined
  let best: { t: number, entity: any } | undefined
  for (const e of Object.values(b.entities ?? {})) {
    if (!e || e === b.entity || e.type !== 'player' || !e.position) continue
    const p = e.position
    const t = rayAabb(o, d, { x: p.x - 0.3, y: p.y, z: p.z - 0.3 }, { x: p.x + 0.3, y: p.y + 1.8, z: p.z + 0.3 })
    if (t !== null && t < maxDist && (!best || t < best.t)) best = { t, entity: e }
  }
  return best
}

const raycaster = new THREE.Raycaster()
const SCREEN_CENTER = new THREE.Vector2(0, 0)

const muzzleFrom = (origin: V3, dir: V3, hitDist: number) => {
  if (hitDist <= 1.2) return { ...origin }
  const right = new THREE.Vector3(dir.x, dir.y, dir.z).cross(new THREE.Vector3(0, 1, 0)).normalize()
  const up = right.clone().cross(new THREE.Vector3(dir.x, dir.y, dir.z)).normalize()
  return {
    x: origin.x + dir.x * 0.8 + right.x * 0.22 - up.x * 0.2,
    y: origin.y + dir.y * 0.8 + right.y * 0.22 - up.y * 0.2,
    z: origin.z + dir.z * 0.8 + right.z * 0.22 - up.z * 0.2,
  }
}

const shoot = (weapon: Weapon) => {
  const w = attachedWorld
  if (!w?.camera) return
  const cam = w.camera
  cam.updateMatrixWorld()
  raycaster.setFromCamera(SCREEN_CENTER, cam)
  raycaster.far = weapon.range

  const ro = raycaster.ray.origin
  const d = raycaster.ray.direction
  const origin = { x: w.sceneOrigin.toWorldX(ro.x), y: w.sceneOrigin.toWorldY(ro.y), z: w.sceneOrigin.toWorldZ(ro.z) }
  const dir = { x: d.x, y: d.y, z: d.z }

  let hitDist = weapon.range
  let hitNormal: V3 | undefined
  let hitKind: 'block' | 'player' | null = null
  const blockHit = voxelRaycast(origin, dir, weapon.range)
  if (blockHit) {
    hitDist = blockHit.t
    hitNormal = blockHit.normal
    hitKind = 'block'
  }

  const playerHit = raycastPlayers(origin, dir, hitDist)
  if (playerHit) {
    hitDist = playerHit.t
    hitNormal = { x: -dir.x, y: -dir.y, z: -dir.z }
    hitKind = 'player'
  }

  // Three.js mesh hits: parked cars (yours and other players')
  const carGroups = [car.driving ? null : car.parts?.group, ...[...remoteCars.values()].map(rc => rc.parts?.group)]
    .filter((g): g is THREE.Group => !!g)
  if (carGroups.length) {
    for (const g of carGroups) g.updateMatrixWorld(true)
    const hit = raycaster.intersectObjects(carGroups, true)[0]
    if (hit && hit.distance < hitDist) {
      hitDist = hit.distance
      hitNormal = { x: -dir.x, y: -dir.y, z: -dir.z }
      hitKind = 'block'
    }
  }

  const end = { x: origin.x + dir.x * hitDist, y: origin.y + dir.y * hitDist, z: origin.z + dir.z * hitDist }
  const start = muzzleFrom(origin, dir, hitDist)

  // Tell everyone (server re-checks the hit against the real world and applies damage)
  sendShoot(origin, dir, hitDist, hitKind)

  playShotSound()
  spawnMuzzleFlash(start)
  const impactNormal = hitNormal
  const kind = hitKind
  spawnTracer(start, end, 0xffe9a0, () => {
    if (impactNormal) spawnRedExplosion(end, impactNormal)
    if (kind === 'player') spawnDamageNumber(end, `-${weapon.damage}`)
  })
}

const startReload = (weapon: Weapon) => {
  const a = ammoFor(weapon)
  if (a.reloadingUntil || a.rounds >= weapon.magazine) return
  a.reloadingUntil = performance.now() + weapon.reloadMs
}

const tryShoot = (now: number) => {
  const weapon = heldWeapon()
  if (!weapon) return
  const a = ammoFor(weapon)
  if (a.reloadingUntil) return
  if (now - lastShotAt < weapon.cooldownMs) return
  if (a.rounds <= 0) {
    startReload(weapon)
    return
  }
  lastShotAt = now
  a.rounds--
  shoot(weapon)
  if (a.rounds <= 0) startReload(weapon)
}

const updateReloads = (now: number) => {
  for (const [id, a] of ammo) {
    if (a.reloadingUntil && now >= a.reloadingUntil) {
      const weapon = Object.values(weapons).find(w => w.id === id)
      a.rounds = weapon?.magazine ?? a.rounds
      a.reloadingUntil = 0
    }
  }
}

// ───────────────────────────── Multiplayer: incoming ─────────────────────────────

onRoomMessage('PLAYER_SHOOT', msg => {
  if (msg.id === room.id || !attachedWorld) return
  const b = getBot()
  const dir = msg.direction
  const end = { x: msg.origin.x + dir.x * msg.distance, y: msg.origin.y + dir.y * msg.distance, z: msg.origin.z + dir.z * msg.distance }

  // Start the tracer at the shooter's avatar so it visibly comes from them
  let origin: V3 = msg.origin
  const avatar = b?.players?.[msg.username]?.entity?.position
  if (avatar) {
    const eye = { x: avatar.x, y: avatar.y + 1.45, z: avatar.z }
    if (Math.hypot(eye.x - msg.origin.x, eye.y - msg.origin.y, eye.z - msg.origin.z) < 8) origin = eye
  }
  const start = muzzleFrom(origin, dir, msg.distance)

  const me = b?.entity?.position
  const distToMe = me ? Math.hypot(me.x - start.x, me.y - start.y, me.z - start.z) : 0
  playShotSound(Math.max(0, 1 - distToMe / 64))
  spawnMuzzleFlash(start)
  spawnTracer(start, end, 0xff8a65, () => {
    if (msg.hit) spawnRedExplosion(end, { x: -dir.x, y: -dir.y, z: -dir.z })
  })
})

onRoomMessage('CAR_STATE', msg => {
  if (msg.id !== room.id) setRemoteCar(msg.id, msg.car)
})
onRoomMessage('WELCOME', msg => {
  for (const id of [...remoteCars.keys()]) removeRemoteCar(id)
  for (const p of msg.players) if (p.car) setRemoteCar(p.id, p.car)
  carSyncedAsGone = !car.spawned
  lastCarSync = 0
})
onRoomMessage('PLAYER_JOIN', () => { lastCarSync = 0 }) // let the newcomer see our car promptly
onRoomMessage('PLAYER_LEAVE', msg => removeRemoteCar(msg.id))

onRoomMessage('HIT_CONFIRM', msg => {
  showHitMarker(msg.killed)
  if (msg.killed) flashHint(`Eliminated ${msg.target}`)
})
onRoomMessage('HIT_TAKEN', msg => {
  flashDamage()
  if (msg.killed) flashHint(`Shot by ${msg.by}`)
})

// ───────────────────────────── Input hooks ─────────────────────────────

// F: get in / out. Only swallowed when it applies, so swap-hands still works elsewhere.
// R: reload while holding a gun.
window.addEventListener('keydown', e => {
  if (e.repeat || !inGameForeground()) return
  if (e.code === 'KeyF') {
    if (!car.driving && distanceToCar() > config.car.enterDistance) return
    e.preventDefault()
    e.stopImmediatePropagation()
    toggleCar()
  } else if (e.code === 'KeyR') {
    const weapon = heldWeapon()
    if (!weapon) return
    e.preventDefault()
    e.stopImmediatePropagation()
    startReload(weapon)
  }
}, { capture: true })

// Left click with a gun fires instead of attacking / breaking.
// The first click that only grabs pointer lock is left alone.
window.addEventListener('mousedown', e => {
  if (e.button !== 0 || !inGameForeground() || !heldWeapon()) return
  if (e.isTrusted && !document.pointerLockElement) return
  e.preventDefault()
  e.stopImmediatePropagation()
  triggerHeld = true
  tryShoot(performance.now())
}, { capture: true })

window.addEventListener('mouseup', e => {
  if (e.button === 0) triggerHeld = false
}, { capture: true })

window.addEventListener('blur', () => {
  triggerHeld = false
  Object.assign(touchInput, { gas: false, brake: false, left: false, right: false, handbrake: false })
})

// ───────────────────────────── HUD + mobile controls ─────────────────────────────

const css = `
.cg-hud{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:12;pointer-events:none;
  color:#fff;font:inherit;font-size:14px;text-shadow:1px 1px 0 #000;text-align:center;white-space:pre;display:none}
.cg-ammo{position:fixed;right:16px;bottom:16px;z-index:12;pointer-events:none;color:#fff;font:inherit;font-size:18px;
  text-shadow:2px 2px 0 #000;text-align:right;white-space:pre;display:none;line-height:1.2}
.cg-ammo b{font-size:30px}
.cg-ammo[data-low]{color:#ff6b5e}
.cg-hitmarker{position:fixed;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;z-index:13;pointer-events:none;
  opacity:0;transition:opacity .25s}
.cg-hitmarker::before,.cg-hitmarker::after{content:'';position:absolute;left:12px;top:0;width:2px;height:26px;background:#fff;
  box-shadow:0 0 2px #000}
.cg-hitmarker::before{transform:rotate(45deg)}.cg-hitmarker::after{transform:rotate(-45deg)}
.cg-hitmarker[data-kill]::before,.cg-hitmarker[data-kill]::after{background:#ff3b30}
.cg-hitmarker[data-on]{opacity:1;transition:none}
.cg-damage{position:fixed;inset:0;z-index:11;pointer-events:none;opacity:0;transition:opacity .5s;
  background:radial-gradient(ellipse at center,rgba(255,0,0,0) 55%,rgba(200,0,0,.55) 100%)}
.cg-damage[data-on]{opacity:1;transition:none}
.cg-toggle{position:fixed;right:8px;top:30%;z-index:20;width:42px;height:42px;border-radius:50%;
  background:rgba(0,0,0,.5);border:2px solid rgba(255,255,255,.4);color:#fff;font-size:20px;line-height:1;
  display:none;align-items:center;justify-content:center;touch-action:none;user-select:none;-webkit-user-select:none;
  -webkit-tap-highlight-color:transparent;cursor:pointer;padding:0}
.cg-toggle[data-on]{background:rgba(211,18,27,.65)}
.cg-panel{position:fixed;right:8px;top:calc(30% + 52px);z-index:20;display:none;flex-direction:column;gap:8px;
  touch-action:none;user-select:none;-webkit-user-select:none}
.cg-row{display:flex;gap:8px;justify-content:flex-end}
.cg-btn{width:64px;height:64px;border-radius:12px;background:rgba(0,0,0,.45);border:2px solid rgba(255,255,255,.35);
  color:#fff;font:inherit;font-size:12px;line-height:1.15;padding:2px;touch-action:none;user-select:none;
  -webkit-user-select:none;-webkit-tap-highlight-color:transparent;white-space:pre;cursor:pointer}
.cg-btn[data-active]{background:rgba(255,255,255,.32)}
.cg-btn[data-dim]{opacity:.45}
.cg-btn.cg-fire{background:rgba(160,10,10,.6)}
.cg-btn.cg-gas{background:rgba(20,120,40,.55)}
body.cg-mobile .cg-ammo{right:84px}
`

const mkButton = (label: string, cls = '') => {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = `cg-btn ${cls}`
  el.textContent = label
  return el
}

/** Hold-style button: onDown on press, onUp on release/cancel. Never leaks touches to the game. */
const bindHold = (el: HTMLElement, onDown: () => void, onUp?: () => void) => {
  const release = () => {
    if (!el.dataset.active) return
    delete el.dataset.active
    onUp?.()
  }
  el.addEventListener('pointerdown', e => {
    e.preventDefault()
    e.stopPropagation()
    try { el.setPointerCapture(e.pointerId) } catch {}
    el.dataset.active = '1'
    onDown()
  })
  el.addEventListener('pointerup', release)
  el.addEventListener('pointercancel', release)
  el.addEventListener('lostpointercapture', release)
  for (const type of ['touchstart', 'touchmove', 'touchend', 'mousedown', 'click', 'contextmenu'] as const) {
    el.addEventListener(type, e => {
      e.stopPropagation()
      if (type === 'contextmenu') e.preventDefault()
    })
  }
}

const loadMobilePref = () => {
  try {
    const v = localStorage.getItem(MOBILE_PREF_KEY)
    if (v !== null) return v === '1'
  } catch {}
  return !!(window.matchMedia?.('(pointer: coarse)').matches || miscUiState.currentTouch)
}
let mobileControlsOn = loadMobilePref()
const setMobileControls = (on: boolean) => {
  mobileControlsOn = on
  try { localStorage.setItem(MOBILE_PREF_KEY, on ? '1' : '0') } catch {}
}

let ui: ReturnType<typeof buildUi> | undefined

let hintText = ''
let hintUntil = 0
const flashHint = (text: string) => {
  hintText = text
  hintUntil = performance.now() + 1800
}

let hitMarkerTimer: ReturnType<typeof setTimeout> | undefined
const showHitMarker = (kill: boolean) => {
  if (!ui) return
  const el = ui.hitMarker
  if (kill) el.dataset.kill = '1'
  else delete el.dataset.kill
  el.dataset.on = '1'
  clearTimeout(hitMarkerTimer)
  hitMarkerTimer = setTimeout(() => { delete el.dataset.on }, kill ? 350 : 120)
}

let damageTimer: ReturnType<typeof setTimeout> | undefined
const flashDamage = () => {
  if (!ui) return
  ui.damage.dataset.on = '1'
  clearTimeout(damageTimer)
  damageTimer = setTimeout(() => { if (ui) delete ui.damage.dataset.on }, 90)
}

const buildUi = () => {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  const hud = document.createElement('div')
  hud.className = 'cg-hud'
  const ammoEl = document.createElement('div')
  ammoEl.className = 'cg-ammo'
  const hitMarker = document.createElement('div')
  hitMarker.className = 'cg-hitmarker'
  const damage = document.createElement('div')
  damage.className = 'cg-damage'

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'cg-toggle'
  toggle.textContent = '🚗'
  toggle.title = 'Show / hide car & gun controls'
  bindHold(toggle, () => setMobileControls(!mobileControlsOn))

  const panel = document.createElement('div')
  panel.className = 'cg-panel'

  const fire = mkButton('FIRE', 'cg-fire')
  bindHold(fire, () => {
    if (!heldWeapon()) { flashHint('Hold your Rifle (iron hoe)\nto shoot · /rifle for a new one'); return }
    triggerHeld = true
    tryShoot(performance.now())
  }, () => { triggerHeld = false })
  const reload = mkButton('RELOAD')
  bindHold(reload, () => {
    const w = heldWeapon()
    if (w) startReload(w)
  })
  const fireRow = document.createElement('div')
  fireRow.className = 'cg-row'
  fireRow.append(reload, fire)

  // On foot
  const footRow = document.createElement('div')
  footRow.className = 'cg-row'
  const drive = mkButton('DRIVE')
  bindHold(drive, () => {
    if (distanceToCar() <= config.car.enterDistance) enterCar()
    else flashHint('Walk up to your car first')
  })
  const summon = mkButton('CALL\nCAR')
  bindHold(summon, () => {
    if (!spawnCar()) flashHint('No room for the car here')
  })
  footRow.append(summon, drive)

  // Driving
  const driveTop = document.createElement('div')
  driveTop.className = 'cg-row'
  const exit = mkButton('EXIT')
  bindHold(exit, exitCar)
  driveTop.append(exit)

  const steerRow = document.createElement('div')
  steerRow.className = 'cg-row'
  const left = mkButton('◀')
  const right = mkButton('▶')
  bindHold(left, () => { touchInput.left = true }, () => { touchInput.left = false })
  bindHold(right, () => { touchInput.right = true }, () => { touchInput.right = false })
  steerRow.append(left, right)

  const pedalRow = document.createElement('div')
  pedalRow.className = 'cg-row'
  const brake = mkButton('▼\nBRAKE')
  const gas = mkButton('▲\nGAS', 'cg-gas')
  bindHold(brake, () => { touchInput.brake = true }, () => { touchInput.brake = false })
  bindHold(gas, () => { touchInput.gas = true }, () => { touchInput.gas = false })
  pedalRow.append(brake, gas)

  panel.append(fireRow, footRow, driveTop, steerRow, pedalRow)
  document.body.append(damage, hud, ammoEl, hitMarker, toggle, panel)

  return { hud, ammoEl, hitMarker, damage, toggle, panel, fire, reload, drive, footRow, driveTop, steerRow, pedalRow }
}

const textCache = new WeakMap<HTMLElement, string>()
const setText = (el: HTMLElement, text: string, html = false) => {
  if (textCache.get(el) === text) return
  textCache.set(el, text)
  if (html) el.innerHTML = text
  else el.textContent = text
}
const setDisplay = (el: HTMLElement, display: string) => {
  if (el.style.display !== display) el.style.display = display
}
const setFlag = (el: HTMLElement, flag: string, on: boolean) => {
  if (on) el.dataset[flag] = '1'
  else delete el.dataset[flag]
}

const updateUi = (now: number) => {
  if (!ui) {
    if (!document.body) return
    ui = buildUi()
  }
  const show = !!getBot()?.entity && miscUiState.gameLoaded && activeModalStack.length === 0
  document.body.classList.toggle('cg-mobile', show && mobileControlsOn)
  setDisplay(ui.toggle, show ? 'flex' : 'none')
  setFlag(ui.toggle, 'on', mobileControlsOn)
  setDisplay(ui.panel, show && mobileControlsOn ? 'flex' : 'none')
  setDisplay(ui.footRow, car.driving ? 'none' : 'flex')
  for (const row of [ui.driveTop, ui.steerRow, ui.pedalRow]) setDisplay(row, car.driving ? 'flex' : 'none')

  // Ammo counter
  const weapon = heldWeapon()
  setFlag(ui.fire, 'dim', !weapon)
  setFlag(ui.reload, 'dim', !weapon)
  if (show && weapon) {
    const a = ammoFor(weapon)
    const text = a.reloadingUntil
      ? `${weapon.label}<br><b>RELOADING…</b>`
      : `${weapon.label}<br><b>${a.rounds}</b> / ${weapon.magazine}`
    setText(ui.ammoEl, text, true)
    setFlag(ui.ammoEl, 'low', !a.reloadingUntil && a.rounds <= Math.ceil(weapon.magazine / 4))
    setDisplay(ui.ammoEl, 'block')
  } else {
    setDisplay(ui.ammoEl, 'none')
  }

  const dist = distanceToCar()
  const near = dist <= config.car.enterDistance
  setText(ui.drive, near ? 'DRIVE' : Number.isFinite(dist) ? `CAR\n${Math.round(dist)}m` : 'DRIVE')
  setFlag(ui.drive, 'dim', !near)

  let hud = ''
  if (now < hintUntil) hud = hintText
  else if (car.driving) hud = `${Math.round(Math.abs(car.speed) * 3.6)} km/h${car.speed < -0.3 ? '  R' : ''}\n${mobileControlsOn ? 'EXIT to get out' : 'F to get out · Space handbrake'}`
  else if (near && show) hud = mobileControlsOn ? 'Tap DRIVE to get in' : 'Press F to drive'
  setText(ui.hud, hud)
  setDisplay(ui.hud, show && hud ? 'block' : 'none')
}

// ───────────────────────────── Lifecycle ─────────────────────────────

const resetSession = () => {
  if (car.driving) {
    const b = getBot()
    if (b) b.physicsEnabled = true
  }
  car.driving = false
  car.spawned = false
  carSyncedAsGone = true
  triggerHeld = false
  ammo.clear()
  removeCarMesh()
  for (const id of [...remoteCars.keys()]) removeRemoteCar(id)
  clearEffects()
}

customEvents.on('gameLoaded', () => {
  resetSession()
  pendingSpawn = true
  lastSpawnAttempt = 0
  getBot()?.once('end', () => {
    resetSession()
    pendingSpawn = false
  })
})

// ───────────────────────────── Frame hook ─────────────────────────────

beforeRenderFrame.push(() => {
  const now = performance.now()
  const dt = Math.min(0.05, (now - lastFrameAt) / 1000)
  lastFrameAt = now

  checkWorld()
  updateReloads(now)
  updateUi(now)

  const b = getBot()
  if (!b?.entity || !attachedWorld) return

  if (pendingSpawn && now - lastSpawnAttempt > 500) {
    lastSpawnAttempt = now
    if (spawnCar()) pendingSpawn = false
  }

  if (car.driving && ((b as any).health <= 0 || b.game?.gameMode === 'spectator')) exitCar()

  if (car.spawned) {
    updateCarPhysics(dt)
    ensureCarMesh()
    syncCarMesh()
    if (car.driving) {
      b.physicsEnabled = false
      placeDriverInSeat()
      updateDrivingCamera()
    }
  }
  syncCarToRoom(now)
  updateRemoteCars(dt)

  if (triggerHeld) {
    if (inGameForeground() && heldWeapon()) tryShoot(now)
    else triggerHeld = false
  }

  updateEffects(dt)
})

;(window as any).carsAndGuns = {
  config,
  weapons,
  spawnCar,
  enterCar,
  exitCar,
  setMobileControls,
  get state () { return { ...car, parts: undefined, remoteCars: remoteCars.size, room: room.connected } },
}
