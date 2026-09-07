import { describe, expect, it } from "vitest";
import type { FindingCategory } from "../llm/schema.ts";
import type { Suppression } from "./allowed-words.ts";
import { findSuppression } from "./allowed-words.ts";

function sup(
  category: FindingCategory,
  quote: string,
  suggestion: string | null,
  words: readonly string[] = ["リュシア"],
): string | null {
  const result = findSuppression({ category, quote, suggestion }, words);
  return result === null ? null : result.word;
}

describe("findSuppression", () => {
  it("notation で登録語の表記を置き換えていれば抑制する（S1）", () => {
    expect(sup("notation", "リュシア", "ルシア")).toBe("リュシア");
  });

  it("context-misuse は抑制しない（S2）", () => {
    expect(sup("context-misuse", "リュシア", "ルシア")).toBeNull();
  });

  it("unclear は抑制しない（S3）", () => {
    expect(sup("unclear", "リュシア", "ルシア")).toBeNull();
  });

  it("particle は抑制しない（S4a）", () => {
    expect(sup("particle", "リュシア", "ルシア")).toBeNull();
  });

  it("grammar は抑制しない（S4b）", () => {
    expect(sup("grammar", "リュシア", "ルシア")).toBeNull();
  });

  it("omission-or-duplication は抑制しない（S4c）", () => {
    expect(sup("omission-or-duplication", "リュシア", "ルシア")).toBeNull();
  });

  it("登録語の外側が一致していれば抑制する（S5）", () => {
    expect(sup("notation", "リュシアは走った", "ルシアは走った")).toBe("リュシア");
  });

  it("登録語の外側が一致していなければ抑制しない（S6）", () => {
    expect(sup("notation", "リュシアは走った", "ルシアが走った")).toBeNull();
  });

  it("2 回出現するうち片方の置き換えなら抑制する（S7）", () => {
    expect(sup("notation", "リュシアとリュシア", "リュシアとルシア")).toBe("リュシア");
  });

  it("両方の出現を置き換えると外側が一致せず抑制しない（S7b）", () => {
    expect(sup("notation", "リュシアとリュシア", "ルシアとルシア")).toBeNull();
  });

  it("置換文字列が空（削除）なら抑制しない（S8）", () => {
    expect(sup("notation", "リュシアは", "は")).toBeNull();
  });

  it("修正案が null なら抑制しない（S9）", () => {
    expect(sup("notation", "リュシア", null)).toBeNull();
  });

  it("修正案が引用と同じなら抑制しない（S10）", () => {
    expect(sup("notation", "リュシア", "リュシア")).toBeNull();
  });

  it("登録語が引用になければ抑制しない（S11）", () => {
    expect(sup("notation", "ルシアは", "リュシアは")).toBeNull();
  });

  it("複数の登録語が該当するときは配列順で最初の語が勝つ（S12）", () => {
    expect(sup("notation", "リュシア", "リュシヤ", ["シア", "リュシア"])).toBe("シア");
  });

  it("空文字の登録語は飛ばして後続の語を試す（S13a）", () => {
    expect(sup("notation", "リュシア", "ルシア", ["", "リュシア"])).toBe("リュシア");
  });

  it("登録語が空文字だけなら抑制しない（S13b）", () => {
    expect(sup("notation", "リュシア", "ルシア", [""])).toBeNull();
  });

  it("登録語が空配列なら抑制しない（S13c）", () => {
    expect(sup("notation", "リュシア", "ルシア", [])).toBeNull();
  });

  it("結合文字クラスタの内部で終わる出現は境界と認めない（S14a）", () => {
    expect(sup("notation", "か\u3099き", "こ\u3099き", ["か"])).toBeNull();
  });

  it("結合文字を含む登録語は書記素境界で一致すれば抑制する（S14b）", () => {
    expect(sup("notation", "か\u3099き", "こ\u3099き", ["か\u3099"])).toBe("か\u3099");
  });

  it("最初の出現が置き換えを再現すれば抑制する（S15a）", () => {
    expect(sup("notation", "あああ", "あいあ", ["ああ"])).toBe("ああ");
  });

  it("どの出現も置き換えを再現しなければ抑制しない（S15b）", () => {
    expect(sup("notation", "あああ", "いああい", ["ああ"])).toBeNull();
  });

  it("削除になる置き換えは抑制しない（S16a）", () => {
    expect(sup("notation", "aba", "aa", ["b"])).toBeNull();
  });

  it("削除になる置き換えは抑制しない（S16b）", () => {
    expect(sup("notation", "aba", "a", ["b"])).toBeNull();
  });

  it("登録語への書き換えでも抑制する（S17）", () => {
    expect(sup("notation", "ルシア", "リュシア", ["ルシア"])).toBe("ルシア");
  });

  it("登録語が引用に含まれなければ抑制しない（S19）", () => {
    expect(sup("notation", "シア", "シヤ")).toBeNull();
  });

  it("修正案が引用と完全に同じなら抑制しない（S20）", () => {
    expect(sup("notation", "リュシアとリュシア", "リュシアとリュシア")).toBeNull();
  });

  it("複数文字の登録語でも表記の置き換えなら抑制する（S21）", () => {
    expect(sup("notation", "吉野家", "吉野屋", ["野家"])).toBe("野家");
  });

  it("登録語の内部だけを書き換えても抑制する（S22）", () => {
    expect(sup("notation", "吉野家", "吉乃家", ["野家"])).toBe("野家");
  });

  it("登録語の後ろへの挿入は抑制しない（S23）", () => {
    expect(sup("notation", "吉野家", "吉野家だ", ["野家"])).toBeNull();
  });

  it("登録語の後ろへの句点挿入は抑制しない（S24）", () => {
    expect(sup("notation", "リュシア", "リュシア。")).toBeNull();
  });

  it("登録語の前への読点挿入は抑制しない（S25）", () => {
    expect(sup("notation", "リュシア", "、リュシア")).toBeNull();
  });

  it("2 回出現のどちらも削除相当なら抑制しない（S26）", () => {
    expect(sup("notation", "リュシアリュシア", "リュシア")).toBeNull();
  });

  it("外側が一致し置換文字列が登録語を含まなければ抑制する（S27）", () => {
    expect(sup("notation", "リュシア", "ルシアさん")).toBe("リュシア");
  });

  it("登録語の後ろへの文字挿入は抑制しない（S28）", () => {
    expect(sup("notation", "リュシア", "リュシアー")).toBeNull();
  });

  it("登録語の前後への挿入は抑制しない（S29）", () => {
    expect(sup("notation", "リュシア", "xリュシアx")).toBeNull();
  });

  it("結果には登録語と規則の版を含む（SV1）", () => {
    const result: Suppression | null = findSuppression(
      { category: "notation", quote: "リュシア", suggestion: "ルシア" },
      ["リュシア"],
    );
    expect(result).toEqual({ word: "リュシア", ruleVersion: "1" });
  });
});
