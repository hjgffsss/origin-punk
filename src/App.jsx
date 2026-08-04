import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { EthereumProvider } from "@walletconnect/ethereum-provider";
import CoinbaseWalletSDK from "@coinbase/wallet-sdk";
import QRCode from "qrcode";
import {
  Wallet, X, Search, ChevronDown, Zap, Layers, Trophy, LayoutGrid,
  Home as HomeIcon, Check, Clock, TrendingUp,
  ShieldCheck, Pause, Play, Copy, Filter, SlidersHorizontal, Loader2
} from "lucide-react";

/* ============================================================================
   404 ORIGIN PUNK — live data build
   NFT metadata + ownership are read live from Alchemy's NFT API on
   Robinhood Chain. Sale/price history is read live from the OpenSea API.
   Wallet connect supports any installed browser extension wallet via
   EIP-6963 auto-discovery (MetaMask, Rabby, OKX, Bitget, Coinbase, etc. —
   whatever's actually installed shows up on its own, nothing hardcoded),
   Coinbase Wallet / Base via the official Coinbase Wallet SDK, and every
   other mobile/desktop wallet (Trust, Rainbow, TokenPocket, Safe, and any
   WalletConnect-compatible wallet) via WalletConnect v2 — QR on desktop,
   a direct deep link on mobile. Staking + XP are still a client-side game
   mechanic (there's no deployed staking contract for this collection), and
   rarity/rank are computed only across whatever page of tokens has been
   loaded so far, not the full on-chain supply — both are labeled as such
   in the UI below.

   ⚠️ SECURITY NOTE: every key below now comes from import.meta.env — set
   them in a .env file (see .env.example) that's gitignored, never commit
   real values. VITE_-prefixed vars are still bundled into the client-visible
   JS at build time (that's how Vite works), so this keeps them out of your
   source/repo but does NOT make them a true server-side secret — for that,
   the OpenSea/Alchemy calls would need to go through your own backend.
   Since the keys used earlier in this conversation were posted in chat,
   rotate/regenerate them in the Alchemy, OpenSea, and WalletConnect Cloud
   dashboards regardless of what you do with this file.
============================================================================ */

const ALCHEMY_API_KEY = import.meta.env.VITE_ALCHEMY_API_KEY || "";
const ALCHEMY_NETWORK_SUBDOMAIN = import.meta.env.VITE_ALCHEMY_NETWORK_SUBDOMAIN || "robinhood-mainnet";
const ALCHEMY_NFT_BASE = `https://${ALCHEMY_NETWORK_SUBDOMAIN}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;
const ALCHEMY_RPC_URL = `https://${ALCHEMY_NETWORK_SUBDOMAIN}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

const OPENSEA_API_KEY = import.meta.env.VITE_OPENSEA_API_KEY || "";
const OPENSEA_BASE = "https://api.opensea.io/api/v2";
const OPENSEA_CHAIN_SLUG = import.meta.env.VITE_OPENSEA_CHAIN_SLUG || "robinhood"; // OpenSea's chain identifier for Robinhood Chain

const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";
if (!WALLETCONNECT_PROJECT_ID) {
  console.warn("[wallet] VITE_WALLETCONNECT_PROJECT_ID is not set — WalletConnect-based wallets (anything besides installed browser extensions) will be unavailable until it is.");
}

const CHAIN_ID_DEC = Number(import.meta.env.VITE_CHAIN_ID || 4663);
const CHAIN_ID_HEX = "0x" + CHAIN_ID_DEC.toString(16);
const CHAIN_NAME = import.meta.env.VITE_CHAIN_NAME || "Robinhood Chain";
const CHAIN_EXPLORER_URL = import.meta.env.VITE_EXPLORER_URL || "https://robinhoodchain.blockscout.com";
const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: CHAIN_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [ALCHEMY_RPC_URL],
  blockExplorerUrls: [CHAIN_EXPLORER_URL],
};

const COLLECTION_ADDRESS = import.meta.env.VITE_COLLECTION_ADDRESS || "0x68e5a6aaf2503940f0337243063ab8f4da6bedec";

// ---------------------------------------------------------------------------
// seeded PRNG so the "collection" is stable across renders
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(404);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const short = (addr) => addr.slice(0, 6) + "…" + addr.slice(-4);

const MOCK_WALLETS = Array.from({ length: 24 }, () => {
  const chars = "0123456789abcdef";
  let s = "0x";
  for (let i = 0; i < 40; i++) s += chars[Math.floor(rand() * 16)];
  return s;
});

// ---------------------------------------------------------------------------
// LIVE DATA — Alchemy NFT API (Robinhood Chain) + OpenSea API
// ---------------------------------------------------------------------------
async function alchemyNft(path) {
  const url = `${ALCHEMY_NFT_BASE}${path}`;
  console.log(`[Alchemy NFT API] → GET ${url}`);
  let res;
  try {
    res = await fetch(url);
  } catch (networkErr) {
    // fetch() throws a bare TypeError for both offline connections and
    // CORS-blocked requests — there's no header to inspect, so we can only
    // report that the request never completed.
    console.error(`[Alchemy NFT API] ✗ network error for ${url}`, networkErr);
    throw new Error(`Network/CORS error reaching Alchemy (${networkErr.message})`);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    console.error(`[Alchemy NFT API] ✗ ${res.status} ${res.statusText} for ${url}`, bodyText);
    throw new Error(`Alchemy ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
  }
  const json = await res.json();
  console.log(`[Alchemy NFT API] ✓ ${url}`, json);
  return json;
}
async function fetchContractMetadata(address) {
  return alchemyNft(`/getContractMetadata?contractAddress=${address}`);
}
async function fetchNFTsForContract(address, pageKey) {
  const params = new URLSearchParams({ contractAddress: address, withMetadata: "true", limit: "48" });
  if (pageKey) params.set("pageKey", pageKey);
  console.log(`[Alchemy] fetchNFTsForContract(address=${address}, pageKey=${pageKey ?? "<none>"})`);
  return alchemyNft(`/getNFTsForContract?${params.toString()}`);
}
async function fetchNFTsForOwner(owner, address) {
  const params = new URLSearchParams({ owner, withMetadata: "true", pageSize: "100" });
  params.append("contractAddresses[]", address);
  console.log(`[Alchemy] fetchNFTsForOwner(owner=${owner}, address=${address})`);
  return alchemyNft(`/getNFTsForOwner?${params.toString()}`);
}
async function fetchSaleHistory(address, tokenId) {
  const url = `${OPENSEA_BASE}/events/chain/${OPENSEA_CHAIN_SLUG}/contract/${address}/nfts/${tokenId}?event_type=sale`;
  console.log(`[OpenSea API] → GET ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: { "x-api-key": OPENSEA_API_KEY, accept: "application/json" } });
  } catch (networkErr) {
    // OpenSea's API does not send CORS headers for every chain slug, so a
    // browser-side call to an unindexed chain fails here as a generic
    // TypeError rather than a readable status code. Surface that plainly
    // instead of letting it bubble up as an unexplained crash.
    console.error(`[OpenSea API] ✗ network/CORS error for ${url}`, networkErr);
    throw new Error(`Network/CORS error reaching OpenSea (${networkErr.message})`);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    console.error(`[OpenSea API] ✗ ${res.status} ${res.statusText} for ${url}`, bodyText);
    throw new Error(`OpenSea ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
  }
  const json = await res.json();
  console.log(`[OpenSea API] ✓ ${url}`, json);
  return json;
}

// map one Alchemy NFT object into the shape the rest of the UI expects
function mapAlchemyNft(raw) {
  const attrs = raw?.raw?.metadata?.attributes || raw?.metadata?.attributes || [];
  const t = {};
  attrs.forEach((a) => { if (a?.trait_type) t[String(a.trait_type).toLowerCase()] = a.value; });
  const image =
    raw?.image?.cachedUrl || raw?.image?.originalUrl || raw?.image?.thumbnailUrl ||
    raw?.media?.[0]?.gateway || null;
  return {
    id: Number(raw.tokenId),
    type: t.type || t.species || t.class || "Unknown",
    gender: t.gender || "N/A",
    background: t.background || "Unknown",
    eyes: t.eyes || "Unknown",
    hat: t.hat || t.headwear || "None",
    accessory: t.accessory || "None",
    traitCount: attrs.length,
    image,
    tokenUri: raw?.tokenUri || null,
    name: raw?.name || raw?.raw?.metadata?.name || null,
  };
}

// generic rarity score computed only across whatever sample is currently
// loaded — NOT the full on-chain supply, so it's labeled as sample-based in the UI
function scoreRaritySample(nfts) {
  if (!nfts.length) return nfts;
  const keys = ["type", "background", "eyes", "hat", "accessory"];
  const freq = {};
  keys.forEach((k) => { freq[k] = {}; });
  nfts.forEach((n) => keys.forEach((k) => { freq[k][n[k]] = (freq[k][n[k]] || 0) + 1; }));
  const scored = nfts.map((n) => {
    let score = 0;
    keys.forEach((k) => { score += nfts.length / (freq[k][n[k]] || 1); });
    return { ...n, rarityScore: score };
  });
  const humanLike = scored.filter((n) => n.type && n.type !== "Alien" && n.type !== "Ape");
  const scores = humanLike.length ? humanLike.map((n) => n.rarityScore) : scored.map((n) => n.rarityScore);
  const minS = Math.min(...scores), maxS = Math.max(...scores);
  const withXp = scored.map((n) => {
    const type = n.type;
    let xpPerDay;
    if (type === "Alien") xpPerDay = 1500;
    else if (type === "Ape") xpPerDay = 1000;
    else if (type === "Zombie") xpPerDay = 600;
    else {
      const tt = (n.rarityScore - minS) / Math.max(1, maxS - minS);
      xpPerDay = Math.round(150 + tt * (350 - 150));
    }
    return { ...n, xpPerDay, owner: n.owner || null, lastSalePrice: n.lastSalePrice ?? null };
  });
  const ranked = [...withXp].sort((a, b) => b.rarityScore - a.rarityScore);
  const rankOf = {};
  ranked.forEach((n, i) => { rankOf[n.id] = i + 1; });
  return withXp.map((n) => ({ ...n, rank: rankOf[n.id] }));
}

// ---------------------------------------------------------------------------
// EIP-6963 wallet discovery — the modern standard for "auto-detect whatever
// wallet extensions are actually installed" (MetaMask, Rabby, OKX, Bitget,
// Coinbase extension, Rainbow extension, etc. all announce themselves this
// way). Nothing here is hardcoded to a specific wallet: the icon, name, and
// EIP-1193 provider all come from the wallet itself.
// ---------------------------------------------------------------------------
function useDiscoveredWallets() {
  const [wallets, setWallets] = useState([]); // [{ info: {uuid,name,icon,rdns}, provider }]

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onAnnounce = (event) => {
      setWallets((prev) => {
        if (prev.some((w) => w.info.uuid === event.detail.info.uuid)) return prev;
        console.log(`[EIP-6963] discovered wallet: ${event.detail.info.name}`);
        return [...prev, event.detail];
      });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  return wallets;
}

// Real deep link schemes for opening a specific wallet app on mobile with a
// pending WalletConnect URI. These change over time as wallets update their
// own linking docs — verify against each wallet's current developer docs
// before relying on this table in production.
const WC_MOBILE_DEEPLINKS = {
  metamask: (uri) => `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`,
  rainbow: (uri) => `https://rnbwapp.com/wc?uri=${encodeURIComponent(uri)}`,
  trust: (uri) => `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}`,
  okx: (uri) => `okx://wallet/wc?uri=${encodeURIComponent(uri)}`,
  bitget: (uri) => `bitkeep://bkwallet/wc?uri=${encodeURIComponent(uri)}`,
  tokenpocket: (uri) => `tpoutside://wc?uri=${encodeURIComponent(uri)}`,
  rabby: (uri) => `rabby://wc?uri=${encodeURIComponent(uri)}`,
  safe: (uri) => `https://app.safe.global/share/safe-app?appUrl=${encodeURIComponent(window.location.origin)}&uri=${encodeURIComponent(uri)}`,
};
const isMobileDevice = () => typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let wcProviderPromise = null;
// Lazily creates (and caches) a single WalletConnect v2 provider instance —
// this is what powers Rainbow, Trust, TokenPocket, Safe, and any other
// WalletConnect-compatible wallet, on both desktop (QR) and mobile (deep link).
function getWalletConnectProvider() {
  if (!WALLETCONNECT_PROJECT_ID) return Promise.reject(new Error("VITE_WALLETCONNECT_PROJECT_ID is not set"));
  if (!wcProviderPromise) {
    wcProviderPromise = EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      chains: [CHAIN_ID_DEC],
      showQrModal: false, // we render our own QR/deep-link UI to match the app's design
      metadata: {
        name: "404 Origin Punk",
        description: "Live NFT gallery, ownership, and staking",
        url: typeof window !== "undefined" ? window.location.origin : "https://404punks.xyz",
        icons: [typeof window !== "undefined" ? `${window.location.origin}/favicon.svg` : ""],
      },
    });
  }
  return wcProviderPromise;
}

