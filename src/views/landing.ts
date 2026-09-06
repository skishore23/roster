import { esc } from "./agent-framework.js";

const landingCss = (): string => `
  :root{
    color-scheme:dark;
    --ink:#f2f5ec;
    --muted:#9ca598;
    --faint:#626c61;
    --canvas:#060807;
    --canvas-soft:#0a0d0b;
    --panel:#0e120f;
    --panel-strong:#131814;
    --line:#242b25;
    --line-bright:#39433a;
    --signal:#b7ff5a;
    --signal-soft:rgba(183,255,90,.12);
    --cyan:#75e7d2;
    --orange:#ff8a4c;
    --red:#ff5d5d;
    --shadow:0 40px 120px rgba(0,0,0,.48);
    --display:"Instrument Sans","Arial Narrow",Arial,sans-serif;
    --mono:"IBM Plex Mono","SFMono-Regular",Consolas,monospace;
    --page:min(1240px,calc(100vw - 48px));
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth;background:var(--canvas)}
  body{margin:0;overflow-x:hidden;color:var(--ink);background:var(--canvas);font-family:var(--display);font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
  body::before{position:fixed;inset:0;z-index:-2;content:"";background:radial-gradient(circle at 82% 12%,rgba(117,231,210,.07),transparent 28%),radial-gradient(circle at 10% 44%,rgba(183,255,90,.045),transparent 30%),var(--canvas)}
  a{color:inherit}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
  .skip-link{position:fixed;top:12px;left:12px;z-index:1000;transform:translateY(-160%);border:1px solid var(--signal);border-radius:999px;padding:10px 16px;color:#091006;background:var(--signal);font-weight:750;text-decoration:none}.skip-link:focus{transform:none}
  :focus-visible{outline:2px solid var(--signal);outline-offset:4px}
  .site-nav{position:fixed;top:0;left:0;right:0;z-index:50;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(6,8,7,.72);backdrop-filter:blur(18px)}
  .nav-inner{width:var(--page);height:72px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:28px}
  .brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;font:760 13px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase}
  .brand-mark{position:relative;width:26px;height:26px;display:grid;place-items:center;border:1px solid var(--line-bright);border-radius:8px;background:var(--panel);box-shadow:inset 0 0 14px rgba(183,255,90,.07)}
  .brand-mark::before,.brand-mark::after{position:absolute;content:"";border-radius:50%;background:var(--signal);box-shadow:0 0 12px rgba(183,255,90,.55)}.brand-mark::before{width:5px;height:5px;left:5px}.brand-mark::after{width:4px;height:4px;right:5px;top:5px}
  .brand-mark i{width:5px;height:5px;border:1px solid var(--signal);border-radius:50%}.brand-mark span{position:absolute;left:8px;right:8px;height:1px;background:var(--line-bright);transform:rotate(-32deg)}
  .brand em{color:var(--muted);font-style:normal;font-weight:500}
  .nav-links{display:flex;align-items:center;gap:28px}.nav-links a{color:var(--muted);font-size:13px;font-weight:620;text-decoration:none}.nav-links a:hover{color:var(--ink)}
  .button{min-height:46px;display:inline-flex;align-items:center;justify-content:center;gap:10px;border:1px solid var(--line-bright);border-radius:999px;padding:0 20px;color:var(--ink);background:rgba(255,255,255,.025);font-size:13px;font-weight:720;text-decoration:none;transition:border-color .25s ease,background .25s ease,color .25s ease,transform .25s ease}
  .button:hover{transform:translateY(-2px);border-color:#566256;background:rgba(255,255,255,.055)}.button.primary{border-color:var(--signal);color:#0a1107;background:var(--signal);box-shadow:0 0 0 1px rgba(183,255,90,.16),0 12px 38px rgba(132,205,43,.17)}.button.primary:hover{background:#c5ff7b}.button svg{width:16px;height:16px}
  .nav-cta{min-height:40px;padding:0 16px}
  .hero{position:relative;min-height:100svh;display:grid;align-items:center;padding:144px 0 84px;isolation:isolate}
  #entropy-field{position:absolute;inset:0;z-index:-1;width:100%;height:100%;opacity:.68;mask-image:linear-gradient(to bottom,black 65%,transparent)}
  .hero::after{position:absolute;left:0;right:0;bottom:0;height:180px;z-index:-1;content:"";background:linear-gradient(to bottom,transparent,var(--canvas))}
  .hero-grid{width:var(--page);margin:auto;display:grid;grid-template-columns:minmax(0,1.02fr) minmax(460px,.98fr);align-items:center;gap:64px}
  .eyebrow{display:flex;align-items:center;gap:12px;margin:0 0 22px;color:var(--signal);font:650 10px/1.4 var(--mono);letter-spacing:.13em;text-transform:uppercase}.eyebrow::before{width:28px;height:1px;content:"";background:currentColor}.eyebrow.neutral{color:var(--muted)}
  .hero h1{max-width:790px;margin:0;font-size:clamp(54px,6.7vw,102px);font-weight:570;line-height:.91;letter-spacing:-.072em;text-wrap:balance}.hero h1 span{color:var(--muted)}
  .hero-copy>p:not(.eyebrow){max-width:650px;margin:30px 0 0;color:#b7bfb3;font-size:clamp(17px,1.6vw,22px);line-height:1.55;text-wrap:pretty}
  .hero-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:34px}.hero-notes{display:flex;flex-wrap:wrap;gap:8px 22px;margin:28px 0 0;padding:0;list-style:none;color:var(--faint);font:580 10px/1.4 var(--mono);letter-spacing:.02em;text-transform:uppercase}.hero-notes li{display:flex;align-items:center;gap:8px}.hero-notes li::before{width:5px;height:5px;border-radius:50%;content:"";background:var(--signal);box-shadow:0 0 8px rgba(183,255,90,.5)}
  .flight-recorder{position:relative;min-height:580px;border:1px solid var(--line);border-radius:28px;background:rgba(9,12,10,.72);box-shadow:var(--shadow);backdrop-filter:blur(14px);overflow:hidden}
  .flight-recorder::before{position:absolute;inset:0;pointer-events:none;content:"";background:linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px);background-size:36px 36px;mask-image:linear-gradient(to bottom,black,transparent 92%)}
  .recorder-top{height:56px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding:0 18px;color:var(--muted);font:560 9px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase}.recorder-status{display:flex;align-items:center;gap:8px}.recorder-status::before{width:7px;height:7px;border-radius:50%;content:"";background:var(--signal);box-shadow:0 0 10px var(--signal);animation:breathe 2.4s ease-in-out infinite}
  .recorder-body{position:relative;height:430px}.clock-block{position:absolute;top:24px;left:24px;z-index:2}.clock-label{display:block;margin-bottom:8px;color:var(--faint);font:560 8px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase}.virtual-clock{font:520 24px/1 var(--mono);letter-spacing:-.04em}.clock-ms{color:var(--signal)}
  .hero-graph{position:absolute;inset:64px 8px 12px;width:calc(100% - 16px);height:calc(100% - 76px)}.hero-graph path{fill:none;stroke:var(--line-bright);stroke-width:1.25;vector-effect:non-scaling-stroke}.hero-graph .trace-live{stroke:var(--signal);stroke-dasharray:5 7;animation:dash 11s linear infinite}.hero-graph .trace-fault{stroke:var(--orange);stroke-dasharray:2 9;animation:dash 8s linear infinite reverse}.hero-graph circle{fill:var(--panel);stroke:var(--line-bright);stroke-width:1.4}.hero-graph .node-live{fill:var(--signal);stroke:#e3ffbd;filter:drop-shadow(0 0 8px rgba(183,255,90,.55))}.hero-graph text{fill:var(--faint);font:8px var(--mono);letter-spacing:.04em}.hero-graph .label-live{fill:var(--signal)}
  .entropy-readout{position:absolute;right:20px;bottom:18px;width:185px;border:1px solid var(--line);border-radius:14px;padding:13px;background:rgba(14,18,15,.82);font-family:var(--mono)}.entropy-readout header{display:flex;justify-content:space-between;color:var(--faint);font-size:8px;letter-spacing:.08em;text-transform:uppercase}.entropy-readout strong{display:block;margin-top:9px;font-size:25px;font-weight:500}.entropy-readout small{color:var(--signal);font-size:8px;text-transform:uppercase}.entropy-bars{height:34px;margin-top:10px;display:flex;align-items:end;gap:3px}.entropy-bars i{flex:1;min-height:5px;border-radius:2px 2px 0 0;background:var(--line-bright);animation:entropy 2.8s ease-in-out infinite;animation-delay:calc(var(--i) * -180ms)}.entropy-bars i:nth-child(3n){background:var(--signal)}.entropy-bars i:nth-child(5n){background:var(--orange)}
  .recorder-foot{height:94px;display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line)}.recorder-stat{display:grid;align-content:center;gap:5px;padding:0 16px;border-right:1px solid var(--line)}.recorder-stat:last-child{border:0}.recorder-stat span{color:var(--faint);font:540 8px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase}.recorder-stat strong{font:590 17px/1 var(--mono)}.recorder-stat strong.good{color:var(--signal)}
  .proof-strip{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#080b09}.proof-inner{width:var(--page);margin:auto;display:grid;grid-template-columns:1.2fr repeat(4,1fr)}.proof-intro,.proof-metric{min-height:144px;display:grid;align-content:center;border-right:1px solid var(--line);padding:24px}.proof-metric:last-child{border-right:0}.proof-intro p{margin:0;color:var(--muted);font-size:13px;line-height:1.55}.proof-intro strong{display:block;margin-bottom:8px;color:var(--ink);font:620 10px/1.2 var(--mono);letter-spacing:.09em;text-transform:uppercase}.proof-metric strong{font:520 clamp(25px,2.3vw,38px)/1 var(--mono);letter-spacing:-.05em}.proof-metric span{margin-top:9px;color:var(--faint);font:540 9px/1.4 var(--mono);letter-spacing:.04em;text-transform:uppercase}
  .section{width:var(--page);margin:auto;padding:150px 0}.section-head{max-width:820px;margin-bottom:70px}.section-kicker{margin:0 0 18px;color:var(--signal);font:620 10px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase}.section h2{margin:0;font-size:clamp(42px,5.2vw,76px);font-weight:560;line-height:.98;letter-spacing:-.058em;text-wrap:balance}.section-head>p:last-child{max-width:690px;margin:24px 0 0;color:var(--muted);font-size:18px;line-height:1.65;text-wrap:pretty}
  .scroll-story{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(330px,.88fr);gap:72px;align-items:start}.story-visual{position:sticky;top:110px;height:660px;border:1px solid var(--line);border-radius:28px;background:#090c0a;box-shadow:var(--shadow);overflow:hidden}.story-visual::before{position:absolute;inset:0;content:"";background:radial-gradient(circle at 50% 48%,rgba(183,255,90,.07),transparent 33%),linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:auto,42px 42px,42px 42px}.story-ui{position:absolute;top:0;left:0;right:0;height:52px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding:0 18px;color:var(--faint);font:540 8px/1 var(--mono);letter-spacing:.09em;text-transform:uppercase}.story-scene-status{color:var(--signal)}
  .world-engine-svg{position:absolute;inset:70px 20px 74px;width:calc(100% - 40px);height:calc(100% - 144px)}.world-engine-svg path{fill:none;stroke:var(--line-bright);stroke-width:1.2;vector-effect:non-scaling-stroke;transition:opacity .7s ease,stroke .7s ease,stroke-width .7s ease,filter .7s ease}.world-engine-svg .branch{opacity:.16}.world-engine-svg circle{fill:#0d110e;stroke:var(--line-bright);stroke-width:1.4;transition:fill .6s ease,stroke .6s ease,filter .6s ease}.world-engine-svg text{fill:var(--faint);font:8px var(--mono);letter-spacing:.05em;transition:fill .6s ease}.world-engine-svg .base{stroke:var(--signal);opacity:1}.world-engine-svg .core{fill:var(--signal);stroke:#eaffd1;filter:drop-shadow(0 0 8px rgba(183,255,90,.45))}
  [data-scene="branch"] .world-engine-svg .branch,[data-scene="fault"] .world-engine-svg .branch,[data-scene="replay"] .world-engine-svg .branch{opacity:.8}[data-scene="branch"] .world-engine-svg .branch{stroke-dasharray:5 7;animation:dash 12s linear infinite}
  [data-scene="fault"] .world-engine-svg .fault{opacity:1;stroke:var(--red);stroke-width:2.2;filter:drop-shadow(0 0 7px rgba(255,93,93,.42));stroke-dasharray:3 7;animation:dash 5s linear infinite}[data-scene="fault"] .world-engine-svg .fault-node{fill:var(--red);stroke:#ffb3b3;filter:drop-shadow(0 0 8px rgba(255,93,93,.55))}[data-scene="fault"] .world-engine-svg .fault-label{fill:var(--red)}
  [data-scene="replay"] .world-engine-svg .branch:not(.safe){opacity:.12}[data-scene="replay"] .world-engine-svg .safe{opacity:1;stroke:var(--cyan);stroke-width:2.2;filter:drop-shadow(0 0 7px rgba(117,231,210,.35))}[data-scene="replay"] .world-engine-svg .safe-node{fill:var(--cyan);stroke:#c9fff5;filter:drop-shadow(0 0 8px rgba(117,231,210,.45))}[data-scene="replay"] .world-engine-svg .safe-label{fill:var(--cyan)}
  .story-legend{position:absolute;left:18px;right:18px;bottom:16px;display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:13px;background:rgba(13,17,14,.9);overflow:hidden}.story-legend div{display:grid;gap:4px;border-right:1px solid var(--line);padding:11px}.story-legend div:last-child{border:0}.story-legend span{color:var(--faint);font:520 7px/1 var(--mono);text-transform:uppercase;letter-spacing:.08em}.story-legend strong{font:560 11px/1.2 var(--mono)}
  .story-steps{padding-bottom:20vh}.story-step{min-height:70vh;display:grid;align-content:center;border-top:1px solid var(--line);padding:48px 0}.story-step:last-child{border-bottom:1px solid var(--line)}.story-number{display:flex;align-items:center;gap:12px;color:var(--faint);font:560 9px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase}.story-number::after{width:42px;height:1px;content:"";background:var(--line-bright)}.story-step h3{margin:20px 0 14px;font-size:clamp(30px,3.2vw,48px);font-weight:560;line-height:1;letter-spacing:-.045em}.story-step p{max-width:500px;margin:0;color:var(--muted);font-size:16px;line-height:1.7}.story-step code{width:max-content;max-width:100%;display:block;overflow:hidden;margin-top:22px;border:1px solid var(--line);border-radius:9px;padding:10px 12px;color:var(--signal);background:var(--panel);font:520 10px/1.4 var(--mono);text-overflow:ellipsis;white-space:nowrap}
  .worlds-section{width:100%;padding:150px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#080b09}.worlds-inner{width:var(--page);margin:auto}.worlds-layout{display:grid;grid-template-columns:1fr 1.65fr;gap:64px;align-items:start}.worlds-copy{position:sticky;top:110px}.worlds-copy h2{font-size:clamp(42px,5vw,72px)}.worlds-copy>p{max-width:490px;margin:24px 0 0;color:var(--muted);font-size:17px;line-height:1.65}.world-detail{margin-top:36px;border-left:1px solid var(--signal);padding-left:22px}.world-detail .world-state{color:var(--signal);font:620 9px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase}.world-detail h3{margin:13px 0 9px;font-size:25px;line-height:1.1;letter-spacing:-.03em}.world-detail p{margin:0;color:var(--muted);font-size:14px;line-height:1.6}.world-detail dl{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0 0}.world-detail dl div{display:grid;gap:5px}.world-detail dt{color:var(--faint);font:520 7px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase}.world-detail dd{margin:0;font:580 15px/1 var(--mono)}
  .world-wall{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.world-card{position:relative;min-height:270px;display:grid;align-content:space-between;overflow:hidden;border:1px solid var(--line);border-radius:18px;padding:20px;color:var(--ink);background:var(--panel);font:inherit;text-align:left;cursor:pointer;transition:transform .35s ease,border-color .35s ease,background .35s ease}.world-card:hover{transform:translateY(-3px);border-color:var(--line-bright);background:var(--panel-strong)}.world-card[aria-pressed="true"]{border-color:var(--signal);background:#11170f;box-shadow:inset 0 0 0 1px rgba(183,255,90,.1),0 18px 55px rgba(0,0,0,.32)}.world-card::after{position:absolute;right:-34px;bottom:-40px;width:150px;height:150px;border:1px solid var(--line);border-radius:50%;content:"";box-shadow:0 0 0 22px rgba(255,255,255,.012),0 0 0 44px rgba(255,255,255,.008)}.world-card[aria-pressed="true"]::after{border-color:rgba(183,255,90,.45)}.world-card.wide{grid-column:1/-1;min-height:240px}.world-card-top{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;color:var(--faint);font:540 8px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase}.world-verdict{display:flex;align-items:center;gap:7px}.world-verdict::before{width:6px;height:6px;border-radius:50%;content:"";background:var(--red)}.world-card[data-world="safe"] .world-verdict::before,.world-card[data-world="guarded"] .world-verdict::before{background:var(--signal)}.world-card-body{position:relative;z-index:1}.world-card-body h3{margin:0 0 9px;font-size:24px;font-weight:580;line-height:1.05;letter-spacing:-.035em}.world-card-body p{max-width:330px;margin:0;color:var(--muted);font-size:13px;line-height:1.55}.mini-trace{position:relative;z-index:1;height:48px;margin-top:18px}.mini-trace svg{width:100%;height:100%}.mini-trace path{fill:none;stroke:var(--line-bright);stroke-width:1.2;vector-effect:non-scaling-stroke}.world-card[aria-pressed="true"] .mini-trace .candidate{stroke:var(--signal);stroke-width:2}.world-card[data-world="fault"] .mini-trace .candidate{stroke:var(--red)}
  .process-grid{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line);border-left:1px solid var(--line)}.process-card{min-height:340px;display:grid;align-content:space-between;border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:28px;background:linear-gradient(145deg,rgba(255,255,255,.018),transparent 60%)}.process-card-number{color:var(--signal);font:560 10px/1 var(--mono)}.process-icon{width:54px;height:54px;display:grid;place-items:center;border:1px solid var(--line);border-radius:16px;color:var(--signal);background:var(--panel)}.process-icon svg{width:27px;height:27px}.process-card h3{margin:24px 0 10px;font-size:23px;line-height:1.05;letter-spacing:-.035em}.process-card p{margin:0;color:var(--muted);font-size:13px;line-height:1.65}
  .doctrine{display:grid;grid-template-columns:.9fr 1.1fr;gap:88px;align-items:start}.doctrine-copy{position:sticky;top:110px}.doctrine-copy h2{font-size:clamp(44px,5vw,72px)}.doctrine-copy p{max-width:470px;margin:25px 0 0;color:var(--muted);font-size:17px;line-height:1.7}.doctrine-list{border-top:1px solid var(--line)}.doctrine-item{display:grid;grid-template-columns:64px 1fr;gap:26px;border-bottom:1px solid var(--line);padding:36px 0}.doctrine-item>span{color:var(--faint);font:560 10px/1 var(--mono)}.doctrine-item h3{margin:0;font-size:27px;line-height:1.1;letter-spacing:-.035em}.doctrine-item p{margin:12px 0 0;color:var(--muted);font-size:14px;line-height:1.7}.doctrine-item code{display:inline-block;margin-top:14px;color:var(--signal);font:520 9px/1.5 var(--mono)}
  .cta-section{width:var(--page);margin:0 auto 48px;min-height:660px;display:grid;place-items:center;position:relative;overflow:hidden;border:1px solid var(--line);border-radius:30px;background:#0a0d0b;text-align:center}.cta-section::before{position:absolute;inset:-20%;content:"";background:repeating-radial-gradient(circle at 50% 50%,transparent 0 45px,rgba(183,255,90,.07) 46px,transparent 47px 86px);animation:orbit 24s linear infinite}.cta-section::after{position:absolute;inset:0;content:"";background:radial-gradient(circle at 50% 50%,rgba(10,13,11,.3),#0a0d0b 62%)}.cta-content{position:relative;z-index:1;max-width:850px;padding:48px}.cta-content .section-kicker{margin-bottom:22px}.cta-content h2{margin:0;font-size:clamp(52px,7vw,96px);font-weight:560;line-height:.92;letter-spacing:-.065em;text-wrap:balance}.cta-content>p{max-width:600px;margin:26px auto 32px;color:var(--muted);font-size:18px;line-height:1.65}.cta-actions{display:flex;justify-content:center;flex-wrap:wrap;gap:12px}
  .site-footer{width:var(--page);margin:auto;display:grid;grid-template-columns:1fr auto;align-items:center;gap:28px;border-top:1px solid var(--line);padding:32px 0 48px;color:var(--faint);font:520 9px/1.5 var(--mono);letter-spacing:.05em;text-transform:uppercase}.footer-links{display:flex;gap:24px}.footer-links a{text-decoration:none}.footer-links a:hover{color:var(--ink)}
  .reveal{opacity:0;transform:translateY(22px);transition:opacity .8s ease,transform .8s cubic-bezier(.2,.8,.2,1)}.reveal.is-visible{opacity:1;transform:none}
  @keyframes dash{to{stroke-dashoffset:-120}}
  @keyframes breathe{0%,100%{opacity:.42;transform:scale(.85)}50%{opacity:1;transform:scale(1.12)}}
  @keyframes entropy{0%,100%{height:18%}35%{height:92%}70%{height:42%}}
  @keyframes orbit{to{transform:rotate(360deg)}}
  @media(max-width:1050px){
    :root{--page:min(100% - 32px,860px)}.hero-grid{grid-template-columns:1fr}.hero-copy{padding-top:28px}.flight-recorder{min-height:520px}.hero h1{max-width:850px}.proof-inner{grid-template-columns:repeat(4,1fr)}.proof-intro{grid-column:1/-1;border-right:0;border-bottom:1px solid var(--line);min-height:100px}.scroll-story{grid-template-columns:1fr;gap:28px}.story-visual{top:90px;height:58svh;min-height:480px}.story-steps{display:grid;grid-template-columns:repeat(2,1fr);gap:0}.story-step{min-height:42vh;padding:42px 22px}.story-step:nth-child(odd){border-right:1px solid var(--line)}.worlds-layout,.doctrine{grid-template-columns:1fr}.worlds-copy,.doctrine-copy{position:static}.process-grid{grid-template-columns:repeat(2,1fr)}
  }
  @media(max-width:720px){
    :root{--page:calc(100% - 24px)}.nav-inner{height:62px}.nav-links a:not(.nav-cta){display:none}.brand em{display:none}.nav-cta{min-height:38px;padding:0 13px}.hero{padding:116px 0 64px}.hero-grid{gap:40px}.hero h1{font-size:clamp(50px,16vw,74px)}.hero-copy>p:not(.eyebrow){font-size:17px}.hero-actions .button{width:100%}.flight-recorder{min-height:470px;border-radius:20px}.recorder-body{height:350px}.recorder-foot{height:80px}.recorder-stat{padding:0 10px}.recorder-stat strong{font-size:13px}.entropy-readout{width:154px}.proof-inner{grid-template-columns:repeat(2,1fr)}.proof-metric:nth-child(3){border-right:0}.proof-metric{min-height:118px;padding:18px}.section{padding:104px 0}.section h2{font-size:44px}.section-head{margin-bottom:46px}.story-visual{height:460px;min-height:460px;border-radius:20px}.story-steps{grid-template-columns:1fr}.story-step{min-height:50vh;padding:40px 8px}.story-step:nth-child(odd){border-right:0}.worlds-section{padding:104px 0}.world-wall{grid-template-columns:1fr}.world-card.wide{grid-column:auto}.world-detail dl{grid-template-columns:repeat(3,minmax(0,1fr))}.process-grid{grid-template-columns:1fr}.process-card{min-height:270px}.doctrine-item{grid-template-columns:40px 1fr;gap:16px}.cta-section{min-height:600px;margin-bottom:24px}.cta-content{padding:28px 18px}.cta-content h2{font-size:52px}.cta-actions .button{width:100%}.site-footer{grid-template-columns:1fr}.footer-links{flex-wrap:wrap}
  }
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}.reveal{opacity:1;transform:none}}
`;

