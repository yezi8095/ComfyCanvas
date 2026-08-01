import { useMemo, useState } from "react";

type LedgerItem = {
  id: string;
  title: string;
  detail: string;
  amount: number;
  status: "完成" | "处理中" | "已退回";
  createdAt: number;
};

type DemoAccount = {
  available: number;
  held: number;
  ledger: LedgerItem[];
};

const STORE = "ym-cloud-points-demo-v1";
const initialAccount: DemoAccount = {
  available: 1280,
  held: 0,
  ledger: [
    { id: "welcome", title: "内测体验积分", detail: "新用户体验赠送", amount: 1000, status: "完成", createdAt: Date.now() - 86400000 * 2 },
    { id: "image-demo", title: "高清图片生成", detail: "FLUX · 1024 × 1024", amount: -30, status: "完成", createdAt: Date.now() - 86400000 },
    { id: "refund-demo", title: "视频生成失败退回", detail: "万相 · 5 秒 · 720p", amount: 0, status: "已退回", createdAt: Date.now() - 3600000 * 5 },
    { id: "gift-demo", title: "内测活动赠送", detail: "活动积分", amount: 310, status: "完成", createdAt: Date.now() - 3600000 * 2 },
  ],
};

const packages = [
  { price: 10, points: 1000, gift: 0, label: "轻量体验" },
  { price: 30, points: 3000, gift: 200, label: "创作常用" },
  { price: 68, points: 6800, gift: 700, label: "高频创作", recommended: true },
  { price: 198, points: 19800, gift: 3000, label: "专业制作" },
];

const prices = [
  { name: "标准图片", spec: "1024 × 1024", points: 15, tone: "mint" },
  { name: "高清图片", spec: "最高 2K", points: 30, tone: "blue" },
  { name: "标准视频", spec: "5 秒 · 720p", points: 180, tone: "amber" },
  { name: "高清视频", spec: "10 秒 · 1080p", points: 680, tone: "violet" },
];

const readAccount = (): DemoAccount => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE) || "") as DemoAccount;
    return typeof stored?.available === "number" && Array.isArray(stored.ledger) ? stored : initialAccount;
  } catch {
    return initialAccount;
  }
};

