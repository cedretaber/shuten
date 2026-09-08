/**
 * 指摘に対する作者の採否（仕様書 5.3 節「『未判断』『採用予定』『却下』『保留』を区別し、
 * 判断は変更できる」）。DB に保存する値の正本として、ここでの値・並び順をそのまま
 * DB の列挙に使う。
 *
 * `adopt-planned`（採用予定）という名前は、仕様書 5.3 節「『採用予定』は本文を書き換えない
 * ことを操作付近に明示する」の含みを残すために、単純な「採用（adopted）」ではなくこの語を選んでいる。
 */
export const JUDGMENT_STATUSES = ["undecided", "adopt-planned", "rejected", "held"] as const;

export type JudgmentStatus = (typeof JUDGMENT_STATUSES)[number];