const arrowIcon = (): string => `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const heroGraph = (): string => `<svg class="hero-graph" viewBox="0 0 520 340" role="img" aria-labelledby="hero-graph-title hero-graph-description">
  <title id="hero-graph-title">AI practice test</title><desc id="hero-graph-description">One customer request takes several paths. The safe path finishes once while a risky second try is stopped.</desc>
  <path d="M42 172 C105 172 118 90 178 90 S238 140 274 140"/><path d="M42 172 C105 172 118 250 178 250 S238 202 274 202"/><path d="M178 90 C230 90 236 55 294 55 S366 84 404 84"/><path d="M178 90 C230 90 236 132 294 132 S355 164 404 164"/><path d="M178 250 C230 250 236 212 294 212 S355 164 404 164"/><path d="M178 250 C230 250 240 294 302 294 S360 246 404 246"/><path class="trace-live" d="M42 172 C105 172 118 90 178 90 C230 90 236 132 294 132 C348 132 357 164 404 164 C440 164 456 172 487 172"/><path class="trace-fault" d="M178 250 C230 250 240 294 302 294 C344 294 369 270 404 246"/>
  <circle cx="42" cy="172" r="8"/><circle cx="178" cy="90" r="7"/><circle cx="178" cy="250" r="7"/><circle cx="294" cy="55" r="6"/><circle cx="294" cy="132" r="6"/><circle cx="294" cy="212" r="6"/><circle cx="302" cy="294" r="6"/><circle cx="404" cy="84" r="6"/><circle class="node-live" cx="404" cy="164" r="8"/><circle cx="404" cy="246" r="6"/><circle class="node-live" cx="487" cy="172" r="6"/>
  <text x="20" y="196">REQUEST</text><text x="148" y="75">DECIDE</text><text x="147" y="274">ACT</text><text x="264" y="41">REMEMBER</text><text x="270" y="119">CHECK</text><text x="268" y="232">ACTION</text><text x="260" y="318">TRY AGAIN</text><text class="label-live" x="386" y="150">DONE</text><text x="378" y="270">STOPPED</text><text class="label-live" x="462" y="194">SAFE</text>