// Starts a WalletConnect pairing session. onUri is called with the wc: URI
// as soon as it's ready, so the caller can render a QR code and/or fire a
// mobile deep link with it. Resolves once the user approves in their wallet.
async function connectWalletConnect(onUri) {
  const provider = await getWalletConnectProvider();
  provider.on("display_uri", (uri) => {
    console.log("[WalletConnect] display_uri ready");
    onUri?.(uri);
  });
  await provider.connect();
  const address = provider.accounts?.[0];
  if (!address) throw new Error("NO_ACCOUNT");
  return { address, ethProvider: provider };
}

let cbProvider = null;
function getCoinbaseProvider() {
  if (!cbProvider) {
    const sdk = new CoinbaseWalletSDK({ appName: "404 Origin Punk", appLogoUrl: typeof window !== "undefined" ? `${window.location.origin}/favicon.svg` : "" });
    // Coinbase's SDK handles extension detection, the Coinbase/Base mobile
    // app popup, and QR pairing internally — no manual device branching needed.
    cbProvider = sdk.makeWeb3Provider(ALCHEMY_RPC_URL, CHAIN_ID_DEC);
  }
  return cbProvider;
}
async function connectCoinbase() {
  const provider = getCoinbaseProvider();
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("NO_ACCOUNT");
  return { address, ethProvider: provider };
}

// Requests accounts + attempts to switch to the collection's chain via any
// EIP-1193 provider (an EIP-6963-discovered extension, the WalletConnect
// session provider, or the Coinbase SDK provider). Signing happens once,
// in finishConnect() — kept out of here so every connect path only prompts
// the wallet for a signature a single time.
async function connectWithProvider(eth, providerLabel) {
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("NO_ACCOUNT");

  // try to get on Robinhood Chain so the reads below line up with what's connected
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (switchErr) {
    if (switchErr?.code === 4902) {
      try {
        await eth.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
      } catch (_addErr) { /* user can decline; we still proceed with whatever chain they're on */ }
    }
  }

  return { address, provider: providerLabel, ethProvider: eth };
}

// ---------------------------------------------------------------------------
// pixel identicon — deterministic per-token placeholder art
// stands in for real token images (not fetched, since no live IPFS/metadata
// source is connected in this demo)
// ---------------------------------------------------------------------------
const TIER_PALETTE = {
  Alien: ["#FF2E9A", "#2BFBEB", "#0E0F13"],
  Ape: ["#FFB020", "#2BFBEB", "#0E0F13"],
  Zombie: ["#C6FF3D", "#1a2b12", "#0E0F13"],
  Human: ["#8993A6", "#2BFBEB", "#0E0F13"],
};
function seededGrid(id, size = 6) {
  let s = id * 9301 + 49297;
  const next = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const half = Math.ceil(size / 2);
  const grid = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < half; x++) row.push(next() > 0.55 ? 1 : 0);
    const mirrored = [...row, ...row.slice(0, size - half).reverse()];
    grid.push(mirrored);
  }
  return grid;
}
function PixelAvatar({ nft, className = "" }) {
  const grid = useMemo(() => seededGrid(nft.id), [nft.id]);
  const [fg, glow, bg] = TIER_PALETTE[nft.type];
  return (
    <div className={`pixel-avatar ${className}`} style={{ background: bg }}>
      <div className="pixel-grid" style={{ gridTemplateColumns: `repeat(${grid[0].length}, 1fr)` }}>
        {grid.flatMap((row, y) =>
          row.map((cell, x) => (
            <div
              key={`${x}-${y}`}
              style={{
                background: cell ? fg : "transparent",
                boxShadow: cell ? `0 0 6px ${glow}55` : "none",
              }}
            />
          ))
        )}
      </div>
      <span className="pixel-id">#{nft.id}</span>
    </div>
  );
}

// live NFT image with a clean fallback: if this token has a real image URL
// from Alchemy, render it; if that URL fails to load (dead IPFS gateway,
// broken CDN, etc.) or no image URL came back at all, fall back to the
// deterministic pixel identicon — the token's real id/traits/rank still
// render either way, nothing here falls back to seeded mock data.
function NFTThumb({ nft }) {
  const [failed, setFailed] = useState(false);
  if (nft.image && !failed) {
    return (
      <img
        src={nft.image}
        alt={`Origin Punk #${nft.id}`}
        loading="lazy"
        style={{ width: "100%", borderRadius: 10, aspectRatio: 1, objectFit: "cover", background: "#0E0F13", display: "block" }}
        onError={() => {
          console.warn(`[NFT image] failed to load for token #${nft.id}: ${nft.image} — falling back to pixel identicon`);
          setFailed(true);
        }}
      />
    );
  }
  return <PixelAvatar nft={nft} />;
}

// wallet tiles shown even when not (yet) detected as an installed
// extension — tapping these routes through WalletConnect or the Coinbase
// SDK, which handle the mobile-app / QR flow on their own
const WC_QUICK_WALLETS = [
  { name: "WalletConnect", deeplinkKey: null, icon: "wc" },
  { name: "Rainbow", deeplinkKey: "rainbow", icon: "rainbow" },
  { name: "Trust Wallet", deeplinkKey: "trust", icon: "trust" },
  { name: "OKX Wallet", deeplinkKey: "okx", icon: "okx" },
  { name: "TokenPocket", deeplinkKey: "tokenpocket", icon: "tokenpocket" },
  { name: "Bitget Wallet", deeplinkKey: "bitget", icon: "bitget" },
  { name: "Safe", deeplinkKey: "safe", icon: "safe" },
];

function WalletTileIcon({ kind, size = 48 }) {
  // simple flat glyphs so every tile has a recognizable mark without
  // depending on external logo assets/CDNs
  const common = { width: size, height: size, borderRadius: size * 0.28, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: size * 0.4, color: "#fff" };
  const palette = {
    wc: { background: "#3396FF", label: "W" },
    rainbow: { background: "linear-gradient(135deg,#FF5A76,#FFC122,#00E0C6,#5A9BFF)", label: "R" },
    coinbase: { background: "#0052FF", label: "C" },
    metamask: { background: "#fff", label: "🦊" },
    trust: { background: "#3375BB", label: "T" },
    okx: { background: "#000", label: "OK" },
    tokenpocket: { background: "#2980FE", label: "TP" },
    bitget: { background: "#00F0FF", label: "B" },
    safe: { background: "#12FF80", label: "S" },
    injected: { background: "#5b6272", label: "🔌" },
  };
  const p = palette[kind] || palette.injected;
  return <div style={{ ...common, background: p.background }}>{p.label}</div>;
}

function WalletTile({ label, iconKind, iconSrc, recent, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 8, background: "none", border: "none",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, padding: 6, width: 84,
    }}>
      {iconSrc ? (
        <img src={iconSrc} alt="" width={48} height={48} style={{ borderRadius: 12, border: "1px solid #eceef2" }} />
      ) : (
        <WalletTileIcon kind={iconKind} />
      )}
      <span style={{ fontSize: 12, fontWeight: 600, color: "#1a1d24", textAlign: "center", lineHeight: 1.2 }}>{label}</span>
      {recent && <span style={{ fontSize: 10.5, color: "#3396FF", fontWeight: 700, marginTop: -4 }}>Recent</span>}
    </button>
  );
}

