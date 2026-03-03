import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, Area, AreaChart } from "recharts";

const fmt = (v) => {
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(1)}億`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return `${Math.round(v)}`;
};
const fmtFull = (v) => {
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)}億円`;
  if (a >= 1e4) return `${Math.round(v / 1e4)}万円`;
  return `${Math.round(v).toLocaleString()}円`;
};

const STOCK_TAX = 0.20315;
const calcAfterTax = (gross, book, type) =>
  type === "stock" ? gross - Math.max(gross - book, 0) * STOCK_TAX : gross * 0.55;

// ── 2バケツシミュレーション
function simulate({
  currentAge, totalAssets, investedAssets,
  incomePhases, loans, oneTimeEvents,
  expensePhases, inflationRate, returnRate,
  pensionAge, pensionAmount,
  privatePensionAge, privatePensionAmount, privatePensionYears,
  saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType,
  salePostSalary, salePostSalaryYears,
}) {
  const MAX = 100;
  const points = [];
  const initTotal = totalAssets * 1e4;
  const initInvested = Math.min(investedAssets * 1e4, initTotal);
  const investRatio = initTotal > 0 ? initInvested / initTotal : 0;

  let investBucket = initInvested;
  let cashBucket = initTotal - initInvested;

  const saleProceeds = saleEnabled
    ? calcAfterTax(saleGross * 1e4, saleBookValue * 1e4, saleTaxType) : 0;

  for (let age = currentAge; age <= MAX; age++) {
    const yearsFromNow = age - currentAge;
    const inflFactor = Math.pow(1 + inflationRate / 100, yearsFromNow);

    // 支出（年齢帯別）
    const activePhase = expensePhases.filter(p => p.enabled && age >= p.fromAge && age < p.toAge);
    const monthlyExp = activePhase.length > 0 ? activePhase[activePhase.length - 1].monthly : (expensePhases.filter(p=>p.enabled).slice(-1)[0]?.monthly ?? 30);
    let annualExpense = monthlyExp * 12 * 1e4 * inflFactor;
    let annualLoan = 0;
    for (const loan of loans) {
      if (loan.enabled && age < loan.endAge) annualLoan += loan.monthly * 12 * 1e4;
    }
    annualExpense += annualLoan;
    let oneTimeExp = 0;
    for (const ev of oneTimeEvents) {
      if (ev.enabled && age === ev.age) oneTimeExp += ev.amount * 1e4;
    }
    annualExpense += oneTimeExp;

    // 収入
    let annualIncome = 0;
    for (const ph of incomePhases) {
      if (ph.enabled && age >= ph.fromAge && age < ph.toAge)
        annualIncome += ph.monthly * 12 * 1e4;
    }
    if (age >= privatePensionAge && age < privatePensionAge + privatePensionYears)
      annualIncome += privatePensionAmount * 12 * 1e4;
    if (age >= pensionAge) annualIncome += pensionAmount * 12 * 1e4;
    if (saleEnabled && age >= saleSaleAge && age < saleSaleAge + salePostSalaryYears)
      annualIncome += salePostSalary * 12 * 1e4;

    const saleEvent = saleEnabled && age === saleSaleAge ? saleProceeds : 0;
    const totalIncome = annualIncome + saleEvent;

    // 収入を比率で按分
    investBucket += totalIncome * investRatio;
    cashBucket   += totalIncome * (1 - investRatio);

    // 運用バケツに利回り
    investBucket *= (1 + returnRate / 100);

    // 支出: 手元から優先、不足分は運用から補填
    const fromCash = Math.min(cashBucket, annualExpense);
    cashBucket -= fromCash;
    investBucket -= (annualExpense - fromCash);

    points.push({
      age,
      invested: investBucket,
      cash: cashBucket,
      assets: investBucket + cashBucket,
      investedClamped: Math.max(investBucket, 0),
      cashClamped: Math.max(cashBucket, 0),
      income: totalIncome,
      expense: annualExpense,
      loanPayment: annualLoan,
      oneTimeExpense: oneTimeExp,
      saleEvent,
    });
  }

  return { data: points, depletionAge: points.find(p => p.assets <= 0)?.age ?? null };
}

// ── UI パーツ
const S = { color: "#8899aa", fontSize: 11, letterSpacing: "0.07em", textTransform: "uppercase" };

const SliderInput = ({ label, value, min, max, step, unit, onChange, display, accent = "#4a9eff" }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
      <span style={S}>{label}</span>
      <span style={{ color: "#e8f0fe", fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {display ? display(value) : `${value}${unit}`}
      </span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))}
      style={{ width: "100%", accentColor: accent, cursor: "pointer" }} />
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 1 }}>
      <span style={{ color: "#334455", fontSize: 10 }}>{min}{unit}</span>
      <span style={{ color: "#334455", fontSize: 10 }}>{max}{unit}</span>
    </div>
  </div>
);

const Sec = ({ title, color = "#4a9eff", children }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color, borderBottom: `1px solid ${color}25`, paddingBottom: 5, marginBottom: 11, fontWeight: 700 }}>{title}</div>
    {children}
  </div>
);

