import {
  ArrowUpRight,
  Bot,
  Boxes,
  Check,
  CircleDashed,
  Database,
  MessageSquareText,
  Radio,
  ShieldCheck,
} from "lucide-react";

const configuration = [
  { label: "Supabase", ready: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) },
  { label: "Gemini", ready: Boolean(process.env.GEMINI_API_KEY) },
  { label: "Gateway secret", ready: Boolean(process.env.GATEWAY_HMAC_SECRET) },
  { label: "Support line", ready: Boolean(process.env.SUPPORT_WA_ID) },
];

const stages = [
  { label: "WhatsApp gateway", detail: "Railway / persistent session", icon: Radio },
  { label: "Agent brain", detail: "Vercel / signed webhook", icon: Bot },
  { label: "Catalog truth", detail: "Supabase / live inventory", icon: Database },
];

export default function Home() {
  const readyCount = configuration.filter((item) => item.ready).length;

  return (
    <main className="console-shell">
      <aside className="sidebar">
        <div className="brand-mark" aria-label="Huzaifa Commerce Desk">
          <span>H</span>
        </div>
        <nav aria-label="Primary navigation">
          <a className="nav-item active" href="#overview" aria-label="Overview"><Boxes size={19} /></a>
          <a className="nav-item" href="#messages" aria-label="Messages"><MessageSquareText size={19} /></a>
          <a className="nav-item" href="#catalog" aria-label="Catalog"><Database size={19} /></a>
        </nav>
        <div className="nav-item security" aria-label="Security status"><ShieldCheck size={19} /></div>
      </aside>

      <section className="workspace" id="overview">
        <header className="topbar">
          <div>
            <p className="eyebrow">HUZAIFA / COMMERCE DESK</p>
            <h1>WhatsApp operations</h1>
          </div>
          <div className="environment"><span /> DEVELOPMENT</div>
        </header>

        <div className="readiness-band">
          <div>
            <p className="section-label">SYSTEM READINESS</p>
            <div className="readiness-score">
              <strong>{readyCount}</strong><span>/ {configuration.length} services configured</span>
            </div>
          </div>
          <div className="config-list">
            {configuration.map((item) => (
              <div className="config-item" key={item.label}>
                {item.ready ? <Check size={15} /> : <CircleDashed size={15} />}
                <span>{item.label}</span>
                <b className={item.ready ? "ready" : "pending"}>{item.ready ? "READY" : "PENDING"}</b>
              </div>
            ))}
          </div>
        </div>

        <section className="flow-section">
          <div className="section-heading">
            <div>
              <p className="section-label">MESSAGE PIPELINE</p>
              <h2>Three services. One grounded reply.</h2>
            </div>
            <span className="status-note">Foundation active</span>
          </div>
          <div className="flow-grid">
            {stages.map((stage, index) => {
              const Icon = stage.icon;
              return (
                <article className="flow-stage" key={stage.label}>
                  <div className="stage-number">0{index + 1}</div>
                  <Icon size={24} strokeWidth={1.7} />
                  <h3>{stage.label}</h3>
                  <p>{stage.detail}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="work-grid">
          <article className="work-panel" id="catalog">
            <div className="panel-title">
              <div><p className="section-label">CATALOG</p><h2>Inventory foundation</h2></div>
              <Database size={21} />
            </div>
            <div className="metric"><strong>0</strong><span>published products</span></div>
            <p className="panel-copy">Apply the Supabase migration, then add products with price and stock tracked for each size.</p>
            <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Open Supabase <ArrowUpRight size={15} /></a>
          </article>

          <article className="work-panel" id="messages">
            <div className="panel-title">
              <div><p className="section-label">CONVERSATIONS</p><h2>Human handoff</h2></div>
              <MessageSquareText size={21} />
            </div>
            <div className="metric"><strong>0</strong><span>waiting for support</span></div>
            <p className="panel-copy">Escalated chats pause automation while the owner replies from the linked WhatsApp account.</p>
            <span className="disabled-link">Available after database setup</span>
          </article>
        </section>

        <footer>
          <span>Grounded catalog agent</span>
          <span>PKR / EN / UR / Roman Urdu</span>
        </footer>
      </section>
    </main>
  );
}
