import { describe, expect, it } from "vitest";
import { SentRegistry } from "./sent-registry.js";

const chat = "923001234567@c.us";
const lid = "98100000000068@lid";

describe("SentRegistry", () => {
  it("recognizes the echo of a gateway send once, even before its id is known", () => {
    const registry = new SentRegistry();
    registry.expect(chat, "Here you go");
    expect(registry.isOwnSend("true_x_1", [chat], "Here you go")).toBe(true);
    // The owner typing the same words afterwards is the owner.
    expect(registry.isOwnSend("true_x_2", [chat], "Here you go")).toBe(false);
  });

  it("recognizes a sent message by id", () => {
    const registry = new SentRegistry();
    registry.remember("true_x_1");
    expect(registry.isOwnSend("true_x_1", [chat], "anything")).toBe(true);
    expect(registry.isOwnSend("true_x_2", [chat], "anything")).toBe(false);
  });

  it("matches only the same chat and text, ignoring surrounding whitespace", () => {
    const registry = new SentRegistry();
    registry.expect(chat, "Price is Rs 3,500 ");
    expect(registry.isOwnSend(undefined, ["923009999999@c.us"], "Price is Rs 3,500")).toBe(false);
    expect(registry.isOwnSend(undefined, [chat], "Price is Rs 4,000")).toBe(false);
    expect(registry.isOwnSend(undefined, [chat], "Price is Rs 3,500")).toBe(true);
  });

  it("matches an echo filed under the contact's other id", () => {
    const registry = new SentRegistry();
    registry.expect(chat, "");
    expect(registry.isOwnSend(undefined, [lid, chat], "")).toBe(true);
  });

  it("counts identical sends separately", () => {
    const registry = new SentRegistry();
    registry.expect(chat, "Thank you!");
    registry.expect(chat, "Thank you!");
    expect(registry.isOwnSend(undefined, [chat], "Thank you!")).toBe(true);
    expect(registry.isOwnSend(undefined, [chat], "Thank you!")).toBe(true);
    expect(registry.isOwnSend(undefined, [chat], "Thank you!")).toBe(false);
  });

  it("forgets sends after the TTL", () => {
    let now = 0;
    const registry = new SentRegistry(60_000, 100, () => now);
    registry.expect(chat, "Hello");
    registry.remember("true_x_1");
    now = 60_001;
    expect(registry.isOwnSend("true_x_1", [chat], "Hello")).toBe(false);
  });

  it("stays bounded, dropping the oldest entries first", () => {
    const registry = new SentRegistry(60_000, 2);
    registry.remember("a");
    registry.remember("b");
    registry.remember("c");
    expect(registry.isOwnSend("a", [], "")).toBe(false);
    expect(registry.isOwnSend("c", [], "")).toBe(true);
    registry.expect(chat, "1");
    registry.expect(chat, "2");
    registry.expect(chat, "3");
    expect(registry.isOwnSend(undefined, [chat], "1")).toBe(false);
    expect(registry.isOwnSend(undefined, [chat], "3")).toBe(true);
  });
});
