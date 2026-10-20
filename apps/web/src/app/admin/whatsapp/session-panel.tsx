"use client";

import { RefreshCw, Unplug } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import type { GatewayResult, GatewaySession } from "@/gateway/admin-client";
import { refreshGatewaySession, requestPairingCode, runGatewayCommand } from "./actions";

const reasonText: Record<string, string> = {
  not_configured: "Set GATEWAY_BASE_URL and GATEWAY_ADMIN_TOKEN on the web server.",
  unreachable: "The gateway is not reachable. Is it running?",
  unauthorized: "The gateway rejected the admin token. GATEWAY_ADMIN_TOKEN must match on both sides.",
  bad_response: "The gateway sent an unexpected response.",
};

const stateText: Record<GatewaySession["state"], string> = {
  starting: "Starting WhatsApp…",
  qr_pending: "Scan this QR code to link the bot's number",
  authenticated: "Linked. Loading chats…",
  ready: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};

// Relative to this render; the panel re-renders on every poll. The server's render runs a moment earlier,
// hence suppressHydrationWarning wherever this is shown.
function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1_000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function SessionPanel({ initial }: { initial: GatewayResult<GatewaySession> }) {
  const [result, setResult] = useState(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ready = result.ok && result.data.state === "ready";

  useEffect(() => {
    // Poll quickly while linking so a fresh QR appears (they rotate every ~20s); slowly once connected.
    const timer = setInterval(async () => setResult(await refreshGatewaySession()), ready ? 15_000 : 3_000);
    return () => clearInterval(timer);
  }, [ready]);

  function run(command: "logout" | "reinitialize") {
    if (command === "logout" && !window.confirm("Unlink this WhatsApp number? The bot stops replying until you scan a new QR code.")) return;
    startTransition(async () => {
      const outcome = await runGatewayCommand(command);
      setNotice(outcome.ok ? (command === "logout" ? "Unlinking… a new QR code will appear." : "Restarting the WhatsApp session…") : reasonText[outcome.reason ?? ""] ?? "Command failed.");
      setResult(await refreshGatewaySession());
    });
  }

  if (!result.ok) {
    return (
      <section className="panel">
        <p className="form-status error" role="alert">{reasonText[result.reason]}</p>
      </section>
    );
  }

  const session = result.data;
  const connected = session.state === "ready";
  // Connected but failing its liveness checks: the gateway restarts it if that goes on.
  const unresponsive = connected && session.healthy === false;
  return (
    <section className="panel session-panel" aria-live="polite">
      <div className="session-head">
        <span className={`session-dot ${unresponsive ? "error" : session.state}`} aria-hidden="true" />
        <strong>{stateText[session.state]}</strong>
        {session.phoneNumber ? <span className="muted">+{session.phoneNumber}</span> : null}
      </div>
      {session.detail && session.state !== "ready" ? <p className="muted">{session.detail}</p> : null}
      {session.reconnectAttempts && session.state !== "ready" ? <p className="muted">Reconnect attempts: {session.reconnectAttempts}</p> : null}
      {unresponsive ? (
        <p className="form-status error" role="alert">
          Not responding — restarting if it doesn&apos;t recover
        </p>
      ) : connected && session.lastHealthCheckAt ? (
        <p className="muted" suppressHydrationWarning>
          Connection check OK {ago(session.lastHealthCheckAt)}
        </p>
      ) : null}
      {connected && session.lastInboundAt ? (
        <p className="muted" suppressHydrationWarning>
          Last message received {ago(session.lastInboundAt)}
        </p>
      ) : null}
      {connected && session.missedMessageCheck === false ? (
        <p className="form-status error" role="alert">
          Can&apos;t read the chat list, so messages WhatsApp fails to report would go unanswered. Restart the session; if it keeps
          happening, whatsapp-web.js needs an update.
        </p>
      ) : null}
      {session.recoveredMessages ? <p className="muted">Recovered {count(session.recoveredMessages, "missed message")} since the gateway started</p> : null}
      {session.ignoredSavedContacts ? <p className="muted">Ignoring {count(session.ignoredSavedContacts, "message")} from saved contacts</p> : null}
      {session.lastAutoRestartAt ? (
        <p className="muted small" suppressHydrationWarning>
          Restarted itself {ago(session.lastAutoRestartAt)}
          {session.lastAutoRestartReason ? `: ${session.lastAutoRestartReason}` : ""}
        </p>
      ) : null}

      {session.state === "qr_pending" && session.qrDataUrl ? (
        <div className="qr-box">
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URL from the gateway */}
          <img src={session.qrDataUrl} alt="WhatsApp link QR code" width={280} height={280} />
          <ol className="muted">
            <li>Open WhatsApp on the bot&apos;s phone.</li>
            <li>Settings → Linked devices → Link a device.</li>
            <li>Point the camera at this code.</li>
          </ol>
        </div>
      ) : null}

      {session.state === "qr_pending" ? (
        <div className="pairing-box">
          <h2>QR not working? Link with phone number</h2>
          {session.pairingCode ? (
            <>
              <p className="pairing-code" aria-label="Pairing code">{session.pairingCode}</p>
              <ol className="muted">
                <li>On the bot&apos;s phone: Settings → Linked devices → Link a device.</li>
                <li>Tap &quot;Link with phone number instead&quot;.</li>
                <li>Enter this code. It expires in a few minutes.</li>
              </ol>
            </>
          ) : (
            <form
              className="pairing-form"
              onSubmit={(event) => {
                event.preventDefault();
                const phone = String(new FormData(event.currentTarget).get("phone") ?? "");
                startTransition(async () => {
                  const outcome = await requestPairingCode(phone);
                  setNotice(outcome.ok ? null : outcome.error);
                  setResult(await refreshGatewaySession());
                });
              }}
            >
              <label>
                Bot&apos;s WhatsApp number
                <input name="phone" inputMode="tel" placeholder="923001234567" required />
              </label>
              <button type="submit" className="secondary" disabled={pending}>{pending ? "Requesting…" : "Get code"}</button>
            </form>
          )}
        </div>
      ) : null}

      <div className="button-row">
        <button type="button" className="secondary" onClick={() => run("reinitialize")} disabled={pending}>
          <RefreshCw size={16} /> Restart session
        </button>
        {ready ? (
          <button type="button" className="danger" onClick={() => run("logout")} disabled={pending}>
            <Unplug size={16} /> Unlink number
          </button>
        ) : null}
      </div>
      {notice ? <p className="form-status ok" role="status">{notice}</p> : null}
      {session.updatedAt ? <p className="muted small">Last change {new Date(session.updatedAt).toLocaleString()}</p> : null}
    </section>
  );
}
