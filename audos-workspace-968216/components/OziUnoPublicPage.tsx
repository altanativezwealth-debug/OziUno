import {
  ArrowRight,
  BellRing,
  Brain,
  CalendarDays,
  Check,
  Heart,
  Home,
  Mic,
  Receipt,
  ShieldCheck,
  ShoppingBasket,
  Sparkles,
  Sunrise,
  Wrench,
} from 'lucide-react';
import { aiAssistantHref } from './publicRoutes';

// Exported so sibling public pages (e.g. AiHouseholdAssistantPage at
// /ai-household-assistant) reuse the exact same design system instead of
// duplicating it.
export const STYLES = `
  .ozi-page, .ozi-page * { box-sizing: border-box; }
  .ozi-page {
    --navy: #07111f;
    --navy-soft: #0f1b2d;
    --panel: #111f33;
    --panel-light: #17273d;
    --teal: #2dd4bf;
    --teal-bright: #5eead4;
    --blue: #38bdf8;
    --white: #f8fafc;
    --muted: #a8b3c5;
    --line: rgba(148, 163, 184, 0.18);
    background: var(--navy);
    color: var(--white);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    min-height: 100%;
    -webkit-font-smoothing: antialiased;
  }
  .ozi-page button, .ozi-page summary { font: inherit; }
  .ozi-page button { -webkit-tap-highlight-color: transparent; }
  .ozi-container { width: min(1160px, calc(100% - 40px)); margin: 0 auto; }
  .ozi-nav { height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
  .ozi-brand { display: inline-flex; align-items: center; gap: 11px; color: var(--white); text-decoration: none; }
  .ozi-brand-mark { width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; color: #04201c; background: linear-gradient(135deg, var(--teal-bright), var(--blue)); box-shadow: 0 8px 30px rgba(45, 212, 191, .2); }
  .ozi-brand-name { font-size: 18px; font-weight: 750; letter-spacing: -.03em; }
  .ozi-brand-tag { display: block; margin-top: 1px; color: var(--muted); font-size: 10px; font-weight: 650; letter-spacing: .13em; text-transform: uppercase; }
  .ozi-nav-links { display: flex; align-items: center; gap: 26px; }
  .ozi-nav-links a { color: #cbd5e1; text-decoration: none; font-size: 14px; transition: color .2s ease; }
  .ozi-nav-links a:hover { color: var(--white); }
  .ozi-button { border: 0; border-radius: 999px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 9px; font-weight: 700; transition: transform .2s ease, box-shadow .2s ease, background .2s ease; }
  .ozi-button:hover { transform: translateY(-2px); }
  .ozi-button-primary { min-height: 52px; padding: 0 23px; color: #04201c; background: linear-gradient(135deg, var(--teal-bright), #22d3ee); box-shadow: 0 14px 34px rgba(45, 212, 191, .2); }
  .ozi-button-primary:hover { box-shadow: 0 18px 42px rgba(45, 212, 191, .3); }
  .ozi-button-small { min-height: 42px; padding: 0 18px; font-size: 14px; }
  .ozi-button-secondary { min-height: 52px; padding: 0 18px; color: var(--white); background: transparent; border: 1px solid var(--line); }
  .ozi-button-secondary:hover { background: rgba(255,255,255,.05); }
  .ozi-hero { position: relative; overflow: hidden; border-bottom: 1px solid var(--line); }
  .ozi-hero::before { content: ""; position: absolute; width: 680px; height: 680px; right: -180px; top: -260px; border-radius: 50%; background: radial-gradient(circle, rgba(45,212,191,.16), rgba(56,189,248,.06) 45%, transparent 70%); pointer-events: none; }
  .ozi-hero-grid { min-height: 650px; padding: 72px 0 88px; display: grid; grid-template-columns: minmax(0, 1.02fr) minmax(400px, .98fr); gap: 68px; align-items: center; position: relative; z-index: 1; }
  .ozi-eyebrow { display: inline-flex; align-items: center; gap: 8px; border: 1px solid rgba(94,234,212,.26); background: rgba(45,212,191,.08); color: var(--teal-bright); border-radius: 999px; padding: 7px 11px; font-size: 12px; font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }
  .ozi-hero h1 { margin: 22px 0 20px; max-width: 690px; font-size: clamp(48px, 6.1vw, 82px); line-height: .98; letter-spacing: -.065em; font-weight: 760; }
  .ozi-gradient-text { color: var(--teal-bright); }
  .ozi-hero-copy { margin: 0; max-width: 610px; color: #b8c4d5; font-size: clamp(18px, 2vw, 21px); line-height: 1.65; }
  .ozi-hero-actions { margin-top: 32px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .ozi-trial-note { margin-top: 18px; display: flex; align-items: center; gap: 9px; color: #8fa0b6; font-size: 13px; }
  .ozi-briefing-wrap { position: relative; }
  .ozi-briefing-glow { position: absolute; inset: 12% 4% -4% 10%; background: rgba(45,212,191,.2); filter: blur(70px); border-radius: 40px; }
  .ozi-briefing-card { position: relative; border: 1px solid rgba(94,234,212,.19); background: linear-gradient(155deg, rgba(23,39,61,.96), rgba(10,23,39,.96)); border-radius: 28px; padding: 26px; box-shadow: 0 28px 80px rgba(0,0,0,.38); }
  .ozi-card-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 21px; border-bottom: 1px solid var(--line); }
  .ozi-card-label { display: flex; align-items: center; gap: 11px; }
  .ozi-card-icon { width: 43px; height: 43px; border-radius: 14px; display: grid; place-items: center; color: var(--teal-bright); background: rgba(45,212,191,.12); }
  .ozi-card-kicker { margin: 0 0 2px; color: var(--teal-bright); font-size: 11px; font-weight: 750; letter-spacing: .11em; text-transform: uppercase; }
  .ozi-card-date { margin: 0; color: #d8e1ed; font-size: 14px; }
  .ozi-live-pill { display: inline-flex; align-items: center; gap: 7px; color: #bdd0df; font-size: 11px; }
  .ozi-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--teal); box-shadow: 0 0 0 5px rgba(45,212,191,.1); }
  .ozi-greeting { margin: 25px 0 12px; font-size: 26px; letter-spacing: -.035em; font-weight: 700; }
  .ozi-briefing-copy { margin: 0; color: #c5d0de; font-size: 15px; line-height: 1.75; }
  .ozi-briefing-copy strong { color: var(--white); font-weight: 680; }
  .ozi-briefing-items { margin-top: 23px; display: grid; gap: 10px; }
  .ozi-briefing-item { display: flex; align-items: center; gap: 12px; border: 1px solid rgba(148,163,184,.13); background: rgba(255,255,255,.035); border-radius: 14px; padding: 12px 13px; color: #dce5ef; font-size: 13px; }
  .ozi-section { padding: 104px 0; }
  .ozi-section-alt { background: #0a1626; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .ozi-section-head { max-width: 680px; margin-bottom: 46px; }
  .ozi-section-kicker { margin: 0 0 12px; color: var(--teal-bright); font-size: 12px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
  .ozi-section h2 { margin: 0; font-size: clamp(34px, 4.2vw, 54px); line-height: 1.08; letter-spacing: -.045em; }
  .ozi-section-intro { margin: 16px 0 0; color: var(--muted); font-size: 17px; line-height: 1.7; }
  .ozi-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  .ozi-step, .ozi-memory-card { border: 1px solid var(--line); background: linear-gradient(145deg, rgba(23,39,61,.72), rgba(15,27,45,.76)); border-radius: 22px; }
  .ozi-step { padding: 27px; min-height: 266px; display: flex; flex-direction: column; }
  .ozi-step-num { color: #607087; font-size: 12px; font-weight: 750; letter-spacing: .14em; }
  .ozi-step-icon { width: 48px; height: 48px; margin: 29px 0 22px; border-radius: 15px; display: grid; place-items: center; background: rgba(45,212,191,.11); color: var(--teal-bright); }
  .ozi-step h3, .ozi-memory-card h3 { margin: 0 0 9px; font-size: 18px; letter-spacing: -.02em; }
  .ozi-step p, .ozi-memory-card p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.65; }
  .ozi-memory-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; }
  .ozi-memory-card { padding: 22px; transition: border-color .2s ease, transform .2s ease; }
  .ozi-memory-card:hover { transform: translateY(-3px); border-color: rgba(94,234,212,.3); }
  .ozi-memory-icon { color: var(--teal-bright); margin-bottom: 23px; }
  .ozi-pricing-head { text-align: center; margin: 0 auto 44px; }
  .ozi-trial-badge { display: inline-flex; align-items: center; gap: 7px; margin-bottom: 17px; padding: 7px 12px; border-radius: 999px; color: #04201c; background: var(--teal-bright); font-size: 12px; font-weight: 800; }
  .ozi-pricing { max-width: 850px; margin: 0 auto; display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; align-items: stretch; }
  .ozi-price-card { position: relative; border: 1px solid var(--line); background: var(--navy-soft); border-radius: 26px; padding: 30px; display: flex; flex-direction: column; }
  .ozi-price-featured { border-color: rgba(94,234,212,.48); background: linear-gradient(160deg, rgba(22,48,63,.95), rgba(15,27,45,.95)); box-shadow: 0 22px 60px rgba(45,212,191,.08); }
  .ozi-best-value { position: absolute; right: 20px; top: 20px; border-radius: 999px; padding: 6px 10px; background: rgba(45,212,191,.12); color: var(--teal-bright); font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; }
  .ozi-plan-name { margin: 0 0 18px; color: #dce5ef; font-size: 15px; font-weight: 700; }
  .ozi-price { display: flex; align-items: flex-end; gap: 6px; }
  .ozi-price strong { font-size: 48px; line-height: 1; letter-spacing: -.05em; }
  .ozi-price span { color: var(--muted); padding-bottom: 5px; }
  .ozi-price-note { min-height: 42px; margin: 11px 0 22px; color: var(--muted); font-size: 13px; line-height: 1.55; }
  .ozi-includes { display: grid; gap: 11px; margin: 0 0 27px; padding: 22px 0 0; border-top: 1px solid var(--line); }
  .ozi-include { display: flex; align-items: center; gap: 9px; color: #cbd5e1; font-size: 13px; }
  .ozi-include svg { color: var(--teal-bright); flex: 0 0 auto; }
  .ozi-price-card .ozi-button { width: 100%; margin-top: auto; }
  .ozi-faqs { display: grid; gap: 12px; max-width: 850px; margin: 0 auto; }
  .ozi-faq { border: 1px solid var(--line); background: rgba(17,31,51,.72); border-radius: 17px; padding: 0 21px; }
  .ozi-faq summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 21px 0; color: var(--white); font-weight: 680; }
  .ozi-faq summary::-webkit-details-marker { display: none; }
  .ozi-faq summary::after { content: "+"; color: var(--teal-bright); font-size: 24px; font-weight: 350; transition: transform .2s ease; }
  .ozi-faq[open] summary::after { transform: rotate(45deg); }
  .ozi-faq p { margin: -4px 0 21px; max-width: 720px; color: var(--muted); font-size: 14px; line-height: 1.7; }
  .ozi-inline-link { color: var(--teal-bright); text-decoration: underline; text-underline-offset: 3px; }
  .ozi-inline-link:hover { color: var(--white); }
  .ozi-final { padding: 48px 0 28px; }
  .ozi-final-card { overflow: hidden; position: relative; border: 1px solid rgba(94,234,212,.22); border-radius: 30px; padding: 62px 40px; text-align: center; background: linear-gradient(135deg, #102a36, #11223a 58%, #122039); }
  .ozi-final-card::before { content: ""; position: absolute; width: 430px; height: 430px; border-radius: 50%; left: 50%; top: -330px; transform: translateX(-50%); background: rgba(45,212,191,.24); filter: blur(60px); }
  .ozi-final-card > * { position: relative; }
  .ozi-final-card h2 { max-width: 700px; margin: 0 auto 14px; font-size: clamp(34px, 5vw, 55px); line-height: 1.08; letter-spacing: -.05em; }
  .ozi-final-card p { margin: 0 auto 27px; max-width: 570px; color: #b9c6d7; font-size: 16px; line-height: 1.65; }
  .ozi-footer { padding: 34px 0; display: flex; align-items: center; justify-content: space-between; gap: 24px; color: #7f8da1; font-size: 12px; }
  .ozi-footer-brand { color: #dce5ef; font-weight: 700; }
  @media (max-width: 900px) {
    .ozi-nav-links a { display: none; }
    .ozi-hero-grid { grid-template-columns: 1fr; gap: 52px; padding: 64px 0 76px; }
    .ozi-hero-copy { max-width: 680px; }
    .ozi-briefing-wrap { max-width: 650px; }
    .ozi-steps, .ozi-memory-grid { grid-template-columns: repeat(2, 1fr); }
    .ozi-step:last-child { grid-column: 1 / -1; min-height: 230px; }
  }
  @media (max-width: 620px) {
    .ozi-container { width: min(100% - 28px, 1160px); }
    .ozi-nav { height: 68px; }
    .ozi-brand-tag { display: none; }
    .ozi-nav .ozi-button-small { min-height: 38px; padding: 0 14px; }
    .ozi-hero-grid { min-height: 0; padding: 52px 0 62px; gap: 42px; }
    .ozi-hero h1 { margin-top: 18px; font-size: clamp(43px, 13vw, 62px); }
    .ozi-hero-copy { font-size: 17px; }
    .ozi-hero-actions { align-items: stretch; flex-direction: column; }
    .ozi-hero-actions .ozi-button { width: 100%; }
    .ozi-briefing-card { padding: 20px; border-radius: 22px; }
    .ozi-live-pill { display: none; }
    .ozi-greeting { font-size: 22px; }
    .ozi-section { padding: 76px 0; }
    .ozi-section-head { margin-bottom: 32px; }
    .ozi-steps, .ozi-memory-grid, .ozi-pricing { grid-template-columns: 1fr; }
    .ozi-step:last-child { grid-column: auto; }
    .ozi-step { min-height: 0; }
    .ozi-final-card { padding: 48px 22px; }
    .ozi-footer { align-items: flex-start; flex-direction: column; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ozi-page *, .ozi-page *::before, .ozi-page *::after { scroll-behavior: auto !important; transition: none !important; }
  }
`;