export default function CloudPointsCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"overview" | "recharge" | "ledger">("overview");
  const [account, setAccount] = useState<DemoAccount>(readAccount);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("这是本地交互演示，不会产生真实费用");
  const consumed = useMemo(
    () => Math.abs(account.ledger.filter((item) => item.amount < 0 && item.status === "完成").reduce((sum, item) => sum + item.amount, 0)),
    [account.ledger],
  );

  if (!open) return null;

  const commit = (next: DemoAccount) => {
    setAccount(next);
    localStorage.setItem(STORE, JSON.stringify(next));
  };

  const recharge = (price: number, points: number, gift: number) => {
    const credited = points + gift;
    const next: DemoAccount = {
      ...account,
      available: account.available + credited,
      ledger: [{
        id: crypto.randomUUID(),
        title: "演示充值到账",
        detail: `模拟支付 ¥${price}${gift ? ` · 含赠送 ${gift} 积分` : ""}`,
        amount: credited,
        status: "完成",
        createdAt: Date.now(),
      }, ...account.ledger],
    };
    commit(next);
    setNotice(`${credited.toLocaleString("zh-CN")} 积分已模拟到账`);
    setTab("overview");
  };

  const simulateJob = (success: boolean) => {
    const cost = 180;
    if (busy || account.available < cost) return;
    setBusy(true);
    setNotice(`已冻结 ${cost} 积分，正在模拟提交视频任务…`);
    const itemId = crypto.randomUUID();
    commit({
      ...account,
      available: account.available - cost,
      held: account.held + cost,
      ledger: [{
        id: itemId,
        title: "标准视频生成",
        detail: "万相 · 5 秒 · 720p",
        amount: -cost,
        status: "处理中",
        createdAt: Date.now(),
      }, ...account.ledger],
    });
    window.setTimeout(() => {
      setAccount((current) => {
        const next: DemoAccount = {
          ...current,
          available: current.available + (success ? 0 : cost),
          held: Math.max(0, current.held - cost),
          ledger: current.ledger.map((item) => item.id === itemId ? {
            ...item,
            title: success ? "标准视频生成" : "视频生成失败退回",
            amount: success ? -cost : 0,
            status: success ? "完成" : "已退回",
          } : item),
        };
        localStorage.setItem(STORE, JSON.stringify(next));
        return next;
      });
      setNotice(success ? "生成成功，冻结积分已转为正式消费" : "任务失败，冻结积分已全部退回");
      setBusy(false);
    }, 1100);
  };

  return <div className="points-center-backdrop" onPointerDown={onClose}>
    <section className="points-center" onPointerDown={(event) => event.stopPropagation()}>
      <aside className="points-sidebar">
        <div className="points-brand"><span>YM</span><div><b>亿幕云端</b><small>积分中心 · 演示版</small></div></div>
        <nav>
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><span>⌂</span>账户概览</button>
          <button className={tab === "recharge" ? "active" : ""} onClick={() => setTab("recharge")}><span>＋</span>充值积分</button>
          <button className={tab === "ledger" ? "active" : ""} onClick={() => setTab("ledger")}><span>≡</span>积分明细</button>
        </nav>
        <div className="points-user"><span>湫</span><div><b>亿幕体验账户</b><small>UID 8095 · 内测用户</small></div></div>
      </aside>

      <main className="points-main">
        <header className="points-header">
          <div><small>亿幕画布 / 云端服务</small><h2>{tab === "overview" ? "账户概览" : tab === "recharge" ? "充值积分" : "积分明细"}</h2></div>
          <div className="points-demo-badge">DEMO 演示数据</div>
          <button className="points-close" onClick={onClose}>×</button>
        </header>

        <div className="points-notice"><span>i</span>{notice}</div>

        {tab === "overview" && <>
          <section className="points-balance-card">
            <div><small>可用积分</small><strong>{account.available.toLocaleString("zh-CN")}</strong><p>约可生成 {Math.floor(account.available / 180)} 个标准 5 秒视频</p></div>
            <div className="points-balance-side"><span>冻结中<b>{account.held}</b></span><span>累计消费<b>{consumed}</b></span></div>
            <button onClick={() => setTab("recharge")}>充值积分</button>
          </section>

          <div className="points-section-title"><div><h3>模型价格</h3><small>价格由云端统一返回，提交任务前会再次确认</small></div><button>查看全部模型 →</button></div>
          <section className="points-price-grid">
            {prices.map((item) => <article className={`points-price-card ${item.tone}`} key={item.name}>
              <span>AI</span><div><b>{item.name}</b><small>{item.spec}</small></div><strong>{item.points}<small> 积分/次</small></strong>
            </article>)}
          </section>

          <section className="points-simulator">
            <div><span>任务扣费演示</span><b>标准视频 · 180 积分</b><small>观察“冻结 → 扣费”以及“冻结 → 失败退回”的变化</small></div>
            <button disabled={busy || account.available < 180} onClick={() => simulateJob(true)}>{busy ? "任务处理中…" : "模拟生成成功"}</button>
            <button className="secondary" disabled={busy || account.available < 180} onClick={() => simulateJob(false)}>模拟失败退回</button>
          </section>
        </>}

        {tab === "recharge" && <>
          <section className="points-recharge-intro"><span>余额</span><strong>{account.available.toLocaleString("zh-CN")}</strong><small>积分仅用于亿幕云端生成服务，不可转让或提现</small></section>
          <section className="points-package-grid">
            {packages.map((item) => <article className={item.recommended ? "recommended" : ""} key={item.price}>
              {item.recommended && <em>推荐</em>}
              <small>{item.label}</small><h3>{(item.points + item.gift).toLocaleString("zh-CN")}<span> 积分</span></h3>
              <p>基础 {item.points.toLocaleString("zh-CN")}{item.gift > 0 && <b> + 赠送 {item.gift}</b>}</p>
              <button onClick={() => recharge(item.price, item.points, item.gift)}>演示支付 ¥{item.price}</button>
            </article>)}
          </section>
          <div className="points-payment-note"><b>正式版本支付流程</b><span>创建订单 → 展示支付宝/微信二维码 → 服务端验签回调 → 积分到账</span><small>当前按钮只修改本机演示数据，不会请求支付平台。</small></div>
        </>}

        {tab === "ledger" && <section className="points-ledger">
          <div className="points-ledger-head"><span>项目</span><span>时间</span><span>状态</span><span>积分变化</span></div>
          {account.ledger.map((item) => <div className="points-ledger-row" key={item.id}>
            <div><b>{item.title}</b><small>{item.detail}</small></div>
            <time>{new Date(item.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
            <span className={`status ${item.status === "已退回" ? "refunded" : item.status === "处理中" ? "pending" : ""}`}>{item.status}</span>
            <strong className={item.amount > 0 ? "income" : item.amount < 0 ? "expense" : ""}>{item.amount > 0 ? "+" : ""}{item.amount}</strong>
          </div>)}
        </section>}
      </main>
    </section>
  </div>;
}
