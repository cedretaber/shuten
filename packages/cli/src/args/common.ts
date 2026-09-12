/**
 * サブコマンドをまたいで使う引数解釈の共通部品（決定 9）。
 * サブコマンド固有の解釈器（`args.ts` の `run` 用、`args/hash.ts` など）はここを土台にする。
 */

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(error: string): Result<T> {
  return { ok: false, error };
}

/**
 * `collectRawOptions` に渡す仕様。`known` が既知のオプション名の集合、`repeatable` が
 * 複数回の指定を許すオプション名の集合（省略時は「今までどおり重複をエラーにする」）。
 */
export interface CollectRawOptionsSpec {
  readonly known: readonly string[];
  readonly repeatable?: readonly string[];
}

/**
 * `--flag value` の並びをオプション名ごとの生の文字列の配列に集める。
 *
 * 戻り値は必ず配列（複数回指定を許さないオプションでも長さ 1 の配列）。呼び出し側は
 * `raw.get(name)?.[0]` で単一値を取り出す。`repeatable` に無いオプションが 2 回現れたら、
 * これまでどおり「オプション ... が重複しています」で拒否する。
 */
export function collectRawOptions(
  argv: readonly string[],
  spec: CollectRawOptionsSpec,
): Result<ReadonlyMap<string, readonly string[]>> {
  const knownSet: ReadonlySet<string> = new Set(spec.known);
  const repeatableSet: ReadonlySet<string> = new Set(spec.repeatable ?? []);
  const raw = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      break;
    }
    if (!knownSet.has(token)) {
      // **受け取ったトークンを一切返さない。** この位置では「打ち間違えたオプション名」と
      // 「オプション名を付け忘れて渡された値」を区別できない。`--` 始まりかどうかでも
      // 区別できない（`--PRIVATE_TITLE.txt` のようなファイル名は Windows でも Linux でも
      // 作れる。レビュー指摘）。`shuten check-truth <原稿パス> --truth t.json` のような
      // 打ち方で原稿のパスが標準エラーに出るのは決定 9 に反する。
      //
      // 代わりに**受け付けるオプション名の一覧**を案内する。これは各サブコマンドの
      // `KNOWN_OPTIONS` リテラル由来で、利用者の入力を含まない。
      // これは `collectRawOptions` を使うすべてのサブコマンドに共通の経路である。
      return err(
        `使えないオプションが渡されました（値は表示しません）。使えるのは: ${spec.known.join(" ")}`,
      );
    }
    const value = argv[i + 1];
    if (value === undefined) {
      return err(`オプション ${token} に値がありません`);
    }
    const existing = raw.get(token);
    if (existing === undefined) {
      raw.set(token, [value]);
    } else if (repeatableSet.has(token)) {
      existing.push(value);
    } else {
      return err(`オプション ${token} が重複しています`);
    }
    i += 1;
  }
  return ok(raw);
}

/** 十進の整数表記であることを確認してから変換する（`Number` の緩さを避ける）。 */
export function parseIntegerOption(
  raw: string,
  name: string,
  min: number,
  max: number,
): Result<number> {
  if (!/^-?[0-9]+$/.test(raw)) {
    return err(`${name} は整数でなければなりません: ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return err(
      `${name} は ${String(min)} 以上 ${String(max)} 以下の整数でなければなりません: ${raw}`,
    );
  }
  return ok(value);
}

/**
 * 十進の小数表記（指数表記は不可）であることを確認してから変換する。範囲は課さない。
 * 桁数が極端な表記は `Number` で Infinity になりうるので、有限数であることまで確かめる。
 */
export function parseFiniteNumberOption(raw: string, name: string): Result<number> {
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(raw)) {
    return err(`${name} は数値でなければなりません: ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return err(`${name} は有限の数値でなければなりません: ${raw}`);
  }
  return ok(value);
}

/** `parseFiniteNumberOption` に加えて範囲も検証する。 */
export function parseRangedNumberOption(
  raw: string,
  name: string,
  min: number,
  max: number,
  maxInclusive: boolean,
): Result<number> {
  const parsed = parseFiniteNumberOption(raw, name);
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  if (value < min || (maxInclusive ? value > max : value >= max)) {
    const upper = maxInclusive ? `${String(max)} 以下` : `${String(max)} 未満`;
    return err(`${name} は ${String(min)} 以上 ${upper} でなければなりません: ${raw}`);
  }
  return ok(value);
}
