import { describe, expect, it } from "vitest";
import { phoneFromWid, serializeMessageId } from "./message-id.js";

describe("serializeMessageId", () => {
  it("uses _serialized when WhatsApp provides it", () => {
    expect(serializeMessageId({ _serialized: "false_923001234567@c.us_ABC" })).toBe("false_923001234567@c.us_ABC");
  });

  it("builds the id for LID chats where _serialized is missing", () => {
    expect(serializeMessageId({ fromMe: false, remote: "98100000000068@lid", id: "3EB0C4A1" })).toBe("false_98100000000068@lid_3EB0C4A1");
    expect(serializeMessageId({ fromMe: true, remote: { _serialized: "923001234567@c.us" }, id: "XYZ" })).toBe("true_923001234567@c.us_XYZ");
  });

  it("returns undefined when there is nothing usable", () => {
    expect(serializeMessageId(undefined)).toBeUndefined();
    expect(serializeMessageId({ fromMe: false, remote: "x@lid" })).toBeUndefined();
  });
});

describe("phoneFromWid", () => {
  it("extracts digits only from phone-number chat ids", () => {
    expect(phoneFromWid("923001234567@c.us")).toBe("923001234567");
    expect(phoneFromWid("98100000000068@lid")).toBeUndefined();
    expect(phoneFromWid(undefined)).toBeUndefined();
  });
});