const steps = [
  {
    icon: Mic,
    title: 'Capture anything',
    copy: 'Speak or type a detail the moment it comes up — an appointment, a bill, a preference, or a passing reminder.',
  },
  {
    icon: Brain,
    title: 'Build household memory',
    copy: 'OziUno connects the details into a persistent, searchable memory that gets more useful every day.',
  },
  {
    icon: Sunrise,
    title: 'Wake up prepared',
    copy: 'Start each morning with a proactive briefing: what is happening, what is due, and what to do next.',
  },
];

const memories = [
  { icon: CalendarDays, title: 'Family schedules', copy: 'Appointments, school events, activities, and everyone’s changing plans.' },
  { icon: Receipt, title: 'Bills & due dates', copy: 'What is due, when it is due, and the payments that cannot slip.' },
  { icon: Heart, title: 'Household preferences', copy: 'Allergies, favorite meals, routines, sizes, and the little things that matter.' },
  { icon: Wrench, title: 'Service history', copy: 'Repairs, vendors, costs, warranties, and when something was last serviced.' },
  { icon: ShoppingBasket, title: 'Grocery & shopping', copy: 'What is running low, what to use up, and what fits this week’s budget.' },
  { icon: BellRing, title: 'Morning briefings', copy: 'A clear daily view of priorities, risks, reminders, and timely suggestions.' },
];

