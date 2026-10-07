"use client";

import { useRef, useState } from "react";

// Paste real Preprod tx hashes here once the on-chain flow is wired up.
// When empty, the UI shows simulated hashes (no explorer link).
const REAL_TX: Record<DemoId, { fund?: string; submit?: string; verdict?: string }> = {
  demo1: { fund: "", submit: "", verdict: "" },
  demo2: { fund: "", submit: "", verdict: "" }, // the refund run (≤ 0.000001 s)
};
const EXPLORER = "https://preprod.cardanoscan.io/transaction/";
const FEE_RATE = 0.02; // marketplace fee on successful delivery
const SELLER = {
  name: "fresh-price-oracle",
  agentId: "a7f3c2e91b04d8f6e5a2c9b17d3e0f84c6b5a2918e7d4c3b2a1f0e9d8c7b6a5",
  wallet: "addr_test1qz8f…x4k2m9",
  sla: "≤ 13 s (13 slots)",
};

type DemoId = "demo1" | "demo2";
type TxKind = "fund" | "submit" | "verdict";

/* ----------------------------- datasets ----------------------------- */

type Asset = { id: string; label: string; pair: string; fallback: number };
type PriceTier = { id: string; amount: number; label: string };
type Window = { id: string; sec: number; label: string };

const ASSETS: Asset[] = [
  { id: "AAVE", label: "Aave", pair: "AAVE-USD", fallback: 268.4 },
  { id: "ETH", label: "Ethereum", pair: "ETH-USD", fallback: 3842.15 },
  { id: "BTC", label: "Bitcoin", pair: "BTC-USD", fallback: 112480.5 },
  { id: "ADA", label: "Cardano", pair: "ADA-USD", fallback: 0.812 },
  { id: "SOL", label: "Solana", pair: "SOL-USD", fallback: 214.7 },
];
const PRICES: PriceTier[] = [
  { id: "std", amount: 0.1, label: "Standard" },
  { id: "pri", amount: 0.25, label: "Priority" },
  { id: "pre", amount: 0.5, label: "Premium" },
];
const WINDOWS: Window[] = [
  { id: "1", sec: 1, label: "within ~1 s" },
  { id: "5", sec: 5, label: "within ~5 s" },
  { id: "10", sec: 10, label: "within ~10 s" },
  { id: "30", sec: 30, label: "within ~30 s" },
  { id: "60", sec: 60, label: "within ~60 s" },
  { id: "1us", sec: 0.000001, label: "within 1 µs" },
];

const DATASETS = [
  { id: "trading", label: "Trading", desc: "Spot prices for crypto assets", live: true },
  { id: "sports", label: "Sports odds", desc: "Live match odds", live: false },
  { id: "fx", label: "FX rates", desc: "Fiat currency pairs", live: false },
  { id: "weather", label: "Weather", desc: "Station readings", live: false },
  { id: "onchain", label: "On-chain metrics", desc: "TVL, volume, fees", live: false },
];

/* ------------------------------ helpers ----------------------------- */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeHash() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Approximate Cardano Preprod slot (1 slot = 1 s).
const PREPROD_SLOT_OFFSET = 1655769600;
const slotAt = (ms: number) => Math.floor(ms / 1000) - PREPROD_SLOT_OFFSET;

async function fetchSpot(asset: Asset): Promise<number> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`https://api.coinbase.com/v2/prices/${asset.pair}/spot`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    const p = parseFloat((await res.json())?.data?.amount);
    if (Number.isFinite(p)) return p;
  } catch {}
  return asset.fallback * (1 + (Math.random() - 0.5) * 0.002);
}

function formatAge(sec: number) {
  if (sec >= 1) return `${sec.toFixed(2)} s`;
  if (sec >= 0.001) return `${(sec * 1000).toFixed(1)} ms`;
  return `${(sec * 1_000_000).toFixed(0)} µs`;
}
const formatLimit = (sec: number) => (sec >= 1 ? `${sec} s` : `${sec.toFixed(6)} s`);
const usd = (n: number) =>
  "$" +
  n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 10 ? 4 : 2,
  });
const fmtAmt = (n: number) => n.toFixed(3).replace(/0$/, "");
const fmtSlot = (n: number) => n.toLocaleString("en-US");
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

