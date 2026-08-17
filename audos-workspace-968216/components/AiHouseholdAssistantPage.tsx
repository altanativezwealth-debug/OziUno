import {
  ArrowRight,
  BellRing,
  Boxes,
  Brain,
  CalendarDays,
  Heart,
  Home,
  Layers,
  Link2,
  ListChecks,
  Mic,
  Receipt,
  ShieldCheck,
  ShoppingBasket,
  Sparkles,
  Sunrise,
  Users,
  Wallet,
} from 'lucide-react';
import { STYLES as OZI_STYLES } from './OziUnoPublicPage';
import { homepageHref } from './publicRoutes';

// SEO landing page for the route /ai-household-assistant.
// Rendered by EmailGate.tsx when window.location.pathname matches — the
// platform serves the same SPA bundle on every path, so this is how the
// space exposes additional public pages. All head tags (canonical, title,
// meta description, robots, OG/Twitter, JSON-LD) for this route are injected
// path-aware at module-eval time in EmailGate.tsx, NOT here.
// Design system: reuses the exact .ozi-* styles from OziUnoPublicPage so the
// page is a natural extension of the homepage — only small page-specific
// additions live in PAGE_STYLES below.

const PAGE_STYLES = `
  .ozi-subhero-inner { position: relative; z-index: 1; max-width: 840px; padding: 78px 0 88px; }
  .ozi-subhero-inner h1 { margin: 22px 0 20px; font-size: clamp(42px, 5.6vw, 74px); line-height: 1.02; letter-spacing: -.055em; font-weight: 760; }
  .ozi-page a.ozi-button { text-decoration: none; }
  .ozi-prose { max-width: 780px; display: grid; gap: 18px; color: #c5d0de; font-size: 16px; line-height: 1.8; }
  .ozi-prose p { margin: 0; }
  .ozi-prose strong { color: var(--white); font-weight: 680; }
  @media (min-width: 901px) {
    .ozi-steps-4 { grid-template-columns: repeat(4, 1fr); }
    .ozi-steps-4 .ozi-step { min-height: 250px; }
  }
  @media (max-width: 900px) {
    .ozi-steps-4 .ozi-step:last-child { grid-column: auto; min-height: 0; }
  }
  .ozi-plain-list { display: grid; gap: 10px; max-width: 780px; margin: 0; padding: 0; list-style: none; }
  .ozi-plain-list li { display: flex; align-items: center; gap: 12px; border: 1px solid var(--line); background: rgba(17,31,51,.6); border-radius: 14px; padding: 14px 16px; color: #dce5ef; font-size: 14px; }
  .ozi-plain-list svg { color: var(--teal-bright); flex: 0 0 auto; }
  @media (max-width: 620px) {
    .ozi-subhero-inner { padding: 54px 0 64px; }
    .ozi-subhero-inner h1 { font-size: clamp(36px, 11vw, 54px); }
  }
`;

const featureAreas = [
  {
    icon: ShoppingBasket,
    title: 'Groceries',
    copy: 'Staples run out quietly, and you only notice at dinner time. Tell OziUno what you use and it keeps track of what is running low, so you know what to buy before it becomes a problem.',
  },
  {
    icon: ListChecks,
    title: 'Shopping lists',
    copy: 'Items come up at random moments — in the shower, at work, mid-conversation. Mention them to OziUno as they occur to you and they are captured in one place instead of scattered across notes and memory.',
  },
  {
    icon: Boxes,
    title: 'Household inventory',
    copy: 'Where are the spare batteries? What is in the garage? What expires this week? OziUno keeps a searchable record of what you have and where it lives, so you stop re-buying things you already own.',
  },
  {
    icon: Wallet,
    title: 'Budgets',
    copy: 'It is hard to know what fits this week\u2019s budget when spending lives in your head. OziUno keeps your household budget alongside your shopping needs, so its suggestions respect what you planned to spend.',
  },
  {
    icon: Receipt,
    title: 'Bills and reminders',
    copy: 'A missed due date costs money and peace of mind. Log a bill once — \u201cthe electricity bill is due Friday\u201d — and OziUno surfaces it in your morning briefing before it slips.',
  },
  {
    icon: Heart,
    title: 'Household information',
    copy: 'Allergies, preferences, sizes, appointments, service history, vendor contacts. The small details that make a home run smoothly finally get one reliable place to live.',
  },
];