function WalletConnectModal({ onClose, discoveredWallets, onConnect, busy, wcUri }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const lastWallet = typeof localStorage !== "undefined" ? localStorage.getItem("op:lastWallet") : null;

  useEffect(() => {
    if (!wcUri) { setQrDataUrl(null); return; }
    QRCode.toDataURL(wcUri, { margin: 1, width: 260, color: { dark: "#0d0e12", light: "#ffffff" } })
      .then(setQrDataUrl)
      .catch((err) => console.error("[WalletConnect] failed to render QR", err));
  }, [wcUri]);

  // known EIP-6963 rdns → our icon key, so a detected MetaMask/Coinbase/etc
  // extension gets the right glyph instead of the generic plug icon
  const rdnsIconKind = (rdns = "") => {
    if (rdns.includes("metamask")) return "metamask";
    if (rdns.includes("coinbase")) return "coinbase";
    if (rdns.includes("rainbow")) return "rainbow";
    if (rdns.includes("trust")) return "trust";
    if (rdns.includes("okx")) return "okx";
    if (rdns.includes("bitget") || rdns.includes("bitkeep")) return "bitget";
    if (rdns.includes("tokenpocket")) return "tokenpocket";
    if (rdns.includes("rabby")) return "injected";
    return "injected";
  };

  // de-dupe: if MetaMask/Coinbase/etc is already detected as an installed
  // extension, don't also show its generic WalletConnect quick-tile
  const detectedNames = new Set(discoveredWallets.map((w) => w.info.name.toLowerCase()));
  const quickWallets = WC_QUICK_WALLETS.filter((q) => !detectedNames.has(q.name.toLowerCase()));

  const allTiles = [
    ...discoveredWallets.map((w) => ({
      label: w.info.name, iconSrc: w.info.icon, key: `injected-${w.info.uuid}`,
      onClick: () => onConnect("injected", { uuid: w.info.uuid, name: w.info.name }),
    })),
    { label: "Coinbase Wallet", iconKind: "coinbase", key: "coinbase", onClick: () => onConnect("coinbase", { name: "Coinbase Wallet" }) },
    ...quickWallets.map((q) => ({
      label: q.name, iconKind: q.icon, key: `wc-${q.name}`,
      onClick: () => onConnect("walletconnect", { name: q.name, deeplinkKey: q.deeplinkKey }),
    })),
  ];
  // "recent" = whatever was used last time, bubbled to the front
  allTiles.sort((a, b) => (b.label.toLowerCase() === lastWallet?.toLowerCase() ? 1 : 0) - (a.label.toLowerCase() === lastWallet?.toLowerCase() ? 1 : 0));

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4,5,7,0.6)", backdropFilter: "blur(4px)", zIndex: 80, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <motion.div onClick={(e) => e.stopPropagation()} initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
        style={{ background: "#fff", color: "#1a1d24", width: "100%", maxWidth: 440, borderRadius: "20px 20px 0 0", padding: "22px 20px 28px", maxHeight: "86vh", overflowY: "auto" }}
        className="wc-modal-sheet">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <h2 style={{ fontSize: 19, fontWeight: 800, margin: 0 }}>{wcUri ? "Scan with your wallet" : "Connect a Wallet"}</h2>
          <button onClick={onClose} style={{ background: "#f1f2f5", border: "none", borderRadius: 999, width: 32, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X size={16} color="#1a1d24" />
          </button>
        </div>

        {wcUri ? (
          <div style={{ textAlign: "center" }}>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="WalletConnect QR code" style={{ width: 240, height: 240, borderRadius: 16, border: "1px solid #eceef2" }} />
            ) : (
              <div style={{ width: 240, height: 240, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Loader2 className="spin" size={28} color="#3396FF" />
              </div>
            )}
            <p style={{ fontSize: 12.5, color: "#6b7280", marginTop: 14 }}>Open your wallet app and scan this code, or use its in-app browser's WalletConnect option.</p>
            <button onClick={() => { navigator.clipboard?.writeText(wcUri); }} className="wc-link-btn" style={{ marginTop: 10 }}>Copy connection link</button>
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 6 }}>
              {allTiles.slice(0, 4).map((t) => (
                <WalletTile key={t.key} label={t.label} iconKind={t.iconKind} iconSrc={t.iconSrc} disabled={busy}
                  recent={t.label.toLowerCase() === lastWallet?.toLowerCase()} onClick={t.onClick} />
              ))}
            </div>
            {allTiles.length > 4 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 4 }}>
                {allTiles.slice(4).map((t) => (
                  <WalletTile key={t.key} label={t.label} iconKind={t.iconKind} iconSrc={t.iconSrc} disabled={busy} onClick={t.onClick} />
                ))}
              </div>
            )}

            <div style={{ borderTop: "1px solid #eceef2", margin: "20px 0 16px" }} />

            <h3 style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>What is a Wallet?</h3>
            <p style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5, marginBottom: 18 }}>
              A wallet is used to send, receive, store, and display digital assets. It's also a new way to log in,
              without needing to create new accounts and passwords on every website.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <a href="https://ethereum.org/wallets/find-wallet/" target="_blank" rel="noreferrer" className="wc-link-btn" style={{ flex: 1, textAlign: "center" }}>Get a Wallet</a>
              <a href="https://ethereum.org/wallets/" target="_blank" rel="noreferrer" className="wc-link-btn" style={{ flex: 1, textAlign: "center" }}>Learn More</a>
            </div>
          </>
        )}
      </motion.div>
      <style>{`
        .wc-link-btn { display:inline-block; padding:10px 18px; border-radius:999px; border:1px solid #dfe2e8; color:#1a1d24; font-size:13px; font-weight:700; text-decoration:none; background:#fff; cursor:pointer; }
        .wc-link-btn:hover { border-color:#3396FF; color:#3396FF; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (min-width:640px){ .wc-modal-sheet{ border-radius:20px !important; margin-bottom:20px; } }
      `}</style>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------
