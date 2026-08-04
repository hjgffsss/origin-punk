# 404 Origin Punk

Live NFT gallery for the Origin Punk collection on Robinhood Chain. Metadata, ownership,
and sale history are read live from Alchemy's NFT API and the OpenSea API — no seeded/mock
data is used as a silent fallback if those calls fail.

Wallet connect supports:
- **Any installed browser extension** (MetaMask, Rabby, OKX, Bitget, Coinbase, etc.) via
  automatic EIP-6963 discovery — nothing hardcoded, whatever's installed just shows up.
- **Coinbase Wallet / Base** via the official Coinbase Wallet SDK.
- **Everything else** (Rainbow, Trust, TokenPocket, Safe, and any other WalletConnect-
  compatible wallet) via WalletConnect v2 — QR code on desktop, direct deep link on mobile.

## Structure

```
origin-punk/
├── index.html          entry HTML, loads src/main.jsx
├── package.json
├── vite.config.js
├── .env.example          copy to .env and fill in real keys
├── .gitignore             .env, node_modules, dist are ignored
└── src/
    ├── main.jsx           ReactDOM render entry
    └── App.jsx            the app (default export: OriginPunkApp)
```

8 files total.

## Local setup

```bash
npm install
cp .env.example .env   # then fill in every VITE_* value
npm run dev
```

You'll need:
- an **Alchemy** app key for Robinhood Chain (or whatever chain you point this at)
- an **OpenSea** API key
- a **WalletConnect Cloud** project ID (walletconnect.com/cloud) — powers every wallet
  connect path except installed browser extensions

## Notes

- **Staking/XP and the home-page activity ticker are a local game mechanic** — there's no
  deployed staking contract or sales indexer behind them, by design.
- **Rarity rank** is computed only across whatever page of tokens has been loaded so far,
  not the full on-chain supply.
- Even with `VITE_*` env vars, Vite inlines them into the client bundle at build time — they
  are **not secret** once deployed. For production, proxy Alchemy/OpenSea calls through your
  own backend instead of calling them directly from the browser, and never reuse a key that
  was ever pasted into a chat.
- Deep-link schemes for individual mobile wallets (`WC_MOBILE_DEEPLINKS` in `App.jsx`) can
  change as wallets update their own linking docs — verify against each wallet's current
  documentation if a specific one stops opening correctly.

## Deploy

Easiest options for a static Vite app:
- **Vercel** or **Netlify**: connect the GitHub repo, set all `VITE_*` vars in the project's
  environment variables dashboard, deploy.
- **GitHub Pages**: works too, but env variables need to be injected at build time via a
  GitHub Actions workflow rather than a dashboard.