const steps = [
  {
    icon: Mic,
    title: 'Capture household information',
    copy: 'Speak or type a detail the moment it comes up — a bill, an appointment, something running low, a preference.',
  },
  {
    icon: Layers,
    title: 'Organize it',
    copy: 'OziUno files each detail where it belongs: groceries, inventory, budgets, bills, schedules, household notes.',
  },
  {
    icon: Link2,
    title: 'Connect related details',
    copy: 'Your shopping needs, budget, and due dates are held together — not as separate lists that never talk to each other.',
  },
  {
    icon: Sunrise,
    title: 'Surface what matters',
    copy: 'Each morning, OziUno briefs you on what is happening, what is due, and what needs attention today.',
  },
];

const whoFor = [
  { icon: Home, copy: 'Busy households where the details pile up faster than anyone can track them.' },
  { icon: Users, copy: 'Couples managing a home together who want one shared source of truth.' },
  { icon: CalendarDays, copy: 'Families juggling schedules, appointments, and everyone\u2019s changing plans.' },
  { icon: ShoppingBasket, copy: 'People managing groceries and household supplies who are tired of running out or over-buying.' },
  { icon: Brain, copy: 'Anyone who wants one place for household organization instead of five apps and a stack of sticky notes.' },
];

const faqs = [
  {
    question: 'What is an AI household assistant?',
    answer: 'An AI household assistant is a tool that helps you organize everyday household information — tasks, reminders, shopping needs, budgets, and home details — by letting you capture it in plain language. OziUno stores those details in one organized household memory and surfaces what matters, like due bills or low supplies, in a daily briefing.',
  },
  {
    question: 'What can OziUno help me manage?',
    answer: 'OziUno helps you manage groceries, shopping lists, household inventory, budgets, bills, reminders, family schedules, preferences, and service history. You add details by speaking or typing naturally, and OziUno organizes them for you.',
  },
  {
    question: 'Is OziUno a family organizer?',
    answer: 'OziUno works well as a family organizer, but it is built for entire households — couples, housemates, and people living alone included. If a home has details worth remembering, OziUno can hold them.',
  },
  {
    question: 'Can OziUno help with grocery planning?',
    answer: 'Yes. OziUno tracks your grocery staples, flags what is running low, and suggests what to use up so less goes to waste. Because it also knows your budget, its shopping suggestions respect what you planned to spend.',
  },
  {
    question: 'Can OziUno help track household inventory?',
    answer: 'Yes. OziUno keeps a record of household items with where they are stored, so you can ask things like \u201cwhere are the spare batteries?\u201d, \u201cwhat\u2019s in the garage?\u201d, or \u201cwhat expires this week?\u201d and get a real answer.',
  },
  {
    question: 'Can OziUno help me remember bills and household tasks?',
    answer: 'Yes. Log a bill or task once and OziUno remembers the due date. Your morning briefing surfaces what is due and what needs doing that day, so nothing depends on you remembering it unprompted.',
  },
];