</svg>`;

const worldEngineSvg = (): string => `<svg class="world-engine-svg" viewBox="0 0 690 500" role="img" aria-labelledby="world-map-title world-map-description">
  <title id="world-map-title">Five practice attempts for one AI task</title><desc id="world-map-description">One task is tried several times. A duplicate refund is found, fixed, and tested again.</desc>
  <path class="base" d="M52 250 C124 250 142 250 208 250"/>
  <path class="branch" d="M208 250 C260 250 270 72 352 72 C436 72 452 126 522 126 C584 126 602 78 650 78"/>
  <path class="branch" d="M208 250 C270 250 276 166 354 166 C430 166 450 194 522 194 C584 194 602 170 650 170"/>
  <path class="branch safe" d="M208 250 C280 250 286 250 354 250 C430 250 450 274 522 274 C584 274 602 252 650 252"/>
  <path class="branch fault" d="M208 250 C270 250 276 338 354 338 C430 338 448 364 522 364 C584 364 602 430 650 430"/>
  <path class="branch" d="M208 250 C258 250 270 428 352 428 C432 428 454 446 522 446"/>
  <circle cx="52" cy="250" r="9"/><circle class="core" cx="208" cy="250" r="11"/><circle cx="352" cy="72" r="7"/><circle cx="354" cy="166" r="7"/><circle class="safe-node" cx="354" cy="250" r="7"/><circle class="fault-node" cx="354" cy="338" r="7"/><circle cx="352" cy="428" r="7"/><circle cx="522" cy="126" r="7"/><circle cx="522" cy="194" r="7"/><circle class="safe-node" cx="522" cy="274" r="7"/><circle class="fault-node" cx="522" cy="364" r="7"/><circle cx="522" cy="446" r="7"/><circle cx="650" cy="78" r="7"/><circle cx="650" cy="170" r="7"/><circle class="safe-node" cx="650" cy="252" r="8"/><circle class="fault-node" cx="650" cy="430" r="8"/>
  <text x="24" y="275">REQUEST</text><text x="178" y="278">START</text><text x="320" y="54">FAST</text><text x="320" y="148">SLOW</text><text class="safe-label" x="320" y="232">NORMAL</text><text class="fault-label" x="318" y="322">CRASH</text><text x="318" y="456">MIXED</text><text class="safe-label" x="620" y="236">SAFE</text><text class="fault-label" x="596" y="454">DONE TWICE</text>
