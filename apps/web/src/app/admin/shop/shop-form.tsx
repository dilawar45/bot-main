"use client";

import { useActionState } from "react";
import type { ShopSettings } from "@/shop/settings";
import { FormStatus } from "../products/_components/form-status";
import type { ActionState } from "../products/actions";

const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;

const hours = Array.from({ length: 25 }, (_, hour) => hour);
const REMINDER_OPTIONS = [30, 60, 120, 240];
const hourLabel = (hour: number) => (hour === 24 ? "midnight" : `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? "am" : "pm"}`);

export function ShopForm({ settings, action }: { settings: ShopSettings; action: (state: ActionState, formData: FormData) => Promise<ActionState> }) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="admin-form">
      <section className="panel">
        <h2>Identity</h2>
        <div className="field-grid">
          <label>
            Shop name
            <input name="shopName" defaultValue={settings.shopName} maxLength={80} />
          </label>
          <label>
            Assistant name (optional)
            <input name="botName" defaultValue={settings.botName} maxLength={40} placeholder="e.g. Sana" />
          </label>
          <label className="span-2">
            About the shop
            <textarea name="about" defaultValue={settings.about} rows={3} maxLength={800} placeholder="What you sell, since when, what makes you different." />
          </label>
          <label className="span-2">
            Address / pickup location
            <textarea name="address" defaultValue={settings.address} rows={2} maxLength={400} />
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Opening hours (Pakistan time)</h2>
        <p className="muted">When a customer asks for a person outside these hours, the bot tells them when the team is back.</p>
        <div className="field-grid">
          <label>
            Opens
            <select name="openHour" defaultValue={settings.openHour}>
              {hours.slice(0, 24).map((hour) => (
                <option key={hour} value={hour}>{hourLabel(hour)}</option>
              ))}
            </select>
          </label>
          <label>
            Closes
            <select name="closeHour" defaultValue={settings.closeHour}>
              {hours.slice(1).map((hour) => (
                <option key={hour} value={hour}>{hourLabel(hour)}</option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="day-row">
          <legend>Closed on</legend>
          {DAYS.map(([key, label]) => (
            <label key={key} className="check">
              <input type="checkbox" name={`closed_${key}`} defaultChecked={settings.closedDays.includes(key)} /> {label}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="panel">
        <h2>Policies the bot may quote</h2>
        <p className="muted">Leave empty if unsure — the bot then says a team member will confirm, instead of guessing.</p>
        <div className="field-grid">
          <label className="span-2">
            Delivery
            <textarea name="delivery" defaultValue={settings.delivery} rows={3} maxLength={1200} placeholder="Cities, charges, how many days, courier." />
          </label>
          <label className="span-2">
            Payment
            <textarea name="payment" defaultValue={settings.payment} rows={2} maxLength={800} placeholder="Cash on delivery? Bank transfer, JazzCash, Easypaisa?" />
          </label>
          <label className="span-2">
            Returns / exchange
            <textarea name="returns" defaultValue={settings.returns} rows={2} maxLength={800} />
          </label>
          <label className="span-2">
            Other questions customers ask
            <textarea name="otherFaq" defaultValue={settings.otherFaq} rows={4} maxLength={3000} placeholder="Stitching, custom sizes, wholesale, gift wrapping..." />
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Orders in WhatsApp</h2>
        <p className="muted">
          The bot collects the items, name, phone number and address, shows the customer a summary with prices, and sends you the order
          once they confirm it. You then confirm, ship or cancel it under Orders. Stock is only taken when you confirm.
        </p>
        <label className="check">
          <input type="checkbox" name="ordersEnabled" defaultChecked={settings.ordersEnabled} /> Let the bot take orders (off: it passes buyers to you)
        </label>
        <div className="field-grid">
          <label>
            Delivery charge (Rs)
            <input name="deliveryFeePkr" inputMode="numeric" defaultValue={settings.deliveryFeePkr ?? ""} placeholder="e.g. 250 — empty: you confirm it" />
          </label>
          <label>
            Free delivery from (Rs, optional)
            <input name="freeDeliveryFromPkr" inputMode="numeric" defaultValue={settings.freeDeliveryFromPkr ?? ""} placeholder="e.g. 5000" />
          </label>
          <label>
            Remind a customer who didn&apos;t confirm
            <select name="cartReminderMinutes" defaultValue={settings.cartReminderMinutes ?? ""}>
              <option value="">Never</option>
              {[...new Set([...REMINDER_OPTIONS, ...(settings.cartReminderMinutes ? [settings.cartReminderMinutes] : [])])]
                .sort((a, b) => a - b)
                .map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes % 60 === 0 ? `After ${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `After ${minutes} minutes`}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" name="ownerFollowUps" defaultChecked={settings.ownerFollowUps} /> Message me about carts that went quiet and orders waiting
          for my confirmation
        </label>
        <p className="muted small">
          A customer gets one short reminder per summary, only during opening hours (never at night) and within a day of their last message.
          Needs the database migration 202610060001_order_followups.sql.
        </p>
      </section>

      <section className="panel">
        <h2>How the bot should sound</h2>
        <div className="field-grid">
          <label className="span-2">
            Tone notes
            <textarea name="toneNotes" defaultValue={settings.toneNotes} rows={3} maxLength={1200} placeholder='e.g. "Call customers bhai/baji, friendly, short, one emoji max."' />
          </label>
          <label className="span-2">
            Real example chats (the strongest way to sound like you)
            <textarea
              name="exampleChats"
              defaultValue={settings.exampleChats}
              rows={12}
              maxLength={12_000}
              placeholder={"Paste 20–30 real exchanges, one line each, like:\nCustomer: salam, red kurta hai?\nYou: Walaikum assalam! Ji hai, ye dekhein 👇 Size konsa?\n\nDon't include prices — the bot never types prices; cards add them."}
            />
          </label>
        </div>
      </section>

      <div className="form-footer sticky-save">
        <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save shop info"}</button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