export function AiHouseholdAssistantPage({ onGetStarted }: { onGetStarted: () => void }) {
  // Links back to the homepage must work on every base this bundle is served
  // from (custom domain, /site/<id> preview, ?page= param form) — see
  // components/publicRoutes.ts.
  const homeHref = homepageHref();
  const howItWorksHref = homepageHref('how-it-works');
  const whatItRemembersHref = homepageHref('what-it-remembers');
  const pricingHref = homepageHref('pricing');
  return (
    <div
      className="eg-root ozi-page"
      data-audos-landing-shell="oziuno"
      style={{ height: '100dvh', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}
    >
      <style>{OZI_STYLES}</style>
      <style>{PAGE_STYLES}</style>

      <header className="ozi-hero">
        <nav className="ozi-container ozi-nav" aria-label="Main navigation">
          <a className="ozi-brand" href={homeHref} aria-label="OziUno homepage">
            <span className="ozi-brand-mark"><Home size={20} strokeWidth={2.4} /></span>
            <span>
              <span className="ozi-brand-name">OziUno</span>
              <span className="ozi-brand-tag">Household OS</span>
            </span>
          </a>
          <div className="ozi-nav-links">
            <a href={howItWorksHref}>How it works</a>
            <a href={whatItRemembersHref}>What it remembers</a>
            <a href={pricingHref}>Pricing</a>
            <button type="button" className="ozi-button ozi-button-primary ozi-button-small" onClick={onGetStarted}>
              Get started <ArrowRight size={15} />
            </button>
          </div>
        </nav>

        <div className="ozi-container">
          <div className="ozi-subhero-inner">
            <span className="ozi-eyebrow"><Sparkles size={14} /> AI household assistant</span>
            <h1>Your AI Household <span className="ozi-gradient-text">Assistant</span></h1>
            <p className="ozi-hero-copy">
              Your home has hundreds of little things to remember. OziUno brings them together, helps you stay organized, and surfaces what matters before it gets forgotten.
            </p>
            <div className="ozi-hero-actions">
              <button type="button" className="ozi-button ozi-button-primary" onClick={onGetStarted}>
                Get started <ArrowRight size={18} />
              </button>
              <a className="ozi-button ozi-button-secondary" href={howItWorksHref}>
                See how it works
              </a>
            </div>
            <p className="ozi-trial-note"><ShieldCheck size={16} /> 7 days free · No credit card required to begin</p>
          </div>
        </div>
      </header>

      <main>
        <section id="what-is-an-ai-household-assistant" className="ozi-section">
          <div className="ozi-container">
            <div className="ozi-section-head">
              <p className="ozi-section-kicker">The category, plainly</p>
              <h2>What is an AI household assistant?</h2>
            </div>
            <div className="ozi-prose">
              <p>
                An AI household assistant is a tool that helps you organize and connect the everyday information a home runs on — tasks, reminders, shopping needs, budgets, and the small household details that are easy to lose track of. Instead of keeping all of that in a notes app, on paper lists, and in your head, you tell the assistant about it in plain language, and it keeps everything in one organized place.
              </p>
              <p>
                OziUno is built around that idea. You can type or speak a detail the moment it comes up — <strong>“the electricity bill is due Friday”</strong>, <strong>“we’re almost out of rice”</strong>, <strong>“Emma doesn’t eat mushrooms”</strong> — and OziUno files it where it belongs. Because everything lives together, OziUno can remind you of what matters, when it matters, in a daily morning briefing.
              </p>
              <p>
                It doesn’t need a complicated setup, and it doesn’t pretend to run your home for you. It is a memory and organization layer for your household: one dependable place where the details live, so you don’t have to hold them all yourself. You can see <a className="ozi-inline-link" href={whatItRemembersHref}>everything OziUno remembers</a> on the homepage.
              </p>
            </div>
          </div>
        </section>

        <section id="what-it-covers" className="ozi-section ozi-section-alt">
          <div className="ozi-container">
            <div className="ozi-section-head">
              <p className="ozi-section-kicker">One place for it all</p>
              <h2>Everything your household needs to remember</h2>
              <p className="ozi-section-intro">Every home carries the same quiet workload. OziUno gives each part of it a place to live.</p>
            </div>
            <div className="ozi-memory-grid">
              {featureAreas.map(({ icon: Icon, title, copy }) => (
                <article className="ozi-memory-card" key={title}>
                  <Icon className="ozi-memory-icon" size={24} />
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="connect-the-dots" className="ozi-section">
          <div className="ozi-container">
            <div className="ozi-section-head">
              <p className="ozi-section-kicker">Connect the dots</p>
              <h2>More than a list of tasks</h2>
            </div>
            <div className="ozi-prose">
              <p>
                Most household tools give you another list to maintain: one app for groceries, one for bills, a calendar for appointments, a spreadsheet for the budget. The lists don’t know about each other — so connecting them is still your job.
              </p>
              <p>
                OziUno takes a different approach: it <strong>connects the dots</strong>. Because your groceries, inventory, budget, bills, and schedule live in one household memory, they can inform each other. When staples are running low, OziUno knows what your budget looks like this week. When a bill is due tomorrow, it appears next to today’s appointments in the same briefing — not buried in a separate app you forgot to open.
              </p>
              <p>
                OziUno doesn’t act on your behalf — it won’t pay a bill or place an order for you. What it does is keep the full picture connected and in view, so the decisions you make are easier and nothing important goes missing.
              </p>
            </div>
          </div>
        </section>

        <section id="mental-load" className="ozi-section ozi-section-alt">
          <div className="ozi-container">
            <div className="ozi-section-head">
              <p className="ozi-section-kicker">The invisible workload</p>
              <h2>Built for the mental load of running a home</h2>
              <p className="ozi-section-intro">Someone in every home is quietly keeping track of it all:</p>
            </div>
            <ul className="ozi-plain-list">
              <li><ShoppingBasket size={17} /> What needs buying</li>
              <li><Boxes size={17} /> What is running low</li>
              <li><Receipt size={17} /> What needs paying</li>
              <li><ListChecks size={17} /> What needs doing</li>
              <li><BellRing size={17} /> What needs remembering</li>
            </ul>
            <div className="ozi-prose" style={{ marginTop: 26 }}>
              <p>
                That constant background tracking is real work, even when nothing is written down. OziUno is designed to be the household’s memory and organization layer: the details get captured once, kept organized, and brought back to you at the right moment — instead of circling in your head at midnight.
              </p>
            </div>
          </div>
        </section>

        <section id="how-oziuno-helps" className="ozi-section">
          <div className="ozi-container">
            <div className="ozi-section-head">
              <p className="ozi-section-kicker">How OziUno helps</p>
              <h2>Four simple steps, every day</h2>
              <p className="ozi-section-intro">No forms, no folders to maintain. Talk to OziUno like you’d talk to a very organized housemate — and see the <a className="ozi-inline-link" href={howItWorksHref}>full walkthrough of how OziUno works</a>.</p>
            </div>
            <div className="ozi-steps ozi-steps-4">
              {steps.map(({ icon: Icon, title, copy }, index) => (
                <article className="ozi-step" key={title}>
                  <span className="ozi-step-num">0{index + 1}</span>
                  <span className="ozi-step-icon"><Icon size={23} /></span>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="who-is-oziuno-for" className="ozi-section ozi-section-alt">
          <div className="ozi-container">
            <div className="ozi-section-head">
              <p className="ozi-section-kicker">Made for real homes</p>
              <h2>Who is OziUno for?</h2>
              <p className="ozi-section-intro">Not just parents, and not just families — OziUno is for any household with more to remember than one head should hold.</p>
            </div>
            <ul className="ozi-plain-list">
              {whoFor.map(({ icon: Icon, copy }) => (
                <li key={copy}><Icon size={17} /> {copy}</li>
              ))}
            </ul>
          </div>
        </section>

        <section id="faq" className="ozi-section">
          <div className="ozi-container">
            <div className="ozi-section-head ozi-pricing-head">
              <p className="ozi-section-kicker">Good to know</p>
              <h2>Frequently asked questions</h2>
            </div>
            <div className="ozi-faqs">
              {faqs.map(({ question, answer }) => (
                <details className="ozi-faq" key={question}>
                  <summary>{question}</summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="ozi-final">
          <div className="ozi-container">
            <div className="ozi-final-card">
              <h2>Your home, remembered</h2>
              <p>
                OziUno helps take the everyday details of home life out of your head and into one place — so you can spend less time remembering everything and more time living. Start free, or see <a className="ozi-inline-link" href={pricingHref}>OziUno’s plans and pricing</a>.
              </p>
              <button type="button" className="ozi-button ozi-button-primary" onClick={onGetStarted}>
                Get started <ArrowRight size={18} />
              </button>
            </div>
            <footer className="ozi-footer">
              <span><span className="ozi-footer-brand">OziUno</span> · your AI household assistant</span>
              <a className="ozi-inline-link" href={homeHref}>Return to the OziUno homepage</a>
              <span>© {new Date().getFullYear()} OziUno. Your household memory, ready when you need it.</span>
            </footer>
          </div>
        </section>
      </main>
    </div>
  );
}
