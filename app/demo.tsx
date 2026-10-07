"use client";

import { useCallback, useRef, useState } from "react";

// Paste real Preprod tx hashes here once the on-chain flow is wired up.
// When empty, the UI shows simulated hashes (no explorer link).
const REAL_TX: Record<ScenarioId, { lock?: string; settle?: string }> = {
  fresh: { lock: "", settle: "" },
  stale: { lock: "", settle: "" },
};
const EXPLORER = "https://preprod.cardanoscan.io/transaction/";

const QUERY_PRICE = 1; // USDM
const FEE_RATE = 0.02; // marketplace fee on successful delivery

type ScenarioId = "fresh" | "stale";
type StepState = "idle" | "active" | "done" | "fail";

type Scenario = {
  id: ScenarioId;
  label: string;
  title: string;
  blurb: string;
  maxAgeSec: number;
  // how old the seller's data is when it arrives, in seconds
  deliveredAge: () => number;
};

const SCENARIOS: Scenario[] = [
  {
    id: "fresh",
    label: "Demo 1",
    title: "Fresh delivery",
    blurb: "Agent buys ETH/USD that must be no more than 10 seconds old.",
    maxAgeSec: 10,
    deliveredAge: () => 1.1 + Math.random() * 1.6,
  },
  {
    id: "stale",
    label: "Demo 2",
    title: "Impossible freshness promise",
    blurb: "Agent demands ETH/USD no more than 0.000001 seconds old.",
    maxAgeSec: 0.000001,
    deliveredAge: () => 0.012 + Math.random() * 0.02,
  },
];

type Delivery = {
  price: number;
  observedAt: number;
  deliveredAt: number;
  age: number;
};

type Run = {
  steps: StepState[];
  delivery?: Delivery;
  passed?: boolean;
  lockTx?: string;
  settleTx?: string;
  lockedAt?: number;
  settledAt?: number;
};

const STEP_LABELS = [
  "Request posted",
  "Payment locked in escrow",
  "Data delivered",
  "Freshness check",
  "Settlement",
];

const emptyRun = (): Run => ({ steps: STEP_LABELS.map(() => "idle") });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeHash() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchEthPrice(): Promise<number> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(
      "https://api.coinbase.com/v2/prices/ETH-USD/spot",
      { signal: ctrl.signal, cache: "no-store" },
    );
    clearTimeout(t);
    const json = await res.json();
    const p = parseFloat(json?.data?.amount);
    if (Number.isFinite(p)) return p;
  } catch {}
  return 3800 + Math.random() * 40;
}

function formatAge(sec: number) {
  if (sec >= 1) return `${sec.toFixed(2)} s`;
  if (sec >= 0.001) return `${(sec * 1000).toFixed(1)} ms`;
  if (sec >= 0.000001) return `${(sec * 1_000_000).toFixed(0)} µs`;
  return `${(sec * 1_000_000_000).toFixed(0)} ns`;
}

function formatLimit(sec: number) {
  if (sec >= 1) return `${sec} s`;
  return `${sec.toFixed(6)} s`;
}