function formatTime(ms: number) {
  const d = new Date(ms);
  return (
    d.toLocaleTimeString("en-GB", { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function sampleFeed() {
  return { age: 0.4 + Math.random() * 1.2, now: Date.now() };
}

/* ----------------------------- purchase ----------------------------- */

type Receipt = {
  demo: DemoId;
  asset: Asset;
  amount: number;
  windowSec: number;
  phase: number; // 0 requested · 1 funded · 2 delivered · 3 submitted · 4 verdict · 5 settled
  purchaseId: string;
  fundTx?: string;
  submitTx?: string;
  verdictTx?: string;
  price?: number;
  age?: number;
  observedAt?: number;
  tipSlot?: number;
  tipAge?: number;
  passed?: boolean;
};

type Tx = {
  hash: string;
  real: boolean;
  time: number;
  demo: string;
  action: string;
  flow: string;
  amount: number;
  tone: "neutral" | "good" | "bad";
};

async function runPurchase(
  init: Pick<Receipt, "demo" | "asset" | "amount" | "windowSec">,
  ageFor: (windowSec: number) => number,
  update: (r: Receipt) => void,
  addTx: (tx: Tx) => void,
  alive: () => boolean,
) {
  const real = REAL_TX[init.demo];
  const hash = (k: TxKind) => real[k] || fakeHash();
  const demoLabel = init.demo === "demo1" ? "Demo 1" : "Demo 2";
  let r: Receipt = {
    ...init,
    phase: 0,
    purchaseId: `pur_${fakeHash().slice(0, 10)}`,
  };
  const set = (p: Partial<Receipt>) => {
    r = { ...r, ...p };
    if (alive()) update(r);
  };
  set({});

  await wait(900);
  if (!alive()) return;
  set({ phase: 1, fundTx: hash("fund") });
  addTx({
    hash: r.fundTx!,
    real: !!real.fund,
    time: Date.now(),
    demo: demoLabel,
    action: "Escrow lock",
    flow: "Buyer agent → Masumi escrow",
    amount: r.amount,
    tone: "neutral",
  });

  const price = await fetchSpot(init.asset);
  await wait(700);
  if (!alive()) return;
  const now = Date.now();
  const age = ageFor(init.windowSec);
  const tipAge = 0.2 + Math.random() * 0.7;
  set({
    phase: 2,
    price,
    age,
    observedAt: now - age * 1000,
    tipSlot: slotAt(now - tipAge * 1000),
    tipAge,
  });

  await wait(900);
  if (!alive()) return;
  set({ phase: 3, submitTx: hash("submit") });

  await wait(1100);
  if (!alive()) return;
  const passed = age <= init.windowSec;
  set({ phase: 4, passed, verdictTx: hash("verdict") });
  addTx({
    hash: r.verdictTx!,
    real: !!real.verdict,
    time: Date.now(),
    demo: demoLabel,
    action: passed ? "Release to seller" : "Refund to buyer",
    flow: passed ? "Masumi escrow → Data seller" : "Masumi escrow → Buyer agent",
    amount: passed ? r.amount * (1 - FEE_RATE) : r.amount,
    tone: passed ? "good" : "bad",
  });

  await wait(500);
  set({ phase: 5 });
}

/* -------------------------------- page ------------------------------ */

export default function Demo() {
  const [txs, setTxs] = useState<Tx[]>([]);
  const addTx = (tx: Tx) => setTxs((t) => [...t, tx]);

  const earned = txs
    .filter((t) => t.tone === "good")
    .reduce((s, t) => s + (t.amount / (1 - FEE_RATE)) * FEE_RATE, 0);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-8">
      <header className="mb-10">
        <div className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-indigo-600">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-500 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
          </span>
          Cardano Preprod · Masumi escrow · USDM
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
          FOR{" "}
          <span className="text-zinc-400">(Fresh Or Refund)</span>
        </h1>
        <p className="mt-2 max-w-xl text-zinc-500">
          A data marketplace where every purchase carries an enforceable
          freshness promise. Meet it, get paid. Miss it, the buyer is refunded.
        </p>
      </header>

      <QueryConsole addTx={addTx} earned={earned} txs={txs} />
      <Ledger txs={txs} />
    </div>
  );
}

/* ---------------------------- Demo 1 console ------------------------ */

type Message =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "receipt"; receipt: Receipt }
  | { id: string; kind: "note"; title: string; rows: [string, React.ReactNode][] };

function QueryConsole({
  addTx,
  earned,
  txs,
}: {
  addTx: (tx: Tx) => void;
  earned: number;
  txs: Tx[];
}) {
  const [dataset, setDataset] = useState<string | null>(null);
  const [asset, setAsset] = useState(ASSETS[1]);
  const [tier, setTier] = useState(PRICES[0]);
  const [win, setWin] = useState(WINDOWS[2]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  const push = (m: Message) => {
    setMessages((ms) => [...ms, m]);
    setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
  };

  const prompts = [
    `Give me the latest ${asset.id} price`,
    `How fresh is the ${asset.id} feed right now?`,
    `Show me the seller's Masumi registry record`,
    `What has the protocol earned?`,
  ];

  async function ask(text: string) {
    if (busy || !text.trim()) return;
    const myGen = gen.current;
    const alive = () => gen.current === myGen;
    push({ id: crypto.randomUUID(), kind: "user", text });
    setInput("");
    const q = text.toLowerCase();

    if (q.includes("earn") || q.includes("fee")) {
      const settled = txs.filter((t) => t.tone !== "neutral").length;
      push({
        id: crypto.randomUUID(),
        kind: "note",
        title: "protocol earnings",
        rows: [
          ["fees collected", `${fmtAmt(earned)} USDM`],
          ["settled purchases", `${settled}`],
          ["fee rule", `${FEE_RATE * 100}% of each approved delivery · nothing on refunds`],
        ],
      });
      return;
    }
    if (q.includes("registry") || q.includes("record") || q.includes("seller")) {
      push({
        id: crypto.randomUUID(),
        kind: "note",
        title: "masumi registry",
        rows: [
          ["agent", SELLER.name],
          ["agent id", <Hash key="a" hash={SELLER.agentId} />],
          ["wallet", SELLER.wallet],
          ["network", "Cardano Preprod"],
          ["pricing", PRICES.map((p) => `${p.label} ${fmtAmt(p.amount)} USDM`).join(" · ")],
          ["advertised sla", SELLER.sla],
          ["status", <span key="s" className="text-emerald-700">online</span>],
        ],
      });
      return;
    }
    if (q.includes("fresh") && !q.includes("price")) {
      const { age, now } = sampleFeed();
      push({
        id: crypto.randomUUID(),
        kind: "note",
        title: `${asset.id} feed health`,
        rows: [
          ["last observation", `${formatAge(age)} ago · ${formatTime(now - age * 1000)}`],
          ["preprod tip", `slot ${fmtSlot(slotAt(now))}`],
          ["your window", `${formatLimit(win.sec)} · ${age <= win.sec ? "currently inside it" : "currently outside it"}`],
        ],
      });
      return;
    }

    // Default: paid price query
    const id = crypto.randomUUID();
    setBusy(true);
    await runPurchase(
      { demo: win.sec < 1 ? "demo2" : "demo1", asset, amount: tier.amount, windowSec: win.sec },
      (w) =>
        w < 0.001
          ? 0.012 + Math.random() * 0.02 // no seller can deliver within a microsecond
          : Math.min(w * 0.45, 2) + Math.random() * Math.min(w * 0.4, 0.8),
      (receipt) => {
        setMessages((ms) =>
          ms.some((m) => m.id === id)
            ? ms.map((m) => (m.id === id ? { id, kind: "receipt", receipt } : m))
            : [...ms, { id, kind: "receipt", receipt }],
        );
        setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
      },
      addTx,
      alive,
    );
    if (alive()) setBusy(false);
  }

  const clear = () => {
    gen.current++;
    setMessages([]);
    setBusy(false);
  };

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <SectionHead
        label="Live demo"
        title="Buy fresh data · enforce the promise"
        blurb="Choose a dataset, set the price and freshness you need, then ask."
        action={
          messages.length > 0 && (
            <button
              onClick={clear}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-50"
            >
              Clear
            </button>
          )
        }
      />

      {/* Dataset types */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {DATASETS.map((d) => {
          const on = dataset === d.id;
          return (
            <button
              key={d.id}
              disabled={!d.live}
              onClick={() => setDataset(on ? null : d.id)}
              className={`rounded-xl border p-3 text-left transition ${
                on
                  ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500"
                  : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
              } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
            >
              <div className="text-sm font-medium text-zinc-900">{d.label}</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {d.live ? d.desc : "Coming soon"}
              </div>
            </button>
          );
        })}
      </div>

      {/* Three-column picker */}
      {dataset === "trading" && (
        <div className="mt-4 grid animate-[fadeIn_.25s_ease-out] gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 sm:grid-cols-3">
          <Column title="Dataset">
            {ASSETS.map((a) => (
              <Pick key={a.id} on={asset.id === a.id} onClick={() => setAsset(a)}>
                <span className="font-mono font-medium">{a.id}</span>
                <span className="text-zinc-500">{a.label}</span>
              </Pick>
            ))}
          </Column>
          <Column title="Price per query">
            {PRICES.map((p) => (
              <Pick key={p.id} on={tier.id === p.id} onClick={() => setTier(p)}>
                <span className="font-mono font-medium">{fmtAmt(p.amount)} USDM</span>
                <span className="text-zinc-500">{p.label}</span>
              </Pick>
            ))}
          </Column>
          <Column title="Freshness">
            {WINDOWS.map((w) => (
              <Pick key={w.id} on={win.id === w.id} onClick={() => setWin(w)}>
                <span className="font-mono font-medium">≤ {formatLimit(w.sec)}</span>
                <span className="text-zinc-500">{w.label}</span>
              </Pick>
            ))}
          </Column>
        </div>
      )}

      {/* Thread */}
      {messages.length > 0 && (
        <div className="mt-6 space-y-4">
          {messages.map((m) =>
            m.kind === "user" ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-zinc-900 px-4 py-2 text-sm text-white">
                  {m.text}
                </div>
              </div>
            ) : m.kind === "receipt" ? (
              <ReceiptView key={m.id} r={m.receipt} />
            ) : (
              <NoteView key={m.id} title={m.title} rows={m.rows} />
            ),
          )}
          <div ref={bottom} />
        </div>
      )}

      {/* Prompt chips + input */}
      {dataset === "trading" && (
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 font-mono text-xs uppercase tracking-widest text-zinc-400">
              Next
            </span>
            {prompts.map((p) => (
              <button
                key={p}
                disabled={busy}
                onClick={() => ask(p)}
                className="rounded-full border border-zinc-300 px-3.5 py-1.5 text-sm text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-40"
              >
                {p}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
            className="mt-3 flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask for ${asset.id} data · ${fmtAmt(tier.amount)} USDM · ≤ ${formatLimit(win.sec)}`}
              className="min-w-0 flex-1 rounded-xl border border-zinc-200 px-4 py-2.5 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
            <button
              disabled={busy || !input.trim()}
              className="rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40"
            >
              {busy ? "Running…" : "Ask"}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white p-3">
      <div className="mb-2 px-2 font-mono text-[10px] uppercase tracking-widest text-zinc-400">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Pick({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
        on ? "bg-indigo-50 text-indigo-900 ring-1 ring-indigo-200" : "hover:bg-zinc-50"
      }`}
    >
      {children}
    </button>
  );
}

function SectionHead({
  label,
  title,
  blurb,
  action,
}: {
  label: string;
  title: string;
  blurb: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <div className="font-mono text-xs uppercase tracking-widest text-zinc-400">{label}</div>
        <h2 className="mt-1 text-xl font-semibold text-zinc-900">{title}</h2>
        <p className="mt-1 text-sm text-zinc-500">{blurb}</p>
      </div>
      {action}
    </div>
  );
}

/* ------------------------------ receipt ----------------------------- */

function ReceiptView({ r }: { r: Receipt }) {
  const sellerAmt = r.amount * (1 - FEE_RATE);
  const feeAmt = r.amount * FEE_RATE;
  const windowSlots = Math.max(1, Math.round(r.windowSec));
  const observedSlot = r.observedAt ? slotAt(r.observedAt) : 0;
  const slotsBehind = r.tipSlot ? Math.max(0, r.tipSlot - observedSlot) : 0;
  const subSlot = r.windowSec < 1;

  const rows: [string, React.ReactNode, boolean?][] = [];
  rows.push([
    "request",
    `${r.asset.id}/USD spot · ${fmtAmt(r.amount)} USDM · max age ${formatLimit(r.windowSec)}`,
  ]);
  if (r.phase >= 1)
    rows.push([
      "fund",
      <>
        <Hash hash={r.fundTx!} demo={r.demo} kind="fund" /> · {r.purchaseId} · buyer agent locked{" "}
        {fmtAmt(r.amount)} USDM in Masumi escrow
      </>,
    ]);
  if (r.phase >= 2 && r.price !== undefined) {
    rows.push([
      "result",
      <span key="p" className="text-zinc-900">
        {r.asset.id}/USD {usd(r.price)}
      </span>,
      true,
    ]);
    rows.push([
      "delivered",
      `observed at slot ${fmtSlot(observedSlot)} · ${formatTime(r.observedAt!)} · signed by ${SELLER.name}`,
    ]);
    rows.push([
      "data age at delivery",
      subSlot
        ? `${formatAge(r.age!)} · inside the current slot; the Preprod tip ${fmtSlot(r.tipSlot!)} is itself ${r.tipAge!.toFixed(1)} s old`
        : `${formatAge(r.age!)} · observed ${slotsBehind} slot${slotsBehind === 1 ? "" : "s"} behind the Preprod tip ${fmtSlot(r.tipSlot!)}, which is itself ${r.tipAge!.toFixed(1)} s old`,
      true,
    ]);
    rows.push([
      "your window",
      subSlot
        ? `${formatLimit(r.windowSec)} · the seller promises ${SELLER.sla}`
        : `${r.windowSec} s · the seller promises ${SELLER.sla}`,
      true,
    ]);
    const passes = r.age! <= r.windowSec;
    rows.push([
      "sla floor",
      subSlot ? (
        <span className={passes ? "text-emerald-700" : "text-rose-600"}>
          observed within {formatLimit(r.windowSec)} of delivery · the delivery{" "}
          {passes ? "clears it" : `misses it by ${formatAge(r.age! - r.windowSec)}`}
        </span>
      ) : (
        <span className={passes ? "text-emerald-700" : "text-rose-600"}>
          slot {fmtSlot(r.tipSlot! - windowSlots)} · the delivery {passes ? "clears it" : "misses it"}
        </span>
      ),
    ]);
  }
  if (r.phase >= 3)
    rows.push([
      "submit",
      <>
        <Hash hash={r.submitTx!} demo={r.demo} kind="submit" /> · the seller&apos;s wallet submitted
        the result hash it fetched
      </>,
    ]);
  if (r.phase >= 4)
    rows.push([
      "verdict",
      <>
        <span className={r.passed ? "text-emerald-700" : "text-rose-600"}>
          {r.passed ? "APPROVE" : "REJECT"}
        </span>{" "}
        · <Hash hash={r.verdictTx!} demo={r.demo} kind="verdict" />
      </>,
      true,
    ]);
  if (r.phase >= 4)
    rows.push([
      "split",
      r.passed
        ? `seller ${fmtAmt(sellerAmt)} · protocol fee ${fmtAmt(feeAmt)} · total ${fmtAmt(r.amount)} USDM`
        : `buyer refund ${fmtAmt(r.amount)} · seller 0 · protocol fee 0 USDM`,
    ]);

  const pending = [
    "locking payment in escrow…",
    "waiting for seller delivery…",
    "seller submitting result on-chain…",
    "checking freshness against your window…",
    "settling…",
  ][r.phase];

  return (
    <div className="rounded-lg border border-zinc-200 border-l-4 border-l-indigo-600 bg-white font-mono text-[13px]">
      <div className="flex items-center justify-between border-b border-dashed border-zinc-200 px-4 py-2 text-[11px] uppercase tracking-widest text-zinc-400">
        <span>receipt · {r.purchaseId}</span>
        <span>cardano preprod</span>
      </div>
      <dl>
        {rows.map(([k, v, strong], i) => (
          <div
            key={k + i}
            className="grid grid-cols-[150px_1fr] gap-4 border-b border-dashed border-zinc-200 px-4 py-2 animate-[fadeIn_.3s_ease-out] sm:grid-cols-[180px_1fr]"
          >
            <dt className={strong ? "text-zinc-700" : "text-zinc-400"}>{k}</dt>
            <dd className={strong ? "text-zinc-900" : "text-zinc-600"}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="px-4 py-2.5 text-zinc-500">
        {r.phase >= 5 ? (
          r.passed ? (
            <>
              settled · the data was {formatAge(r.age!)} old and you allowed{" "}
              {formatLimit(r.windowSec)}, so the escrow paid the seller
            </>
          ) : (
            <>
              refunded · the data was {formatAge(r.age!)} old and you allowed{" "}
              {formatLimit(r.windowSec)}, so the escrow refunded the buyer
            </>
          )
        ) : (
          <span className="animate-pulse text-amber-600">{pending}</span>
        )}
      </div>
    </div>
  );
}

function NoteView({ title, rows }: { title: string; rows: [string, React.ReactNode][] }) {
  return (
    <div className="rounded-lg border border-zinc-200 border-l-4 border-l-zinc-400 bg-white font-mono text-[13px] animate-[fadeIn_.3s_ease-out]">
      <div className="border-b border-dashed border-zinc-200 px-4 py-2 text-[11px] uppercase tracking-widest text-zinc-400">
        {title}
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div
            key={k}
            className="grid grid-cols-[150px_1fr] gap-4 border-b border-dashed border-zinc-200 px-4 py-2 last:border-0 sm:grid-cols-[180px_1fr]"
          >
            <dt className="text-zinc-400">{k}</dt>
            <dd className="break-words text-zinc-700">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Hash({ hash, demo, kind }: { hash: string; demo?: DemoId; kind?: TxKind }) {
  const [copied, setCopied] = useState(false);
  const real = demo && kind ? !!REAL_TX[demo][kind] : false;
  const copy = () => {
    navigator.clipboard?.writeText(hash).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <span className="inline-flex items-center gap-1">
      {real ? (
        <a
          href={EXPLORER + hash}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-700 underline decoration-dotted underline-offset-2"
        >
          {short(hash)}
        </a>
      ) : (
        <span className="text-indigo-700 underline decoration-dotted underline-offset-2" title={hash}>
          {short(hash)}
        </span>
      )}
      <button
        type="button"
        onClick={copy}
        aria-label="Copy hash"
        className="text-[11px] text-zinc-400 hover:text-zinc-700"
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

/* ------------------------------- ledger ----------------------------- */

function Ledger({ txs }: { txs: Tx[] }) {
  const badge = {
    neutral: "bg-zinc-100 text-zinc-600",
    good: "bg-emerald-50 text-emerald-700",
    bad: "bg-rose-50 text-rose-700",
  };
  const rows = [...txs].sort((a, b) => a.time - b.time);

  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-zinc-900">Transactions</h2>
        <span className="font-mono text-xs text-zinc-400">{rows.length} tx</span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-8 text-center text-sm text-zinc-400">
          Run a demo to see escrow and settlement transactions.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-widest text-zinc-400">
              <tr>
                <th className="pb-3 font-normal">Time</th>
                <th className="pb-3 font-normal">Demo</th>
                <th className="pb-3 font-normal">Action</th>
                <th className="pb-3 font-normal">Flow</th>
                <th className="pb-3 text-right font-normal">Amount</th>
                <th className="pb-3 pl-6 font-normal">Tx hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((row) => (
                <tr key={row.hash + row.time} className="text-zinc-700">
                  <td className="py-3 font-mono text-xs text-zinc-400">{formatTime(row.time)}</td>
                  <td className="py-3">{row.demo}</td>
                  <td className="py-3">
                    <span className={`rounded-md px-2 py-0.5 text-xs ${badge[row.tone]}`}>
                      {row.action}
                    </span>
                  </td>
                  <td className="py-3 text-xs text-zinc-500">{row.flow}</td>
                  <td className="py-3 text-right font-mono">{fmtAmt(row.amount)} USDM</td>
                  <td className="py-3 pl-6 font-mono text-xs">
                    {row.real ? (
                      <a
                        href={EXPLORER + row.hash}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-700 underline decoration-dotted underline-offset-2"
                      >
                        {short(row.hash)}
                      </a>
                    ) : (
                      <span title={row.hash}>{short(row.hash)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
