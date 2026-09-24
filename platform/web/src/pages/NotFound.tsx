import { Link } from "react-router";

/** Adapted from `web/src/pages/NotFound.tsx` in bttf/wow-guide@df80260. */
export function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </>
  );
}