function formatTime(ms: number) {
  const d = new Date(ms);
  return (
    d.toLocaleTimeString("en-GB", { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export default function Demo() {
  const [runs, setRuns] = useState<Record<ScenarioId, Run>>({
    fresh: emptyRun(),
    stale: emptyRun(),
  });
  const [busy, setBusy] = useState<Record<ScenarioId, boolean>>({
    fresh: false,
    stale: false,
  });
  const runIdRef = useRef<Record<ScenarioId, number>>({ fresh: 0, stale: 0 });

  const play = useCallback(async (s: Scenario) => {
    const myRun = ++runIdRef.current[s.id];
    const alive = () => runIdRef.current[s.id] === myRun;
    const patch = (fn: (r: Run) => Run) =>
      alive() && setRuns((prev) => ({ ...prev, [s.id]: fn(prev[s.id]) }));
    const setStep = (i: number, st: StepState) =>
      patch((r) => {
        const steps = [...r.steps];
        steps[i] = st;
        return { ...r, steps };
      });

    setBusy((b) => ({ ...b, [s.id]: true }));
    setRuns((prev) => ({ ...prev, [s.id]: emptyRun() }));

    setStep(0, "active");
    await wait(700);
    setStep(0, "done");

    setStep(1, "active");
    await wait(1100);
    const lockTx = REAL_TX[s.id].lock || fakeHash();
    patch((r) => ({ ...r, lockTx, lockedAt: Date.now() }));
    setStep(1, "done");

    setStep(2, "active");
    const price = await fetchEthPrice();
    await wait(600);
    const deliveredAt = Date.now();
    const age = s.deliveredAge();
    const delivery: Delivery = {
      price,
      deliveredAt,
      observedAt: deliveredAt - age * 1000,
      age,
    };
    patch((r) => ({ ...r, delivery }));
    setStep(2, "done");

    setStep(3, "active");
    await wait(1200);
    const passed = age <= s.maxAgeSec;
    patch((r) => ({ ...r, passed }));
    setStep(3, passed ? "done" : "fail");

    setStep(4, "active");
    await wait(1100);
    const settleTx = REAL_TX[s.id].settle || fakeHash();
    patch((r) => ({ ...r, settleTx, settledAt: Date.now() }));
    setStep(4, passed ? "done" : "fail");

    if (alive()) setBusy((b) => ({ ...b, [s.id]: false }));
  }, []);

  const reset = () => {
    runIdRef.current.fresh++;
    runIdRef.current.stale++;
    setRuns({ fresh: emptyRun(), stale: emptyRun() });
    setBusy({ fresh: false, stale: false });
  };

  const anyBusy = busy.fresh || busy.stale;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-8">
      <header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-emerald-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            Cardano Preprod · Masumi escrow
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Freshproof
          </h1>
          <p className="mt-2 max-w-xl text-zinc-400">
            A data marketplace where every purchase carries an enforceable
            freshness promise. Meet it, get paid. Miss it, the buyer is
            refunded.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => SCENARIOS.forEach((s) => play(s))}
            disabled={anyBusy}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200 disabled:opacity-40"
          >
            Run both
          </button>
          <button
            onClick={reset}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800"
          >
            Reset
          </button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {SCENARIOS.map((s) => (
          <FlowCard
            key={s.id}
            scenario={s}
            run={runs[s.id]}
            busy={busy[s.id]}
            onRun={() => play(s)}
          />
        ))}
      </div>

      <Ledger runs={runs} />
    </div>
  );
}

function FlowCard({
  scenario: s,
  run,
  busy,
  onRun,
}: {
  scenario: Scenario;
  run: Run;
  busy: boolean;
  onRun: () => void;
}) {
  const d = run.delivery;
  const settled = run.steps[4] === "done" || run.steps[4] === "fail";

  return (
    <section className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="font-mono text-xs uppercase tracking-widest text-zinc-500">
            {s.label}
          </div>
          <h2 className="mt-1 text-xl font-semibold text-white">{s.title}</h2>
          <p className="mt-1 text-sm text-zinc-400">{s.blurb}</p>
        </div>
        <button
          onClick={onRun}
          disabled={busy}
          className="shrink-0 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
        >
          {busy ? "Running…" : settled ? "Run again" : "Run"}
        </button>
      </div>

      {/* Order terms */}
      <div className="mb-6 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 font-mono text-sm">
        <Term k="Feed" v="ETH / USD" />
        <Term k="Max age" v={formatLimit(s.maxAgeSec)} />
        <Term k="Price" v={`${QUERY_PRICE.toFixed(2)} USDM`} />
      </div>

      {/* Steps */}
      <ol className="mb-6 space-y-3">
        {STEP_LABELS.map((label, i) => (
          <Step key={label} label={label} state={run.steps[i]}>
            {i === 0 && run.steps[0] !== "idle" && (
              <>agent → seller: ETH/USD, age ≤ {formatLimit(s.maxAgeSec)}</>
            )}
            {i === 1 && run.lockTx && (
              <>
                {QUERY_PRICE.toFixed(2)} USDM locked ·{" "}
                <TxLink id={s.id} kind="lock" hash={run.lockTx} />
              </>
            )}
            {i === 2 && d && (
              <>
                ${d.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{" "}
                · observed {formatTime(d.observedAt)}
              </>
            )}
            {i === 3 && run.passed !== undefined && d && (
              <>
                age {formatAge(d.age)} {run.passed ? "≤" : ">"} limit{" "}
                {formatLimit(s.maxAgeSec)}
              </>
            )}
            {i === 4 && run.settleTx && (
              <>
                {run.passed ? "released to seller" : "refunded to buyer"} ·{" "}
                <TxLink id={s.id} kind="settle" hash={run.settleTx} />
              </>
            )}
          </Step>
        ))}
      </ol>

      {/* Age gauge */}
      <AgeGauge maxAge={s.maxAgeSec} delivery={d} passed={run.passed} />

      {/* Verdict */}
      <div className="mt-6 min-h-[92px]">
        {settled ? (
          run.passed ? (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
              <div className="text-sm font-semibold text-emerald-300">
                ✓ Promise kept · seller paid
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs text-emerald-200/80">
                <span>Seller receives</span>
                <span className="text-right">
                  {(QUERY_PRICE * (1 - FEE_RATE)).toFixed(2)} USDM
                </span>
                <span>Marketplace fee ({FEE_RATE * 100}%)</span>
                <span className="text-right">
                  {(QUERY_PRICE * FEE_RATE).toFixed(2)} USDM
                </span>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4">
              <div className="text-sm font-semibold text-rose-300">
                ✕ Promise broken · buyer refunded
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs text-rose-200/80">
                <span>Buyer refund</span>
                <span className="text-right">{QUERY_PRICE.toFixed(2)} USDM</span>
                <span>Seller receives</span>
                <span className="text-right">0.00 USDM</span>
              </div>
            </div>
          )
        ) : (
          <div className="flex h-full min-h-[92px] items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-600">
            {busy ? "Settling…" : "Awaiting run"}
          </div>
        )}
      </div>
    </section>
  );
}

function Term({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-zinc-950 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">{k}</div>
      <div className="mt-0.5 truncate text-zinc-100">{v}</div>
    </div>
  );
}

function Step({
  label,
  state,
  children,
}: {
  label: string;
  state: StepState;
  children?: React.ReactNode;
}) {
  const dot = {
    idle: "border-zinc-700 bg-transparent",
    active: "border-amber-400 bg-amber-400/20 animate-pulse",
    done: "border-emerald-400 bg-emerald-400",
    fail: "border-rose-400 bg-rose-400",
  }[state];
  const text = state === "idle" ? "text-zinc-600" : "text-zinc-100";

  return (
    <li className="flex gap-3">
      <span className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 transition ${dot}`} />
      <div className="min-w-0">
        <div className={`text-sm font-medium transition ${text}`}>{label}</div>
        <div className="truncate font-mono text-xs text-zinc-400">
          {children ?? (state === "active" ? "…" : " ")}
        </div>
      </div>
    </li>
  );
}

function AgeGauge({
  maxAge,
  delivery,
  passed,
}: {
  maxAge: number;
  delivery?: Delivery;
  passed?: boolean;
}) {
  // Bar spans 0 → 2× the limit (log-ish clamp so tiny limits still read clearly).
  const ratio = delivery ? delivery.age / maxAge : 0;
  const pct = delivery ? Math.min(100, (ratio / 2) * 100) : 0;
  const color =
    passed === undefined
      ? "bg-zinc-500"
      : passed
        ? "bg-emerald-400"
        : "bg-rose-400";

  return (
    <div>
      <div className="mb-2 flex justify-between font-mono text-xs text-zinc-500">
        <span>Data age at delivery</span>
        <span className={delivery ? "text-zinc-100" : ""}>
          {delivery ? formatAge(delivery.age) : "—"}
        </span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/70" />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-zinc-600">
        <span>0</span>
        <span className="text-zinc-400">limit {formatLimit(maxAge)}</span>
        <span>
          {delivery && ratio > 2 ? `${Math.round(ratio).toLocaleString()}× over` : ""}
        </span>
      </div>
    </div>
  );
}

function TxLink({
  id,
  kind,
  hash,
}: {
  id: ScenarioId;
  kind: "lock" | "settle";
  hash: string;
}) {
  const real = !!REAL_TX[id][kind];
  return real ? (
    <a
      href={EXPLORER + hash}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-400 underline-offset-2 hover:underline"
    >
      {short(hash)}
    </a>
  ) : (
    <span className="text-zinc-300" title="simulated">
      {short(hash)}
    </span>
  );
}

function Ledger({ runs }: { runs: Record<ScenarioId, Run> }) {
  type Row = {
    id: ScenarioId;
    kind: "lock" | "settle";
    time: number;
    demo: string;
    action: string;
    from: string;
    to: string;
    amount: string;
    hash: string;
    tone: "neutral" | "good" | "bad";
  };

  const rows: Row[] = [];
  for (const s of SCENARIOS) {
    const r = runs[s.id];
    if (r.lockTx && r.lockedAt)
      rows.push({
        id: s.id,
        kind: "lock",
        time: r.lockedAt,
        demo: s.label,
        action: "Escrow lock",
        from: "Buyer agent",
        to: "Escrow",
        amount: `${QUERY_PRICE.toFixed(2)} USDM`,
        hash: r.lockTx,
        tone: "neutral",
      });
    if (r.settleTx && r.settledAt)
      rows.push({
        id: s.id,
        kind: "settle",
        time: r.settledAt,
        demo: s.label,
        action: r.passed ? "Release to seller" : "Refund to buyer",
        from: "Escrow",
        to: r.passed ? "Data seller" : "Buyer agent",
        amount: r.passed
          ? `${(QUERY_PRICE * (1 - FEE_RATE)).toFixed(2)} USDM`
          : `${QUERY_PRICE.toFixed(2)} USDM`,
        hash: r.settleTx,
        tone: r.passed ? "good" : "bad",
      });
  }
  rows.sort((a, b) => a.time - b.time);

  const badge = {
    neutral: "bg-zinc-800 text-zinc-300",
    good: "bg-emerald-500/15 text-emerald-300",
    bad: "bg-rose-500/15 text-rose-300",
  };

  return (
    <section className="mt-10 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-white">Transactions</h2>
        <span className="font-mono text-xs text-zinc-500">
          {rows.length} tx
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 py-8 text-center text-sm text-zinc-600">
          Run a demo to see escrow and settlement transactions.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              <tr>
                <th className="pb-3 font-normal">Time</th>
                <th className="pb-3 font-normal">Demo</th>
                <th className="pb-3 font-normal">Action</th>
                <th className="pb-3 font-normal">Flow</th>
                <th className="pb-3 text-right font-normal">Amount</th>
                <th className="pb-3 pl-6 font-normal">Tx hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.map((row) => (
                <tr key={row.hash} className="text-zinc-300">
                  <td className="py-3 font-mono text-xs text-zinc-500">
                    {formatTime(row.time)}
                  </td>
                  <td className="py-3">{row.demo}</td>
                  <td className="py-3">
                    <span className={`rounded-md px-2 py-0.5 text-xs ${badge[row.tone]}`}>
                      {row.action}
                    </span>
                  </td>
                  <td className="py-3 text-xs text-zinc-400">
                    {row.from} → {row.to}
                  </td>
                  <td className="py-3 text-right font-mono">{row.amount}</td>
                  <td className="py-3 pl-6 font-mono text-xs">
                    <TxLink id={row.id} kind={row.kind} hash={row.hash} />
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
