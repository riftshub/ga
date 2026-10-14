# Cars & Guns — browser Minecraft with its own multiplayer host

```
game/
├── client/            The game client (TypeScript + Three.js). Builds to client/dist (HTML/JS/CSS).
│   ├── src/
│   │   ├── carsAndGuns.ts       cars, Rifle item, ammo, tracers, mobile controls
│   │   ├── gameServer.ts        the server address: wss://trueelement.shop (change it here)
│   │   ├── multiplayerRoom.ts   JSON room connection (PLAYER_SHOOT, cars, hits)
│   │   └── index.ts             loads the two modules above
│   └── dist/          created by the build — the static files players download
├── server/
│   ├── server.js      serves client/dist + runs the world (/mc) and room (/room) on one port
│   └── package.json   server-only dependencies
├── Dockerfile         builds client, then runs server
└── package.json       one-command build / start
```

## Run it on your computer (Node.js 22)

```
npm run build     # installs client + server packages, builds client/dist
npm start         # http://localhost:8080/play
```

While developing the client: `npm run dev` (hot reload on http://localhost:3000, world + room on :8080;
join `ws://localhost:8080/mc`).

## Host it

Use a host that runs Docker or Node.js with WebSockets (Railway, Render, Fly.io, a VPS).
Static-only hosts (GitHub Pages, Netlify, Vercel) can't run the server.

- **Docker:** point the host at this folder; it uses the `Dockerfile`.
- **Plain Node:** build command `npm run build`, start command `npm start`.
- Attach a persistent disk at `/app/world` (Docker) or set `WORLD_FOLDER`, or the world resets on restart.
- Point your domain `trueelement.shop` at the host (the host gives you the DNS record to add)
  and turn on HTTPS there — `wss://` only works over HTTPS.
- Share `https://trueelement.shop/play` with friends.
- To use a different address, change `GAME_SERVER_ORIGIN` in `client/src/gameServer.ts`
  and `PUBLIC_GAME_URL` in the `Dockerfile` (or your host's environment settings), then rebuild.

Settings are environment variables, listed at the top of `server/server.js`
(`SERVER_NAME`, `MAX_PLAYERS`, `GAME_MODE`, `MC_VERSION`, `VIEW_DISTANCE`, ...).