const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmt2 = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function durationSince(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------
export default function OriginPunkApp() {
  // ---- live collection data (Alchemy NFT API, Robinhood Chain) ----
  const [collectionRaw, setCollectionRaw] = useState([]); // mapped, unscored
  const [collectionMeta, setCollectionMeta] = useState(null); // getContractMetadata result
  const [collectionLoading, setCollectionLoading] = useState(true);
  const [collectionError, setCollectionError] = useState(null);
  const [pageKey, setPageKey] = useState(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const collection = useMemo(() => scoreRaritySample(collectionRaw), [collectionRaw]);

  // pageKey is also mirrored into a ref so loadMoreNfts always reads the
  // *latest* key even if it's called again before a re-render has flushed
  // the new pageKey into state (fast/rapid scroll events) — without this a
  // second scroll-triggered call can fire with a stale/undefined pageKey
  // and either re-request page 1 or skip a page.
  const pageKeyRef = useRef(undefined);
  const loadingMoreRef = useRef(false);
  const [loadReloadToken, setLoadReloadToken] = useState(0); // bump to retry the initial load

  const loadMoreNfts = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const keyUsed = pageKeyRef.current;
    console.log(`[Collection] loading next page (pageKey=${keyUsed ?? "<none>"})`);
    try {
      const data = await fetchNFTsForContract(COLLECTION_ADDRESS, keyUsed);
      const mapped = (data.nfts || []).map(mapAlchemyNft);
      console.log(`[Collection] page loaded: ${mapped.length} NFTs, nextPageKey=${data.pageKey ?? "<none>"}`);
      setCollectionRaw((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...mapped.filter((n) => !seen.has(n.id))];
      });
      pageKeyRef.current = data.pageKey || undefined;
      setPageKey(data.pageKey || undefined);
      setHasMore(Boolean(data.pageKey));
    } catch (err) {
      console.error("[Collection] failed to load next page from Alchemy", err);
      setCollectionError(err.message || "Failed to load NFTs from Alchemy");
      setHasMore(false);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCollectionLoading(true);
      setCollectionError(null);
      pageKeyRef.current = undefined;
      setPageKey(undefined);
      setHasMore(true);
      console.log(`[Collection] initial load for contract ${COLLECTION_ADDRESS} on Robinhood Chain`);
      try {
        const [meta, first] = await Promise.all([
          fetchContractMetadata(COLLECTION_ADDRESS).catch((err) => {
            console.error("[Collection] getContractMetadata failed (non-fatal — collection stats will show as unavailable)", err);
            return null;
          }),
          fetchNFTsForContract(COLLECTION_ADDRESS, undefined),
        ]);
        if (cancelled) return;
        setCollectionMeta(meta);
        const mapped = (first.nfts || []).map(mapAlchemyNft);
        console.log(`[Collection] initial page loaded: ${mapped.length} NFTs, nextPageKey=${first.pageKey ?? "<none>"}`);
        setCollectionRaw(mapped);
        pageKeyRef.current = first.pageKey || undefined;
        setPageKey(first.pageKey || undefined);
        setHasMore(Boolean(first.pageKey));
      } catch (err) {
        // Deliberately no fallback to seeded/mock data here: if Alchemy
        // can't be reached, the gallery stays empty and the error banner
        // below reports exactly what failed, rather than quietly
        // substituting fake NFTs that would look real to the user.
        console.error(`[Collection] initial load from Alchemy failed for ${COLLECTION_ADDRESS}`, err);
        if (!cancelled) {
          setCollectionError(err.message || "Failed to reach Alchemy");
          setCollectionRaw([]);
          setHasMore(false);
        }
      } finally {
        if (!cancelled) setCollectionLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadReloadToken]);

  const retryCollectionLoad = useCallback(() => setLoadReloadToken((t) => t + 1), []);

  const loading = collectionLoading; // gallery skeleton keys off the real fetch now

  const [view, setView] = useState("home");
  const [now, setNow] = useState(Date.now());

  // wallet
  const [wallet, setWallet] = useState(null); // {address, provider, signature}
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [ownedIds, setOwnedIds] = useState([]);
  const [walletBusy, setWalletBusy] = useState(false);

  // staking: tokenId -> {start, lastClaim} — client-side game mechanic;
  // there's no deployed staking contract for this collection, so this
  // stays local rather than pretending to write on-chain
  const [stakes, setStakes] = useState({});
  const [claimedTotal, setClaimedTotal] = useState(0);
  const [claimEvents, setClaimEvents] = useState([]); // {amount, ts}

  const [selected, setSelected] = useState(null); // token detail modal
  const [toast, setToast] = useState(null);

  const [liveSales, setLiveSales] = useState([]);
  const [salesPaused, setSalesPaused] = useState(false);

  // gallery filter/sort/search/pagination
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("newest");
  const [typeFilter, setTypeFilter] = useState([]);
  const [genderFilter, setGenderFilter] = useState([]);
  const [visibleCount, setVisibleCount] = useState(15);
  const scrollRef = useRef(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);

  // simulated activity feed — there's no live sales websocket/indexer wired
  // up here, so this stays a local simulation drawn from the loaded sample,
  // labeled as such in the UI (real per-token sale history is fetched from
  // OpenSea on demand when a token's modal is opened)
  useEffect(() => {
    if (salesPaused || collection.length === 0) return;
    const i = setInterval(() => {
      const nft = pick(collection);
      const buyer = pick(MOCK_WALLETS), seller = pick(MOCK_WALLETS);
      const sale = {
        id: `${Date.now()}-${nft.id}`, tokenId: nft.id, nft, buyer, seller,
        price: +(0.35 + rand() * 3.2).toFixed(2),
        marketplace: pick(["OpenSea", "Blur", "OpenSea", "LooksRare"]),
        ts: Date.now(),
      };
      setLiveSales((prev) => [sale, ...prev].slice(0, 10));
    }, 7000 + rand() * 4000);
    return () => clearInterval(i);
  }, [salesPaused, collection]);

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 2600); return () => clearTimeout(t); }
  }, [toast]);

  const [wcUri, setWcUri] = useState(null); // set while a WalletConnect pairing is awaiting approval
  const discoveredWallets = useDiscoveredWallets();

  // shared tail-end of every connect path: sign a message to prove control
  // of the address, then load real owned tokens for it
  const finishConnect = async (address, ethProvider, providerLabel) => {
    const nonce = Math.floor(Math.random() * 1e9);
    const message = `Sign in to 404 Origin Punk\n\nAddress: ${address}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
    const hexMessage = "0x" + Array.from(new TextEncoder().encode(message)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const signature = await ethProvider.request({ method: "personal_sign", params: [hexMessage, address] });

    setWallet({ address, provider: providerLabel, signature, ethProvider });
    localStorage.setItem("op:lastWallet", providerLabel);
    setWalletMenuOpen(false);
    setWcUri(null);
    setToast(`Connected via ${providerLabel} — ${short(address)} (signature verified)`);

    try {
      const owned = await fetchNFTsForOwner(address, COLLECTION_ADDRESS);
      const ids = (owned.ownedNfts || []).map((n) => Number(n.tokenId));
      setOwnedIds(ids);
      const missing = (owned.ownedNfts || [])
        .filter((n) => !collectionRaw.some((c) => c.id === Number(n.tokenId)))
        .map(mapAlchemyNft);
      if (missing.length) setCollectionRaw((prev) => [...prev, ...missing]);
    } catch (err) {
      setToast(`Connected, but couldn't read owned tokens from Alchemy (${err.message})`);
    }
  };

  // providerKind: "injected" (EIP-6963 uuid) | "walletconnect" | "coinbase"
  const connectWallet = async (providerKind, meta) => {
    setWalletBusy(true);
    try {
      if (providerKind === "injected") {
        const found = discoveredWallets.find((w) => w.info.uuid === meta.uuid);
        if (!found) throw new Error("Wallet no longer detected — try refreshing.");
        const { address } = await connectWithProvider(found.provider, meta.name);
        await finishConnect(address, found.provider, meta.name);
      } else if (providerKind === "coinbase") {
        const provider = getCoinbaseProvider();
        const { address } = await connectCoinbase();
        await finishConnect(address, provider, "Coinbase Wallet");
      } else if (providerKind === "walletconnect") {
        const uri = await new Promise((resolve) => {
          connectWalletConnect((uri) => {
            resolve(uri);
            // on mobile, jump straight to the target wallet app with the
            // pending session instead of making the user scan a QR of their
            // own screen; on desktop we render the QR below
            if (isMobileDevice()) {
              const link = WC_MOBILE_DEEPLINKS[meta.deeplinkKey]?.(uri);
              if (link) window.location.href = link;
            }
          }).then(({ address, ethProvider }) => {
            finishConnect(address, ethProvider, meta.name).catch((err) =>
              setToast(`Wallet connect failed: ${err.message || err}`)
            );
          }).catch((err) => {
            setWcUri(null);
            setToast(err.message === "NO_ACCOUNT" ? "No account returned by wallet." : `Wallet connect failed: ${err.message || err}`);
          }).finally(() => setWalletBusy(false));
        });
        setWcUri(uri);
        return; // resolves asynchronously above once the wallet approves
      }
    } catch (err) {
      if (err.code === 4001) {
        setToast("Connection request rejected in wallet.");
      } else {
        setToast(`Wallet connect failed: ${err.message || err}`);
      }
    } finally {
      if (providerKind !== "walletconnect") setWalletBusy(false);
    }
  };
  const disconnectWallet = () => {
    if (wallet?.provider && wcProviderPromise) {
      getWalletConnectProvider().then((p) => p.disconnect?.()).catch(() => {});
    }
    setWallet(null); setOwnedIds([]); setStakes({}); setClaimedTotal(0); setClaimEvents([]);
    setToast("Wallet disconnected");
  };

  const pendingXP = useCallback((tokenId) => {
    const s = stakes[tokenId]; if (!s) return 0;
    const nft = collection.find((n) => n.id === tokenId);
    const elapsedDays = (now - s.lastClaim) / 86400000;
    return elapsedDays * nft.xpPerDay;
  }, [stakes, now, collection]);

  const totalPendingXP = useMemo(
    () => Object.keys(stakes).reduce((acc, id) => acc + pendingXP(Number(id)), 0),
    [stakes, pendingXP]
  );

  const stakeToken = (id) => {
    setStakes((s) => ({ ...s, [id]: { start: Date.now(), lastClaim: Date.now() } }));
    setToast(`Token #${id} staked`);
  };
  const unstakeToken = (id) => {
    const owed = pendingXP(id);
    setClaimedTotal((c) => c + owed);
    if (owed > 0) setClaimEvents((e) => [...e, { amount: owed, ts: Date.now() }]);
    setStakes((s) => { const n = { ...s }; delete n[id]; return n; });
    setToast(`Token #${id} unstaked${owed > 0 ? ` · +${fmt2(owed)} XP claimed` : ""}`);
  };
  const claimToken = (id) => {
    const owed = pendingXP(id);
    if (owed <= 0) return;
    setClaimedTotal((c) => c + owed);
    setClaimEvents((e) => [...e, { amount: owed, ts: Date.now() }]);
    setStakes((s) => ({ ...s, [id]: { ...s[id], lastClaim: Date.now() } }));
    setToast(`Claimed ${fmt2(owed)} XP from #${id}`);
  };
  const claimAll = () => {
    const owed = totalPendingXP;
    if (owed <= 0) return;
    setClaimedTotal((c) => c + owed);
    setClaimEvents((e) => [...e, { amount: owed, ts: Date.now() }]);
    setStakes((s) => {
      const n = {}; Object.keys(s).forEach((id) => { n[id] = { ...s[id], lastClaim: Date.now() }; }); return n;
    });
    setToast(`Claimed ${fmt2(owed)} XP total`);
  };

  const xpToday = useMemo(() => claimEvents.filter((e) => now - e.ts < 86400000).reduce((a, e) => a + e.amount, 0) + 0, [claimEvents, now]);
  const xpWeek = useMemo(() => claimEvents.filter((e) => now - e.ts < 7 * 86400000).reduce((a, e) => a + e.amount, 0), [claimEvents, now]);
  const xpMonth = useMemo(() => claimEvents.filter((e) => now - e.ts < 30 * 86400000).reduce((a, e) => a + e.amount, 0), [claimEvents, now]);

  // ---- gallery filtering ----
  const filtered = useMemo(() => {
    let list = collection;
    if (search.trim()) list = list.filter((n) => String(n.id).includes(search.trim()));
    if (typeFilter.length) list = list.filter((n) => typeFilter.includes(n.type));
    if (genderFilter.length) list = list.filter((n) => genderFilter.includes(n.gender));
    const sorted = [...list];
    if (sortBy === "newest") sorted.sort((a, b) => b.id - a.id);
    if (sortBy === "oldest") sorted.sort((a, b) => a.id - b.id);
    if (sortBy === "priceHigh") sorted.sort((a, b) => (b.lastSalePrice ?? -1) - (a.lastSalePrice ?? -1));
    if (sortBy === "priceLow") sorted.sort((a, b) => (a.lastSalePrice ?? Infinity) - (b.lastSalePrice ?? Infinity));
    if (sortBy === "xpHigh") sorted.sort((a, b) => b.xpPerDay - a.xpPerDay);
    if (sortBy === "rarest") sorted.sort((a, b) => a.rank - b.rank);
    return sorted;
  }, [collection, search, typeFilter, genderFilter, sortBy]);

  const visible = filtered.slice(0, visibleCount);
  const onGalleryScroll = () => {
    const el = scrollRef.current; if (!el) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) {
      setVisibleCount((v) => Math.min(v + 15, filtered.length));
      // once we've shown everything currently loaded, pull the next real page from Alchemy
      if (visibleCount >= filtered.length && hasMore) loadMoreNfts();
    }
  };
  useEffect(() => { setVisibleCount(15); }, [search, typeFilter, genderFilter, sortBy]);

  const myTokens = collection.filter((n) => ownedIds.includes(n.id));

  // ---- leaderboard mock aggregates ----
  const leaderboardHolders = useMemo(() => {
    const map = {};
    MOCK_WALLETS.forEach((w) => { map[w] = Math.floor(rand() * 40000) + 500; });
    let list = Object.entries(map).map(([addr, xp]) => ({ addr, xp }));
    if (wallet) list.push({ addr: wallet.address, xp: claimedTotal, isYou: true });
    return list.sort((a, b) => b.xp - a.xp).slice(0, 10);
  }, [wallet, claimedTotal]);

  const leaderboardStakers = useMemo(() => {
    const map = {};
    MOCK_WALLETS.forEach((w) => { map[w] = Math.floor(rand() * 40) + 1; });
    let list = Object.entries(map).map(([addr, count]) => ({ addr, count }));
    if (wallet) list.push({ addr: wallet.address, count: Object.keys(stakes).length, isYou: true });
    return list.sort((a, b) => b.count - a.count).slice(0, 10);
  }, [wallet, stakes]);

  const rarest = useMemo(() => [...collection].sort((a, b) => a.rank - b.rank).slice(0, 10), [collection]);

  const largestCollections = useMemo(() => {
    const counts = {};
    collection.forEach((n) => { if (n.owner) counts[n.owner] = (counts[n.owner] || 0) + 1; });
    return Object.entries(counts).map(([addr, count]) => ({ addr, count })).sort((a, b) => b.count - a.count).slice(0, 10);
  }, [collection]);

  // Alchemy's getContractMetadata (via its bundled OpenSea metadata) is the
  // only live source this app has for collection-level stats — it covers
  // floor price and total supply. There's no connected source for
  // owners/listed/volume/best-offer/sales counts (that needs an indexer or
  // the OpenSea collection-stats endpoint, which isn't wired up here), so
  // those stay null and render as "—" rather than hardcoded placeholder
  // numbers that would look live but aren't.
  const stats = useMemo(() => {
    const realFloor = collectionMeta?.openSeaMetadata?.floorPrice ?? collectionMeta?.contract?.openSeaMetadata?.floorPrice;
    const realSupply = collectionMeta?.contract?.totalSupply ?? collectionMeta?.totalSupply;
    console.log("[Collection] stats derived from getContractMetadata:", { realFloor, realSupply, collectionMeta });
    return {
      floor: realFloor != null ? Number(realFloor) : null,
      totalItems: realSupply ? Number(realSupply) : null,
      bestOffer: null, volume: null, salesToday: null, salesWeek: null,
      owners: null, listed: null, avgPrice: null, highSale: null, lowSale: null,
      floorIsReal: realFloor != null, totalItemsIsReal: Boolean(realSupply),
    };
  }, [collectionMeta]);

  const NAV = [
    { id: "home", label: "Home", icon: HomeIcon },
    { id: "gallery", label: "Gallery", icon: LayoutGrid },
    { id: "collection", label: "My Collection", icon: Layers },
    { id: "dashboard", label: "Dashboard", icon: TrendingUp },
    { id: "leaderboard", label: "Leaderboard", icon: Trophy },
  ];

  return (
    <div className="op-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Press+Start+2P&display=swap');

        .op-root {
          --void:#08090B; --panel:#12141A; --panel2:#171a21; --line:#242833;
          --cyan:#2BFBEB; --lime:#D4FF00; --lime-dim:#a8cc00; --magenta:#FF2E9A; --amber:#FFB020;
          --fog:#8993A6; --bone:#EDEFF3;
          background:var(--void); color:var(--bone);
          font-family:'Inter',sans-serif;
          min-height:100vh; position:relative; overflow-x:hidden;
          -webkit-tap-highlight-color: transparent; /* kills the default translucent tap flash on mobile Chrome */
        }
        .op-root * { -webkit-tap-highlight-color: transparent; }
        .op-root ::selection { background: var(--lime); color:#101400; }
        .op-root :focus-visible { outline: 2px solid var(--lime); outline-offset: 2px; }
        .op-root button, .op-root a, .op-root input, .op-root select { -webkit-tap-highlight-color: transparent; }
        .op-root .disp { font-family:'Space Grotesk',sans-serif; }
        .op-root .mono { font-family:'JetBrains Mono',monospace; }
        .op-root .pixel { font-family:'Press Start 2P',monospace; }
        .op-root ::-webkit-scrollbar{width:8px;height:8px;}
        .op-root ::-webkit-scrollbar-thumb{background:#2a2e39;border-radius:4px;}

        .noise-bg {
          position:fixed; inset:0; pointer-events:none; z-index:0; opacity:0.5;
          background-image:
            radial-gradient(circle at 15% 20%, rgba(43,251,235,0.08), transparent 40%),
            radial-gradient(circle at 85% 75%, rgba(212,255,0,0.07), transparent 40%),
            linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px);
          background-size:auto, auto, 28px 28px, 28px 28px;
        }

        .glass {
          background:rgba(23,26,33,0.55);
          border:1px solid var(--line);
          backdrop-filter:blur(14px);
          -webkit-backdrop-filter:blur(14px);
        }
        .glow-cyan { box-shadow:0 0 0 1px rgba(43,251,235,0.25), 0 0 24px rgba(43,251,235,0.10); }
        .glow-lime { box-shadow:0 0 0 1px rgba(212,255,0,0.25), 0 0 24px rgba(212,255,0,0.10); }

        .btn-primary {
          background:linear-gradient(120deg, var(--lime), #e8ff66);
          color:#141a00; font-weight:700; border:none; cursor:pointer;
          transition:transform .15s ease, box-shadow .15s ease;
        }
        .btn-primary:hover { transform:translateY(-1px); box-shadow:0 6px 22px rgba(212,255,0,0.3); }
        .btn-primary:active { transform:translateY(0); }
        .btn-primary:disabled { opacity:0.4; cursor:not-allowed; transform:none; box-shadow:none; }

        .btn-ghost {
          background:transparent; border:1px solid var(--line); color:var(--bone);
          transition:border-color .15s ease, background .15s ease;
        }
        .btn-ghost:hover { border-color:var(--lime); background:rgba(212,255,0,0.06); }

        .btn-lime {
          background:linear-gradient(120deg, var(--lime), #e4ff9a);
          color:#1a2b06; font-weight:700; border:none; cursor:pointer;
          transition:transform .15s ease, box-shadow .15s ease;
        }
        .btn-lime:hover { transform:translateY(-1px); box-shadow:0 6px 20px rgba(212,255,0,0.25); }
        .btn-lime:disabled { opacity:0.35; cursor:not-allowed; transform:none; box-shadow:none; }

        .nft-card { transition:transform .2s ease, box-shadow .2s ease, border-color .2s ease; cursor:pointer; }
        .nft-card:hover { transform:translateY(-4px); border-color:var(--lime); box-shadow:0 12px 30px rgba(0,0,0,0.4), 0 0 20px rgba(212,255,0,0.14); }

        .pixel-avatar { position:relative; aspect-ratio:1; width:100%; border-radius:10px; overflow:hidden; }
        .pixel-grid { position:absolute; inset:8%; display:grid; grid-template-rows:repeat(6,1fr); gap:2px; }
        .pixel-id { position:absolute; bottom:6px; right:8px; font-family:'JetBrains Mono',monospace; font-size:10px; color:rgba(255,255,255,0.55); }

        .tag { font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:0.04em; padding:3px 8px; border-radius:999px; border:1px solid var(--line); }

        .ticker-track { display:flex; gap:2.5rem; white-space:nowrap; animation:ticker 26s linear infinite; }
        .ticker-wrap:hover .ticker-track { animation-play-state:paused; }
        @keyframes ticker { from{transform:translateX(0);} to{transform:translateX(-50%);} }

        @keyframes pulseDot { 0%,100%{opacity:1;} 50%{opacity:0.3;} }
        .live-dot { animation:pulseDot 1.4s ease-in-out infinite; }

        .skeleton { background:linear-gradient(90deg, #171a21 25%, #1d212a 37%, #171a21 63%); background-size:400% 100%; animation:shimmer 1.4s ease infinite; }
        @keyframes shimmer { 0%{background-position:100% 0;} 100%{background-position:0 0;} }

        .scrollbar-thin::-webkit-scrollbar{width:6px;}

        input[type=text]::placeholder { color:#5b6272; }
        .checkbox-row { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
      `}</style>

      <div className="noise-bg" />

      {/* ================= TOP NAV ================= */}
      <header className="glass" style={{ position: "sticky", top: 0, zIndex: 40, borderLeft: "none", borderRight: "none", borderTop: "none" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setView("home")}>
            <div className="pixel" style={{ fontSize: 10, color: "#05201d", background: "linear-gradient(120deg,var(--cyan),var(--lime))", padding: "8px 6px", borderRadius: 6, lineHeight: 1 }}>404</div>
            <div className="disp" style={{ fontWeight: 700, fontSize: 18, letterSpacing: "0.02em" }}>ORIGIN <span style={{ color: "var(--lime)" }}>PUNK</span></div>
          </div>

          <nav style={{ display: "none", gap: 4 }} className="md-flex">
            {NAV.map((n) => (
              <button key={n.id} onClick={() => setView(n.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                  background: view === n.id ? "rgba(212,255,0,0.10)" : "transparent",
                  color: view === n.id ? "var(--lime)" : "var(--fog)", fontSize: 13.5, fontWeight: 600,
                }}>
                <n.icon size={15} /> {n.label}
              </button>
            ))}
          </nav>

          <div style={{ position: "relative" }}>
            {wallet ? (
              <button onClick={() => setAccountMenuOpen((o) => !o)} className="btn-ghost mono"
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 10, fontSize: 12.5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--lime)" }} className="live-dot" />
                {short(wallet.address)} <ChevronDown size={14} />
              </button>
            ) : (
              <button onClick={() => setWalletMenuOpen(true)} className="btn-primary" style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 10, fontSize: 13.5 }}>
                <Wallet size={15} /> Connect Wallet
              </button>
            )}
            <AnimatePresence>
              {wallet && accountMenuOpen && (
                <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                  className="glass" style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 240, borderRadius: 12, padding: 8, zIndex: 50 }}>
                  <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--fog)" }}>Connected via {wallet.provider}</div>
                  <button onClick={() => { navigator.clipboard?.writeText(wallet.address); setToast("Address copied"); }} className="btn-ghost" style={{ width: "100%", textAlign: "left", padding: "9px 10px", borderRadius: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 8, border: "none" }}>
                    <Copy size={14} /> Copy address
                  </button>
                  <button onClick={() => { disconnectWallet(); setAccountMenuOpen(false); }} className="btn-ghost" style={{ width: "100%", textAlign: "left", padding: "9px 10px", borderRadius: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 8, border: "none", color: "var(--magenta)" }}>
                    <X size={14} /> Disconnect
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {walletMenuOpen && !wallet && (
          <WalletConnectModal
            onClose={() => { setWalletMenuOpen(false); setWcUri(null); }}
            discoveredWallets={discoveredWallets}
            onConnect={connectWallet}
            busy={walletBusy}
            wcUri={wcUri}
          />
        )}
      </AnimatePresence>

      {/* live-data notice */}
      <div style={{ background: "rgba(255,176,32,0.08)", borderBottom: "1px solid rgba(255,176,32,0.2)", color: "#ffcf7a", fontSize: 11.5, textAlign: "center", padding: "6px 12px", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
        {collectionError
          ? (
            <>
              <span>Couldn't reach Alchemy for <span className="mono">{short(COLLECTION_ADDRESS)}</span>: {collectionError}</span>
              <button onClick={retryCollectionLoad} className="btn-ghost" style={{ padding: "2px 10px", borderRadius: 999, fontSize: 11, color: "#ffcf7a", borderColor: "rgba(255,176,32,0.35)" }}>Retry</button>
            </>
          )
          : <>Live reads: NFT metadata + ownership from Alchemy, sale history from OpenSea, wallet connect via real signature. Staking/XP and the activity ticker stay a local game mechanic — there's no deployed staking contract or sales indexer behind them.</>}
      </div>

      <main style={{ maxWidth: 1280, margin: "0 auto", padding: "0 20px 100px", position: "relative", zIndex: 1 }}>
        {view === "home" && (
          <HomeView stats={stats} liveSales={liveSales} salesPaused={salesPaused} setSalesPaused={setSalesPaused} setView={setView} />
        )}
        {view === "gallery" && (
          <GalleryView
            loading={loading} visible={visible} filtered={filtered} collection={collection} search={search} setSearch={setSearch}
            sortBy={sortBy} setSortBy={setSortBy} typeFilter={typeFilter} setTypeFilter={setTypeFilter}
            genderFilter={genderFilter} setGenderFilter={setGenderFilter} scrollRef={scrollRef}
            onGalleryScroll={onGalleryScroll} setSelected={setSelected} filtersOpen={filtersOpen} setFiltersOpen={setFiltersOpen}
            collectionError={collectionError} onRetry={retryCollectionLoad}
          />
        )}
        {view === "collection" && (
          <CollectionView
            wallet={wallet} myTokens={myTokens} stakes={stakes} pendingXP={pendingXP}
            stakeToken={stakeToken} unstakeToken={unstakeToken} claimToken={claimToken} claimAll={claimAll}
            totalPendingXP={totalPendingXP} claimedTotal={claimedTotal} setSelected={setSelected}
            setWalletMenuOpen={setWalletMenuOpen}
          />
        )}
        {view === "dashboard" && (
          <DashboardView
            wallet={wallet} stakes={stakes} claimedTotal={claimedTotal} totalPendingXP={totalPendingXP}
            xpToday={xpToday} xpWeek={xpWeek} xpMonth={xpMonth} myTokens={myTokens} rarest={rarest}
          />
        )}
        {view === "leaderboard" && (
          <LeaderboardView holders={leaderboardHolders} stakers={leaderboardStakers} rarest={rarest} largest={largestCollections} wallet={wallet} />
        )}
      </main>

      {/* ================= NFT DETAIL MODAL ================= */}
      <AnimatePresence>
        {selected && (
          <NFTModal
            nft={selected} onClose={() => setSelected(null)} isOwned={ownedIds.includes(selected.id)}
            isStaked={!!stakes[selected.id]} pendingXP={pendingXP(selected.id)} stakes={stakes}
            onStake={() => stakeToken(selected.id)} onUnstake={() => unstakeToken(selected.id)} onClaim={() => claimToken(selected.id)}
            sampleSize={collection.length} collectionMeta={collectionMeta}
          />
        )}
      </AnimatePresence>

      {/* ================= TOAST ================= */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
            className="glass mono" style={{ position: "fixed", bottom: 84, left: "50%", transform: "translateX(-50%)", padding: "10px 18px", borderRadius: 999, fontSize: 12.5, zIndex: 60, color: "var(--bone)", display: "flex", alignItems: "center", gap: 8 }}>
            <Check size={14} color="var(--lime)" /> {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ================= MOBILE BOTTOM NAV ================= */}
      <nav className="glass mobile-nav" style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 45, display: "flex", justifyContent: "space-around", padding: "8px 4px", borderLeft: "none", borderRight: "none", borderBottom: "none" }}>
        {NAV.map((n) => (
          <button key={n.id} onClick={() => setView(n.id)} style={{ background: "none", border: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "4px 8px", color: view === n.id ? "var(--lime)" : "var(--fog)" }}>
            <n.icon size={19} />
            <span style={{ fontSize: 9.5, fontWeight: 600 }}>{n.label.split(" ")[0]}</span>
          </button>
        ))}
      </nav>

      <style>{`
        @media (min-width:768px){ .md-flex{ display:flex !important; } .mobile-nav{ display:none !important; } }
      `}</style>
    </div>
  );
}

// ===========================================================================
// HOME
// ===========================================================================
function HomeView({ stats, liveSales, salesPaused, setSalesPaused, setView }) {
  const ethVal = (v) => (v != null ? `${v} ETH` : "—");
  const countVal = (v) => (v != null ? fmt(v) : "—");
  const tickerItems = [
    { label: "FLOOR", value: ethVal(stats.floor) },
    { label: "VOLUME", value: ethVal(stats.volume) },
    { label: "OWNERS", value: countVal(stats.owners) },
    { label: "LISTED", value: countVal(stats.listed) },
    { label: "SALES 24H", value: stats.salesToday ?? "—" },
    { label: "BEST OFFER", value: ethVal(stats.bestOffer) },
  ];
  return (
    <div>
      {/* HERO */}
      <section style={{ padding: "56px 0 32px", textAlign: "center" }}>
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5 }}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 22 }}>
          <span className="tag" style={{ color: "var(--lime)", borderColor: "rgba(212,255,0,0.3)" }}><span className="live-dot" style={{ display: "inline-block", width: 6, height: 6, borderRadius: 999, background: "var(--lime)", marginRight: 6, verticalAlign: "1px" }} />LIVE ON {CHAIN_NAME.toUpperCase()}</span>
        </motion.div>

        <motion.h1 initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.05 }}
          className="disp" style={{ fontSize: "clamp(2.4rem, 7vw, 5rem)", fontWeight: 700, lineHeight: 1.02, letterSpacing: "-0.02em" }}>
          <span style={{ color: "var(--bone)" }}>ORIGIN</span>{" "}
          <span style={{
            background: "linear-gradient(120deg, var(--cyan), var(--lime))", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>PUNK</span>
        </motion.h1>
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="mono"
          style={{ color: "var(--fog)", marginTop: 14, fontSize: 13.5, letterSpacing: "0.03em" }}>
          10,000 GLITCH-BORN COLLECTIBLES · STAKE FOR XP · NO LOCK · NO CUSTODY RISK
        </motion.p>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
          style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 30, flexWrap: "wrap" }}>
          <button onClick={() => setView("gallery")} className="btn-primary" style={{ padding: "13px 26px", borderRadius: 12, fontSize: 14.5, display: "flex", alignItems: "center", gap: 8 }}>
            <LayoutGrid size={16} /> Browse Gallery
          </button>
          <button onClick={() => setView("collection")} className="btn-ghost" style={{ padding: "13px 26px", borderRadius: 12, fontSize: 14.5, display: "flex", alignItems: "center", gap: 8 }}>
            <Zap size={16} color="var(--lime)" /> Start Staking
          </button>
        </motion.div>
      </section>

      {/* TICKER */}
      <div className="glass ticker-wrap" style={{ borderRadius: 14, padding: "14px 0", overflow: "hidden", marginBottom: 28 }}>
        <div className="ticker-track mono">
          {[...tickerItems, ...tickerItems, ...tickerItems].map((t, i) => (
            <span key={i} style={{ fontSize: 13 }}>
              <span style={{ color: "var(--fog)" }}>{t.label}</span>{" "}
              <span style={{ color: "var(--cyan)", fontWeight: 700 }}>{t.value}</span>
            </span>
          ))}
        </div>
      </div>

      {/* STAT GRID */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 36 }} className="stat-grid">
        {[
          ["Minted Supply", countVal(stats.totalItems), Layers, stats.totalItemsIsReal],
          ["Floor Price", ethVal(stats.floor), TrendingUp, stats.floorIsReal],
          ["Total Volume", ethVal(stats.volume), ShoppingBag, false],
          ["Owners", countVal(stats.owners), Users, false],
          ["Listed", countVal(stats.listed), Tag, false],
          ["Total Sales", countVal(stats.salesWeek), Sparkles, false],
        ].map(([label, val, Icon, isLive]) => (
          <div key={label} className="glass" style={{ borderRadius: 14, padding: "16px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11.5, color: "var(--fog)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</span>
              <Icon size={14} color="var(--cyan)" />
            </div>
            <div className="disp" style={{ fontSize: 22, fontWeight: 700 }} title={isLive ? "Live from Alchemy" : "No live source connected for this stat"}>{val}</div>
          </div>
        ))}
      </div>

      {/* LIVE ACTIVITY */}
      <section style={{ marginBottom: 40 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--magenta)" }} className="live-dot" />
            <h2 className="disp" style={{ fontSize: 18, fontWeight: 700 }}>Live Activity</h2>
          </div>
          <button onClick={() => setSalesPaused((p) => !p)} className="btn-ghost" style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            {salesPaused ? <Play size={13} /> : <Pause size={13} />} {salesPaused ? "Resume" : "Pause"}
          </button>
        </div>
        <div className="glass" style={{ borderRadius: 14, overflow: "hidden" }}>
          {liveSales.length === 0 && <div style={{ padding: 28, textAlign: "center", color: "var(--fog)", fontSize: 13 }}>Waiting for the next sale…</div>}
          <AnimatePresence initial={false}>
            {liveSales.map((s) => (
              <motion.div key={s.id} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
                <div style={{ width: 40 }}><PixelAvatar nft={s.nft} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>Origin Punk #{s.tokenId}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--fog)" }}>{short(s.seller)} → {short(s.buyer)} · {s.marketplace}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="mono" style={{ fontWeight: 700, color: "var(--lime)", fontSize: 13.5 }}>{s.price} ETH</div>
                  <div style={{ fontSize: 10.5, color: "var(--fog)" }}>{timeAgo(s.ts)}</div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </section>

      <style>{`@media (min-width:640px){ .stat-grid{ grid-template-columns:repeat(3,1fr) !important; } } @media (min-width:1024px){ .stat-grid{ grid-template-columns:repeat(6,1fr) !important; } }`}</style>
    </div>
  );
}

// ===========================================================================
// GALLERY
// ===========================================================================
function GalleryView({ loading, visible, filtered, collection, search, setSearch, sortBy, setSortBy, typeFilter, setTypeFilter, genderFilter, setGenderFilter, scrollRef, onGalleryScroll, setSelected, filtersOpen, setFiltersOpen, collectionError, onRetry }) {
  const toggle = (arr, setArr, val) => setArr(arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);

  // filter options come straight from whatever attribute values Alchemy
  // actually returned for the loaded tokens — never a hardcoded trait list —
  // so "Unknown" only shows up if the metadata genuinely didn't include it
  const availableTypes = useMemo(
    () => [...new Set(collection.map((n) => n.type).filter(Boolean))].sort(),
    [collection]
  );
  const availableGenders = useMemo(
    () => [...new Set(collection.map((n) => n.gender).filter((g) => g && g !== "N/A"))].sort(),
    [collection]
  );

  return (
    <div style={{ paddingTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <h1 className="disp" style={{ fontSize: 26, fontWeight: 700 }}>Gallery <span className="mono" style={{ fontSize: 13, color: "var(--fog)", fontWeight: 400 }}>({filtered.length} results)</span></h1>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div className="glass" style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 10, flex: "1 1 220px" }}>
          <Search size={15} color="var(--fog)" />
          <input type="text" placeholder="Search by Token ID…" value={search} onChange={(e) => setSearch(e.target.value.replace(/\D/g, ""))}
            style={{ background: "none", border: "none", outline: "none", color: "var(--bone)", fontSize: 13.5, width: "100%" }} />
        </div>
        <button onClick={() => setFiltersOpen((o) => !o)} className="btn-ghost" style={{ padding: "10px 14px", borderRadius: 10, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <SlidersHorizontal size={14} /> Filters {typeFilter.length + genderFilter.length > 0 && `(${typeFilter.length + genderFilter.length})`}
        </button>
        <div className="glass" style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 14px", borderRadius: 10 }}>
          <Filter size={14} color="var(--fog)" />
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ background: "none", border: "none", outline: "none", color: "var(--bone)", fontSize: 13 }}>
            <option style={{ color: "#000" }} value="newest">Newest</option>
            <option style={{ color: "#000" }} value="oldest">Oldest</option>
            <option style={{ color: "#000" }} value="priceHigh">Highest Price</option>
            <option style={{ color: "#000" }} value="priceLow">Lowest Price</option>
            <option style={{ color: "#000" }} value="xpHigh">Highest XP</option>
            <option style={{ color: "#000" }} value="rarest">Rarest</option>
          </select>
        </div>
      </div>

      <AnimatePresence>
        {filtersOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="glass" style={{ borderRadius: 12, padding: 16, marginBottom: 18, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--fog)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>Type</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {availableTypes.length === 0 && <span style={{ fontSize: 12, color: "var(--fog)" }}>No types loaded yet</span>}
                  {availableTypes.map((t) => (
                    <label key={t} className="checkbox-row" style={{ fontSize: 13 }}>
                      <input type="checkbox" checked={typeFilter.includes(t)} onChange={() => toggle(typeFilter, setTypeFilter, t)} /> {t}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--fog)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>Gender</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {availableGenders.length === 0 && <span style={{ fontSize: 12, color: "var(--fog)" }}>No gender trait loaded yet</span>}
                  {availableGenders.map((g) => (
                    <label key={g} className="checkbox-row" style={{ fontSize: 13 }}>
                      <input type="checkbox" checked={genderFilter.includes(g)} onChange={() => toggle(genderFilter, setGenderFilter, g)} /> {g}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div ref={scrollRef} onScroll={onGalleryScroll} style={{ maxHeight: "72vh", overflowY: "auto", paddingRight: 4 }} className="scrollbar-thin">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14 }} className="gallery-grid">
          {loading
            ? Array.from({ length: 10 }).map((_, i) => <div key={i} className="skeleton" style={{ borderRadius: 14, aspectRatio: "0.78" }} />)
            : visible.map((nft) => (
              <div key={nft.id} onClick={() => setSelected(nft)} className="glass nft-card" style={{ borderRadius: 14, padding: 10 }}>
                <NFTThumb nft={nft} />
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>#{nft.id}</span>
                    <span className="tag" style={{ color: tierColor(nft.type), borderColor: "transparent", padding: 0, fontSize: 9.5 }}>{nft.type}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--fog)", marginTop: 4 }}>Rank #{nft.rank} · {nft.traitCount} traits</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                    <span className="mono" style={{ fontSize: 12, color: "var(--lime)", fontWeight: 700 }}>{nft.xpPerDay} XP/d</span>
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--fog)" }}>{nft.lastSalePrice != null ? `${nft.lastSalePrice} ETH` : "open in detail →"}</span>
                  </div>
                </div>
              </div>
            ))}
        </div>
        {!loading && visible.length < filtered.length && (
          <div style={{ textAlign: "center", padding: "18px 0", color: "var(--fog)", fontSize: 12 }} className="mono">Scroll for more · {filtered.length - visible.length} remaining</div>
        )}
        {!loading && filtered.length === 0 && collectionError && (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <div className="pixel" style={{ fontSize: 22, color: "var(--amber)", marginBottom: 10 }}>404</div>
            <div style={{ color: "var(--fog)", fontSize: 13.5, marginBottom: 14 }}>Couldn't load the collection from Alchemy: {collectionError}</div>
            <button onClick={onRetry} className="btn-primary" style={{ padding: "9px 20px", borderRadius: 10, fontSize: 13 }}>Retry</button>
          </div>
        )}
        {!loading && filtered.length === 0 && !collectionError && (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <div className="pixel" style={{ fontSize: 22, color: "var(--magenta)", marginBottom: 10 }}>404</div>
            <div style={{ color: "var(--fog)", fontSize: 13.5 }}>No punks match those filters.</div>
          </div>
        )}
      </div>

      <style>{`@media (min-width:640px){ .gallery-grid{ grid-template-columns:repeat(3,1fr) !important; } } @media (min-width:1024px){ .gallery-grid{ grid-template-columns:repeat(5,1fr) !important; } }`}</style>
    </div>
  );
}
function tierColor(type) {
  return { Alien: "var(--magenta)", Ape: "var(--amber, #FFB020)", Zombie: "var(--lime)", Human: "var(--cyan)" }[type];
}

// ===========================================================================
// MY COLLECTION
// ===========================================================================
function CollectionView({ wallet, myTokens, stakes, pendingXP, stakeToken, unstakeToken, claimToken, claimAll, totalPendingXP, claimedTotal, setSelected, setWalletMenuOpen }) {
  if (!wallet) {
    return (
      <div style={{ textAlign: "center", padding: "90px 20px" }}>
        <div className="pixel" style={{ fontSize: 28, color: "var(--cyan)", marginBottom: 18 }}>404</div>
        <h2 className="disp" style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>No wallet connected</h2>
        <p style={{ color: "var(--fog)", fontSize: 13.5, marginBottom: 22 }}>Connect a wallet to see the punks you own and start staking.</p>
        <button onClick={() => setWalletMenuOpen(true)} className="btn-primary" style={{ padding: "12px 22px", borderRadius: 10, fontSize: 13.5 }}>Connect Wallet</button>
      </div>
    );
  }

  const staked = myTokens.filter((n) => stakes[n.id]);
  const unstaked = myTokens.filter((n) => !stakes[n.id]);

  return (
    <div style={{ paddingTop: 24 }}>
      <h1 className="disp" style={{ fontSize: 26, fontWeight: 700, marginBottom: 6 }}>My Collection</h1>
      <p className="mono" style={{ color: "var(--fog)", fontSize: 12.5, marginBottom: 20 }}>{short(wallet.address)} · {myTokens.length} owned · {staked.length} staked</p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 24 }} className="wallet-stat-grid">
        {[
          ["Owned NFTs", myTokens.length],
          ["Currently Staking", staked.length],
          ["Claimable XP", fmt2(totalPendingXP)],
          ["Total Claimed", fmt2(claimedTotal)],
        ].map(([l, v]) => (
          <div key={l} className="glass" style={{ borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: "var(--fog)", marginBottom: 6 }}>{l}</div>
            <div className="disp mono" style={{ fontSize: 19, fontWeight: 700, color: l === "Claimable XP" ? "var(--lime)" : "var(--bone)" }}>{v}</div>
          </div>
        ))}
      </div>

      <button onClick={claimAll} disabled={totalPendingXP <= 0} className="btn-lime" style={{ padding: "12px 20px", borderRadius: 10, fontSize: 13.5, marginBottom: 28, display: "flex", alignItems: "center", gap: 8 }}>
        <Zap size={15} /> Claim All XP ({fmt2(totalPendingXP)})
      </button>

      {myTokens.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: "var(--fog)" }}>This wallet doesn't hold any Origin Punks from <span className="mono">{short(COLLECTION_ADDRESS)}</span>.</div>
      ) : (
        <>
          {staked.length > 0 && (
            <>
              <h3 className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, color: "var(--lime)" }}>Staked ({staked.length})</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14, marginBottom: 30 }} className="my-grid">
                {staked.map((nft) => (
                  <StakeCard key={nft.id} nft={nft} staked stakeInfo={stakes[nft.id]} pending={pendingXP(nft.id)}
                    onDetails={() => setSelected(nft)} onClaim={() => claimToken(nft.id)} onUnstake={() => unstakeToken(nft.id)} />
                ))}
              </div>
            </>
          )}
          {unstaked.length > 0 && (
            <>
              <h3 className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Unstaked ({unstaked.length})</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14 }} className="my-grid">
                {unstaked.map((nft) => (
                  <StakeCard key={nft.id} nft={nft} onDetails={() => setSelected(nft)} onStake={() => stakeToken(nft.id)} />
                ))}
              </div>
            </>
          )}
        </>
      )}
      <style>{`@media (min-width:640px){ .wallet-stat-grid{ grid-template-columns:repeat(4,1fr) !important; } .my-grid{ grid-template-columns:repeat(3,1fr) !important; } } @media (min-width:1024px){ .my-grid{ grid-template-columns:repeat(4,1fr) !important; } }`}</style>
    </div>
  );
}

function StakeCard({ nft, staked, stakeInfo, pending, onDetails, onStake, onClaim, onUnstake }) {
  return (
    <div className="glass" style={{ borderRadius: 14, padding: 10, borderColor: staked ? "rgba(212,255,0,0.3)" : undefined }}>
      <div onClick={onDetails} style={{ cursor: "pointer" }}><NFTThumb nft={nft} /></div>
      <div style={{ marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>#{nft.id}</span>
          <span className="tag" style={{ color: tierColor(nft.type), borderColor: "transparent", padding: 0, fontSize: 9.5 }}>{nft.type}</span>
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--fog)", margin: "4px 0" }}>Rank #{nft.rank} · {nft.xpPerDay} XP/day</div>

        {staked ? (
          <>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--fog)", marginBottom: 2 }}>Staked {durationSince(stakeInfo.start)} ago</div>
            <div className="mono" style={{ fontSize: 13, color: "var(--lime)", fontWeight: 700, marginBottom: 8 }}>+{fmt2(pending)} XP</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={onClaim} disabled={pending <= 0} className="btn-lime" style={{ flex: 1, padding: "7px 0", borderRadius: 8, fontSize: 11.5 }}>Claim</button>
              <button onClick={onUnstake} className="btn-ghost" style={{ flex: 1, padding: "7px 0", borderRadius: 8, fontSize: 11.5 }}>Unstake</button>
            </div>
          </>
        ) : (
          <button onClick={onStake} className="btn-primary" style={{ width: "100%", padding: "8px 0", borderRadius: 8, fontSize: 12, marginTop: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Zap size={13} /> Stake
          </button>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// DASHBOARD
// ===========================================================================
function DashboardView({ wallet, stakes, claimedTotal, totalPendingXP, xpToday, xpWeek, xpMonth, myTokens, rarest }) {
  const mockActiveStakers = 1842, mockTotalStaked = 6120, mockXpMinted = 48_302_110, mockAvgDuration = "11d 6h";
  const stakedCount = Object.keys(stakes).length;
  return (
    <div style={{ paddingTop: 24 }}>
      <h1 className="disp" style={{ fontSize: 26, fontWeight: 700, marginBottom: 20 }}>Dashboard</h1>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 30 }} className="dash-grid">
        {[
          ["Total NFTs Staked", fmt(mockTotalStaked + stakedCount), Layers],
          ["Total XP Minted", fmt(mockXpMinted + claimedTotal), Zap],
          ["Active Stakers", fmt(mockActiveStakers + (wallet ? 1 : 0)), Users],
          ["Avg. Stake Duration", mockAvgDuration, Clock],
        ].map(([l, v, Icon]) => (
          <div key={l} className="glass glow-lime" style={{ borderRadius: 14, padding: "16px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "var(--fog)", textTransform: "uppercase" }}>{l}</span>
              <Icon size={14} color="var(--cyan)" />
            </div>
            <div className="disp mono" style={{ fontSize: 20, fontWeight: 700 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20 }} className="dash-cols">
        <div className="glass" style={{ borderRadius: 14, padding: 20 }}>
          <h3 className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Claim Statistics {wallet ? "(you)" : "(connect wallet)"}</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              ["Today's XP", xpToday], ["Weekly XP", xpWeek], ["Monthly XP", xpMonth],
              ["Pending XP", totalPendingXP], ["Total Claimed", claimedTotal],
            ].map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: 10 }}>
                <span style={{ fontSize: 13, color: "var(--fog)" }}>{l}</span>
                <span className="mono" style={{ fontWeight: 700, color: "var(--lime)" }}>{fmt2(v)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="glass" style={{ borderRadius: 14, padding: 20 }}>
          <h3 className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Top Daily XP Earners (rarest tokens)</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rarest.slice(0, 6).map((n, i) => (
              <div key={n.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="mono" style={{ width: 18, fontSize: 12, color: "var(--fog)" }}>{i + 1}</span>
                <div style={{ width: 30 }}><PixelAvatar nft={n} /></div>
                <span style={{ fontSize: 13, flex: 1 }}>Origin Punk #{n.id}</span>
                <span className="mono" style={{ color: "var(--lime)", fontWeight: 700, fontSize: 13 }}>{n.xpPerDay} XP/d</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <style>{`@media (min-width:640px){ .dash-grid{ grid-template-columns:repeat(4,1fr) !important; } } @media (min-width:900px){ .dash-cols{ grid-template-columns:1fr 1fr !important; } }`}</style>
    </div>
  );
}

// ===========================================================================
// LEADERBOARD
// ===========================================================================
function LeaderboardView({ holders, stakers, rarest, largest, wallet }) {
  const [tab, setTab] = useState("holders");
  const TABS = [
    { id: "holders", label: "Top XP Holders" },
    { id: "stakers", label: "Top Stakers" },
    { id: "rarest", label: "Top Rarest" },
    { id: "largest", label: "Largest Collections" },
  ];
  return (
    <div style={{ paddingTop: 24 }}>
      <h1 className="disp" style={{ fontSize: 26, fontWeight: 700, marginBottom: 4 }}>Leaderboards</h1>
      <p style={{ fontSize: 11.5, color: "var(--fog)", marginBottom: 14 }}>
        "Top Rarest" is computed live from the tokens loaded from Alchemy. "XP Holders" / "Stakers" reflect the local staking game, not an on-chain contract. "Largest Collections" only counts owners this session has actually resolved (your connected wallet).
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={t.id === tab ? "btn-primary" : "btn-ghost"} style={{ padding: "8px 14px", borderRadius: 999, fontSize: 12.5 }}>{t.label}</button>
        ))}
      </div>

      <div className="glass" style={{ borderRadius: 14, overflow: "hidden" }}>
        {tab === "holders" && holders.map((h, i) => (
          <Row key={h.addr} rank={i + 1} left={short(h.addr)} right={`${fmt(h.xp)} XP`} highlight={h.isYou} />
        ))}
        {tab === "stakers" && stakers.map((h, i) => (
          <Row key={h.addr} rank={i + 1} left={short(h.addr)} right={`${h.count} staked`} highlight={h.isYou} />
        ))}
        {tab === "rarest" && rarest.map((n, i) => (
          <Row key={n.id} rank={i + 1} left={`Origin Punk #${n.id}`} right={`Rank #${n.rank}`} icon={<div style={{ width: 26 }}><PixelAvatar nft={n} /></div>} />
        ))}
        {tab === "largest" && largest.map((h, i) => (
          <Row key={h.addr} rank={i + 1} left={short(h.addr)} right={`${h.count} punks`} />
        ))}
      </div>
    </div>
  );
}
function Row({ rank, left, right, highlight, icon }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line)", background: highlight ? "rgba(212,255,0,0.06)" : "transparent" }}>
      <span className="mono" style={{ width: 22, color: rank <= 3 ? "var(--lime)" : "var(--fog)", fontWeight: 700, fontSize: 13 }}>{rank}</span>
      {icon}
      <span className="mono" style={{ flex: 1, fontSize: 13 }}>{left} {highlight && <span className="tag" style={{ color: "var(--lime)", marginLeft: 6, borderColor: "rgba(212,255,0,0.3)" }}>YOU</span>}</span>
      <span className="mono" style={{ fontWeight: 700, fontSize: 13, color: "var(--bone)" }}>{right}</span>
    </div>
  );
}

// ===========================================================================
// NFT DETAIL MODAL
// ===========================================================================
function NFTModal({ nft, onClose, isOwned, isStaked, pendingXP, onStake, onUnstake, onClaim, sampleSize, collectionMeta }) {
  const [sales, setSales] = useState(null); // null = loading, [] = loaded empty, array = loaded
  const [salesError, setSalesError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSales(null);
    setSalesError(null);
    fetchSaleHistory(COLLECTION_ADDRESS, nft.id)
      .then((data) => { if (!cancelled) setSales(data.asset_events || []); })
      .catch((err) => { if (!cancelled) { setSalesError(err.message); setSales([]); } });
    return () => { cancelled = true; };
  }, [nft.id]);

  const lastSale = sales && sales.length ? sales[0] : null;
  const lastSaleEth = lastSale ? Number(lastSale.payment?.quantity || 0) / 10 ** (lastSale.payment?.decimals ?? 18) : null;
  const floorEth = collectionMeta?.openSeaMetadata?.floorPrice ?? collectionMeta?.contract?.openSeaMetadata?.floorPrice ?? null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4,5,7,0.75)", backdropFilter: "blur(6px)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <motion.div onClick={(e) => e.stopPropagation()} initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.94, opacity: 0 }}
        className="glass" style={{ borderRadius: 18, maxWidth: 780, width: "100%", maxHeight: "86vh", overflowY: "auto", padding: 24, position: "relative" }}>
        <button onClick={onClose} className="btn-ghost" style={{ position: "absolute", top: 16, right: 16, padding: 8, borderRadius: 8, zIndex: 2 }}><X size={16} /></button>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20 }} className="modal-grid">
          <div style={{ maxWidth: 280, margin: "0 auto" }}>
            <NFTThumb nft={nft} />
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span className="tag" style={{ color: tierColor(nft.type), borderColor: "transparent", padding: 0 }}>{nft.type}</span>
              {isStaked && <span className="tag" style={{ color: "var(--lime)", borderColor: "rgba(212,255,0,0.3)" }}>STAKED</span>}
            </div>
            <h2 className="disp" style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Origin Punk #{nft.id}</h2>
            <div className="mono" style={{ fontSize: 12, color: "var(--fog)", marginBottom: 16 }}>
              {nft.owner ? <>Owner {short(nft.owner)} · </> : null}Rank #{nft.rank} of {sampleSize} loaded <span title="Rarity is only computed across NFTs fetched so far, not the full on-chain supply">(sample-based)</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10, marginBottom: 18 }}>
              {[["Background", nft.background], ["Eyes", nft.eyes], ["Hat", nft.hat], ["Accessory", nft.accessory], ["Gender", nft.gender], ["Trait Count", nft.traitCount]].map(([k, v]) => (
                <div key={k} className="glass" style={{ borderRadius: 10, padding: "8px 12px" }}>
                  <div style={{ fontSize: 10, color: "var(--fog)", textTransform: "uppercase" }}>{k}</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{v}</div>
                </div>
              ))}
            </div>

            <div className="glass glow-lime" style={{ borderRadius: 12, padding: "14px 16px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--fog)" }}>XP Per Day</div>
                <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--lime)" }}>{nft.xpPerDay}</div>
              </div>
              {isStaked && (
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: "var(--fog)" }}>Pending</div>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--bone)" }}>+{fmt2(pendingXP)}</div>
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div className="glass" style={{ borderRadius: 10, padding: "8px 12px" }}>
                <div style={{ fontSize: 10, color: "var(--fog)" }}>Last Sale (OpenSea)</div>
                <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>
                  {sales === null ? "Loading…" : lastSaleEth !== null ? `${lastSaleEth.toFixed(3)} ${lastSale.payment?.symbol || "ETH"}` : "No recorded sale"}
                </div>
              </div>
              <div className="glass" style={{ borderRadius: 10, padding: "8px 12px" }}>
                <div style={{ fontSize: 10, color: "var(--fog)" }}>Collection Floor</div>
                <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>{floorEth !== null ? `${floorEth} ETH` : "—"}</div>
              </div>
            </div>

            <div className="glass" style={{ borderRadius: 10, padding: "10px 12px", marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: "var(--fog)", textTransform: "uppercase", marginBottom: 6 }}>Sale History</div>
              {sales === null && <div style={{ fontSize: 12, color: "var(--fog)" }}>Fetching from OpenSea…</div>}
              {salesError && <div style={{ fontSize: 11.5, color: "var(--amber)" }}>OpenSea read failed ({salesError}) — Robinhood Chain may not be indexed under this chain slug yet.</div>}
              {sales && sales.length === 0 && !salesError && <div style={{ fontSize: 12, color: "var(--fog)" }}>No sale events found on OpenSea for this token.</div>}
              {sales && sales.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 130, overflowY: "auto" }}>
                  {sales.slice(0, 8).map((s, i) => {
                    const eth = Number(s.payment?.quantity || 0) / 10 ** (s.payment?.decimals ?? 18);
                    return (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span className="mono" style={{ color: "var(--fog)" }}>{s.seller ? short(s.seller) : "—"} → {s.buyer ? short(s.buyer) : "—"}</span>
                        <span className="mono" style={{ fontWeight: 700 }}>{eth.toFixed(3)} {s.payment?.symbol || "ETH"}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {isOwned && (
              <div style={{ display: "flex", gap: 8 }}>
                {isStaked ? (
                  <>
                    <button onClick={onClaim} disabled={pendingXP <= 0} className="btn-lime" style={{ flex: 1, padding: "11px 0", borderRadius: 10, fontSize: 13 }}>Claim XP</button>
                    <button onClick={() => { onUnstake(); onClose(); }} className="btn-ghost" style={{ flex: 1, padding: "11px 0", borderRadius: 10, fontSize: 13 }}>Unstake</button>
                  </>
                ) : (
                  <button onClick={onStake} className="btn-primary" style={{ flex: 1, padding: "11px 0", borderRadius: 10, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    <Zap size={15} /> Stake this NFT
                  </button>
                )}
              </div>
            )}

            <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fog)" }}>
              <ShieldCheck size={13} /> Only accepts NFTs from <span className="mono">{short(COLLECTION_ADDRESS)}</span>
            </div>
          </div>
        </div>
      </motion.div>
      <style>{`@media (min-width:640px){ .modal-grid{ grid-template-columns:280px 1fr !important; } }`}</style>
    </motion.div>
  );
}
