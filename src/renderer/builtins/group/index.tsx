import type { ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import { childSurface, stringProp } from "../shared";
import "../card/card.css";

export default function Group({ props, children }: ComponentRendererProps): ReactNode {
  const title = stringProp(props, ["title"]);
  const description = stringProp(props, ["description"]);
  if (!title && !description) return childSurface(children);
  return <section className="card">
    <header className="card__header">
      {title ? <h2>{title}</h2> : null}
      {description ? <p>{description}</p> : null}
    </header>
    <div className="card__body">{childSurface(children)}</div>
  </section>;
}