const Toggle = ({ value, onChange, color = "#4a9eff" }) => (
  <div onClick={() => onChange(!value)} style={{ width: 32, height: 18, borderRadius: 9, background: value ? color : "#1e3a5f", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
    <div style={{ position: "absolute", top: 2, left: value ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "#e8f0fe", transition: "left 0.2s" }} />
  </div>
);

const NumCell = ({ value, onChange, min = 0, max = 99999 }) => (
  <input type="number" value={value} min={min} max={max}
    onChange={e => onChange(Number(e.target.value))}
    style={{ width: "100%", background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#e8f0fe", padding: "4px 6px", fontSize: 12, outline: "none", fontFamily: "inherit", fontVariantNumeric: "tabular-nums" }} />
);

const TaxRadio = ({ value, onChange }) => (
  <div style={{ display: "flex", gap: 7, marginBottom: 11 }}>
    {[{ v: "stock", label: "株式譲渡", sub: "20.315%" }, { v: "biz", label: "事業譲渡", sub: "実効~45%" }].map(({ v, label, sub }) => (
      <div key={v} onClick={() => onChange(v)} style={{ flex: 1, border: `1px solid ${value === v ? "#f0a040" : "#1e3a5f"}`, borderRadius: 7, padding: "6px 8px", cursor: "pointer", background: value === v ? "#1a1000" : "#0a1520" }}>
        <div style={{ fontSize: 11, color: value === v ? "#f0a040" : "#778899", fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 10, color: "#445566" }}>{sub}</div>
      </div>
    ))}
  </div>
);

const InfoRow = ({ label, value, color = "#8899aa" }) => (
  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
    <span style={{ color: "#556677", fontSize: 11 }}>{label}</span>
    <span style={{ color, fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
  </div>
);

const StatCard = ({ label, value, color = "#c8d8e8", sub }) => (
  <div style={{ background: "#0a1520", border: "1px solid #1e3a5f", borderRadius: 7, padding: "8px 11px" }}>
    <div style={{ fontSize: 10, color: "#556677", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
    <div style={{ fontSize: 14, fontWeight: 700, color, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    {sub && <div style={{ fontSize: 10, color: "#445566", marginTop: 1 }}>{sub}</div>}
  </div>
);

const AddBtn = ({ onClick, color, children }) => (
  <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: `1px dashed ${color}55`, borderRadius: 6, color, fontSize: 11, padding: "5px 10px", cursor: "pointer", width: "100%", justifyContent: "center", fontFamily: "inherit" }}>
    {children}
  </button>
);

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ background: "#080f18", border: "1px solid #1e3a5f", borderRadius: 8, padding: "10px 13px", fontSize: 11, color: "#c8d8e8", minWidth: 215 }}>
      <div style={{ color: "#4a9eff", fontWeight: 700, marginBottom: 6 }}>{label}歳</div>
      <InfoRow label="合計資産" value={fmtFull(d?.assets ?? 0)} color={(d?.assets ?? 0) >= 0 ? "#e8f0fe" : "#ff5577"} />
      <InfoRow label="  うち運用バケツ" value={fmtFull(Math.max(d?.invested ?? 0, 0))} color="#4a9eff" />
      <InfoRow label="  うち手元バケツ" value={fmtFull(Math.max(d?.cash ?? 0, 0))} color="#4adfb0" />
      <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px solid #1e2a3a" }}>
        <InfoRow label="収入" value={fmtFull(d?.income ?? 0)} color="#88ddaa" />
        <InfoRow label="支出" value={fmtFull(d?.expense ?? 0)} color="#ff8899" />
        {(d?.loanPayment ?? 0) > 0 && <InfoRow label="うちローン" value={fmtFull(d.loanPayment)} color="#aa88ff" />}
        {(d?.oneTimeExpense ?? 0) > 0 && <InfoRow label="うち突発" value={fmtFull(d.oneTimeExpense)} color="#ff6644" />}
        {(d?.saleEvent ?? 0) > 0 && <InfoRow label="売却手取" value={fmtFull(d.saleEvent)} color="#f0c060" />}
      </div>
    </div>
  );
};

const PHASE_COLORS = ["#2adf90", "#4a9eff", "#aa88ff", "#ff9966", "#ffcc44"];

const PhaseRow = ({ phase, idx, onUpdate, onDelete, currentAge }) => {
  const c = PHASE_COLORS[idx % PHASE_COLORS.length];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "14px 1fr 46px 8px 46px 52px 20px", gap: 4, alignItems: "center", marginBottom: 6 }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: phase.enabled ? c : "#334455", margin: "0 auto", cursor: "pointer" }}
        onClick={() => onUpdate({ ...phase, enabled: !phase.enabled })} />
      <input value={phase.label} onChange={e => onUpdate({ ...phase, label: e.target.value })}
        style={{ background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#c8d8e8", padding: "4px 6px", fontSize: 11, outline: "none", fontFamily: "inherit", width: "100%" }} />
      <NumCell value={phase.fromAge} min={currentAge} max={99} onChange={v => onUpdate({ ...phase, fromAge: v })} />
      <span style={{ color: "#334455", fontSize: 10, textAlign: "center" }}>→</span>
      <NumCell value={phase.toAge} min={phase.fromAge + 1} max={100} onChange={v => onUpdate({ ...phase, toAge: v })} />
      <NumCell value={phase.monthly} min={0} max={9999} onChange={v => onUpdate({ ...phase, monthly: v })} />
      <button onClick={onDelete} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
    </div>
  );
};

const LoanRow = ({ loan, onUpdate, onDelete }) => (
  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 50px 46px 20px", gap: 4, alignItems: "center", marginBottom: 6 }}>
    <Toggle value={loan.enabled} onChange={v => onUpdate({ ...loan, enabled: v })} color="#aa88ff" />
    <input value={loan.label} onChange={e => onUpdate({ ...loan, label: e.target.value })}
      style={{ background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#c8d8e8", padding: "4px 6px", fontSize: 11, outline: "none", fontFamily: "inherit", width: "100%" }} />
    <NumCell value={loan.monthly} min={0} max={999} onChange={v => onUpdate({ ...loan, monthly: v })} />
    <NumCell value={loan.endAge} min={1} max={100} onChange={v => onUpdate({ ...loan, endAge: v })} />
    <button onClick={onDelete} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
  </div>
);

const EventRow = ({ ev, onUpdate, onDelete }) => (
  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 50px 54px 20px", gap: 4, alignItems: "center", marginBottom: 6 }}>
    <Toggle value={ev.enabled} onChange={v => onUpdate({ ...ev, enabled: v })} color="#ff6644" />
    <input value={ev.label} onChange={e => onUpdate({ ...ev, label: e.target.value })}
      style={{ background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#c8d8e8", padding: "4px 6px", fontSize: 11, outline: "none", fontFamily: "inherit", width: "100%" }} />
    <NumCell value={ev.age} min={1} max={100} onChange={v => onUpdate({ ...ev, age: v })} />
    <NumCell value={ev.amount} min={0} max={99999} onChange={v => onUpdate({ ...ev, amount: v })} />
    <button onClick={onDelete} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
  </div>
);

const StockCalc = ({ onApply }) => {
  const [shares, setShares] = useState(10000);
  const [price, setPrice] = useState(30000);
  const gross = Math.round(shares * price / 1e4);
  return (
    <div style={{ background: "#0a0800", border: "1px solid #f0a04030", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: "#aa7722", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, fontWeight: 700 }}>株数 × 単価 → グロス計算</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <div>
          <div style={{ ...S, fontSize: 10, marginBottom: 3 }}>株数</div>
          <input type="number" value={shares} min={1} onChange={e => setShares(Number(e.target.value))}
            style={{ width: "100%", background: "#060e18", border: "1px solid #2a1e00", borderRadius: 5, color: "#e8f0fe", padding: "5px 7px", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
        </div>
        <div>
          <div style={{ ...S, fontSize: 10, marginBottom: 3 }}>単価（円/株）</div>
          <input type="number" value={price} min={1} onChange={e => setPrice(Number(e.target.value))}
            style={{ width: "100%", background: "#060e18", border: "1px solid #2a1e00", borderRadius: 5, color: "#e8f0fe", padding: "5px 7px", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <span style={{ color: "#667788", fontSize: 10 }}>売却総額 → </span>
          <span style={{ color: "#f0c060", fontWeight: 700, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{fmtFull(gross * 1e4)}</span>
        </div>
        <button onClick={() => onApply(gross)} style={{ background: "#2a1800", border: "1px solid #f0a04066", borderRadius: 6, color: "#f0a040", fontSize: 11, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
          ↑ 上に反映
        </button>
      </div>
    </div>
  );
};

// ── 2バケツ配分バー
const BucketBar = ({ totalAssets, investedAssets, onChange }) => {
  const invested = Math.min(investedAssets, totalAssets);
  const cash = totalAssets - invested;
  const investPct = totalAssets > 0 ? Math.round(invested / totalAssets * 100) : 0;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ ...S, fontSize: 10 }}>資産配分（運用 / 手元）</span>
        <span style={{ color: "#e8f0fe", fontSize: 12, fontWeight: 600 }}>{investPct}% / {100 - investPct}%</span>
      </div>
      {/* ビジュアルバー */}
      <div style={{ height: 22, borderRadius: 6, overflow: "hidden", display: "flex", border: "1px solid #1e3a5f", marginBottom: 8 }}>
        <div style={{ width: `${investPct}%`, background: "linear-gradient(90deg,#1a4a8a,#2a6adf)", display: "flex", alignItems: "center", justifyContent: "center", transition: "width 0.2s", minWidth: investPct > 5 ? "auto" : 0 }}>
          {investPct > 10 && <span style={{ fontSize: 10, color: "#9ac8ff", fontWeight: 600 }}>運用 {fmtFull(invested * 1e4)}</span>}
        </div>
        <div style={{ flex: 1, background: "linear-gradient(90deg,#0a3028,#0d4038)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {(100 - investPct) > 10 && <span style={{ fontSize: 10, color: "#6ad8a8", fontWeight: 600 }}>手元 {fmtFull(cash * 1e4)}</span>}
        </div>
      </div>
      {/* 運用額スライダー */}
      <div style={{ ...S, fontSize: 10, marginBottom: 3 }}>運用資産額</div>
      <input type="range" min={0} max={totalAssets} step={100} value={invested}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "#4a9eff", cursor: "pointer" }} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 1 }}>
        <span style={{ color: "#334455", fontSize: 10 }}>0（全額手元）</span>
        <span style={{ color: "#334455", fontSize: 10 }}>{fmtFull(totalAssets * 1e4)}（全額運用）</span>
      </div>
    </div>
  );
};

// ── 印刷用スタイル注入
const PRINT_STYLE = `
@media print {
  body { background: #fff !important; color: #111 !important; }
  .no-print { display: none !important; }
  .print-only { display: block !important; }
  .print-only-wrap { display: block !important; }
  .print-page { background: #fff !important; color: #111 !important; padding: 12px !important; }
  .print-section { background: #f8f8f8 !important; border: 1px solid #ccc !important; border-radius: 6px !important; padding: 12px !important; margin-bottom: 10px !important; break-inside: avoid; }
  .print-title { color: #111 !important; }
  .print-value { color: #222 !important; font-weight: 700; }
  .print-label { color: #555 !important; }
  .print-safe { color: #1a7a4a !important; }
  .print-warn { color: #cc2222 !important; }
  @page { margin: 15mm; size: A4; }
}
`;

// ── メイン
export default function App() {
  const [currentAge, setCurrentAge] = useState(45);
  const [totalAssets, setTotalAssets] = useState(5000);
  const [investedAssets, setInvestedAssets] = useState(3000);

  const [incomePhases, setIncomePhases] = useState([
    { id: 1, label: "役員報酬", fromAge: 45, toAge: 52, monthly: 150, enabled: true },
    { id: 2, label: "引継ぎ・その他収入", fromAge: 52, toAge: 60, monthly: 30, enabled: true },
  ]);
  const [nextPhaseId, setNextPhaseId] = useState(3);

  const [loans, setLoans] = useState([
    { id: 1, label: "住宅ローンA", monthly: 15, endAge: 53, enabled: true },
  ]);
  const [nextLoanId, setNextLoanId] = useState(2);

  const [oneTimeEvents, setOneTimeEvents] = useState([
    { id: 1, label: "車の購入", age: 50, amount: 500, enabled: false },
  ]);
  const [nextEventId, setNextEventId] = useState(2);

  const [expensePhases, setExpensePhases] = useState([
    { id: 1, label: "アクティブ期", fromAge: 48, toAge: 65, monthly: 42, enabled: true },
    { id: 2, label: "スロー期",    fromAge: 65, toAge: 80, monthly: 30, enabled: true },
    { id: 3, label: "晩年期",      fromAge: 80, toAge: 101, monthly: 22, enabled: true },
  ]);
  const [nextExpId, setNextExpId] = useState(4);
  const [dwzEnabled, setDwzEnabled] = useState(false);
  const [dwzTargetAge, setDwzTargetAge] = useState(95);
  const [dwzTargetAmount, setDwzTargetAmount] = useState(0);
  const [inflationRate, setInflationRate] = useState(1.5);
  const [returnRate, setReturnRate] = useState(4.0);

  const [pensionAge, setPensionAge] = useState(65);
  const [pensionAmount, setPensionAmount] = useState(22);
  const [privatePensionAge, setPrivatePensionAge] = useState(60);
  const [privatePensionAmount, setPrivatePensionAmount] = useState(10);
  const [privatePensionYears, setPrivatePensionYears] = useState(10);

  const [saleEnabled, setSaleEnabled] = useState(true);
  const [saleSaleAge, setSaleSaleAge] = useState(52);
  const [saleGross, setSaleGross] = useState(30000);
  const [saleBookValue, setSaleBookValue] = useState(1000);
  const [saleTaxType, setSaleTaxType] = useState("stock");
  const [salePostSalary, setSalePostSalary] = useState(50);
  const [salePostSalaryYears, setSalePostSalaryYears] = useState(2);

  const safeInvested = Math.min(investedAssets, totalAssets);
  const investRatioPct = totalAssets > 0 ? Math.round(safeInvested / totalAssets * 100) : 0;

  const simParams = {
    currentAge, totalAssets, investedAssets: safeInvested,
    incomePhases, loans, oneTimeEvents,
    expensePhases, inflationRate, returnRate,
    pensionAge, pensionAmount,
    privatePensionAge, privatePensionAmount, privatePensionYears,
  };

  const withSale = useMemo(() => simulate({
    ...simParams, saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears
  }), [JSON.stringify(simParams), saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears]);

  const noSale = useMemo(() => simulate({
    ...simParams, saleEnabled: false, saleSaleAge: 0, saleGross: 0, saleBookValue: 0, saleTaxType: "stock", salePostSalary: 0, salePostSalaryYears: 0
  }), [JSON.stringify(simParams)]);

  const chartData = useMemo(() => withSale.data.map((d, i) => ({
    ...d,
    assetsNoSale: noSale.data[i]?.assets ?? 0,
    dwzTarget: dwzEnabled && d.age === dwzTargetAge ? dwzTargetAmount * 1e4 : undefined,
  })), [withSale, noSale, dwzEnabled, dwzTargetAge, dwzTargetAmount]);

  const dwzActual = dwzEnabled ? (withSale.data.find(d => d.age === dwzTargetAge)?.assets ?? 0) : 0;
  const dwzDiff = dwzActual - dwzTargetAmount * 1e4;
  const dwzOnTrack = dwzDiff >= 0;

  const afterTax = saleEnabled ? calcAfterTax(saleGross * 1e4, saleBookValue * 1e4, saleTaxType) : 0;
  const taxAmount = saleEnabled ? saleGross * 1e4 - afterTax : 0;
  const isSafe = withSale.depletionAge === null;
  const isNoSaleSafe = noSale.depletionAge === null;
  const impactAt80 = (withSale.data.find(d => d.age === 80)?.assets ?? 0) - (noSale.data.find(d => d.age === 80)?.assets ?? 0);
  const totalLoanMonthly = loans.filter(l => l.enabled).reduce((a, l) => a + l.monthly, 0);
  const enabledEvents = oneTimeEvents.filter(e => e.enabled);

  // ── シナリオ保存
  const [savedScenarios, setSavedScenarios] = useState([]);
  const [compareMode, setCompareMode] = useState(false);
  const [saveNameInput, setSaveNameInput] = useState("");
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [storageReady, setStorageReady] = useState(false);

  const getCurrentParams = useCallback(() => ({
    currentAge, totalAssets, investedAssets,
    incomePhases, loans, oneTimeEvents,
    expensePhases, inflationRate, returnRate,
    pensionAge, pensionAmount,
    privatePensionAge, privatePensionAmount, privatePensionYears,
    saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType,
    salePostSalary, salePostSalaryYears,
    dwzEnabled, dwzTargetAge, dwzTargetAmount,
  }), [currentAge, totalAssets, investedAssets, incomePhases, loans, oneTimeEvents,
    expensePhases, inflationRate, returnRate, pensionAge, pensionAmount,
    privatePensionAge, privatePensionAmount, privatePensionYears,
    saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType,
    salePostSalary, salePostSalaryYears, dwzEnabled, dwzTargetAge, dwzTargetAmount]);

  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get('scenarios');
        if (result?.value) setSavedScenarios(JSON.parse(result.value));
      } catch(e) { /* 初回は空 */ }
      setStorageReady(true);
    })();
  }, []);

  const saveScenario = async (name) => {
    const newScenario = {
      id: Date.now(),
      name,
      savedAt: new Date().toLocaleDateString('ja-JP'),
      params: getCurrentParams(),
    };
    const updated = [...savedScenarios, newScenario];
    setSavedScenarios(updated);
    try { await window.storage.set('scenarios', JSON.stringify(updated)); } catch(e) {}
    setShowSaveModal(false);
    setSaveNameInput("");
  };

  const deleteScenario = async (id) => {
    const updated = savedScenarios.filter(s => s.id !== id);
    setSavedScenarios(updated);
    try { await window.storage.set('scenarios', JSON.stringify(updated)); } catch(e) {}
  };

  const SCENARIO_COLORS = ["#4a9eff","#2adf90","#f0a040","#aa88ff","#ff8866","#ffcc44"];

  // 印刷スタイル注入
  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = PRINT_STYLE;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const P   = { background: "linear-gradient(160deg,#0d1b2a,#0a1520)", border: "1px solid #1e3a5f", borderRadius: 12, padding: "16px 15px" };
  const LP  = { ...P, borderColor: "#f0a04044", background: "linear-gradient(160deg,#150e00,#1a1200)" };
  const IP  = { ...P, borderColor: "#2adf9033", background: "linear-gradient(160deg,#001510,#001a14)" };
  const LOP = { ...P, borderColor: "#aa88ff33", background: "linear-gradient(160deg,#0d0820,#0a0618)" };

  return (
    <div className="print-page" style={{ minHeight: "100vh", width: "100%", boxSizing: "border-box", background: "#060e18", color: "#c8d8e8", fontFamily: "'DM Mono','Fira Code','Courier New',monospace", padding: "20px 16px" }}>

      <div style={{ marginBottom: 18 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.3em", color: "#4a9eff", textTransform: "uppercase", marginBottom: 3 }}>Private Asset Planner v7</div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#e8f0fe" }}>老後資産シミュレーター</h1>
          <div style={{ fontSize: 11, color: "#334455", marginTop: 3 }}>2バケツ方式（運用資産 / 手元資産）対応</div>
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 12 }}>
          <button onClick={() => setShowSaveModal(true)}
            style={{ background: "#0a1e14", border: "1px solid #2adf9066", borderRadius: 8, color: "#2adf90", fontSize: 11, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
            💾 シナリオを保存
          </button>
          <button onClick={handlePrint} className="no-print"
            style={{ background: "#0a1520", border: "1px solid #4a9eff66", borderRadius: 8, color: "#4a9eff", fontSize: 11, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
            📄 PDFで保存
          </button>
          {savedScenarios.length > 0 && (
            <button onClick={() => setCompareMode(m => !m)}
              style={{ background: compareMode ? "#1a0e30" : "#0a1520", border: `1px solid ${compareMode ? "#aa88ff" : "#1e3a5f"}`, borderRadius: 8, color: compareMode ? "#aa88ff" : "#556677", fontSize: 11, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
              ⚖ 比較モード {savedScenarios.length > 0 ? `(${savedScenarios.length})` : ""}
            </button>
          )}
        </div>
      </div>

      {/* 保存モーダル */}
      {showSaveModal && (
        <div style={{ position: "fixed", inset: 0, background: "#000a", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#0d1b2a", border: "1px solid #2adf9066", borderRadius: 14, padding: "24px 28px", minWidth: 300 }}>
            <div style={{ fontSize: 13, color: "#2adf90", fontWeight: 700, marginBottom: 14 }}>シナリオ名を入力</div>
            <input value={saveNameInput} onChange={e => setSaveNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && saveNameInput.trim()) saveScenario(saveNameInput.trim()); }}
              placeholder="例：楽観シナリオ"
              style={{ width: "100%", background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 7, color: "#e8f0fe", padding: "8px 10px", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
              autoFocus />
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => saveNameInput.trim() && saveScenario(saveNameInput.trim())}
                style={{ flex: 1, background: "#0a2a1a", border: "1px solid #2adf9088", borderRadius: 7, color: "#2adf90", fontSize: 12, padding: "8px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
                保存
              </button>
              <button onClick={() => { setShowSaveModal(false); setSaveNameInput(""); }}
                style={{ flex: 1, background: "#0a1520", border: "1px solid #1e3a5f", borderRadius: 7, color: "#556677", fontSize: 12, padding: "8px", cursor: "pointer", fontFamily: "inherit" }}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 比較モード */}
      {compareMode && savedScenarios.length > 0 && (
        <div style={{ background: "linear-gradient(160deg,#0d0820,#0a0618)", border: "1px solid #aa88ff44", borderRadius: 12, padding: "16px 15px", marginBottom: 12 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.13em", textTransform: "uppercase", color: "#aa88ff", marginBottom: 12, fontWeight: 700 }}>⚖ シナリオ比較</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 500 }}>
              <thead>
                <tr>
                  <th style={{ color: "#445566", fontSize: 10, textAlign: "left", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingRight: 12 }}>シナリオ</th>
                  {[65, 70, 75, 80, 85, 90, 95].map(a => (
                    <th key={a} style={{ color: "#445566", fontSize: 10, textAlign: "right", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 8 }}>{a}歳</th>
                  ))}
                  <th style={{ color: "#445566", fontSize: 10, textAlign: "right", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 8 }}>枯渇</th>
                  <th style={{ paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 8 }} />
                </tr>
              </thead>
              <tbody>
                {/* 現在の設定 */}
                {(() => {
                  const color = "#e8f0fe";
                  return (
                    <tr>
                      <td style={{ color, paddingTop: 8, paddingRight: 12, fontSize: 11 }}>
                        <div style={{ fontWeight: 700 }}>◉ 現在の設定</div>
                      </td>
                      {[65, 70, 75, 80, 85, 90, 95].map(a => {
                        const v = withSale.data.find(d => d.age === a)?.assets ?? 0;
                        return <td key={a} style={{ textAlign: "right", paddingTop: 8, paddingLeft: 8, color: v > 0 ? color : "#ff5577", fontVariantNumeric: "tabular-nums" }}>{fmtFull(Math.max(v, 0))}</td>;
                      })}
                      <td style={{ textAlign: "right", paddingTop: 8, paddingLeft: 8, color: isSafe ? "#4adfb0" : "#ff5577" }}>{isSafe ? "安全" : `${withSale.depletionAge}歳`}</td>
                      <td />
                    </tr>
                  );
                })()}
                {savedScenarios.map((sc, si) => {
                  const p = sc.params;
                  const ep = { ...p, investedAssets: Math.min(p.investedAssets, p.totalAssets) };
                  const res = simulate({
                    ...ep,
                    saleEnabled: p.saleEnabled, saleSaleAge: p.saleSaleAge, saleGross: p.saleGross,
                    saleBookValue: p.saleBookValue, saleTaxType: p.saleTaxType,
                    salePostSalary: p.salePostSalary, salePostSalaryYears: p.salePostSalaryYears,
                  });
                  const color = SCENARIO_COLORS[si % SCENARIO_COLORS.length];
                  const safe = res.depletionAge === null;
                  return (
                    <tr key={sc.id}>
                      <td style={{ paddingTop: 8, paddingRight: 12 }}>
                        <div style={{ color, fontWeight: 600, fontSize: 11 }}>{sc.name}</div>
                        <div style={{ color: "#334455", fontSize: 9 }}>{sc.savedAt}</div>
                      </td>
                      {[65, 70, 75, 80, 85, 90, 95].map(a => {
                        const v = res.data.find(d => d.age === a)?.assets ?? 0;
                        return <td key={a} style={{ textAlign: "right", paddingTop: 8, paddingLeft: 8, color: v > 0 ? color : "#ff5577", fontVariantNumeric: "tabular-nums", fontSize: 11 }}>{fmtFull(Math.max(v, 0))}</td>;
                      })}
                      <td style={{ textAlign: "right", paddingTop: 8, paddingLeft: 8, color: safe ? "#4adfb0" : "#ff5577", fontSize: 11 }}>{safe ? "安全" : `${res.depletionAge}歳`}</td>
                      <td style={{ paddingTop: 8, paddingLeft: 8 }}>
                        <button onClick={() => deleteScenario(sc.id)} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 12, padding: 0 }}>✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 印刷専用サマリー（画面では非表示） */}
      <div className="print-only-wrap" style={{ display: "none" }}>
        <div className="print-only" style={{ display: "none", fontFamily: "sans-serif" }}>
          <h2 className="print-title" style={{ fontSize: 18, marginBottom: 4 }}>老後資産シミュレーション結果</h2>
          <div className="print-label" style={{ fontSize: 11, marginBottom: 16 }}>出力日: {new Date().toLocaleDateString('ja-JP')}</div>

          <div className="print-section">
            <div className="print-label" style={{ fontSize: 10, marginBottom: 8, fontWeight: 700 }}>■ 基本設定</div>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <tbody>
                {[
                  ["現在の年齢", `${currentAge}歳`],
                  ["総資産", fmtFull(totalAssets * 1e4)],
                  ["運用資産", fmtFull(safeInvested * 1e4)],
                  ["手元資産", fmtFull((totalAssets - safeInvested) * 1e4)],
                  ["インフレ率", `${inflationRate}%`],
                  ["運用利回り", `${returnRate}%`],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td className="print-label" style={{ padding: "3px 8px 3px 0", width: "40%" }}>{label}</td>
                    <td className="print-value" style={{ padding: "3px 0" }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="print-section">
            <div className="print-label" style={{ fontSize: 10, marginBottom: 8, fontWeight: 700 }}>■ 判定結果</div>
            <div className={isSafe ? "print-safe" : "print-warn"} style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
              {isSafe ? "✓ 生涯 安全圏" : `⚠ ${withSale.depletionAge}歳で資産枯渇リスク`}
            </div>
            {saleEnabled && (
              <div className="print-label" style={{ fontSize: 11 }}>
                会社売却: {saleSaleAge}歳 → 手取り {fmtFull(afterTax)}（税負担 {fmtFull(taxAmount)}）
              </div>
            )}
          </div>

          <div className="print-section">
            <div className="print-label" style={{ fontSize: 10, marginBottom: 8, fontWeight: 700 }}>■ 年齢別残高</div>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {[50,55,60,65,70,75,80,85,90,95].map(a => (
                    <th key={a} className="print-label" style={{ textAlign: "right", padding: "3px 5px", borderBottom: "1px solid #ccc", fontSize: 10 }}>{a}歳</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {[50,55,60,65,70,75,80,85,90,95].map(a => {
                    const v = withSale.data.find(d => d.age === a)?.assets ?? 0;
                    return <td key={a} className={v > 0 ? "print-value" : "print-warn"} style={{ textAlign: "right", padding: "4px 5px", fontSize: 10 }}>{fmtFull(Math.max(v,0))}</td>;
                  })}
                </tr>
              </tbody>
            </table>
          </div>

          {savedScenarios.length > 0 && (
            <div className="print-section">
              <div className="print-label" style={{ fontSize: 10, marginBottom: 8, fontWeight: 700 }}>■ 保存シナリオ比較</div>
              <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th className="print-label" style={{ textAlign: "left", padding: "3px 8px 3px 0", borderBottom: "1px solid #ccc" }}>シナリオ</th>
                    {[65,75,85,95].map(a => (
                      <th key={a} className="print-label" style={{ textAlign: "right", padding: "3px 5px", borderBottom: "1px solid #ccc" }}>{a}歳</th>
                    ))}
                    <th className="print-label" style={{ textAlign: "right", padding: "3px 5px", borderBottom: "1px solid #ccc" }}>枯渇</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="print-value" style={{ padding: "4px 8px 4px 0" }}>◉ 現在</td>
                    {[65,75,85,95].map(a => {
                      const v = withSale.data.find(d => d.age === a)?.assets ?? 0;
                      return <td key={a} className="print-value" style={{ textAlign: "right", padding: "4px 5px" }}>{fmtFull(Math.max(v,0))}</td>;
                    })}
                    <td className={isSafe ? "print-safe" : "print-warn"} style={{ textAlign: "right", padding: "4px 5px" }}>{isSafe ? "安全" : `${withSale.depletionAge}歳`}</td>
                  </tr>
                  {savedScenarios.map(sc => {
                    const p = sc.params;
                    const ep = { ...p, investedAssets: Math.min(p.investedAssets, p.totalAssets) };
                    const res = simulate({ ...ep, saleEnabled: p.saleEnabled, saleSaleAge: p.saleSaleAge, saleGross: p.saleGross, saleBookValue: p.saleBookValue, saleTaxType: p.saleTaxType, salePostSalary: p.salePostSalary, salePostSalaryYears: p.salePostSalaryYears });
                    const safe = res.depletionAge === null;
                    return (
                      <tr key={sc.id}>
                        <td className="print-value" style={{ padding: "4px 8px 4px 0" }}>{sc.name}</td>
                        {[65,75,85,95].map(a => {
                          const v = res.data.find(d => d.age === a)?.assets ?? 0;
                          return <td key={a} className="print-value" style={{ textAlign: "right", padding: "4px 5px" }}>{fmtFull(Math.max(v,0))}</td>;
                        })}
                        <td className={safe ? "print-safe" : "print-warn"} style={{ textAlign: "right", padding: "4px 5px" }}>{safe ? "安全" : `${res.depletionAge}歳`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ステータスバナー */}
      <div style={{ ...P, marginBottom: 12, borderColor: isSafe ? "#1e5f3a" : "#5f1e2a", background: isSafe ? "linear-gradient(135deg,#0a1e14,#0d2018)" : "linear-gradient(135deg,#1e0a10,#200d14)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 10, color: isSafe ? "#4adfb0" : "#ff7799", textTransform: "uppercase", letterSpacing: "0.12em" }}>{isSafe ? "✓ LIFETIME SAFE" : "⚠ DEPLETION RISK"}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: isSafe ? "#4adfb0" : "#ff5577", marginTop: 2 }}>{isSafe ? "生涯 安全圏" : `${withSale.depletionAge}歳で資産枯渇`}</div>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[65, 75, 85, 95].map(a => {
            const v = chartData.find(d => d.age === a)?.assets;
            return <div key={a} style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#556677" }}>{a}歳</div>
              <div style={{ fontSize: 13, color: (v ?? 0) > 0 ? "#c8d8e8" : "#ff5577", fontWeight: 600 }}>{fmtFull(v ?? 0)}</div>
            </div>;
          })}
        </div>
      </div>

      {/* 売却サマリー */}
      {saleEnabled && (
        <div style={{ ...LP, marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 10, color: "#f0a040", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>🏷 会社売却</div>
            <div style={{ fontSize: 17, color: "#f0c060", fontWeight: 700, marginTop: 2 }}>{saleSaleAge}歳 → 手取り {fmtFull(afterTax)}</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 7 }}>
            <StatCard label="税負担" value={fmtFull(taxAmount)} color="#ff8899" />
            <StatCard label="80歳差分" value={(impactAt80 >= 0 ? "+" : "") + fmtFull(impactAt80)} color={impactAt80 >= 0 ? "#4adfb0" : "#ff5577"} sub="あり vs なし" />
            <StatCard label="売却なし" value={isNoSaleSafe ? "生涯安全" : `${noSale.depletionAge}歳`} color={isNoSaleSafe ? "#4adfb0" : "#ff5577"} />
          </div>
        </div>
      )}

      {/* グラフ */}
      <div style={{ ...P, marginBottom: 12 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.13em", textTransform: "uppercase", color: "#4a9eff", marginBottom: 8, fontWeight: 700 }}>資産推移グラフ</div>
        {/* 凡例 */}
        <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
          {[
            { color: "#4a9eff", label: `運用（利回り ${returnRate}%）` },
            { color: "#4adfb0", label: "手元（利回りなし）" },
            { color: "#556677", label: "売却なし 合計", dash: true },
          ].map(({ color, label, dash }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 18, height: 2, borderTop: `2px ${dash ? "dashed" : "solid"}`, borderColor: color }} />
              <span style={{ fontSize: 10, color: "#556677" }}>{label}</span>
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={270}>
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 6, bottom: 0 }}>
            <defs>
              <linearGradient id="gInv" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#4a9eff" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#4a9eff" stopOpacity={0.03} />
              </linearGradient>
              <linearGradient id="gCash" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#4adfb0" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#4adfb0" stopOpacity={0.03} />
              </linearGradient>
              <linearGradient id="gNoSale" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#445566" stopOpacity={0.1} />
                <stop offset="95%" stopColor="#445566" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#0f2030" />
            <XAxis dataKey="age" tick={{ fill: "#445566", fontSize: 10 }} tickFormatter={v => `${v}歳`} interval={4} />
            <YAxis tick={{ fill: "#445566", fontSize: 10 }} tickFormatter={fmt} width={54} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#334455" />
            {incomePhases.filter(p => p.enabled).map((p, i) => (
              <ReferenceLine key={p.id} x={p.fromAge} stroke={PHASE_COLORS[i % PHASE_COLORS.length]} strokeDasharray="2 4" strokeOpacity={0.3} />
            ))}
            {loans.filter(l => l.enabled).map(l => (
              <ReferenceLine key={l.id} x={l.endAge} stroke="#aa88ff" strokeDasharray="2 4" strokeOpacity={0.25} />
            ))}
            {enabledEvents.map(ev => (
              <ReferenceLine key={ev.id} x={ev.age} stroke="#ff6644" strokeDasharray="2 3" strokeOpacity={0.6}
                label={{ value: "💸", fill: "#ff6644", fontSize: 10 }} />
            ))}
            <ReferenceLine x={pensionAge} stroke="#4adfb0" strokeDasharray="3 3" strokeOpacity={0.5}
              label={{ value: "年金", fill: "#4adfb0", fontSize: 9 }} />
            {saleEnabled && (
              <ReferenceLine x={saleSaleAge} stroke="#f0a040" strokeDasharray="4 3"
                label={{ value: "売却", fill: "#f0a040", fontSize: 9 }} />
            )}
            {dwzEnabled && (
              <ReferenceLine x={dwzTargetAge} stroke="#a040f0" strokeDasharray="3 3"
                label={{ value: `DWZ目標 ${fmtFull(dwzTargetAmount * 1e4)}`, fill: "#a040f0", fontSize: 9 }} />
            )}
            {withSale.depletionAge && (
              <ReferenceLine x={withSale.depletionAge} stroke="#ff5577" strokeDasharray="4 3"
                label={{ value: `${withSale.depletionAge}歳`, fill: "#ff5577", fontSize: 10 }} />
            )}
            {/* 売却なし合計（背景点線） */}
            <Area type="monotone" dataKey="assetsNoSale" stroke="#556677" strokeWidth={1.5} fill="url(#gNoSale)" dot={false} strokeDasharray="4 3" />
            {/* 手元バケツ（積み上げ下段） */}
            <Area type="monotone" dataKey="cashClamped" stroke="#4adfb0" strokeWidth={1.5} fill="url(#gCash)" dot={false} stackId="bucket" />
            {/* 運用バケツ（積み上げ上段） */}
            <Area type="monotone" dataKey="investedClamped" stroke="#4a9eff" strokeWidth={2} fill="url(#gInv)" dot={false} stackId="bucket" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* コントロール */}
      <div className="no-print" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))", gap: 11 }}>

        {/* 資産 & 2バケツ */}
        <div style={P}>
          <Sec title="資産 & 2バケツ配分">
            <SliderInput label="現在の年齢" value={currentAge} min={30} max={70} step={1} unit="歳" onChange={setCurrentAge} />
            <SliderInput label="総資産" value={totalAssets} min={0} max={50000} step={100} unit=""
              display={v => fmtFull(v * 1e4)}
              onChange={v => { setTotalAssets(v); if (investedAssets > v) setInvestedAssets(v); }} />
            <BucketBar totalAssets={totalAssets} investedAssets={safeInvested} onChange={setInvestedAssets} />
            <div style={{ background: "#0a1520", border: "1px solid #1e3a5f22", borderRadius: 7, padding: "8px 10px", fontSize: 11 }}>
              <InfoRow label="収入・売却金の按分" value={`運用 ${investRatioPct}% / 手元 ${100 - investRatioPct}%`} color="#4a9eff" />
              <InfoRow label="支出の優先順" value="手元 → 運用（自動補填）" color="#556677" />
            </div>
          </Sec>
          <Sec title="生活費（年齢帯別）・運用" color="#ff8899">
            <div style={{ fontSize: 10, color: "#556677", marginBottom: 8 }}>年齢帯ごとに月間生活費を設定できます</div>
            <div style={{ display: "grid", gridTemplateColumns: "14px 1fr 46px 8px 46px 52px 20px", gap: 4, marginBottom: 5 }}>
              <span /><span style={{ ...S, fontSize: 10 }}>期間名</span><span style={{ ...S, fontSize: 10 }}>開始</span><span />
              <span style={{ ...S, fontSize: 10 }}>終了</span><span style={{ ...S, fontSize: 10 }}>万/月</span><span />
            </div>
            {expensePhases.map((ph, idx) => (
              <div key={ph.id} style={{ display: "grid", gridTemplateColumns: "14px 1fr 46px 8px 46px 52px 20px", gap: 4, alignItems: "center", marginBottom: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: ph.enabled ? "#ff8899" : "#334455", margin: "0 auto", cursor: "pointer" }}
                  onClick={() => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, enabled: !p.enabled } : p))} />
                <input value={ph.label} onChange={e => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, label: e.target.value } : p))}
                  style={{ background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#c8d8e8", padding: "4px 6px", fontSize: 11, outline: "none", fontFamily: "inherit", width: "100%" }} />
                <NumCell value={ph.fromAge} min={30} max={99} onChange={v => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, fromAge: v } : p))} />
                <span style={{ color: "#334455", fontSize: 10, textAlign: "center" }}>→</span>
                <NumCell value={ph.toAge} min={ph.fromAge + 1} max={101} onChange={v => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, toAge: v } : p))} />
                <NumCell value={ph.monthly} min={0} max={999} onChange={v => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, monthly: v } : p))} />
                <button onClick={() => setExpensePhases(ps => ps.filter(p => p.id !== ph.id))} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
              </div>
            ))}
            <AddBtn onClick={() => { const last = expensePhases[expensePhases.length - 1]; setExpensePhases(ps => [...ps, { id: nextExpId, label: "期間", fromAge: last?.toAge ?? currentAge, toAge: (last?.toAge ?? currentAge) + 10, monthly: 30, enabled: true }]); setNextExpId(n => n + 1); }} color="#ff8899">＋ 期間を追加</AddBtn>
            <div style={{ marginTop: 10, background: "#0a1520", border: "1px solid #1e3a5f22", borderRadius: 7, padding: "7px 9px" }}>
              <SliderInput label="インフレ率" value={inflationRate} min={0} max={5} step={0.1} unit="%" onChange={setInflationRate} />
              <SliderInput label="運用資産 利回り（年率）" value={returnRate} min={0} max={10} step={0.1} unit="%" onChange={setReturnRate} accent="#4a9eff" />
              <InfoRow label="うちローン（月）" value={`${totalLoanMonthly}万円`} color="#aa88ff" />
            </div>
          </Sec>
        </div>

        {/* 収入フェーズ */}
        <div style={IP}>
          <div style={{ fontSize: 10, letterSpacing: "0.13em", textTransform: "uppercase", color: "#2adf90", borderBottom: "1px solid #2adf9025", paddingBottom: 5, marginBottom: 11, fontWeight: 700 }}>収入フェーズ</div>
          <div style={{ display: "grid", gridTemplateColumns: "14px 1fr 46px 8px 46px 52px 20px", gap: 4, marginBottom: 5 }}>
            <span /><span style={{ ...S, fontSize: 10 }}>名称</span><span style={{ ...S, fontSize: 10 }}>開始</span><span />
            <span style={{ ...S, fontSize: 10 }}>終了</span><span style={{ ...S, fontSize: 10 }}>万/月</span><span />
          </div>
          {incomePhases.map((ph, idx) => (
            <PhaseRow key={ph.id} phase={ph} idx={idx}
              onUpdate={u => setIncomePhases(ps => ps.map(p => p.id === ph.id ? u : p))}
              onDelete={() => setIncomePhases(ps => ps.filter(p => p.id !== ph.id))}
              currentAge={currentAge} />
          ))}
          <AddBtn onClick={() => { const last = incomePhases[incomePhases.length - 1]; setIncomePhases(ps => [...ps, { id: nextPhaseId, label: "収入フェーズ", fromAge: last?.toAge ?? currentAge, toAge: (last?.toAge ?? currentAge) + 5, monthly: 50, enabled: true }]); setNextPhaseId(n => n + 1); }} color="#2adf90">＋ フェーズを追加</AddBtn>
          <div style={{ marginTop: 11, background: "#001510", border: "1px solid #2adf9018", borderRadius: 7, padding: "8px 10px" }}>
            {incomePhases.filter(p => p.enabled).map((p, i) => (
              <InfoRow key={p.id} label={`${p.fromAge}→${p.toAge}歳: ${p.label}`} value={`${p.monthly}万/月`} color={PHASE_COLORS[i % PHASE_COLORS.length]} />
            ))}
          </div>
        </div>

        {/* ローン + 突発支出 */}
        <div style={LOP}>
          <Sec title="ローン・固定費" color="#aa88ff">
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 50px 46px 20px", gap: 4, marginBottom: 5 }}>
              <span /><span style={{ ...S, fontSize: 10 }}>名称</span><span style={{ ...S, fontSize: 10 }}>万/月</span><span style={{ ...S, fontSize: 10 }}>終了歳</span><span />
            </div>
            {loans.map(l => <LoanRow key={l.id} loan={l} onUpdate={u => setLoans(ls => ls.map(x => x.id === l.id ? u : x))} onDelete={() => setLoans(ls => ls.filter(x => x.id !== l.id))} />)}
            <AddBtn onClick={() => { setLoans(ls => [...ls, { id: nextLoanId, label: "ローン", monthly: 10, endAge: currentAge + 10, enabled: true }]); setNextLoanId(n => n + 1); }} color="#aa88ff">＋ ローンを追加</AddBtn>
          </Sec>
          <Sec title="突発支出・一時費用" color="#ff6644">
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 50px 54px 20px", gap: 4, marginBottom: 5 }}>
              <span /><span style={{ ...S, fontSize: 10 }}>名称</span><span style={{ ...S, fontSize: 10 }}>年齢</span><span style={{ ...S, fontSize: 10 }}>金額(万)</span><span />
            </div>
            {oneTimeEvents.map(ev => <EventRow key={ev.id} ev={ev} onUpdate={u => setOneTimeEvents(es => es.map(e => e.id === ev.id ? u : e))} onDelete={() => setOneTimeEvents(es => es.filter(e => e.id !== ev.id))} />)}
            <AddBtn onClick={() => { setOneTimeEvents(es => [...es, { id: nextEventId, label: "一時支出", age: currentAge + 5, amount: 300, enabled: true }]); setNextEventId(n => n + 1); }} color="#ff6644">＋ 一時支出を追加</AddBtn>
            {enabledEvents.length > 0 && (
              <div style={{ marginTop: 8, background: "#180800", border: "1px solid #ff664418", borderRadius: 7, padding: "7px 9px" }}>
                {enabledEvents.map(ev => <InfoRow key={ev.id} label={`${ev.age}歳: ${ev.label}`} value={fmtFull(ev.amount * 1e4)} color="#ff8866" />)}
                <InfoRow label="合計" value={fmtFull(enabledEvents.reduce((a, e) => a + e.amount, 0) * 1e4)} color="#ff6644" />
              </div>
            )}
          </Sec>
        </div>

        {/* 年金 + 売却 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <div style={P}>
            <Sec title="公的年金">
              <SliderInput label="受給開始年齢" value={pensionAge} min={60} max={75} step={1} unit="歳" onChange={setPensionAge} />
              <SliderInput label="月額（夫婦合算）" value={pensionAmount} min={5} max={50} step={1} unit="万/月" onChange={setPensionAmount} />
            </Sec>
            <Sec title="個人年金">
              <SliderInput label="受給開始年齢" value={privatePensionAge} min={55} max={75} step={1} unit="歳" onChange={setPrivatePensionAge} />
              <SliderInput label="月額" value={privatePensionAmount} min={0} max={30} step={1} unit="万/月" onChange={setPrivatePensionAmount} />
              <SliderInput label="受給期間" value={privatePensionYears} min={1} max={30} step={1} unit="年間" onChange={setPrivatePensionYears} />
            </Sec>
          </div>

          <div style={saleEnabled ? LP : P}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.13em", textTransform: "uppercase", color: "#f0a040", fontWeight: 700 }}>会社売却シナリオ</div>
              <Toggle value={saleEnabled} onChange={setSaleEnabled} color="#f0a040" />
            </div>
            {saleEnabled && (
              <>
                <SliderInput label="売却実行年齢" value={saleSaleAge} min={currentAge} max={70} step={1} unit="歳" onChange={setSaleSaleAge} accent="#f0a040" />
                <SliderInput label="売却総額（グロス）" value={saleGross} min={1000} max={200000} step={1000} unit="" display={v => fmtFull(v * 1e4)} onChange={setSaleGross} accent="#f0a040" />
                <SliderInput label="株式簿価" value={saleBookValue} min={0} max={10000} step={10} unit="" display={v => fmtFull(v * 1e4)} onChange={setSaleBookValue} accent="#f0a040" />
                <div style={{ ...S, marginBottom: 6 }}>譲渡方式</div>
                <TaxRadio value={saleTaxType} onChange={setSaleTaxType} />
                <StockCalc onApply={setSaleGross} />
                <div style={{ background: "#0a0800", border: "1px solid #f0a04028", borderRadius: 7, padding: "8px 11px", marginBottom: 12 }}>
                  <InfoRow label="税引後手取り" value={fmtFull(afterTax)} color="#f0c060" />
                  <InfoRow label="税負担" value={fmtFull(taxAmount)} color="#ff8899" />
                  <InfoRow label="うち運用バケツへ" value={fmtFull(afterTax * investRatioPct / 100)} color="#4a9eff" />
                  <InfoRow label="うち手元バケツへ" value={fmtFull(afterTax * (100 - investRatioPct) / 100)} color="#4adfb0" />
                </div>
                <Sec title="売却後 引継ぎ報酬" color="#f0a040">
                  <SliderInput label="月額報酬" value={salePostSalary} min={0} max={200} step={5} unit="万/月" onChange={setSalePostSalary} accent="#f0a040" />
                  <SliderInput label="期間" value={salePostSalaryYears} min={0} max={5} step={1} unit="年間" onChange={setSalePostSalaryYears} accent="#f0a040" />
                </Sec>
              </>
            )}
          </div>
        </div>

        {/* Die with Zero パネル */}
        <div style={{ ...P, borderColor: dwzEnabled ? "#a040f044" : "#1e3a5f", background: dwzEnabled ? "linear-gradient(160deg,#100818,#0e0615)" : undefined }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: dwzEnabled ? 14 : 0 }}>
            <div>
              <div style={{ fontSize: 10, letterSpacing: "0.13em", textTransform: "uppercase", color: "#a040f0", fontWeight: 700 }}>Die with Zero モード</div>
              {dwzEnabled && <div style={{ fontSize: 10, color: "#667788", marginTop: 2 }}>目標年齢での残高目標を設定</div>}
            </div>
            <Toggle value={dwzEnabled} onChange={setDwzEnabled} color="#a040f0" />
          </div>
          {dwzEnabled && (
            <>
              <SliderInput label="目標年齢" value={dwzTargetAge} min={70} max={100} step={1} unit="歳" onChange={setDwzTargetAge} accent="#a040f0" />
              <SliderInput label="目標残高" value={dwzTargetAmount} min={0} max={10000} step={100} unit="" display={v => fmtFull(v * 1e4)} onChange={setDwzTargetAmount} accent="#a040f0" />
              <div style={{ background: "#0e0615", border: `1px solid ${dwzOnTrack ? "#a040f044" : "#ff557744"}`, borderRadius: 7, padding: "9px 11px", marginTop: 4 }}>
                <div style={{ fontSize: 10, color: dwzOnTrack ? "#c080ff" : "#ff7799", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5 }}>
                  {dwzOnTrack ? "✓ 目標クリア" : "⚠ 目標オーバー（使い残し）"}
                </div>
                <InfoRow label={`${dwzTargetAge}歳時点の推定残高`} value={fmtFull(dwzActual)} color="#c080ff" />
                <InfoRow label="目標との差分" value={(dwzDiff >= 0 ? "+" : "") + fmtFull(dwzDiff)} color={dwzOnTrack ? "#a040f0" : "#ff8899"} />
                {!dwzOnTrack && <div style={{ fontSize: 10, color: "#ff7799", marginTop: 6 }}>→ 生活費を増やすか、目標残高を上げてください</div>}
                {dwzOnTrack && dwzDiff > 0 && <div style={{ fontSize: 10, color: "#a040f0", marginTop: 6 }}>→ 年間 {fmtFull(dwzDiff / Math.max(dwzTargetAge - currentAge, 1))} 追加消費できます</div>}
              </div>
            </>
          )}
        </div>
      </div>

      {/* マイルストーンテーブル */}
      <div style={{ ...P, marginTop: 11 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.13em", textTransform: "uppercase", color: "#4a9eff", marginBottom: 11, fontWeight: 700 }}>マイルストーン別 残高</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 640 }}>
            <thead>
              <tr>
                <th style={{ color: "#445566", fontSize: 10, textAlign: "left", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingRight: 10 }}>項目</th>
                {[50, 55, 60, 65, 70, 75, 80, 85, 90, 95].map(a => (
                  <th key={a} style={{ color: "#445566", fontSize: 10, textAlign: "right", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 5 }}>{a}歳</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                { label: "合計（売却あり）", key: "assets", data: withSale.data, color: "#c8d8e8" },
                { label: "  うち運用", key: "invested", data: withSale.data, color: "#4a9eff" },
                { label: "  うち手元", key: "cash", data: withSale.data, color: "#4adfb0" },
                { label: "合計（売却なし）", key: "assets", data: noSale.data, color: "#445566" },
              ].map(({ label, key, data, color }) => (
                <tr key={label}>
                  <td style={{ color, paddingTop: 7, paddingRight: 10, fontSize: label.startsWith("  ") ? 10 : 11 }}>{label}</td>
                  {[50, 55, 60, 65, 70, 75, 80, 85, 90, 95].map(a => {
                    const v = data.find(d => d.age === a)?.[key] ?? 0;
                    return <td key={a} style={{ textAlign: "right", paddingTop: 7, paddingLeft: 5, color: v > 0 ? color : "#ff5577", fontVariantNumeric: "tabular-nums", fontSize: label.startsWith("  ") ? 10 : 11 }}>
                      {fmtFull(Math.max(v, 0))}
                    </td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ textAlign: "center", marginTop: 16, fontSize: 10, color: "#2a3a4a" }}>
        ※ 試算ツール。税務・資産設計は専門家にご相談ください。　v7: シナリオ保存・比較・PDF出力 追加
      </div>
    </div>
  );
}
