import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import type {
  PaymentLinkRepository,
  StoredPaymentLink,
} from '../db/repositories/payment-link.repo.js';
import { formatCentsRo, formatIsoDateRo } from '../extraction/schema.js';
import type { QrTrackingService } from './qr.tracking.service.js';

const LINK_PREVIEW_BOT_PATTERNS = [
  /whatsapp/i,
  /facebookexternalhit/i,
  /facebot/i,
  /slackbot/i,
  /telegrambot/i,
  /twitterbot/i,
  /discordbot/i,
  /linkedinbot/i,
  /bingpreview/i,
  /skypeuripreview/i,
];

export function isLinkPreviewBot(userAgent: string | undefined): boolean {
  if (!userAgent) {
    return false;
  }
  return LINK_PREVIEW_BOT_PATTERNS.some((pattern) => pattern.test(userAgent));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getMerchantInitials(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !['SA', 'SRL', 'S', 'A', 'RO'].includes(w.toUpperCase()));
  if (words.length >= 2) {
    return `${words[0]![0] ?? ''}${words[1]![0] ?? ''}`.toUpperCase();
  }
  return (words[0] ?? name).slice(0, 2).toUpperCase();
}

function splitFormattedRoAmount(amountCents: bigint): { whole: string; decimals: string } {
  const abs = amountCents < 0n ? -amountCents : amountCents;
  const wholeRaw = (abs / 100n).toString();
  const wholeWithDots = wholeRaw.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimals = (abs % 100n).toString().padStart(2, '0');
  return {
    whole: amountCents < 0n ? `-${wholeWithDots}` : wholeWithDots,
    decimals,
  };
}

function renderNotFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link plată invalid — Invoice X-Ray</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: radial-gradient(ellipse at 50% 40%, #F4F6F9 0%, #E9ECF2 100%);
      color: #0F172A;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px 16px;
      -webkit-font-smoothing: antialiased;
    }
    .panel {
      background: #FCFCFD;
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 22px;
      padding: 40px 32px;
      max-width: 410px;
      width: 100%;
      text-align: center;
      box-shadow: 0 24px 60px -15px rgba(15, 23, 42, 0.12), 0 4px 16px -4px rgba(15, 23, 42, 0.06);
      animation: rise 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .orb {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      background: #F1F5F9;
      border: 1px solid #E2E8F0;
      color: #475569;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 18px;
    }
    h1 {
      font-size: 18px;
      font-weight: 650;
      letter-spacing: -0.02em;
      margin: 0 0 8px;
      color: #0F172A;
    }
    p { color: #475569; font-size: 14px; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <main class="panel">
    <div class="orb" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9"></circle>
        <path d="M12 8v4"></path>
        <path d="M12 16h.01"></path>
      </svg>
    </div>
    <h1>Link de plată invalid sau expirat</h1>
    <p>Nu am găsit acest ordin de plată în sistemul Invoice X-Ray. Solicită un cod QR nou direct pe WhatsApp.</p>
  </main>
</body>
</html>`;
}

function renderPaymentHandoffPage(link: StoredPaymentLink): string {
  const isCompleted = link.status === 'COMPLETED';
  const formattedAmount = formatCentsRo(link.amountCents, link.currency);
  const { whole, decimals } = splitFormattedRoAmount(link.amountCents);
  const rawAmountDot = (Number(link.amountCents) / 100).toFixed(2);
  const dueDateDisplay = link.dueDate ? formatIsoDateRo(link.dueDate) : 'Fără termen fix';
  const initials = getMerchantInitials(link.payeeName);
  const shortRefCode = link.token.slice(0, 8).toUpperCase();

  const copyIconSvg = `<svg class="ico ico-copy" width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const checkIconSvg = `<svg class="ico ico-check" width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  const revolutSection = link.redirectUrl
    ? `<a class="btn btn-external" href="${escapeHtml(link.redirectUrl)}" target="_blank" rel="noopener noreferrer">
         <span>Deschide aplicația de plată</span>
         <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"></path><path d="M7 7h10v10"></path></svg>
       </a>`
    : '';

  const ibanRow = link.payeeIban
    ? `<div class="detail-row">
         <div class="detail-left">
           <span class="detail-label">IBAN beneficiar</span>
           <span class="detail-val mono tabular" id="iban-val">${escapeHtml(link.payeeIban)}</span>
         </div>
         <button class="copy-btn" type="button" data-copy="${escapeHtml(link.payeeIban)}" aria-label="Copiază IBAN">
           <span class="copy-ico-stack">${copyIconSvg}${checkIconSvg}</span>
           <span class="copy-txt">Copiază</span>
         </button>
       </div>`
    : '';

  const refRow = link.paymentReference
    ? `<div class="detail-row">
         <div class="detail-left">
           <span class="detail-label">Referință / Detalii plată</span>
           <span class="detail-val tabular">${escapeHtml(link.paymentReference)}</span>
         </div>
         <button class="copy-btn" type="button" data-copy="${escapeHtml(link.paymentReference)}" aria-label="Copiază referința">
           <span class="copy-ico-stack">${copyIconSvg}${checkIconSvg}</span>
           <span class="copy-txt">Copiază</span>
         </button>
       </div>`
    : '';

  const confirmArea = isCompleted
    ? `<div class="confirmed-card" id="confirmed-box">
         <div class="confirmed-badge" aria-hidden="true">
           <span class="confirmed-ripple"></span>
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
             <polyline class="draw-check" points="5.5 12.5 10 17 18.5 7.5"></polyline>
           </svg>
         </div>
         <div class="confirmed-copy">
           <div class="confirmed-title">Plată confirmată</div>
           <div class="confirmed-sub">Am actualizat situația financiară și ți-am trimis confirmarea pe WhatsApp.</div>
         </div>
       </div>`
    : `<form method="POST" action="/pay/${encodeURIComponent(link.token)}/confirm" id="confirm-form">
         <button class="btn btn-primary" type="submit" id="confirm-btn">
           <span class="btn-sheen" aria-hidden="true"></span>
           <svg class="btn-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
           <span id="confirm-label">Confirmă că am finalizat plata</span>
         </button>
       </form>`;

  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Plată ${escapeHtml(link.payeeName)} — ${escapeHtml(formattedAmount)}</title>
  <meta name="description" content="Ordin de plată ${escapeHtml(link.payeeName)} — ${escapeHtml(formattedAmount)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --canvas: #ECEEF2;
      --obsidian: #0C0E12;
      --porcelain: #FCFCFD;
      --ink: #0F172A;
      --ink-secondary: #475569;
      --ink-muted: #94A3B8;
      --emerald: #059669;
      --emerald-bright: #10B981;
      --amber: #D97706;
      --amber-bright: #F59E0B;
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-damped: cubic-bezier(0.22, 1, 0.36, 1);
    }

    *, *::before, *::after { box-sizing: border-box; }

    html, body {
      min-height: 100%;
      margin: 0;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(ellipse at 50% 42%, #F3F5F8 0%, #E9ECF2 72%, #E3E7EE 100%);
      color: var(--ink);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 28px 20px;
    }

    .tabular {
      font-variant-numeric: tabular-nums;
    }

    /* ================= SPLIT-SCREEN MODAL STAGE ================= */
    .stage {
      width: 100%;
      max-width: 980px;
      min-height: 580px;
      background: var(--porcelain);
      border-radius: 26px;
      display: grid;
      grid-template-columns: 1.03fr 1fr;
      overflow: hidden;
      border: 1px solid rgba(15, 23, 42, 0.08);
      box-shadow:
        0 24px 60px -15px rgba(15, 23, 42, 0.12),
        0 4px 16px -4px rgba(15, 23, 42, 0.06);
      animation: stageEnter 0.55s var(--ease-out) both;
    }

    @keyframes stageEnter {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ================= LEFT PANEL: MATTE OBSIDIAN + BRUSHED METAL ================= */
    .left-pane {
      position: relative;
      background: var(--obsidian);
      color: #F8FAFC;
      padding: 36px 36px 34px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden;
      isolation: isolate;
    }

    /* Restrained top-left ambient mist (cross-fades smoothly on confirm via opacity) */
    .mist-pending,
    .mist-confirmed {
      position: absolute;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      transition: opacity 0.7s var(--ease-damped);
    }

    .mist-pending {
      background: radial-gradient(circle 420px at 10% 8%, rgba(148, 163, 184, 0.075), transparent 65%);
      opacity: 1;
    }

    .mist-confirmed {
      background: radial-gradient(circle 440px at 10% 8%, rgba(16, 185, 129, 0.095), transparent 65%);
      opacity: 0;
    }

    body.is-paid .mist-pending { opacity: 0; }
    body.is-paid .mist-confirmed { opacity: 1; }

    .brand-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 13.5px;
      font-weight: 600;
      letter-spacing: -0.015em;
      color: #F8FAFC;
    }

    .brand-mark {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      background: linear-gradient(145deg, #252A33 0%, #14171D 100%);
      border: 1px solid rgba(255, 255, 255, 0.13);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
      color: #E2E8F0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .session-id {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.03em;
      color: #94A3B8;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      padding: 4px 10px;
    }

    /* ================= ANODIZED BRUSHED-METAL CARD ================= */
    .metal-stage {
      perspective: 1100px;
      margin: 28px 0;
    }

    .metal-card {
      position: relative;
      border-radius: 20px;
      padding: 25px 25px 22px;
      background: linear-gradient(135deg, #272B33 0%, #171A20 42%, #1F232B 68%, #121418 100%);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow:
        inset 0 1px 0 0 rgba(255, 255, 255, 0.22),
        inset 0 -1px 0 0 rgba(0, 0, 0, 0.5),
        0 20px 40px -12px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      transform-style: preserve-3d;
      will-change: transform;
      transition: transform 0.3s var(--ease-damped), border-color 0.45s ease;
    }

    body.is-paid .metal-card {
      border-color: rgba(52, 211, 153, 0.22);
    }

    /* Directional ultra-fine brushed hairline grain */
    .metal-card::before {
      content: '';
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        118deg,
        rgba(255, 255, 255, 0.015) 0px,
        rgba(255, 255, 255, 0.015) 1px,
        transparent 1px,
        transparent 3px
      );
      pointer-events: none;
      z-index: 1;
    }

    /* SVG feTurbulence micro-texture overlay */
    .metal-noise {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0.045;
      mix-blend-mode: overlay;
      pointer-events: none;
      z-index: 2;
    }

    /* Interactive cursor-tracking specular sheen */
    .metal-sheen {
      position: absolute;
      inset: 0;
      background: radial-gradient(
        400px circle at var(--mouse-x, 22%) var(--mouse-y, 18%),
        rgba(255, 255, 255, 0.09),
        transparent 60%
      );
      opacity: 0;
      transition: opacity 0.35s var(--ease-damped);
      pointer-events: none;
      z-index: 3;
    }

    .metal-card:hover .metal-sheen {
      opacity: 1;
    }

    .metal-inner {
      position: relative;
      z-index: 4;
    }

    .card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 26px;
    }

    .merchant-lockup {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .monogram {
      width: 40px;
      height: 40px;
      border-radius: 11px;
      background: linear-gradient(145deg, #2A2F39 0%, #15181E 100%);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        inset 0 -1px 0 rgba(0, 0, 0, 0.45),
        0 4px 10px rgba(0, 0, 0, 0.35);
      color: #F1F5F9;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .micro-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #94A3B8;
    }

    .card-merchant-name {
      font-size: 15.5px;
      font-weight: 600;
      letter-spacing: -0.015em;
      color: #F8FAFC;
      margin: 3px 0 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: -0.01em;
      flex-shrink: 0;
      transition: background-color 0.4s ease, color 0.4s ease, border-color 0.4s ease;
    }

    .status-pill-pending {
      background: rgba(217, 119, 6, 0.13);
      color: #FCD34D;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .status-pill-done {
      background: rgba(16, 185, 129, 0.15);
      color: #6EE7B7;
      border: 1px solid rgba(52, 211, 153, 0.3);
    }

    .breathe-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--amber-bright);
      animation: breathe 2.4s ease-in-out infinite;
    }

    @keyframes breathe {
      0%, 100% { opacity: 0.5; transform: scale(0.88); }
      50% { opacity: 1; transform: scale(1.1); }
    }

    .card-amount-wrap {
      margin-bottom: 22px;
    }

    .card-amount-kicker {
      font-size: 11.5px;
      font-weight: 500;
      color: #94A3B8;
      margin-bottom: 6px;
    }

    .card-amount {
      font-variant-numeric: tabular-nums;
      font-size: 40px;
      font-weight: 700;
      letter-spacing: -0.035em;
      line-height: 1.05;
      color: #F8FAFC;
    }

    .card-amount .dec {
      font-size: 26px;
      font-weight: 600;
      color: #CBD5E1;
    }

    .card-amount .cur {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.06em;
      color: #94A3B8;
      margin-left: 7px;
    }

    .engraved-divider {
      height: 1px;
      width: 100%;
      background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.15) 50%, transparent 100%);
      margin-bottom: 16px;
    }

    .card-meta-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
    }

    .card-meta-val {
      display: block;
      margin-top: 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12.5px;
      font-weight: 500;
      color: #E2E8F0;
    }

    /* ================= LEFT PANEL TIMELINE ================= */
    .timeline {
      position: relative;
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .timeline-rail {
      position: absolute;
      left: 9px;
      top: 10px;
      bottom: 14px;
      width: 1px;
      background: rgba(255, 255, 255, 0.1);
      overflow: hidden;
    }

    .timeline-rail-fill {
      width: 100%;
      height: 100%;
      background: rgba(16, 185, 129, 0.52);
      transform-origin: top center;
      transform: scaleY(0.52);
      transition: transform 0.65s var(--ease-out);
    }

    body.is-paid .timeline-rail-fill {
      transform: scaleY(1);
    }

    .step {
      position: relative;
      display: flex;
      align-items: flex-start;
      gap: 13px;
    }

    .step-node {
      position: relative;
      z-index: 2;
      width: 19px;
      height: 19px;
      border-radius: 50%;
      background: var(--obsidian);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 1px;
      transition: border-color 0.35s ease, background-color 0.35s ease, color 0.35s ease;
    }

    .step.done .step-node {
      background: #0F241D;
      border: 1px solid rgba(16, 185, 129, 0.55);
      color: #34D399;
    }

    .step.pending .step-node {
      background: #21190D;
      border: 1px solid rgba(245, 158, 11, 0.55);
    }

    .step-amber-dot {
      position: relative;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--amber-bright);
    }

    .step-amber-dot::after {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      border: 1px solid rgba(245, 158, 11, 0.55);
      animation: calmPulse 2.4s var(--ease-out) infinite;
    }

    @keyframes calmPulse {
      0% { transform: scale(0.75); opacity: 0.75; }
      100% { transform: scale(1.9); opacity: 0; }
    }

    .step-check-path {
      stroke-dasharray: 22;
      stroke-dashoffset: 0;
    }

    .step.just-completed .step-check-path {
      stroke-dashoffset: 22;
      animation: drawStroke 0.4s var(--ease-out) 0.1s forwards;
    }

    .step-body {
      transition: opacity 0.25s ease;
    }

    .step-title {
      font-size: 13px;
      font-weight: 600;
      color: #F1F5F9;
      line-height: 1.3;
    }

    .step-desc {
      font-size: 12px;
      color: #64748B;
      margin-top: 2px;
      line-height: 1.45;
    }

    /* ================= RIGHT PANEL: WARM PORCELAIN EXECUTION SURFACE ================= */
    .right-pane {
      background: var(--porcelain);
      padding: 36px 38px 30px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .right-core {
      margin: auto 0;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .right-header {
      transition: opacity 0.25s ease, transform 0.3s var(--ease-out);
    }

    .right-header.fading {
      opacity: 0;
      transform: translateY(-4px);
    }

    .right-title {
      font-size: 23px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--ink);
      margin: 7px 0 0;
      line-height: 1.25;
    }

    /* Crisp Payment Details Card */
    .details-card {
      background: #FFFFFF;
      border: 1px solid rgba(226, 232, 240, 0.85);
      border-radius: 16px;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.03);
      overflow: hidden;
    }

    .detail-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 15px 18px;
      transition: background-color 0.15s ease;
    }

    .detail-row:hover {
      background: rgba(248, 250, 252, 0.78);
    }

    .detail-row + .detail-row {
      border-top: 1px solid rgba(226, 232, 240, 0.72);
    }

    .detail-left {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .detail-label {
      font-size: 11.5px;
      font-weight: 500;
      color: #64748B;
    }

    .detail-val {
      font-size: 14px;
      font-weight: 600;
      color: var(--ink);
      word-break: break-word;
      line-height: 1.4;
    }

    .mono {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 500;
    }

    /* Tactile Copy Button with Icon Morph & Pulse Ring */
    .copy-btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: 10px;
      border: 1px solid #E2E8F0;
      background: #FFFFFF;
      color: #334155;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      transition: transform 0.15s ease, background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease;
    }

    .copy-btn:hover {
      border-color: #CBD5E1;
      background: #F8FAFC;
      color: var(--ink);
    }

    .copy-btn:active {
      transform: scale(0.94);
    }

    .copy-btn.copied {
      background: #ECFDF5;
      border-color: #A7F3D0;
      color: #047857;
    }

    .copy-btn.flash::after {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: inherit;
      border: 1.5px solid rgba(16, 185, 129, 0.5);
      pointer-events: none;
      animation: copyRing 0.55s var(--ease-out) forwards;
    }

    @keyframes copyRing {
      from { transform: scale(1); opacity: 0.9; }
      to { transform: scale(1.16, 1.32); opacity: 0; }
    }

    .copy-ico-stack {
      position: relative;
      width: 14px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .copy-ico-stack .ico {
      position: absolute;
      transition: opacity 0.2s ease, transform 0.22s var(--ease-out);
    }

    .copy-ico-stack .ico-copy {
      opacity: 1;
      transform: scale(1);
    }

    .copy-ico-stack .ico-check {
      opacity: 0;
      transform: scale(0.5);
    }

    .copy-btn.copied .ico-copy {
      opacity: 0;
      transform: scale(0.5);
    }

    .copy-btn.copied .ico-check {
      opacity: 1;
      transform: scale(1);
    }

    /* ================= PRIMARY CTA & CONFIRMED CARD ================= */
    .actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .btn {
      position: relative;
      overflow: hidden;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      width: 100%;
      height: 52px;
      border-radius: 12px;
      padding: 0 20px;
      font-family: inherit;
      font-size: 14.5px;
      font-weight: 500;
      letter-spacing: -0.01em;
      text-decoration: none;
      cursor: pointer;
      transition: transform 0.15s ease, background-color 0.18s ease, box-shadow 0.2s ease, border-color 0.18s ease;
    }

    .btn-primary {
      background: #0F172A;
      color: #FFFFFF;
      border: 1px solid rgba(15, 23, 42, 0.9);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.15),
        0 8px 20px -6px rgba(15, 23, 42, 0.35);
    }

    .btn-primary:hover:not(:disabled) {
      background: #1E293B;
    }

    .btn-primary:active:not(:disabled) {
      transform: scale(0.985);
      box-shadow: 0 2px 6px rgba(15, 23, 42, 0.2);
    }

    .btn-primary:disabled {
      cursor: wait;
      opacity: 0.92;
    }

    .btn-sheen {
      position: absolute;
      inset: 0;
      background: linear-gradient(
        110deg,
        transparent 30%,
        rgba(255, 255, 255, 0.13) 50%,
        transparent 70%
      );
      transform: translateX(-120%);
      transition: transform 0.65s var(--ease-out);
      pointer-events: none;
    }

    .btn-primary:hover:not(:disabled) .btn-sheen {
      transform: translateX(120%);
    }

    .btn-external {
      background: #FFFFFF;
      color: var(--ink);
      border: 1px solid #E2E8F0;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }

    .btn-external:hover {
      background: #F8FAFC;
      border-color: #CBD5E1;
    }

    .btn-external:active {
      transform: scale(0.985);
    }

    .spinner {
      width: 15px;
      height: 15px;
      border: 2px solid rgba(255, 255, 255, 0.28);
      border-top-color: #FFFFFF;
      border-radius: 50%;
      animation: spin 0.65s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Executive Confirmed State Card (zero confetti) */
    .confirmed-card {
      display: flex;
      align-items: center;
      gap: 15px;
      padding: 20px;
      border-radius: 16px;
      background: rgba(236, 253, 245, 0.65);
      border: 1px solid rgba(167, 243, 208, 0.85);
      animation: confirmEntrance 0.45s var(--ease-out) both;
    }

    @keyframes confirmEntrance {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .confirmed-badge {
      position: relative;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: var(--emerald);
      color: #FFFFFF;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 6px 16px -4px rgba(5, 150, 105, 0.4);
    }

    .confirmed-ripple {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      border: 2px solid rgba(16, 185, 129, 0.55);
      animation: singleRipple 0.9s var(--ease-out) 0.12s forwards;
      opacity: 0;
    }

    @keyframes singleRipple {
      0% { transform: scale(1); opacity: 0.7; }
      100% { transform: scale(1.65); opacity: 0; }
    }

    .draw-check {
      stroke-dasharray: 24;
      stroke-dashoffset: 24;
      animation: drawStroke 0.42s var(--ease-out) 0.16s forwards;
    }

    @keyframes drawStroke {
      to { stroke-dashoffset: 0; }
    }

    .confirmed-title {
      font-size: 15px;
      font-weight: 650;
      letter-spacing: -0.015em;
      color: #065F46;
    }

    .confirmed-sub {
      font-size: 13px;
      color: #047857;
      margin-top: 3px;
      line-height: 1.48;
    }

    /* Footer */
    .trust-foot {
      padding-top: 18px;
      border-top: 1px solid rgba(15, 23, 42, 0.06);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--ink-muted);
    }

    .trust-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    @media (max-width: 860px) {
      body { padding: 14px; align-items: flex-start; }
      .stage {
        grid-template-columns: 1fr;
        min-height: auto;
        border-radius: 22px;
      }
      .left-pane { padding: 26px 22px 26px; }
      .right-pane { padding: 28px 22px 24px; gap: 26px; }
      .metal-stage { margin: 22px 0; }
      .card-amount { font-size: 34px; }
      .card-amount .dec { font-size: 22px; }
      .trust-foot { flex-direction: column; align-items: flex-start; gap: 6px; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body class="${isCompleted ? 'is-paid' : 'is-pending'}">
  <div class="stage">
    <!-- LEFT PANEL: MATTE OBSIDIAN + BRUSHED METAL CARD + TIMELINE -->
    <section class="left-pane" aria-label="Rezumat ordin de plată">
      <div class="mist-pending" aria-hidden="true"></div>
      <div class="mist-confirmed" aria-hidden="true"></div>

      <div>
        <header class="brand-bar">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 7V4h3"></path><path d="M20 7V4h-3"></path>
                <path d="M4 17v3h3"></path><path d="M20 17v3h-3"></path>
                <line x1="7" y1="12" x2="17" y2="12"></line>
              </svg>
            </span>
            <span>Invoice X-Ray Pay</span>
          </div>
          <span class="session-id tabular">ID #${escapeHtml(shortRefCode)}</span>
        </header>

        <div class="metal-stage">
          <div class="metal-card" id="metal-card">
            <svg class="metal-noise" aria-hidden="true">
              <filter id="brushed-noise">
                <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
              </filter>
              <rect width="100%" height="100%" filter="url(#brushed-noise)" />
            </svg>
            <div class="metal-sheen" aria-hidden="true"></div>

            <div class="metal-inner">
              <div class="card-top">
                <div class="merchant-lockup">
                  <div class="monogram" aria-hidden="true">${escapeHtml(initials)}</div>
                  <div style="min-width:0">
                    <div class="micro-label">Beneficiar verificat</div>
                    <h1 class="card-merchant-name">${escapeHtml(link.payeeName)}</h1>
                  </div>
                </div>
                <span class="status-pill ${isCompleted ? 'status-pill-done' : 'status-pill-pending'}" id="card-status-pill">${
                  isCompleted
                    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Achitat</span>'
                    : '<span class="breathe-dot"></span><span>De achitat</span>'
                }</span>
              </div>

              <div class="card-amount-wrap">
                <div class="card-amount-kicker">Sumă verificată de plată</div>
                <div class="card-amount tabular" data-amount="${escapeHtml(formattedAmount)}">${escapeHtml(whole)}<span class="dec">,${escapeHtml(decimals)}</span><span class="cur">${escapeHtml(link.currency)}</span></div>
              </div>

              <div class="engraved-divider" aria-hidden="true"></div>

              <div class="card-meta-row">
                <div>
                  <span class="micro-label">Scadență</span>
                  <span class="card-meta-val tabular">${escapeHtml(dueDateDisplay)}</span>
                </div>
                <div style="text-align:right">
                  <span class="micro-label">Canal sincronizare</span>
                  <span class="card-meta-val">WhatsApp Twin</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ol class="timeline" aria-label="Stadiul plății">
        <div class="timeline-rail" aria-hidden="true">
          <div class="timeline-rail-fill"></div>
        </div>

        <li class="step done">
          <span class="step-node" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </span>
          <div class="step-body">
            <div class="step-title">Factură auditată automat</div>
            <div class="step-desc">Sumele și referința au fost validate prin Invoice X-Ray.</div>
          </div>
        </li>

        <li class="step done">
          <span class="step-node" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </span>
          <div class="step-body">
            <div class="step-title">Sesiune QR deschisă</div>
            <div class="step-desc">Datele sunt pregătite pentru copiere instantă.</div>
          </div>
        </li>

        <li class="step ${isCompleted ? 'done' : 'pending'}" id="step-final">
          <span class="step-node" id="step-final-node" aria-hidden="true">${
            isCompleted
              ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline class="step-check-path" points="20 6 9 17 4 12"></polyline></svg>'
              : '<span class="step-amber-dot"></span>'
          }</span>
          <div class="step-body" id="step-final-body">
            <div class="step-title" id="step-final-title">${
              isCompleted ? 'Plată confirmată & arhivată' : 'Așteaptă confirmarea plății'
            }</div>
            <div class="step-desc" id="step-final-desc">${
              isCompleted
                ? 'Reminderele automate au fost oprite definitiv.'
                : 'După transferul bancar, apasă confirmarea din dreapta.'
            }</div>
          </div>
        </li>
      </ol>
    </section>

    <!-- RIGHT PANEL: WARM PORCELAIN EXECUTION SURFACE -->
    <main class="right-pane">
      <div class="right-core">
        <header class="right-header" id="right-header">
          <div class="micro-label" id="right-eyebrow">${
            isCompleted ? 'Confirmare înregistrată' : 'Ordin de plată rapid'
          }</div>
          <h2 class="right-title" id="right-title">${
            isCompleted ? 'Plata ta este completă' : 'Copiază datele și confirmă'
          }</h2>
        </header>

        <section class="details-card" aria-label="Detalii ordin de plată">
          <div class="detail-row">
            <div class="detail-left">
              <span class="detail-label">Sumă exactă</span>
              <span class="detail-val mono tabular">${escapeHtml(formattedAmount)}</span>
            </div>
            <button class="copy-btn" type="button" data-copy="${escapeHtml(rawAmountDot)}" aria-label="Copiază suma">
              <span class="copy-ico-stack">${copyIconSvg}${checkIconSvg}</span>
              <span class="copy-txt">Copiază</span>
            </button>
          </div>

          ${ibanRow}
          ${refRow}

          <div class="detail-row">
            <div class="detail-left">
              <span class="detail-label">Dată scadentă</span>
              <span class="detail-val tabular">${escapeHtml(dueDateDisplay)}</span>
            </div>
          </div>
        </section>

        <div class="actions" id="actions-container">
          ${revolutSection}
          ${confirmArea}
        </div>
      </div>

      <footer class="trust-foot">
        <span class="trust-item">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          <span>Sesiune securizată</span>
        </span>
        <span>Sincronizat live cu AI Twin</span>
      </footer>
    </main>
  </div>

  <script>
    (function() {
      var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      /* 1. Cursor-tracking specular sheen + restrained damped micro-tilt on brushed metal card */
      var card = document.getElementById('metal-card');
      if (card && !prefersReduced && window.matchMedia('(pointer: fine)').matches) {
        card.addEventListener('mousemove', function(e) {
          var rect = card.getBoundingClientRect();
          var x = e.clientX - rect.left;
          var y = e.clientY - rect.top;
          var nx = x / rect.width - 0.5;
          var ny = y / rect.height - 0.5;
          card.style.setProperty('--mouse-x', x.toFixed(1) + 'px');
          card.style.setProperty('--mouse-y', y.toFixed(1) + 'px');
          card.style.transform =
            'translateY(-2px) rotateX(' + (-ny * 5.2).toFixed(2) + 'deg) rotateY(' + (nx * 6.2).toFixed(2) + 'deg)';
        });
        card.addEventListener('mouseleave', function() {
          card.style.transform = 'translateY(0) rotateX(0deg) rotateY(0deg)';
        });
      }

      /* 2. Tactile copy buttons with icon morph + radial flash ring */
      function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
      }

      document.querySelectorAll('.copy-btn[data-copy]').forEach(function(btn) {
        var resetTimer;
        btn.addEventListener('click', function() {
          var text = btn.getAttribute('data-copy') || '';
          var onCopied = function() {
            var txtEl = btn.querySelector('.copy-txt');
            btn.classList.remove('flash');
            void btn.offsetWidth;
            btn.classList.add('copied', 'flash');
            if (txtEl) txtEl.textContent = 'Copiat';
            clearTimeout(resetTimer);
            resetTimer = setTimeout(function() {
              btn.classList.remove('copied', 'flash');
              if (txtEl) txtEl.textContent = 'Copiază';
            }, 1800);
          };

          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(onCopied).catch(function() {
              fallbackCopy(text);
              onCopied();
            });
          } else {
            fallbackCopy(text);
            onCopied();
          }
        });
      });

      /* 3. Primary CTA -> 450ms processing state -> calm executive Confirmed transition */
      var form = document.getElementById('confirm-form');
      if (form) {
        form.addEventListener('submit', function(e) {
          e.preventDefault();
          var btn = document.getElementById('confirm-btn');
          var origHtml = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Se verifică confirmarea...</span>';

          var minDelay = new Promise(function(resolve) { setTimeout(resolve, 450); });
          var req = fetch(form.action, {
            method: 'POST',
            headers: { 'Accept': 'application/json' }
          }).then(function(r) { return r.json(); });

          Promise.all([req, minDelay])
            .then(function(results) {
              var data = results[0];
              if (!data || !data.ok) {
                btn.disabled = false;
                btn.innerHTML = origHtml;
                return;
              }

              document.body.classList.remove('is-pending');
              document.body.classList.add('is-paid');

              /* Morph card status pill */
              var pill = document.getElementById('card-status-pill');
              if (pill) {
                pill.className = 'status-pill status-pill-done';
                pill.innerHTML =
                  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Achitat</span>';
              }

              /* Animate 3rd timeline step & cross-fade copy */
              var stepFinal = document.getElementById('step-final');
              var stepNode = document.getElementById('step-final-node');
              var stepBody = document.getElementById('step-final-body');
              var stepTitle = document.getElementById('step-final-title');
              var stepDesc = document.getElementById('step-final-desc');
              if (stepFinal) {
                stepFinal.classList.remove('pending');
                stepFinal.classList.add('done', 'just-completed');
              }
              if (stepNode) {
                stepNode.innerHTML =
                  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline class="step-check-path" points="20 6 9 17 4 12"></polyline></svg>';
              }
              if (stepBody) {
                stepBody.style.opacity = '0';
                setTimeout(function() {
                  if (stepTitle) stepTitle.textContent = 'Plată confirmată & arhivată';
                  if (stepDesc) stepDesc.textContent = 'Reminderele automate au fost oprite definitiv.';
                  stepBody.style.opacity = '1';
                }, 160);
              }

              /* Cross-fade right-panel heading */
              var header = document.getElementById('right-header');
              var eyebrow = document.getElementById('right-eyebrow');
              var title = document.getElementById('right-title');
              if (header) {
                header.classList.add('fading');
                setTimeout(function() {
                  if (eyebrow) eyebrow.textContent = 'Confirmare înregistrată';
                  if (title) title.textContent = 'Plata ta este completă';
                  header.classList.remove('fading');
                }, 170);
              }

              /* Swap CTA smoothly for executive confirmed card */
              var actions = document.getElementById('actions-container');
              if (actions) {
                actions.innerHTML =
                  '<div class="confirmed-card" id="confirmed-box">' +
                    '<div class="confirmed-badge" aria-hidden="true">' +
                      '<span class="confirmed-ripple"></span>' +
                      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
                        '<polyline class="draw-check" points="5.5 12.5 10 17 18.5 7.5"></polyline>' +
                      '</svg>' +
                    '</div>' +
                    '<div class="confirmed-copy">' +
                      '<div class="confirmed-title">Plată confirmată</div>' +
                      '<div class="confirmed-sub">Am actualizat situația financiară și ți-am trimis confirmarea pe WhatsApp.</div>' +
                    '</div>' +
                  '</div>';
              }
            })
            .catch(function() {
              btn.disabled = false;
              btn.innerHTML = origHtml;
            });
        });
      }
    })();
  </script>
</body>
</html>`;
}

export interface TrackingServerDeps {
  paymentLinkRepo: PaymentLinkRepository;
  qrTrackingService: QrTrackingService;
}

export function createTrackingApp(deps: TrackingServerDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/pay/:token', async (req, res) => {
    const token = req.params.token;
    const existing = await deps.paymentLinkRepo.findByToken(token);
    if (!existing) {
      res.status(404).type('html').send(renderNotFoundPage());
      return;
    }

    const userAgent = req.get('user-agent') ?? '';
    let linkToRender = existing;

    if (!isLinkPreviewBot(userAgent)) {
      const updated = await deps.qrTrackingService.recordHumanQrAccess(token, userAgent);
      if (updated) {
        linkToRender = updated;
      }
    }

    res.status(200).type('html').send(renderPaymentHandoffPage(linkToRender));
  });

  app.post('/pay/:token/confirm', async (req, res) => {
    const token = req.params.token;
    const outcome = await deps.qrTrackingService.confirmPaymentByToken(token, 'WEB_CONFIRM');
    if (!outcome.found || !outcome.link) {
      res.status(404).json({ ok: false, error: 'Payment link not found' });
      return;
    }

    const wantsJson = (req.get('accept') ?? '').includes('application/json');
    if (wantsJson) {
      res.status(200).json({
        ok: true,
        alreadyCompleted: outcome.alreadyCompleted,
        status: outcome.link.status,
        payeeName: outcome.link.payeeName,
        amountFormatted: formatCentsRo(outcome.link.amountCents, outcome.link.currency),
      });
      return;
    }

    res.redirect(303, `/pay/${encodeURIComponent(token)}`);
  });

  return app;
}

export interface RunningTrackingServer {
  app: Express;
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startTrackingServer(
  deps: TrackingServerDeps,
  port: number,
  host = '0.0.0.0',
): Promise<RunningTrackingServer> {
  const app = createTrackingApp(deps);

  const server = await new Promise<Server>((resolve, reject) => {
    const srv = app.listen(port, host, () => resolve(srv));
    srv.on('error', reject);
  });

  const addr = server.address() as AddressInfo | null;
  const boundPort = addr?.port ?? port;

  return {
    app,
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
