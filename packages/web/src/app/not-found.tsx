import { Link } from "react-router";
import { ROUTES } from "./routes.ts";

/** 未知のパスに対する画面内 404。 */
export function NotFound() {
  return (
    <div>
      <h1>そのページはありません</h1>
      <p>
        <Link to={ROUTES.home}>トップへ戻る</Link>
      </p>
    </div>
  );
}
