import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { EthereumProvider } from "@walletconnect/ethereum-provider";
import CoinbaseWalletSDK from "@coinbase/wallet-sdk";
import QRCode from "qrcode";
import {
  Wallet, X, Search, ChevronDown, Zap, Layers, Trophy, LayoutGrid,
  Home as HomeIcon, Check, Clock, TrendingUp, Users, Tag, ShoppingBag,
  Sparkles, ShieldCheck, Pause, Play, Copy, Filter, SlidersHorizontal, Loader2, AlertCircle, ExternalLink, RefreshCw
} from "lucide-react";

/* ============================================================================
   ENVIRONMENT & NETWORK CONFIGURATION
============================================================================ */
const ALCHEMY_API_KEY = import.meta.env.VITE_ALCHEMY_API_KEY || "";
const ALCHEMY_NETWORK_SUBDOMAIN = import.meta.env.VITE_ALCHEMY_NETWORK_SUBDOMAIN || "robinhood-mainnet";
const ALCHEMY_NFT_BASE = `https://${ALCHEMY_NETWORK_SUBDOMAIN}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;
const ALCHEMY_RPC_URL = `https://${ALCHEMY_NETWORK_SUBDOMAIN}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

const OPENSEA_API_KEY = import.meta.env.VITE_OPENSEA_API_KEY || "";
const OPENSEA_BASE = "https://api.opensea.io/api/v2";
const OPENSEA_CHAIN_SLUG = import.meta.env.VITE_OPENSEA_CHAIN_SLUG || "robinhood";

const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";

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

const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "");

/* ============================================================================
   API HELPER FUNCTIONS
============================================================================ */
async function alchemyNft(path) {
  const url = `${ALCHEMY_NFT_BASE}${path}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Alchemy API Error: Status ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`[Alchemy Request Failed]:`, err);
    throw err;
  }
}

async function fetchContractMetadata(address) {
  return alchemyNft(`/getContractMetadata?contractAddress=${address}`);
}

async function fetchNFTsForContract(address, pageKey) {
  const params = new URLSearchParams({ contractAddress: address, withMetadata: "true", limit: "48" });
  if (pageKey) params.set("pageKey", pageKey);
  return alchemyNft(`/getNFTsForContract?${params.toString()}`);
}

async function fetchNFTsForOwner(owner, address) {
  const params = new URLSearchParams({ owner, withMetadata: "true", pageSize: "100" });
  params.append("contractAddresses[]", address);
  return alchemyNft(`/getNFTsForOwner?${params.toString()}`);
}

/* ============================================================================
   ON-CHAIN METADATA & TRAIT MAPPER
============================================================================ */
function mapAlchemyNft(raw) {
  const rawAttributes = raw?.raw?.metadata?.attributes || raw?.metadata?.attributes || [];
  
  const dynamicAttributes = Array.isArray(rawAttributes) ? rawAttributes.map(a => ({
    trait_type: a?.trait_type || "Attribute",
    value: String(a?.value || "N/A")
  })) : [];

  const getTraitValue = (keyName) => {
    const found = dynamicAttributes.find(a => String(a.trait_type).toLowerCase() === keyName.toLowerCase());
    return found ? found.value : "None";
  };

  const image =
    raw?.image?.cachedUrl || raw?.image?.originalUrl || raw?.image?.thumbnailUrl ||
    raw?.media?.[0]?.gateway || null;

  return {
    id: Number(raw.tokenId),
    name: raw?.name || raw?.raw?.metadata?.name || `Origin Punk #${raw.tokenId}`,
    type: getTraitValue("type") !== "None" ? getTraitValue("type") : (getTraitValue("species") !== "None" ? getTraitValue("species") : "Standard"),
    gender: getTraitValue("gender"),
    background: getTraitValue("background"),
    eyes: getTraitValue("eyes"),
    hat: getTraitValue("hat") !== "None" ? getTraitValue("hat") : getTraitValue("headwear"),
    accessory: getTraitValue("accessory"),
    attributes: dynamicAttributes,
    traitCount: dynamicAttributes.length,
    image,
    tokenUri: raw?.tokenUri?.raw || raw?.tokenUri?.gateway || null,
  };
}

