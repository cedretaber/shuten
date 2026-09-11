import { describe, expect, it } from "vitest";
import { buildBodyView } from "./body-view.ts";

describe("buildBodyView", () => {
  it("R1-1: 強調が無ければ段落ごとに 1 セグメント。改行文字は含まない", () => {
    // "あい\r\nうえ\n" → 段落 0 は [0,4)、段落 1 は [4,7)。内容範囲は [0,2) と [4,6)。
    expect(buildBodyView("あい\r\nうえ\n", [])).toEqual([
      { id: 0, segments: [{ start: 0, end: 2, text: "あい", findingIds: [] }] },
      { id: 1, segments: [{ start: 4, end: 6, text: "うえ", findingIds: [] }] },
    ]);
  });

  it("R1-2: 空行は segments が空", () => {
    expect(buildBodyView("あ\n\nい", [])).toEqual([
      { id: 0, segments: [{ start: 0, end: 1, text: "あ", findingIds: [] }] },
      { id: 1, segments: [] },
      { id: 2, segments: [{ start: 3, end: 4, text: "い", findingIds: [] }] },
    ]);
  });

  it("R1-3: 末尾の改行ぶんの空ブロックは足さない（決定 5）", () => {
    // LF・CRLF・CR・連続、いずれも「段落数 = splitParagraphs の段落数」。
    expect(buildBodyView("あ\nい\n", []).length).toBe(2);
    expect(buildBodyView("あ\r\nい\r\n", []).length).toBe(2);
    expect(buildBodyView("あ\rい\r", []).length).toBe(2);
    expect(buildBodyView("あ\nい", []).length).toBe(2);
    // 連続する末尾改行：2 つ目は空段落として残る。
    expect(buildBodyView("あ\n\n", [])).toEqual([
      { id: 0, segments: [{ start: 0, end: 1, text: "あ", findingIds: [] }] },
      { id: 1, segments: [] },
    ]);
  });

  it("R1-4: 段落内の強調を 3 つのセグメントに切る", () => {
    const view = buildBodyView("あいうえお", [{ id: "f1", range: { start: 1, end: 3 } }]);
    expect(view[0]?.segments).toEqual([
      { start: 0, end: 1, text: "あ", findingIds: [] },
      { start: 1, end: 3, text: "いう", findingIds: ["f1"] },
      { start: 3, end: 5, text: "えお", findingIds: [] },
    ]);
  });

  it("R1-5: 同一範囲・重なり・入れ子の findingIds", () => {
    const body = "あいうえお";
    const same = buildBodyView(body, [
      { id: "f1", range: { start: 1, end: 3 } },
      { id: "f2", range: { start: 1, end: 3 } },
    ]);
    expect(same[0]?.segments[1]).toEqual({
      start: 1,
      end: 3,
      text: "いう",
      findingIds: ["f1", "f2"],
    });

    const overlap = buildBodyView(body, [
      { id: "f1", range: { start: 0, end: 3 } },
      { id: "f2", range: { start: 2, end: 5 } },
    ]);
    expect(overlap[0]?.segments).toEqual([
      { start: 0, end: 2, text: "あい", findingIds: ["f1"] },
      { start: 2, end: 3, text: "う", findingIds: ["f1", "f2"] },
      { start: 3, end: 5, text: "えお", findingIds: ["f2"] },
    ]);

    const nested = buildBodyView(body, [
      { id: "outer", range: { start: 0, end: 5 } },
      { id: "inner", range: { start: 2, end: 3 } },
    ]);
    expect(nested[0]?.segments.map((s) => s.findingIds)).toEqual([
      ["outer"],
      ["outer", "inner"],
      ["outer"],
    ]);
  });

  it("R1-6: 段落を跨ぐ強調は段落ごとに切り詰められ、改行には掛からない", () => {
    // "あい\nうえ" → 段落 0 の内容 [0,2)、段落 1 の内容 [3,5)。強調 [1,4) は両段落に掛かる。
    const view = buildBodyView("あい\nうえ", [{ id: "f1", range: { start: 1, end: 4 } }]);
    expect(view[0]?.segments).toEqual([
      { start: 0, end: 1, text: "あ", findingIds: [] },
      { start: 1, end: 2, text: "い", findingIds: ["f1"] },
    ]);
    expect(view[1]?.segments).toEqual([
      { start: 3, end: 4, text: "う", findingIds: ["f1"] },
      { start: 4, end: 5, text: "え", findingIds: [] },
    ]);
  });

  it("R1-7: 空の範囲と段落外の範囲は無視する", () => {
    expect(buildBodyView("あい", [{ id: "f1", range: { start: 1, end: 1 } }])[0]?.segments).toEqual(
      [{ start: 0, end: 2, text: "あい", findingIds: [] }],
    );
    // 改行だけに掛かる強調（"あ\nい" の [1,2)）は、どの段落の内容範囲とも重ならない。
    const view = buildBodyView("あ\nい", [{ id: "f1", range: { start: 1, end: 2 } }]);
    expect(view.flatMap((p) => p.segments).every((s) => s.findingIds.length === 0)).toBe(true);
  });

  it("R1-8: 書記素境界に揃った範囲を切っても壊れない（単独サロゲートが無い）", () => {
    // 濁点付き（結合文字）、サロゲートペア、異体字セレクタ、ZWJ の家族、異体字付き絵文字。
    // エディタの正規化で崩れないよう、すべて明示のエスケープで書く（決定 15）。
    // 長さは 2 + 2 + 3 + 8 + 2 = 17 コード単位。
    const body =
      "\u304B\u3099" + // が（か + 結合濁点）
      "\u{29E3D}" + // サロゲートペア 1 つ
      "\u845B\u{E0100}" + // 葛 + 異体字セレクタ
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}" + // ZWJ の家族
      "\u2764\uFE0F"; // 異体字付きの絵文字
    const highlights = [
      { id: "f1", range: { start: 0, end: 2 } }, // か + 濁点
      { id: "f2", range: { start: 2, end: 4 } }, // サロゲートペア 1 つ
      { id: "f3", range: { start: 4, end: 7 } }, // 葛 + 異体字セレクタ
    ];
    const segments = buildBodyView(body, highlights).flatMap((p) => p.segments);
    // 連結すると元の本文に戻る。
    expect(segments.map((s) => s.text).join("")).toBe(body);
    // どのセグメントにも単独サロゲートが無い（申し送り 2）。
    for (const segment of segments) {
      for (let i = 0; i < segment.text.length; i += 1) {
        const code = segment.text.charCodeAt(i);
        const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
        const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
        if (isHighSurrogate) {
          const next = segment.text.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
          i += 1;
        } else {
          expect(isLowSurrogate).toBe(false);
        }
      }
    }
  });

  it("R1-9: セグメントの連結は本文から改行を除いたものに一致する", () => {
    const body = "あい\r\n\nうえお\r";
    const segments = buildBodyView(body, [{ id: "f1", range: { start: 5, end: 7 } }]).flatMap(
      (p) => p.segments,
    );
    expect(segments.map((s) => s.text).join("")).toBe("あいうえお");
    for (const segment of segments) {
      expect(segment.text).toBe(body.slice(segment.start, segment.end));
    }
  });
});