</svg>`;

const miniTrace = (variant: "fault" | "safe" | "guarded"): string => {
  const paths = variant === "fault"
    ? `<path d="M2 38 C42 38 47 13 87 13 S135 38 170 38 S220 9 260 9"/><path class="candidate" d="M87 13 C138 13 142 45 190 45 S227 22 260 22"/>`
    : variant === "safe"
      ? `<path d="M2 38 C42 38 47 13 87 13 S135 38 170 38 S220 9 260 9"/><path class="candidate" d="M2 38 C48 38 50 28 89 28 S136 20 174 20 S220 20 260 20"/>`
      : `<path d="M2 38 C42 38 47 13 87 13 S135 38 170 38 S220 9 260 9"/><path class="candidate" d="M2 38 C48 38 50 28 89 28 S136 20 174 20 S220 28 260 28"/>`;
  return `<div class="mini-trace" aria-hidden="true"><svg viewBox="0 0 262 50" preserveAspectRatio="none">${paths}</svg></div>`;
};

const processIcon = (kind: "trace" | "twin" | "worlds" | "proof"): string => {
  if (kind === "trace") return `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 8h8M5 16h14M5 24h8M19 8h8M25 16h2M19 24h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="16" cy="8" r="2" fill="currentColor"/><circle cx="22" cy="24" r="2" fill="currentColor"/></svg>`;
  if (kind === "twin") return `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="8" cy="16" r="3" stroke="currentColor" stroke-width="1.4"/><circle cx="24" cy="8" r="3" stroke="currentColor" stroke-width="1.4"/><circle cx="24" cy="24" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M11 16h5m0 0 5-7m-5 7 5 7" stroke="currentColor" stroke-width="1.4"/></svg>`;
  if (kind === "worlds") return `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 25 12 7l6 18 4-12 5 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 25h24" stroke="currentColor" stroke-width="1.4"/></svg>`;
  return `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m7 17 6 6L26 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M25 17v9H6V7h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
};

const landingScript = (): string => `
(()=>{
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root=document.documentElement;
  const clock=document.querySelector('[data-virtual-clock]');
  const draws=document.querySelector('[data-entropy-draws]');
  let frame=0;
  const updateScroll=()=>{
    frame=0;
    const max=Math.max(1,document.documentElement.scrollHeight-innerHeight);
    const progress=Math.max(0,Math.min(1,scrollY/max));
    root.style.setProperty('--page-progress',String(progress));
    const total=Math.round(progress*1122800);
    const minutes=Math.floor(total/60000).toString().padStart(2,'0');
    const seconds=Math.floor((total%60000)/1000).toString().padStart(2,'0');
    const millis=(total%1000).toString().padStart(3,'0');
    if(clock)clock.innerHTML='00:'+minutes+':'+seconds+'<span class="clock-ms">.'+millis+'</span>';
    if(draws)draws.textContent=String(Math.round(48+progress*2241)).padStart(4,'0');
  };
  addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(updateScroll)},{passive:true});
  updateScroll();

  const reveals=[...document.querySelectorAll('.reveal')];
  if(reduced){reveals.forEach(el=>el.classList.add('is-visible'));}
  else{
    const revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-visible');revealObserver.unobserve(entry.target);}}),{threshold:.12});
    reveals.forEach(el=>revealObserver.observe(el));
  }

  const engine=document.querySelector('[data-world-engine]');
  const sceneStatus=document.querySelector('[data-scene-status]');
  const sceneLabels={base:'job copied',branch:'message lost',fault:'mistake caught',replay:'fix works'};
  const sceneObserver=new IntersectionObserver(entries=>{
    const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];
    if(!visible||!engine)return;
    const scene=visible.target.getAttribute('data-scene-step')||'base';
    engine.setAttribute('data-scene',scene);
    if(sceneStatus)sceneStatus.textContent=sceneLabels[scene]||scene;
  },{rootMargin:'-32% 0px -38% 0px',threshold:[0,.2,.5,.8]});
  document.querySelectorAll('[data-scene-step]').forEach(el=>sceneObserver.observe(el));

  const worldData={
    fault:{state:'Not safe · two refunds',title:'Try again without checking',description:'The first refund worked, but the “done” message was lost. The AI tries again and sends a second refund.',effects:'2×',recovery:'41s',human:'0%'},
    safe:{state:'Best choice · one refund',title:'Check before trying again',description:'The AI sees that the refund already happened. It does not send another one.',effects:'1×',recovery:'8s',human:'0%'},
    guarded:{state:'Safe · but slow',title:'Ask a person every time',description:'A person stops the second refund, but every small problem now waits in a line for help.',effects:'1×',recovery:'4m',human:'38%'}
  };
  const detail={state:document.querySelector('[data-world-state]'),title:document.querySelector('[data-world-title]'),description:document.querySelector('[data-world-description]'),effects:document.querySelector('[data-world-effects]'),recovery:document.querySelector('[data-world-recovery]'),human:document.querySelector('[data-world-human]')};
  document.querySelectorAll('[data-world]').forEach(button=>button.addEventListener('click',()=>{
    const id=button.getAttribute('data-world');const next=worldData[id];if(!next)return;
    document.querySelectorAll('[data-world]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
    Object.keys(detail).forEach(key=>{const node=detail[key];if(node)node.textContent=next[key]});
  }));

  const canvas=document.querySelector('#entropy-field');
  if(!(canvas instanceof HTMLCanvasElement))return;
  const context=canvas.getContext('2d');if(!context)return;
  let width=0,height=0,dpr=1,particles=[];
  let seed=0x51f15e;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
  const resize=()=>{dpr=Math.min(devicePixelRatio||1,2);width=canvas.clientWidth;height=canvas.clientHeight;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);context.setTransform(dpr,0,0,dpr,0,0);seed=0x51f15e;const count=Math.min(110,Math.max(54,Math.round(width/14)));particles=Array.from({length:count},(_,index)=>({x:random()*width,y:random()*height,vx:(random()-.5)*.18,vy:(random()-.5)*.18,r:random()*1.4+.35,signal:index%17===0}));};
  const render=(time=0)=>{context.clearRect(0,0,width,height);for(let i=0;i<particles.length;i+=1){const p=particles[i];if(!reduced){p.x=(p.x+p.vx+width)%width;p.y=(p.y+p.vy+height)%height;}for(let j=i+1;j<particles.length;j+=1){const q=particles[j],dx=p.x-q.x,dy=p.y-q.y,dist=Math.hypot(dx,dy);if(dist<105){context.strokeStyle='rgba(120,142,124,'+((1-dist/105)*.13)+')';context.lineWidth=.65;context.beginPath();context.moveTo(p.x,p.y);context.lineTo(q.x,q.y);context.stroke();}}context.fillStyle=p.signal?'rgba(183,255,90,.78)':'rgba(183,196,183,.32)';context.beginPath();context.arc(p.x,p.y,p.r,0,Math.PI*2);context.fill();}if(!reduced)requestAnimationFrame(render);};
  resize();addEventListener('resize',resize,{passive:true});render();
})();
`;

export const landingPageHtml = (nonce: string): string => `<!doctype html>
<html lang="en" data-scene="base">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#060807" />
  <meta name="description" content="Give your AI a safe place to practice. Catch costly mistakes before customers are affected." />
  <meta property="og:title" content="Roster Lab — A safe place for your AI to make mistakes" />
  <meta property="og:description" content="Copy one AI task, make things go wrong, catch the mistake, and test the fix." />
  <meta property="og:type" content="website" />
  <title>Roster Lab — A safe place for your AI to make mistakes</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wdth,wght@75..100,400..700&display=swap" rel="stylesheet" />
  <style nonce="${esc(nonce)}">${landingCss()}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-nav">
    <div class="nav-inner">
      <a class="brand" href="/" aria-label="Roster Lab home"><span class="brand-mark" aria-hidden="true"><span></span><i></i></span>Roster <em>/ lab</em></a>
      <nav class="nav-links" aria-label="Primary navigation">
        <a href="#world-engine">See an example</a><a href="#how-it-works">How it works</a><a href="#proof">What you get</a>
        <a class="button nav-cta" href="https://x.com/shimikeri" rel="noreferrer">Test one AI task ${arrowIcon()}</a>
      </nav>
    </div>
  </header>

  <main id="main">
    <section class="hero" aria-labelledby="hero-title">
      <canvas id="entropy-field" aria-hidden="true"></canvas>
      <div class="hero-grid">
        <div class="hero-copy reveal">
          <p class="eyebrow">A safe practice room for AI</p>
          <h1 id="hero-title">Let your AI make mistakes. <span>Before a customer gets hurt.</span></h1>
          <p>We copy one job your AI does. Then we make things go wrong on purpose. If it charges, refunds, deletes, or sends something twice, you find out safely.</p>
          <div class="hero-actions"><a class="button primary" href="https://x.com/shimikeri" rel="noreferrer">Test one AI task ${arrowIcon()}</a><a class="button" href="/simulations">Watch an example ${arrowIcon()}</a></div>
          <ul class="hero-notes" aria-label="Product benefits"><li>No real customers</li><li>No real money</li><li>Repeat the same mistake</li></ul>
        </div>
        <div class="flight-recorder reveal" aria-label="AI practice run">
          <div class="recorder-top"><span>practice run / 0214</span><span class="recorder-status">watching every step</span></div>
          <div class="recorder-body">
            <div class="clock-block"><span class="clock-label">practice clock</span><div class="virtual-clock" data-virtual-clock>00:00:00<span class="clock-ms">.000</span></div></div>
            ${heroGraph()}
            <div class="entropy-readout"><header><span>things tried</span><span>test 51f15e</span></header><strong data-entropy-draws>0048</strong><small>every change saved</small><div class="entropy-bars" aria-hidden="true">${Array.from({ length: 16 }, (_, index) => `<i style="--i:${index}"></i>`).join("")}</div></div>
          </div>
          <div class="recorder-foot"><div class="recorder-stat"><span>result</span><strong class="good">safe</strong></div><div class="recorder-stat"><span>refunds sent</span><strong>1 / 1</strong></div><div class="recorder-stat"><span>try again</span><strong class="good">same</strong></div></div>
        </div>
      </div>
    </section>

    <section class="proof-strip" aria-label="Results from the working prototype"><div class="proof-inner">
      <div class="proof-intro"><strong>This already works.</strong><p>These are real results from the test tool in this repository—not numbers made for the website.</p></div>
      <div class="proof-metric"><strong>527</strong><span>problems tried</span></div><div class="proof-metric"><strong>2,190</strong><span>steps watched</span></div><div class="proof-metric"><strong>22 / 22</strong><span>checks passed</span></div><div class="proof-metric"><strong>1.4s</strong><span>on one laptop</span></div>
    </div></section>

    <section class="section" id="world-engine" aria-labelledby="world-engine-heading">
      <header class="section-head reveal"><p class="section-kicker">Here is the whole idea</p><h2 id="world-engine-heading">We let the AI practice the same job again and again.</h2><p>Then we make one small thing go wrong. A message arrives late. A tool stops. A “done” note gets lost. We watch what the AI does next.</p></header>
      <div class="scroll-story">
        <div class="story-visual" data-world-engine data-scene="base">
          <div class="story-ui"><span>practice attempts / test 5370206</span><span class="story-scene-status" data-scene-status>job copied</span></div>
          ${worldEngineSvg()}
          <div class="story-legend"><div><span>clock</span><strong>pretend</strong></div><div><span>attempts</span><strong>5 kinds</strong></div><div><span>refund</span><strong>once</strong></div></div>
        </div>
        <div class="story-steps">
          <article class="story-step" data-scene-step="base"><span class="story-number">01 / Copy</span><h3>Copy one job.</h3><p>For example: “When an order is wrong, give the customer their money back.” The copy cannot touch real money or real customers.</p><code>Job: refund one order</code></article>
          <article class="story-step" data-scene-step="branch"><span class="story-number">02 / Break</span><h3>Make one thing go wrong.</h3><p>The refund works, but the message saying “done” disappears. The AI thinks the job may not have worked.</p><code>Problem: the “done” message is lost</code></article>
          <article class="story-step" data-scene-step="fault"><span class="story-number">03 / Watch</span><h3>See the mistake.</h3><p>The AI tries the refund again. That would give the customer their money twice. We stop the practice run and show you the exact step.</p><code>Caught: refund number two</code></article>
          <article class="story-step" data-scene-step="replay"><span class="story-number">04 / Fix</span><h3>Fix it and try again.</h3><p>Now the AI checks whether the refund already happened. We repeat the same problem. This time it sends only one refund.</p><code>Passed: one refund, even after the problem</code></article>
        </div>
      </div>
    </section>

    <section class="worlds-section" aria-labelledby="world-wall-heading">
      <div class="worlds-inner worlds-layout">
        <div class="worlds-copy reveal"><p class="section-kicker">When something breaks</p><h2 id="world-wall-heading">What should the AI do next?</h2><p>You can see the good and bad part of each choice before real customers are involved.</p>
          <div class="world-detail" aria-live="polite"><span class="world-state" data-world-state>Best choice · one refund</span><h3 data-world-title>Check before trying again</h3><p data-world-description>The AI sees that the refund already happened. It does not send another one.</p><dl><div><dt>Refunds</dt><dd data-world-effects>1×</dd></div><div><dt>Ready again</dt><dd data-world-recovery>8s</dd></div><div><dt>Needs help</dt><dd data-world-human>0%</dd></div></dl></div>
        </div>
        <div class="world-wall reveal" role="group" aria-label="Compare three ways the AI can respond">
          <button class="world-card" type="button" data-world="fault" aria-pressed="false"><div class="world-card-top"><span>choice 01</span><span class="world-verdict">not safe</span></div><div class="world-card-body"><h3>Try again without checking</h3><p>Quick, but it may charge, refund, delete, or send the same thing twice.</p>${miniTrace("fault")}</div></button>
          <button class="world-card" type="button" data-world="safe" aria-pressed="true"><div class="world-card-top"><span>choice 02</span><span class="world-verdict">best choice</span></div><div class="world-card-body"><h3>Check before trying again</h3><p>The AI sees what already happened, finishes once, and does not need a person.</p>${miniTrace("safe")}</div></button>
          <button class="world-card wide" type="button" data-world="guarded" aria-pressed="false"><div class="world-card-top"><span>choice 03</span><span class="world-verdict">safe but slow</span></div><div class="world-card-body"><h3>Ask a person every time</h3><p>Stops the mistake, but every small problem waits in a line for help.</p>${miniTrace("guarded")}</div></button>
        </div>
      </div>
    </section>

    <section class="section" id="how-it-works" aria-labelledby="process-heading">
      <header class="section-head reveal"><p class="section-kicker">How it works</p><h2 id="process-heading">Bring us one job your AI does.</h2><p>Pick something simple where a mistake would hurt: sending money, changing an account, deleting a file, or messaging a customer.</p></header>
      <div class="process-grid reveal">
        <article class="process-card"><span class="process-card-number">01</span><div><span class="process-icon">${processIcon("trace")}</span><h3>Show us the job</h3><p>Tell us what should happen from start to finish.</p></div></article>
        <article class="process-card"><span class="process-card-number">02</span><div><span class="process-icon">${processIcon("twin")}</span><h3>We make a safe copy</h3><p>The copy cannot touch real customers, money, or data.</p></div></article>
        <article class="process-card"><span class="process-card-number">03</span><div><span class="process-icon">${processIcon("worlds")}</span><h3>We cause problems</h3><p>We stop tools, lose messages, repeat things, and change the timing.</p></div></article>
        <article class="process-card"><span class="process-card-number">04</span><div><span class="process-icon">${processIcon("proof")}</span><h3>You fix what breaks</h3><p>Then the same test runs again before every new release.</p></div></article>
      </div>
    </section>

    <section class="section doctrine" id="proof" aria-labelledby="doctrine-heading">
      <div class="doctrine-copy reveal"><p class="section-kicker">What you get</p><h2 id="doctrine-heading">A simple answer to: “Is this safe to ship?”</h2><p>Not just a green check. You can see the mistake, repeat it, and watch the fix stop it.</p></div>
      <div class="doctrine-list reveal">
        <article class="doctrine-item"><span>01</span><div><h3>The first bad step.</h3><p>See exactly where the AI went wrong instead of digging through a pile of logs.</p><code>Here is where refund number two began</code></div></article>
        <article class="doctrine-item"><span>02</span><div><h3>A run-it-again button.</h3><p>Run the same problem again whenever you want. Everyone on the team can see it.</p><code>Press run → see the same problem</code></div></article>
        <article class="doctrine-item"><span>03</span><div><h3>A test for every release.</h3><p>Once a mistake is fixed, keep checking it so the same bug does not come back later.</p><code>New release → run the safety test</code></div></article>
        <article class="doctrine-item"><span>04</span><div><h3>Proof the warning works.</h3><p>We plant a known mistake. If the warning does not turn red, the test is not allowed to pass.</p><code>Plant a mistake → require a red light</code></div></article>
      </div>
    </section>

    <section class="cta-section reveal" aria-labelledby="cta-heading">
      <div class="cta-content"><p class="section-kicker">Try it with us</p><h2 id="cta-heading">What is one thing your AI must never do twice?</h2><p>A charge? A refund? A message? A deleted file? Bring us that one job. We will try to break it safely.</p><div class="cta-actions"><a class="button primary" href="https://x.com/shimikeri" rel="noreferrer">Test one AI task ${arrowIcon()}</a><a class="button" href="/simulations">Watch the example ${arrowIcon()}</a></div></div>
    </section>
  </main>

  <footer class="site-footer"><span>Roster Lab · a safe place for AI to practice · 2026</span><nav class="footer-links" aria-label="Footer navigation"><a href="/monitor">Workspace</a><a href="/simulations">Watch an example</a><a href="https://x.com/shimikeri" rel="noreferrer">Contact</a></nav></footer>
  <script nonce="${esc(nonce)}">${landingScript()}</script>
</body>
</html>`;

export const landingSecurityHeaders = (nonce: string): Readonly<Record<string, string>> => ({
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' https://fonts.gstatic.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
  ].join("; "),
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});