function calculateRarityAndTraits(nfts) {
  if (!nfts || !nfts.length) return { scoredNFTs: [], traitCategories: {} };

  const traitFreq = {};
  nfts.forEach((nft) => {
    nft.attributes.forEach(({ trait_type, value }) => {
      if (!traitFreq[trait_type]) traitFreq[trait_type] = {};
      traitFreq[trait_type][value] = (traitFreq[trait_type][value] || 0) + 1;
    });
  });

  const total = nfts.length;
  const scored = nfts.map((nft) => {
    let score = 0;
    nft.attributes.forEach(({ trait_type, value }) => {
      const count = traitFreq[trait_type][value] || 1;
      score += total / count;
    });
    return { ...nft, rarityScore: Math.round(score * 100) / 100 };
  });

  const ranked = [...scored].sort((a, b) => b.rarityScore - a.rarityScore);
  const rankMap = {};
  ranked.forEach((item, index) => { rankMap[item.id] = index + 1; });

  const finalNFTs = scored.map((item) => ({
    ...item,
    rank: rankMap[item.id] || 1,
    dailyReward: Math.round(50 + (item.rarityScore / 10))
  }));

  return { scoredNFTs: finalNFTs, traitCategories: traitFreq };
}

/* ============================================================================
   EIP-6963 WALLET DISCOVERY HOOK
============================================================================ */
function useDiscoveredWallets() {
  const [wallets, setWallets] = useState([]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onAnnounce = (event) => {
      setWallets((prev) => {
        if (prev.some((w) => w.info.uuid === event.detail.info.uuid)) return prev;
        return [...prev, event.detail];
      });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:removeProvider", onAnnounce);
  }, []);
  return wallets;
}

