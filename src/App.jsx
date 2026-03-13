import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, Area, AreaChart, Line } from "recharts";

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

// ── 年金手取り率（公的年金控除・必要経費控除後の簡易近似）
// 公的年金：65歳以上・年200万前後で実効税率5%程度
// 個人年金：必要経費控除後の課税部分に10%程度
const PENSION_TAKE_RATE         = 0.95; // 公的年金手取り率
const PRIVATE_PENSION_TAKE_RATE = 0.90; // 個人年金手取り率


// ── 3シナリオ差分定数（後から変更しやすいように定数化）
const TRI_PESSIMISTIC = { returnDelta: -2.0, inflDelta: +1.0 };
const TRI_OPTIMISTIC  = { returnDelta: +2.0, inflDelta: -0.5 };

// ── ストレステスト プリセット定義
const STRESS_PRESETS = [
  { id: "asset_shock",    label: "退職直後に運用資産 −30%",   desc: "退職年齢時点で運用バケツを70%に圧縮" },
  { id: "high_inflation", label: "高インフレ継続（10年 +2pt）", desc: "10年間インフレ率が2pt高い水準で推移" },
  { id: "sale_delay",     label: "会社売却が3年遅れる",        desc: "売却タイミングを3年後ろ倒し" },
  { id: "medical",        label: "医療・介護費（75歳以降 +5万/月）", desc: "75歳以降の毎月支出が5万円増加" },
];

// ── 生活言語換算 単価定数（後から変更しやすいように定数化）
const TRAVEL_COST_MAN  = 20;   // 旅行1回あたり（万円）
const CAR_COST_MAN     = 300;  // 車買い替え（万円）
const SUPPORT_UNIT_YEARS = 20; // 援助を何年分に分散して計算するか

// ── 2バケツシミュレーション
function simulate({
  currentAge, totalAssets, investedAssets,
  incomePhases, loans, oneTimeEvents,
  expensePhases, inflationRate, returnRate,
  pensionAge, pensionAmount,
  privatePensionAge, privatePensionAmount, privatePensionYears,
  saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType,
  salePostSalary, salePostSalaryYears,
  oneTimeIncomes, cashBufferMonths,
  defaultTakeRate, pensionSlideRate,
  incomeInvestRatioPct, windfallInvestRatioPct,
  stressAssetShockAge, stressExtraInflYears, stressExtraInflPt, stressExtraMonthlyFrom, stressExtraMonthly,
}) {
  const MAX = 100;
  const points = [];
  const initTotal = totalAssets * 1e4;
  const initInvested = Math.min(investedAssets * 1e4, initTotal);
  const investRatio = initTotal > 0 ? initInvested / initTotal : 0;

  let investBucket = initInvested;
  let cashBucket = initTotal - initInvested;
  let _assetShockApplied = false; // ストレス①フラグ

  const saleProceeds = saleEnabled
    ? calcAfterTax(saleGross * 1e4, saleBookValue * 1e4, saleTaxType) : 0;

  for (let age = currentAge; age <= MAX; age++) {
    const yearsFromNow = age - currentAge;
    // 修正1: 高インフレ期間は年ごとに正確に累積計算する
    // stressExtraInflYears 年間だけ (inflationRate + stressExtraInflPt) を使い、その後は通常に戻す
    let inflFactor = 1;
    for (let y = 0; y < yearsFromNow; y++) {
      const r = (stressExtraInflYears != null && stressExtraInflPt != null && y < stressExtraInflYears)
        ? (inflationRate + stressExtraInflPt) / 100
        : inflationRate / 100;
      inflFactor *= (1 + r);
    }

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

    // 収入（手取り率・マクロ経済スライド適用）
    let annualIncome = 0;
    for (const ph of incomePhases) {
      if (ph.enabled && age >= ph.fromAge && age < ph.toAge) {
        const rate = (ph.takeRate ?? defaultTakeRate) / 100;
        annualIncome += ph.monthly * 12 * 1e4 * rate;
      }
    }
    if (age >= privatePensionAge && age < privatePensionAge + privatePensionYears)
      annualIncome += privatePensionAmount * 12 * 1e4 * PRIVATE_PENSION_TAKE_RATE;
    if (age >= pensionAge) {
      const slideYears = age - pensionAge;
      const slideFactor = Math.pow(1 + pensionSlideRate / 100, slideYears);
      annualIncome += pensionAmount * 12 * 1e4 * slideFactor * PENSION_TAKE_RATE;
    }
    if (saleEnabled && age >= saleSaleAge && age < saleSaleAge + salePostSalaryYears)
      annualIncome += salePostSalary * 12 * 1e4;

    const saleEvent = saleEnabled && age === saleSaleAge ? saleProceeds : 0;
    let oneTimeInc = 0;
    for (const ev of oneTimeIncomes) {
      if (ev.enabled && age === ev.age) oneTimeInc += ev.amount * 1e4;
    }
    const windfallIncome = saleEvent + oneTimeInc;
    const totalIncome = annualIncome + windfallIncome;

    // 収入を比率で按分（継続収入・一時収入で別比率）
    const incomeRatio   = incomeInvestRatioPct   != null ? incomeInvestRatioPct   / 100 : investRatio;
    const windfallRatio = windfallInvestRatioPct != null ? windfallInvestRatioPct / 100 : investRatio;
    investBucket += annualIncome   * incomeRatio   + windfallIncome * windfallRatio;
    cashBucket   += annualIncome   * (1 - incomeRatio) + windfallIncome * (1 - windfallRatio);

    // ストレス①：指定年齢に運用資産-30%ショック
    if (stressAssetShockAge != null && age === stressAssetShockAge && !_assetShockApplied) {
      investBucket *= 0.70;
      _assetShockApplied = true;
    }
    // ストレス④：高齢期の医療・介護費（支出追加）
    if (stressExtraMonthlyFrom != null && age >= stressExtraMonthlyFrom && stressExtraMonthly > 0) {
      const extraExp = stressExtraMonthly * 12 * 1e4 * inflFactor;
      const fromCashExtra = Math.min(cashBucket, extraExp);
      cashBucket -= fromCashExtra;
      investBucket -= (extraExp - fromCashExtra);
    }
    // 運用バケツに利回り（ストレス②：高インフレは inflFactor に反映済み）
    investBucket *= (1 + returnRate / 100);

    // 支出: 手元から優先、不足分は運用から補填
    const fromCash = Math.min(cashBucket, annualExpense);
    cashBucket -= fromCash;
    investBucket -= (annualExpense - fromCash);

    // 支出後リバランス（下限＝生活費×cashBufferMonths を下回ったら運用から補充）
    const cashFloor = monthlyExp * inflFactor * cashBufferMonths * 1e4;
    if (cashBucket < cashFloor && investBucket > 0) {
      const topUp = Math.min(cashFloor - cashBucket, investBucket);
      cashBucket += topUp;
      investBucket -= topUp;
    }

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
      oneTimeIncome: oneTimeInc,
      saleEvent,
    });
  }

  return { data: points, depletionAge: points.find(p => p.assets <= 0)?.age ?? null };
}

// ── UI パーツ
const S = { color: "#8899aa", fontSize: 15, letterSpacing: "0.07em", textTransform: "uppercase" };

const SliderInput = ({ label, value, min, max, step, unit, onChange, display, accent = "#4a9eff" }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
      <span style={S}>{label}</span>
      <span style={{ color: "#e8f0fe", fontSize: 17, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {display ? display(value) : `${value}${unit}`}
      </span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))}
      style={{ width: "100%", accentColor: accent, cursor: "pointer" }} />
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 1 }}>
      <span style={{ color: "#334455", fontSize: 14 }}>{min}{unit}</span>
      <span style={{ color: "#334455", fontSize: 14 }}>{max}{unit}</span>
    </div>
  </div>
);

const Sec = ({ title, color = "#4a9eff", children }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ fontSize: 14, letterSpacing: "0.14em", textTransform: "uppercase", color, borderBottom: `1px solid ${color}25`, paddingBottom: 5, marginBottom: 11, fontWeight: 700 }}>{title}</div>
    {children}
  </div>
);

const Toggle = ({ value, onChange, color = "#4a9eff" }) => (
  <div onClick={() => onChange(!value)} style={{ width: 32, height: 18, borderRadius: 9, background: value ? color : "#1e3a5f", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
    <div style={{ position: "absolute", top: 2, left: value ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "#e8f0fe", transition: "left 0.2s" }} />
  </div>
);

const NumCell = ({ value, onChange, min = 0, max = 99999 }) => {
  const [local, setLocal] = useState(String(value));
  useEffect(() => { setLocal(String(value)); }, [value]);
  return (
    <input
      type="number" value={local} min={min} max={max}
      onChange={e => setLocal(e.target.value)}
      onBlur={() => {
        const n = local === "" ? min : Math.min(max, Math.max(min, Number(local) || 0));
        setLocal(String(n));
        onChange(n);
      }}
      onFocus={e => e.target.select()}
      style={{ width: "100%", background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#e8f0fe", padding: "4px 6px", fontSize: 16, outline: "none", fontFamily: "inherit", fontVariantNumeric: "tabular-nums" }} />
  );
};

const TaxRadio = ({ value, onChange }) => (
  <div style={{ display: "flex", gap: 7, marginBottom: 11 }}>
    {[{ v: "stock", label: "株式譲渡", sub: "20.315%" }, { v: "biz", label: "事業譲渡", sub: "実効~45%" }].map(({ v, label, sub }) => (
      <div key={v} onClick={() => onChange(v)} style={{ flex: 1, border: `1px solid ${value === v ? "#f0a040" : "#1e3a5f"}`, borderRadius: 7, padding: "6px 8px", cursor: "pointer", background: value === v ? "#1a1000" : "#0a1520" }}>
        <div style={{ fontSize: 15, color: value === v ? "#f0a040" : "#778899", fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 14, color: "#445566" }}>{sub}</div>
      </div>
    ))}
  </div>
);

const InfoRow = ({ label, value, color = "#8899aa" }) => (
  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
    <span style={{ color: "#556677", fontSize: 15 }}>{label}</span>
    <span style={{ color, fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
  </div>
);

// ── 用語補足ツールチップ（修正3）
const TERM_TIPS = {
  DWZ: "「使い切る目標残高」の設定。老後に残したい最低ラインを決め、\nそれを下回らない範囲で使える額を計算します。",
  bucket2: "資産を「運用バケツ（株・投信など）」と「手元バケツ（現金）」の\n2つに分けて管理する方式。取り崩しリスクを減らせます。",
  takeRate: "税・社会保険料を引いた後の手取り割合。\n例：月収100万円で手取り率80%なら、手元に入るのは80万円。",
  macroSlide: "年金額の改定ルール。物価や賃金の上昇より少し低く抑えられる仕組み。\nここでは年間の調整率（マイナスも設定可）として反映します。",
  stress: "想定外の出来事（資産急落・インフレ・売却遅延など）が起きたときに\n資産がどう変わるかを確認する機能です。",
};
const Tip = ({ term, children }) => {
  const [show, setShow] = useState(false);
  const tip = TERM_TIPS[term];
  if (!tip) return <>{children}</>;
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 3 }}>
      {children}
      <span onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} onClick={() => setShow(s => !s)}
        style={{ display:"inline-flex",alignItems:"center",justifyContent:"center",width:14,height:14,borderRadius:"50%",background:"#1a2a3a",border:"1px solid #2a4a6a",color:"#4a9eff",fontSize:9,cursor:"pointer",userSelect:"none",flexShrink:0 }}>?</span>
      {show && <span style={{ position:"absolute",bottom:"120%",left:0,zIndex:50,background:"#0d1e30",border:"1px solid #2a4a6a",borderRadius:8,padding:"8px 10px",fontSize:10,color:"#aabbcc",whiteSpace:"pre-line",width:220,lineHeight:1.6,boxShadow:"0 4px 16px #000a" }}>{tip}</span>}
    </span>
  );
};

const StatCard = ({ label, value, color = "#c8d8e8", sub }) => (
  <div style={{ background: "#0a1520", border: "1px solid #1e3a5f", borderRadius: 7, padding: "8px 11px" }}>
    <div style={{ fontSize: 14, color: "#556677", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
    <div style={{ fontSize: 18, fontWeight: 700, color, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    {sub && <div style={{ fontSize: 14, color: "#445566", marginTop: 1 }}>{sub}</div>}
  </div>
);

const AddBtn = ({ onClick, color, children }) => (
  <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: `1px dashed ${color}55`, borderRadius: 6, color, fontSize: 15, padding: "5px 10px", cursor: "pointer", width: "100%", justifyContent: "center", fontFamily: "inherit" }}>
    {children}
  </button>
);

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ background: "#080f18", border: "1px solid #1e3a5f", borderRadius: 8, padding: "10px 13px", fontSize: 15, color: "#c8d8e8", minWidth: 215 }}>
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
        {(d?.oneTimeIncome ?? 0) > 0 && <InfoRow label="一時収入" value={`+${fmtFull(d.oneTimeIncome)}`} color="#2adf90" />}
      </div>
    </div>
  );
};

