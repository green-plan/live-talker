import { describe, it, expect } from "vitest";
import { stripAnchorTag } from "../src/synthesis/cs2/CommentaryWriter";

describe("stripAnchorTag", () => {
  it("strips a leading <from:N> tag and reports the beat number", () => {
    const { raw, fromBeat } = stripAnchorTag("<from:2> Frank trades it back instantly.", 3);
    expect(raw).toBe("Frank trades it back instantly.");
    expect(fromBeat).toBe(2);
  });

  it("returns fromBeat: null when there's no tag", () => {
    const { raw, fromBeat } = stripAnchorTag("Colin picks off a body shot.", 3);
    expect(raw).toBe("Colin picks off a body shot.");
    expect(fromBeat).toBeNull();
  });

  it("treats N <= 1 as no shift, but still strips the tag", () => {
    const { raw, fromBeat } = stripAnchorTag("<from:1> Colin opens the round.", 3);
    expect(raw).toBe("Colin opens the round.");
    expect(fromBeat).toBeNull();
  });

  it("strips an out-of-range N defensively, treating it as no shift", () => {
    const { raw, fromBeat } = stripAnchorTag("<from:99> garbled.", 3);
    expect(raw).toBe("garbled.");
    expect(fromBeat).toBeNull();
  });

  it("never leaves tag remnants in the text it returns", () => {
    const { raw } = stripAnchorTag("<from:2>Frank answers immediately.", 3);
    expect(raw).not.toMatch(/<from/i);
  });

  it("still finds and strips the tag when it lands mid-text instead of at the very front", () => {
    const { raw, fromBeat } = stripAnchorTag("### CONTEXT <from:2> Colin is under pressure.", 3);
    expect(raw).not.toMatch(/<from/i);
    expect(raw).toBe("### CONTEXT Colin is under pressure.");
    expect(fromBeat).toBe(2);
  });

  it("preserves newlines around a mid-text tag (gemini CONTEXT/TRANSCRIPT structure)", () => {
    const { raw, fromBeat } = stripAnchorTag("### CONTEXT\nSome scene.\n<from:2>\n#### TRANSCRIPT\nGo time.", 3);
    expect(raw).toBe("### CONTEXT\nSome scene.\n\n#### TRANSCRIPT\nGo time.");
    expect(fromBeat).toBe(2);
  });
});