const faqs = [
  {
    question: 'What does OziUno remember?',
    answer: 'OziUno can remember the practical details that keep a household moving: family schedules, bills, food preferences and allergies, grocery needs, recurring tasks, vendor contacts, service history, and more. Its memory becomes richer and more useful as you use it.',
  },
  {
    question: 'How do I add things?',
    answer: 'Just speak or type naturally. You can say “The electricity bill is due Friday,” “Ada’s dentist appointment is at 2 PM,” or “We’re almost out of rice.” OziUno organizes the detail into your household memory for you.',
  },
  {
    question: 'Is my data private?',
    answer: 'Yes. Your household memory is private to your account and is used to provide your OziUno experience. We treat the personal details that make your home run with care and do not make them public.',
  },
  {
    question: 'What’s included in the free trial?',
    answer: 'Your 7-day trial includes the full OziUno experience: voice and text capture, household memory, smart organization, and proactive morning briefings. You can explore it before choosing the monthly or yearly plan.',
  },
];

const included = ['Voice and text capture', 'Persistent household memory', 'Proactive morning briefings', 'Smart household awareness'];

export function OziUnoPublicPage({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <div
      className="eg-root ozi-page"
      data-audos-landing-shell="oziuno"
      style={{ height: '100dvh', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}
    >
      <style>{STYLES}</style>

      <header className="ozi-hero">
        <nav className="ozi-container ozi-nav" aria-label="Main navigation">
          <a className="ozi-brand" href="#top" aria-label="OziUno home">
            <span className="ozi-brand-mark"><Home size={20} strokeWidth={2.4} /></span>
            <span>
              <span className="ozi-brand-name">OziUno</span>
              <span className="ozi-brand-tag">Household OS</span>
            </span>
          </a>
          <div className="ozi-nav-links">
            <a href="#how-it-works">How it works</a>
            <a href="#what-it-remembers">What it remembers</a>
            <a href="#pricing">Pricing</a>
            <button type="button" className="ozi-button ozi-button-primary ozi-button-small" onClick={onGetStarted}>
              Get started <ArrowRight size={15} />
            </button>
          </div>
        </nav>

        <div id="top" className="ozi-container ozi-hero-grid">
          <div>
            <span className="ozi-eyebrow"><Sparkles size={14} /> Your household’s backup brain</span>
            <h1>OziUno <span className="ozi-gradient-text">holds your home together.</span></h1>
            <p className="ozi-hero-copy">
              The AI-powered household management OS that remembers the details, connects the dots, and tells you what matters before anything gets forgotten.
            </p>
            <div className="ozi-hero-actions">
              <button type="button" className="ozi-button ozi-button-primary" onClick={onGetStarted}>
                Get started <ArrowRight size={18} />
              </button>
              <button type="button" className="ozi-button ozi-button-secondary" onClick={onGetStarted}>
                Start your free trial
              </button>
            </div>
            <p className="ozi-trial-note"><ShieldCheck size={16} /> 7 days free · No credit card required to begin</p>
          </div>

          <div className="ozi-briefing-wrap" role="group" aria-label="Example OziUno morning briefing">
            <div className="ozi-briefing-glow" />
            <div className="ozi-briefing-card">
              <div className="ozi-card-top">
                <div className="ozi-card-label">
                  <span className="ozi-card-icon"><Sunrise size={22} /></span>
                  <span>
                    <p className="ozi-card-kicker">Morning briefing</p>
                    <p className="ozi-card-date">Tuesday · 7:02 AM</p>
                  </span>
                </div>
                <span className="ozi-live-pill"><span className="ozi-live-dot" /> Ready for you</span>
              </div>
              {/* Sample-UI greeting, not a document section — kept out of the
                  heading outline so the page's H2s are the real sections.
                  font-weight moved into .ozi-greeting to match the old h2 look. */}
              <p className="ozi-greeting">Good morning, Nkechi.</p>
              <p className="ozi-briefing-copy">
                Today you have a <strong>dentist appointment at 2:00 PM</strong>. Your electricity bill is due tomorrow, and you’re running low on rice, eggs, and cooking oil. Based on your budget, I suggest shopping today after work.
              </p>
              <div className="ozi-briefing-items">
                <div className="ozi-briefing-item"><CalendarDays size={17} color="#5eead4" /> Dentist · 2:00 PM</div>
                <div className="ozi-briefing-item"><Receipt size={17} color="#5eead4" /> Electricity bill · Due tomorrow</div>
                <div className="ozi-briefing-item"><ShoppingBasket size={17} color="#5eead4" /> 3 grocery staples running low</div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main>
        <section id="how-it-works" className="ozi-section">
          <div className="ozi-container">
            <div className="ozi-section-head">
              <p className="ozi-section-kicker">How it works</p>
              <h2>Get it out of your head. OziUno takes it from here.</h2>
              <p className="ozi-section-intro">No complicated setup. Start with one real detail and build a calmer, more dependable home one conversation at a time.</p>
            </div>
            <div className="ozi-steps">
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

        <section id="what-it-remembers" className="ozi-section ozi-section-alt">
          <div className="ozi-container">
            <div className="ozi-section-head">
              <p className="ozi-section-kicker">Your household memory</p>
              <h2>Everything your home needs you to remember.</h2>
              <p className="ozi-section-intro">OziUno turns scattered household details into one living memory — ready when you ask and proactive when you do not.</p>
            </div>
            <div className="ozi-memory-grid">
              {memories.map(({ icon: Icon, title, copy }) => (
                <article className="ozi-memory-card" key={title}>
                  <Icon className="ozi-memory-icon" size={24} />
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </article>
              ))}
            </div>
            <p className="ozi-section-intro" style={{ marginTop: 28 }}>
              Curious what this looks like day to day?{' '}
              <a className="ozi-inline-link" href={aiAssistantHref()}>Learn more about OziUno as an AI household assistant</a>.
            </p>
          </div>
        </section>

        <section id="pricing" className="ozi-section">
          <div className="ozi-container">
            <div className="ozi-section-head ozi-pricing-head">
              <span className="ozi-trial-badge"><Sparkles size={13} /> 7-day free trial</span>
              <h2>Less mental load. One simple plan.</h2>
              <p className="ozi-section-intro">Start free, then choose the rhythm that works for your household.</p>
            </div>
            <div className="ozi-pricing">
              <article className="ozi-price-card">
                <p className="ozi-plan-name">Monthly</p>
                <div className="ozi-price"><strong>$29</strong><span>/ month</span></div>
                <p className="ozi-price-note">Flexible month-to-month access. Cancel anytime.</p>
                <div className="ozi-includes">
                  {included.map((item) => <span className="ozi-include" key={item}><Check size={16} /> {item}</span>)}
                </div>
                <button type="button" className="ozi-button ozi-button-secondary" onClick={onGetStarted}>Start 7-day trial</button>
              </article>
              <article className="ozi-price-card ozi-price-featured">
                <span className="ozi-best-value">Best value</span>
                <p className="ozi-plan-name">Yearly</p>
                <div className="ozi-price"><strong>$250</strong><span>/ year</span></div>
                <p className="ozi-price-note">About $20.83/month — save $98, or roughly 28%.</p>
                <div className="ozi-includes">
                  {included.map((item) => <span className="ozi-include" key={item}><Check size={16} /> {item}</span>)}
                </div>
                <button type="button" className="ozi-button ozi-button-primary" onClick={onGetStarted}>Start 7-day trial <ArrowRight size={17} /></button>
              </article>
            </div>
          </div>
        </section>

        <section className="ozi-section ozi-section-alt">
          <div className="ozi-container">
            <div className="ozi-section-head ozi-pricing-head">
              <p className="ozi-section-kicker">Frequently asked questions</p>
              <h2>A few things you may be wondering.</h2>
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
              <h2>Your home has a lot to remember. You don’t have to hold it alone.</h2>
              <p>Give OziUno one detail today. Wake up tomorrow with a little more space in your head.</p>
              <button type="button" className="ozi-button ozi-button-primary" onClick={onGetStarted}>
                Start your free trial <ArrowRight size={18} />
              </button>
            </div>
            <footer className="ozi-footer">
              <span><span className="ozi-footer-brand">OziUno</span> · holds your home together</span>
              <span>© {new Date().getFullYear()} OziUno. Your household memory, ready when you need it.</span>
            </footer>
          </div>
        </section>
      </main>
    </div>
  );
}