const PHASE_COLORS = ["#2adf90", "#4a9eff", "#aa88ff", "#ff9966", "#ffcc44"];

const CardNumInput = ({ value, onChange, min = 0, max = 999, suffix = "" }) => {
  const [local, setLocal] = useState(String(value));
  useEffect(() => { setLocal(String(value)); }, [value]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <input type="number" value={local} min={min} max={max}
        onChange={e => setLocal(e.target.value)}
        onBlur={() => {
          const n = local === "" ? min : Math.min(max, Math.max(min, Number(local) || 0));
          setLocal(String(n));
          onChange(n);
        }}
        onFocus={e => e.target.select()}
        style={{ width: "100%", background: "#0a1520", border: "1px solid #1e3a5f", borderRadius: 6, color: "#e8f0fe", padding: "6px 8px", fontSize: 17, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
      {suffix && <span style={{ fontSize: 15, color: "#445566" }}>{suffix}</span>}
    </div>
  );
};

const PhaseRow = ({ phase, idx, onUpdate, onDelete, currentAge, defaultTakeRate }) => {
  const c = PHASE_COLORS[idx % PHASE_COLORS.length];
  const takeRate = phase.takeRate ?? defaultTakeRate;
  return (
    <div style={{ background: "#060e18", border: `1px solid ${phase.enabled ? c + "55" : "#1e3a5f"}`, borderRadius: 10, padding: "12px 13px", marginBottom: 8, position: "relative", opacity: phase.enabled ? 1 : 0.5 }}>
      {/* ヘッダー行 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: phase.enabled ? c : "#334455", cursor: "pointer", flexShrink: 0 }}
            onClick={() => onUpdate({ ...phase, enabled: !phase.enabled })} />
          <input value={phase.label} onChange={e => onUpdate({ ...phase, label: e.target.value })}
            style={{ background: "transparent", border: "none", borderBottom: `1px solid ${c}44`, color: "#e8f0fe", padding: "2px 4px", fontSize: 17, fontWeight: 700, outline: "none", fontFamily: "inherit", width: 140 }} />
        </div>
        <button onClick={onDelete} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 18, padding: 0, lineHeight: 1 }}>✕</button>
      </div>
      {/* 数値グリッド */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div>
          <div style={{ fontSize: 14, color: "#445566", marginBottom: 4 }}>開始年齢</div>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <input type="number" value={phase.fromAge} min={currentAge} max={99}
              onChange={e => onUpdate({ ...phase, fromAge: Number(e.target.value) })}
              style={{ width: "100%", background: "#0a1520", border: "1px solid #1e3a5f", borderRadius: 6, color: "#e8f0fe", padding: "6px 8px", fontSize: 17, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
            <span style={{ fontSize: 15, color: "#445566" }}>歳</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 14, color: "#445566", marginBottom: 4 }}>終了年齢</div>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <input type="number" value={phase.toAge} min={phase.fromAge + 1} max={100}
              onChange={e => onUpdate({ ...phase, toAge: Number(e.target.value) })}
              style={{ width: "100%", background: "#0a1520", border: "1px solid #1e3a5f", borderRadius: 6, color: "#e8f0fe", padding: "6px 8px", fontSize: 17, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
            <span style={{ fontSize: 15, color: "#445566" }}>歳</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 14, color: "#445566", marginBottom: 4 }}>月額</div>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <input type="number" value={phase.monthly} min={0} max={9999}
              onChange={e => onUpdate({ ...phase, monthly: Number(e.target.value) })}
              style={{ width: "100%", background: "#0a1520", border: "1px solid #1e3a5f", borderRadius: 6, color: "#e8f0fe", padding: "6px 8px", fontSize: 17, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
            <span style={{ fontSize: 15, color: "#445566" }}>万</span>
          </div>
        </div>
      </div>
      {/* 手取り率 */}
      <div style={{ marginTop: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 14, color: "#445566" }}>手取り率</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: "#aaddaa" }}>{takeRate}%</span>
        </div>
        <input type="range" min={50} max={100} step={1} value={takeRate}
          onChange={e => onUpdate({ ...phase, takeRate: Number(e.target.value) })}
          style={{ width: "100%", accentColor: c, cursor: "pointer" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#2a3a2a" }}>
          <span>50%</span><span>100%</span>
        </div>
        <div style={{ marginTop: 5, fontSize: 15, color: "#aaddaa" }}>
          手取り → <span style={{ fontWeight: 700, color: c }}>{Math.round(phase.monthly * takeRate / 100)}万/月</span>
          <span style={{ color: "#334455", marginLeft: 6 }}>（税等 {Math.round(phase.monthly * (100 - takeRate) / 100)}万/月）</span>
        </div>
      </div>
    </div>
  );
};

const LoanRow = ({ loan, onUpdate, onDelete }) => (
  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 50px 46px 20px", gap: 4, alignItems: "center", marginBottom: 6 }}>
    <Toggle value={loan.enabled} onChange={v => onUpdate({ ...loan, enabled: v })} color="#aa88ff" />
    <input value={loan.label} onChange={e => onUpdate({ ...loan, label: e.target.value })}
      style={{ background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#c8d8e8", padding: "4px 6px", fontSize: 15, outline: "none", fontFamily: "inherit", width: "100%" }} />
    <NumCell value={loan.monthly} min={0} max={999} onChange={v => onUpdate({ ...loan, monthly: v })} />
    <NumCell value={loan.endAge} min={1} max={100} onChange={v => onUpdate({ ...loan, endAge: v })} />
    <button onClick={onDelete} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 17, padding: 0, lineHeight: 1 }}>✕</button>
  </div>
);

const EventRow = ({ ev, onUpdate, onDelete }) => (
  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 50px 54px 20px", gap: 4, alignItems: "center", marginBottom: 6 }}>
    <Toggle value={ev.enabled} onChange={v => onUpdate({ ...ev, enabled: v })} color="#ff6644" />
    <input value={ev.label} onChange={e => onUpdate({ ...ev, label: e.target.value })}
      style={{ background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#c8d8e8", padding: "4px 6px", fontSize: 15, outline: "none", fontFamily: "inherit", width: "100%" }} />
    <NumCell value={ev.age} min={1} max={100} onChange={v => onUpdate({ ...ev, age: v })} />
    <NumCell value={ev.amount} min={0} max={99999} onChange={v => onUpdate({ ...ev, amount: v })} />
    <button onClick={onDelete} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 17, padding: 0, lineHeight: 1 }}>✕</button>
  </div>
);

const StockCalc = ({ onApply }) => {
  const [shares, setShares] = useState(10000);
  const [price, setPrice] = useState(30000);
  const gross = Math.round(shares * price / 1e4);
  return (
    <div style={{ background: "#0a0800", border: "1px solid #f0a04030", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
      <div style={{ fontSize: 14, color: "#aa7722", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, fontWeight: 700 }}>株数 × 単価 → グロス計算</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <div>
          <div style={{ ...S, fontSize: 14, marginBottom: 3 }}>株数</div>
          <input type="number" value={shares} min={1} onChange={e => setShares(Number(e.target.value))}
            style={{ width: "100%", background: "#060e18", border: "1px solid #2a1e00", borderRadius: 5, color: "#e8f0fe", padding: "5px 7px", fontSize: 16, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
        </div>
        <div>
          <div style={{ ...S, fontSize: 14, marginBottom: 3 }}>単価（円/株）</div>
          <input type="number" value={price} min={1} onChange={e => setPrice(Number(e.target.value))}
            style={{ width: "100%", background: "#060e18", border: "1px solid #2a1e00", borderRadius: 5, color: "#e8f0fe", padding: "5px 7px", fontSize: 16, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <span style={{ color: "#667788", fontSize: 14 }}>売却総額 → </span>
          <span style={{ color: "#f0c060", fontWeight: 700, fontSize: 18, fontVariantNumeric: "tabular-nums" }}>{fmtFull(gross * 1e4)}</span>
        </div>
        <button onClick={() => onApply(gross)} style={{ background: "#2a1800", border: "1px solid #f0a04066", borderRadius: 6, color: "#f0a040", fontSize: 15, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
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
        <span style={{ ...S, fontSize: 14 }}>資産配分（運用 / 手元）</span>
        <span style={{ color: "#e8f0fe", fontSize: 16, fontWeight: 600 }}>{investPct}% / {100 - investPct}%</span>
      </div>
      {/* ビジュアルバー */}
      <div style={{ height: 22, borderRadius: 6, overflow: "hidden", display: "flex", border: "1px solid #1e3a5f", marginBottom: 8 }}>
        <div style={{ width: `${investPct}%`, background: "linear-gradient(90deg,#1a4a8a,#2a6adf)", display: "flex", alignItems: "center", justifyContent: "center", transition: "width 0.2s", minWidth: investPct > 5 ? "auto" : 0 }}>
          {investPct > 10 && <span style={{ fontSize: 14, color: "#9ac8ff", fontWeight: 600 }}>運用 {fmtFull(invested * 1e4)}</span>}
        </div>
        <div style={{ flex: 1, background: "linear-gradient(90deg,#0a3028,#0d4038)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {(100 - investPct) > 10 && <span style={{ fontSize: 14, color: "#6ad8a8", fontWeight: 600 }}>手元 {fmtFull(cash * 1e4)}</span>}
        </div>
      </div>
      {/* 運用額スライダー */}
      <div style={{ ...S, fontSize: 14, marginBottom: 3 }}>運用資産額</div>
      <input type="range" min={0} max={totalAssets} step={100} value={invested}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "#4a9eff", cursor: "pointer" }} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 1 }}>
        <span style={{ color: "#334455", fontSize: 14 }}>0（全額手元）</span>
        <span style={{ color: "#334455", fontSize: 14 }}>{fmtFull(totalAssets * 1e4)}（全額運用）</span>
      </div>
    </div>
  );
};

// ── 印刷用スタイル注入
const MOBILE_STYLE = `
@media (max-width: 600px) {
  .mobile-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .mobile-col1 { grid-template-columns: 1fr !important; }
  .mobile-col2 { grid-template-columns: 1fr 1fr !important; }
  .outer-pad { padding: 12px 8px !important; }
  .header-btns { flex-wrap: wrap !important; gap: 6px !important; }
  .chart-height { height: 220px !important; }
}
`;
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
    { id: 1, label: "役員報酬", fromAge: 45, toAge: 52, monthly: 150, enabled: true, takeRate: 75 },
    { id: 2, label: "引継ぎ・その他収入", fromAge: 52, toAge: 60, monthly: 30, enabled: true, takeRate: 80 },
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

  const [oneTimeIncomes, setOneTimeIncomes] = useState([
    { id: 1, label: "退職金", age: 60, amount: 500, enabled: false },
    { id: 2, label: "相続（実家）", age: 70, amount: 2000, enabled: false },
  ]);
  const [nextIncomeEventId, setNextIncomeEventId] = useState(3);
  const [cashBufferMonths, setCashBufferMonths] = useState(24);
  // 収入按分比率（初期値は初期投資比率に同期）
  const [incomeInvestRatioPct, setIncomeInvestRatioPct] = useState(null); // null = 初期化待ち
  const [windfallInvestRatioPct, setWindfallInvestRatioPct] = useState(null);
  const [defaultTakeRate, setDefaultTakeRate] = useState(80);
  const [pensionSlideRate, setPensionSlideRate] = useState(-0.2);

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
  const investRatioPctCalc = totalAssets > 0 ? Math.round(safeInvested / totalAssets * 100) : 60;
  // 初回マウント時に初期投資比率でセット
  useEffect(() => {
    if (incomeInvestRatioPct === null) setIncomeInvestRatioPct(investRatioPctCalc);
    if (windfallInvestRatioPct === null) setWindfallInvestRatioPct(investRatioPctCalc);
  }, []);
  const investRatioPct = totalAssets > 0 ? Math.round(safeInvested / totalAssets * 100) : 0;

  const simParams = {
    currentAge, totalAssets, investedAssets: safeInvested,
    incomePhases, loans, oneTimeEvents,
    expensePhases, inflationRate, returnRate,
    pensionAge, pensionAmount,
    privatePensionAge, privatePensionAmount, privatePensionYears,
    oneTimeIncomes, cashBufferMonths,
    defaultTakeRate, pensionSlideRate,
    incomeInvestRatioPct, windfallInvestRatioPct,
  };

  const withSale = useMemo(() => simulate({
    ...simParams, saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears
  }), [JSON.stringify(simParams), saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears]);

  const noSale = useMemo(() => simulate({
    ...simParams, saleEnabled: false, saleSaleAge: 0, saleGross: 0, saleBookValue: 0, saleTaxType: "stock", salePostSalary: 0, salePostSalaryYears: 0
  }), [JSON.stringify(simParams)]);

  // ── 3シナリオ表示
  const [triMode, setTriMode] = useState(false);

  // ── ストレステスト
  const [stressMode, setStressMode] = useState(false);
  const [stressPresetId, setStressPresetId] = useState("asset_shock");

  // ── 3シナリオ計算
  const triPessimistic = useMemo(() => triMode ? simulate({
    ...simParams,
    saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears,
    returnRate: returnRate + TRI_PESSIMISTIC.returnDelta,
    inflationRate: inflationRate + TRI_PESSIMISTIC.inflDelta,
  }) : null, [triMode, JSON.stringify(simParams), saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears, returnRate, inflationRate]);

  const triOptimistic = useMemo(() => triMode ? simulate({
    ...simParams,
    saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears,
    returnRate: returnRate + TRI_OPTIMISTIC.returnDelta,
    inflationRate: inflationRate + TRI_OPTIMISTIC.inflDelta,
  }) : null, [triMode, JSON.stringify(simParams), saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears, returnRate, inflationRate]);

  // ── ストレステスト計算
  const stressResult = useMemo(() => {
    if (!stressMode) return null;
    const base = { ...simParams, saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears };
    switch (stressPresetId) {
      case "asset_shock":
        return simulate({ ...base, stressAssetShockAge: currentAge });
      case "high_inflation":
        // 修正1: 年ごとの累積で正確に計算。10年後は通常インフレに戻る
        return simulate({ ...base, stressExtraInflYears: 10, stressExtraInflPt: 2 });
      case "sale_delay":
        return simulate({ ...base, saleSaleAge: saleEnabled ? saleSaleAge + 3 : saleSaleAge });
      case "medical":
        return simulate({ ...base, stressExtraMonthlyFrom: 75, stressExtraMonthly: 5 });
      default:
        return null;
    }
  }, [stressMode, stressPresetId, JSON.stringify(simParams), saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears, inflationRate, currentAge]);

  const chartData = useMemo(() => withSale.data.map((d, i) => ({
    ...d,
    assetsNoSale: noSale.data[i]?.assets ?? 0,
    dwzTarget: dwzEnabled && d.age === dwzTargetAge ? dwzTargetAmount * 1e4 : undefined,
    // 3シナリオ
    assetsPessimistic: triPessimistic?.data[i]?.assets ?? undefined,
    assetsOptimistic:  triOptimistic?.data[i]?.assets ?? undefined,
    // ストレス
    assetsStress: stressResult?.data[i]?.assets ?? undefined,
  })), [withSale, noSale, triPessimistic, triOptimistic, stressResult, dwzEnabled, dwzTargetAge, dwzTargetAmount]);


  // ── 感度分析（追加1）: 各前提を変えたときの90歳残高差
  const SENSITIVITY_ITEMS = [
    { id: "expense+5",   label: "生活費 +5万/月",        always: true  },
    { id: "return-1",    label: "運用利回り −1pt",       always: true  },
    { id: "infl+1",      label: "インフレ率 +1pt",       always: true  },
    { id: "sale-3000",   label: "売却額 −3,000万円",     always: false },
    { id: "sale-3yr",    label: "売却 3年遅れ",           always: false },
  ];
  const sensitivityData = useMemo(() => {
    const base = { ...simParams, saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType, salePostSalary, salePostSalaryYears };
    const baseAt90 = withSale.data.find(d => d.age === 90)?.assets ?? 0;
    return SENSITIVITY_ITEMS
      .filter(item => item.always || saleEnabled)
      .map(item => {
        let res;
        switch (item.id) {
          case "expense+5":
            res = simulate({ ...base, expensePhases: expensePhases.map(p => p.enabled ? { ...p, monthly: p.monthly + 5 } : p) });
            break;
          case "return-1":
            res = simulate({ ...base, returnRate: returnRate - 1 });
            break;
          case "infl+1":
            res = simulate({ ...base, inflationRate: inflationRate + 1 });
            break;
          case "sale-3000":
            res = simulate({ ...base, saleGross: Math.max(saleGross - 3000, 0) });
            break;
          case "sale-3yr":
            res = simulate({ ...base, saleSaleAge: saleSaleAge + 3 });
            break;
          default: res = withSale;
        }
        const at90 = res.data.find(d => d.age === 90)?.assets ?? 0;
        return { ...item, at90, diff: at90 - baseAt90 };
      })
      .sort((a, b) => a.diff - b.diff); // 影響大きい順（マイナスが大きい順）
  }, [JSON.stringify(simParams), saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType,
      salePostSalary, salePostSalaryYears, returnRate, inflationRate, expensePhases, withSale]);

  // ── 危険水域入り年齢（追加2）
  const dangerZone = useMemo(() => {
    const initTotal = totalAssets * 1e4;
    const firstPhaseMonthly = expensePhases.filter(p => p.enabled)[0]?.monthly ?? 30;
    const cashThreshold = firstPhaseMonthly * 24 * 1e4; // 生活費24か月分
    const halfAssets = initTotal * 0.5;
    let cashWarnAge = null;
    let halfWarnAge = null;
    for (const d of withSale.data) {
      if (cashWarnAge === null && d.cash < cashThreshold && d.cash >= 0) cashWarnAge = d.age;
      if (halfWarnAge === null && d.assets < halfAssets && d.assets >= 0) halfWarnAge = d.age;
    }
    return { cashWarnAge, halfWarnAge, cashThreshold, halfAssets };
  }, [withSale, totalAssets, expensePhases]);

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
  const [solverResult, setSolverResult] = useState(null); // {delta, deltaDwz}
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
    oneTimeIncomes, cashBufferMonths,
    defaultTakeRate, pensionSlideRate,
    incomeInvestRatioPct, windfallInvestRatioPct,
  }), [currentAge, totalAssets, investedAssets, incomePhases, loans, oneTimeEvents,
    expensePhases, inflationRate, returnRate, pensionAge, pensionAmount,
    privatePensionAge, privatePensionAmount, privatePensionYears,
    saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType,
    salePostSalary, salePostSalaryYears, dwzEnabled, dwzTargetAge, dwzTargetAmount,
    oneTimeIncomes, cashBufferMonths, defaultTakeRate, pensionSlideRate,
    incomeInvestRatioPct, windfallInvestRatioPct]);

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
    style.innerHTML = PRINT_STYLE + MOBILE_STYLE;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const runSolver = useCallback(() => {
    const baseParams = {
      ...simParams,
      saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType,
      salePostSalary, salePostSalaryYears,
    };
    const check = (delta, dwzMode) => {
      const phases = expensePhases.map(p =>
        p.enabled ? { ...p, monthly: p.monthly + delta } : p
      );
      const res = simulate({ ...baseParams, expensePhases: phases });
      if (res.depletionAge !== null) return false;
      if (dwzMode) {
        const atTarget = res.data.find(d => d.age === dwzTargetAge)?.assets ?? 0;
        return atTarget >= dwzTargetAmount * 1e4;
      }
      return true;
    };
    // 安全モード二分探索
    let delta = 0;
    if (!check(0, false)) {
      setSolverResult({ delta: -1, deltaDwz: null, depletionAge: withSale.depletionAge });
      return;
    }
    let lo = 0, hi = 1000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (check(mid, false)) lo = mid; else hi = mid - 1;
    }
    delta = lo;
    // DWZモード
    let deltaDwz = null;
    if (dwzEnabled) {
      if (!check(0, true)) {
        deltaDwz = -1;
      } else {
        let dlo = 0, dhi = 1000;
        while (dlo < dhi) {
          const mid = Math.floor((dlo + dhi + 1) / 2);
          if (check(mid, true)) dlo = mid; else dhi = mid - 1;
        }
        deltaDwz = dlo;
      }
    }
    setSolverResult({ delta, deltaDwz, depletionAge: null });
  }, [simParams, saleEnabled, saleSaleAge, saleGross, saleBookValue, saleTaxType,
      salePostSalary, salePostSalaryYears, expensePhases, dwzEnabled, dwzTargetAge,
      dwzTargetAmount, withSale]);

  const applyDelta = useCallback((delta) => {
    setExpensePhases(ps => ps.map(p => p.enabled ? { ...p, monthly: p.monthly + delta } : p));
    setSolverResult(null);
  }, []);

  const P   = { background: "linear-gradient(160deg,#0d1b2a,#0a1520)", border: "1px solid #1e3a5f", borderRadius: 12, padding: "16px 15px" };
  const LP  = { ...P, borderColor: "#f0a04044", background: "linear-gradient(160deg,#150e00,#1a1200)" };
  const IP  = { ...P, borderColor: "#2adf9033", background: "linear-gradient(160deg,#001510,#001a14)" };
  const LOP = { ...P, borderColor: "#aa88ff33", background: "linear-gradient(160deg,#0d0820,#0a0618)" };

  return (
    <div className="print-page outer-pad" style={{ minHeight: "100vh", background: "#060e18", color: "#c8d8e8", fontFamily: "'DM Mono','Fira Code','Courier New',monospace", padding: "20px 16px" }}>

      <div style={{ marginBottom: 18 }}>
        <div style={{ textAlign: "center" }}>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: "#e8f0fe" }}>老後資産シミュレーター</h1>
          <div style={{ fontSize: 15, color: "#334455", marginTop: 3 }}>2バケツ方式（運用資産 / 手元資産）対応</div>
        </div>
        <div className="header-btns" style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button onClick={() => setShowSaveModal(true)}
            style={{ background: "#0a1e14", border: "1px solid #2adf9066", borderRadius: 8, color: "#2adf90", fontSize: 15, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
            💾 シナリオを保存
          </button>
          <button onClick={handlePrint} className="no-print"
            style={{ background: "#0a1520", border: "1px solid #4a9eff66", borderRadius: 8, color: "#4a9eff", fontSize: 15, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
            📄 PDFで保存
          </button>
          {savedScenarios.length > 0 && (
            <button onClick={() => setCompareMode(m => !m)}
              style={{ background: compareMode ? "#1a0e30" : "#0a1520", border: `1px solid ${compareMode ? "#aa88ff" : "#1e3a5f"}`, borderRadius: 8, color: compareMode ? "#aa88ff" : "#556677", fontSize: 15, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
              ⚖ 比較モード {savedScenarios.length > 0 ? `(${savedScenarios.length})` : ""}
            </button>
          )}
          <button onClick={() => setTriMode(m => !m)}
            style={{ background: triMode ? "#0d2010" : "#0a1520", border: `1px solid ${triMode ? "#2adf90" : "#1e3a5f"}`, borderRadius: 8, color: triMode ? "#2adf90" : "#556677", fontSize: 15, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
            📊 3シナリオ
          </button>
          <button onClick={() => setStressMode(m => !m)}
            style={{ background: stressMode ? "#1a1200" : "#0a1520", border: `1px solid ${stressMode ? "#ffcc44" : "#1e3a5f"}`, borderRadius: 8, color: stressMode ? "#ffcc44" : "#556677", fontSize: 15, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
            ⚡ ストレス
          </button>
        </div>
      </div>

      {/* 保存モーダル */}
      {showSaveModal && (
        <div style={{ position: "fixed", inset: 0, background: "#000a", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#0d1b2a", border: "1px solid #2adf9066", borderRadius: 14, padding: "24px 28px", minWidth: 300 }}>
            <div style={{ fontSize: 17, color: "#2adf90", fontWeight: 700, marginBottom: 14 }}>シナリオ名を入力</div>
            <input value={saveNameInput} onChange={e => setSaveNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && saveNameInput.trim()) saveScenario(saveNameInput.trim()); }}
              placeholder="例：楽観シナリオ"
              style={{ width: "100%", background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 7, color: "#e8f0fe", padding: "8px 10px", fontSize: 17, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
              autoFocus />
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => saveNameInput.trim() && saveScenario(saveNameInput.trim())}
                style={{ flex: 1, background: "#0a2a1a", border: "1px solid #2adf9088", borderRadius: 7, color: "#2adf90", fontSize: 16, padding: "8px", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
                保存
              </button>
              <button onClick={() => { setShowSaveModal(false); setSaveNameInput(""); }}
                style={{ flex: 1, background: "#0a1520", border: "1px solid #1e3a5f", borderRadius: 7, color: "#556677", fontSize: 16, padding: "8px", cursor: "pointer", fontFamily: "inherit" }}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 比較モード */}
      {compareMode && savedScenarios.length > 0 && (
        <div style={{ background: "linear-gradient(160deg,#0d0820,#0a0618)", border: "1px solid #aa88ff44", borderRadius: 12, padding: "16px 15px", marginBottom: 12 }}>
          <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#aa88ff", marginBottom: 12, fontWeight: 700 }}>⚖ シナリオ比較</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15, minWidth: 500 }}>
              <thead>
                <tr>
                  <th style={{ color: "#445566", fontSize: 14, textAlign: "left", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingRight: 12 }}>シナリオ</th>
                  {[65, 70, 75, 80, 85, 90, 95].map(a => (
                    <th key={a} style={{ color: "#445566", fontSize: 14, textAlign: "right", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 8 }}>{a}歳</th>
                  ))}
                  <th style={{ color: "#445566", fontSize: 14, textAlign: "right", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 8 }}>枯渇</th>
                  <th style={{ paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 8 }} />
                </tr>
              </thead>
              <tbody>
                {/* 現在の設定 */}
                {(() => {
                  const color = "#e8f0fe";
                  return (
                    <tr>
                      <td style={{ color, paddingTop: 8, paddingRight: 12, fontSize: 15 }}>
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
                        <div style={{ color, fontWeight: 600, fontSize: 15 }}>{sc.name}</div>
                        <div style={{ color: "#334455", fontSize: 13 }}>{sc.savedAt}</div>
                      </td>
                      {[65, 70, 75, 80, 85, 90, 95].map(a => {
                        const v = res.data.find(d => d.age === a)?.assets ?? 0;
                        return <td key={a} style={{ textAlign: "right", paddingTop: 8, paddingLeft: 8, color: v > 0 ? color : "#ff5577", fontVariantNumeric: "tabular-nums", fontSize: 15 }}>{fmtFull(Math.max(v, 0))}</td>;
                      })}
                      <td style={{ textAlign: "right", paddingTop: 8, paddingLeft: 8, color: safe ? "#4adfb0" : "#ff5577", fontSize: 15 }}>{safe ? "安全" : `${res.depletionAge}歳`}</td>
                      <td style={{ paddingTop: 8, paddingLeft: 8 }}>
                        <button onClick={() => deleteScenario(sc.id)} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 16, padding: 0 }}>✕</button>
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
          <h2 className="print-title" style={{ fontSize: 24, marginBottom: 4 }}>老後資産シミュレーション結果</h2>
          <div className="print-label" style={{ fontSize: 15, marginBottom: 16 }}>出力日: {new Date().toLocaleDateString('ja-JP')}</div>

          <div className="print-section">
            <div className="print-label" style={{ fontSize: 14, marginBottom: 8, fontWeight: 700 }}>■ 基本設定</div>
            <table style={{ width: "100%", fontSize: 15, borderCollapse: "collapse" }}>
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
            <div className="print-label" style={{ fontSize: 14, marginBottom: 8, fontWeight: 700 }}>■ 判定結果</div>
            <div className={isSafe ? "print-safe" : "print-warn"} style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
              {isSafe ? "✓ 生涯 安全圏" : `⚠ ${withSale.depletionAge}歳で資産枯渇リスク`}
            </div>
            {saleEnabled && (
              <div className="print-label" style={{ fontSize: 15 }}>
                会社売却: {saleSaleAge}歳 → 手取り {fmtFull(afterTax)}（税負担 {fmtFull(taxAmount)}）
              </div>
            )}
          </div>

          <div className="print-section">
            <div className="print-label" style={{ fontSize: 14, marginBottom: 8, fontWeight: 700 }}>■ 年齢別残高</div>
            <table style={{ width: "100%", fontSize: 15, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {[50,55,60,65,70,75,80,85,90,95].map(a => (
                    <th key={a} className="print-label" style={{ textAlign: "right", padding: "3px 5px", borderBottom: "1px solid #ccc", fontSize: 14 }}>{a}歳</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {[50,55,60,65,70,75,80,85,90,95].map(a => {
                    const v = withSale.data.find(d => d.age === a)?.assets ?? 0;
                    return <td key={a} className={v > 0 ? "print-value" : "print-warn"} style={{ textAlign: "right", padding: "4px 5px", fontSize: 14 }}>{fmtFull(Math.max(v,0))}</td>;
                  })}
                </tr>
              </tbody>
            </table>
          </div>

          {savedScenarios.length > 0 && (
            <div className="print-section">
              <div className="print-label" style={{ fontSize: 14, marginBottom: 8, fontWeight: 700 }}>■ 保存シナリオ比較</div>
              <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
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


      {/* ── 前提サマリーカード（修正2） */}
      {(() => {
        const firstPhase = expensePhases.filter(p => p.enabled)[0];
        const cashAssets = (totalAssets - safeInvested);
        return (
          <div style={{ background: "linear-gradient(160deg,#080e18,#0a1220)", border: "1px solid #2a3a50", borderRadius: 12, padding: "14px 15px", marginBottom: 12 }}>
            <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#667788", fontWeight: 700, marginBottom: 10 }}>
              📋 この試算の前提
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))", gap: "8px 12px" }}>
              {[
                { label: "現在の年齢",    value: `${currentAge}歳` },
                { label: "総資産",        value: fmtFull(totalAssets * 1e4) },
                { label: "うち運用資産",  value: fmtFull(safeInvested * 1e4), sub: `（全体の${Math.round(safeInvested/totalAssets*100)}%）` },
                { label: "うち現金資産",  value: fmtFull(cashAssets * 1e4) },
                { label: "月間生活費",    value: `${firstPhase?.monthly ?? "—"}万円/月`, sub: firstPhase ? `（${firstPhase.label}）` : "" },
                { label: "公的年金",      value: `${pensionAge}歳〜 ${pensionAmount}万/月` },
                ...(privatePensionAmount > 0 ? [{ label: "私的年金", value: `${privatePensionAge}歳〜 ${privatePensionAmount}万/月`, sub: `（${privatePensionYears}年間）` }] : []),
                ...(saleEnabled ? [{ label: "会社売却", value: `${saleSaleAge}歳 手取り${fmtFull(calcAfterTax(saleGross*1e4,saleBookValue*1e4,saleTaxType))}`, sub: "(税引後)", color: "#f0c060" }] : []),
                { label: "運用利回り",    value: `年 ${returnRate}%` },
                { label: "インフレ率",    value: `年 ${inflationRate}%` },
                { label: "現金バッファ",  value: `${cashBufferMonths}か月分`, sub: "（手元の最低維持額）" },
              ].map(({ label, value, sub, color }) => (
                <div key={label}>
                  <div style={{ fontSize: 13, color: "#445566", marginBottom: 1 }}>{label}</div>
                  <div style={{ fontSize: 16, color: color ?? "#c8d8e8", fontWeight: 600 }}>{value}</div>
                  {sub && <div style={{ fontSize: 13, color: "#334455" }}>{sub}</div>}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ステータスバナー */}
      <div style={{ ...P, marginBottom: 12, borderColor: isSafe ? "#1e5f3a" : "#5f1e2a", background: isSafe ? "linear-gradient(135deg,#0a1e14,#0d2018)" : "linear-gradient(135deg,#1e0a10,#200d14)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, color: isSafe ? "#4adfb0" : "#ff7799", textTransform: "uppercase", letterSpacing: "0.12em" }}>{isSafe ? "✓ LIFETIME SAFE" : "⚠ DEPLETION RISK"}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: isSafe ? "#4adfb0" : "#ff5577", marginTop: 2 }}>{isSafe ? "生涯 安全圏" : `${withSale.depletionAge}歳で資産枯渇`}</div>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[65, 75, 85, 95].map(a => {
            const v = chartData.find(d => d.age === a)?.assets;
            return <div key={a} style={{ textAlign: "right" }}>
              <div style={{ fontSize: 14, color: "#556677" }}>{a}歳</div>
              <div style={{ fontSize: 17, color: (v ?? 0) > 0 ? "#c8d8e8" : "#ff5577", fontWeight: 600 }}>{fmtFull(v ?? 0)}</div>
            </div>;
          })}
        </div>
      </div>



      {/* ── 危険水域入り年齢（追加2） */}
      {(() => {
        const { cashWarnAge, halfWarnAge } = dangerZone;
        const hasDanger = cashWarnAge !== null || halfWarnAge !== null;
        return (
          <div style={{ background: "linear-gradient(160deg,#0d1018,#0a0e18)", border: `1px solid ${hasDanger ? "#ff884422" : "#1e3a5f"}`, borderRadius: 12, padding: "12px 15px", marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <div style={{ fontSize: 14, letterSpacing: "0.12em", textTransform: "uppercase", color: hasDanger ? "#ff8844" : "#445566", fontWeight: 700, minWidth: 100 }}>
              {hasDanger ? "⚠ 警戒ライン" : "✓ 警戒ラインなし"}
            </div>
            {cashWarnAge !== null ? (
              <div>
                <div style={{ fontSize: 13, color: "#664433" }}>手元資金が生活費2年分を下回る</div>
                <div style={{ fontSize: 17, color: "#ff9966", fontWeight: 600 }}>{cashWarnAge}歳ごろ</div>
              </div>
            ) : (
              <div style={{ fontSize: 15, color: "#334455" }}>手元2年分：生涯維持</div>
            )}
            {halfWarnAge !== null ? (
              <div>
                <div style={{ fontSize: 13, color: "#664433" }}>総資産が初期の50%を下回る</div>
                <div style={{ fontSize: 17, color: "#ff9966", fontWeight: 600 }}>{halfWarnAge}歳ごろ</div>
              </div>
            ) : (
              <div style={{ fontSize: 15, color: "#334455" }}>初期50%水準：生涯維持</div>
            )}
          </div>
        );
      })()}

      {/* ── 感度分析（追加1） */}
      <div style={{ background: "linear-gradient(160deg,#0a1018,#0d1420)", border: "1px solid #1e3a5f", borderRadius: 12, padding: "14px 15px", marginBottom: 12 }}>
        <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#4a9eff", fontWeight: 700, marginBottom: 4 }}>
          🔬 感度分析 — 90歳残高への影響
        </div>
        <div style={{ fontSize: 14, color: "#334455", marginBottom: 12 }}>
          各前提を少し変えたとき、90歳時点の残高がどれだけ変わるかの目安です
        </div>
        {sensitivityData.map((item) => {
          const base90 = withSale.data.find(d => d.age === 90)?.assets ?? 0;
          const maxAbsDiff = Math.max(...sensitivityData.map(d => Math.abs(d.diff)), 1);
          const barPct = Math.abs(item.diff) / maxAbsDiff * 100;
          const isNeg = item.diff < 0;
          return (
            <div key={item.id} style={{ marginBottom: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 15, color: "#889aaa" }}>{item.label}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: isNeg ? "#ff8855" : "#4adfb0", fontVariantNumeric: "tabular-nums" }}>
                  {isNeg ? "" : "+"}{fmtFull(item.diff)}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: "#0a1020", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${barPct}%`, background: isNeg ? "linear-gradient(90deg,#cc4422,#ff6644)" : "linear-gradient(90deg,#22aa66,#44ddaa)", borderRadius: 3 }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 3シナリオサマリー */}
      {triMode && triPessimistic && triOptimistic && (
        <div style={{ background: "linear-gradient(160deg,#0d1a12,#0a1810)", border: "1px solid #2adf9033", borderRadius: 12, padding: "14px 15px", marginBottom: 12 }}>
          <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#2adf90", fontWeight: 700, marginBottom: 10 }}>
            📊 悲観・標準・楽観 3シナリオ比較
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15 }}>
              <thead>
                <tr>
                  <th style={{ color: "#445566", fontSize: 14, textAlign: "left", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingRight: 12 }}>シナリオ</th>
                  <th style={{ color: "#445566", fontSize: 14, textAlign: "left", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingRight: 12 }}>前提</th>
                  {[75, 85, 90, 95].map(a => (
                    <th key={a} style={{ color: "#445566", fontSize: 14, textAlign: "right", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 8 }}>{a}歳</th>
                  ))}
                  <th style={{ color: "#445566", fontSize: 14, textAlign: "right", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 8 }}>枯渇</th>
                  {dwzEnabled && <th style={{ color: "#445566", fontSize: 14, textAlign: "right", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 8 }}>DWZ</th>}
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "🔴 悲観", prefix: `利回り${returnRate + TRI_PESSIMISTIC.returnDelta}% / インフレ${inflationRate + TRI_PESSIMISTIC.inflDelta}%`, result: triPessimistic, color: "#ff8855" },
                  { label: "⚪ 標準", prefix: `利回り${returnRate}% / インフレ${inflationRate}%`, result: withSale, color: "#c8d8e8" },
                  { label: "🟢 楽観", prefix: `利回り${returnRate + TRI_OPTIMISTIC.returnDelta}% / インフレ${inflationRate + TRI_OPTIMISTIC.inflDelta}%`, result: triOptimistic, color: "#55cc88" },
                ].map(({ label, prefix, result, color }) => {
                  const safe = result.depletionAge === null;
                  const dwzOk = dwzEnabled ? (result.data.find(d => d.age === dwzTargetAge)?.assets ?? 0) >= dwzTargetAmount * 1e4 : false;
                  return (
                    <tr key={label}>
                      <td style={{ color, fontWeight: 700, paddingTop: 8, paddingRight: 12 }}>{label}</td>
                      <td style={{ color: "#445566", fontSize: 14, paddingTop: 8, paddingRight: 12 }}>{prefix}</td>
                      {[75, 85, 90, 95].map(a => {
                        const v = result.data.find(d => d.age === a)?.assets ?? 0;
                        return <td key={a} style={{ textAlign: "right", paddingTop: 8, paddingLeft: 8, color: v > 0 ? color : "#ff5577", fontVariantNumeric: "tabular-nums" }}>{fmtFull(Math.max(v, 0))}</td>;
                      })}
                      <td style={{ textAlign: "right", paddingTop: 8, paddingLeft: 8, color: safe ? "#4adfb0" : "#ff5577", fontWeight: 600 }}>{safe ? "安全" : `${result.depletionAge}歳`}</td>
                      {dwzEnabled && <td style={{ textAlign: "right", paddingTop: 8, paddingLeft: 8, color: dwzOk ? "#c080ff" : "#ff7799" }}>{dwzOk ? "✓" : "✗"}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── ストレステストサマリー */}
      {stressMode && stressResult && (
        <div style={{ background: "linear-gradient(160deg,#1a1400,#18120a)", border: "1px solid #ffcc4433", borderRadius: 12, padding: "14px 15px", marginBottom: 12 }}>
          <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#ffcc44", fontWeight: 700, marginBottom: 4 }}>
            ⚡ ストレステスト結果
          </div>
          <div style={{ fontSize: 15, color: "#aa8833", marginBottom: 10 }}>
            適用中：{STRESS_PRESETS.find(p => p.id === stressPresetId)?.label}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, marginBottom: 10 }}>
            {[75, 85, 90].map(a => {
              const normal = withSale.data.find(d => d.age === a)?.assets ?? 0;
              const stress = stressResult.data.find(d => d.age === a)?.assets ?? 0;
              const diff = stress - normal;
              return (
                <div key={a} style={{ background: "#100e00", border: "1px solid #33280a", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 14, color: "#666644", marginBottom: 3 }}>{a}歳時点</div>
                  <div style={{ fontSize: 16, color: "#ffcc44", fontWeight: 600 }}>{fmtFull(Math.max(stress, 0))}</div>
                  <div style={{ fontSize: 14, color: diff >= 0 ? "#88cc66" : "#ff8855", marginTop: 2 }}>
                    通常比 {diff >= 0 ? "+" : ""}{fmtFull(diff)}
                  </div>
                </div>
              );
            })}
            <div style={{ background: "#100e00", border: "1px solid #33280a", borderRadius: 8, padding: "8px 10px" }}>
              <div style={{ fontSize: 14, color: "#666644", marginBottom: 3 }}>枯渇リスク</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: stressResult.depletionAge ? "#ff5577" : "#4adfb0" }}>
                {stressResult.depletionAge ? `${stressResult.depletionAge}歳` : "安全圏"}
              </div>
              <div style={{ fontSize: 14, color: "#556644", marginTop: 2 }}>
                通常：{withSale.depletionAge ? `${withSale.depletionAge}歳` : "安全圏"}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 14, color: "#555533", paddingTop: 8, borderTop: "1px solid #2a2010" }}>
            {STRESS_PRESETS.find(p => p.id === stressPresetId)?.desc}
          </div>
        </div>
      )}

      {/* 売却サマリー */}
      {saleEnabled && (
        <div style={{ ...LP, marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "flex-start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 14, color: "#f0a040", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>🏷 会社売却</div>
            <div style={{ fontSize: 21, color: "#f0c060", fontWeight: 700, marginTop: 2 }}>{saleSaleAge}歳 → 手取り {fmtFull(afterTax)}</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7, flex: 1, minWidth: 220 }}>
            <StatCard label="税負担" value={fmtFull(taxAmount)} color="#ff8899" />
            <StatCard label="80歳差分" value={(impactAt80 >= 0 ? "+" : "") + fmtFull(impactAt80)} color={impactAt80 >= 0 ? "#4adfb0" : "#ff5577"} sub="あり vs なし" />
            <StatCard label="売却なし" value={isNoSaleSafe ? "生涯安全" : `${noSale.depletionAge}歳`} color={isNoSaleSafe ? "#4adfb0" : "#ff5577"} />
          </div>
        </div>
      )}

      {/* グラフ */}
      <div style={{ ...P, marginBottom: 12 }}>
        <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#4a9eff", marginBottom: 8, fontWeight: 700 }}>資産推移グラフ</div>
        {/* 凡例 */}
        <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
          {[
            { color: "#4a9eff", label: `運用（利回り ${returnRate}%）` },
            { color: "#4adfb0", label: "手元（利回りなし）" },
            { color: "#556677", label: "売却なし 合計", dash: true },
            ...(triMode ? [
              { color: "#ff8855", label: `悲観（利回り${returnRate + TRI_PESSIMISTIC.returnDelta}%/インフレ${inflationRate + TRI_PESSIMISTIC.inflDelta}%）`, dash: true },
              { color: "#55cc88", label: `楽観（利回り${returnRate + TRI_OPTIMISTIC.returnDelta}%/インフレ${inflationRate + TRI_OPTIMISTIC.inflDelta}%）`, dash: true },
            ] : []),
            ...(stressMode && stressResult ? [
              { color: "#ffcc44", label: `ストレス：${STRESS_PRESETS.find(p=>p.id===stressPresetId)?.label}`, dash: true },
            ] : []),
          ].map(({ color, label, dash }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 18, height: 2, borderTop: `2px ${dash ? "dashed" : "solid"}`, borderColor: color }} />
              <span style={{ fontSize: 14, color: "#556677" }}>{label}</span>
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
            <XAxis dataKey="age" tick={{ fill: "#445566", fontSize: 14 }} tickFormatter={v => `${v}歳`} interval={4} />
            <YAxis tick={{ fill: "#445566", fontSize: 14 }} tickFormatter={fmt} width={54} />
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
                label={{ value: "💸", fill: "#ff6644", fontSize: 14 }} />
            ))}
            <ReferenceLine x={pensionAge} stroke="#4adfb0" strokeDasharray="3 3" strokeOpacity={0.5}
              label={{ value: "年金", fill: "#4adfb0", fontSize: 13 }} />
            {saleEnabled && (
              <ReferenceLine x={saleSaleAge} stroke="#f0a040" strokeDasharray="4 3"
                label={{ value: "売却", fill: "#f0a040", fontSize: 13 }} />
            )}
            {dwzEnabled && (
              <ReferenceLine x={dwzTargetAge} stroke="#a040f0" strokeDasharray="3 3"
                label={{ value: `DWZ目標 ${fmtFull(dwzTargetAmount * 1e4)}`, fill: "#a040f0", fontSize: 13 }} />
            )}
            {withSale.depletionAge && (
              <ReferenceLine x={withSale.depletionAge} stroke="#ff5577" strokeDasharray="4 3"
                label={{ value: `${withSale.depletionAge}歳`, fill: "#ff5577", fontSize: 14 }} />
            )}
            {/* 売却なし合計（背景点線） */}
            <Area type="monotone" dataKey="assetsNoSale" stroke="#556677" strokeWidth={1.5} fill="url(#gNoSale)" dot={false} strokeDasharray="4 3" />
            {/* 手元バケツ（積み上げ下段） */}
            <Area type="monotone" dataKey="cashClamped" stroke="#4adfb0" strokeWidth={1.5} fill="url(#gCash)" dot={false} stackId="bucket" />
            {/* 運用バケツ（積み上げ上段） */}
            <Area type="monotone" dataKey="investedClamped" stroke="#4a9eff" strokeWidth={2} fill="url(#gInv)" dot={false} stackId="bucket" />
            {/* 3シナリオ表示 */}
            {triMode && <Line type="monotone" dataKey="assetsPessimistic" stroke="#ff8855" strokeWidth={1.5} dot={false} strokeDasharray="5 3" connectNulls />}
            {triMode && <Line type="monotone" dataKey="assetsOptimistic"  stroke="#55cc88" strokeWidth={1.5} dot={false} strokeDasharray="5 3" connectNulls />}
            {/* ストレスライン */}
            {stressMode && stressResult && <Line type="monotone" dataKey="assetsStress" stroke="#ffcc44" strokeWidth={1.5} dot={false} strokeDasharray="4 2" connectNulls />}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* コントロール */}
      <div className="no-print" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(270px, 100%), 1fr))", gap: 11 }}>

        {/* 資産 & 2バケツ */}
        <div style={P}>
          <Sec title={<Tip term="bucket2">資産 & 2バケツ配分</Tip>}>
            <SliderInput label="現在の年齢" value={currentAge} min={30} max={70} step={1} unit="歳" onChange={setCurrentAge} />
            <SliderInput label="総資産" value={totalAssets} min={0} max={50000} step={100} unit=""
              display={v => fmtFull(v * 1e4)}
              onChange={v => { setTotalAssets(v); if (investedAssets > v) setInvestedAssets(v); }} />
            <BucketBar totalAssets={totalAssets} investedAssets={safeInvested} onChange={setInvestedAssets} />
              <SliderInput label="継続収入 → 運用に回す割合" value={incomeInvestRatioPct ?? investRatioPct} min={0} max={100} step={1} unit="%" onChange={setIncomeInvestRatioPct} accent="#2adf90" />
              <SliderInput label="一時収入（売却/退職金/相続）→ 運用に回す割合" value={windfallInvestRatioPct ?? investRatioPct} min={0} max={100} step={1} unit="%" onChange={setWindfallInvestRatioPct} accent="#f0a040" />
            <div style={{ background: "#0a1520", border: "1px solid #1e3a5f22", borderRadius: 7, padding: "8px 10px", fontSize: 15 }}>
              <InfoRow label="収入・売却金の按分" value={`運用 ${investRatioPct}% / 手元 ${100 - investRatioPct}%`} color="#4a9eff" />
              <InfoRow label="支出の優先順" value="手元 → 運用（自動補填）" color="#556677" />
            </div>
          </Sec>
          <Sec title="生活費（年齢帯別）・運用" color="#ff8899">
            <div style={{ fontSize: 14, color: "#556677", marginBottom: 8 }}>年齢帯ごとに月間生活費を設定できます</div>
            <div className="mobile-scroll"><div style={{ display: "grid", gridTemplateColumns: "14px 1fr 46px 8px 46px 52px 20px", gap: 4, marginBottom: 5, minWidth: 300 }}>
              <span /><span style={{ ...S, fontSize: 14 }}>期間名</span><span style={{ ...S, fontSize: 14 }}>開始</span><span />
              <span style={{ ...S, fontSize: 14 }}>終了</span><span style={{ ...S, fontSize: 14 }}>万/月</span><span />
            </div>
            {expensePhases.map((ph, idx) => (
              <div key={ph.id} style={{ display: "grid", gridTemplateColumns: "14px 1fr 46px 8px 46px 52px 20px", gap: 4, alignItems: "center", marginBottom: 6, minWidth: 300 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: ph.enabled ? "#ff8899" : "#334455", margin: "0 auto", cursor: "pointer" }}
                  onClick={() => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, enabled: !p.enabled } : p))} />
                <input value={ph.label} onChange={e => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, label: e.target.value } : p))}
                  style={{ background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#c8d8e8", padding: "4px 6px", fontSize: 15, outline: "none", fontFamily: "inherit", width: "100%" }} />
                <NumCell value={ph.fromAge} min={30} max={99} onChange={v => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, fromAge: v } : p))} />
                <span style={{ color: "#334455", fontSize: 14, textAlign: "center" }}>→</span>
                <NumCell value={ph.toAge} min={ph.fromAge + 1} max={101} onChange={v => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, toAge: v } : p))} />
                <NumCell value={ph.monthly} min={0} max={999} onChange={v => setExpensePhases(ps => ps.map(p => p.id === ph.id ? { ...p, monthly: v } : p))} />
                <button onClick={() => setExpensePhases(ps => ps.filter(p => p.id !== ph.id))} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 17, padding: 0, lineHeight: 1 }}>✕</button>
              </div>
            ))}
            </div>{/* /mobile-scroll */}
            <AddBtn onClick={() => { const last = expensePhases[expensePhases.length - 1]; setExpensePhases(ps => [...ps, { id: nextExpId, label: "期間", fromAge: last?.toAge ?? currentAge, toAge: (last?.toAge ?? currentAge) + 10, monthly: 30, enabled: true }]); setNextExpId(n => n + 1); }} color="#ff8899">＋ 期間を追加</AddBtn>
            <div style={{ marginTop: 10, background: "#0a1520", border: "1px solid #1e3a5f22", borderRadius: 7, padding: "7px 9px" }}>
              <SliderInput label="インフレ率" value={inflationRate} min={0} max={5} step={0.1} unit="%" onChange={setInflationRate} />
              <SliderInput label="運用資産 利回り（年率）" value={returnRate} min={0} max={10} step={0.1} unit="%" onChange={setReturnRate} accent="#4a9eff" />
              <InfoRow label="うちローン（月）" value={`${totalLoanMonthly}万円`} color="#aa88ff" />
            </div>
            <SliderInput label="手元バケツ下限（生活費の何ヶ月分）" value={cashBufferMonths} min={0} max={60} step={1} unit="ヶ月" onChange={setCashBufferMonths} accent="#ff8899" />
            <div style={{ background: "#0a1520", border: "1px solid #1e3a5f22", borderRadius: 7, padding: "6px 9px" }}>
              <InfoRow label="補充トリガー残高（目安）" value={fmtFull(
                (() => { const p = expensePhases.filter(x=>x.enabled)[0]; return (p?.monthly ?? 30) * cashBufferMonths * 1e4; })()
              )} color="#ff8899" />
            </div>
          </Sec>
          {/* 逆算ソルバー */}
          <div style={{ background: "linear-gradient(160deg,#0a1a10,#081408)", border: "1px solid #2adf9033", borderRadius: 10, padding: "13px 14px", marginTop: 4 }}>
            <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#2adf90", fontWeight: 700, marginBottom: 8 }}>逆算 — 最大生活費</div>
            <div style={{ fontSize: 14, color: "#445566", marginBottom: 10 }}>現在の設定で枯渇しない最大の生活費増加額を計算します</div>
            <button onClick={runSolver}
              style={{ width: "100%", background: "#0d2a18", border: "1px solid #2adf9066", borderRadius: 7, color: "#2adf90", fontSize: 16, padding: "8px 0", cursor: "pointer", fontFamily: "inherit", fontWeight: 700, marginBottom: 10 }}>
              ▶ 逆算を実行
            </button>
            {solverResult && (
              <div>
                {solverResult.delta === -1 ? (
                  <div style={{ background: "#1a0808", border: "1px solid #ff557744", borderRadius: 7, padding: "8px 10px" }}>
                    <div style={{ color: "#ff5577", fontSize: 16, fontWeight: 700 }}>⚠ 現状でも枯渇リスクあり</div>
                    <div style={{ color: "#667788", fontSize: 15, marginTop: 4 }}>枯渇年齢: {solverResult.depletionAge}歳</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ background: "#001510", border: "1px solid #2adf9033", borderRadius: 7, padding: "8px 10px", marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ color: "#445566", fontSize: 15 }}>最大追加（安全）</span>
                        <span style={{ color: "#2adf90", fontSize: 20, fontWeight: 700 }}>+{solverResult.delta}万/月</span>
                      </div>
                      {expensePhases.filter(p => p.enabled).map(p => (
                        <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#556677", marginBottom: 2 }}>
                          <span>{p.label}</span>
                          <span>{p.monthly} → <span style={{ color: "#88ddaa" }}>{p.monthly + solverResult.delta}万/月</span></span>
                        </div>
                      ))}
                      <button onClick={() => applyDelta(solverResult.delta)}
                        style={{ width: "100%", marginTop: 8, background: "#0a2818", border: "1px solid #2adf9088", borderRadius: 6, color: "#2adf90", fontSize: 15, padding: "6px 0", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
                        このΔを支出設定に適用
                      </button>
                    </div>
                    {dwzEnabled && solverResult.deltaDwz !== null && (
                      <div style={{ background: "#0e0615", border: "1px solid #a040f033", borderRadius: 7, padding: "8px 10px" }}>
                        {solverResult.deltaDwz === -1 ? (
                          <div style={{ color: "#ff7799", fontSize: 15 }}>⚠ DWZ目標は現状でも未達</div>
                        ) : (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                              <span style={{ color: "#445566", fontSize: 15 }}>最大追加（DWZ達成）</span>
                              <span style={{ color: "#c080ff", fontSize: 20, fontWeight: 700 }}>+{solverResult.deltaDwz}万/月</span>
                            </div>
                            {expensePhases.filter(p => p.enabled).map(p => (
                              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#556677", marginBottom: 2 }}>
                                <span>{p.label}</span>
                                <span>{p.monthly} → <span style={{ color: "#c080ff" }}>{p.monthly + solverResult.deltaDwz}万/月</span></span>
                              </div>
                            ))}
                            <button onClick={() => applyDelta(solverResult.deltaDwz)}
                              style={{ width: "100%", marginTop: 8, background: "#100820", border: "1px solid #a040f088", borderRadius: 6, color: "#c080ff", fontSize: 15, padding: "6px 0", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
                              このΔを支出設定に適用（DWZ）
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 収入フェーズ */}
        <div style={IP}>
          <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#2adf90", borderBottom: "1px solid #2adf9025", paddingBottom: 5, marginBottom: 11, fontWeight: 700 }}>収入フェーズ</div>
          <SliderInput label={<Tip term="takeRate">デフォルト手取り率</Tip>} value={defaultTakeRate} min={50} max={100} step={1} unit="%" onChange={setDefaultTakeRate} accent="#2adf90" />
          <div style={{ background: "#001510", border: "1px solid #2adf9018", borderRadius: 7, padding: "5px 9px", marginBottom: 8, fontSize: 14, color: "#445566" }}>
            各フェーズで個別設定がない場合にこの値が使われます
          </div>
          {incomePhases.map((ph, idx) => (
            <PhaseRow key={ph.id} phase={ph} idx={idx}
              onUpdate={u => setIncomePhases(ps => ps.map(p => p.id === ph.id ? u : p))}
              onDelete={() => setIncomePhases(ps => ps.filter(p => p.id !== ph.id))}
              currentAge={currentAge} defaultTakeRate={defaultTakeRate} />
          ))}
          {incomePhases.length < 3 && (
            <AddBtn onClick={() => { const last = incomePhases[incomePhases.length - 1]; setIncomePhases(ps => [...ps, { id: nextPhaseId, label: "収入フェーズ", fromAge: last?.toAge ?? currentAge, toAge: (last?.toAge ?? currentAge) + 5, monthly: 50, enabled: true, takeRate: defaultTakeRate }]); setNextPhaseId(n => n + 1); }} color="#2adf90">＋ フェーズを追加（最大3件）</AddBtn>
          )}
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
              <span /><span style={{ ...S, fontSize: 14 }}>名称</span><span style={{ ...S, fontSize: 14 }}>万/月</span><span style={{ ...S, fontSize: 14 }}>終了歳</span><span />
            </div>
            {loans.map(l => <LoanRow key={l.id} loan={l} onUpdate={u => setLoans(ls => ls.map(x => x.id === l.id ? u : x))} onDelete={() => setLoans(ls => ls.filter(x => x.id !== l.id))} />)}
            <AddBtn onClick={() => { setLoans(ls => [...ls, { id: nextLoanId, label: "ローン", monthly: 10, endAge: currentAge + 10, enabled: true }]); setNextLoanId(n => n + 1); }} color="#aa88ff">＋ ローンを追加</AddBtn>
          </Sec>
          <Sec title="突発支出・一時費用" color="#ff6644">
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 50px 54px 20px", gap: 4, marginBottom: 5 }}>
              <span /><span style={{ ...S, fontSize: 14 }}>名称</span><span style={{ ...S, fontSize: 14 }}>年齢</span><span style={{ ...S, fontSize: 14 }}>金額(万)</span><span />
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
          <Sec title="突発収入・一時収入" color="#2adf90">
            <div style={{ fontSize: 14, color: "#556677", marginBottom: 7 }}>退職金・相続・保険金など</div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 50px 54px 20px", gap: 4, marginBottom: 5 }}>
              <span /><span style={{ ...S, fontSize: 14 }}>名称</span><span style={{ ...S, fontSize: 14 }}>年齢</span><span style={{ ...S, fontSize: 14 }}>金額(万)</span><span />
            </div>
            {oneTimeIncomes.map(ev => (
              <div key={ev.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr 50px 54px 20px", gap: 4, alignItems: "center", marginBottom: 6 }}>
                <Toggle value={ev.enabled} onChange={v => setOneTimeIncomes(es => es.map(e => e.id === ev.id ? { ...e, enabled: v } : e))} color="#2adf90" />
                <input value={ev.label} onChange={e => setOneTimeIncomes(es => es.map(x => x.id === ev.id ? { ...x, label: e.target.value } : x))}
                  style={{ background: "#060e18", border: "1px solid #1e3a5f", borderRadius: 5, color: "#c8d8e8", padding: "4px 6px", fontSize: 15, outline: "none", fontFamily: "inherit", width: "100%" }} />
                <NumCell value={ev.age} min={1} max={100} onChange={v => setOneTimeIncomes(es => es.map(e => e.id === ev.id ? { ...e, age: v } : e))} />
                <NumCell value={ev.amount} min={0} max={99999} onChange={v => setOneTimeIncomes(es => es.map(e => e.id === ev.id ? { ...e, amount: v } : e))} />
                <button onClick={() => setOneTimeIncomes(es => es.filter(e => e.id !== ev.id))} style={{ background: "none", border: "none", color: "#334455", cursor: "pointer", fontSize: 17, padding: 0, lineHeight: 1 }}>✕</button>
              </div>
            ))}
            <AddBtn onClick={() => { setOneTimeIncomes(es => [...es, { id: nextIncomeEventId, label: "一時収入", age: currentAge + 10, amount: 500, enabled: true }]); setNextIncomeEventId(n => n + 1); }} color="#2adf90">＋ 一時収入を追加</AddBtn>
            {oneTimeIncomes.filter(e => e.enabled).length > 0 && (
              <div style={{ marginTop: 8, background: "#001510", border: "1px solid #2adf9018", borderRadius: 7, padding: "7px 9px" }}>
                {oneTimeIncomes.filter(e => e.enabled).map(ev => <InfoRow key={ev.id} label={`${ev.age}歳: ${ev.label}`} value={`+${fmtFull(ev.amount * 1e4)}`} color="#2adf90" />)}
                <InfoRow label="合計" value={`+${fmtFull(oneTimeIncomes.filter(e=>e.enabled).reduce((a,e) => a + e.amount, 0) * 1e4)}`} color="#2adf90" />
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
              <SliderInput label={<Tip term="macroSlide">マクロ経済スライド（年率）</Tip>} value={pensionSlideRate} min={-1.0} max={0} step={0.1} unit="%" onChange={setPensionSlideRate} accent="#4adfb0" />
              <div style={{ background: "#001510", border: "1px solid #2adf9018", borderRadius: 7, padding: "6px 9px" }}>
                <InfoRow label={`受給開始から20年後（${pensionAge+20}歳）`} value={`${(pensionAmount * Math.pow(1 + pensionSlideRate/100, 20)).toFixed(1)}万/月`} color="#4adfb0" />
              </div>
            </Sec>
            <Sec title="個人年金">
              <SliderInput label="受給開始年齢" value={privatePensionAge} min={55} max={75} step={1} unit="歳" onChange={setPrivatePensionAge} />
              <SliderInput label="月額" value={privatePensionAmount} min={0} max={30} step={1} unit="万/月" onChange={setPrivatePensionAmount} />
              <SliderInput label="受給期間" value={privatePensionYears} min={1} max={30} step={1} unit="年間" onChange={setPrivatePensionYears} />
            </Sec>
          </div>

          <div style={saleEnabled ? LP : P}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#f0a040", fontWeight: 700 }}>会社売却シナリオ</div>
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
              <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#a040f0", fontWeight: 700 }}><Tip term="DWZ">Die with Zero モード</Tip></div>
              {dwzEnabled && <div style={{ fontSize: 14, color: "#667788", marginTop: 2 }}>目標年齢での残高目標を設定</div>}
            </div>
            <Toggle value={dwzEnabled} onChange={setDwzEnabled} color="#a040f0" />
          </div>
          {dwzEnabled && (
            <>
              <SliderInput label="目標年齢" value={dwzTargetAge} min={70} max={100} step={1} unit="歳" onChange={setDwzTargetAge} accent="#a040f0" />
              <SliderInput label="目標残高" value={dwzTargetAmount} min={0} max={10000} step={100} unit="" display={v => fmtFull(v * 1e4)} onChange={setDwzTargetAmount} accent="#a040f0" />
              <div style={{ background: "#0e0615", border: `1px solid ${dwzOnTrack ? "#a040f044" : "#ff557744"}`, borderRadius: 7, padding: "9px 11px", marginTop: 4 }}>
                <div style={{ fontSize: 14, color: dwzOnTrack ? "#c080ff" : "#ff7799", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5 }}>
                  {dwzOnTrack ? "✓ 目標クリア" : "⚠ 目標オーバー（使い残し）"}
                </div>
                <InfoRow label={`${dwzTargetAge}歳時点の推定残高`} value={fmtFull(dwzActual)} color="#c080ff" />
                <InfoRow label="目標との差分" value={(dwzDiff >= 0 ? "+" : "") + fmtFull(dwzDiff)} color={dwzOnTrack ? "#a040f0" : "#ff8899"} />
                {!dwzOnTrack && <div style={{ fontSize: 14, color: "#ff7799", marginTop: 6 }}>→ 生活費を増やすか、目標残高を上げてください</div>}
                {dwzOnTrack && dwzDiff > 0 && <div style={{ fontSize: 14, color: "#a040f0", marginTop: 6 }}>→ 年間 {fmtFull(dwzDiff / Math.max(dwzTargetAge - currentAge, 1))} 追加消費できます</div>}
              </div>
            </>
          )}
        </div>
      </div>


        {/* ── ストレステスト設定 */}
        {stressMode && (
          <div style={{ background: "linear-gradient(160deg,#1a1400,#18120a)", border: "1px solid #ffcc4455", borderRadius: 12, padding: "16px 15px" }}>
            <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#ffcc44", fontWeight: 700, marginBottom: 12 }}>⚡ ストレステスト設定</div>
            {STRESS_PRESETS.map(preset => (
              <div key={preset.id}
                onClick={() => setStressPresetId(preset.id)}
                style={{ background: stressPresetId === preset.id ? "#2a2000" : "#100e00", border: `1px solid ${stressPresetId === preset.id ? "#ffcc44" : "#2a2010"}`, borderRadius: 8, padding: "10px 12px", marginBottom: 8, cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: stressPresetId === preset.id ? "#ffcc44" : "#334433", flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 16, color: stressPresetId === preset.id ? "#ffcc44" : "#778866", fontWeight: 600 }}>{preset.label}</div>
                    <div style={{ fontSize: 14, color: "#555533", marginTop: 2 }}>{preset.desc}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      {/* マイルストーンテーブル */}
      <div style={{ ...P, marginTop: 11 }}>
        <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#4a9eff", marginBottom: 11, fontWeight: 700 }}>マイルストーン別 残高</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15, minWidth: 640 }}>
            <thead>
              <tr>
                <th style={{ color: "#445566", fontSize: 14, textAlign: "left", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingRight: 10 }}>項目</th>
                {[50, 55, 60, 65, 70, 75, 80, 85, 90, 95].map(a => (
                  <th key={a} style={{ color: "#445566", fontSize: 14, textAlign: "right", paddingBottom: 6, borderBottom: "1px solid #1e3a5f", paddingLeft: 5 }}>{a}歳</th>
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

      {/* ── 生活言語への翻訳 */}
      {(() => {
        // DWZモードON時はdwzTargetAge、OFF時は90歳を計算基準年齢とする
        const horizonAge = dwzEnabled ? dwzTargetAge : 100;
        const effectivelySafe2 = isSafe || (dwzEnabled && (withSale.data.find(d => d.age === horizonAge)?.assets ?? 0) >= 0);
        // 逆算ソルバーが実行済みなら solverResult.delta を、未実行なら簡易推算
        const extraMonthly = solverResult && solverResult.delta >= 0 ? solverResult.delta : (() => {
          const atHorizon = withSale.data.find(d => d.age === horizonAge)?.assets ?? 0;
          if (atHorizon <= 0 || !effectivelySafe2) return 0;
          const remainYears = Math.max(horizonAge - currentAge, 1);
          return Math.floor(atHorizon / (remainYears * 12 * 1e4));
        })();
        if (extraMonthly <= 0 && effectivelySafe2) return null;
        const travelPerYear = extraMonthly > 0 ? Math.floor(extraMonthly * 12 / TRAVEL_COST_MAN) : 0;
        const carEveryYears = extraMonthly > 0 ? Math.floor(CAR_COST_MAN / (extraMonthly * 12)) : 0;
        const supportPerYear = extraMonthly > 0 ? Math.floor(extraMonthly * 12) : 0;
        return (
          <div style={{ background: "linear-gradient(160deg,#0d1a20,#0a1828)", border: "1px solid #4a9eff33", borderRadius: 12, padding: "16px 15px", marginTop: 12 }}>
            <div style={{ fontSize: 14, letterSpacing: "0.13em", textTransform: "uppercase", color: "#4a9eff", fontWeight: 700, marginBottom: 4 }}>
              💬 この結果を生活に置き換えると
            </div>
            <div style={{ fontSize: 14, color: "#334455", marginBottom: 14 }}>
              ※ 現在の設定に基づく目安です。税務・実際の支出状況によって変わります。
            </div>
            {(() => {
              // DWZモード時はhorizonAgeまでの生存が目標
              const depletionBeforeDwz = dwzEnabled && withSale.depletionAge !== null && withSale.depletionAge <= horizonAge;
              if (!effectivelySafe2 || depletionBeforeDwz) return (
                <div style={{ color: "#ff7799", fontSize: 16, padding: "10px", background: "#200a10", borderRadius: 8 }}>
                  {dwzEnabled
                    ? `${dwzTargetAge}歳までに資産が枯渇する見込みです。支出や収入の設定を見直してください。`
                    : "現在の設定では資産が枯渇する見込みです。まず支出や収入の設定を見直してください。"}
                </div>
              );
              return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
                <div style={{ background: "#080f18", border: "1px solid #1a2a3a", borderRadius: 9, padding: "12px 13px" }}>
                  <div style={{ fontSize: 14, color: "#4a9eff", fontWeight: 700, marginBottom: 6 }}>💴 毎月の追加余力</div>
                  {extraMonthly > 0 ? (
                    <>
                      <div style={{ fontSize: 24, fontWeight: 700, color: "#e8f0fe" }}>+{extraMonthly}万円/月</div>
                      <div style={{ fontSize: 14, color: "#445566", marginTop: 4 }}>{dwzEnabled ? `${dwzTargetAge}歳まで安全を保ちながら増やせる生活費の目安` : "生涯安全を保ちながら増やせる生活費の目安"}</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 16, color: "#445566" }}>現在の生活費がほぼ上限です</div>
                  )}
                </div>
                <div style={{ background: "#080f18", border: "1px solid #1a2a3a", borderRadius: 9, padding: "12px 13px" }}>
                  <div style={{ fontSize: 14, color: "#4adfb0", fontWeight: 700, marginBottom: 6 }}>✈ 旅行の余力（目安）</div>
                  {travelPerYear >= 1 ? (
                    <>
                      <div style={{ fontSize: 24, fontWeight: 700, color: "#e8f0fe" }}>年{travelPerYear}回まで</div>
                      <div style={{ fontSize: 14, color: "#445566", marginTop: 4 }}>旅行1回 {TRAVEL_COST_MAN}万円として換算</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 16, color: "#445566" }}>旅行1回分の余力がない状態です</div>
                  )}
                </div>
                <div style={{ background: "#080f18", border: "1px solid #1a2a3a", borderRadius: 9, padding: "12px 13px" }}>
                  <div style={{ fontSize: 14, color: "#aa88ff", fontWeight: 700, marginBottom: 6 }}>🚗 車の買い替え周期</div>
                  {carEveryYears >= 1 ? (
                    <>
                      <div style={{ fontSize: 24, fontWeight: 700, color: "#e8f0fe" }}>{carEveryYears}年に1回</div>
                      <div style={{ fontSize: 14, color: "#445566", marginTop: 4 }}>車買い替え {CAR_COST_MAN}万円として換算</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 16, color: "#445566" }}>
                      {extraMonthly > 0 ? `約${Math.ceil(CAR_COST_MAN / (extraMonthly * 12))}年分の余力で1回分` : "余力が限られています"}
                    </div>
                  )}
                </div>
                <div style={{ background: "#080f18", border: "1px solid #1a2a3a", borderRadius: 9, padding: "12px 13px" }}>
                  <div style={{ fontSize: 14, color: "#f0a040", fontWeight: 700, marginBottom: 6 }}>🎁 子・孫への援助</div>
                  {supportPerYear > 0 ? (
                    <>
                      <div style={{ fontSize: 24, fontWeight: 700, color: "#e8f0fe" }}>年{supportPerYear}万円まで</div>
                      <div style={{ fontSize: 14, color: "#445566", marginTop: 4 }}>追加余力を援助に充てた場合の目安</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 16, color: "#445566" }}>現在の設定では援助の余力は限られています</div>
                  )}
                </div>
              </div>
              );
            })()}
          </div>
        );
      })()}

      <div style={{ textAlign: "center", marginTop: 16, fontSize: 14, color: "#2a3a4a" }}>
        ※ 試算ツール。税務・資産設計は専門家にご相談ください。　v11.1: 年金収入を手取り換算（公的95%・個人90%）
      </div>
    </div>
  );
}