/* ============================================================================
   SUB-COMPONENTS
============================================================================ */
function NFTImage({ src, name, id }) {
  const [error, setError] = useState(false);
  if (src && !error) {
    return (
      <img
        src={src}
        alt={name || `Punk #${id}`}
        loading="lazy"
        style={{ width: "100%", aspectRatio: "1/1", borderRadius: 10, objectFit: "cover", display: "block", background: "#0D0E12" }}
        onError={() => setError(true)}
      />
    );
  }
  return (
    <div style={{ width: "100%", aspectRatio: "1/1", borderRadius: 10, background: "#161922", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", border: "1px dashed var(--line)" }}>
      <Sparkles size={28} color="var(--fog)" />
      <span className="mono" style={{ fontSize: 11, color: "var(--fog)", marginTop: 8 }}>#{id}</span>
    </div>
  );
}

function CountdownTimer() {
  const [timeLeft, setTimeLeft] = useState(86400);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const format = (seconds) => {
    const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
  };

  return (
    <div className="glass glow-box" style={{ padding: "24px", borderRadius: "16px", textAlign: "center", position: "relative", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--lime)", marginBottom: 10 }}>
        <Clock className="pulse-icon" size={20} />
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Staking Pool Countdown</span>
      </div>
      <div className="disp mono" style={{ fontSize: "clamp(2.2rem, 5vw, 3.8rem)", fontWeight: 800, color: "#FFF" }}>
        {format(timeLeft)}
      </div>
      <p style={{ fontSize: 13, color: "var(--fog)", marginTop: 10, maxWidth: 600, marginInLine: "auto" }}>
        স্টেকিং স্মার্ট কন্ট্রাক্ট ভেরিফিকেশন চলছে। ২৪ ঘন্টার রিভার্স কাউন্টডাউন শেষ হলে অন-চেইন $PUNK রিওয়ার্ড স্ট্যাকিং লাইভ চালু হয়ে যাবে।
      </p>
    </div>
  );
}

/* ============================================================================
   MAIN APPLICATION
============================================================================ */
export default function OriginPunkApp() {
  const [view, setView] = useState("home");
  const [rawNfts, setRawNfts] = useState([]);
  const [contractData, setContractData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);

  // Wallet states
  const [wallet, setWallet] = useState(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [userNfts, setUserNfts] = useState([]);
  const [stakedNfts, setStakedNfts] = useState([]);
  const [userNftsLoading, setUserNftsLoading] = useState(false);

  // WalletConnect & QRCode States
  const [wcQrUrl, setWcQrUrl] = useState("");
  const [qrModalOpen, setQrModalOpen] = useState(false);

  // Filter & Search states
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTrait, setSelectedTrait] = useState("all");
  const [sortBy, setSortBy] = useState("rank-asc");
  const [selectedNft, setSelectedNft] = useState(null);
  const [toast, setToast] = useState(null);

  const discoveredWallets = useDiscoveredWallets();

  // Show toast notification
  const triggerToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // Process Rarity and Categories
  const { scoredNFTs: collection, traitCategories } = useMemo(() => {
    return calculateRarityAndTraits(rawNfts);
  }, [rawNfts]);

  // Fetch Collection Data
  const loadCollectionData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [meta, nftData] = await Promise.all([
        fetchContractMetadata(COLLECTION_ADDRESS).catch(() => null),
        fetchNFTsForContract(COLLECTION_ADDRESS)
      ]);
      if (meta) setContractData(meta);
      if (nftData && nftData.nfts) {
        const mapped = nftData.nfts.map(mapAlchemyNft);
        setRawNfts(mapped);
      }
    } catch (err) {
      setErrorMsg("Failed to load on-chain NFTs from Alchemy RPC.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCollectionData();
  }, [loadCollectionData]);

  // Connect Wallet Logic
  const handleConnect = async (address, providerName) => {
    setWallet({ address, provider: providerName });
    setWalletModalOpen(false);
    setQrModalOpen(false);
    triggerToast(`Wallet Connected: ${short(address)}`);

    // Fetch User Owned NFTs
    setUserNftsLoading(true);
    try {
      const res = await fetchNFTsForOwner(address, COLLECTION_ADDRESS);
      if (res && res.ownedNfts) {
        const mapped = res.ownedNfts.map(mapAlchemyNft);
        setUserNfts(mapped);
      } else {
        setUserNfts([]);
      }
    } catch (err) {
      setUserNfts([]);
      triggerToast("Error fetching owned NFTs");
    } finally {
      setUserNftsLoading(false);
    }
  };

  const connectInjected = async (eWallet) => {
    try {
      const accounts = await eWallet.provider.request({ method: "eth_requestAccounts" });
      if (accounts && accounts[0]) {
        await handleConnect(accounts[0], eWallet.info.name);
      }
    } catch (err) {
      triggerToast("User rejected connection request");
    }
  };

  const connectWalletConnect = async () => {
    try {
      if (!WALLETCONNECT_PROJECT_ID) {
        triggerToast("WalletConnect Project ID Missing in Env");
        return;
      }
      const provider = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        chains: [CHAIN_ID_DEC],
        showQrModal: false,
        rpcMap: { [CHAIN_ID_DEC]: ALCHEMY_RPC_URL }
      });

      provider.on("display_uri", async (uri) => {
        const qr = await QRCode.toDataURL(uri);
        setWcQrUrl(qr);
        setQrModalOpen(true);
      });

      await provider.connect();
      const accounts = provider.accounts;
      if (accounts && accounts[0]) {
        await handleConnect(accounts[0], "WalletConnect");
      }
    } catch (err) {
      triggerToast("WalletConnect Failed");
    }
  };

  const disconnectWallet = () => {
    setWallet(null);
    setUserNfts([]);
    setStakedNfts([]);
    setAccountModalOpen(false);
    triggerToast("Wallet Disconnected");
  };

  // Stake / Unstake Actions
  const toggleStake = (nft) => {
    if (stakedNfts.some(s => s.id === nft.id)) {
      setStakedNfts(stakedNfts.filter(s => s.id !== nft.id));
      triggerToast(`Unstaked #${nft.id}`);
    } else {
      setStakedNfts([...stakedNfts, nft]);
      triggerToast(`Staked #${nft.id} successfully!`);
    }
  };

  // Filter and Sorting Logic
  const filteredNFTs = useMemo(() => {
    let list = [...collection];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(n => String(n.id).includes(q) || n.name.toLowerCase().includes(q));
    }

    if (selectedTrait !== "all") {
      list = list.filter(n => n.type === selectedTrait || n.attributes.some(a => a.value === selectedTrait));
    }

    if (sortBy === "rank-asc") list.sort((a, b) => a.rank - b.rank);
    if (sortBy === "rank-desc") list.sort((a, b) => b.rank - a.rank);
    if (sortBy === "id-asc") list.sort((a, b) => a.id - b.id);
    if (sortBy === "id-desc") list.sort((a, b) => b.id - a.id);

    return list;
  }, [collection, searchQuery, selectedTrait, sortBy]);

  return (
    <div className="app-container">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
        
        :root {
          --bg-dark: #08090B;
          --panel-bg: #12141A;
          --line: #222630;
          --lime: #D4FF00;
          --cyan: #2BFBEB;
          --magenta: #FF2E9A;
          --fog: #8993A6;
          --white: #FFFFFF;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg-dark); color: var(--white); font-family: 'Inter', sans-serif; overflow-x: hidden; }
        
        .disp { font-family: 'Space Grotesk', sans-serif; }
        .mono { font-family: 'JetBrains Mono', monospace; }

        .glass { background: rgba(18, 20, 26, 0.75); border: 1px solid var(--line); backdrop-filter: blur(14px); }
        .glow-box { border-color: rgba(212, 255, 0, 0.3); box-shadow: 0 0 20px rgba(212, 255, 0, 0.05); }

        .btn-lime { background: var(--lime); color: #000; font-weight: 700; border: none; cursor: pointer; transition: 0.2s; }
        .btn-lime:hover { background: #e5ff4d; transform: translateY(-1px); }
        
        .btn-outline { background: transparent; border: 1px solid var(--line); color: var(--white); cursor: pointer; transition: 0.2s; }
        .btn-outline:hover { border-color: var(--lime); color: var(--lime); }

        .nft-card { transition: all 0.25s ease; cursor: pointer; position: relative; }
        .nft-card:hover { transform: translateY(-5px); border-color: var(--lime); box-shadow: 0 8px 24px rgba(212, 255, 0, 0.12); }

        .pulse-icon { animation: pulse 1.5s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

        .custom-scroll::-webkit-scrollbar { width: 6px; }
        .custom-scroll::-webkit-scrollbar-track { background: var(--bg-dark); }
        .custom-scroll::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
      `}</style>

      {/* HEADER NAVBAR */}
      <header className="glass" style={{ position: "sticky", top: 0, zIndex: 50, borderBottom: "1px solid var(--line)" }}>
        <div style={{ maxWidth: 1320, margin: "0 auto", padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          
          <div style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }} onClick={() => setView("home")}>
            <div className="disp" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>
              ORIGIN <span style={{ color: "var(--lime)" }}>PUNK</span>
            </div>
            <span className="mono" style={{ fontSize: 10, background: "rgba(212,255,0,0.1)", color: "var(--lime)", padding: "2px 8px", borderRadius: 4, border: "1px solid rgba(212,255,0,0.2)" }}>
              ROBINHOOD CHAIN
            </span>
          </div>

          <nav style={{ display: "flex", gap: 6 }}>
            {[
              { id: "home", label: "Home", icon: HomeIcon },
              { id: "gallery", label: "Gallery", icon: LayoutGrid },
              { id: "staking", label: "Staking", icon: Zap },
              { id: "my-collection", label: "My NFTs", icon: Layers },
              { id: "dashboard", label: "Analytics", icon: TrendingUp },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setView(tab.id)}
                className="btn-outline"
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  borderColor: view === tab.id ? "var(--lime)" : "transparent",
                  color: view === tab.id ? "var(--lime)" : "var(--fog)",
                  background: view === tab.id ? "rgba(212,255,0,0.05)" : "transparent"
                }}
              >
                <tab.icon size={15} /> {tab.label}
              </button>
            ))}
          </nav>

          <div>
            {wallet ? (
              <button onClick={() => setAccountModalOpen(true)} className="btn-outline mono" style={{ padding: "8px 16px", borderRadius: 8, fontSize: 12, color: "var(--lime)", borderColor: "var(--lime)" }}>
                {short(wallet.address)}
              </button>
            ) : (
              <button onClick={() => setWalletModalOpen(true)} className="btn-lime" style={{ padding: "9px 18px", borderRadius: 8, fontSize: 13 }}>
                Connect Wallet
              </button>
            )}
          </div>
        </div>
      </header>

      {/* BODY VIEW CONTAINERS */}
      <main style={{ maxWidth: 1320, margin: "0 auto", padding: "30px 20px 100px" }}>

        {/* 1. HOME VIEW */}
        {view === "home" && (
          <div>
            <section style={{ textAlign: "center", padding: "60px 0 40px" }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--lime)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
                Official On-Chain NFT Collection
              </div>
              <h1 className="disp" style={{ fontSize: "clamp(2.5rem, 6vw, 4.8rem)", fontWeight: 800, lineHeight: 1.1 }}>
                NEXT-GEN PIXEL <br /><span style={{ color: "var(--lime)" }}>REVOLUTION</span>
              </h1>
              <p style={{ color: "var(--fog)", fontSize: 16, maxWidth: 640, margin: "20px auto 32px" }}>
                10,000 Dynamic Origin Punks generated directly from Robinhood Chain block data. Complete with real rarity ranks, metadata, and $PUNK token yield.
              </p>
              <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                <button onClick={() => setView("gallery")} className="btn-lime" style={{ padding: "14px 28px", borderRadius: 10, fontSize: 15 }}>Explore Collection</button>
                <button onClick={() => setView("staking")} className="btn-outline" style={{ padding: "14px 28px", borderRadius: 10, fontSize: 15 }}>Enter Staking Pool</button>
              </div>
            </section>

            <CountdownTimer />

            {/* Quick Stats Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginTop: 30 }}>
              {[
                { label: "Total Supply", val: contractData?.contract?.totalSupply || collection.length || "10,000", icon: Layers },
                { label: "Contract Address", val: short(COLLECTION_ADDRESS), icon: ShieldCheck },
                { label: "Chain Network", val: CHAIN_NAME, icon: Zap },
                { label: "On-Chain Traits", val: Object.keys(traitCategories).length || "24+", icon: Tag },
              ].map((s, i) => (
                <div key={i} className="glass" style={{ padding: 20, borderRadius: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", color: "var(--fog)" }}>
                    <span style={{ fontSize: 12 }}>{s.label}</span>
                    <s.icon size={16} />
                  </div>
                  <div className="disp mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 8 }}>{s.val}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 2. GALLERY VIEW */}
        {view === "gallery" && (
          <div>
            {/* Filter Bar */}
            <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 24, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
              
              <div style={{ display: "flex", gap: 10, flex: 1, minWidth: 260 }}>
                <div style={{ position: "relative", width: "100%" }}>
                  <Search size={16} color="var(--fog)" style={{ position: "absolute", left: 12, top: 12 }} />
                  <input
                    type="text"
                    placeholder="Search Token ID or Name..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{ width: "100%", padding: "10px 10px 10px 38px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--line)", borderRadius: 8, color: "#fff", fontSize: 13, outline: "none" }}
                  />
                </div>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                {/* Trait Filter */}
                <select
                  value={selectedTrait}
                  onChange={(e) => setSelectedTrait(e.target.value)}
                  style={{ background: "rgba(0,0,0,0.5)", border: "1px solid var(--line)", color: "#fff", padding: "10px 14px", borderRadius: 8, fontSize: 13 }}
                >
                  <option value="all">All Attributes</option>
                  {Object.keys(traitCategories).map(cat => (
                    <optgroup key={cat} label={cat}>
                      {Object.keys(traitCategories[cat]).map(v => (
                        <option key={v} value={v}>{v} ({traitCategories[cat][v]})</option>
                      ))}
                    </optgroup>
                  ))}
                </select>

                {/* Sort Filter */}
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  style={{ background: "rgba(0,0,0,0.5)", border: "1px solid var(--line)", color: "#fff", padding: "10px 14px", borderRadius: 8, fontSize: 13 }}
                >
                  <option value="rank-asc">Rarity: Rare to Common</option>
                  <option value="rank-desc">Rarity: Common to Rare</option>
                  <option value="id-asc">Token ID: Low to High</option>
                  <option value="id-desc">Token ID: High to Low</option>
                </select>
              </div>

            </div>

            {/* Gallery Grid */}
            {loading ? (
              <div style={{ textAlign: "center", padding: "80px 0", color: "var(--fog)" }}>
                <Loader2 className="pulse-icon" size={32} style={{ marginInLine: "auto", marginBottom: 12 }} />
                <p className="mono" style={{ fontSize: 14 }}>Fetching Live Alchemy On-Chain Metadata...</p>
              </div>
            ) : errorMsg ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "var(--magenta)" }}>{errorMsg}</div>
            ) : (
              <div>
                <div style={{ fontSize: 12, color: "var(--fog)", marginBottom: 16 }} className="mono">
                  Showing {filteredNFTs.length} NFTs
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 16 }}>
                  {filteredNFTs.map((nft) => (
                    <div key={nft.id} onClick={() => setSelectedNft(nft)} className="glass nft-card" style={{ padding: 12, borderRadius: 12 }}>
                      <NFTImage src={nft.image} name={nft.name} id={nft.id} />
                      <div style={{ marginTop: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>#{nft.id}</span>
                          <span className="mono" style={{ fontSize: 10, color: "var(--lime)", background: "rgba(212,255,0,0.1)", padding: "2px 6px", borderRadius: 4 }}>
                            Rank #{nft.rank}
                          </span>
                        </div>
                        <div className="mono" style={{ fontSize: 11, color: "var(--fog)", marginTop: 4 }}>{nft.type}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 3. STAKING VIEW */}
        {view === "staking" && (
          <div>
            <h1 className="disp" style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>$PUNK Staking Vault</h1>
            <p style={{ color: "var(--fog)", fontSize: 14, marginBottom: 24 }}>
              Stake your Origin Punks to earn daily $PUNK tokens. Higher rarity rank provides higher daily yield multiplier.
            </p>

            <CountdownTimer />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20, marginTop: 24 }}>
              {/* Unstaked Holdings */}
              <div className="glass" style={{ padding: 20, borderRadius: 16 }}>
                <h3 className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Wallet NFTs ({userNfts.length})</h3>
                {userNfts.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--fog)" }}>No NFTs available in connected wallet.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 300, overflowY: "auto" }} className="custom-scroll">
                    {userNfts.map((nft) => (
                      <div key={nft.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(0,0,0,0.3)", padding: 10, borderRadius: 8 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>#{nft.id}</div>
                          <div className="mono" style={{ fontSize: 10, color: "var(--lime)" }}>+{nft.dailyReward || 50} $PUNK/day</div>
                        </div>
                        <button onClick={() => toggleStake(nft)} className="btn-lime" style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12 }}>
                          Stake
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Staked Vault */}
              <div className="glass" style={{ padding: 20, borderRadius: 16, borderColor: "var(--lime)" }}>
                <h3 className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: "var(--lime)" }}>Staked Vault ({stakedNfts.length})</h3>
                {stakedNfts.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--fog)" }}>No NFTs staked in vault currently.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 300, overflowY: "auto" }} className="custom-scroll">
                    {stakedNfts.map((nft) => (
                      <div key={nft.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(0,0,0,0.3)", padding: 10, borderRadius: 8 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>#{nft.id}</div>
                          <div className="mono" style={{ fontSize: 10, color: "var(--lime)" }}>Active Yielding</div>
                        </div>
                        <button onClick={() => toggleStake(nft)} className="btn-outline" style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12 }}>
                          Unstake
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 4. MY COLLECTION VIEW */}
        {view === "my-collection" && (
          <div>
            <h1 className="disp" style={{ fontSize: 28, fontWeight: 800, marginBottom: 16 }}>My Origin Punks</h1>
            {!wallet ? (
              <div className="glass" style={{ padding: 50, textAlign: "center", borderRadius: 16 }}>
                <Wallet size={36} color="var(--fog)" style={{ marginBottom: 12 }} />
                <p style={{ color: "var(--fog)", fontSize: 14 }}>Connect wallet to inspect your on-chain assets.</p>
                <button onClick={() => setWalletModalOpen(true)} className="btn-lime" style={{ marginTop: 16, padding: "10px 20px", borderRadius: 8 }}>Connect Wallet</button>
              </div>
            ) : userNftsLoading ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "var(--fog)" }} className="mono">Querying holdings for {short(wallet.address)}...</div>
            ) : userNfts.length === 0 ? (
              <div className="glass" style={{ padding: 40, textAlign: "center", borderRadius: 16 }}>
                <AlertCircle size={32} color="var(--magenta)" style={{ marginBottom: 12 }} />
                <h3 className="disp" style={{ fontSize: 18, fontWeight: 700 }}>No NFTs Found in Wallet</h3>
                <p style={{ color: "var(--fog)", fontSize: 13, marginTop: 4 }}>This connected address does not hold any Origin Punks.</p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 16 }}>
                {userNfts.map((nft) => (
                  <div key={nft.id} onClick={() => setSelectedNft(nft)} className="glass nft-card" style={{ padding: 12, borderRadius: 12 }}>
                    <NFTImage src={nft.image} name={nft.name} id={nft.id} />
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>#{nft.id}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--lime)", marginTop: 2 }}>Owned Asset</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 5. DASHBOARD ANALYTICS */}
        {view === "dashboard" && (
          <div>
            <h1 className="disp" style={{ fontSize: 28, fontWeight: 800, marginBottom: 20 }}>Contract Analytics</h1>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
              <div className="glass" style={{ padding: 20, borderRadius: 12 }}>
                <div style={{ fontSize: 12, color: "var(--fog)" }}>CONTRACT SYMBOL</div>
                <div className="disp mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>{contractData?.contract?.symbol || "PUNK"}</div>
              </div>
              <div className="glass" style={{ padding: 20, borderRadius: 12 }}>
                <div style={{ fontSize: 12, color: "var(--fog)" }}>TOKEN STANDARD</div>
                <div className="disp mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>{contractData?.contract?.tokenType || "ERC-721"}</div>
              </div>
              <div className="glass" style={{ padding: 20, borderRadius: 12 }}>
                <div style={{ fontSize: 12, color: "var(--fog)" }}>TOTAL INDEXED NFTS</div>
                <div className="disp mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 6, color: "var(--lime)" }}>{collection.length}</div>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* NFT DETAIL MODAL */}
      <AnimatePresence>
        {selectedNft && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelectedNft(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div onClick={(e) => e.stopPropagation()} className="glass" style={{ width: "100%", maxWidth: 640, borderRadius: 16, padding: 24, position: "relative" }}>
              <button onClick={() => setSelectedNft(null)} className="btn-outline" style={{ position: "absolute", top: 16, right: 16, borderRadius: 999, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}><X size={16} /></button>
              
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                <div>
                  <NFTImage src={selectedNft.image} name={selectedNft.name} id={selectedNft.id} />
                  <a href={`${CHAIN_EXPLORER_URL}/token/${COLLECTION_ADDRESS}/instance/${selectedNft.id}`} target="_blank" rel="noreferrer" className="btn-outline" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%", marginTop: 12, padding: "8px 0", borderRadius: 8, fontSize: 12, textDecoration: "none" }}>
                    Blockscout Explorer <ExternalLink size={12} />
                  </a>
                </div>

                <div>
                  <h2 className="disp" style={{ fontSize: 22, fontWeight: 800 }}>{selectedNft.name}</h2>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <span className="mono" style={{ fontSize: 11, background: "rgba(212,255,0,0.1)", color: "var(--lime)", padding: "2px 8px", borderRadius: 4 }}>Rarity Rank #{selectedNft.rank}</span>
                    <span className="mono" style={{ fontSize: 11, background: "rgba(255,255,255,0.05)", color: "var(--fog)", padding: "2px 8px", borderRadius: 4 }}>Score {selectedNft.rarityScore}</span>
                  </div>

                  <h4 style={{ fontSize: 12, textTransform: "uppercase", marginTop: 18, color: "var(--lime)", letterSpacing: "0.05em" }}>On-Chain Attributes</h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, maxHeight: 200, overflowY: "auto" }} className="custom-scroll">
                    {selectedNft.attributes.map((attr, idx) => (
                      <div key={idx} style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--line)", padding: "6px 10px", borderRadius: 6, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span style={{ color: "var(--fog)" }}>{attr.trait_type}</span>
                        <span style={{ fontWeight: 600, color: "#fff" }}>{attr.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CONNECT WALLET MODAL */}
      <AnimatePresence>
        {walletModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setWalletModalOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div onClick={(e) => e.stopPropagation()} className="glass" style={{ width: "100%", maxWidth: 380, borderRadius: 16, padding: 22 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 className="disp" style={{ fontSize: 18, fontWeight: 700 }}>Connect Web3 Wallet</h3>
                <button onClick={() => setWalletModalOpen(false)} className="btn-outline" style={{ border: "none" }}><X size={16} /></button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {/* EIP-6963 Discovered Extension Wallets */}
                {discoveredWallets.map((w) => (
                  <button key={w.info.uuid} onClick={() => connectInjected(w)} className="btn-outline" style={{ padding: 12, borderRadius: 10, textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
                    <img src={w.info.icon} alt="" width={24} height={24} style={{ borderRadius: 4 }} />
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{w.info.name}</span>
                  </button>
                ))}

                {/* WalletConnect Option */}
                <button onClick={connectWalletConnect} className="btn-outline" style={{ padding: 12, borderRadius: 10, textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
                  <Zap size={20} color="var(--cyan)" />
                  <span style={{ fontSize: 14, fontWeight: 600 }}>WalletConnect (QR Code)</span>
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ACCOUNT DETAILS MODAL */}
      <AnimatePresence>
        {accountModalOpen && wallet && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setAccountModalOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div onClick={(e) => e.stopPropagation()} className="glass" style={{ width: "100%", maxWidth: 360, borderRadius: 16, padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 className="disp" style={{ fontSize: 16, fontWeight: 700 }}>Account Info</h3>
                <button onClick={() => setAccountModalOpen(false)} className="btn-outline" style={{ border: "none" }}><X size={16} /></button>
              </div>

              <div className="mono" style={{ fontSize: 12, color: "var(--fog)", background: "rgba(0,0,0,0.3)", padding: 12, borderRadius: 8, wordBreak: "break-all" }}>
                {wallet.address}
              </div>

              <button onClick={disconnectWallet} className="btn-outline" style={{ width: "100%", marginTop: 16, padding: "10px 0", borderRadius: 8, color: "var(--magenta)", borderColor: "var(--magenta)" }}>
                Disconnect Wallet
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* TOAST NOTIFICATION */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 15 }} className="glass mono" style={{ position: "fixed", bottom: 24, right: 24, padding: "12px 20px", borderRadius: 8, fontSize: 13, color: "var(--lime)", border: "1px solid var(--lime)", zIndex: 120 }}>
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
